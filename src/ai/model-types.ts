/**
 * 模型与厂商的对外形状（纯类型）。
 *
 * 单独成文件是为了让浏览器那侧能引这些类型，而不必把
 * `src/ai/models.ts` 整个拖进来——那里面 static import 了 42 个 pi-ai 内置
 * provider，连带 openai / @anthropic-ai/sdk / @google/genai / @aws-sdk 四个 SDK，
 * 浏览器里一个都用不上。
 *
 * 类型导入会被完全擦除，所以引本文件不会产生任何运行时代码。
 */
import type { CostRates, ModelThinkingLevel } from "../config/settings.ts";

/** 一个可用模型的摘要，列表页与设置页都用它。 */
export interface ModelSummary {
	/** "providerId/modelId"，唯一键。 */
	id: string;
	provider: string;
	providerLabel: string;
	providerKind: "builtin" | "custom";
	modelId: string;
	name: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinkingLevels: ModelThinkingLevel[];
	/** 上下文窗口与输出上限还是占位值，说明这个模型未经人工核对。 */
	placeholder: boolean;
	/** 每百万 token 的价格，缺失时为 0。 */
	cost?: CostRates;
}

/** 密钥来自哪儿。 */
export type ProviderAuthSource = "app" | "env" | "none";

/** 设置页里一个厂商的运行状态。 */
export interface ProviderStatus {
	id: string;
	label: string;
	kind: "builtin" | "custom";
	/** 内置供应商的展示分组。 */
	group?: string;
	enabled: boolean;
	baseUrl?: string;
	api?: string;
	apiFormatKnown: boolean;
	envVars: string[];
	authSource: ProviderAuthSource;
	/** 已脱显的 key，不是真实密钥。 */
	maskedKey: string;
	/** 运行时注册的模型数。自定义 provider 只有配置过的模型。 */
	modelCount: number;
	configuredModelCount: number;
	registered: boolean;
	error?: string;
}
