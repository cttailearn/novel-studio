import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createNovelAgent, type AgentRole } from "../ai/novel-agent.ts";
import type { ChapterWriteMode, WritingContext } from "../ai/prompts.ts";
import { extractText, MAX_UPLOAD_BYTES, UnsupportedUploadError } from "./upload.ts";
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
	normalizeSettings,
	THINKING_LEVELS,
	type ApiFormat,
	type ModelConfig,
	type ProviderConfig,
	type Settings,
} from "../config/settings.ts";
import { loadEnvFile, readConfig, type AppConfig } from "../config/env.ts";
import { assembledMaterials, linkMaterials, MATERIAL_KINDS, MATERIAL_KIND_LABELS, removeMaterial, ProjectStore, type MaterialKind, type Project } from "../store/project.ts";

loadEnvFile();
const config = readConfig();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** 写作作业的三种性质，与提示词里的"作业"一一对应。 */
const WRITE_MODES: readonly ChapterWriteMode[] = ["create", "rewrite", "continue"];

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
	modelRef: string;
	thinkingLevel: ThinkingLevel;
	/** 当前模型对象。写作会话每轮重建智能体时要用它，不必重新解析。 */
	model: Model<any>;
	agent: Agent;
	createdAt: number;
}

const sessions = new Map<string, Session>();

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
	res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage, limitBytes = 1_000_000): Promise<T> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > limitBytes) throw new Error("请求体过大");
		chunks.push(buf);
	}
	if (chunks.length === 0) return {} as T;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	} catch {
		throw new Error("请求体不是合法 JSON");
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
	req: IncomingMessage,
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
	req.on("close", () => {
		state.aborted = true;
		agent.abort();
	});

	try {
		await runAgentStream(agent, modelRef, input, emit, state);
	} finally {
		if (!res.writableEnded) res.end();
	}
}

/** 把 Agent 事件映射成前端可消费的 NDJSON 事件。 */
function runAgentStream(agent: Agent, modelRef: string, input: string, emit: (event: unknown) => void, signal: { aborted: boolean }): Promise<void> {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
	let thinking = false;
	/** 本轮是否真的产出过正文，用来区分"写完了"与"空手而归"。 */
	let sawText = false;

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
			case "agent_end":
				// 上游常把错误塞在 200 响应体里（额度用尽、限流都会这样），
				// 适配器只看得到"没有 finish_reason"。空手而归时补一句人话，
				// 否则界面上只有一句无从下手的 Stream ended without finish_reason。
				if (agent.state.errorMessage && !signal.aborted && !sawText) {
					emit({
						type: "error",
						message:
							"上游没有返回任何内容就断流了。常见原因：额度用尽、Key 失效、中转服务限流，或模型名不被上游接受。" +
							"可到设置里换一个模型或供应商再试。",
					});
				}
				emit({
					type: "run_end",
					aborted: signal.aborted,
					usage: { ...usage, cacheRead: usage.cacheRead || undefined, cacheWrite: usage.cacheWrite || undefined },
					error: agent.state.errorMessage,
				});
				break;
			default:
				break;
		}
	});

	return (async () => {
		try {
			await agent.prompt(input);
		} catch (error) {
			emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
			emit({ type: "run_end", aborted: signal.aborted, usage, error: agent.state.errorMessage });
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

async function statusOf(id: string) {
	return (await listProviderStatus()).find((provider) => provider.id === id);
}

/** 设置页需要的完整视图：配置、运行时状态、内置厂商目录。 */
async function settingsView() {
	const settings = settingsStore.get();
	return {
		defaultModel: settings.defaultModel,
		defaultThinkingLevel: settings.defaultThinkingLevel,
		providers: settings.providers,
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

	// 保存章节正文（稿件视图的直接编辑）
	const chapterMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)$/);
	if (chapterMatch && req.method === "PATCH") {
		const project = store.get(chapterMatch[1]!);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(chapterMatch[2]!);
		const body = await readJsonBody<{ content?: string; title?: string }>(req);
		if (typeof body.content !== "string") return json(res, 400, { error: "缺少 content" });
		// 取成常量：属性访问的类型收窄无法穿透闭包。
		const content = body.content;
		// 与智能体的 write_chapter 共用同一把按章的锁：两边都是整段覆盖，
		// 谁后写谁赢会让先写的内容无声消失。
		const saved = await store.withChapterLock(project.id, chapterId, () =>
			store.mutate(project.id, (draft) => {
				const existing = draft.drafts[chapterId];
				const planned = draft.outline.find((c) => c.id === chapterId);
				draft.drafts[chapterId] = {
					id: chapterId,
					title: body.title?.trim() || existing?.title || chapterId,
					content,
					revision: (existing?.revision ?? 0) + 1,
					updatedAt: Date.now(),
					// 首次存稿时继承该章的装配清单：正文是拿这些料写的，
					// 留空会让"这段正文从什么料来"的回溯断掉。
					materialIds: existing?.materialIds ?? planned?.materialIds ?? [],
				};
			}),
		);
		return json(res, 200, { chapter: saved.drafts[chapterId], stats: store.stats(saved) });
	}

	const projectMatch = pathname.match(/^\/api\/projects\/([\w-]+)$/);
	if (projectMatch) {
		const projectId = projectMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(res, 404, { error: "工程不存在" });

		if (req.method === "GET") return json(res, 200, { project, stats: store.stats(project) });

		if (req.method === "DELETE") {
			// 只删这部作品，不动素材库：库里记的取用情况是从工程现算的，会自己跟上。
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
		}>(req);
		if (!body.projectId) return json(res, 400, { error: "缺少 projectId" });
		if (!store.get(body.projectId)) return json(res, 404, { error: "工程不存在" });

		// 默认是素材会话：写作是一次性动作，不走常驻会话。
		const role: AgentRole = body.role === "writing" ? "writing" : "material";
		if (role === "writing" && !body.chapterId) {
			return json(res, 400, { error: "写作会话需要 chapterId" });
		}

		const modelRef = body.modelRef?.trim() || config.defaultModel;
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
			projectId: body.projectId,
			role,
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
		return streamNdjson(req, res, session.agent, session.modelRef, input);
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

		const modelRef = body.modelRef?.trim() || config.defaultModel;
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
		return streamNdjson(req, res, agent, `${model.provider}/${model.id}`, instruction);
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

	/** 上传原料：只提取文本交回前端预览，不落盘、不建素材。 */
	const uploadMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/uploads$/);
	if (uploadMatch && req.method === "POST") {
		if (!store.get(uploadMatch[1]!)) return json(res, 404, { error: "工程不存在" });
		const filename = url.searchParams.get("filename")?.trim();
		if (!filename) return json(res, 400, { error: "缺少 filename" });
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
			// removeMaterial 会顺手把它从各章装配清单里摘掉，
			// 否则那些章节的"装料 N 条"会一直虚高。
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
		return json(res, 201, { provider: created, status: await statusOf(created.id) });
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
		return json(res, 200, { provider: settingsStore.getProvider(provider.id), status: await statusOf(provider.id) });
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
			const { models, added } = mergeFetched(provider.models, fetched);
			settingsStore.upsertProvider({ ...provider, models });
			rebuildModels();
			return json(res, 200, {
				provider: settingsStore.getProvider(provider.id),
				fetched: fetched.length,
				added: added.length,
				addedIds: added,
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
		const normalized = normalizeSettings({ providers: [{ ...provider, models: [{ ...emptyModel(id), ...body } as ModelConfig] }] })
			.providers[0]!.models[0]!;
		const models = provider.models.some((model) => model.id === id)
			? provider.models.map((model) => (model.id === id ? normalized : model))
			: [...provider.models, normalized];
		settingsStore.upsertProvider({ ...provider, models });
		rebuildModels();
		return json(res, 200, { provider: settingsStore.getProvider(provider.id) });
	}

	const modelItemMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/([^/]+)$/);
	if (modelItemMatch && req.method === "DELETE") {
		const provider = settingsStore.getProvider(modelItemMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		const modelId = decodeURIComponent(modelItemMatch[2]!);
		settingsStore.upsertProvider({ ...provider, models: provider.models.filter((model) => model.id !== modelId) });
		rebuildModels();
		return json(res, 200, { provider: settingsStore.getProvider(provider.id) });
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

const store = await ProjectStore.open(config.dataDir);
const libraryStore = await MaterialLibrary.open(config.dataDir);
const settingsStore = await SettingsStore.open(config.dataDir);
const credentialStore = await FileCredentialStore.open(config.dataDir);
settingsStore.replace(syncBuiltinProviders(settingsStore.get(), config.defaultModel));
initModelRuntime(settingsStore, credentialStore);

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const run = url.pathname.startsWith("/api/")
		? handleApi(req, res, url)
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
	void listProviderStatus().then((providers) => {
		const ready = providers.filter((provider) => provider.authSource !== "none" && provider.registered).map((provider) => provider.label);
		console.log(ready.length > 0 ? `已配置厂商  ${ready.join(", ")}` : "未检测到厂商 API Key，请在 .env 中配置");
	});
});
