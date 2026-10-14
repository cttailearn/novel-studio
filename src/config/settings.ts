import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type { ModelThinkingLevel };

/** 白名单制的接口格式。选项尽量少且能覆盖自建服务的常见场景。 */
export const API_FORMATS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

export const API_FORMAT_LABELS: Record<ApiFormat, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
};

export const API_FORMAT_HINTS: Record<ApiFormat, string> = {
	"openai-completions": "支持 /v1/chat/completions 的服务，如 vLLM、Ollama 兼容层、大部分中国厂商",
	"openai-responses": "支持 /v1/responses 的服务",
	"anthropic-messages": "Anthropic 原生 /v1/messages 协议",
	"google-generative-ai": "Google 原生 /v1beta/models，模型名会自动去掉 models/ 前缀",
};

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const THINKING_LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
	off: "关",
	minimal: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最高",
};

/** 每百万 token 的费用，用于成本统计。 */
export interface CostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelConfig {
	id: string;
	name: string;
	/** 输入上下文窗口（token）。 */
	contextWindow: number;
	/** 单次回复的输出上限（token）。 */
	maxTokens: number;
	/** 是否支持思考。 */
	reasoning: boolean;
	/** 支持的思考档位，导出到 pi-ai 的 thinkingLevelMap。 */
	thinkingLevels: ModelThinkingLevel[];
	cost: CostRates;
}

export interface ProviderConfig {
	id: string;
	label: string;
	kind: "builtin" | "custom";
	/** kind = builtin 时，指向 pi-ai 内置 provider id。 */
	builtinId?: string;
	/** kind = custom 时必填。 */
	baseUrl?: string;
	api?: ApiFormat;
	/** 自建或本地服务不需要鉴权时置 true，会跳过 Key 校验。 */
	noAuthRequired?: boolean;
	models: ModelConfig[];
	enabled: boolean;
	updatedAt: number;
}

export interface Settings {
	version: 1;
	/** "providerId/modelId"。 */
	defaultModel: string;
	defaultThinkingLevel: ModelThinkingLevel;
	providers: ProviderConfig[];
}

export const DEFAULT_COST: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 新模型的起始值。
 *
 * 这只是"还没从上游取到真实限制"时的占位，不是测出来的数字。
 * 上游报了 inputTokenLimit / outputTokenLimit 就用上游的；
 * 报不出来的（如 OpenAI 兼容的 /models 只回 id）就落在这里，需要人工核对。
 */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576; // 1M
export const DEFAULT_MAX_TOKENS = 131_072; // 128K

export function emptyModel(id: string, name = id): ModelConfig {
	return {
		id,
		name,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		reasoning: false,
		thinkingLevels: ["off"],
		cost: { ...DEFAULT_COST },
	};
}

export function emptySettings(): Settings {
	return { version: 1, defaultModel: "", defaultThinkingLevel: "off", providers: [] };
}

/** 归一化保证读回的配置始终符合 schema，避免手改文件后崩盘。 */
export function normalizeSettings(raw: unknown): Settings {
	const base = emptySettings();
	if (!raw || typeof raw !== "object") return base;
	const input = raw as Partial<Settings>;

	const providers: ProviderConfig[] = Array.isArray(input.providers)
		? input.providers
				.filter((provider): provider is ProviderConfig => Boolean(provider) && typeof provider === "object")
				.map((provider) => {
					const kind: "builtin" | "custom" = provider.kind === "custom" ? "custom" : "builtin";
					return {
						id: String(provider.id ?? "").trim(),
						label: String(provider.label ?? provider.id ?? "").trim(),
						kind,
						...(kind === "builtin" && provider.builtinId ? { builtinId: String(provider.builtinId) } : {}),
						...(kind === "custom" && provider.baseUrl ? { baseUrl: String(provider.baseUrl).trim() } : {}),
						...(kind === "custom" && API_FORMATS.includes(provider.api as ApiFormat)
							? { api: provider.api as ApiFormat }
							: {}),
						...(kind === "custom" && provider.noAuthRequired === true ? { noAuthRequired: true } : {}),
						models: Array.isArray(provider.models) ? provider.models.filter(Boolean).map(normalizeModel) : [],
						enabled: provider.enabled !== false,
						updatedAt: typeof provider.updatedAt === "number" ? provider.updatedAt : 0,
					};
				})
				.filter((provider) => provider.id !== "")
		: [];

	return {
		version: 1,
		defaultModel: typeof input.defaultModel === "string" ? input.defaultModel : "",
		defaultThinkingLevel: THINKING_LEVELS.includes(input.defaultThinkingLevel as ModelThinkingLevel)
			? (input.defaultThinkingLevel as ModelThinkingLevel)
			: "off",
		providers,
	};
}

function normalizeModel(raw: ModelConfig): ModelConfig {
	const id = String(raw?.id ?? "").trim();
	return {
		id,
		name: String(raw?.name ?? id).trim() || id,
		contextWindow: positiveInt(raw?.contextWindow, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveInt(raw?.maxTokens, DEFAULT_MAX_TOKENS),
		reasoning: raw?.reasoning === true,
		thinkingLevels: Array.isArray(raw?.thinkingLevels)
			? THINKING_LEVELS.filter((level) => raw.thinkingLevels.includes(level))
			: ["off"],
		cost: {
			input: numberOr(raw?.cost?.input, 0),
			output: numberOr(raw?.cost?.output, 0),
			cacheRead: numberOr(raw?.cost?.cacheRead, 0),
			cacheWrite: numberOr(raw?.cost?.cacheWrite, 0),
		},
	};
}

function positiveInt(value: unknown, fallback: number): number {
	const parsed = Math.floor(Number(value));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberOr(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
