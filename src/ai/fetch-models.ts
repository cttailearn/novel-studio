import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	emptyModel,
	isPlaceholderContextWindow,
	isPlaceholderMaxTokens,
	type ApiFormat,
	type ModelConfig,
} from "../config/settings.ts";

export interface FetchedModel {
	id: string;
	name: string;
	/** 上游若提供了 token 限制就预填，否则为 undefined 待用户确认。 */
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

/** 从上游模型描述里挖出来的限制。 */
export interface ModelLimits {
	/** 输入上下文窗口（token）。 */
	contextWindow?: number;
	/** 单次回复的输出上限（token）。 */
	maxTokens?: number;
}

export class ModelFetchError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ModelFetchError";
		this.status = status;
	}
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** Anthropic 与 Google 的模型列表路径与 /v1 不同，按已有后缀补全。 */
function modelsUrl(baseUrl: string, api: ApiFormat): string {
	const base = trimSlash(baseUrl);
	if (api === "google-generative-ai") {
		return base.endsWith("/v1beta") ? `${base}/models` : `${base}/v1beta/models`;
	}
	if (api === "anthropic-messages") {
		return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
	}
	return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

function headersFor(api: ApiFormat, apiKey: string): Record<string, string> {
	switch (api) {
		case "anthropic-messages":
			return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
		case "google-generative-ai":
			return { "x-goog-api-key": apiKey };
		default:
			return { authorization: `Bearer ${apiKey}` };
	}
}

/** 拉取模型列表的超时与重试间隔。拉列表是"点一下等一下"的交互，拖太久等于卡死。 */
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_RETRY_MS = 600;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 从上游拉取模型列表。不会写入任何配置，只返回候选。 */
export async function fetchUpstreamModels(input: {
	baseUrl: string;
	api: ApiFormat;
	apiKey?: string;
	/** 为 true 时允许无 key 拉取，用于自建服务。 */
	noAuthRequired?: boolean;
	/** 浏览器本地模式在这里注入经 /api/llm 的 fetch；Node 默认直接访问上游。 */
	fetchImpl?: typeof globalThis.fetch;
	signal?: AbortSignal;
}): Promise<FetchedModel[]> {
	const { baseUrl, api, apiKey, noAuthRequired, fetchImpl = globalThis.fetch, signal } = input;
	if (!baseUrl.trim()) throw new ModelFetchError("请先填写 Base URL");
	if (!apiKey?.trim() && !noAuthRequired) throw new ModelFetchError("请先填写 API Key");
	// 无鉴权时仍需要一个占位头：不少自建服务（如 LM Studio）要求该头存在才肯响应。
	const auth = apiKey?.trim() || "not-required";
	const url = modelsUrl(baseUrl, api);
	// 上游不响应时不能无限挂着：调用方常常不传 signal，早先这里就是无限等待。
	// 限流与临时故障重试两次，4xx 里的 429 除外 —— 那是"等会儿再来"的信号。
	const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
	let response: Response | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			response = await fetchImpl(url, { headers: headersFor(api, auth), signal: abort });
		} catch (error) {
			// 调用方主动取消要原样抛出去，不要包装成"连接失败"。
			if (signal?.aborted) throw error;
			if (attempt === 2) {
				throw new ModelFetchError(
					deadline.aborted ? `连接超时（${FETCH_TIMEOUT_MS / 1000} 秒无响应）` : `连接失败：${(error as Error).message}`,
				);
			}
			await delay(FETCH_RETRY_MS * (attempt + 1));
			continue;
		}
		const retryable = response.status === 429 || response.status >= 500;
		if (!retryable || attempt === 2) break;
		await delay(FETCH_RETRY_MS * (attempt + 1));
	}
	if (!response) throw new ModelFetchError("连接失败");

	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 300);
		throw new ModelFetchError(
			`上游返回 ${response.status} ${response.statusText}${detail ? `：${detail}` : ""}`,
			response.status,
		);
	}

	const body = (await response.json().catch(() => undefined)) as unknown;
	if (!body || typeof body !== "object") throw new ModelFetchError("上游返回了非 JSON 内容");

	const models = parseModels(body, api);
	if (models.length === 0) throw new ModelFetchError("上游没有返回任何模型");
	return models;
}

/**
 * 上游限制字段的归一化名 → 归属。
 *
 * 键名先去掉下划线并转小写，所以 "max_input_tokens"、"maxInputTokens"、
 * "Max-Input-Tokens" 都能落到同一个条目上。
 */
const LIMIT_KEYS: Record<string, keyof ModelLimits> = {
	// 上下文窗口
	inputtokenlimit: "contextWindow",
	contextlength: "contextWindow",
	maxinputtokens: "contextWindow",
	contextwindow: "contextWindow",
	maxcontextlength: "contextWindow",
	contextwindowsize: "contextWindow",
	// 输出上限
	outputtokenlimit: "maxTokens",
	maxoutputtokens: "maxTokens",
	maxtokens: "maxTokens",
	maxcompletiontokens: "maxTokens",
	outputtokens: "maxTokens",
};

/** 有些厂商把限制包在这些子对象里。 */
const NESTED_LIMIT_KEYS = ["limits", "capabilities", "model_info", "modelInfo", "details"];

/** 归一化键名：去下划线 / 连字符并转小写。 */
function normalizeLimitKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 只接受正整数。
 *
 * 上游偶尔把数字写成字符串（"1048576"），这种照样收；
 * 0、负数、小数与非数一律当作"没有报限制"，不猜。
 */
function toPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isInteger(value) && value > 0 ? value : undefined;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!/^\d+$/.test(trimmed)) return undefined;
		const parsed = Number(trimmed);
		return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

/**
 * 从上游返回的单个模型描述里尽力挖出上下文窗口与输出上限。
 *
 * 各家厂商的字段名不统一：Google 用 inputTokenLimit / outputTokenLimit，
 * OpenRouter 用 context_length，有些自建服务用 max_input_tokens / max_output_tokens，
 * 还有些把限制塞进 limits 之类的子对象。这里把常见键名都认一遍，
 * 认不出来就留空 —— 留空时模型维持占位值，等用户人工核对。
 */
export function extractLimits(raw: unknown, api: ApiFormat): ModelLimits {
	const limits: ModelLimits = {};
	if (!raw || typeof raw !== "object") return limits;
	const item = raw as Record<string, unknown>;

	const scan = (source: Record<string, unknown>): void => {
		for (const [key, value] of Object.entries(source)) {
			const field = LIMIT_KEYS[normalizeLimitKey(key)];
			if (!field || limits[field] !== undefined) continue;
			const parsed = toPositiveInt(value);
			if (parsed === undefined) continue;
			limits[field] = parsed;
		}
	};

	// Google 的字段名最权威，先读它，免得被别的通用键名抢走。
	if (api === "google-generative-ai") {
		const input = toPositiveInt(item.inputTokenLimit);
		if (input !== undefined) limits.contextWindow = input;
		const output = toPositiveInt(item.outputTokenLimit);
		if (output !== undefined) limits.maxTokens = output;
	}

	scan(item);
	for (const key of NESTED_LIMIT_KEYS) {
		const nested = item[key];
		if (nested && typeof nested === "object") scan(nested as Record<string, unknown>);
	}
	return limits;
}

/** 把上游描述转成候选模型。 */
export function parseModels(body: object, api: ApiFormat): FetchedModel[] {
	// Google: { models: [{ name: "models/x", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods }] }
	if (api === "google-generative-ai") {
		const list = (body as { models?: unknown[] }).models;
		if (!Array.isArray(list)) return [];
		const models: FetchedModel[] = [];
		for (const raw of list) {
			const item = raw as Record<string, unknown>;
			const id = String(item.name ?? "").replace(/^models\//, "");
			if (!id) continue;
			const limits = extractLimits(item, api);
			const model: FetchedModel = { id, name: String(item.displayName ?? id) };
			if (limits.contextWindow !== undefined) model.contextWindow = limits.contextWindow;
			if (limits.maxTokens !== undefined) model.maxTokens = limits.maxTokens;
			models.push(model);
		}
		return models;
	}

	// OpenAI 兼容与 Anthropic 都是 { data: [{ id, display_name? }] }，
	// 但也有自建服务直接回 { models: [...] }，两种都认。
	const list = (body as { data?: unknown[]; models?: unknown[] }).data;
	const rows = Array.isArray(list) ? list : (body as { models?: unknown[] }).models;
	if (!Array.isArray(rows)) return [];
	const models: FetchedModel[] = [];
	for (const raw of rows) {
		const item = raw as Record<string, unknown>;
		const id = String(item.id ?? "");
		if (!id) continue;
		const limits = extractLimits(item, api);
		const model: FetchedModel = { id, name: String(item.display_name ?? item.name ?? id) };
		if (limits.contextWindow !== undefined) model.contextWindow = limits.contextWindow;
		if (limits.maxTokens !== undefined) model.maxTokens = limits.maxTokens;
		models.push(model);
	}
	return models;
}

/**
 * 合并上游拉到的模型与本地配置。
 *
 * - 新模型：按上游给的限制建档，没有就留占位值（前端标「待核对」）。
 * - 已有模型：原样保留；若某一项还是占位值，而这次上游报了该项的限制，就回填它。
 *   用户手工填过的值绝不覆盖 —— 那是他们核对后的数字，比上游的更可信。
 */
export function mergeFetched(existing: ModelConfig[], fetched: FetchedModel[]): {
	models: ModelConfig[];
	added: string[];
	backfilled: string[];
} {
	const byId = new Map(existing.map((model) => [model.id, model]));
	const added: string[] = [];
	const backfilled: string[] = [];
	const models: ModelConfig[] = [];

	for (const item of fetched) {
		const previous = byId.get(item.id);
		if (previous) {
			// 逐项回填：只动仍是占位的那一项。
			const patch: Partial<ModelConfig> = {};
			if (item.contextWindow !== undefined && isPlaceholderContextWindow(previous.contextWindow)) {
				patch.contextWindow = item.contextWindow;
			}
			if (item.maxTokens !== undefined && isPlaceholderMaxTokens(previous.maxTokens)) {
				patch.maxTokens = item.maxTokens;
			}
			if (patch.contextWindow !== undefined || patch.maxTokens !== undefined) {
				models.push({ ...previous, ...patch });
				backfilled.push(item.id);
			} else {
				models.push(previous);
			}
			byId.delete(item.id);
			continue;
		}
		added.push(item.id);
		models.push({
			...emptyModel(item.id, item.name),
			...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
			...(item.maxTokens ? { maxTokens: item.maxTokens } : {}),
			...(item.reasoning !== undefined ? { reasoning: item.reasoning } : {}),
		} satisfies ModelConfig);
	}

	// 上游已删除的模型保留配置，避免意外丢失用户手填的上下文限制。
	models.push(...byId.values());

	return { models, added, backfilled };
}

/**
 * 内置厂商拉取上游清单：完整采用上游给出的模型集合。
 *
 * 不能沿用 mergeFetched 的"把没出现的旧模型留在末尾"：那会把静态目录里
 * 实际上没有权限的模型混进实时清单，看起来就像已经拉到了全部可用模型。
 * 同名旧条目的限制、价格、思考档位仍保留，作者手工核对过的值不会丢。
 */
export function replaceWithFetched(existing: ModelConfig[], fetched: FetchedModel[]): ModelConfig[] {
	const previous = new Map(existing.map((model) => [model.id, model]));
	return mergeFetched(
		fetched.map((model) => previous.get(model.id) ?? emptyModel(model.id, model.name)),
		fetched,
	).models;
}

/** 一个模型是否声称支持思考。 */
export function inferReasoning(id: string): boolean {
	return /-(?:thinking|reasoner|reasoning|r1|o[134])/i.test(id) || /^(?:o[134])/.test(id);
}

export const ALL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
