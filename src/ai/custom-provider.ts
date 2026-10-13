import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel, ProviderStreams, ThinkingLevelMap } from "@earendil-works/pi-ai";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as googleGenerativeAi from "@earendil-works/pi-ai/api/google-generative-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
import type { ApiFormat, ModelConfig, ProviderConfig } from "../config/settings.ts";

/** 接口格式 → pi-ai 内置适配器。自建 provider 就是这张映射表。 */
export const API_STREAMS: Record<ApiFormat, ProviderStreams> = {
	"openai-completions": { stream: openaiCompletions.stream, streamSimple: openaiCompletions.streamSimple },
	"openai-responses": { stream: openaiResponses.stream, streamSimple: openaiResponses.streamSimple },
	"anthropic-messages": { stream: anthropicMessages.stream, streamSimple: anthropicMessages.streamSimple },
	"google-generative-ai": { stream: googleGenerativeAi.stream, streamSimple: googleGenerativeAi.streamSimple },
};

const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 把用户配置的思考档位翻译成 pi-ai 的 thinkingLevelMap。
 *
 * 关键决策："off" 不写入映射。若把它映射成字符串 "off"，适配器会当作
 * effort 发给上游，而 Anthropic 的 effort 枚举里没有 "off"，会直接报错。
 * 缺省时 pi-ai 使用厂商默认值，对 "off" 就是不开启思考。
 */
export function buildThinkingLevelMap(config: ModelConfig): ThinkingLevelMap {
	const supported = new Set<ModelThinkingLevel>(config.reasoning ? config.thinkingLevels : []);
	const map: Record<string, string | null> = {};
	for (const level of MODEL_THINKING_LEVELS) {
		if (level === "off") continue;
		map[level] = supported.has(level) ? level : null;
	}
	return map as ThinkingLevelMap;
}

/** 把配置转成 pi-ai 的 Model 对象。 */
export function toModel(provider: ProviderConfig, model: ModelConfig): Model<any> {
	const base = {
		id: model.id,
		name: model.name,
		api: provider.api ?? "openai-completions",
		provider: provider.id,
		baseUrl: provider.baseUrl ?? "",
		input: ["text"],
		cost: { ...model.cost },
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	if (!model.reasoning) return base as Model<any>;
	return { ...base, thinkingLevelMap: buildThinkingLevelMap(model) } as Model<any>;
}

/**
 * 构建一个自定义 provider。
 *
 * 鉴权走 envApiKeyAuth，但不给它任何环境变量——key 只能来自应用的
 * CredentialStore。这样表面保存的 key 优先，而进程环境变量不会意外注入自定义 provider。
 */
export function buildCustomProvider(config: ProviderConfig): Provider {
	if (!config.baseUrl || !config.api) {
		throw new Error("自定义 provider 缺少 baseUrl 或接口格式");
	}
	return createProvider({
		id: config.id,
		name: config.label,
		baseUrl: config.baseUrl.replace(/\/+$/, ""),
		auth: {
			apiKey: {
				name: `${config.label} API key`,
				resolve: async ({ credential }) => {
					if (credential?.type === "api_key" && credential.key) {
						return { auth: { apiKey: credential.key }, source: "应用保存的 key" };
					}
					// 自建服务不校验 key。返回一个占位串是让 Models 判定“已配置”的唯一方式：
					// 部分服务会忽略 Authorization 头，部分会直接拒绝——设置页对此有明确提示。
					if (config.noAuthRequired) {
						return { auth: { apiKey: "not-required" }, source: "无需鉴权" };
					}
					return undefined;
				},
			},
		},
		models: config.models.map((model) => toModel(config, model)),
		api: API_STREAMS[config.api],
	});
}

/** 为会话生成的模型快照，避免会话持有旧的 Model 对象。 */
export function modelsFor(config: ProviderConfig): Model<any>[] {
	return config.models.map((model) => toModel(config, model));
}
