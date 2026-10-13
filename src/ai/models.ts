import { createModels, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
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

export interface ProviderSpec {
	id: string;
	label: string;
	/** 该厂商会读取的环境变量，用于前端提示。 */
	envVars: readonly string[];
	create: () => Provider;
}

/**
 * 注册的厂商。顺序无意义，前端按 label 排序展示。
 * 只注册常见的，需要其他厂商时在此补一行即可。
 */
export const PROVIDER_SPECS: readonly ProviderSpec[] = [
	{ id: "deepseek", label: "DeepSeek", envVars: ["DEEPSEEK_API_KEY"], create: deepseekProvider },
	{ id: "moonshotai-cn", label: "Moonshot 国内", envVars: ["MOONSHOT_API_KEY"], create: moonshotaiCnProvider },
	{ id: "zai", label: "Z.ai (GLM)", envVars: ["ZAI_API_KEY"], create: zaiProvider },
	{ id: "openrouter", label: "OpenRouter", envVars: ["OPENROUTER_API_KEY"], create: openrouterProvider },
	{ id: "anthropic", label: "Anthropic", envVars: ["ANTHROPIC_API_KEY"], create: anthropicProvider },
	{ id: "openai", label: "OpenAI", envVars: ["OPENAI_API_KEY"], create: openaiProvider },
	{ id: "google", label: "Google Gemini", envVars: ["GEMINI_API_KEY"], create: googleProvider },
	{ id: "kimi-coding", label: "Kimi Coding", envVars: ["KIMI_API_KEY"], create: kimiCodingProvider },
	{ id: "opencode", label: "OpenCode Zen", envVars: ["OPENCODE_API_KEY"], create: opencodeProvider },
	{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", envVars: ["AI_GATEWAY_API_KEY"], create: vercelAIGatewayProvider },
	{ id: "groq", label: "Groq", envVars: ["GROQ_API_KEY"], create: groqProvider },
	{ id: "mistral", label: "Mistral", envVars: ["MISTRAL_API_KEY"], create: mistralProvider },
	{ id: "xai", label: "xAI", envVars: ["XAI_API_KEY"], create: xaiProvider },
	{ id: "fireworks", label: "Fireworks", envVars: ["FIREWORKS_API_KEY"], create: fireworksProvider },
];

let instance: MutableModels | undefined;

/** 进程内单例 Models 集合。首次调用时注册全部 provider。 */
export function getModels(): MutableModels {
	if (instance) return instance;
	const models = createModels();
	for (const spec of PROVIDER_SPECS) {
		try {
			models.setProvider(spec.create());
		} catch (error) {
			console.warn(`[models] 注册 provider ${spec.id} 失败，已跳过:`, error);
		}
	}
	instance = models;
	return models;
}

export interface ModelSummary {
	/** "provider/modelId"，唯一键。 */
	id: string;
	provider: string;
	providerLabel: string;
	modelId: string;
	name: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

function summarize(model: Model<Api>): ModelSummary {
	const spec = PROVIDER_SPECS.find((candidate) => candidate.id === model.provider);
	return {
		id: `${model.provider}/${model.id}`,
		provider: model.provider,
		providerLabel: spec?.label ?? model.provider,
		modelId: model.id,
		name: model.name,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
	};
}

const sortByName = (a: ModelSummary, b: ModelSummary) =>
	a.providerLabel.localeCompare(b.providerLabel, "zh-CN") || a.name.localeCompare(b.name, "zh-CN");

/**
 * 返回已配置 API Key 的厂商所有对话模型。
 * getAvailable() 内部会检查鉴权完整性，未配置的厂商会被过滤。
 */
export async function listAvailableModels(): Promise<ModelSummary[]> {
	const models = getModels();
	const available = await models.getAvailable();
	return available.map(summarize).sort(sortByName);
}

/** 返回已注册的厂商及其 API Key 配置状态，用于前端设置页。 */
export async function listProviderStatus(): Promise<
	Array<{ id: string; label: string; envVars: string[]; configured: boolean; modelCount: number }>
> {
	const models = getModels();
	const out: Array<{ id: string; label: string; envVars: string[]; configured: boolean; modelCount: number }> = [];
	for (const spec of PROVIDER_SPECS) {
		const registered = models.getProvider(spec.id);
		const configured = registered ? Boolean(process.env[spec.envVars[0] ?? ""]) : false;
		out.push({
			id: spec.id,
			label: spec.label,
			envVars: [...spec.envVars],
			configured,
			modelCount: registered?.getModels().length ?? 0,
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

	const models = getModels();
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
		throw new ModelResolutionError(`模型 "${ref}" 匹配到多个结果，请指定 provider`, contains.map((m) => `${m.provider}/${m.id}`));
	}

	throw new ModelResolutionError(
		available.length === 0
			? "没有可用模型，请先在 .env 配置至少一个厂商的 API Key"
			: `找不到模型 "${ref}"`,
		available.map((m) => `${m.provider}/${m.id}`),
	);
}
