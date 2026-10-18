import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/env.ts";
import { assembledMaterials, MATERIAL_KIND_LABELS, type MaterialKind, type Project, type ProjectStore } from "../store/project.ts";
import type { MaterialLibrary } from "../store/library.ts";
import {
	buildContextDigest,
	buildLibrarySystemPrompt,
	buildMaterialSystemPrompt,
	buildWritingSystemPrompt,
	type WritingContext,
} from "./prompts.ts";
import { createLibraryTools, createMaterialTools, createWritingTools } from "./tools.ts";

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
}

/** 当会话里的工具结果超过这个数量时，丢弃最旧的部分。 */
const MAX_TOOL_RESULTS = 24;

const TOOL_ROLES = new Set(["toolResult"]);

/**
 * 创建写作智能体。
 *
 * 两个角色共享工具定义的只读部分，但提示词与工具集完全分开：
 * 素材角色拿不到 write_chapter，写作角色拿不到 upsert_material。
 * 这是整个架构的核心约束 —— 工具边界即职责边界。
 */
export function createNovelAgent(options: NovelAgentOptions): Agent {
	const { store, projectId, model, models, config, sessionId, role } = options;

	// 库作用域：没有工程也没有章节，projectId 在这一支是空的。
	// 提示词、工具集、状态快照三者都要换，不是只换工具 ——
	// 提示词里仍提「本章」会让模型去找根本不存在的章节。
	if (options.library) {
		return new Agent({
			initialState: {
				systemPrompt: buildLibrarySystemPrompt(options.library.list()),
				model,
				thinkingLevel: options.thinkingLevel ?? config.defaultThinkingLevel,
				tools: createLibraryTools({ library: options.library }),
			},
			streamFn: models.streamSimple.bind(models),
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

	const deps = { store, projectId };
	const systemPrompt =
		role === "material"
			? buildMaterialSystemPrompt(project)
			: buildWritingSystemPrompt(project, writingContextOf(options, project));

	return new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: options.thinkingLevel ?? config.defaultThinkingLevel,
			tools: role === "material" ? createMaterialTools(deps) : createWritingTools(deps),
		},
		streamFn: models.streamSimple.bind(models),
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
	const counts = [...byKind.entries()].map(([kind, n]) => MATERIAL_KIND_LABELS[kind as MaterialKind] + " " + n).join("、");
	const index = all
		.map((entry) => "- [" + MATERIAL_KIND_LABELS[entry.kind] + "] " + entry.title + "（id: " + entry.id + "）" + (entry.usage ? " —— " + entry.usage : ""))
		.join("\n");
	return `共 ${all.length} 条（${counts}）：\n${index}`;
}

/**
 * 组装上下文：优先用调用方传入的，否则按 chapterId 从工程里现算。
 *
 * 现算这一支让常驻写作会话也能用（调试、连续改稿），
 * 一次性写作则由服务端预先算好，避免提示词与注入的快照不一致。
 */
function writingContextOf(options: NovelAgentOptions, project: Project): WritingContext {
	if (options.writing) return options.writing;
	const chapterId = options.chapterId;
	const index = chapterId ? project.outline.findIndex((c) => c.id === chapterId) : -1;
	const chapter = index >= 0 ? project.outline[index] : undefined;
	if (!chapter || !chapterId) {
		throw new Error(`章节 ${chapterId ?? "(未指定)"} 不存在，无法建立写作上下文`);
	}
	const previousChapter = index > 0 ? project.outline[index - 1] : undefined;
	const existing = project.drafts[chapterId];
	return {
		chapter,
		materials: assembledMaterials(project, chapterId),
		// 没有调用方指定作业性质时，按有无旧稿推断：有旧稿就是重写。
		mode: existing ? "rewrite" : "create",
		// 现算的这一支就是常驻工作台会话：作业由作者当轮交代，提示词不预设。
		interactive: true,
		...(previousChapter ? { previous: project.drafts[previousChapter.id] } : {}),
		...(existing ? { existing } : {}),
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
