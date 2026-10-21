import { createModels, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { antLingProvider } from "@earendil-works/pi-ai/providers/ant-ling";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { basetenProvider } from "@earendil-works/pi-ai/providers/baseten";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { huggingfaceProvider } from "@earendil-works/pi-ai/providers/huggingface";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { qwenTokenPlanProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan";
import { qwenTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn";
import { qwenTokenPlanIndividualProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { xiaomiProvider } from "@earendil-works/pi-ai/providers/xiaomi";
import { xiaomiTokenPlanAmsProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-ams";
import { xiaomiTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn";
import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { FileCredentialStore } from "../config/credential-store.ts";
import type { SettingsStore } from "../config/settings-store.ts";
import type { ModelThinkingLevel, ProviderConfig, Settings } from "../config/settings.ts";
import { isPlaceholderModel, type CostRates } from "../config/settings.ts";
import { buildCustomProvider } from "./custom-provider.ts";

export interface BuiltinProviderSpec {
	id: string;
	label: string;
	/** pi-ai 内置 provider id，也是我们的 provider id。 */
	builtinId: string;
	envVars: readonly string[];
	/** 设置页展示分组。 */
	group: BuiltinGroup;
	create: () => Provider;
}

/**
 * 设置页的展示分组。
 *
 * 单独定义而非内联在数组里，是为了让新增 provider 时"忘记归类"变成一个会被
 * 测试抓到的问题（见 scripts/config.ts 的分组完整性断言）。
 */
const GROUP_DOMESTIC = new Set([
	"deepseek", "moonshotai-cn", "moonshotai", "kimi-coding", "zai", "zai-coding-cn",
	"minimax-cn", "minimax", "qwen-token-plan-cn", "qwen-token-plan", "qwen-token-plan-individual",
	"xiaomi-token-plan-cn", "xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "ant-ling",
]);

const GROUP_CLOUD = new Set([
	"azure", "amazon-bedrock", "google-vertex", "cloudflare-ai-gateway", "cloudflare-workers-ai",
	"opencode", "opencode-go",
]);

export type BuiltinGroup = "国际通用" | "国内厂商" | "云平台与推理";

/** 未落入上面两组的归为国际通用。 */
export function builtinGroup(id: string): BuiltinGroup {
	if (GROUP_DOMESTIC.has(id)) return "国内厂商";
	if (GROUP_CLOUD.has(id)) return "云平台与推理";
	return "国际通用";
}

/**
 * 可作为"默认供应商"的全部内置 provider。
 *
 * 覆盖 pi-ai 除 faux（测试用）与 openai-codex（仅 OAuth）之外的所有厂商，
 * 共 41 个。新增 pi-ai 版本带来的厂商时，在这里补一行即可。
 *
 * envVars 只用于界面提示与"是否已配置"判定，实际鉴权仍由 pi-ai 的
 * CredentialStore + 环境变量回落机制完成。
 */
export const BUILTIN_PROVIDERS: readonly BuiltinProviderSpec[] = [
	// ---- 国际通用 ----
	{ id: "anthropic", label: "Anthropic", builtinId: "anthropic", envVars: ["ANTHROPIC_API_KEY"], group: builtinGroup("anthropic"), create: anthropicProvider },
	{ id: "openai", label: "OpenAI", builtinId: "openai", envVars: ["OPENAI_API_KEY"], group: builtinGroup("openai"), create: openaiProvider },
	{ id: "google", label: "Google Gemini", builtinId: "google", envVars: ["GEMINI_API_KEY"], group: builtinGroup("google"), create: googleProvider },
	{ id: "mistral", label: "Mistral", builtinId: "mistral", envVars: ["MISTRAL_API_KEY"], group: builtinGroup("mistral"), create: mistralProvider },
	{ id: "xai", label: "xAI", builtinId: "xai", envVars: ["XAI_API_KEY"], group: builtinGroup("xai"), create: xaiProvider },
	{ id: "groq", label: "Groq", builtinId: "groq", envVars: ["GROQ_API_KEY"], group: builtinGroup("groq"), create: groqProvider },
	{ id: "cerebras", label: "Cerebras", builtinId: "cerebras", envVars: ["CEREBRAS_API_KEY"], group: builtinGroup("cerebras"), create: cerebrasProvider },
	{ id: "together", label: "Together AI", builtinId: "together", envVars: ["TOGETHER_API_KEY"], group: builtinGroup("together"), create: togetherProvider },
	{ id: "fireworks", label: "Fireworks", builtinId: "fireworks", envVars: ["FIREWORKS_API_KEY"], group: builtinGroup("fireworks"), create: fireworksProvider },
	{ id: "nvidia", label: "NVIDIA NIM", builtinId: "nvidia", envVars: ["NVIDIA_API_KEY"], group: builtinGroup("nvidia"), create: nvidiaProvider },
	{ id: "baseten", label: "Baseten", builtinId: "baseten", envVars: ["BASETEN_API_KEY"], group: builtinGroup("baseten"), create: basetenProvider },
	{ id: "huggingface", label: "Hugging Face", builtinId: "huggingface", envVars: ["HF_TOKEN"], group: builtinGroup("huggingface"), create: huggingfaceProvider },
	{ id: "openrouter", label: "OpenRouter", builtinId: "openrouter", envVars: ["OPENROUTER_API_KEY"], group: builtinGroup("openrouter"), create: openrouterProvider },
	{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", builtinId: "vercel-ai-gateway", envVars: ["AI_GATEWAY_API_KEY"], group: builtinGroup("vercel-ai-gateway"), create: vercelAIGatewayProvider },
	{ id: "typesafe", label: "TypeSafe", builtinId: "typesafe", envVars: ["TYPESAFE_API_KEY"], group: builtinGroup("typesafe"), create: typesafeProvider },
	{ id: "radius", label: "Radius", builtinId: "radius", envVars: ["RADIUS_API_KEY"], group: builtinGroup("radius"), create: radiusProvider },
	{ id: "github-copilot", label: "GitHub Copilot", builtinId: "github-copilot", envVars: ["COPILOT_GITHUB_TOKEN"], group: builtinGroup("github-copilot"), create: githubCopilotProvider },

	// ---- 国内厂商 ----
	{ id: "deepseek", label: "DeepSeek", builtinId: "deepseek", envVars: ["DEEPSEEK_API_KEY"], group: builtinGroup("deepseek"), create: deepseekProvider },
	{ id: "moonshotai-cn", label: "Moonshot 国内（Kimi）", builtinId: "moonshotai-cn", envVars: ["MOONSHOT_API_KEY"], group: builtinGroup("moonshotai-cn"), create: moonshotaiCnProvider },
	{ id: "moonshotai", label: "Moonshot 国际", builtinId: "moonshotai", envVars: ["MOONSHOT_API_KEY"], group: builtinGroup("moonshotai"), create: moonshotaiProvider },
	{ id: "kimi-coding", label: "Kimi Coding", builtinId: "kimi-coding", envVars: ["KIMI_API_KEY"], group: builtinGroup("kimi-coding"), create: kimiCodingProvider },
	{ id: "zai", label: "Z.ai（GLM）", builtinId: "zai", envVars: ["ZAI_API_KEY"], group: builtinGroup("zai"), create: zaiProvider },
	{ id: "zai-coding-cn", label: "Z.ai Coding 国内", builtinId: "zai-coding-cn", envVars: ["ZAI_CODING_CN_API_KEY"], group: builtinGroup("zai-coding-cn"), create: zaiCodingCnProvider },
	{ id: "minimax-cn", label: "MiniMax 国内", builtinId: "minimax-cn", envVars: ["MINIMAX_CN_API_KEY"], group: builtinGroup("minimax-cn"), create: minimaxCnProvider },
	{ id: "minimax", label: "MiniMax 国际", builtinId: "minimax", envVars: ["MINIMAX_API_KEY"], group: builtinGroup("minimax"), create: minimaxProvider },
	{ id: "qwen-token-plan-cn", label: "Qwen Token Plan 国内", builtinId: "qwen-token-plan-cn", envVars: ["QWEN_TOKEN_PLAN_CN_API_KEY"], group: builtinGroup("qwen-token-plan-cn"), create: qwenTokenPlanCnProvider },
	{ id: "qwen-token-plan", label: "Qwen Token Plan", builtinId: "qwen-token-plan", envVars: ["QWEN_TOKEN_PLAN_API_KEY"], group: builtinGroup("qwen-token-plan"), create: qwenTokenPlanProvider },
	{ id: "qwen-token-plan-individual", label: "Qwen Token Plan 个人版", builtinId: "qwen-token-plan-individual", envVars: ["QWEN_TOKEN_PLAN_API_KEY"], group: builtinGroup("qwen-token-plan-individual"), create: qwenTokenPlanIndividualProvider },
	{ id: "xiaomi-token-plan-cn", label: "小米 Token Plan 国内", builtinId: "xiaomi-token-plan-cn", envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], group: builtinGroup("xiaomi-token-plan-cn"), create: xiaomiTokenPlanCnProvider },
	{ id: "xiaomi", label: "小米 MiMo", builtinId: "xiaomi", envVars: ["XIAOMI_API_KEY"], group: builtinGroup("xiaomi"), create: xiaomiProvider },
	{ id: "xiaomi-token-plan-sgp", label: "小米 Token Plan 新加坡", builtinId: "xiaomi-token-plan-sgp", envVars: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"], group: builtinGroup("xiaomi-token-plan-sgp"), create: xiaomiTokenPlanSgpProvider },
	{ id: "xiaomi-token-plan-ams", label: "小米 Token Plan 国际", builtinId: "xiaomi-token-plan-ams", envVars: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], group: builtinGroup("xiaomi-token-plan-ams"), create: xiaomiTokenPlanAmsProvider },
	{ id: "ant-ling", label: "蚂蚁灵光", builtinId: "ant-ling", envVars: ["ANT_LING_API_KEY"], group: builtinGroup("ant-ling"), create: antLingProvider },
	{ id: "meta", label: "Meta", builtinId: "meta", envVars: ["META_API_KEY"], group: builtinGroup("meta"), create: metaProvider },

	// ---- 云平台与推理服务 ----
	{ id: "azure", label: "Azure OpenAI", builtinId: "azure", envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"], group: builtinGroup("azure"), create: azureProvider },
	{ id: "amazon-bedrock", label: "Amazon Bedrock", builtinId: "amazon-bedrock", envVars: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_PROFILE"], group: builtinGroup("amazon-bedrock"), create: amazonBedrockProvider },
	{ id: "google-vertex", label: "Google Vertex AI", builtinId: "google-vertex", envVars: ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"], group: builtinGroup("google-vertex"), create: googleVertexProvider },
	{ id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", builtinId: "cloudflare-ai-gateway", envVars: ["CLOUDFLARE_API_KEY"], group: builtinGroup("cloudflare-ai-gateway"), create: cloudflareAIGatewayProvider },
	{ id: "cloudflare-workers-ai", label: "Cloudflare Workers AI", builtinId: "cloudflare-workers-ai", envVars: ["CLOUDFLARE_API_KEY"], group: builtinGroup("cloudflare-workers-ai"), create: cloudflareWorkersAIProvider },
	{ id: "opencode", label: "OpenCode Zen", builtinId: "opencode", envVars: ["OPENCODE_API_KEY"], group: builtinGroup("opencode"), create: opencodeProvider },
	{ id: "opencode-go", label: "OpenCode Go", builtinId: "opencode-go", envVars: ["OPENCODE_API_KEY"], group: builtinGroup("opencode-go"), create: opencodeGoProvider },
];

interface ModelRuntime {
	models: MutableModels;
	settings: SettingsStore;
	credentials: FileCredentialStore;
	/** 注册失败的 provider，设置页以允许看到原因而不是一个空列表。 */
	failures: Map<string, string>;
}

let runtime: ModelRuntime | undefined;

/** 首次启动时调用。设置变更后调用 rebuildModels()。 */
export function initModelRuntime(settings: SettingsStore, credentials: FileCredentialStore): ModelRuntime {
	runtime = build(settings, credentials);
	return runtime;
}

function getRuntime(): ModelRuntime {
	if (!runtime) throw new Error("模型运行时尚未初始化");
	return runtime;
}

function build(settings: SettingsStore, credentials: FileCredentialStore): ModelRuntime {
	const models = createModels({ credentials });
	const failures = new Map<string, string>();

	for (const config of settings.get().providers) {
		if (!config.enabled) continue;
		try {
			models.setProvider(config.kind === "builtin" ? builtinProviderOf(config) : buildCustomProvider(config));
		} catch (error) {
			failures.set(config.id, error instanceof Error ? error.message : String(error));
		}
	}

	return { models, settings, credentials, failures };
}

function builtinProviderOf(config: ProviderConfig): Provider {
	const spec = BUILTIN_PROVIDERS.find((item) => item.builtinId === config.builtinId);
	if (!spec) throw new Error(`未知的内置 provider：${config.builtinId ?? "未指定"}`);
	return spec.create();
}

/** 设置改动后重建注册表。会话持有的 Model 对象需要重建。 */
export function rebuildModels(): void {
	if (!runtime) return;
	const failures = new Map<string, string>();
	const models = createModels({ credentials: runtime.credentials });
	for (const config of runtime.settings.get().providers) {
		if (!config.enabled) continue;
		try {
			models.setProvider(config.kind === "builtin" ? builtinProviderOf(config) : buildCustomProvider(config));
		} catch (error) {
			failures.set(config.id, error instanceof Error ? error.message : String(error));
		}
	}
	runtime = { ...runtime, models, failures };
}

export function getModels(): MutableModels {
	return getRuntime().models;
}

export function getSettingsStore(): SettingsStore {
	return getRuntime().settings;
}

export function getCredentialStore(): FileCredentialStore {
	return getRuntime().credentials;
}

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

function summarize(model: Model<Api>, settings: Settings): ModelSummary {
	const config = settings.providers.find((provider) => provider.id === model.provider);
	return {
		id: `${model.provider}/${model.id}`,
		provider: model.provider,
		providerLabel: config?.label ?? model.provider,
		providerKind: config?.kind ?? "builtin",
		modelId: model.id,
		name: model.name,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		thinkingLevels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
		placeholder: isPlaceholderModel(model),
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cacheRead ?? 0,
			cacheWrite: model.cost?.cacheWrite ?? 0,
		},
	};
}

/** 已配置鉴权的厂商所有对话模型。 */
export async function listAvailableModels(): Promise<ModelSummary[]> {
	const { models, settings } = getRuntime();
	const available = await models.getAvailable();
	const current = settings.get();
	return available
		.map((model) => summarize(model, current))
		.sort((a, b) => a.providerLabel.localeCompare(b.providerLabel, "zh-CN") || a.name.localeCompare(b.name, "zh-CN"));
}

export type ProviderAuthSource = "app" | "env" | "none";

export interface ProviderStatus {
	id: string;
	label: string;
	kind: "builtin" | "custom";
	/** 内置供应商的展示分组。 */
	group?: BuiltinGroup;
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

export async function listProviderStatus(): Promise<ProviderStatus[]> {
	const { models, settings, credentials, failures } = getRuntime();
	const out: ProviderStatus[] = [];

	for (const config of settings.get().providers) {
		const spec = config.kind === "builtin" ? BUILTIN_PROVIDERS.find((item) => item.builtinId === config.builtinId) : undefined;
		const stored = credentials.hasKey(config.id);
		const fromEnv = spec?.envVars.some((name) => Boolean(process.env[name])) ?? false;
		const registered = models.getProvider(config.id) !== undefined;

		out.push({
			id: config.id,
			label: config.label,
			kind: config.kind,
			...(config.kind === "builtin" ? { group: builtinGroup(config.id) } : {}),
			enabled: config.enabled,
			...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
			...(config.api ? { api: config.api, apiFormatKnown: true } : { apiFormatKnown: false }),
			envVars: [...(spec?.envVars ?? [])],
			authSource: stored ? "app" : fromEnv ? "env" : "none",
			maskedKey: credentials.maskedKey(config.id),
			modelCount: models.getProvider(config.id)?.getModels().length ?? 0,
			configuredModelCount: config.models.length,
			registered,
			...(failures.get(config.id) ? { error: failures.get(config.id) } : {}),
		});
	}
	return out;
}

export class ModelResolutionError extends Error {
	readonly candidates: string[];

	constructor(message: string, candidates: string[] = []) {
		super(message);
		this.name = "ModelResolutionError";
		this.candidates = candidates;
	}
}

/**
 * 解析模型引用。
 * - "provider/modelId"：精确匹配
 * - "modelId" 或 "modelId@provider"：在已配置的厂商中搜索
 */
export async function resolveModel(reference: string): Promise<Model<Api>> {
	const ref = reference.trim();
	if (!ref) throw new ModelResolutionError("未指定模型");

	const { models } = getRuntime();
	// 只按第一个斜杠切分：模型 id 本身可以含斜杠（OpenRouter 的 "vendor/model"），
	// 早先的 ref.split("/") 会把三段的 id 拆成 provider=vendor、id=model 并静默失配，
	// 最后落到模糊匹配，命中一个"看起来差不多"的模型。
	if (ref.includes("/")) {
		const cut = ref.indexOf("/");
		const providerId = ref.slice(0, cut);
		const modelId = ref.slice(cut + 1);
		const hit = models.getModel(providerId, modelId);
		if (hit) return hit;
	}

	const available = await models.getAvailable();
	const normalized = ref.toLowerCase();

	const byId = available.find((model) => model.id.toLowerCase() === normalized);
	if (byId) return byId;

	const byLabel = available.find((model) => model.name.toLowerCase() === normalized);
	if (byLabel) return byLabel;

	const contains = available.filter(
		(model) => model.id.toLowerCase().includes(normalized) || model.name.toLowerCase().includes(normalized),
	);
	if (contains.length === 1 && contains[0]) return contains[0];
	if (contains.length > 1) {
		throw new ModelResolutionError(
			`模型 "${ref}" 匹配到多个结果，请指定 provider`,
			contains.map((model) => `${model.provider}/${model.id}`),
		);
	}

	throw new ModelResolutionError(
		available.length === 0
			? "没有可用模型，请先在设置中配置供应商的 API Key"
			: `找不到模型 "${ref}"`,
		available.map((model) => `${model.provider}/${model.id}`),
	);
}

/** 首次启动：把所有内置供应商预置进设置。 */
export function ensureDefaultSettings(settings: Settings, envDefaultModel: string): Settings {
	if (settings.providers.length > 0) return settings;
	return { ...settings, providers: defaultProviderConfigs(), defaultModel: settings.defaultModel || envDefaultModel };
}

function defaultProviderConfigs(): ProviderConfig[] {
	return BUILTIN_PROVIDERS.map((spec) => ({
		id: spec.id,
		label: spec.label,
		kind: "builtin" as const,
		builtinId: spec.builtinId,
		models: [],
		enabled: true,
		updatedAt: 0,
	}));
}

/**
 * 把新增的内置供应商补进已有配置。
 *
 * 升级 pi-ai 或扩充 BUILTIN_PROVIDERS 后，老的 settings.json 里只存了旧的那批，
 * 这里做增量补齐：只追加缺失的，绝不覆盖用户已有的 label、key、模型参数与启停状态。
 */
export function syncBuiltinProviders(settings: Settings, envDefaultModel: string): Settings {
	const base = ensureDefaultSettings(settings, envDefaultModel);
	const known = new Set(base.providers.map((provider) => provider.id));
	const missing = BUILTIN_PROVIDERS.filter((spec) => !known.has(spec.id)).map((spec) => ({
		id: spec.id,
		label: spec.label,
		kind: "builtin" as const,
		builtinId: spec.builtinId,
		models: [],
		enabled: true,
		updatedAt: 0,
	}));
	if (missing.length === 0) return base;
	return { ...base, providers: [...base.providers, ...missing] };
}