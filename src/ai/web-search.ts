import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";

/** DeepSeek Search / Fetch 是独立计费的原始 JSON API，不是模型聊天参数。 */
export interface WebSearchConfig {
	enabled: boolean;
	maxResults: number;
	includeContent: boolean;
}

export const DEFAULT_WEB_SEARCH: WebSearchConfig = { enabled: false, maxResults: 5, includeContent: false };

export function normalizeWebSearch(raw: unknown): WebSearchConfig {
	const input = raw && typeof raw === "object" ? raw as Partial<WebSearchConfig> : {};
	return {
		enabled: input.enabled === true,
		maxResults: Math.min(10, Math.max(1, Math.floor(Number(input.maxResults) || DEFAULT_WEB_SEARCH.maxResults))),
		includeContent: input.includeContent === true,
	};
}

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	summary: string;
	content?: string;
	siteName?: string;
	date?: string;
	/** DeepSeek 自研搜索引擎的权威性评分，0～4；-1 表示未知。 */
	authority?: number;
	/** 综合相关性、权威性与时效性的排序分，0～3；供后续筛选或排序使用。 */
	rerankScore?: number;
}

export interface WebSearchClient {
	search(query: string, options?: { count?: number; needContent?: boolean; originalQuestion?: string; signal?: AbortSignal }): Promise<WebSearchResult[]>;
	fetch(url: string, signal?: AbortSignal): Promise<{ title: string; content: string }>;
}

export interface DeepSeekWebSearchOptions {
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** 瞬时故障的重试基础间隔；测试中可设为 0。 */
	retryBaseDelayMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 429]);
const MAX_RETRIES = 2;

/** 可注入 fetch 的客户端：不依赖 DeepSeek 聊天模型，测试也不必访问真实网络。 */
export class DeepSeekWebSearchClient implements WebSearchClient {
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly retryBaseDelayMs: number;
	private readonly options: DeepSeekWebSearchOptions;

	constructor(options: DeepSeekWebSearchOptions) {
		this.options = options;
		if (!options.apiKey.trim()) throw new Error("DeepSeek 联网检索尚未配置 API Key。");
		this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 350);
	}

	async search(query: string, options: { count?: number; needContent?: boolean; originalQuestion?: string; signal?: AbortSignal } = {}): Promise<WebSearchResult[]> {
		const clean = query.trim();
		if (!clean || [...clean].length > 128) throw new Error("搜索词需为 1～128 个字符。");
		const payload = await this.request("/v1/tools/search", {
			query: clean,
			count: Math.min(10, Math.max(1, Math.floor(options.count ?? 5))),
			need_content: options.needContent === true,
			...(options.originalQuestion?.trim() ? { ori_question: options.originalQuestion.trim().slice(0, 128) } : {}),
		}, options.signal);
		if (!Array.isArray(payload.results)) throw new Error("联网检索返回格式不正确。");
		return payload.results.filter((item: unknown) => item && typeof item === "object").map((item: Record<string, unknown>) => ({
			title: text(item.title, 300), url: text(item.url, 8192), snippet: text(item.snippet, 800),
			summary: text(item.summary, 1600), ...(typeof item.content === "string" && item.content ? { content: item.content.slice(0, 6000) } : {}),
			...(typeof item.site_name === "string" ? { siteName: item.site_name.slice(0, 160) } : {}),
			...(typeof item.date === "string" ? { date: item.date.slice(0, 50) } : {}),
			...(typeof item.authority === "number" && Number.isFinite(item.authority) ? { authority: Math.trunc(item.authority) } : {}),
			...(typeof item.rerank_score === "number" && Number.isFinite(item.rerank_score) ? { rerankScore: item.rerank_score } : {}),
		})).filter((item: WebSearchResult) => /^https?:\/\//.test(item.url));
	}

	async fetch(url: string, signal?: AbortSignal): Promise<{ title: string; content: string }> {
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 8192) {
			throw new Error("只能抓取不带账号密码的 HTTP/HTTPS 网页。");
		}
		const payload = await this.request("/v1/tools/fetch", { url: parsed.href }, signal);
		return { title: text(payload.title, 300), content: typeof payload.content === "string" ? payload.content.slice(0, 16000) : "" };
	}

	private async request(endpoint: string, body: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("联网请求超时，请稍后重试。")), 30_000);
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for (let attempt = 0; ; attempt += 1) {
				if (controller.signal.aborted) {
					throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("联网请求已取消。");
				}
				const response = await this.fetchImpl(this.baseUrl + endpoint, {
					method: "POST",
					headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify(body), signal: controller.signal,
				});
				const data = await response.json().catch(() => ({})) as Record<string, any>;
				if (!response.ok) {
					const transient = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
					if (transient && attempt < MAX_RETRIES) {
						await delayBeforeRetry(this.retryBaseDelayMs, attempt, response.headers.get("retry-after"));
						continue;
					}
					throw new Error(`DeepSeek 联网请求失败：${errorReason(data, response.status)}`);
				}
				return data;
			}
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}
}

function errorReason(data: Record<string, any>, status: number): string {
	const reason = typeof data?.error?.message === "string" ? data.error.message : `HTTP ${status}`;
	const hint = status === 401 ? "请检查联网检索 API Key。"
		: status === 402 ? "请检查 DeepSeek 账户余额。"
		: status === 403 ? "目标网页被安全策略拒绝，请换一个来源。"
		: status === 404 ? "没有可提取的网页正文，请换一个来源。"
		: status === 408 ? "联网服务读取超时，请稍后重试。"
		: status === 429 ? "联网检索触发限速，请稍后重试。"
		: status >= 500 ? "联网服务暂时不可用，请稍后重试。" : "";
	return `${reason}${hint}`;
}

async function delayBeforeRetry(baseMs: number, attempt: number, retryAfter: string | null): Promise<void> {
	const seconds = Number(retryAfter);
	const serverWait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
	const wait = Math.min(2_500, Math.max(baseMs * 2 ** attempt, serverWait));
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

function text(value: unknown, limit: number): string {
	return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** 不直接传客户端时，工具列表不可能出现：角色边界由代码而非提示词保证。 */
export function createWebSearchTools(client: WebSearchClient, config: WebSearchConfig): AgentTool<any>[] {
	return [webSearchTool(client, config), webFetchTool(client)];
}

function webSearchTool(client: WebSearchClient, config: WebSearchConfig): AgentTool<any> {
	return {
		name: "web_search", label: "联网检索素材资料",
		description: "在作者需要现实资料、历史背景或公开事实时搜索网页。返回标题、摘要与来源 URL；先把资料提炼为素材并注明来源，不要把搜索结果当正文。",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 128, description: "具体检索词，可用 site:、lang:、after: 等 DeepSeek 搜索语法" }),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: `返回数量，默认 ${config.maxResults}；每次成功搜索独立计费` })),
			includeContent: Type.Optional(Type.Boolean({ description: "是否附网页正文摘录；仅在摘要不足时开启" })),
		}),
		execute: async (_id: string, params: Static<TSchema>, signal?: AbortSignal) => {
			const input = params as { query: string; count?: number; includeContent?: boolean };
			const results = await client.search(input.query, { count: input.count ?? config.maxResults, needContent: input.includeContent ?? config.includeContent, signal });
			return { content: [{ type: "text", text: results.length ? results.map((item, index) => {
				const trust = typeof item.authority === "number" && item.authority >= 0 ? `\n权威性：${item.authority}/4` : "";
				return `[${index + 1}] ${item.title}\n来源：${item.url}${item.date ? `\n日期：${item.date}` : ""}${trust}\n摘要：${item.summary || item.snippet}${item.content ? `\n正文摘录：${item.content}` : ""}`;
			}).join("\n\n") : "没有找到匹配网页，可换关键词或缩小站点范围。" }], details: { query: input.query, results } };
		},
	} as AgentTool<any>;
}

function webFetchTool(client: WebSearchClient): AgentTool<any> {
	return {
		name: "web_fetch", label: "读取网页资料",
		description: "读取 web_search 返回的具体网页，以 Markdown 摘录补充资料。只接受 HTTP/HTTPS URL；成功抓取独立计费。",
		parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 8192, description: "搜索结果中的 HTTP/HTTPS 来源链接" }) }),
		execute: async (_id: string, params: Static<TSchema>, signal?: AbortSignal) => {
			const page = await client.fetch((params as { url: string }).url, signal);
			return { content: [{ type: "text", text: `标题：${page.title || "未提供"}\n来源：${(params as { url: string }).url}\n\n${page.content || "没有可提取的网页正文。"}` }], details: page };
		},
	} as AgentTool<any>;
}
