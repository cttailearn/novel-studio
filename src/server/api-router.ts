/**
 * HTTP 路由层：与传输方式无关的核心。
 *
 * 这一层只认两样东西：
 *   · ApiRequest —— 一次请求（方法、路径、查询串、请求头、请求体）
 *   · ApiSink —— 一个能往里写回话的出口（writeHead / setHeader / write / end）
 *
 * 路由本身不知道来的是 Node 的 http.IncomingMessage 还是浏览器的 Request：
 * 那两种适配器分别在 node-http.ts 与 fetch-api.ts 里，把各自的请求与响应
 * 翻译成上面这两个接口。于是同一套路由既能跑在 Node 的文件系统上，
 * 也能跑在浏览器的 IndexedDB 上。
 *
 * 数据从哪来不在这一层：作品、素材库、设置、凭据、记录、会话、模型运行时
 * 全部由调用方通过 ApiRouterDeps 递进来。这里不持有任何模块级的可变单例，
 * 连"这一轮写作"的登记表也是每个路由器实例自带的。
 */
import type { Agent, AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, MutableModels } from "@earendil-works/pi-ai";
import { createNovelAgent, type AgentRole } from "../ai/novel-agent.ts";
import type { ChapterWriteMode, WritingContext } from "../ai/prompts.ts";
// 注意：这里刻意不 import ../ai/models.ts。
// 那个文件静态 import 了 42 个 pi-ai 内置 provider，连带 openai / @anthropic-ai/sdk /
// @google/genai / @aws-sdk 四个 SDK，浏览器里一个都用不上。
// 内置厂商目录走 deps.builtinCatalog 递进来（服务端从 models.ts 投影，浏览器读构建期
// 导出的 catalog.json），错误类型走轻量模块 model-errors.ts。
import { ModelResolutionError } from "../ai/model-errors.ts";
import type { ModelSummary, ProviderStatus } from "../ai/model-types.ts";
import type { BuiltinCatalogEntry } from "../ai/provider-catalog.ts";
import { fetchUpstreamModels, mergeFetched, replaceWithFetched } from "../ai/fetch-models.ts";
import { DeepSeekWebSearchClient, normalizeWebSearch } from "../ai/web-search.ts";
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
import type { AppConfig } from "../config/env.ts";
import {
	assembledMaterials,
	CHAPTER_STATUSES,
	isKnownKind,
	kindOptions,
	linkMaterials,
	MATERIAL_KINDS,
	registerCustomKinds,
	removeMaterial,
	type ChapterDraft,
	type ChapterMeta,
	type ChapterStatus,
	type MaterialKind,
	type Project,
} from "../store/project.ts";
import {
	libraryFieldsOf,
	materialFromLibrary,
	type LibraryMaterial,
	type LibraryMaterialInput,
} from "../store/library.ts";
import type {
	CredentialStorePort,
	KindsStorePort,
	LibraryStorePort,
	ProjectCreateInput,
	ProjectStorePort,
	RecordStorePort,
	SettingsStorePort,
} from "../store/store-port.ts";
import {
	exportNovel,
	importNovel,
	NOVEL_PACKAGE_MAX_BYTES,
	type NovelImportResult,
} from "../store/novel-package.ts";
import { extractText, MAX_UPLOAD_BYTES, UnsupportedUploadError, UploadTooLargeError } from "./upload.ts";
import type { AskChannel } from "./ask.ts";
import type { RecordFilter, RecordRole } from "./records.ts";

/**
 * 一次请求。
 *
 * 传输无关：Node 的 IncomingMessage 与浏览器的 Request 都被各自的适配器
 * 翻译成这一个形状，路由只认它。
 */
export interface ApiRequest {
	/** "GET" / "POST" / "PATCH" / "DELETE" / "PUT"。 */
	readonly method: string;
	/** "/api/projects"。 */
	readonly pathname: string;
	readonly searchParams: URLSearchParams;
	readonly headers: Record<string, string | string[] | undefined>;
	/** 把请求体当 JSON 解析。空体当 {}；不是合法 JSON 抛 HttpError(400)。 */
	json<T = unknown>(): Promise<T>;
	/** 原始请求体字节。超过 limitBytes 抛 HttpError(413)。 */
	raw(limitBytes?: number): Promise<Uint8Array>;
}

/**
 * 回话的出口。
 *
 * 前四个方法与 Node 的 ServerResponse 同名同义，因此路由里的写法不必改；
 * 后几个是把"连接断没断"这件事也搬到传输无关的一层：
 * 流式回复要在客户端半路离开时停笔，而"断开"在 Node 与浏览器里不是同一件事。
 */
export interface ApiSink {
	writeHead(status: number, headers?: Record<string, string>): void;
	setHeader(name: string, value: string): void;
	write(chunk: string | Uint8Array): void;
	end(chunk?: string | Uint8Array): void;
	/** 响应头已经发出去了没有。 */
	readonly headersSent: boolean;
	/** 响应体已经写完没有。 */
	readonly ended: boolean;
	/** 连接已经断了没有。 */
	readonly destroyed: boolean;
	/** 订阅"客户端断开"。返回取消订阅的函数。 */
	onClose(handler: () => void): () => void;
	/** 订阅"写流出错"。返回取消订阅的函数。 */
	onError(handler: (error: unknown) => void): () => void;
}

/** 一次请求配一个出口，把回话写回去。 */
export type ApiRouter = (req: ApiRequest, sink: ApiSink) => Promise<void>;

/**
 * 带 HTTP 状态码的请求错误。
 *
 * readJsonBody 这类底层函数手里没有出口，只能抛；由路由兜底翻译成状态码，
 * 否则"请求体太大"和"不是合法 JSON"都会一路冒成 500。
 */
export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

/**
 * JSON 请求体上限。
 *
 * 长正文一次几万字，用不到 1 MB 以上太多；但素材导入、批量装料这类请求
 * 可能带着整章正文，给到 8 MB 足够，也避免一个坏请求把内存吃光。
 */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/** 请求体超限的提示语。 */
export function bodyTooLargeMessage(limitBytes: number): string {
	return "请求体超过 " + Math.round(limitBytes / 1024 / 1024) + " MB 上限";
}

/** 上传文件超限的提示语。与请求体那句措辞不同，作者看的意思一样。 */
export function fileTooLargeMessage(limitBytes: number): string {
	return "文件超过 " + Math.round(limitBytes / 1024 / 1024) + " MB 上限";
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** UTF-8 字节数。替代 Buffer.byteLength：这一层不碰 Node 的 Buffer。 */
function byteLength(text: string): number {
	return textEncoder.encode(text).length;
}

/** 把几段字节接成一段。替代 Buffer.concat。 */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/**
 * 回一句 JSON。
 *
 * content-type 与 content-length 都给全：前者让前端知道按 JSON 解析，
 * 后者让服务端不必自己数长度。
 */
export function json(sink: ApiSink, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	sink.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(byteLength(payload)),
	});
	sink.end(payload);
}

/** 把请求体字节解析成 JSON。空体当 {}；不是合法 JSON 抛 400。 */
export function parseJsonBytes<T>(bytes: Uint8Array): T {
	if (bytes.length === 0) return {} as T;
	try {
		return JSON.parse(textDecoder.decode(bytes)) as T;
	} catch {
		throw new HttpError(400, "请求体不是合法 JSON");
	}
}

/** 读 JSON 请求体。体积超限的提示语按"请求体"算，与上传那条不同。 */
export async function readJsonBody<T>(req: ApiRequest, limitBytes = MAX_JSON_BYTES): Promise<T> {
	let bytes: Uint8Array;
	try {
		bytes = await req.raw(limitBytes);
	} catch (error) {
		if (error instanceof HttpError && error.status === 413) {
			throw new HttpError(413, bodyTooLargeMessage(limitBytes));
		}
		throw error;
	}
	return parseJsonBytes<T>(bytes);
}

/** 读原始请求体（上传用）。二进制不做 JSON 解析，直接给字节。 */
export async function readRawBody(req: ApiRequest, limitBytes: number): Promise<Uint8Array> {
	return await req.raw(limitBytes);
}

/** 声明的体积已经超限时提前拒绝，不必先收满 32 MB 再发现它太大。 */
export function exceedsUploadLimit(req: ApiRequest): boolean {
	const declared = Number(req.headers["content-length"]);
	return Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES;
}

/** 上传超限的统一回复。 */
export function uploadLimitError(sink: ApiSink): void {
	json(sink, 413, { error: fileTooLargeMessage(MAX_UPLOAD_BYTES) });
}

/**
 * 一席对话。
 *
 * 会话是内存里的一次对话，进程一重启就没了；记录活在 data/records.json 里，
 * 作者回头还能把它捡起来接着写。两者共用同一个 id 生成的记录。
 */
export interface Session {
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
	/**
	 * 提问通道。
	 *
	 * 智能体问出来的问题要送到作者眼前，作者的回答再送回智能体 ——
	 * 这一来一回都走这条通道。会话活多久，通道就活多久。
	 */
	ask: AskChannel;
	/** 这一席留档的记录 id。 */
	recordId?: string;
}

/**
 * 路由要用的全部依赖。
 *
 * 一个字段都不留在模块里：磁盘版与浏览器版递进来的东西形状一样，
 * 只是底下换成 IndexedDB 而已。
 */
export interface ApiRouterDeps {
	/** 作品存储。 */
	store: ProjectStorePort;
	/** 通用素材库。 */
	libraryStore: LibraryStorePort;
	/** 作者自建的素材种类表。 */
	kindStore: KindsStorePort;
	/** 应用设置。 */
	settingsStore: SettingsStorePort;
	/** 厂商密钥。 */
	credentialStore: CredentialStorePort;
	/** 生成记录。 */
	recordStore: RecordStorePort;
	/** 会话表。 */
	sessions: Map<string, Session>;
	/** 应用配置（.env 与命令行读出来的）。 */
	config: AppConfig;
	/** 运行环境变量。浏览器端传 {} 或自备的键值表。 */
	env: Record<string, string | undefined>;
	/** 记录列表的默认条数。 */
	recordsKeep: number;
	/** 新 id（UUID）。 */
	newId: () => string;
	/** 内置厂商目录。服务端从 models.ts 的 BUILTIN_PROVIDERS 投影，浏览器读构建期导出的 catalog.json。 */
	builtinCatalog: readonly BuiltinCatalogEntry[];
	/** 浏览器把上游 fetch 包成经中继的请求；Node 不填，直接访问上游。 */
	upstreamFetch?: typeof globalThis.fetch;
	/** 开一条提问通道。 */
	createAskChannel: (sessionId: string) => AskChannel;
	/** 作者回话。按问题 id 找得到就行。 */
	answerQuestion: (id: string, answer: string) => boolean;
	/** 模型运行时。 */
	models: {
		/** 已配置鉴权的厂商所有对话模型。 */
		list: () => Promise<ModelSummary[]>;
		/** 各厂商的运行状态。 */
		status: () => Promise<ProviderStatus[]>;
		/** 解析模型引用。 */
		resolve: (reference: string) => Promise<Model<any>>;
		/** 设置改动后重建注册表。 */
		rebuild: () => void;
		/** 当前注册表。 */
		current: () => MutableModels;
	};
}

/** 写作作业的三种性质，与提示词里的"作业"一一对应。 */
const WRITE_MODES: readonly ChapterWriteMode[] = ["create", "rewrite", "continue", "patch"];

/** 写作作业的中文叫法。按钮文案、提示语与记录标题都从这里取，别各写一份。 */
const WRITE_MODE_LABELS: Record<ChapterWriteMode, string> = {
	create: "从零写起",
	rewrite: "整章重写",
	continue: "续写下去",
	patch: "局部修改",
};

/**
 * 会话存活上限。早先这里只有 set/get 没有任何删除路径，而每个 Session 都抱着
 * 完整对话历史 —— 用一天下来，Map 里的内存只增不减，最终把进程吃满。
 */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_MAX = 64;

/** 联网检索用的凭据 id。 */
const WEB_CREDENTIAL_ID = "deepseek-web-search";

/** 本轮实际落盘结果。写作请求要求 revision 前进，不只是模型说自己写好了。 */
interface RunAcceptance {
	runId: string;
	projectId: string;
	chapterId: string;
	mode: ChapterWriteMode;
	requiredTools?: string[];
	beforeRevision: number;
}

interface WriteRun extends RunAcceptance {
	/** 没有客户端幂等键的请求也占章锁，但不留下重放入口。 */
	requestId?: string;
	recordId: string;
	events: unknown[];
	done: boolean;
	createdAt: number;
	completedAt?: number;
}

const WRITE_RUN_TTL_MS = 30 * 60 * 1000;

/**
 * 写作轮次的登记表。
 *
 * 每个路由器实例自带的，不是模块级的单例：浏览器端那个实例与 Node 端
 * 那个互不相干，各自记着自己那一侧正在写哪一章。
 */
interface WriteRunRegistry {
	writeRuns: Map<string, WriteRun>;
	activeWriteRuns: Map<string, string>;
	completedWriteRequests: Map<string, string>;
}

/** 路由内部用的上下文：依赖 + 这一侧自己的登记表。 */
interface RouterContext {
	deps: ApiRouterDeps;
	runs: WriteRunRegistry;
}

function writeRunKey(projectId: string, chapterId: string): string {
	return projectId + "::" + chapterId;
}

function writeRequestKey(projectId: string, chapterId: string, requestId: string): string {
	return writeRunKey(projectId, chapterId) + "::" + requestId;
}

function validRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
}

function sweepWriteRuns(runs: WriteRunRegistry): void {
	const cutoff = Date.now() - WRITE_RUN_TTL_MS;
	for (const [runId, run] of runs.writeRuns) {
		if (run.createdAt >= cutoff) continue;
		if (!run.done) {
			// 防异常路径留下永不释放的章锁；正常长任务不会达到这个兜底时限。
			runs.activeWriteRuns.delete(writeRunKey(run.projectId, run.chapterId));
		}
		runs.writeRuns.delete(runId);
		if (run.requestId) {
			runs.completedWriteRequests.delete(writeRequestKey(run.projectId, run.chapterId, run.requestId));
		}
	}
	while (runs.writeRuns.size > 200) {
		const oldest = [...runs.writeRuns.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
		if (!oldest || !oldest[1].done) break;
		runs.writeRuns.delete(oldest[0]);
		if (oldest[1].requestId) {
			runs.completedWriteRequests.delete(writeRequestKey(oldest[1].projectId, oldest[1].chapterId, oldest[1].requestId));
		}
	}
}

/** 按创建时间淘汰：既清超时会话，也给数量封顶。 */
function pruneSessions(sessions: Map<string, Session>): void {
	const now = Date.now();
	for (const [id, session] of sessions) {
		if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
	}
	if (sessions.size <= SESSION_MAX) return;
	// 还超量就按创建时间丢最老的。
	const ordered = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
	for (const [id] of ordered.slice(0, sessions.size - SESSION_MAX)) sessions.delete(id);
}

/** 章节标题，找不到就退回章号。 */
function chapterTitleOf(ctx: RouterContext, projectId: string, chapterId: string): string {
	const chapter = ctx.deps.store.get(projectId)?.outline.find((item) => item.id === chapterId);
	return chapter?.title?.trim() || chapterId;
}

/**
 * 给一轮生成起个名字。
 *
 * 记录列表是给作者认的："设定官的一席"三个月后毫无信息量，
 * 所以写作记录带上章名与这一轮的写法（从零写起/整章重写/局部修改）。
 */
function recordTitleFor(ctx: RouterContext, input: {
	role: AgentRole;
	projectId?: string;
	chapterId?: string;
	libraryScope?: boolean;
	mode?: ChapterWriteMode;
}): string {
	if (input.role === "writing" && input.projectId && input.chapterId) {
		const mode = input.mode ? " · " + WRITE_MODE_LABELS[input.mode] : "";
		return "《" + chapterTitleOf(ctx, input.projectId, input.chapterId) + "》" + mode;
	}
	if (input.libraryScope) return "通用素材库的一席";
	return "设定官的一席";
}

/**
 * 一轮跑完（或被中止）后，把这段对话补进记录。
 *
 * 中止的一轮也要存：作者点了"止笔"往往只是不满意，回头接着改的正是那半轮。
 * 系统消息不入库 —— 它是按当时的素材现算的，存下来下次也照样会重算。
 */
function roundRecorder(ctx: RouterContext, agent: Agent, recordId: string) {
	return async (): Promise<void> => {
		const messages = agent.state.messages;
		const conversation = messages[0]?.role === "system" ? messages.slice(1) : messages;
		if (conversation.length === 0) return;
		await ctx.deps.recordStore.saveMessages(recordId, conversation);
	};
}

/** 运行时构造，设置与凭据改动后不必重启；写作角色永不注入。 */
async function authorizedWebSearch(ctx: RouterContext) {
	const web = ctx.deps.settingsStore.get().webSearch;
	if (!web.enabled) return undefined;
	const stored = await ctx.deps.credentialStore.read(WEB_CREDENTIAL_ID);
	const envKey = ctx.deps.env.DEEPSEEK_API_KEY;
	const apiKey = stored?.type === "api_key" ? stored.key : envKey;
	if (!apiKey) return undefined;
	const baseUrl = ctx.deps.env.DEEPSEEK_WEB_SEARCH_BASE_URL;
	return {
		client: new DeepSeekWebSearchClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
		config: web,
	};
}

async function replaceAgent(ctx: RouterContext, session: Session, model: Model<any>): Promise<void> {
	session.model = model;
	session.agent = await createNovelAgent({
		store: ctx.deps.store,
		projectId: session.projectId,
		model,
		models: ctx.deps.models.current(),
		config: ctx.deps.config,
		sessionId: session.id,
		role: session.role,
		thinkingLevel: session.thinkingLevel,
		// 会话里的提问通道：智能体问，作者答，答案回到同一轮里。
		ask: session.ask,
		webSearch: session.role === "material" ? await authorizedWebSearch(ctx) : undefined,
		// 库作用域传的是库，不是工程；createNovelAgent 见到它就走另一支。
		...(session.libraryScope ? { library: ctx.deps.libraryStore } : {}),
		...(session.chapterId ? { chapterId: session.chapterId } : {}),
	});
}

/**
 * 一次性写作的组装上下文：章节 + 已装配素材 + 上一章结尾。
 *
 * 与 novel-agent.ts 的 writingContextOf 是同一套语义，这里显式传入 mode
 * 并对缺章节报错，因为服务端需要据此返回 404。
 *
 * 正文在磁盘上（.txt），这里按需取两章：上一章与本章。
 * 只取两章而不是整本 —— 千万字的书不可能整本塞进上下文。
 */
async function buildWritingContext(
	ctx: RouterContext,
	projectId: string,
	chapterId: string,
	mode: ChapterWriteMode,
): Promise<WritingContext> {
	const project = ctx.deps.store.get(projectId);
	if (!project) throw new Error("工程不存在");
	const index = project.outline.findIndex((c) => c.id === chapterId);
	const chapter = index >= 0 ? project.outline[index] : undefined;
	if (!chapter) throw new Error("章节 " + chapterId + " 不存在");
	// 只认真正解析得到的素材：装配清单里可能有指向已删素材的悬空 id。
	const materials = assembledMaterials(project, chapterId);
	const previousChapter = index > 0 ? project.outline[index - 1] : undefined;
	const previous = previousChapter ? await loadDraftShape(ctx, projectId, previousChapter.id) : undefined;
	const existing = await loadDraftShape(ctx, projectId, chapterId);
	return {
		chapter,
		materials,
		mode,
		// 上一章的两样都给：正文草稿（结尾 + 实际小结）与大纲条目（写前定的要略）。
		...(previousChapter
			? {
					previous,
					previousOutline: previousChapter,
				}
			: {}),
		...(existing ? { existing } : {}),
	};
}

/**
 * 把磁盘上的正文组装成工具与提示词之间传的那种形状。
 *
 * 正文与历史分开存，但提示词要的是"这一章的正文 + 小结 + 版本"，
 * 所以这里把两者合起来 —— 只在需要的那一刻读这一章。
 */
async function loadDraftShape(
	ctx: RouterContext,
	projectId: string,
	chapterId: string,
): Promise<ChapterDraft | undefined> {
	const meta = ctx.deps.store.get(projectId)?.drafts[chapterId];
	if (!meta) return undefined;
	const body = await ctx.deps.store.readDraftBody(projectId, chapterId);
	return {
		id: chapterId,
		title: meta.title,
		content: body?.content ?? "",
		summary: meta.summary,
		revision: meta.revision,
		updatedAt: meta.updatedAt,
		materialIds: meta.materialIds,
		history: body?.history ?? [],
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

/**
 * 一次性写作的首轮指令。素材全文已在系统提示词里，这里只说"动手"。
 *
 * patch 与另外三种不同：它不是"再写一遍"，而是"只改这几处"。
 * 指令里点明只用 revise_chapter，免得它顺手整章重交。
 */
function writingInstruction(assembly: WritingContext, note?: string): string {
	const base =
		assembly.mode === "patch"
			? "局部修改《" + assembly.chapter.title + "》。先 read_chapter 读现有正文，只用 revise_chapter 改作者点名的那几处，其余一字不动。"
			: assembly.mode === "continue"
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
async function refreshWritingAgent(ctx: RouterContext, session: Session): Promise<void> {
	if (session.agent.state.isStreaming) return;
	const messages = session.agent.state.messages;
	// 对话要留着，只换开头那条系统消息（它携带提示词与工具声明）。
	const conversation = messages[0]?.role === "system" ? messages.slice(1) : messages;
	await replaceAgent(ctx, session, session.model);
	session.agent.state.messages = [...session.agent.state.messages.slice(0, 1), ...conversation];
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

function modelCost(
	ctx: RouterContext,
	modelRef: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
	const providerId = modelRef.split("/")[0];
	if (!providerId) return undefined;
	const modelId = modelRef.slice(providerId.length + 1);
	const model = ctx.deps.settingsStore.getProvider(providerId)?.models.find((item) => item.id === modelId);
	if (!model) return undefined;
	const rates = model.cost;
	const amount = (usage.input * rates.input + usage.output * rates.output + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite) / 1_000_000;
	return { amount, currency: "USD", configured: Object.values(rates).some((rate) => rate > 0) };
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
 *
 * 正文按章从磁盘取，一章一段地吐出去：整本书先拼成一个大字符串，
 * 千万字的书光这一份导出就能把内存吃掉几百兆。
 */
async function* exportChunks(
	ctx: RouterContext,
	project: Project,
	chapterId: string | null,
	markdown: boolean,
): AsyncGenerator<string> {
	let first = true;
	const yieldBlock = (block: string): string => {
		const separator = first ? "" : "\n\n";
		first = false;
		return separator + block;
	};
	if (!chapterId) {
		yield yieldBlock((markdown ? "# " : "") + project.title);
		const meta = [project.genre, project.logline].filter(Boolean).join(" · ");
		if (meta) yield yieldBlock(meta);
	}

	for (const [index, chapter] of project.outline.entries()) {
		if (chapterId && chapter.id !== chapterId) continue;
		const body = (await ctx.deps.store.readDraftBody(project.id, chapter.id))?.content.trim() ?? "";
		// 单章导出即使还没落笔也要给出章名，否则用户拿到一个空文件不知所以。
		if (!body && !chapterId) continue;
		const heading = (markdown ? "## " : "") + "第" + (index + 1) + "章 " + chapter.title;
		yield yieldBlock(body ? heading + "\n\n" + body : heading);
	}
	yield "\n";
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

async function statusOf(ctx: RouterContext, id: string) {
	return (await ctx.deps.models.status()).find((provider) => provider.id === id);
}

function webSearchView(ctx: RouterContext) {
	const config = ctx.deps.settingsStore.get().webSearch;
	const stored = ctx.deps.credentialStore.hasKey(WEB_CREDENTIAL_ID);
	const envKey = ctx.deps.env.DEEPSEEK_API_KEY;
	return {
		...config,
		configured: stored || Boolean(envKey),
		authSource: stored ? "app" : envKey ? "env" : "none",
	};
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
function resolveDefaultModel(ctx: RouterContext, requested?: string): string {
	return requested?.trim() || ctx.deps.settingsStore.get().defaultModel.trim() || ctx.deps.config.defaultModel;
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
async function settingsView(ctx: RouterContext) {
	const settings = ctx.deps.settingsStore.get();
	return {
		defaultModel: settings.defaultModel,
		defaultThinkingLevel: settings.defaultThinkingLevel,
		webSearch: webSearchView(ctx),
		providers: settings.providers.map((provider) => providerView(provider)),
		statuses: await ctx.deps.models.status(),
		defaults: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
		builtinCatalog: ctx.deps.builtinCatalog.map((spec) => ({
			id: spec.id,
			label: spec.label,
			envVars: [...spec.envVars],
		})),
	};
}

/** 哪些作品取用过某条通用素材。从工程现算，不落盘，免得两边不一致。 */
function libraryUsage(ctx: RouterContext): Map<string, Array<{ projectId: string; title: string; materialId: string }>> {
	const usage = new Map<string, Array<{ projectId: string; title: string; materialId: string }>>();
	for (const project of ctx.deps.store.list()) {
		for (const material of project.materials) {
			if (!material.originId) continue;
			const list = usage.get(material.originId) ?? [];
			list.push({ projectId: project.id, title: project.title, materialId: material.id });
			usage.set(material.originId, list);
		}
	}
	return usage;
}

/**
 * 种类目录：内置在前，自建在后，各带一个用它的素材数。
 *
 * 数目是现算的 —— 库里一份、各作品里一份，加起来才是作者真正放了多少料在这一类。
 * 目录里没有、却仍有素材在用的种类（比如在别的机器上添的）也补一条出来，
 * 免得那些料在界面上无处安放。
 */
function kindsView(ctx: RouterContext) {
	const counts = new Map<string, number>();
	const bump = (kind: string): void => {
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	};
	for (const entry of ctx.deps.libraryStore.list()) bump(entry.kind);
	for (const project of ctx.deps.store.list()) {
		for (const material of project.materials) bump(material.kind);
	}
	const catalog = kindOptions().map((option) => ({ ...option, count: counts.get(option.kind) ?? 0 }));
	const known = new Set(catalog.map((option) => option.kind));
	for (const [kind, count] of counts) {
		if (!known.has(kind)) catalog.push({ kind, label: kind, builtin: false, count });
	}
	return catalog;
}

/** 素材库视图：条目 + 取用情况 + 种类表。 */
function libraryView(ctx: RouterContext) {
	const usage = libraryUsage(ctx);
	return {
		materials: ctx.deps.libraryStore.list().map((entry) => ({ ...entry, usedBy: usage.get(entry.id) ?? [] })),
		kinds: kindsView(ctx),
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
function projectSummary(ctx: RouterContext, project: Project) {
	return {
		id: project.id,
		title: project.title,
		genre: project.genre,
		logline: project.logline,
		styleGuide: project.styleGuide,
		targetWords: project.targetWords,
		updatedAt: project.updatedAt,
		stats: ctx.deps.store.stats(project),
	};
}

/** 统一的 NDJSON 流式响应。会话与一次性写作走同一条路。 */
async function streamNdjson(
	ctx: RouterContext,
	sink: ApiSink,
	agent: Agent,
	modelRef: string,
	input: string,
	ask?: AskChannel,
	/** 这一轮结束后（含中途断线、中止）调用，用来把对话补进记录。 */
	onFinish?: () => Promise<void>,
	acceptance?: RunAcceptance,
): Promise<void> {
	sink.writeHead(200, {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});

	const state = { aborted: false };
	const emit = (event: unknown) => {
		if (acceptance) {
			const run = ctx.runs.writeRuns.get(acceptance.runId);
			if (run && !run.done) run.events.push(event);
		}
		// 连接已经没了还往里写，Node 会在响应上抛一个 error 事件。
		// 那个事件没人接，就会把整个进程带走 —— 作者下一句话直接撞上"连不上服务"。
		if (sink.ended || sink.destroyed) return;
		try {
			sink.write(`${JSON.stringify(event)}\n`);
		} catch (error) {
			console.error("[server] 回话通道写失败", error);
		}
	};
	/**
	 * 客户端断开就停笔。
	 *
	 * 早先监听的是 req 的 close，但请求体读尽之后 req 不会再触发 close ——
	 * 于是关页、断网、按"止笔"之后模型仍在后台继续生成，还会照常覆盖正文。
	 * 真正代表连接死活的是响应这一侧的 close；正常结束时 ended 已为 true，
	 * 只有半途关闭才需要中止。
	 */
	const abortOnClose = () => {
		if (sink.ended) return;
		state.aborted = true;
		agent.abort();
	};
	const offClose = sink.onClose(abortOnClose);
	// 半路断线的写错误就地咽下：不接这个事件，它就是一个未捕获异常。
	sink.onError((error) => {
		state.aborted = true;
		console.error("[server] 回话通道断了", error);
	});

	// 智能体在这一轮里问出来的问题，走这条流送到作者眼前。
	ask?.bindEmitter((event) => emit(event));

	try {
		await runAgentStream(ctx, agent, modelRef, input, emit, state, acceptance);
	} finally {
		ask?.bindEmitter(null);
		offClose();
		if (!sink.ended) sink.end();
		if (acceptance) {
			const run = ctx.runs.writeRuns.get(acceptance.runId);
			if (run) {
				run.done = true;
				run.completedAt = Date.now();
			}
			if (ctx.runs.activeWriteRuns.get(writeRunKey(acceptance.projectId, acceptance.chapterId)) === acceptance.runId) {
				ctx.runs.activeWriteRuns.delete(writeRunKey(acceptance.projectId, acceptance.chapterId));
			}
			if (run?.requestId) {
				ctx.runs.completedWriteRequests.set(
					writeRequestKey(acceptance.projectId, acceptance.chapterId, run.requestId),
					acceptance.runId,
				);
			}
		}
		// 记录在流关掉之后才落盘：它比回话慢（要写整个文件），但不该拖住作者看结果。
		if (onFinish) {
			try {
				await onFinish();
			} catch (error) {
				console.error("[records] 这一轮的记录没能存下", error);
			}
		}
	}
}

/** 把 Agent 事件映射成前端可消费的 NDJSON 事件。 */
function runAgentStream(
	ctx: RouterContext,
	agent: Agent,
	modelRef: string,
	input: string,
	emit: (event: unknown) => void,
	signal: { aborted: boolean },
	acceptance?: RunAcceptance,
): Promise<void> {
	const startedAt = Date.now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
	let savedRevision: number | undefined;
	let writeFailed = false;
	let terminalError = "";
	const requiredTools = acceptance?.requiredTools
		? new Set(acceptance.requiredTools)
		: acceptance?.mode === "patch"
			? new Set(["revise_chapter"])
			: acceptance?.mode === "continue"
				? new Set(["append_chapter", "write_chapter"])
				: new Set(["write_chapter"]);
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
				if (acceptance && requiredTools.has(event.toolName)) {
					if (event.isError) writeFailed = true;
					else {
						const meta = ctx.deps.store.get(acceptance.projectId)?.drafts[acceptance.chapterId];
						if (meta && meta.revision > acceptance.beforeRevision) savedRevision = meta.revision;
					}
				}
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
					terminalError = describeStreamFailure(agent.state.errorMessage, Date.now() - startedAt, sawText);
					emit({
						type: "error",
						message: terminalError,
					});
				}
				if (acceptance && !aborted && !terminalError && (savedRevision === undefined || writeFailed)) {
					terminalError = writeFailed
						? "正文写入工具执行失败，这一轮不能算完成；请根据工具报错重试。"
						: "这一轮没有成功保存正文，不能算完成；请重试，或要求执笔者实际调用写入工具。";
					emit({ type: "error", message: terminalError });
				}
				const cost = modelCost(ctx, modelRef, usage);
				emit({
					type: "run_end",
					runId: acceptance?.runId,
					aborted,
					saved: acceptance ? savedRevision !== undefined && !writeFailed && !terminalError : undefined,
					savedRevision,
					usage: { ...usage, cacheRead: usage.cacheRead || undefined, cacheWrite: usage.cacheWrite || undefined },
					cost,
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
					terminalError = `这一轮没有跑完（等了 ${formatElapsed(Date.now() - startedAt)}）：${detail}`;
					emit({
						type: "error",
						message: terminalError,
					});
				}
				emit({
					type: "run_end",
					runId: acceptance?.runId,
					aborted,
					saved: acceptance ? false : undefined,
					savedRevision,
					usage,
					cost: modelCost(ctx, modelRef, usage),
					error: undefined,
				});
			}
		} finally {
			unsubscribe();
		}
	})();
}

function replayWriteRun(sink: ApiSink, run: WriteRun): void {
	sink.writeHead(200, {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "no-store",
		"x-write-replay": "1",
	});
	for (const event of run.events) sink.write(JSON.stringify(event) + "\n");
	sink.end();
}

async function handleRoutes(ctx: RouterContext, req: ApiRequest, sink: ApiSink): Promise<void> {
	const {
		store,
		libraryStore,
		kindStore,
		settingsStore,
		credentialStore,
		recordStore,
		sessions,
		config,
		recordsKeep,
	} = ctx.deps;
	const {
		list: listAvailableModels,
		status: listProviderStatus,
		resolve: resolveModel,
		rebuild: rebuildModels,
		current: getModels,
	} = ctx.deps.models;
	const randomUUID = ctx.deps.newId;
	const answerQuestion = ctx.deps.answerQuestion;
	const createAskChannel = ctx.deps.createAskChannel;

	const { pathname } = req;

	if (pathname === "/api/bootstrap" && req.method === "GET") {
		const [models, providers, settings] = await Promise.all([
			listAvailableModels(),
			listProviderStatus(),
			settingsView(ctx),
		]);
		return json(sink, 200, {
			defaultModel: settings.defaultModel,
			defaultThinkingLevel: settings.defaultThinkingLevel,
			models,
			providers,
			settings,
			kinds: kindsView(ctx),
			projects: store.list().map((project) => projectSummary(ctx, project)),
		});
	}

	if (pathname === "/api/models" && req.method === "GET") {
		return json(sink, 200, { models: await listAvailableModels() });
	}

	if (pathname === "/api/projects" && req.method === "GET") {
		return json(sink, 200, { projects: store.list().map((project) => projectSummary(ctx, project)) });
	}

	if (pathname === "/api/projects" && req.method === "POST") {
		const body = await readJsonBody<ProjectCreateInput & { libraryIds?: string[] }>(req);
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
		// 新建一部书要等骨架真的落到磁盘上才回话：这一部书刚建就没了，
		// 比慢上一二十毫秒难受得多。
		await store.flush();
		return json(sink, 201, { project, stats: store.stats(project) });
	}

	// 新建章节：作者自己立一章的入口。
	// 章节此前只能由设定官的 update_outline 产出 —— 而没有章节，生文工作台就没有装配落点，
	// 素材也就无处可装，界面上只能看到一片空。
	const chaptersMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters$/);
	if (chaptersMatch && req.method === "POST") {
		const projectId = chaptersMatch[1]!;
		if (!store.get(projectId)) return json(sink, 404, { error: "工程不存在" });
		const body = await readJsonBody<{
			title?: string;
			summary?: string;
			pov?: string;
			targetWords?: number;
			volumeId?: string;
		}>(req);
		const title = body.title?.trim();
		if (!title) return json(sink, 400, { error: "请填写章节标题" });
		// 卷没填或填了个不存在的 id，就当作不分卷：立章这件事不该被一个卷 id 挡住。
		const wantedVolume = typeof body.volumeId === "string" ? body.volumeId.trim() : "";
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
				volumeId: draft.volumes.some((volume) => volume.id === wantedVolume) ? wantedVolume : "",
				status: "planned",
				targetWords:
					typeof body.targetWords === "number" && body.targetWords > 0 ? Math.floor(body.targetWords) : 0,
				notes: "",
				materialIds: [],
			});
		});
		const chapter = saved.outline.find((item) => item.id === createdId);
		// 立完章就回话之前先等骨架落盘：章目录丢了等于这一章白立。
		await store.flush();
		return json(sink, 201, { chapter, stats: store.stats(saved) });
	}

	// 卷：一卷书。卷只为分组与"这一卷大致写什么"服务，正文仍在章上。
	// 章挂不挂卷是自由的 —— 老工程、短篇都不必先分卷才能写。
	const volumesMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/volumes$/);
	if (volumesMatch && req.method === "POST") {
		const projectId = volumesMatch[1]!;
		if (!store.get(projectId)) return json(sink, 404, { error: "工程不存在" });
		const body = await readJsonBody<{ title?: string; summary?: string; targetWords?: number }>(req);
		const title = body.title?.trim();
		if (!title) return json(sink, 400, { error: "请填写卷名" });
		let createdId = "";
		const saved = store.mutate(projectId, (draft) => {
			const taken = new Set(draft.volumes.map((volume) => volume.id));
			let n = draft.volumes.length + 1;
			createdId = "v" + String(n).padStart(2, "0");
			while (taken.has(createdId)) createdId = "v" + String(++n).padStart(2, "0");
			draft.volumes.push({
				id: createdId,
				title,
				summary: body.summary?.trim() ?? "",
				targetWords:
					typeof body.targetWords === "number" && body.targetWords > 0 ? Math.floor(body.targetWords) : 0,
				notes: "",
			});
		});
		const volume = saved.volumes.find((item) => item.id === createdId);
		await store.flush();
		return json(sink, 201, { volume, stats: store.stats(saved) });
	}

	const volumeMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/volumes\/([^/]+)$/);
	if (volumeMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const projectId = volumeMatch[1]!;
		if (!store.get(projectId)) return json(sink, 404, { error: "工程不存在" });
		const volumeId = decodeURIComponent(volumeMatch[2]!);
		if (req.method === "DELETE") {
			// 删卷不删章：章是作者真正写过的东西，卷只是一层分组。
			// 这一卷下的章一律归到"不分卷"，并把条数回报给界面，免得静默改变章目。
			let moved = 0;
			let found = false;
			const saved = store.mutate(projectId, (draft) => {
				const index = draft.volumes.findIndex((volume) => volume.id === volumeId);
				if (index < 0) return;
				found = true;
				draft.volumes.splice(index, 1);
				for (const chapter of draft.outline) {
					if (chapter.volumeId !== volumeId) continue;
					chapter.volumeId = "";
					moved += 1;
				}
			});
			if (!found) return json(sink, 404, { error: "卷不存在" });
			await store.flushForProject(projectId);
			return json(sink, 200, { ok: true, moved, stats: store.stats(saved) });
		}
		const body = await readJsonBody<{ title?: string; summary?: string; targetWords?: number }>(req);
		let found = false;
		const saved = store.mutate(projectId, (draft) => {
			const volume = draft.volumes.find((item) => item.id === volumeId);
			if (!volume) return;
			found = true;
			if (typeof body.title === "string" && body.title.trim()) volume.title = body.title.trim();
			if (typeof body.summary === "string") volume.summary = body.summary.trim();
			if (typeof body.targetWords === "number" && body.targetWords >= 0) {
				volume.targetWords = Math.floor(body.targetWords);
			}
		});
		if (!found) return json(sink, 404, { error: "卷不存在" });
		const volume = saved.volumes.find((item) => item.id === volumeId);
		await store.flush();
		return json(sink, 200, { volume, stats: store.stats(saved) });
	}

	// 改章目本身（标题、要点、视角、所属卷、状态、目标字数、备注）。
	// 与下面"存稿"那条 PATCH 分开：那条改的是正文，这条改的是计划。
	const outlineMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/outline\/([^/]+)$/);
	if (outlineMatch && req.method === "PATCH") {
		const projectId = outlineMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(outlineMatch[2]!);
		if (!project.outline.some((chapter) => chapter.id === chapterId)) {
			return json(sink, 404, { error: "章节不存在" });
		}
		const body = await readJsonBody<{
			title?: string;
			summary?: string;
			pov?: string;
			volumeId?: string;
			status?: string;
			targetWords?: number;
			notes?: string;
		}>(req);
		if (typeof body.title === "string" && !body.title.trim()) {
			return json(sink, 400, { error: "请填写章节标题" });
		}
		const saved = store.mutate(projectId, (draft) => {
			const chapter = draft.outline.find((item) => item.id === chapterId);
			if (!chapter) return;
			if (typeof body.title === "string" && body.title.trim()) chapter.title = body.title.trim();
			if (typeof body.summary === "string") chapter.summary = body.summary.trim();
			if (typeof body.pov === "string") chapter.pov = body.pov.trim();
			if (typeof body.notes === "string") chapter.notes = body.notes.trim();
			if (typeof body.targetWords === "number" && body.targetWords >= 0) {
				chapter.targetWords = Math.floor(body.targetWords);
			}
			if (typeof body.status === "string" && CHAPTER_STATUSES.includes(body.status as ChapterStatus)) {
				chapter.status = body.status as ChapterStatus;
			}
			// 卷只能挂到确实存在的卷上；传空串就是摘下来（不分卷）。
			if (typeof body.volumeId === "string") {
				const wanted = body.volumeId.trim();
				chapter.volumeId = draft.volumes.some((volume) => volume.id === wanted) ? wanted : "";
			}
		});
		const chapter = saved.outline.find((item) => item.id === chapterId);
		await store.flush();
		return json(sink, 200, { chapter, stats: store.stats(saved) });
	}

	// 保存章节正文（稿件视图的直接编辑）
	const chapterMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)$/);
	if (chapterMatch && req.method === "PATCH") {
		const project = store.get(chapterMatch[1]!);
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(chapterMatch[2]!);
		// 大纲里没有这一章时不能凭一个 id 凭空造 draft：正文会挂不上任何章，
		// 前端也永远列不出它，等于一份幽灵稿。
		if (!project.outline.some((chapter) => chapter.id === chapterId)) {
			return json(sink, 404, { error: "章节不存在" });
		}
		const body = await readJsonBody<{ content?: string; title?: string; autosave?: boolean; summary?: string }>(req);
		if (typeof body.content !== "string") return json(sink, 400, { error: "缺少 content" });
		// 取成常量：属性访问的类型收窄无法穿透闭包。
		const content = body.content;
		// autosave 是前端定时持久化的草稿：内容要存，但不构成版本点。
		// 显式保存才归档旧稿 —— 每 1.5 秒一次的自动保存若都进 history，
		// 最近 10 版会全是零碎片段，真正的版本历史就没了。
		const autosave = body.autosave === true;
		const existingMeta = project.drafts[chapterId];
		const planned = project.outline.find((c) => c.id === chapterId);
		// 与智能体的 write_chapter 共用同一把按章的锁：两边都是整段覆盖，
		// 谁后写谁赢会让先写的内容无声消失。
		// 正文落 .txt、元数据落 .meta.json、历史落 .hist/，主文件只留骨架 ——
		// 存稿不再需要重写整本书。
		const saved = await store.withChapterLock(project.id, chapterId, () =>
			store.saveDraftBody(project.id, chapterId, {
				title: body.title?.trim() || existingMeta?.title || planned?.title || chapterId,
				content,
				// 手动存稿是作者手改正文，不是重写这一章：旧小结一律留着。
				// 它可能略旧（正文改了、小结没跟着改），但比空着强 ——
				// 下一章接续靠的就是它。作者显式补了小结才用新值。
				summary:
					typeof body.summary === "string" && body.summary.trim() ? body.summary : undefined,
				// 首次存稿时继承该章的装配清单：正文是拿这些料写的，
				// 留空会让"这段正文从什么料来"的回溯断掉。
				materialIds: existingMeta?.materialIds ?? planned?.materialIds ?? [],
				keepHistory: !autosave,
			}),
		);
		const current = store.get(project.id);
		// 存稿回话之前先等骨架也落盘：正文与元数据都在磁盘上，才算存上。
		await store.flush();
		return json(sink, 200, { chapter: saved, stats: current ? store.stats(current) : undefined });
	}

	// 取一章的正文：正文按需取，不再随整本响应一起过来。
	const draftMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)\/draft$/);
	if (draftMatch && req.method === "GET") {
		const project = store.get(draftMatch[1]!);
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(draftMatch[2]!);
		const meta = project.drafts[chapterId];
		if (!meta) return json(sink, 404, { error: "章节不存在" });
		const withHistory = req.searchParams.get("history") === "1";
		const body = await store.readDraftBody(project.id, chapterId, { history: withHistory });
		return json(sink, 200, {
			chapter: {
				id: chapterId,
				title: meta.title,
				content: body?.content ?? "",
				summary: meta.summary,
				revision: meta.revision,
				updatedAt: meta.updatedAt,
				materialIds: meta.materialIds,
				...(withHistory ? { history: body?.history ?? [] } : {}),
			},
		});
	}

	// 导出：整本或单章。正文原样给出，不重排、不加字数标记 —— 导出的稿子要能直接进别的编辑器。
	const exportMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/export$/);
	if (exportMatch && req.method === "GET") {
		const project = store.get(exportMatch[1]!);
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const chapterId = req.searchParams.get("chapter");
		if (chapterId && !project.outline.some((chapter) => chapter.id === chapterId)) {
			return json(sink, 404, { error: "章节不存在" });
		}
		const markdown = req.searchParams.get("format") === "md";
		const ext = markdown ? "md" : "txt";
		// 边读边写：正文按章从磁盘取，不先拼成一个大字符串。
		sink.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			// 文件名里有中文，只能走 RFC 5987 的 filename*：塞进 filename= 的非 ASCII 会被浏览器整个丢掉。
			"content-disposition":
				`attachment; filename="novel.${ext}"; filename*=UTF-8''${encodeURIComponent(exportFilename(project, chapterId, ext))}`,
		});
		for await (const chunk of exportChunks(ctx, project, chapterId, markdown)) {
			sink.write(chunk);
		}
		sink.end();
		return;
	}

	if (pathname === "/api/projects/trash" && req.method === "GET") {
		return json(sink, 200, { projects: await store.listDeleted() });
	}
	const trashMatch = pathname.match(/^\/api\/projects\/trash\/([\w-]+)\/restore$/);
	if (trashMatch && req.method === "POST") {
		const project = await store.restoreDeleted(trashMatch[1]!);
		return json(sink, 200, { project, stats: store.stats(project) });
	}

	const projectMatch = pathname.match(/^\/api\/projects\/([\w-]+)$/);
	if (projectMatch) {
		const projectId = projectMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(sink, 404, { error: "工程不存在" });

		if (req.method === "GET") {
			// 整本响应只给骨架与各章元数据，正文按需另取。
			// 附一份按大纲顺序排好的章目清单：前端不必自己从 drafts 里拼。
			const chapters = project.outline
				.map((chapter) => project.drafts[chapter.id])
				.filter((meta): meta is ChapterMeta => meta !== undefined);
			return json(sink, 200, { project, chapters, stats: store.stats(project) });
		}

		if (req.method === "DELETE") {
			// 默认移入回收站，保留正文、历史与快照，可通过恢复接口找回。
			await store.remove(projectId);
			return json(sink, 200, { ok: true, recoverable: true });
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
			await store.flushForProject(projectId);
			return json(sink, 200, { project: saved, stats: store.stats(saved) });
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
			/** 从这条旧记录接着写：新的一席会把那段对话当自己的上下文。 */
			recordId?: string;
		}>(req);
		// 库作用域不绑工程：那时作者还没建书，不该强迫他先随便开一卷。
		const libraryScope = body.scope === "library";
		if (!libraryScope) {
			if (!body.projectId) return json(sink, 400, { error: "缺少 projectId" });
			if (!store.get(body.projectId)) return json(sink, 404, { error: "工程不存在" });
		}

		// 默认是素材会话：写作是一次性动作，不走常驻会话。
		const role: AgentRole = body.role === "writing" ? "writing" : "material";
		if (role === "writing" && !body.chapterId) {
			return json(sink, 400, { error: "写作会话需要 chapterId" });
		}

		const modelRef = resolveDefaultModel(ctx, body.modelRef);
		if (!modelRef) return json(sink, 400, { error: "请指定模型" });

		let model: Model<any>;
		try {
			model = await resolveModel(modelRef);
		} catch (error) {
			const status = error instanceof ModelResolutionError ? 400 : 500;
			return json(sink, status, {
				error: (error as Error).message,
				candidates: error instanceof ModelResolutionError ? error.candidates : [],
			});
		}

		const sessionId = randomUUID();
		// 从旧记录接着写：把那段对话原样塞回来，不新建记录（否则一条线会被切成好几截）。
		const resumed = body.recordId ? recordStore.get(body.recordId) : undefined;
		if (body.recordId && !resumed) return json(sink, 404, { error: "这条记录不在了（可能已被删除）" });
		if (resumed) {
			if (resumed.role !== role) return json(sink, 400, { error: "这条记录不属于这个面板" });
			// 记录的 libraryScope 只在 true 时才写进文件，工程记录的该字段是 undefined，
			// 所以两边都规范成布尔再比，否则同一面板的旧记录会被判成"别的面板"。
			if (Boolean(resumed.libraryScope) !== libraryScope) return json(sink, 400, { error: "这条记录不属于这个面板" });
			if (!libraryScope && resumed.projectId !== body.projectId) {
				return json(sink, 400, { error: "这条记录属于别的作品" });
			}
			if (role === "writing" && resumed.chapterId !== body.chapterId) {
				return json(sink, 400, { error: "这条记录属于别的章节" });
			}
		}

		const session: Session = {
			id: sessionId,
			projectId: body.projectId ?? "",
			role,
			...(libraryScope ? { libraryScope: true } : {}),
			...(body.chapterId ? { chapterId: body.chapterId } : {}),
			modelRef: `${model.provider}/${model.id}`,
			thinkingLevel: body.thinkingLevel ?? settingsStore.get().defaultThinkingLevel,
			agent: undefined as unknown as Agent,
			model,
			createdAt: Date.now(),
			ask: createAskChannel(sessionId),
		};
		try {
			await replaceAgent(ctx, session, model);
		} catch (error) {
			return json(sink, 400, { error: (error as Error).message });
		}

		if (resumed) {
			session.recordId = resumed.id;
			// 接上那段对话：消息头仍是这一席刚建好的 system（提示词与工具声明在里头）。
			if (resumed.messages.length > 0) {
				const head = session.agent.state.messages[0]?.role === "system" ? session.agent.state.messages.slice(0, 1) : [];
				session.agent.state.messages = [...head, ...resumed.messages];
			}
		} else {
			const record = await recordStore.create({
				role,
				projectId: session.projectId,
				...(session.chapterId ? { chapterId: session.chapterId } : {}),
				...(libraryScope ? { libraryScope: true } : {}),
				title: recordTitleFor(ctx, { role, projectId: session.projectId, chapterId: session.chapterId, libraryScope }),
			});
			session.recordId = record.id;
		}

		pruneSessions(sessions);
		sessions.set(session.id, session);
		return json(sink, 201, {
			sessionId: session.id,
			role: session.role,
			model: session.modelRef,
			thinkingLevel: session.thinkingLevel,
			recordId: session.recordId,
		});
	}
	const modelMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/model$/);
	if (modelMatch && req.method === "POST") {
		const session = sessions.get(modelMatch[1]!);
		if (!session) return json(sink, 404, { error: "会话不存在或已过期" });
		// 生成途中换模型会把正在跑的那支智能体整支换掉：旧流还挂在旧对象上，
		// 前端却以为下一轮已经换了脑子。让当前这轮先结束（或先中止）再换。
		if (session.agent.state.isStreaming) {
			return json(sink, 409, { error: "当前这轮还在生成中，请先中止或等它结束再换模型" });
		}
		const body = await readJsonBody<{ modelRef?: string; thinkingLevel?: ThinkingLevel }>(req);
		try {
			const model = await resolveModel(body.modelRef ?? "");
			session.modelRef = `${model.provider}/${model.id}`;
			if (body.thinkingLevel) session.thinkingLevel = body.thinkingLevel;
			// 保留对话历史，只更换模型与推理档位。
			const messages = [...session.agent.state.messages];
			await replaceAgent(ctx, session, model);
			session.agent.state.messages = messages;
			return json(sink, 200, { model: session.modelRef, thinkingLevel: session.thinkingLevel });
		} catch (error) {
			const status = error instanceof ModelResolutionError ? 400 : 500;
			return json(sink, status, {
				error: (error as Error).message,
				candidates: error instanceof ModelResolutionError ? error.candidates : [],
			});
		}
	}

	const abortMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/abort$/);
	if (abortMatch && req.method === "POST") {
		const session = sessions.get(abortMatch[1]!);
		if (!session) return json(sink, 404, { error: "会话不存在" });
		session.agent.abort();
		// 中止了还在等的问题：作者不答了，这一轮也就到此为止。
		session.ask.close("aborted");
		return json(sink, 200, { ok: true });
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
		if (!session) return json(sink, 404, { error: "会话不存在" });
		session.agent.abort();
		session.ask.close("aborted");
		sessions.delete(session.id);
		return json(sink, 200, { ok: true });
	}

	const messageMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/messages$/);
	if (messageMatch && req.method === "POST") {
		const session = sessions.get(messageMatch[1]!);
		if (!session) return json(sink, 404, { error: "会话不存在或已过期" });
		// 上传的资料可能整篇进对话，给足体积。
		const body = await readJsonBody<{ input?: string }>(req, 8_000_000);
		const input = body.input?.trim();
		if (!input) return json(sink, 400, { error: "请求空白" });
		if (session.agent.state.isStreaming) return json(sink, 409, { error: "上一条消息还在生成中" });
		// 写作会话的组装上下文会随装料变化，每轮重建让提示词跟上。
		if (session.role === "writing") await refreshWritingAgent(ctx, session);
		const recordId = session.recordId;
		if (session.role === "writing" && session.projectId && session.chapterId) {
			sweepWriteRuns(ctx.runs);
			const runKey = writeRunKey(session.projectId, session.chapterId);
			if (ctx.runs.activeWriteRuns.has(runKey)) {
				return json(sink, 409, { error: "这一章正在生成或保存，请等这一轮结束再提交。" });
			}
			const acceptance: RunAcceptance = {
				runId: randomUUID(),
				projectId: session.projectId,
				chapterId: session.chapterId,
				mode: "patch",
				requiredTools: ["write_chapter", "append_chapter", "revise_chapter"],
				beforeRevision: store.get(session.projectId)?.drafts[session.chapterId]?.revision ?? 0,
			};
			const run: WriteRun = {
				...acceptance,
				requestId: acceptance.runId,
				recordId: recordId ?? "",
				events: [],
				done: false,
				createdAt: Date.now(),
			};
			ctx.runs.writeRuns.set(acceptance.runId, run);
			ctx.runs.activeWriteRuns.set(runKey, acceptance.runId);
			try {
				return await streamNdjson(
					ctx,
					sink,
					session.agent,
					session.modelRef,
					input,
					session.ask,
					recordId ? roundRecorder(ctx, session.agent, recordId) : undefined,
					acceptance,
				);
			} finally {
				ctx.runs.writeRuns.delete(acceptance.runId);
				if (ctx.runs.activeWriteRuns.get(runKey) === acceptance.runId) ctx.runs.activeWriteRuns.delete(runKey);
			}
		}
		return streamNdjson(
			ctx,
			sink,
			session.agent,
			session.modelRef,
			input,
			session.ask,
			recordId ? roundRecorder(ctx, session.agent, recordId) : undefined,
		);
	}

	/**
	 * 作者回话。
	 *
	 * 提问的那条流此刻正阻塞着等这个回答，所以回答不能走那条流 ——
	 * 走独立的一条 HTTP 请求，带上问题的 id。
	 *
	 * 空串是"跳过"：模型会知道作者没答，按自己的判断往下走。
	 */
	const answerMatch = pathname.match(/^\/api\/questions\/([\w-]+)\/answer$/);
	if (answerMatch && req.method === "POST") {
		const body = await readJsonBody<{ answer?: string }>(req);
		const answer = typeof body.answer === "string" ? body.answer.trim() : "";
		const id = answerMatch[1]!;
		if (!answerQuestion(id, answer)) {
			return json(sink, 404, { error: "这个问题已经结束了" });
		}
		return json(sink, 200, { ok: true });
	}

	/**
	 * 一次性写作：组装本章素材 → 生成正文。
	 *
	 * 不建常驻会话。上下文在服务端算好后一次性交给写作智能体，
	 * 章末正文由 write_chapter 落盘，因此连不上也不会丢稿。
	 * 每一轮都留一条记录；带上 recordId 就是从那一轮接着写。
	 */
	const writeMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)\/write$/);
	if (writeMatch && req.method === "POST") {
		const projectId = writeMatch[1]!;
		if (!store.get(projectId)) return json(sink, 404, { error: "工程不存在" });
		const body = await readJsonBody<{
			modelRef?: string;
			thinkingLevel?: ThinkingLevel;
			mode?: string;
			note?: string;
			/** 从这条旧记录接着写：那段对话会原样接在这一轮前面。 */
			recordId?: string;
			/** 客户端生成的幂等键；同键重试返回同一轮结果，不重复写章。 */
			requestId?: string;
		}>(req);

		sweepWriteRuns(ctx.runs);
		const chapterId = decodeURIComponent(writeMatch[2]!);
		const requestId = body.requestId;
		if (requestId !== undefined && !validRequestId(requestId)) {
			return json(sink, 400, { error: "requestId 需为 8–100 位字母、数字、下划线或连字符" });
		}
		// 幂等键只在参数完整后占位；校验失败不应阻塞后续正常写作。
		const runKey = writeRunKey(projectId, chapterId);
		const previousRunId = requestId
			? ctx.runs.completedWriteRequests.get(writeRequestKey(projectId, chapterId, requestId))
			: undefined;
		const previous = previousRunId ? ctx.runs.writeRuns.get(previousRunId) : undefined;
		if (previous) return replayWriteRun(sink, previous);
		if (ctx.runs.activeWriteRuns.has(runKey)) {
			return json(sink, 409, { error: "这一章正在生成或保存，请等这一轮结束再提交；不要重复点击。" });
		}
		const runId = randomUUID();
		const run: WriteRun = {
			runId,
			requestId,
			projectId,
			chapterId,
			mode: body.mode as ChapterWriteMode,
			beforeRevision: 0,
			recordId: "",
			events: [],
			done: false,
			createdAt: Date.now(),
		};
		ctx.runs.writeRuns.set(runId, run);
		ctx.runs.activeWriteRuns.set(runKey, runId);
		try {
			// mode 决定提示词里的"作业"，先定下来再组装上下文。
			if (body.mode !== undefined && !WRITE_MODES.includes(body.mode as ChapterWriteMode)) {
				return json(sink, 400, { error: "mode 只能是 create / rewrite / continue / patch" });
			}
			// 章号先对一遍再谈正文有无：章号打错时该说"没这一章"，
			// 而不是拿 patch 的"还没有正文"去答，否则作者会去按「从零写起」白写一遍。
			const project = store.get(projectId)!;
			if (!project.outline.some((chapter) => chapter.id === chapterId)) {
				return json(sink, 404, { error: "章节 " + chapterId + " 不存在" });
			}
			const hasDraft = Boolean(project.drafts[chapterId]);
			const mode: ChapterWriteMode = (body.mode as ChapterWriteMode | undefined) ?? (hasDraft ? "rewrite" : "create");
			if (run) run.mode = mode; // 局部修改改的是已有正文：没有正文就无从下笔，别让它退化成"从零写起"。
			if (mode === "patch" && !hasDraft) {
				return json(sink, 409, { error: "这一章还没有正文，没法局部修改；要从零写起请选「从零写起」。" });
			}

			let assembly: WritingContext;
			try {
				assembly = await buildWritingContext(ctx, projectId, chapterId, mode);
			} catch (error) {
				return json(sink, 404, { error: (error as Error).message });
			}
			// 局部修改不装料也成立：料是"写"的来源，不是"改"的前提。
			const blocked = mode === "patch" ? "" : writingPreflight(assembly);
			if (blocked) return json(sink, 409, { error: blocked });

			const modelRef = resolveDefaultModel(ctx, body.modelRef);
			if (!modelRef) return json(sink, 400, { error: "请指定模型" });
			let model: Model<any>;
			try {
				model = await resolveModel(modelRef);
			} catch (error) {
				const status = error instanceof ModelResolutionError ? 400 : 500;
				return json(sink, status, {
					error: (error as Error).message,
					candidates: error instanceof ModelResolutionError ? error.candidates : [],
				});
			}

			const instruction = writingInstruction(assembly, body.note?.trim());
			// 记录先认下来：接旧记录就沿用它的 id，否则这一轮自己开一条。
			const resumed = body.recordId ? recordStore.get(body.recordId) : undefined;
			if (body.recordId && !resumed) return json(sink, 404, { error: "这条记录不在了（可能已被删除）" });
			if (resumed) {
				if (resumed.role !== "writing") return json(sink, 400, { error: "这条记录不属于执笔者" });
				if (resumed.projectId !== projectId || resumed.chapterId !== chapterId) {
					return json(sink, 400, { error: "这条记录属于别的章节" });
				}
			}
			const record =
				resumed ??
				(await recordStore.create({
					role: "writing",
					projectId,
					chapterId,
					title: recordTitleFor(ctx, { role: "writing", projectId, chapterId, mode }),
				}));

			let agent: Agent;
			try {
				agent = await createNovelAgent({
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
			} catch (error) {
				// 这一轮根本没开成，刚占的那条空记录别留着占名额。
				if (!resumed) await recordStore.remove(record.id);
				return json(sink, 400, { error: (error as Error).message });
			}
			// 接着旧记录写：把那段对话当成本轮之前的上下文。系统消息不塞，
			// 这一轮的提示词是按现在的素材现算的，比旧的那份准 ——
			// 但消息头那条 system 要留住，它是提示词与工具声明的载体。
			if (resumed && resumed.messages.length > 0) {
				const head = agent.state.messages[0]?.role === "system" ? agent.state.messages.slice(0, 1) : [];
				agent.state.messages = [...head, ...resumed.messages];
			}
			return await streamNdjson(ctx, sink, agent, `${model.provider}/${model.id}`, instruction, undefined, roundRecorder(ctx, agent, record.id), {
				runId,
				projectId,
				chapterId,
				mode,
				beforeRevision: project.drafts[chapterId]?.revision ?? 0,
			});
		} finally {
			// 校验失败是普通 return，也走这里；不能只清异常路径，否则章会永久卡在 409。
			const latest = ctx.runs.writeRuns.get(runId);
			if (!latest || !latest.done) ctx.runs.writeRuns.delete(runId);
			if (ctx.runs.activeWriteRuns.get(runKey) === runId) ctx.runs.activeWriteRuns.delete(runKey);
		}
	}

	// ---------------------------------------------------------------- 生成记录
	//
	// 每轮落笔都留档：作者回头能翻到上一版是在哪一轮写的，也能从那一轮接着写。
	// 列表只给摘要，正文按 id 现取 —— 一条记录里可能躺着整章内容。

	if (pathname === "/api/records" && req.method === "GET") {
		const filter: RecordFilter = {};
		const roleParam = req.searchParams.get("role");
		if (roleParam === "writing" || roleParam === "material") filter.role = roleParam as RecordRole;
		const projectId = req.searchParams.get("projectId");
		if (projectId) filter.projectId = projectId;
		const chapterId = req.searchParams.get("chapterId");
		if (chapterId) filter.chapterId = chapterId;
		if (req.searchParams.get("scope") === "library") filter.libraryScope = true;
		const asked = Number(req.searchParams.get("limit") ?? recordsKeep);
		const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 50) : recordsKeep;
		return json(sink, 200, { records: recordStore.list(filter, limit) });
	}

	const recordMatch = pathname.match(/^\/api\/records\/([\w-]+)$/);
	if (recordMatch && req.method === "GET") {
		const record = recordStore.get(recordMatch[1]!);
		if (!record) return json(sink, 404, { error: "这条记录不在了（可能已被删除）" });
		return json(sink, 200, { record });
	}

	if (recordMatch && req.method === "DELETE") {
		if (!(await recordStore.remove(recordMatch[1]!))) {
			return json(sink, 404, { error: "这条记录不在了（可能已被删除）" });
		}
		return json(sink, 200, { ok: true });
	}

	// ---------------------------------------------------------------- 通用素材库
	//
	// 跨作品的一层：库里的料不属于任何一部小说。新建作品时可以把它们取进作品，
	// 作品里改好的料也可以存回库里。取用是复制（materialFromLibrary），
	// 所以作品文件始终自包含，删掉库里的条目也不会让已有作品缺料。

	if (pathname === "/api/library" && req.method === "GET") {
		return json(sink, 200, libraryView(ctx));
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
		if (!title) return json(sink, 400, { error: "请填写素材标题" });
		if (!content) return json(sink, 400, { error: "素材内容是空的" });
		const entry = libraryStore.create({
			kind: isKnownKind(String(body.kind ?? "")) ? (String(body.kind).trim() as MaterialKind) : "other",
			title,
			content,
			usage: body.usage?.trim() ?? "",
			tags: pickTags(body.tags),
			// 作者亲手收录的，直接算确认过的。
			status: "confirmed",
		});
		await libraryStore.flush();
		return json(sink, 201, { material: entry, ...libraryView(ctx) });
	}

	const libraryItemMatch = pathname.match(/^\/api\/library\/([\w-]+)$/);
	if (libraryItemMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const libraryId = libraryItemMatch[1]!;
		if (!libraryStore.get(libraryId)) return json(sink, 404, { error: "通用素材不存在" });

		if (req.method === "DELETE") {
			libraryStore.remove(libraryId);
			await libraryStore.flush();
			return json(sink, 200, { ok: true, ...libraryView(ctx) });
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
		if (typeof body.kind === "string" && isKnownKind(body.kind.trim())) {
			input.kind = body.kind.trim() as MaterialKind;
		}
		if (typeof body.title === "string") input.title = body.title;
		if (typeof body.content === "string") input.content = body.content;
		if (typeof body.usage === "string") input.usage = body.usage;
		if (body.status === "confirmed" || body.status === "draft") input.status = body.status;
		if (Array.isArray(body.tags)) input.tags = pickTags(body.tags);
		const material = libraryStore.update(libraryId, input);
		await libraryStore.flush();
		return json(sink, 200, { material, ...libraryView(ctx) });
	}

	/**
	 * 素材种类目录。
	 *
	 * 内置的十三个是所有书共用的笔法，自建的那些是这位作者自己的门类 ——
	 * 势力、道具、民俗，哪本书里都成立，所以目录是全局一份，不挂在某部作品下。
	 */
	if (pathname === "/api/kinds" && req.method === "GET") {
		return json(sink, 200, { kinds: kindsView(ctx) });
	}

	if (pathname === "/api/kinds" && req.method === "POST") {
		const body = await readJsonBody<{ label?: string }>(req, 200_000);
		const result = kindStore.add(String(body.label ?? ""));
		if (!result.ok) return json(sink, result.status, { error: result.error });
		// 登记进全局：素材校验、界面分组、智能体的工具 schema 都问这张表。
		registerCustomKinds(kindStore.list());
		return json(sink, 201, { kind: result.value.id, label: result.value.label, kinds: kindsView(ctx) });
	}

	const kindItemMatch = pathname.match(/^\/api\/kinds\/([^/]+)$/);
	if (kindItemMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const kindId = decodeURIComponent(kindItemMatch[1]!);
		// 内置种类是共用的笔法：不给改名，也不给删。
		if ((MATERIAL_KINDS as readonly string[]).includes(kindId)) {
			return json(sink, 400, { error: "内置种类不能改" });
		}

		if (req.method === "DELETE") {
			const removed = kindStore.remove(kindId);
			if (!removed.ok) return json(sink, removed.status, { error: removed.error });
			// 用着这一类的料改判为「其他」：不这么办，这些料就成了认不出的孤儿，
			// 界面上既选不到它们的类别，智能体也检索不着。
			let moved = 0;
			for (const entry of libraryStore.list()) {
				if (entry.kind !== kindId) continue;
				libraryStore.update(entry.id, { kind: "other" as MaterialKind });
				moved += 1;
			}
			for (const project of store.list()) {
				if (!project.materials.some((item) => item.kind === kindId)) continue;
				store.mutate(project.id, (draft) => {
					for (const material of draft.materials) {
						if (material.kind !== kindId) continue;
						material.kind = "other" as MaterialKind;
						material.updatedAt = Date.now();
						moved += 1;
					}
				});
			}
			registerCustomKinds(kindStore.list());
			return json(sink, 200, { kinds: kindsView(ctx), moved });
		}

		const body = await readJsonBody<{ label?: string }>(req, 200_000);
		const renamed = kindStore.rename(kindId, String(body.label ?? ""));
		if (!renamed.ok) return json(sink, renamed.status, { error: renamed.error });
		registerCustomKinds(kindStore.list());
		return json(sink, 200, { kind: renamed.value.id, label: renamed.value.label, kinds: kindsView(ctx) });
	}

	/** 把作品里的一条素材存进通用素材库，或更新它来源的那一条。 */
	const promoteMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/materials\/([^/]+)\/library$/);
	if (promoteMatch && req.method === "POST") {
		const projectId = promoteMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const materialId = decodeURIComponent(promoteMatch[2]!);
		const material = project.materials.find((item) => item.id === materialId);
		if (!material) return json(sink, 404, { error: "素材不存在" });

		const body = await readJsonBody<{ mode?: string; title?: string }>(req);
		const mode = body.mode === "update" ? "update" : "create";
		// 更新只在这条料确实有来源条目时成立：否则会把别人收录的条目覆盖掉。
		if (mode === "update" && (!material.originId || !libraryStore.get(material.originId))) {
			return json(sink, 409, { error: "这条素材没有可更新的库条目，请改用「另存为新条目」" });
		}

		const fields = libraryFieldsOf(material);
		if (typeof body.title === "string" && body.title.trim()) fields.title = body.title.trim();

		if (mode === "update") {
			const updated = libraryStore.update(material.originId!, fields);
			return json(sink, 200, { mode, material: updated, ...libraryView(ctx) });
		}

		const entry = libraryStore.create({ ...fields, status: "confirmed" });
		// 记下来源：之后在作品里改好了可以直接推回这一条。
		store.mutate(projectId, (draft) => {
			const target = draft.materials.find((item) => item.id === materialId);
			if (target) target.originId = entry.id;
		});
		return json(sink, 200, { mode, material: entry, ...libraryView(ctx) });
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
		const filename = req.searchParams.get("filename")?.trim();
		if (!filename) return json(sink, 400, { error: "缺少 filename" });
		if (exceedsUploadLimit(req)) return uploadLimitError(sink);
		let bytes: Uint8Array;
		try {
			bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		} catch (error) {
			return json(sink, 413, { error: (error as Error).message });
		}
		if (bytes.length === 0) return json(sink, 400, { error: "文件是空的" });
		try {
			const extracted = await extractText(filename, bytes);
			return json(sink, 200, { upload: { filename, ...extracted } });
		} catch (error) {
			if (error instanceof UploadTooLargeError) return json(sink, 413, { error: error.message });
			if (error instanceof UnsupportedUploadError) return json(sink, 415, { error: error.message });
			throw error;
		}
	}

	/** 上传原料（作品作用域）：同上，只是多一道工程存在性检查。 */
	const uploadMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/uploads$/);
	if (uploadMatch && req.method === "POST") {
		if (!store.get(uploadMatch[1]!)) return json(sink, 404, { error: "工程不存在" });
		const filename = req.searchParams.get("filename")?.trim();
		if (!filename) return json(sink, 400, { error: "缺少 filename" });
		if (exceedsUploadLimit(req)) return uploadLimitError(sink);
		let bytes: Uint8Array;
		try {
			bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		} catch (error) {
			return json(sink, 413, { error: (error as Error).message });
		}
		if (bytes.length === 0) return json(sink, 400, { error: "文件是空的" });
		try {
			const extracted = await extractText(filename, bytes);
			return json(sink, 200, { upload: { filename, ...extracted } });
		} catch (error) {
			if (error instanceof UploadTooLargeError) return json(sink, 413, { error: error.message });
			if (error instanceof UnsupportedUploadError) return json(sink, 415, { error: error.message });
			throw error;
		}
	}

	/** 新建素材：上传的原料经作者确认后入库。 */
	const materialCreateMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/materials$/);
	if (materialCreateMatch && req.method === "POST") {
		const projectId = materialCreateMatch[1]!;
		if (!store.get(projectId)) return json(sink, 404, { error: "工程不存在" });
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
		if (!title) return json(sink, 400, { error: "请填写素材标题" });
		if (!content) return json(sink, 400, { error: "素材内容是空的" });

		const id = randomUUID();
		const chapterIds = Array.isArray(body.chapterIds)
			? body.chapterIds.filter((value): value is string => typeof value === "string")
			: [];
		const saved = store.mutate(projectId, (project) => {
			project.materials.push({
				id,
				kind: isKnownKind(String(body.kind ?? "")) ? (String(body.kind).trim() as MaterialKind) : "other",
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
		return json(sink, 201, {
			material: saved.materials.find((item) => item.id === id),
			stats: store.stats(saved),
		});
	}

	/** 改 / 删单条素材。 */
	const materialItemMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/materials\/([^/]+)$/);
	if (materialItemMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const projectId = materialItemMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const materialId = decodeURIComponent(materialItemMatch[2]!);
		if (!project.materials.some((item) => item.id === materialId)) {
			return json(sink, 404, { error: "素材不存在" });
		}

		if (req.method === "DELETE") {
			// 删除前拍快照：素材可能是作者手写了很久的，删了就没了。
			// removeMaterial 会顺手把它从各章装配清单里摘掉，
			// 否则那些章节的"装料 N 条"会一直虚高。
			await store.snapshot(project, "before-material-delete");
			const saved = store.mutate(projectId, (draft) => {
				removeMaterial(draft, materialId);
			});
			return json(sink, 200, { ok: true, stats: store.stats(saved) });
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
			if (typeof body.kind === "string" && isKnownKind(body.kind.trim())) material.kind = body.kind.trim() as MaterialKind;
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
		return json(sink, 200, {
			material: saved.materials.find((item) => item.id === materialId),
			stats: store.stats(saved),
		});
	}

	/** 作者在工作台里直接装料 / 摘料。 */
	const assemblyMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)\/materials$/);
	if (assemblyMatch && req.method === "POST") {
		const projectId = assemblyMatch[1]!;
		const project = store.get(projectId);
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(assemblyMatch[2]!);
		if (!project.outline.some((item) => item.id === chapterId)) {
			return json(sink, 404, { error: "章节不存在" });
		}
		const body = await readJsonBody<{ add?: string[]; remove?: string[] }>(req, 8_000_000);
		const pick = (value: unknown) =>
			Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
		const add = pick(body.add);
		const remove = pick(body.remove);
		if (add.length === 0 && remove.length === 0) {
			return json(sink, 400, { error: "add 与 remove 不能同时为空" });
		}
		const skipped: string[] = [];
		const saved = store.mutate(projectId, (draft) => {
			// 先摘后装：同一批里既摘又装时，装是作者的最终意图。
			skipped.push(...linkMaterials(draft, chapterId, remove, "remove").skipped);
			skipped.push(...linkMaterials(draft, chapterId, add, "add").skipped);
		});
		return json(sink, 200, {
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
		if (!project) return json(sink, 404, { error: "工程不存在" });
		const kind = req.searchParams.get("kind")?.trim();
		const materials = kind ? project.materials.filter((m) => m.kind === kind) : project.materials;
		return json(sink, 200, { materials, kinds: kindsView(ctx) });
	}

	// ---------------------------------------------------------------- 设置

	if (pathname === "/api/settings" && req.method === "GET") {
		return json(sink, 200, await settingsView(ctx));
	}

	if (pathname === "/api/settings" && req.method === "PUT") {
		const body = await readJsonBody<{
			defaultModel?: string;
			defaultThinkingLevel?: string;
			webSearch?: unknown;
			webApiKey?: string;
		}>(req);
		if (body.webSearch !== undefined) {
			const next = normalizeWebSearch({
				...settingsStore.get().webSearch,
				...(body.webSearch && typeof body.webSearch === "object" ? body.webSearch : {}),
			});
			if (
				next.enabled &&
				!credentialStore.hasKey(WEB_CREDENTIAL_ID) &&
				!ctx.deps.env.DEEPSEEK_API_KEY &&
				!body.webApiKey?.trim()
			) {
				return json(sink, 400, {
					error: "请先填写 DeepSeek API Key，或在环境变量 DEEPSEEK_API_KEY 中配置。",
				});
			}
			settingsStore.mutate((settings) => {
				settings.webSearch = next;
			});
		}
		if (typeof body.webApiKey === "string") await credentialStore.setKey(WEB_CREDENTIAL_ID, body.webApiKey);
		settingsStore.mutate((settings) => {
			if (typeof body.defaultModel === "string") settings.defaultModel = body.defaultModel.trim();
			if (typeof body.defaultThinkingLevel === "string") {
				const level = body.defaultThinkingLevel as Settings["defaultThinkingLevel"];
				if (THINKING_LEVELS.includes(level)) settings.defaultThinkingLevel = level;
			}
		});
		await settingsStore.flush();
		return json(sink, 200, await settingsView(ctx));
	}

	if (pathname === "/api/settings/web-search/test" && req.method === "POST") {
		const search = await authorizedWebSearch(ctx);
		if (!search) return json(sink, 400, { error: "请先保存 API Key 并开启联网检索。" });
		try {
			const results = await search.client.search("DeepSeek 网页搜索 API", { count: 1 });
			return json(sink, 200, {
				ok: true,
				results: results.length,
				message: `连接正常，返回 ${results.length} 条结果。此次成功搜索可能按官方价格计费。`,
			});
		} catch (error) {
			return json(sink, 502, { error: (error as Error).message });
		}
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
		if (!label) return json(sink, 400, { error: "请填写供应商名称" });
		if (!baseUrl) return json(sink, 400, { error: "请填写 Base URL" });
		if (!api || !API_FORMATS.includes(api)) return json(sink, 400, { error: "请选择接口格式" });
		try {
			new URL(baseUrl);
		} catch {
			return json(sink, 400, { error: "Base URL 不是合法地址" });
		}
		if (settingsStore.getProvider(slugify(label))) {
			return json(sink, 409, { error: "同名供应商已存在" });
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
		return json(sink, 201, { provider: providerView(created), status: await statusOf(ctx, created.id) });
	}

	const providerMatch = pathname.match(/^\/api\/providers\/([\w-]+)$/);
	if (providerMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const provider = settingsStore.getProvider(providerMatch[1]!);
		if (!provider) return json(sink, 404, { error: "供应商不存在" });
		if (req.method === "DELETE") {
			settingsStore.removeProvider(provider.id);
			await credentialStore.setKey(provider.id, undefined);
			rebuildModels();
			return json(sink, 200, await settingsView(ctx));
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
		return json(sink, 200, {
			provider: providerView(settingsStore.getProvider(provider.id)!),
			status: await statusOf(ctx, provider.id),
		});
	}

	// 清除已保存的 key
	const keyMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/key$/);
	if (keyMatch && req.method === "DELETE") {
		const provider = settingsStore.getProvider(keyMatch[1]!);
		if (!provider) return json(sink, 404, { error: "供应商不存在" });
		await credentialStore.setKey(provider.id, undefined);
		rebuildModels();
		return json(sink, 200, { status: await statusOf(ctx, provider.id) });
	}

	// 从上游拉取模型列表
	const fetchMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/fetch$/);
	if (fetchMatch && req.method === "POST") {
		const provider = settingsStore.getProvider(fetchMatch[1]!);
		if (!provider) return json(sink, 404, { error: "供应商不存在" });
		if (provider.kind === "builtin") {
			const entry = ctx.deps.builtinCatalog.find((item) => item.id === provider.id || item.id === provider.builtinId);
			if (!entry?.baseUrl || !entry.api) return json(sink, 400, { error: "这个内置厂商没有可用于拉取模型的接入点" });
			const credential = await credentialStore.read(provider.id);
			const apiKey = credential?.type === "api_key" && credential.key
				? credential.key
				: entry.envVars.map((name) => ctx.deps.env[name]).find((value): value is string => Boolean(value)) ?? "";
			try {
				const fetched = await fetchUpstreamModels({
					baseUrl: provider.baseUrl ?? entry.baseUrl,
					api: provider.api ?? entry.api,
					apiKey,
					fetchImpl: ctx.deps.upstreamFetch,
				});
				const models = replaceWithFetched(provider.models, fetched);
				const fetchedAt = Date.now();
				settingsStore.upsertProvider({ ...provider, models, modelsSource: "upstream", modelsFetchedAt: fetchedAt, updatedAt: fetchedAt });
				rebuildModels();
				return json(sink, 200, {
					provider: providerView(settingsStore.getProvider(provider.id)!),
					fetched: fetched.length,
					added: models.filter((model) => !provider.models.some((old) => old.id === model.id)).length,
					addedIds: models.filter((model) => !provider.models.some((old) => old.id === model.id)).map((model) => model.id),
					backfilled: [],
					modelsSource: "upstream",
					modelsFetchedAt: fetchedAt,
				});
			} catch (error) {
				return json(sink, 502, { error: (error as Error).message });
			}
		}
		if (!provider.baseUrl || !provider.api) {
			return json(sink, 400, { error: "自定义供应商需要填写 Base URL 与接口格式" });
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
			return json(sink, 200, {
				provider: providerView(settingsStore.getProvider(provider.id)!),
				fetched: fetched.length,
				added: added.length,
				addedIds: added,
				// 这次从上游回填了限制的模型（原先还是占位值的那几项）。
				backfilled,
			});
		} catch (error) {
			const status = (error as { status?: number }).status;
			return json(sink, status && status < 500 ? 502 : 502, { error: (error as Error).message });
		}
	}

	// 内置厂商放弃实时清单，回到应用随版本维护的目录。
	const catalogMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/catalog$/);
	if (catalogMatch && req.method === "POST") {
		const provider = settingsStore.getProvider(catalogMatch[1]!);
		if (!provider) return json(sink, 404, { error: "供应商不存在" });
		if (provider.kind !== "builtin") return json(sink, 400, { error: "只有内置供应商有内置目录" });
		const { modelsSource: _source, modelsFetchedAt: _fetchedAt, ...base } = provider;
		const restored = settingsStore.upsertProvider({ ...base, updatedAt: Date.now() });
		rebuildModels();
		return json(sink, 200, { provider: providerView(restored), modelsSource: "catalog" });
	}

	// 新增 / 更新单个模型的参数
	const upsertModelMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models$/);
	if (upsertModelMatch && req.method === "POST") {
		const provider = settingsStore.getProvider(upsertModelMatch[1]!);
		if (!provider) return json(sink, 404, { error: "供应商不存在" });
		const body = await readJsonBody<Partial<ModelConfig> & { id?: string }>(req);
		const id = body.id?.trim();
		if (!id) return json(sink, 400, { error: "缺少模型 id" });
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
		return json(sink, 200, { provider: providerView(settingsStore.getProvider(provider.id)!) });
	}

	// 批量更新模型参数：设置页的"统一改上下文窗口 / 输出上限 / 思考档位"。
	const patchModelsMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models$/);
	if (patchModelsMatch && req.method === "PATCH") {
		const provider = settingsStore.getProvider(patchModelsMatch[1]!);
		if (!provider) return json(sink, 404, { error: "供应商不存在" });
		const body = await readJsonBody<{
			ids?: unknown;
			contextWindow?: unknown;
			maxTokens?: unknown;
			reasoning?: unknown;
			thinkingLevels?: unknown;
		}>(req);

		// ids 缺省或为空数组 = 该供应商的全部模型。
		if (body.ids !== undefined && !Array.isArray(body.ids)) {
			return json(sink, 400, { error: "ids 必须是字符串数组" });
		}
		const ids = Array.isArray(body.ids)
			? body.ids
					.filter((id): id is string => typeof id === "string")
					.map((id) => id.trim())
					.filter((id) => id !== "")
			: [];

		if (body.contextWindow !== undefined && !isPositiveInt(body.contextWindow)) {
			return json(sink, 400, { error: "contextWindow 必须是正整数" });
		}
		if (body.maxTokens !== undefined && !isPositiveInt(body.maxTokens)) {
			return json(sink, 400, { error: "maxTokens 必须是正整数" });
		}
		if (body.reasoning !== undefined && typeof body.reasoning !== "boolean") {
			return json(sink, 400, { error: "reasoning 必须是布尔值" });
		}
		let levels: ModelThinkingLevel[] | undefined;
		if (body.thinkingLevels !== undefined) {
			if (
				!Array.isArray(body.thinkingLevels) ||
				body.thinkingLevels.some((level) => !THINKING_LEVELS.includes(level as ModelThinkingLevel))
			) {
				return json(sink, 400, { error: "thinkingLevels 含有非法档位" });
			}
			levels = body.thinkingLevels as ModelThinkingLevel[];
		}
		if (body.contextWindow === undefined && body.maxTokens === undefined && body.reasoning === undefined && !levels) {
			return json(sink, 400, { error: "没有需要更新的字段" });
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
		return json(sink, 200, {
			updated,
			provider: providerView(settingsStore.getProvider(provider.id)!),
		});
	}

	const modelItemMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/([^/]+)$/);
	if (modelItemMatch && req.method === "DELETE") {
		const provider = settingsStore.getProvider(modelItemMatch[1]!);
		if (!provider) return json(sink, 404, { error: "供应商不存在" });
		const modelId = decodeURIComponent(modelItemMatch[2]!);
		settingsStore.upsertProvider({ ...provider, models: provider.models.filter((model) => model.id !== modelId) });
		rebuildModels();
		return json(sink, 200, { provider: providerView(settingsStore.getProvider(provider.id)!) });
	}

	// 落盘健康状况：前端据此提示"这一稿可能没存上"，而不是让用户以为存成功了。
	if (pathname === "/api/storage" && req.method === "GET") {
		const pending = store.pendingWrites();
		// pending 仍按作品粒度（前端只读它）；pendingChapters 给出具体失败的章，
		// 供排查与后续界面细化，旧前端不依赖这个字段。
		const pendingChapters = store.pendingChapterWrites();
		return json(sink, 200, {
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
		return json(sink, 200, { ok: pending.length === 0, pending });
	}

	const snapshotMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/snapshots$/);
	if (snapshotMatch && req.method === "GET") {
		if (!store.get(snapshotMatch[1]!)) return json(sink, 404, { error: "工程不存在" });
		return json(sink, 200, { snapshots: await store.listSnapshots(snapshotMatch[1]!) });
	}

	const snapshotItemMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/snapshots\/([^/]+)$/);
	if (snapshotItemMatch && req.method === "POST") {
		const projectId = snapshotItemMatch[1]!;
		const current = store.get(projectId);
		if (!current) return json(sink, 404, { error: "工程不存在" });
		const restored = await store.readSnapshot(projectId, decodeURIComponent(snapshotItemMatch[2]!));
		if (!restored) return json(sink, 404, { error: "快照不存在或已损坏" });
		// 回滚前先给当前状态拍一份，否则回滚本身就成了不可逆操作。
		await store.snapshot(current, "before-restore");
		store.mutate(projectId, (draft) => {
			// 逐字段覆盖而不是整体替换对象。
			draft.title = restored.project.title;
			draft.genre = restored.project.genre;
			draft.logline = restored.project.logline;
			draft.synopsis = restored.project.synopsis;
			draft.styleGuide = restored.project.styleGuide;
			draft.targetWords = restored.project.targetWords;
			draft.materials = restored.project.materials;
			draft.outline = restored.project.outline;
			draft.volumes = restored.project.volumes;
			draft.notes = restored.project.notes;
			draft.drafts = { ...restored.project.drafts };
		});
		// 正文逐章退回去：只退骨架等于书还在原处，字没回来。
		for (const [chapterId, body] of Object.entries(restored.bodies)) {
			const meta = restored.project.drafts[chapterId];
			await store.saveDraftBody(projectId, chapterId, {
				title: meta?.title ?? chapterId,
				content: body.content,
				summary: meta?.summary,
				materialIds: meta?.materialIds ?? [],
				keepHistory: false,
			});
		}
		return json(sink, 200, { project: store.get(projectId) });
	}

	/**
	 * 搬家的出口：把整个工作区（或一部作品）打成一个 `.novel` 文件。
	 *
	 * 多用户模式下这件事的分量比单机重得多 —— 数据只在别人的浏览器里，
	 * 换一台机器、换一个浏览器、清一次站点数据，稿子就没了。
	 * 所以导出是这套改造里唯一"必须存在"的逃生通道。
	 *
	 * 参数（都在查询串里，因为要能直接用 <a download> 触发）：
	 *   project=<id>        只导这一部（单部导出不含设置与密钥）
	 *   passphrase=<口令>   给了就 AES-GCM 加密
	 *   credentials=1       连 API 密钥一起带走（必须给口令，且不能是单部导出）
	 *   compress=0          不 gzip，落盘是人眼可读的 JSON
	 */
	if (pathname === "/api/novel/export" && req.method === "GET") {
		const projectId = req.searchParams.get("project")?.trim() || undefined;
		if (projectId && !store.get(projectId)) return json(sink, 404, { error: "工程不存在" });
		const passphrase = req.searchParams.get("passphrase") ?? undefined;
		const includeCredentials = req.searchParams.get("credentials") === "1";
		const compress = req.searchParams.get("compress") !== "0";
		let bytes: Uint8Array;
		try {
			bytes = await exportNovel(
				{
					store,
					libraryStore: ctx.deps.libraryStore,
					kindStore: ctx.deps.kindStore,
					settingsStore: ctx.deps.settingsStore,
					recordStore: ctx.deps.recordStore,
					credentialStore: ctx.deps.credentialStore,
				},
				{ projectId, passphrase, includeCredentials, compress },
			);
		} catch (error) {
			// 口令/参数层面的错是作者能修的，回 400 说人话；真意外照旧冒成 500。
			return json(sink, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		const stamp = new Date().toISOString().slice(0, 10);
		const name = projectId ? `${exportFilename(store.get(projectId)!, null, "novel")}` : `novel-studio-${stamp}.novel`;
		sink.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(bytes.length),
			// 中文文件名只能走 RFC 5987 的 filename*，塞进 filename= 会被浏览器整个丢掉。
			"content-disposition": `attachment; filename="novel.novel"; filename*=UTF-8''${encodeURIComponent(name)}`,
		});
		sink.end(bytes);
		return;
	}

	/**
	 * 搬家的入口：把 `.novel` 文件读回浏览器（或磁盘）。
	 *
	 * 请求体就是文件字节本身，不经 multipart —— 前端 `fetch(url, { body: file })` 直接怼过来，
	 * 少一层解析就少一处能把大文件读爆的地方。
	 */
	if (pathname === "/api/novel/import" && req.method === "POST") {
		const passphrase = req.searchParams.get("passphrase") ?? undefined;
		const onConflictRaw = req.searchParams.get("onConflict") ?? "skip";
		const onConflict = onConflictRaw === "replace" || onConflictRaw === "rename" ? onConflictRaw : "skip";
		let bytes: Uint8Array;
		try {
			bytes = await req.raw(NOVEL_PACKAGE_MAX_BYTES);
		} catch (error) {
			return json(sink, 413, { error: error instanceof Error ? error.message : "文件太大" });
		}
		if (bytes.length === 0) return json(sink, 400, { error: "文件是空的" });
		let result: NovelImportResult;
		try {
			result = await importNovel(
				{
					store,
					libraryStore: ctx.deps.libraryStore,
					kindStore: ctx.deps.kindStore,
					settingsStore: ctx.deps.settingsStore,
					recordStore: ctx.deps.recordStore,
					credentialStore: ctx.deps.credentialStore,
				},
				bytes,
				{ passphrase, onConflict },
			);
		} catch (error) {
			return json(sink, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		// 导完立刻把骨架推到底：作者关标签页之前就该真的在库里，不能等闲时落盘。
		await store.flush();
		return json(sink, 200, result);
	}

	return json(sink, 404, { error: "未知接口" });
}

/**
 * 造一个路由器。
 *
 * 兜底也在这里：任何未捕获异常都翻成 JSON，绝不让它把进程带走。
 * 请求体解析这类底层错误（413 / 400）没有出口可写，只能抛；
 * 在这里统一翻译成状态码。500 则说明是真正的意外，照旧记日志再回一句人话。
 */
export function createApiRouter(deps: ApiRouterDeps): ApiRouter {
	const ctx: RouterContext = {
		deps,
		runs: {
			writeRuns: new Map<string, WriteRun>(),
			activeWriteRuns: new Map<string, string>(),
			completedWriteRequests: new Map<string, string>(),
		},
	};
	return async (req: ApiRequest, sink: ApiSink): Promise<void> => {
		try {
			await handleRoutes(ctx, req, sink);
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			console.error("[server]", error);
			if (!sink.headersSent) json(sink, status, { error: error instanceof Error ? error.message : String(error) });
			else if (!sink.ended) sink.end();
		}
	};
}
