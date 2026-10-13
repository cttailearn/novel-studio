import { createModels, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { FileCredentialStore } from "../config/credential-store.ts";
import type { SettingsStore } from "../config/settings-store.ts";
import type { ModelThinkingLevel, ProviderConfig, Settings } from "../config/settings.ts";
import { buildCustomProvider } from "./custom-provider.ts";

export interface BuiltinProviderSpec {
	id: string;
	label: string;
	/** pi-ai 内置 provider id，也是我们的 provider id。 */
	builtinId: string;
	envVars: readonly string[];
	create: () => Provider;
}

/** 可作为“默认供应商”的内置 provider。在设置页中可动态启停。 */
export const BUILTIN_PROVIDERS: readonly BuiltinProviderSpec[] = [
	{ id: "deepseek", label: "DeepSeek", builtinId: "deepseek", envVars: ["DEEPSEEK_API_KEY"], create: deepseekProvider },
	{ id: "moonshotai-cn", label: "Moonshot 国内", builtinId: "moonshotai-cn", envVars: ["MOONSHOT_API_KEY"], create: moonshotaiCnProvider },
	{ id: "zai", label: "Z.ai (GLM)", builtinId: "zai", envVars: ["ZAI_API_KEY"], create: zaiProvider },
	{ id: "openrouter", label: "OpenRouter", builtinId: "openrouter", envVars: ["OPENROUTER_API_KEY"], create: openrouterProvider },
	{ id: "anthropic", label: "Anthropic", builtinId: "anthropic", envVars: ["ANTHROPIC_API_KEY"], create: anthropicProvider },
	{ id: "openai", label: "OpenAI", builtinId: "openai", envVars: ["OPENAI_API_KEY"], create: openaiProvider },
	{ id: "google", label: "Google Gemini", builtinId: "google", envVars: ["GEMINI_API_KEY"], create: googleProvider },
	{ id: "kimi-coding", label: "Kimi Coding", builtinId: "kimi-coding", envVars: ["KIMI_API_KEY"], create: kimiCodingProvider },
	{ id: "opencode", label: "OpenCode Zen", builtinId: "opencode", envVars: ["OPENCODE_API_KEY"], create: opencodeProvider },
	{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", builtinId: "vercel-ai-gateway", envVars: ["AI_GATEWAY_API_KEY"], create: vercelAIGatewayProvider },
	{ id: "groq", label: "Groq", builtinId: "groq", envVars: ["GROQ_API_KEY"], create: groqProvider },
	{ id: "mistral", label: "Mistral", builtinId: "mistral", envVars: ["MISTRAL_API_KEY"], create: mistralProvider },
	{ id: "xai", label: "xAI", builtinId: "xai", envVars: ["XAI_API_KEY"], create: xaiProvider },
	{ id: "fireworks", label: "Fireworks", builtinId: "fireworks", envVars: ["FIREWORKS_API_KEY"], create: fireworksProvider },
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
	const direct = ref.includes("/") ? models.getModel(...(ref.split("/") as [string, string])) : undefined;
	if (direct) return direct;

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

/** 设置存储已就绪但尚未初始化运行时的首次配置。 */
export function ensureDefaultSettings(settings: Settings, envDefaultModel: string): Settings {
	if (settings.providers.length > 0) return settings;
	const providers: ProviderConfig[] = BUILTIN_PROVIDERS.map((spec) => ({
		id: spec.id,
		label: spec.label,
		kind: "builtin" as const,
		builtinId: spec.builtinId,
		models: [],
		enabled: true,
		updatedAt: 0,
	}));
	return { ...settings, providers, defaultModel: settings.defaultModel || envDefaultModel };
}
