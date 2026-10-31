/**
 * 浏览器内的本地 API。
 *
 * 这是整套改造的收口处：把**同一份** `createApiRouter()`（服务端那 51 个路由）
 * 架在 IndexedDB 之上跑起来，再用 `handleFetchRequest()` 把结果包成 `Response`。
 * 于是 `public/app.js` 与 `public/settings.js` 一行都不用改 —— 它们照旧
 * `fetch("/api/…")`，只是请求在同一个标签页里就被接住了，一个字节都没出浏览器。
 *
 * 由 `public/boot.js` 在本地模式下懒加载（构建产物落在 browser/local-api.js），
 * 拿到本模块的 `handle` 之后把同源 `/api/*` 的请求交给它。
 *
 * 落地的三层：
 *   1. 存储层：`IdbProjectStore` + `openIdbStores()`（六个存储，全在 IndexedDB 里）；
 *   2. 模型层：`createBrowserModels()`（catalog.json 当目录）+ `createLlmClient()`（只用 fetch）；
 *   3. 路由层：`createApiRouter(deps)` —— 与服务端逐字相同的那一份。
 *
 * 上游请求走哪儿：默认走 `/api/llm` 中继（服务端只转发、不落盘，能通吃所有厂商）；
 * 想在浏览器里直连就把 `localStorage["novel-studio/transport"]` 设成 `"direct"`
 * —— 只有少数厂商的接口带 CORS 头，直连不通是常态，不是 bug。
 */
import type { Session } from "../server/api-router.ts";
import { createApiRouter } from "../server/api-router.ts";
import { handleFetchRequest } from "../server/fetch-api.ts";
import { AskChannel, answerQuestion } from "../server/ask.ts";
import { RECORDS_KEEP } from "../server/records.ts";
import type { AppConfig } from "../config/env.ts";
import { createLlmClient, type LlmClient } from "../ai/llm-client.ts";
import { newId } from "../store/project.ts";
import { IdbProjectStore } from "../store/project-idb.ts";
import { openIdbStores, closeIdbStores, type IdbStores } from "../store/idb-stores.ts";
import { createBrowserModels, parseCatalog, syncBuiltinProvidersFromCatalog, type BrowserCatalog } from "./models.ts";

/** 目录文件的固定位置（构建产物，见 `scripts/browser-build.ts`）。 */
const CATALOG_URL = "/browser/vendor/catalog.json";

/**
 * 浏览器全局。
 *
 * 本仓库的 tsconfig 只开 ES2023（没有 DOM lib），所以这里按需声明用到的那一点形状，
 * 和 `src/store/project-idb.ts` 自声明 IndexedDB 结构是同一个理由。
 */
declare const location: { readonly href: string; readonly origin: string };
declare const navigator: {
	readonly storage?: {
		persist?: () => Promise<boolean>;
		persisted?: () => Promise<boolean>;
	};
};

/** 传输方式的开关：默认中继，`direct` 才是浏览器直连上游。 */
const TRANSPORT_KEY = "novel-studio/transport";

/** 浏览器里没有服务端进程，这些值只为了让 `AppConfig` 形状成立。 */
const RELAY_DEFAULTS_FOR_BROWSER = {
	maxRequestBytes: 8 * 1024 * 1024,
	requestsPerMinute: 60,
	maxInflight: 16,
	timeoutMs: 180_000,
	maxResponseBytes: 64 * 1024 * 1024,
} as const;

function browserConfig(): AppConfig {
	const origin = typeof location === "object" && location.origin ? location.origin : "http://localhost";
	return {
		// 浏览器不是服务端，端口/主机只是占位；真正用到它们的地方在 idb 模式下都关掉了。
		port: 0,
		host: "localhost",
		dataDir: "",
		defaultModel: "",
		defaultThinkingLevel: "off",
		storage: "idb",
		corsOrigins: [origin],
		relay: {
			allowedHosts: [],
			...RELAY_DEFAULTS_FOR_BROWSER,
			allowedOrigin: origin,
		},
	};
}

function readTransport(): "direct" | "relay" {
	try {
		return localStorage.getItem(TRANSPORT_KEY) === "direct" ? "direct" : "relay";
	} catch {
		// 隐私模式里 localStorage 可能直接抛错 —— 那就老老实实走中继。
		return "relay";
	}
}

/**
 * 浏览器模式的上游请求：与 LLM 一样走中继，绕开厂商未开放的 CORS。
 *
 * 连请求体一起转：模型列表是 GET 不需要体，但联网检索的 Search/Fetch 是 POST，
 * 丢掉 body 会让上游收到空请求。中继的 encodeBody 把字符串原样写出，
 * 所以这里不必 JSON.parse 再序列化，省一次往返转换。
 */
export function createRelayFetch(relayUrl: string): typeof globalThis.fetch {
	return async (input, init) => {
		const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const requestHeaders = new Headers(init?.headers);
		const authorization = requestHeaders.get("authorization") ?? "";
		const schemeMatch = authorization.match(/^Bearer\s+(.*)$/i);
		const apiKey = schemeMatch?.[1] ?? requestHeaders.get("x-api-key") ?? requestHeaders.get("x-goog-api-key") ?? "";
		const authHeader = schemeMatch ? "authorization" : requestHeaders.has("x-api-key") ? "x-api-key" : "x-goog-api-key";
		requestHeaders.delete("authorization");
		requestHeaders.delete("x-api-key");
		requestHeaders.delete("x-goog-api-key");
		return fetch(relayUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				target,
				method: (init?.method ?? "GET").toUpperCase(),
				apiKey,
				authHeader,
				authScheme: authHeader === "authorization" ? "Bearer " : "",
				headers: Object.fromEntries(requestHeaders),
				...(typeof init?.body === "string" ? { body: init.body } : {}),
			}),
			signal: init?.signal,
		});
	};
}

/** 跑起来的那一套东西。 */
interface LocalRuntime {
	router: ReturnType<typeof createApiRouter>;
	stores: IdbStores;
	store: IdbProjectStore;
	client: LlmClient;
}

let runtimePromise: Promise<LocalRuntime> | null = null;

function requestJson<T>(url: string): Promise<T> {
	return fetch(url, { method: "GET", credentials: "same-origin" }).then((response) => {
		if (!response.ok) throw new Error(`读取 ${url} 失败（HTTP ${response.status}）`);
		return response.json() as Promise<T>;
	});
}

async function bootstrap(): Promise<LocalRuntime> {
	/*
	 * 0) 申请持久化存储。
	 *
	 * 浏览器默认只给站点「尽力保留」（best-effort）级存储，磁盘紧张时有权整站清掉。
	 * 写小说是长期资产，丢不起 —— 启动时申请一次 persistent，同意了就不再被自动回收。
	 * Safari 没有这个 API（`navigator.storage` 上只有 estimate），申请失败也照常跑。
	 */
	try {
		await navigator.storage?.persist?.();
	} catch {
		/* 隐私模式或老浏览器：忽略，不影响主流程 */
	}

	// 1) 存储：六个端口全部落到 IndexedDB。
	const [store, stores] = await Promise.all([IdbProjectStore.open(), openIdbStores()]);

	// 2) 目录：构建期在 Node 侧导出的纯数据。缺了也不致命，只是没有内置厂商。
	let catalog: BrowserCatalog = { providers: [] };
	try {
		catalog = parseCatalog(await requestJson<unknown>(CATALOG_URL));
	} catch (error) {
		console.warn("[local] 读不到模型目录，内置厂商暂时不可用：", error);
	}

	// 3) 设置：把目录里的内置厂商补齐（等价于服务端启动时的 syncBuiltinProviders）。
	try {
		syncBuiltinProvidersFromCatalog(stores.settings, catalog);
	} catch (error) {
		console.warn("[local] 补齐内置厂商失败：", error);
	}

	// 4) 模型 + LLM 客户端。密钥一律现读浏览器里的凭据库，不缓存。
	let models: ReturnType<typeof createBrowserModels> | null = null;
	const client = createLlmClient({
		resolveApiKey: (provider: string) => (models ? models.apiKey(provider) : Promise.resolve(undefined)),
		transport: readTransport(),
		relayUrl: "/api/llm",
	});

	models = createBrowserModels({
		settingsStore: stores.settings,
		credentialStore: stores.credentials,
		catalog,
		client,
	});

	// 5) 路由：与服务端逐字相同的一份，只是依赖全换成浏览器版。
	const router = createApiRouter({
		store,
		libraryStore: stores.library,
		kindStore: stores.kinds,
		settingsStore: stores.settings,
		credentialStore: stores.credentials,
		recordStore: stores.records,
		sessions: new Map<string, Session>(),
		config: browserConfig(),
		// 浏览器里没有服务端环境变量可读：厂商密钥只认浏览器里存的那把。
		env: {},
		recordsKeep: RECORDS_KEEP,
		newId,
		builtinCatalog: models.builtinCatalog(),
		upstreamFetch: createRelayFetch("/api/llm"),
		createAskChannel: (sessionId: string) => new AskChannel(sessionId),
		answerQuestion,
		models,
	});

	return { router, stores, store, client };
}

/**
 * 拿到（必要时先建好）本地运行时。
 *
 * 建的过程只做一次：同一页面里重复 open 同一个 IndexedDB 库会把版本号顶坏
 * （`openIdbStores` 内部也另有保护），这里再加一层 memo。
 */
export function ready(): Promise<void> {
	return ensureRuntime().then(() => undefined);
}

function ensureRuntime(): Promise<LocalRuntime> {
	if (!runtimePromise) {
		runtimePromise = bootstrap().catch((error: unknown) => {
			// 失败要允许重试：下次 fetch 再试一遍，而不是永远卡在坏状态上。
			runtimePromise = null;
			throw error;
		});
	}
	return runtimePromise;
}

/** 关掉数据库连接（换账号、清数据、或者单纯想重置时用）。 */
export async function close(): Promise<void> {
	const current = runtimePromise;
	runtimePromise = null;
	if (!current) return;
	const runtime = await current.catch(() => null);
	if (!runtime) return;
	try {
		runtime.store.close?.();
	} catch {
		/* 关不掉就算了，下次打开会复用或重开 */
	}
	closeIdbStores(runtime.stores);
}

/** 把 `fetch(input, init)` 的入参归一成一条绝对 URL 的 Request。 */
function toRequest(input: unknown, init?: RequestInit): Request {
	if (typeof Request === "function" && input instanceof Request) {
		return init ? new Request(input, init) : input;
	}
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
	// 路由层要求绝对 URL（fetch-api.ts 里 `new URL(request.url)`），所以相对路径先补上 origin。
	return new Request(new URL(raw, location.href), init);
}

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	console.error("[local] 处理请求失败：", error);
	return new Response(JSON.stringify({ error: message }), {
		status: 500,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/**
 * 处理一次本地 API 请求。
 *
 * `public/boot.js` 把同源的 `/api/*`（`/api/llm` 除外）都送进来，
 * 返回值与真实 `fetch` 的 `Response` 完全一样，所以前端的 `api()` helper 察觉不到区别。
 */
export async function handle(input: unknown, init?: RequestInit): Promise<Response> {
	try {
		const runtime = await ensureRuntime();
		return await handleFetchRequest(runtime.router, toRequest(input, init));
	} catch (error) {
		return errorResponse(error);
	}
}

export default handle;
