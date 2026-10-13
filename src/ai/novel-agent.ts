import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/env.ts";
import type { Project, ProjectStore } from "../store/project.ts";
import { buildContextDigest, buildSystemPrompt } from "./prompts.ts";
import { createNovelTools } from "./tools.ts";

export interface NovelAgentOptions {
	store: ProjectStore;
	projectId: string;
	model: Model<any>;
	models: Models;
	config: AppConfig;
	sessionId: string;
	thinkingLevel?: ThinkingLevel;
}

/** 当会话里的工具结果超过这个数量时，丢弃最旧的部分。 */
const MAX_TOOL_RESULTS = 24;

const TOOL_ROLES = new Set(["toolResult"]);

/**
 * 创建小说写作智能体。
 *
 * transformContext 在每次请求前做两件事：
 * 1. 注入当前工程快照，保证模型看到的是最新事实；
 * 2. 过长会话丢弃旧的工具结果，控制上下文窗口。
 */
export function createNovelAgent(options: NovelAgentOptions): Agent {
	const { store, projectId, model, models, config, sessionId } = options;
	const project = store.get(projectId);
	if (!project) throw new Error(`工程 ${projectId} 不存在`);

	return new Agent({
		initialState: {
			systemPrompt: buildSystemPrompt(project),
			model,
			thinkingLevel: options.thinkingLevel ?? config.defaultThinkingLevel,
			tools: createNovelTools({ store, projectId }),
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
${latest ? buildContextDigest(latest) : "工程已删除"}
</工程状态更新>`,
				timestamp: Date.now(),
			};
			// 系统提示词始终在头部，快照插在它之后。
			const rest = messages[0]?.role === "system" ? messages.slice(1) : messages;

			const toolResultIndexes = rest
				.map((message, index) => (TOOL_ROLES.has(message.role) ? index : -1))
				.filter((index) => index >= 0);
			const excess = toolResultIndexes.length - MAX_TOOL_RESULTS;
			if (excess <= 0) return [messages[0]!, digest, ...rest];

			const drop = new Set(toolResultIndexes.slice(0, excess));
			return [messages[0]!, digest, ...rest.filter((_message, index) => !drop.has(index))];
		},
	});
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
