import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/env.ts";
import { assembledMaterials, kindLabel, type ChapterDraft, type ChapterMeta, type Project, type ProjectStore } from "../store/project.ts";
import type { MaterialLibrary } from "../store/library.ts";
import {
	buildContextDigest,
	buildLibrarySystemPrompt,
	buildMaterialSystemPrompt,
	buildWritingSystemPrompt,
	type WritingContext,
} from "./prompts.ts";
import { createLibraryTools, createMaterialTools, createWritingTools } from "./tools.ts";
import type { AskBroker } from "./ask.ts";

/**
 * 智能体角色。
 *
 * material = 设定官，产出素材条目，没有写正文的工具。
 * writing  = 执笔者，把已装配的素材组装成正文，读得到素材但改不了素材。
 */
export type AgentRole = "material" | "writing";

export interface NovelAgentOptions {
	store: ProjectStore;
	projectId: string;
	model: Model<any>;
	models: Models;
	config: AppConfig;
	sessionId: string;
	role: AgentRole;
	/** writing 角色必填：一次性写作的目标章节。 */
	chapterId?: string;
	/** writing 角色可选：覆盖组装上下文（一次性写作时由服务端算好传入）。 */
	writing?: WritingContext;
	/**
	 * 库作用域：给了它就走通用素材库这一支，不碰工程。
	 * 这一支下 projectId 可以是空串，工具集也换成只有素材读写的那两个。
	 */
	library?: MaterialLibrary;
	thinkingLevel?: ThinkingLevel;
	/**
	 * 提问通道。给了才有 ask_user 工具 ——
	 * 没有通道的场合（比如一次性写作）不给模型一个问不出去的工具。
	 */
	ask?: AskBroker;
}

/** 当会话里的工具结果超过这个数量时，丢弃最旧的部分。 */
const MAX_TOOL_RESULTS = 24;

const TOOL_ROLES = new Set(["toolResult"]);

/**
 * 单次上游请求的兜底超时。
 *
 * 三分钟：正常成文时首字几秒内就到，等不到多半是中转站挂起了；
 * 让作者对着一个已经死掉的连接干等 SDK 默认的十分钟，是最坏的体验。
 * 每三分钟收一次手并重来，才能把"偶发挂起"和"Key/额度真的废了"区分开。
 */
const STREAM_TIMEOUT_MS = 180_000;

/**
 * 超时/连接失败后的兜底重试次数。
 *
 * 两次：偶发 5xx、限流、连接没建起来，这个量级足够自愈；
 * 再多也不会让失效的 Key 变好，只会把一次明显的失败拖成更长的空等。
 */
const STREAM_MAX_RETRIES = 2;

/**
 * 给 Agent 用的流函数补上超时与重试。
 *
 * Agent 循环调用 streamFn 时会把 apiKey、signal 等一起塞进 options，
 * 这里只填缺省值，调用方显式给了就以调用方为准 —— 尤其 signal 必须原样
 * 传下去，"止笔"靠它中断上游请求。直接 bind(models.streamSimple) 的话，
 * 适配器在 options.timeoutMs 缺省时不设 HTTP 超时、maxRetries 也会被
 * 显式写成 0，一次挂起就要空等十分钟且不会自愈。
 */
function withStreamDefaults(models: Models): Models["streamSimple"] {
	return (model, context, options) =>
		models.streamSimple(model, context, {
			...options,
			timeoutMs: options?.timeoutMs ?? STREAM_TIMEOUT_MS,
			maxRetries: options?.maxRetries ?? STREAM_MAX_RETRIES,
		});
}

/**
 * 创建写作智能体。
 *
 * 两个角色共享工具定义的只读部分，但提示词与工具集完全分开：
 * 素材角色拿不到 write_chapter，写作角色拿不到 upsert_material。
 * 这是整个架构的核心约束 —— 工具边界即职责边界。
 *
 * 之所以是异步的：写作角色的提示词要带上本章旧稿与上一章的正文，
 * 而正文按章存在磁盘上（.txt），不在内存里 —— 建会话这一刻才按需取。
 */
export async function createNovelAgent(options: NovelAgentOptions): Promise<Agent> {
	const { store, projectId, model, models, config, sessionId, role } = options;
	const streamFn = withStreamDefaults(models);

	// 库作用域：没有工程也没有章节，projectId 在这一支是空的。
	// 提示词、工具集、状态快照三者都要换，不是只换工具 ——
	// 提示词里仍提「本章」会让模型去找根本不存在的章节。
	if (options.library) {
		return new Agent({
			initialState: {
				systemPrompt: buildLibrarySystemPrompt(options.library.list()),
				model,
				thinkingLevel: options.thinkingLevel ?? config.defaultThinkingLevel,
				tools: createLibraryTools({ library: options.library, ask: options.ask }),
			},
			streamFn,
			sessionId,
			// 与另外两个角色同理：工具会写数据，不能并行。
			toolExecution: "sequential",
			transformContext: async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
				const digest: AgentMessage = {
					role: "system",
					content: `<素材库状态更新>\n${buildLibraryDigest(options.library!)}\n</素材库状态更新>`,
					timestamp: Date.now(),
				};
				const head = messages[0]?.role === "system" ? [messages[0]] : [];
				const rest = messages.slice(head.length);
				const toolResultIndexes = rest
					.map((message, index) => (TOOL_ROLES.has(message.role) ? index : -1))
					.filter((index) => index >= 0);
				const excess = toolResultIndexes.length - MAX_TOOL_RESULTS;
				if (excess <= 0) return [...head, digest, ...rest];
				const drop = new Set(toolResultIndexes.slice(0, excess));
				return [...head, digest, ...rest.filter((_message, index) => !drop.has(index))];
			},
		});
	}

	const project = store.get(projectId);
	if (!project) throw new Error(`工程 ${projectId} 不存在`);

	const deps = { store, projectId, ask: options.ask };
	const systemPrompt =
		role === "material"
			? buildMaterialSystemPrompt(project)
			: buildWritingSystemPrompt(project, await writingContextOf(options, project));

	return new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: options.thinkingLevel ?? config.defaultThinkingLevel,
			tools: role === "material" ? createMaterialTools(deps) : createWritingTools(deps),
		},
		streamFn,
		sessionId,
		// 工具会写数据，并行执行可能丢失更新，因此统一串行。
		toolExecution: "sequential",
		transformContext: async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
			const latest = store.get(projectId);
			const digest: AgentMessage = {
				role: "system",
				content: `<工程状态更新>
${latest ? buildContextDigest(latest, { scope: role, chapterId: options.chapterId }) : "工程已删除"}
</工程状态更新>`,
				timestamp: Date.now(),
			};
			// 系统提示词在头部时保留它、快照插在其后；否则快照直接插到最前，
			// 不能无条件取 messages[0] —— 那会在首条不是 system 时把它重复一遍。
			const head = messages[0]?.role === "system" ? [messages[0]] : [];
			const rest = messages.slice(head.length);

			const toolResultIndexes = rest
				.map((message, index) => (TOOL_ROLES.has(message.role) ? index : -1))
				.filter((index) => index >= 0);
			const excess = toolResultIndexes.length - MAX_TOOL_RESULTS;
			if (excess <= 0) return [...head, digest, ...rest];

			const drop = new Set(toolResultIndexes.slice(0, excess));
			return [...head, digest, ...rest.filter((_message, index) => !drop.has(index))];
		},
	});
}

/**
 * 通用素材库的状态快照。
 *
 * 与工程快照同理：模型靠它知道库里现在有什么，不必反复调 list_materials。
 * 但只给「标题 + usage + 标签」这一行索引 —— 库可能攒了上百条，
 * 全文塞进来会把窗口占满，需要全文时让它自己按 id 取。
 */
function buildLibraryDigest(library: MaterialLibrary): string {
	const all = library.list();
	if (all.length === 0) return "通用素材库为空。";
	const byKind = new Map<string, number>();
	for (const entry of all) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
	const counts = [...byKind.entries()].map(([kind, n]) => kindLabel(kind) + " " + n).join("、");
	const index = all
		.map((entry) => "- [" + kindLabel(entry.kind) + "] " + entry.title + "（id: " + entry.id + "）" + (entry.usage ? " —— " + entry.usage : ""))
		.join("\n");
	return `共 ${all.length} 条（${counts}）：\n${index}`;
}

/**
 * 组装上下文：优先用调用方传入的，否则按 chapterId 从工程里现算。
 *
 * 现算这一支让常驻写作会话也能用（调试、连续改稿），
 * 一次性写作则由服务端预先算好，避免提示词与注入的快照不一致。
 *
 * 正文按章从磁盘取：工程骨架里只有元数据，字在 .txt 里。
 * 这里只取两章 —— 本章旧稿与上一章 —— 不是整本。
 */
async function writingContextOf(options: NovelAgentOptions, project: Project): Promise<WritingContext> {
	if (options.writing) return options.writing;
	const chapterId = options.chapterId;
	const index = chapterId ? project.outline.findIndex((c) => c.id === chapterId) : -1;
	const chapter = index >= 0 ? project.outline[index] : undefined;
	if (!chapter || !chapterId) {
		throw new Error(`章节 ${chapterId ?? "(未指定)"} 不存在，无法建立写作上下文`);
	}
	const previousChapter = index > 0 ? project.outline[index - 1] : undefined;
	const existingMeta = project.drafts[chapterId];
	const existing = existingMeta
		? await loadDraftShape(options.store, project.id, chapterId, existingMeta)
		: undefined;
	const previousMeta = previousChapter ? project.drafts[previousChapter.id] : undefined;
	const previous =
		previousChapter && previousMeta
			? await loadDraftShape(options.store, project.id, previousChapter.id, previousMeta)
			: undefined;
	return {
		chapter,
		materials: assembledMaterials(project, chapterId),
		// 没有调用方指定作业性质时，按有无旧稿推断：有旧稿就是重写。
		mode: existing ? "rewrite" : "create",
		// 现算的这一支就是常驻工作台会话：作业由作者当轮交代，提示词不预设。
		interactive: true,
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

/** 把磁盘上的正文组装成提示词与工具之间传的那种形状（正文 + 小结 + 版本）。 */
async function loadDraftShape(
	store: ProjectStore,
	projectId: string,
	chapterId: string,
	meta: ChapterMeta,
): Promise<ChapterDraft> {
	const body = await store.readDraftBody(projectId, chapterId);
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

/** 工程成绩。 */
export interface TurnUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export function summarizeUsage(usage: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): TurnUsage {
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
		...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
	};
}

export type { Project, ThinkingLevel };
