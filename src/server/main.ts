import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createNovelAgent, type AgentRole } from "../ai/novel-agent.ts";
import type { ChapterWriteMode, WritingContext } from "../ai/prompts.ts";
import { extractText, MAX_UPLOAD_BYTES, UnsupportedUploadError, UploadTooLargeError } from "./upload.ts";
import {
	libraryFieldsOf,
	materialFromLibrary,
	MaterialLibrary,
	type LibraryMaterial,
	type LibraryMaterialInput,
} from "../store/library.ts";

import {
	BUILTIN_PROVIDERS,
	syncBuiltinProviders,
	getCredentialStore,
	getModels,
	getSettingsStore,
	initModelRuntime,
	listAvailableModels,
	listProviderStatus,
	ModelResolutionError,
	rebuildModels,
	resolveModel,
} from "../ai/models.ts";
import { fetchUpstreamModels, mergeFetched } from "../ai/fetch-models.ts";
import { FileCredentialStore } from "../config/credential-store.ts";
import { SettingsStore } from "../config/settings-store.ts";
import {
	API_FORMATS,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	emptyModel,
	isPlaceholderModel,
	normalizeSettings,
	THINKING_LEVELS,
	type ApiFormat,
	type ModelConfig,
	type ModelThinkingLevel,
	type ProviderConfig,
	type Settings,
} from "../config/settings.ts";
import { loadEnvFile, readConfig, type AppConfig } from "../config/env.ts";
import { assembledMaterials, linkMaterials, MATERIAL_KINDS, MATERIAL_KIND_LABELS, MAX_DRAFT_HISTORY, removeMaterial, ProjectStore, type MaterialKind, type Project } from "../store/project.ts";

loadEnvFile();
const config = readConfig();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** 写作作业的三种性质，与提示词里的"作业"一一对应。 */
const WRITE_MODES: readonly ChapterWriteMode[] = ["create", "rewrite", "continue"];

/**
 * JSON 请求体上限。
 *
 * 长正文一次几万字，用不到 1 MB 以上太多；但素材导入、批量装料这类请求
 * 可能带着整章正文，给到 8 MB 足够，也避免一个坏请求把内存吃光。
 */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * 带 HTTP 状态码的请求错误。
 *
 * readJsonBody 这类底层函数手里没有 res，只能抛；由 API 兜底翻译成状态码，
 * 否则"请求体太大"和"不是合法 JSON"都会一路冒成 500。
 */
class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

interface Session {
	id: string;
	projectId: string;
	role: AgentRole;
	/** writing 角色绑定的目标章节。 */
	chapterId?: string;
	/** 库作用域：不绑工程，工具直接读写通用素材库。 */
	libraryScope?: boolean;
	modelRef: string;
	thinkingLevel: ThinkingLevel;
	/** 当前模型对象。写作会话每轮重建智能体时要用它，不必重新解析。 */
	model: Model<any>;
	agent: Agent;
	createdAt: number;
}

const sessions = new Map<string, Session>();

/**
 * 会话存活上限。早先这里只有 set/get 没有任何删除路径，而每个 Session 都抱着
 * 完整对话历史 —— 用一天下来，Map 里的内存只增不减，最终把进程吃满。
 */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_MAX = 64;

/** 按创建时间淘汰：既清超时会话，也给数量封顶。 */
function pruneSessions(): void {
	const now = Date.now();
	for (const [id, session] of sessions) {
		if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
	}
	if (sessions.size <= SESSION_MAX) return;
	// 还超量就按创建时间丢最老的。
	const ordered = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
	for (const [id] of ordered.slice(0, sessions.size - SESSION_MAX)) sessions.delete(id);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
	res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage, limitBytes = MAX_JSON_BYTES): Promise<T> {
	// 声明了超限长度就直接拒绝，不必先把几 MB 收进内存再发现它太大。
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limitBytes) {
		throw new HttpError(413, "请求体超过 " + Math.round(limitBytes / 1024 / 1024) + " MB 上限");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > limitBytes) {
			throw new HttpError(413, "请求体超过 " + Math.round(limitBytes / 1024 / 1024) + " MB 上限");
		}
		chunks.push(buf);
	}
	if (chunks.length === 0) return {} as T;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	} catch {
		throw new HttpError(400, "请求体不是合法 JSON");
	}
}

/** 读取原始请求体（上传用）。二进制不做 JSON 解析，直接给字节。 */
async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > limitBytes) {
			throw new Error("文件超过 " + Math.round(limitBytes / 1024 / 1024) + " MB 上限");
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

/** 声明的体积已经超限时提前拒绝，不必先收满 32 MB 再发现它太大。 */
function exceedsUploadLimit(req: IncomingMessage): boolean {
	const declared = Number(req.headers["content-length"]);
	return Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES;
}

/** 上传超限的统一回复。 */
function uploadLimitError(res: ServerResponse): void {
	json(res, 413, { error: "文件超过 " + Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) + " MB 上限" });
}

function replaceAgent(session: Session, model: Model<any>): void {
	session.model = model;
	session.agent = createNovelAgent({
		store,
		projectId: session.projectId,
		model,
		models: getModels(),
		config,
		sessionId: session.id,
		role: session.role,
		thinkingLevel: session.thinkingLevel,
		// 库作用域传的是库，不是工程；createNovelAgent 见到它就走另一支。
		...(session.libraryScope ? { library: libraryStore } : {}),
		...(session.chapterId ? { chapterId: session.chapterId } : {}),
	});
}

/**
 * 一次性写作的组装上下文：章节 + 已装配素材 + 上一章结尾。
 *
 * 与 novel-agent.ts 的 writingContextOf 是同一套语义，这里显式传入 mode
 * 并对缺章节报错，因为服务端需要据此返回 404。
 */
function buildWritingContext(projectId: string, chapterId: string, mode: ChapterWriteMode): WritingContext {
	const project = store.get(projectId);
	if (!project) throw new Error("工程不存在");
	const index = project.outline.findIndex((c) => c.id === chapterId);
	const chapter = index >= 0 ? project.outline[index] : undefined;
	if (!chapter) throw new Error("章节 " + chapterId + " 不存在");
	// 只认真正解析得到的素材：装配清单里可能有指向已删素材的悬空 id。
	const materials = assembledMaterials(project, chapterId);
	const previousChapter = index > 0 ? project.outline[index - 1] : undefined;
	return {
		chapter,
		materials,
		mode,
		...(previousChapter ? { previous: project.drafts[previousChapter.id] } : {}),
		...(project.drafts[chapterId] ? { existing: project.drafts[chapterId] } : {}),
	};
}

/**
 * 素材不足时给出的具体提示，比让模型对着空清单硬编要好。
 * 判据是解析后的素材数，不是装配清单的长度 —— 后者可能全是悬空 id。
 */
function writingPreflight(assembly: WritingContext): string {
	if (assembly.materials.length === 0) {
		return "本章没有可用的素材。先让设定官用 upsert_material / attach_materials 把料备齐，再来装料成文。";
	}
	return "";
}

/** 一次性写作的首轮指令。素材全文已在系统提示词里，这里只说"动手"。 */
function writingInstruction(assembly: WritingContext, note?: string): string {
	const base =
		assembly.mode === "continue"
			? "在《" + assembly.chapter.title + "》现有正文之后继续写。先 read_chapter 读已有正文，接上末尾继续，不要重复已写内容。"
			: assembly.mode === "rewrite"
				? "重写《" + assembly.chapter.title + "》。先 read_chapter 读旧稿，再整章重写。"
				: "写出《" + assembly.chapter.title + "》本章。";
	return note ? base + "\n\n作者另有交代：" + note : base;
}

/**
 * 写作会话每轮重建智能体。
 *
 * 系统提示词里写着本章装了哪些料，而提示词是建会话时一次性拼好的。
 * 作者中途装料或摘料之后若不重建，模型看到的依据就是旧的 ——
 * 新装的料这一轮用不上，已摘掉的料还会被当成已经定下的事实。
 */
function refreshWritingAgent(session: Session): void {
	if (session.agent.state.isStreaming) return;
	const messages = session.agent.state.messages;
	// 对话要留着，只换开头那条系统消息（它携带提示词与工具声明）。
	const conversation = messages[0]?.role === "system" ? messages.slice(1) : messages;
	replaceAgent(session, session.model);
	session.agent.state.messages = [...session.agent.state.messages.slice(0, 1), ...conversation];
}

/** 统一的 NDJSON 流式响应。会话与一次性写作走同一条路。 */
async function streamNdjson(
	res: ServerResponse,
	agent: Agent,
	modelRef: string,
	input: string,
): Promise<void> {
	res.writeHead(200, {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});

	const state = { aborted: false };
	const emit = (event: unknown) => {
		if (res.writableEnded) return;
		res.write(`${JSON.stringify(event)}\n`);
	};
	/**
	 * 客户端断开就停笔。
	 *
	 * 早先监听的是 req 的 close，但请求体读尽之后 req 不会再触发 close ——
	 * 于是关页、断网、按"止笔"之后模型仍在后台继续生成，还会照常覆盖正文。
	 * 真正代表连接死活的是 res 的 close；正常结束时 writableEnded 已为 true，
	 * 只有半途关闭才需要中止。
	 */
	const abortOnClose = () => {
		if (res.writableEnded) return;
		state.aborted = true;
		agent.abort();
	};
	res.on("close", abortOnClose);

	try {
		await runAgentStream(agent, modelRef, input, emit, state);
	} finally {
		res.off("close", abortOnClose);
		if (!res.writableEnded) res.end();
	}
}

/** 把耗时说成作者读得懂的话。报错里带上它，"网络慢"与"Key 废了"才分得清。 */
function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes} 分 ${seconds % 60} 秒`;
}

/**
 * 上游的错属于哪一类。
 *
 * 分了类才知道该让作者等、该换 Key，还是该换模型 —— 一句"断流了"，
 * 作者只能自己猜。类别尤其重要：上游限流时最该做的是稍后重试，
 * 让作者去换模型反而是把他引到错的地方。
 */
type UpstreamFault = "overload" | "quota" | "auth" | "model" | "timeout" | "other" | "silent";

/** 每一类错，作者该做什么。 */
const FAULT_ADVICE: Record<UpstreamFault, string> = {
	overload:
		"这是上游自己忙（限流或集群满载），过一会儿再试就行，不必改设置 —— " +
		"点「再试一次」就能把原来那句话原样重发。",
	quota: "多半是额度或余额见底了：去供应商那边充值，或换一个 Key 再试。",
	auth: "多半是上游没认这个 Key：到设置里核对 API Key 与 Base URL。",
	model: "多半是上游不认这个模型名：到设置里换一个模型。",
	timeout: "这么久还没一个字，多半是上游慢或者链路堵了：先点「再试一次」；老是这样就换一个更快的模型。",
	other: "拿不准是哪一环出了问题：先点「再试一次」原句重发，还是不行就到设置里换一个模型或供应商。",
	silent:
		"多半是上游正忙或者链路不通：先点「再试一次」；" +
		"老是这样就到设置里换一个模型或供应商。",
};

/**
 * 把上游的错从 SDK 的壳里剥出来。
 *
 * OpenAI SDK 会把上游的错裹成 `429: {"error":{"message":"…","code":2064}}`。
 * 满屏 JSON 括号作者读不出重点，只要里头那句正经话。
 */
function cleanUpstreamDetail(detail: string): string {
	const text = (detail || "").trim();
	const match = /^\d{3}:\s*(\{[\s\S]*\})$/.exec(text);
	if (!match) return text;
	try {
		const parsed = JSON.parse(match[1] ?? "{}") as { error?: { message?: string }; message?: string };
		const inner = parsed.error?.message ?? parsed.message;
		if (typeof inner === "string" && inner.trim()) return inner.trim();
	} catch {
		/* 不是 JSON，就照原样留着。 */
	}
	return text;
}

/**
 * 从上游的原始报错里认出是哪一类。
 *
 * 上游常把错误塞在 200 响应体里（限流、额度用尽、Key 失效都会这样），
 * 适配器只看得到"没有 finish_reason"。认错了类别，给的处置建议就是错的。
 */
function classifyUpstreamFault(detail: string): UpstreamFault {
	const text = (detail || "").toLowerCase();
	if (!text) return "silent";
	if (/timed out|timeout|etimedout|超时/.test(text)) return "timeout";
	if (
		/负载|繁忙|拥塞|限流|稍后重试|请稍后|请重试|熔断|过载|too many requests|rate[ _-]?limit|overload|capacity|busy|service unavailable|bad gateway|gateway timeout|\b429\b|\b500\b|\b502\b|\b503\b/.test(
			text,
		)
	)
		return "overload";
	if (/额度|余额|欠费|配额|quota|billing|insufficient|payment|credit balance/.test(text)) return "quota";
	if (/api[ _-]?key|apikey|密钥|鉴权|认证|未授权|unauthorized|invalid[ _-]?key|\b401\b|\b403\b/.test(text)) return "auth";
	if (/模型|model/.test(text) && /not found|不存在|不认|不识别|unknown|invalid|unsupported|no such|\b404\b/.test(text))
		return "model";
	return "other";
}

/**
 * 本轮失败时给作者看的那一句话。
 *
 * 原始错误必须并进来：只说"断流了"分不清是超时、Key 失效还是模型名写错，
 * 作者也就不知道该等、该换 Key 还是该换模型。耗时同理 —— 三分钟就断和
 * 十分钟才断，处置方式完全不同。
 * 已经产出过正文时不能静默：用户得知道写出来的内容停在哪儿、要不要重跑。
 *
 * 上游**回话了**却把它说成"没有返回任何内容"，是作者看着最迷惑的一种错 ——
 * 上游明明把原因说了，我们却替它编了一个不相干的"常见原因"清单。
 */
function describeStreamFailure(detail: string, elapsedMs: number, sawText: boolean): string {
	const waited = formatElapsed(elapsedMs);
	// 分类看原始报错（带状态码与完整 JSON，认类更准），显示看剥出来的正经话。
	const fault = classifyUpstreamFault(detail);
	const advice = FAULT_ADVICE[fault];
	// 上游的原文自带句号，末尾再补一个就成了「。。」。
	const clean = cleanUpstreamDetail(detail).replace(/[。.！!]+$/, "");
	if (sawText) {
		return (
			`本轮已经产出一部分正文，随后上游报错断流。等了 ${waited}` +
			(clean ? `，最后报错：${clean}` : "") +
			"。已写出的内容不会自动回退，可先核对正文。" +
			advice
		);
	}
	if (fault === "timeout") {
		return `等了 ${waited}，上游一个字也没回。` + (clean ? `最后报错：${clean}。` : "") + advice;
	}
	if (clean) {
		return `上游回话了，回的却是错：${clean}。` + advice;
	}
	return `等了 ${waited}，上游连一个字也没回就断了。` + advice;
}

/**
 * 本轮是不是作者主动止笔。
 *
 * 不能只看 signal：会话「止笔」走的是 agent.abort()，流里的 signal 并没有置位。
 * Agent 会把这次收尾标成 stopReason "aborted"（而不是 error），以它为准；
 * signal 只覆盖客户端直接断开这一路。
 */
function wasAborted(agent: Agent, signal: { aborted: boolean }): boolean {
	if (signal.aborted) return true;
	for (let index = agent.state.messages.length - 1; index >= 0; index -= 1) {
		const message = agent.state.messages[index];
		if (message?.role === "assistant") return message.stopReason === "aborted";
	}
	return false;
}

/** 把 Agent 事件映射成前端可消费的 NDJSON 事件。 */
function runAgentStream(agent: Agent, modelRef: string, input: string, emit: (event: unknown) => void, signal: { aborted: boolean }): Promise<void> {
	const startedAt = Date.now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
	let thinking = false;
	/** 本轮是否真的产出过正文，用来区分"写完了"与"空手而归"。 */
	let sawText = false;
	/** agent_end 已经收过尾时，prompt 的 catch 不再补第二组事件。 */
	let ended = false;

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "agent_start":
				emit({ type: "run_start", model: modelRef });
				break;
			case "turn_start":
				usage.turns += 1;
				thinking = false;
				emit({ type: "turn_start", turn: usage.turns });
				break;
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					if (thinking) {
						emit({ type: "thinking_end" });
						thinking = false;
					}
					sawText = true;
					emit({ type: "text", delta: inner.delta });
				} else if (inner.type === "thinking_delta") {
					if (!thinking) {
						thinking = true;
						emit({ type: "thinking_start" });
					}
					emit({ type: "thinking", delta: inner.delta });
				} else if (inner.type === "toolcall_end") {
					emit({ type: "tool_call", name: inner.toolCall.name, args: inner.toolCall.arguments });
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					usage.input += event.message.usage?.input ?? 0;
					usage.output += event.message.usage?.output ?? 0;
					usage.cacheRead += event.message.usage?.cacheRead ?? 0;
					usage.cacheWrite += event.message.usage?.cacheWrite ?? 0;
					emit({
						type: "message_end",
						stopReason: event.message.stopReason,
						error: event.message.errorMessage,
						usage: event.message.usage,
					});
				}
				break;
			}
			case "tool_execution_start":
				emit({ type: "tool_start", name: event.toolName, args: event.args });
				break;
			case "tool_execution_end":
				emit({
					type: "tool_end",
					name: event.toolName,
					isError: event.isError,
					durationMs: event.durationMs,
					preview: previewResult(event.result),
				});
				break;
			case "turn_end":
				emit({
					type: "turn_end",
					usage: event.message.role === "assistant" ? event.message.usage : undefined,
					tools: event.toolResults.length,
				});
				break;
			case "agent_end": {
				ended = true;
				// 会话「止笔」走 agent.abort()，此时 signal 不会置位，只能看收尾状态。
				const aborted = wasAborted(agent, signal);
				// 上游常把错误塞在 200 响应体里（额度用尽、限流都会这样），
				// 适配器只看得到"没有 finish_reason"。补一句人话，并带上原始错误与
				// 已经等了多久 —— 只报"断流了"分不清是超时、Key 失效还是模型名写错。
				if (agent.state.errorMessage && !aborted) {
					emit({
						type: "error",
						message: describeStreamFailure(agent.state.errorMessage, Date.now() - startedAt, sawText),
					});
				}
				emit({
					type: "run_end",
					aborted,
					usage: { ...usage, cacheRead: usage.cacheRead || undefined, cacheWrite: usage.cacheWrite || undefined },
					// 错误已经在上面那条「error」里说过一次；这里再带一遍，前端会
					// 追加第二条「讹误」。止笔时的 "Request was aborted" 同理：
					// 那不是错误，不该被渲染成红字。
					error: undefined,
				});
				break;
			}
			default:
				break;
		}
	});

	return (async () => {
		try {
			await agent.prompt(input);
		} catch (error) {
			// 正常的上游错误会被 Agent 变成一条 error 状态的助手消息、走 agent_end；
			// 走到这个 catch 说明会话或事件循环自己出了意外。agent_end 已经收过尾时
			// 不再补第二组事件，否则同一轮会出现两条「讹误」。
			if (!ended) {
				ended = true;
				const detail = error instanceof Error ? error.message : String(error);
				const aborted = signal.aborted || (error instanceof Error && error.name === "AbortError");
				if (!aborted) {
					emit({
						type: "error",
						message: `这一轮没有跑完（等了 ${formatElapsed(Date.now() - startedAt)}）：${detail}`,
					});
				}
				emit({
					type: "run_end",
					aborted,
					usage,
					// 同上：原始错误已经在人话里，这里再带一次会重复。
					error: undefined,
				});
			}
		} finally {
			unsubscribe();
		}
	})();
}

/** 工具结果截断，避免正文全量进入事件流。 */
function previewResult(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
	const text = (content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 供应商 id：拉丁字母与数字，其余折叠为连字符。中文名会退化为时间戳后缀。 */
function slugify(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || `custom-${Date.now().toString(36)}`;
}

/** token 上限必须是正整数：0、负数、小数与非数都不接受。 */
function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 两个模型的可调参数是否一致（用于判断这次批量更新有没有真的改到东西）。 */
function sameModelParams(a: ModelConfig, b: ModelConfig): boolean {
	return (
		a.contextWindow === b.contextWindow &&
		a.maxTokens === b.maxTokens &&
		a.reasoning === b.reasoning &&
		a.thinkingLevels.length === b.thinkingLevels.length &&
		a.thinkingLevels.every((level, index) => level === b.thinkingLevels[index])
	);
}

/**
 * 把作品铺成可以带走的纯文本。
 *
 * 单章只给这一章的题头与正文；全书另加书名与骨相 —— 导出的东西通常要直接贴进
 * 别的编辑器或投稿系统，多一层信息比少一层更容易删。没落笔的章节一律跳过：
 * 导出成一片空白没有意义，还得用户自己回头删。
 * 章序用阿拉伯数字：中文数字过了百章就开始别扭，导出件不该有这种上限。
 */
function buildExport(project: Project, chapterId: string | null, markdown: boolean): string {
	const blocks: string[] = [];
	if (!chapterId) {
		blocks.push((markdown ? "# " : "") + project.title);
		const meta = [project.genre, project.logline].filter(Boolean).join(" · ");
		if (meta) blocks.push(meta);
	}

	project.outline.forEach((chapter, index) => {
		if (chapterId && chapter.id !== chapterId) return;
		const body = project.drafts[chapter.id]?.content.trim() ?? "";
		// 单章导出即使还没落笔也要给出章名，否则用户拿到一个空文件不知所以。
		if (!body && !chapterId) return;
		const heading = (markdown ? "## " : "") + "第" + (index + 1) + "章 " + chapter.title;
		blocks.push(body ? heading + "\n\n" + body : heading);
	});

	return blocks.join("\n\n") + "\n";
}

/** 导出文件名。路径分隔符与控制字符一律换成下划线，别让它爬出下载目录。 */
function exportFilename(project: Project, chapterId: string | null, ext: string): string {
	const safe = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
	const book = safe(project.title) || "未命名";
	if (!chapterId) return book + "." + ext;
	const index = project.outline.findIndex((chapter) => chapter.id === chapterId);
	const title = safe(project.outline[index]?.title ?? "") || chapterId;
	return book + " 第" + (index + 1) + "章 " + title + "." + ext;
}

async function statusOf(id: string) {
	return (await listProviderStatus()).find((provider) => provider.id === id);
}

/**
 * 决定这一轮用哪支笔。
 *
 * 优先级：调用方指定 > 设置页选的默认 > .env 的 DEFAULT_MODEL。
 *
 * 早先这里是 body.modelRef?.trim() || config.defaultModel，直接跳过了设置页 ——
 * 于是用户在设置页挑的默认模型只是摆设，改了不生效；DEFAULT_MODEL 未设时还会
 * 拿到空串直接 400。两处 thinkingLevel 本来就读的是 settings，这里对齐成同一套。
 */
function resolveDefaultModel(requested?: string): string {
	return requested?.trim() || settingsStore.get().defaultModel.trim() || config.defaultModel;
}
/**
 * 供应商视图：给每个模型补上 placeholder 标记。
 *
 * 上下文窗口与输出上限还停在占位值上，说明这个模型没被人核对过。
 * 设置页据此打「待核对」徽标；这是只读视图，落盘的配置本身不带这个字段。
 */
function providerView(provider: ProviderConfig) {
	return {
		...provider,
		models: provider.models.map((model) => ({ ...model, placeholder: isPlaceholderModel(model) })),
	};
}

/** 设置页需要的完整视图：配置、运行时状态、内置厂商目录。 */
async function settingsView() {
	const settings = settingsStore.get();
	return {
		defaultModel: settings.defaultModel,
		defaultThinkingLevel: settings.defaultThinkingLevel,
		providers: settings.providers.map((provider) => providerView(provider)),
		statuses: await listProviderStatus(),
		defaults: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
		builtinCatalog: BUILTIN_PROVIDERS.map((spec) => ({
			id: spec.id,
			label: spec.label,
			envVars: [...spec.envVars],
		})),
	};
}

/** 哪些作品取用过某条通用素材。从工程现算，不落盘，免得两边不一致。 */
function libraryUsage(): Map<string, Array<{ projectId: string; title: string; materialId: string }>> {
	const usage = new Map<string, Array<{ projectId: string; title: string; materialId: string }>>();
	for (const project of store.list()) {
		for (const material of project.materials) {
			if (!material.originId) continue;
			const list = usage.get(material.originId) ?? [];
			list.push({ projectId: project.id, title: project.title, materialId: material.id });
			usage.set(material.originId, list);
		}
	}
	return usage;
}

/** 素材库视图：条目 + 取用情况 + 种类表。 */
function libraryView() {
	const usage = libraryUsage();
	return {
		materials: libraryStore.list().map((entry) => ({ ...entry, usedBy: usage.get(entry.id) ?? [] })),
		kinds: MATERIAL_KINDS.map((kind) => ({ kind, label: MATERIAL_KIND_LABELS[kind] })),
	};
}

/** 过滤标签数组：去掉非字符串与空串。 */
function pickTags(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
		: [];
}

/**
 * 作品摘要：列表与卷宗页只关心这几个字段。
 *
 * 带上 logline / styleGuide / targetWords 是为了让"改卷宗"不必再取一次全量 ——
 * 但正文与素材全文不在这里，列表不该把整本书传过去。
 */
function projectSummary(project: Project) {
	return {
		id: project.id,
		title: project.title,
		genre: project.genre,
		logline: project.logline,
		styleGuide: project.styleGuide,
		targetWords: project.targetWords,
		updatedAt: project.updatedAt,
		stats: store.stats(project),
	};
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const { pathname } = url;

	if (pathname === "/api/bootstrap" && req.method === "GET") {
		const [models, providers, settings] = await Promise.all([listAvailableModels(), listProviderStatus(), settingsView()]);
		return json(res, 200, {
			defaultModel: settings.defaultModel,
			defaultThinkingLevel: settings.defaultThinkingLevel,
			models,
			providers,
			settings,
			projects: store.list().map(projectSummary),
		});
	}

	if (pathname === "/api/models" && req.method === "GET") {
		return json(res, 200, { models: await listAvailableModels() });
	}

	if (pathname === "/api/projects" && req.method === "GET") {
		return json(res, 200, { projects: store.list().map(projectSummary) });
	}

	if (pathname === "/api/projects" && req.method === "POST") {
		const body = await readJsonBody<Parameters<ProjectStore["create"]>[0] & { libraryIds?: string[] }>(req);
		// 新建时可以从通用素材库取料。取用是复制：副本归这本书，之后的改动不回写库。
		const libraryIds = Array.isArray(body.libraryIds)
			? body.libraryIds.filter((value): value is string => typeof value === "string")
			: [];
		const taken = libraryIds
			.map((id) => libraryStore.get(id))
			.filter((entry): entry is LibraryMaterial => entry !== undefined);

		let project = store.create(body);
		if (taken.length > 0) {
			project = store.mutate(project.id, (draft) => {
				for (const entry of taken) draft.materials.push(materialFromLibrary(entry));
			});
		}
		return json(res, 201, { project, stats: store.stats(project) });
	}

	// 新建章节：作者自己立一章的入口。
	// 章节此前只能由设定官的 update_outline 产出 —— 而没有章节，生文工作台就没有装配落点，
	// 素材也就无处可装，界面上只能看到一片空。
	const chaptersMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters$/);
	if (chaptersMatch && req.method === "POST") {
		const projectId = chaptersMatch[1]!;
		if (!store.get(projectId)) return json(res, 404, { error: "工程不存在" });
		const body = await readJsonBody<{
			title?: string;
			summary?: string;
			pov?: string;
			targetWords?: number;
		}>(req);
		const title = body.title?.trim();
		if (!title) return json(res, 400, { error: "请填写章节标题" });
		// id 在 mutate 内部现算：并发立章也不会撞号。
		let createdId = "";
		const saved = store.mutate(projectId, (draft) => {
			const taken = new Set(draft.outline.map((chapter) => chapter.id));
			let n = draft.outline.length + 1;
			createdId = "ch" + String(n).padStart(2, "0");
			while (taken.has(createdId)) createdId = "ch" + String(++n).padStart(2, "0");
			draft.outline.push({
				id: createdId,
				title,
				summary: body.summary?.trim() ?? "",
				pov: body.pov?.trim() ?? "",
				status: "planned",
				targetWords:
					typeof body.targetWords === "number" && body.targetWords > 0 ? Math.floor(body.targetWords) : 0,
				notes: "",
				materialIds: [],
			});
		});
		const chapter = saved.outline.find((item) => item.id === createdId);
		return json(res, 201, { chapter, stats: store.stats(saved) });
	}

	// 保存章节正文（稿件视图的直接编辑）
	const chapterMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)$/);
	if (chapterMatch && req.method === "PATCH") {
		const project = store.get(chapterMatch[1]!);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(chapterMatch[2]!);
		// 大纲里没有这一章时不能凭一个 id 凭空造 draft：正文会挂不上任何章，
		// 前端也永远列不出它，等于一份幽灵稿。
		if (!project.outline.some((chapter) => chapter.id === chapterId)) {
			return json(res, 404, { error: "章节不存在" });
		}
		const body = await readJsonBody<{ content?: string; title?: string; autosave?: boolean }>(req);
		if (typeof body.content !== "string") return json(res, 400, { error: "缺少 content" });
		// 取成常量：属性访问的类型收窄无法穿透闭包。
		const content = body.content;
		// autosave 是前端定时持久化的草稿：内容要存，但不构成版本点。
		// 显式保存才归档旧稿 —— 每 1.5 秒一次的自动保存若都进 history，
		// 最近 10 版会全是零碎片段，真正的版本历史就没了。
		const autosave = body.autosave === true;
		// 与智能体的 write_chapter 共用同一把按章的锁：两边都是整段覆盖，
		// 谁后写谁赢会让先写的内容无声消失。
		const saved = await store.withChapterLock(project.id, chapterId, () =>
			store.mutate(project.id, (draft) => {
				const existing = draft.drafts[chapterId];
				const planned = draft.outline.find((c) => c.id === chapterId);
				// 手动存稿和智能体写稿都会覆盖旧稿，走同一个归档逻辑。
				const history = [...(existing?.history ?? [])];
				// 内容没变就不留版本：连点两次"存稿"不该产生一份重复历史。
				const sameContent = existing !== undefined && existing.content.trim() === content.trim();
				if (existing && existing.content.trim() && !autosave && !sameContent) {
					history.push({
						revision: existing.revision,
						title: existing.title,
						content: existing.content,
						materialIds: existing.materialIds,
						updatedAt: existing.updatedAt,
						mode: "manual",
					});
					while (history.length > MAX_DRAFT_HISTORY) history.shift();
				}
				draft.drafts[chapterId] = {
					id: chapterId,
					title: body.title?.trim() || existing?.title || chapterId,
					content,
					revision: (existing?.revision ?? 0) + 1,
					updatedAt: Date.now(),
					// 首次存稿时继承该章的装配清单：正文是拿这些料写的，
					// 留空会让"这段正文从什么料来"的回溯断掉。
					materialIds: existing?.materialIds ?? planned?.materialIds ?? [],
					history,
				};
			}),
		);
		return json(res, 200, { chapter: saved.drafts[chapterId], stats: store.stats(saved) });
	}

	// 导出：整本或单章。正文原样给出，不重排、不加字数标记 —— 导出的稿子要能直接进别的编辑器。
	const exportMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/export$/);
	if (exportMatch && req.method === "GET") {
		const project = store.get(exportMatch[1]!);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const chapterId = url.searchParams.get("chapter");
		if (chapterId && !project.outline.some((chapter) => chapter.id === chapterId)) {
			return json(res, 404, { error: "章节不存在" });
		}
		const markdown = url.searchParams.get("format") === "md";
		const ext = markdown ? "md" : "txt";
		const text = buildExport(project, chapterId, markdown);
		res.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"content-length": Buffer.byteLength(text),
			// 文件名里有中文，只能走 RFC 5987 的 filename*：塞进 filename= 的非 ASCII 会被浏览器整个丢掉。
			"content-disposition":
				`attachment; filename="novel.${ext}"; filename*=UTF-8''${encodeURIComponent(exportFilename(project, chapterId, ext))}`,
		});
		res.end(text);
		return;
	}

	const projectMatch = pathname.match(/^\/api\/projects\/([\w-]+)$/);
	if (projectMatch) {
		const projectId = projectMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(res, 404, { error: "工程不存在" });

		if (req.method === "GET") return json(res, 200, { project, stats: store.stats(project) });

		if (req.method === "DELETE") {
			// 只删这部作品，不动素材库：库里记的取用情况是从工程现算的，会自己跟上。
			// 整部作品没法像素材那样退回，所以删之前先把整本存一份快照，
			// 删错了还能从快照里捞回来。
			await store.snapshot(project, "before-project-delete");
			await store.remove(projectId);
			return json(res, 200, { ok: true });
		}

		if (req.method === "PATCH") {
			const body = await readJsonBody<{
				title?: string;
				genre?: string;
				logline?: string;
				synopsis?: string;
				styleGuide?: string;
				targetWords?: number;
			}>(req);
			const saved = store.mutate(projectId, (draft) => {
				if (typeof body.title === "string" && body.title.trim()) draft.title = body.title.trim();
				if (typeof body.genre === "string") draft.genre = body.genre.trim();
				if (typeof body.logline === "string") draft.logline = body.logline.trim();
				if (typeof body.synopsis === "string") draft.synopsis = body.synopsis.trim();
				if (typeof body.styleGuide === "string") draft.styleGuide = body.styleGuide.trim();
				if (typeof body.targetWords === "number" && body.targetWords >= 0) {
					draft.targetWords = Math.floor(body.targetWords);
				}
			});
			return json(res, 200, { project: saved, stats: store.stats(saved) });
		}
	}

	if (pathname === "/api/sessions" && req.method === "POST") {
		const body = await readJsonBody<{
			projectId?: string;
			role?: AgentRole;
			chapterId?: string;
			modelRef?: string;
			thinkingLevel?: ThinkingLevel;
			/** "library" 时不绑工程：作者要在开书之前先把通用素材备好。 */
			scope?: string;
		}>(req);
		// 库作用域不绑工程：那时作者还没建书，不该强迫他先随便开一卷。
		const libraryScope = body.scope === "library";
		if (!libraryScope) {
			if (!body.projectId) return json(res, 400, { error: "缺少 projectId" });
			if (!store.get(body.projectId)) return json(res, 404, { error: "工程不存在" });
		}

		// 默认是素材会话：写作是一次性动作，不走常驻会话。
		const role: AgentRole = body.role === "writing" ? "writing" : "material";
		if (role === "writing" && !body.chapterId) {
			return json(res, 400, { error: "写作会话需要 chapterId" });
		}

		const modelRef = resolveDefaultModel(body.modelRef);
		if (!modelRef) return json(res, 400, { error: "请指定模型" });

		let model: Model<any>;
		try {
			model = await resolveModel(modelRef);
		} catch (error) {
			const status = error instanceof ModelResolutionError ? 400 : 500;
			return json(res, status, { error: (error as Error).message, candidates: error instanceof ModelResolutionError ? error.candidates : [] });
		}

		const session: Session = {
			id: randomUUID(),
			projectId: body.projectId ?? "",
			role,
			...(libraryScope ? { libraryScope: true } : {}),
			...(body.chapterId ? { chapterId: body.chapterId } : {}),
			modelRef: `${model.provider}/${model.id}`,
			thinkingLevel: body.thinkingLevel ?? settingsStore.get().defaultThinkingLevel,
			agent: undefined as unknown as Agent,
			model,
			createdAt: Date.now(),
		};
		try {
			replaceAgent(session, model);
		} catch (error) {
			return json(res, 400, { error: (error as Error).message });
		}
		pruneSessions();
		sessions.set(session.id, session);
		return json(res, 201, {
			sessionId: session.id,
			role: session.role,
			model: session.modelRef,
			thinkingLevel: session.thinkingLevel,
		});
	}
	const modelMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/model$/);
	if (modelMatch && req.method === "POST") {
		const session = sessions.get(modelMatch[1]!);
		if (!session) return json(res, 404, { error: "会话不存在或已过期" });
		// 生成途中换模型会把正在跑的那支智能体整支换掉：旧流还挂在旧对象上，
		// 前端却以为下一轮已经换了脑子。让当前这轮先结束（或先中止）再换。
		if (session.agent.state.isStreaming) {
			return json(res, 409, { error: "当前这轮还在生成中，请先中止或等它结束再换模型" });
		}
		const body = await readJsonBody<{ modelRef?: string; thinkingLevel?: ThinkingLevel }>(req);
		try {
			const model = await resolveModel(body.modelRef ?? "");
			session.modelRef = `${model.provider}/${model.id}`;
			if (body.thinkingLevel) session.thinkingLevel = body.thinkingLevel;
			// 保留对话历史，只更换模型与推理档位。
			const messages = [...session.agent.state.messages];
			replaceAgent(session, model);
			session.agent.state.messages = messages;
			return json(res, 200, { model: session.modelRef, thinkingLevel: session.thinkingLevel });
		} catch (error) {
			const status = error instanceof ModelResolutionError ? 400 : 500;
			return json(res, status, { error: (error as Error).message, candidates: error instanceof ModelResolutionError ? error.candidates : [] });
		}
	}

	const abortMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/abort$/);
	if (abortMatch && req.method === "POST") {
		const session = sessions.get(abortMatch[1]!);
		if (!session) return json(res, 404, { error: "会话不存在" });
		session.agent.abort();
		return json(res, 200, { ok: true });
	}

	/**
	 * 丢弃一席对话。
	 *
	 * 会话是常驻的：同一个面板反复追问，历史会一直攒下去，最后既占窗口
	 * 又让模型被前面的旧话牵着走。作者要能主动另起一席干净的。
	 * 先掐断在跑的那一轮再删，否则流还挂在被删掉的会话上。
	 */
	const sessionMatch = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
	if (sessionMatch && req.method === "DELETE") {
		const session = sessions.get(sessionMatch[1]!);
		if (!session) return json(res, 404, { error: "会话不存在" });
		session.agent.abort();
		sessions.delete(session.id);
		return json(res, 200, { ok: true });
	}

	const messageMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/messages$/);
	if (messageMatch && req.method === "POST") {
		const session = sessions.get(messageMatch[1]!);
		if (!session) return json(res, 404, { error: "会话不存在或已过期" });
		// 上传的资料可能整篇进对话，给足体积。
		const body = await readJsonBody<{ input?: string }>(req, 8_000_000);
		const input = body.input?.trim();
		if (!input) return json(res, 400, { error: "请求空白" });
		if (session.agent.state.isStreaming) return json(res, 409, { error: "上一条消息还在生成中" });
		// 写作会话的组装上下文会随装料变化，每轮重建让提示词跟上。
		if (session.role === "writing") refreshWritingAgent(session);
		return streamNdjson(res, session.agent, session.modelRef, input);
	}

	/**
	 * 一次性写作：组装本章素材 → 生成正文。
	 *
	 * 不建常驻会话、不留历史。上下文在服务端算好后一次性交给写作智能体，
	 * 章末正文由 write_chapter 落盘，因此连不上也不会丢稿。
	 */
	const writeMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)\/write$/);
	if (writeMatch && req.method === "POST") {
		const projectId = writeMatch[1]!;
		if (!store.get(projectId)) return json(res, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(writeMatch[2]!);
		const body = await readJsonBody<{
			modelRef?: string;
			thinkingLevel?: ThinkingLevel;
			mode?: string;
			note?: string;
		}>(req);

		// mode 决定提示词里的"作业"，先定下来再组装上下文。
		if (body.mode !== undefined && !WRITE_MODES.includes(body.mode as ChapterWriteMode)) {
			return json(res, 400, { error: "mode 只能是 create / rewrite / continue" });
		}
		const hasDraft = Boolean(store.get(projectId)?.drafts[chapterId]);
		const mode: ChapterWriteMode = (body.mode as ChapterWriteMode | undefined) ?? (hasDraft ? "rewrite" : "create");

		let assembly: WritingContext;
		try {
			assembly = buildWritingContext(projectId, chapterId, mode);
		} catch (error) {
			return json(res, 404, { error: (error as Error).message });
		}
		const blocked = writingPreflight(assembly);
		if (blocked) return json(res, 409, { error: blocked });

		const modelRef = resolveDefaultModel(body.modelRef);
		if (!modelRef) return json(res, 400, { error: "请指定模型" });
		let model: Model<any>;
		try {
			model = await resolveModel(modelRef);
		} catch (error) {
			const status = error instanceof ModelResolutionError ? 400 : 500;
			return json(res, status, { error: (error as Error).message, candidates: error instanceof ModelResolutionError ? error.candidates : [] });
		}

		const instruction = writingInstruction(assembly, body.note?.trim());
		const agent = createNovelAgent({
			store,
			projectId,
			model,
			models: getModels(),
			config,
			sessionId: randomUUID(),
			role: "writing",
			chapterId,
			writing: assembly,
			thinkingLevel: body.thinkingLevel ?? settingsStore.get().defaultThinkingLevel,
		});
		return streamNdjson(res, agent, `${model.provider}/${model.id}`, instruction);
	}


	// ---------------------------------------------------------------- 通用素材库
	//
	// 跨作品的一层：库里的料不属于任何一部小说。新建作品时可以把它们取进作品，
	// 作品里改好的料也可以存回库里。取用是复制（materialFromLibrary），
	// 所以作品文件始终自包含，删掉库里的条目也不会让已有作品缺料。

	if (pathname === "/api/library" && req.method === "GET") {
		return json(res, 200, libraryView());
	}

	if (pathname === "/api/library" && req.method === "POST") {
		const body = await readJsonBody<{
			kind?: string;
			title?: string;
			content?: string;
			usage?: string;
			tags?: string[];
		}>(req, 8_000_000);
		const title = body.title?.trim();
		const content = body.content?.trim();
		if (!title) return json(res, 400, { error: "请填写素材标题" });
		if (!content) return json(res, 400, { error: "素材内容是空的" });
		const entry = libraryStore.create({
			kind: MATERIAL_KINDS.includes(body.kind as MaterialKind) ? (body.kind as MaterialKind) : "other",
			title,
			content,
			usage: body.usage?.trim() ?? "",
			tags: pickTags(body.tags),
			// 作者亲手收录的，直接算确认过的。
			status: "confirmed",
		});
		return json(res, 201, { material: entry, ...libraryView() });
	}

	const libraryItemMatch = pathname.match(/^\/api\/library\/([\w-]+)$/);
	if (libraryItemMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const libraryId = libraryItemMatch[1]!;
		if (!libraryStore.get(libraryId)) return json(res, 404, { error: "通用素材不存在" });

		if (req.method === "DELETE") {
			libraryStore.remove(libraryId);
			return json(res, 200, { ok: true, ...libraryView() });
		}

		const body = await readJsonBody<{
			kind?: string;
			title?: string;
			content?: string;
			usage?: string;
			tags?: string[];
			status?: string;
		}>(req, 8_000_000);
		const input: LibraryMaterialInput = {};
		if (typeof body.kind === "string" && MATERIAL_KINDS.includes(body.kind as MaterialKind)) {
			input.kind = body.kind as MaterialKind;
		}
		if (typeof body.title === "string") input.title = body.title;
		if (typeof body.content === "string") input.content = body.content;
		if (typeof body.usage === "string") input.usage = body.usage;
		if (body.status === "confirmed" || body.status === "draft") input.status = body.status;
		if (Array.isArray(body.tags)) input.tags = pickTags(body.tags);
		return json(res, 200, { material: libraryStore.update(libraryId, input), ...libraryView() });
	}

	/** 把作品里的一条素材存进通用素材库，或更新它来源的那一条。 */
	const promoteMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/materials\/([^/]+)\/library$/);
	if (promoteMatch && req.method === "POST") {
		const projectId = promoteMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const materialId = decodeURIComponent(promoteMatch[2]!);
		const material = project.materials.find((item) => item.id === materialId);
		if (!material) return json(res, 404, { error: "素材不存在" });

		const body = await readJsonBody<{ mode?: string; title?: string }>(req);
		const mode = body.mode === "update" ? "update" : "create";
		// 更新只在这条料确实有来源条目时成立：否则会把别人收录的条目覆盖掉。
		if (mode === "update" && (!material.originId || !libraryStore.get(material.originId))) {
			return json(res, 409, { error: "这条素材没有可更新的库条目，请改用「另存为新条目」" });
		}

		const fields = libraryFieldsOf(material);
		if (typeof body.title === "string" && body.title.trim()) fields.title = body.title.trim();

		if (mode === "update") {
			const updated = libraryStore.update(material.originId!, fields);
			return json(res, 200, { mode, material: updated, ...libraryView() });
		}

		const entry = libraryStore.create({ ...fields, status: "confirmed" });
		// 记下来源：之后在作品里改好了可以直接推回这一条。
		store.mutate(projectId, (draft) => {
			const target = draft.materials.find((item) => item.id === materialId);
			if (target) target.originId = entry.id;
		});
		return json(res, 200, { mode, material: entry, ...libraryView() });
	}

	// ---------------------------------------------------------------- 工作台操作
	//
	// 以下都是作者在工作台里的直接操作。它们与智能体的工具写同一套数据结构：
	// 装料共用 linkMaterials，所以"人装的料"和"墨客装的料"不会把双向索引写歪。

	/**
	 * 上传原料：只提取文本交回前端预览，不落盘、不建素材。
	 *
	 * 库作用域不绑工程 —— 作者还没建书时也要能把资料喂给设定官，
	 * 所以另开一条不带 projectId 的路，提取逻辑与作品那条完全共用。
	 */
	if (pathname === "/api/uploads" && req.method === "POST") {
		const filename = url.searchParams.get("filename")?.trim();
		if (!filename) return json(res, 400, { error: "缺少 filename" });
		if (exceedsUploadLimit(req)) return uploadLimitError(res);
		let buffer: Buffer;
		try {
			buffer = await readRawBody(req, MAX_UPLOAD_BYTES);
		} catch (error) {
			return json(res, 413, { error: (error as Error).message });
		}
		if (buffer.length === 0) return json(res, 400, { error: "文件是空的" });
		try {
			return json(res, 200, { upload: { filename, ...extractText(filename, buffer) } });
		} catch (error) {
			if (error instanceof UploadTooLargeError) return json(res, 413, { error: error.message });
			if (error instanceof UnsupportedUploadError) return json(res, 415, { error: error.message });
			throw error;
		}
	}

	/** 上传原料（作品作用域）：同上，只是多一道工程存在性检查。 */
	const uploadMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/uploads$/);
	if (uploadMatch && req.method === "POST") {
		if (!store.get(uploadMatch[1]!)) return json(res, 404, { error: "工程不存在" });
		const filename = url.searchParams.get("filename")?.trim();
		if (!filename) return json(res, 400, { error: "缺少 filename" });
		if (exceedsUploadLimit(req)) return uploadLimitError(res);
		let buffer: Buffer;
		try {
			buffer = await readRawBody(req, MAX_UPLOAD_BYTES);
		} catch (error) {
			return json(res, 413, { error: (error as Error).message });
		}
		if (buffer.length === 0) return json(res, 400, { error: "文件是空的" });
		try {
			return json(res, 200, { upload: { filename, ...extractText(filename, buffer) } });
		} catch (error) {
			if (error instanceof UploadTooLargeError) return json(res, 413, { error: error.message });
			if (error instanceof UnsupportedUploadError) return json(res, 415, { error: error.message });
			throw error;
		}
	}

	/** 新建素材：上传的原料经作者确认后入库。 */
	const materialCreateMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/materials$/);
	if (materialCreateMatch && req.method === "POST") {
		const projectId = materialCreateMatch[1]!;
		if (!store.get(projectId)) return json(res, 404, { error: "工程不存在" });
		const body = await readJsonBody<{
			kind?: string;
			title?: string;
			content?: string;
			usage?: string;
			tags?: string[];
			chapterIds?: string[];
		}>(req, 8_000_000);
		const title = body.title?.trim();
		const content = body.content?.trim();
		if (!title) return json(res, 400, { error: "请填写素材标题" });
		if (!content) return json(res, 400, { error: "素材内容是空的" });

		const id = randomUUID();
		const chapterIds = Array.isArray(body.chapterIds)
			? body.chapterIds.filter((value): value is string => typeof value === "string")
			: [];
		const saved = store.mutate(projectId, (project) => {
			project.materials.push({
				id,
				kind: MATERIAL_KINDS.includes(body.kind as MaterialKind) ? (body.kind as MaterialKind) : "other",
				title,
				content,
				tags: Array.isArray(body.tags)
					? body.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
					: [],
				usage: body.usage?.trim() ?? "",
				// 作者亲手交的料直接算确认过的；模型拟的才需要再过一道。
				status: "confirmed",
				chapterIds: [],
				source: "human",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			for (const chapterId of chapterIds) linkMaterials(project, chapterId, [id], "add");
		});
		return json(res, 201, {
			material: saved.materials.find((item) => item.id === id),
			stats: store.stats(saved),
		});
	}

	/** 改 / 删单条素材。 */
	const materialItemMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/materials\/([^/]+)$/);
	if (materialItemMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const projectId = materialItemMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const materialId = decodeURIComponent(materialItemMatch[2]!);
		if (!project.materials.some((item) => item.id === materialId)) {
			return json(res, 404, { error: "素材不存在" });
		}

		if (req.method === "DELETE") {
			// 删除前拍快照：素材可能是作者手写了很久的，删了就没了。
			// removeMaterial 会顺手把它从各章装配清单里摘掉，
			// 否则那些章节的"装料 N 条"会一直虚高。
			await store.snapshot(project, "before-material-delete");
			const saved = store.mutate(projectId, (draft) => {
				removeMaterial(draft, materialId);
			});
			return json(res, 200, { ok: true, stats: store.stats(saved) });
		}

		const body = await readJsonBody<{
			kind?: string;
			title?: string;
			content?: string;
			usage?: string;
			tags?: string[];
			status?: string;
			chapterIds?: string[];
		}>(req, 8_000_000);
		const saved = store.mutate(projectId, (draft) => {
			const material = draft.materials.find((item) => item.id === materialId)!;
			if (typeof body.title === "string" && body.title.trim()) material.title = body.title.trim();
			if (typeof body.content === "string" && body.content.trim()) material.content = body.content.trim();
			if (typeof body.usage === "string") material.usage = body.usage.trim();
			if (MATERIAL_KINDS.includes(body.kind as MaterialKind)) material.kind = body.kind as MaterialKind;
			if (body.status === "confirmed" || body.status === "draft") material.status = body.status;
			if (Array.isArray(body.tags)) {
				material.tags = body.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "");
			}
			// chapterIds 传了就整体替换装配关系，传空表等于从所有章节摘除。
			if (Array.isArray(body.chapterIds)) {
				const wanted = new Set(body.chapterIds.filter((value): value is string => typeof value === "string"));
				for (const chapter of draft.outline) {
					linkMaterials(draft, chapter.id, [materialId], wanted.has(chapter.id) ? "add" : "remove");
				}
			}
			material.updatedAt = Date.now();
		});
		return json(res, 200, {
			material: saved.materials.find((item) => item.id === materialId),
			stats: store.stats(saved),
		});
	}

	/** 作者在工作台里直接装料 / 摘料。 */
	const assemblyMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)\/materials$/);
	if (assemblyMatch && req.method === "POST") {
		const projectId = assemblyMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(assemblyMatch[2]!);
		if (!project.outline.some((item) => item.id === chapterId)) {
			return json(res, 404, { error: "章节不存在" });
		}
		const body = await readJsonBody<{ add?: string[]; remove?: string[] }>(req, 8_000_000);
		const pick = (value: unknown) =>
			Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
		const add = pick(body.add);
		const remove = pick(body.remove);
		if (add.length === 0 && remove.length === 0) {
			return json(res, 400, { error: "add 与 remove 不能同时为空" });
		}
		const skipped: string[] = [];
		const saved = store.mutate(projectId, (draft) => {
			// 先摘后装：同一批里既摘又装时，装是作者的最终意图。
			skipped.push(...linkMaterials(draft, chapterId, remove, "remove").skipped);
			skipped.push(...linkMaterials(draft, chapterId, add, "add").skipped);
		});
		return json(res, 200, {
			chapter: saved.outline.find((item) => item.id === chapterId),
			assembled: assembledMaterials(saved, chapterId).map((material) => material.id),
			skipped,
			stats: store.stats(saved),
		});
	}
	// 右案素材页：按 kind 过滤，便于分组展示。
	const materialsMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/materials$/);
	if (materialsMatch && req.method === "GET") {
		const project = store.get(materialsMatch[1]!);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const kind = url.searchParams.get("kind")?.trim();
		const materials = kind ? project.materials.filter((m) => m.kind === kind) : project.materials;
		return json(res, 200, { materials, kinds: MATERIAL_KINDS.map((k) => ({ kind: k, label: MATERIAL_KIND_LABELS[k] })) });
	}


	// ---------------------------------------------------------------- 设置

	if (pathname === "/api/settings" && req.method === "GET") {
		return json(res, 200, await settingsView());
	}

	if (pathname === "/api/settings" && req.method === "PUT") {
		const body = await readJsonBody<{ defaultModel?: string; defaultThinkingLevel?: string }>(req);
		settingsStore.mutate((settings) => {
			if (typeof body.defaultModel === "string") settings.defaultModel = body.defaultModel.trim();
			if (typeof body.defaultThinkingLevel === "string") {
				const level = body.defaultThinkingLevel as Settings["defaultThinkingLevel"];
				if (THINKING_LEVELS.includes(level)) settings.defaultThinkingLevel = level;
			}
		});
		return json(res, 200, await settingsView());
	}

	// 新增自定义供应商
	if (pathname === "/api/providers" && req.method === "POST") {
		const body = await readJsonBody<{
			label?: string;
			baseUrl?: string;
			api?: ApiFormat;
			apiKey?: string;
			noAuthRequired?: boolean;
		}>(req);

		const label = body.label?.trim();
		const baseUrl = body.baseUrl?.trim();
		const api = body.api;
		if (!label) return json(res, 400, { error: "请填写供应商名称" });
		if (!baseUrl) return json(res, 400, { error: "请填写 Base URL" });
		if (!api || !API_FORMATS.includes(api)) return json(res, 400, { error: "请选择接口格式" });
		try {
			new URL(baseUrl);
		} catch {
			return json(res, 400, { error: "Base URL 不是合法地址" });
		}
		if (settingsStore.getProvider(slugify(label))) {
			return json(res, 409, { error: "同名供应商已存在" });
		}

		const id = slugify(label);
		const created = settingsStore.upsertProvider({
			id,
			label,
			kind: "custom",
			baseUrl,
			api,
			...(body.noAuthRequired === true ? { noAuthRequired: true } : {}),
			models: [],
			enabled: true,
			updatedAt: 0,
		});
		if (body.apiKey?.trim()) await credentialStore.setKey(id, body.apiKey);
		rebuildModels();
		return json(res, 201, { provider: providerView(created), status: await statusOf(created.id) });
	}

	const providerMatch = pathname.match(/^\/api\/providers\/([\w-]+)$/);
	if (providerMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const provider = settingsStore.getProvider(providerMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		if (req.method === "DELETE") {
			settingsStore.removeProvider(provider.id);
			await credentialStore.setKey(provider.id, undefined);
			rebuildModels();
			return json(res, 200, await settingsView());
		}
		const body = await readJsonBody<Partial<ProviderConfig> & { apiKey?: string }>(req);
		settingsStore.upsertProvider({
			...provider,
			...(typeof body.label === "string" && body.label.trim() ? { label: body.label.trim() } : {}),
			...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl.trim() } : {}),
			...(body.api && API_FORMATS.includes(body.api) ? { api: body.api } : {}),
			...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
			...(typeof body.noAuthRequired === "boolean" ? { noAuthRequired: body.noAuthRequired } : {}),
		});
		if (typeof body.apiKey === "string") await credentialStore.setKey(provider.id, body.apiKey);
		rebuildModels();
		return json(res, 200, {
			provider: providerView(settingsStore.getProvider(provider.id)!),
			status: await statusOf(provider.id),
		});
	}

	// 清除已保存的 key
	const keyMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/key$/);
	if (keyMatch && req.method === "DELETE") {
		const provider = settingsStore.getProvider(keyMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		await credentialStore.setKey(provider.id, undefined);
		rebuildModels();
		return json(res, 200, { status: await statusOf(provider.id) });
	}

	// 从上游拉取模型列表
	const fetchMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/fetch$/);
	if (fetchMatch && req.method === "POST") {
		const provider = settingsStore.getProvider(fetchMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		if (provider.kind !== "custom" || !provider.baseUrl || !provider.api) {
			return json(res, 400, { error: "只有自定义供应商需要拉取模型" });
		}
		const credential = await credentialStore.read(provider.id);
		const apiKey = credential?.type === "api_key" && credential.key ? credential.key : "";
		try {
			const fetched = await fetchUpstreamModels({
			baseUrl: provider.baseUrl,
			api: provider.api,
			apiKey,
			noAuthRequired: provider.noAuthRequired === true,
		});
			const { models, added, backfilled } = mergeFetched(provider.models, fetched);
			settingsStore.upsertProvider({ ...provider, models });
			rebuildModels();
			return json(res, 200, {
				provider: providerView(settingsStore.getProvider(provider.id)!),
				fetched: fetched.length,
				added: added.length,
				addedIds: added,
				// 这次从上游回填了限制的模型（原先还是占位值的那几项）。
				backfilled,
			});
		} catch (error) {
			const status = (error as { status?: number }).status;
			return json(res, status && status < 500 ? 502 : 502, { error: (error as Error).message });
		}
	}

	// 新增 / 更新单个模型的参数
	const upsertModelMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models$/);
	if (upsertModelMatch && req.method === "POST") {
		const provider = settingsStore.getProvider(upsertModelMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		const body = await readJsonBody<Partial<ModelConfig> & { id?: string }>(req);
		const id = body.id?.trim();
		if (!id) return json(res, 400, { error: "缺少模型 id" });
		// 覆盖已有模型时以原配置打底：只改请求里出现的字段，
		// 剩下的（cost、thinkingLevels 等）不能因为这次只提交了一个字段就被抹成默认值。
		const existing = provider.models.find((model) => model.id === id);
		const base = existing ?? emptyModel(id);
		const normalized = normalizeSettings({
			providers: [{ ...provider, models: [{ ...base, ...body, id } as ModelConfig] }],
		}).providers[0]!.models[0]!;
		const models = provider.models.some((model) => model.id === id)
			? provider.models.map((model) => (model.id === id ? normalized : model))
			: [...provider.models, normalized];
		settingsStore.upsertProvider({ ...provider, models });
		rebuildModels();
		return json(res, 200, { provider: providerView(settingsStore.getProvider(provider.id)!) });
	}

	// 批量更新模型参数：设置页的"统一改上下文窗口 / 输出上限 / 思考档位"。
	const patchModelsMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models$/);
	if (patchModelsMatch && req.method === "PATCH") {
		const provider = settingsStore.getProvider(patchModelsMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		const body = await readJsonBody<{
			ids?: unknown;
			contextWindow?: unknown;
			maxTokens?: unknown;
			reasoning?: unknown;
			thinkingLevels?: unknown;
		}>(req);

		// ids 缺省或为空数组 = 该供应商的全部模型。
		if (body.ids !== undefined && !Array.isArray(body.ids)) {
			return json(res, 400, { error: "ids 必须是字符串数组" });
		}
		const ids = Array.isArray(body.ids)
			? body.ids
					.filter((id): id is string => typeof id === "string")
					.map((id) => id.trim())
					.filter((id) => id !== "")
			: [];

		if (body.contextWindow !== undefined && !isPositiveInt(body.contextWindow)) {
			return json(res, 400, { error: "contextWindow 必须是正整数" });
		}
		if (body.maxTokens !== undefined && !isPositiveInt(body.maxTokens)) {
			return json(res, 400, { error: "maxTokens 必须是正整数" });
		}
		if (body.reasoning !== undefined && typeof body.reasoning !== "boolean") {
			return json(res, 400, { error: "reasoning 必须是布尔值" });
		}
		let levels: ModelThinkingLevel[] | undefined;
		if (body.thinkingLevels !== undefined) {
			if (
				!Array.isArray(body.thinkingLevels) ||
				body.thinkingLevels.some((level) => !THINKING_LEVELS.includes(level as ModelThinkingLevel))
			) {
				return json(res, 400, { error: "thinkingLevels 含有非法档位" });
			}
			levels = body.thinkingLevels as ModelThinkingLevel[];
		}
		if (body.contextWindow === undefined && body.maxTokens === undefined && body.reasoning === undefined && !levels) {
			return json(res, 400, { error: "没有需要更新的字段" });
		}

		// 开思考时若档位全是 "off"，退回该模型原有的非 off 档位；再没有就用全部非 off 档位。
		const allNonOffLevels = THINKING_LEVELS.filter((level) => level !== "off");
		const updated: string[] = [];
		const models = provider.models.map((model) => {
			if (ids.length > 0 && !ids.includes(model.id)) return model;
			const next: ModelConfig = { ...model, cost: { ...model.cost }, thinkingLevels: [...model.thinkingLevels] };
			if (body.contextWindow !== undefined) next.contextWindow = body.contextWindow as number;
			if (body.maxTokens !== undefined) next.maxTokens = body.maxTokens as number;
			if (typeof body.reasoning === "boolean") {
				next.reasoning = body.reasoning;
				if (!body.reasoning) {
					// 关思考就不该留档位：模型会照着 thinkingLevelMap 发 effort。
					next.thinkingLevels = ["off"];
				} else if (levels) {
					const nonOff = levels.filter((level) => level !== "off");
					if (nonOff.length > 0) {
						next.thinkingLevels = [...levels];
					} else {
						const own = model.thinkingLevels.filter((level) => level !== "off");
						next.thinkingLevels = own.length > 0 ? own : [...allNonOffLevels];
					}
				}
			} else if (levels) {
				next.thinkingLevels = [...levels];
			}
			if (sameModelParams(model, next)) return model;
			updated.push(model.id);
			return next;
		});

		// 走与单个模型保存相同的落盘路径：settings store 持久化 + 重建模型运行时。
		// 再过一遍 normalizeSettings，保证 cost 四个字段、thinkingLevels 档位等不变量照旧成立。
		const normalizedModels = normalizeSettings({ providers: [{ ...provider, models }] }).providers[0]!.models;
		settingsStore.upsertProvider({ ...provider, models: normalizedModels });
		rebuildModels();
		return json(res, 200, {
			updated,
			provider: providerView(settingsStore.getProvider(provider.id)!),
		});
	}

	const modelItemMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/([^/]+)$/);
	if (modelItemMatch && req.method === "DELETE") {
		const provider = settingsStore.getProvider(modelItemMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		const modelId = decodeURIComponent(modelItemMatch[2]!);
		settingsStore.upsertProvider({ ...provider, models: provider.models.filter((model) => model.id !== modelId) });
		rebuildModels();
		return json(res, 200, { provider: providerView(settingsStore.getProvider(provider.id)!) });
	}

	// 落盘健康状况：前端据此提示"这一稿可能没存上"，而不是让用户以为存成功了。
	if (pathname === "/api/storage" && req.method === "GET") {
		const pending = store.pendingWrites();
		// pending 仍按作品粒度（前端只读它）；pendingChapters 给出具体失败的章，
		// 供排查与后续界面细化，旧前端不依赖这个字段。
		const pendingChapters = store.pendingChapterWrites();
		return json(res, 200, {
			ok: pending.length === 0,
			pending,
			pendingChapters,
			message: pending.length > 0 ? "有 " + pending.length + " 部作品未能落盘" : "",
		});
	}

	// 手动触发重试，供前端在用户点"重试保存"时调用。
	if (pathname === "/api/storage/retry" && req.method === "POST") {
		await store.retryPending();
		const pending = store.pendingWrites();
		return json(res, 200, { ok: pending.length === 0, pending });
	}

	const snapshotMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/snapshots$/);
	if (snapshotMatch && req.method === "GET") {
		if (!store.get(snapshotMatch[1]!)) return json(res, 404, { error: "工程不存在" });
		return json(res, 200, { snapshots: await store.listSnapshots(snapshotMatch[1]!) });
	}

	const snapshotItemMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/snapshots\/([^/]+)$/);
	if (snapshotItemMatch && req.method === "POST") {
		const projectId = snapshotItemMatch[1]!;
		const current = store.get(projectId);
		if (!current) return json(res, 404, { error: "工程不存在" });
		const restored = await store.readSnapshot(projectId, decodeURIComponent(snapshotItemMatch[2]!));
		if (!restored) return json(res, 404, { error: "快照不存在或已损坏" });
		// 回滚前先给当前状态拍一份，否则回滚本身就成了不可逆操作。
		await store.snapshot(current, "before-restore");
		store.mutate(projectId, (draft) => {
			// 逐字段覆盖而不是整体替换对象：drafts 需按 id 合并，
			// 替换整个对象会让引用比较误判，从而触发全量重写。
			draft.title = restored.title;
			draft.genre = restored.genre;
			draft.logline = restored.logline;
			draft.synopsis = restored.synopsis;
			draft.styleGuide = restored.styleGuide;
			draft.targetWords = restored.targetWords;
			draft.materials = restored.materials;
			draft.outline = restored.outline;
			draft.notes = restored.notes;
			draft.drafts = { ...restored.drafts };
		});
		return json(res, 200, { project: store.get(projectId) });
	}

	return json(res, 404, { error: "未知接口" });
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
	const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	const target = path.resolve(publicDir, relative);
	// 防止路径遍历越出静态目录。
	if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
		return json(res, 403, { error: "禁止访问" });
	}
	const body = await readFile(target).catch(() => undefined);
	if (!body) return json(res, 404, { error: "未找到" });
	// 本地开发工具，静态资源不缓存，避免改完看到旧版
	res.writeHead(200, {
		"content-type": MIME[path.extname(target)] ?? "application/octet-stream",
		"cache-control": "no-store",
	});
	res.end(body);
}

/**
 * API 兜底：任何未捕获异常都翻成 JSON，绝不让它把进程带走。
 *
 * 请求体解析这类底层错误（413 / 400）没有 res 可写，只能抛；
 * 在这里统一翻译成状态码。500 则说明是真正的意外，照旧记日志再回一句人话。
 */
async function handleApiSafely(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	try {
		await handleApi(req, res, url);
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		console.error("[server]", error);
		if (!res.headersSent) json(res, status, { error: error instanceof Error ? error.message : String(error) });
		else if (!res.writableEnded) res.end();
	}
}

const store = await ProjectStore.open(config.dataDir);
const libraryStore = await MaterialLibrary.open(config.dataDir);
const settingsStore = await SettingsStore.open(config.dataDir);
const credentialStore = await FileCredentialStore.open(config.dataDir);
settingsStore.replace(syncBuiltinProviders(settingsStore.get(), config.defaultModel));
initModelRuntime(settingsStore, credentialStore);

const server = createServer((req, res) => {
	let url: URL;
	try {
		url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	} catch {
		// 畸形请求行（例如扫描器发的 "GET http://["）会让 new URL 直接抛。
		// 合法客户端不会这样请求，回 400 即可，但绝不能让整个进程退出。
		json(res, 400, { error: "请求地址不合法" });
		return;
	}
	const run = url.pathname.startsWith("/api/")
		? handleApiSafely(req, res, url)
		: serveStatic(res, url.pathname);
	run.catch((error) => {
		console.error("[server]", error);
		if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		else if (!res.writableEnded) res.end();
	});
});

server.listen(config.port, config.host, () => {
	console.log(`novel-studio 已启动  http://${config.host}:${config.port}`);
	console.log(`数据目录  ${config.dataDir}`);
	// 上次退出时若有没存上的稿，在这里补写一次。磁盘满、文件被占用这类故障
	// 多半是暂时的，重启后往往已经恢复，不补这一下用户就永远丢了那一稿。
	void store.retryPending().then(() => {
		const pending = store.pendingWrites();
		if (pending.length > 0) console.error("[store] 仍有 " + pending.length + " 部作品未能落盘：" + pending.join(", "));
	});
	void listProviderStatus().then((providers) => {
		const ready = providers.filter((provider) => provider.authSource !== "none" && provider.registered).map((provider) => provider.label);
		console.log(ready.length > 0 ? `已配置厂商  ${ready.join(", ")}` : "未检测到厂商 API Key，请在 .env 中配置");
	});
});
