import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { emptyModel, type ApiFormat, type ModelConfig } from "../config/settings.ts";

export interface FetchedModel {
	id: string;
	name: string;
	/** 上游若提供了 token 限制就预填，否则为 undefined 待用户确认。 */
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
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
	signal?: AbortSignal;
}): Promise<FetchedModel[]> {
	const { baseUrl, api, apiKey, noAuthRequired, signal } = input;
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
			response = await fetch(url, { headers: headersFor(api, auth), signal: abort });
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

function parseModels(body: object, api: ApiFormat): FetchedModel[] {
	// Google: { models: [{ name: "models/x", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods }] }
	if (api === "google-generative-ai") {
		const list = (body as { models?: unknown[] }).models;
		if (!Array.isArray(list)) return [];
		const models: FetchedModel[] = [];
		for (const raw of list) {
			const item = raw as Record<string, unknown>;
			const id = String(item.name ?? "").replace(/^models\//, "");
			if (!id) continue;
			const model: FetchedModel = { id, name: String(item.displayName ?? id) };
			if (typeof item.inputTokenLimit === "number") model.contextWindow = item.inputTokenLimit;
			if (typeof item.outputTokenLimit === "number") model.maxTokens = item.outputTokenLimit;
			models.push(model);
		}
		return models;
	}

	// OpenAI 兼容与 Anthropic 都是 { data: [{ id, display_name? }] }
	const list = (body as { data?: unknown[] }).data;
	if (!Array.isArray(list)) return [];
	const models: FetchedModel[] = [];
	for (const raw of list) {
		const item = raw as Record<string, unknown>;
		const id = String(item.id ?? "");
		if (!id) continue;
		models.push({ id, name: String(item.display_name ?? item.name ?? id) });
	}
	return models;
}

/** 保留已有配置，新模型补默认值，已不在上游列表的保留但标记。 */
export function mergeFetched(existing: ModelConfig[], fetched: FetchedModel[]): {
	models: ModelConfig[];
	added: string[];
} {
	const byId = new Map(existing.map((model) => [model.id, model]));
	const added: string[] = [];
	const models: ModelConfig[] = [];

	for (const item of fetched) {
		const previous = byId.get(item.id);
		if (previous) {
			models.push(previous);
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

	return { models, added };
}

/** 一个模型是否声称支持思考。 */
export function inferReasoning(id: string): boolean {
	return /-(?:thinking|reasoner|reasoning|r1|o[134])/i.test(id) || /^(?:o[134])/.test(id);
}

export const ALL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
