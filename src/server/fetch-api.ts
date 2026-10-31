/**
 * 浏览器侧的适配器：把 WHATWG Request / Response 翻译成路由认得的形状。
 *
 * 与 node-http.ts 是同一件事的两面：路由那套处理器一行不改，
 * 就能在浏览器里对着 IndexedDB 跑（数据源换掉即可，路由不关心）。
 *
 * 这里唯一比 Node 那边多出来的活是"流式"：
 * NDJSON 的写作过程是一句一句往外蹦的，不能等全部跑完再一次性返回。
 * 所以回话用 ReadableStream 顶着，路由每写一段就推进去一段。
 */
import {
	bodyTooLargeMessage,
	fileTooLargeMessage,
	HttpError,
	MAX_JSON_BYTES,
	parseJsonBytes,
	type ApiRequest,
	type ApiRouter,
	type ApiSink,
} from "./api-router.ts";
import { MAX_UPLOAD_BYTES } from "./upload.ts";

const encoder = new TextEncoder();

/** Response 构造函数的第一个参数类型。undici 的 BodyInit 里没有 ReadableStream，要转一下。 */
type FetchBody = ConstructorParameters<typeof Response>[0];

/** 把路由写的字符串或字节统一成字节。 */
function toBytes(chunk: string | Uint8Array): Uint8Array {
	return typeof chunk === "string" ? encoder.encode(chunk) : chunk;
}

/** 把 Request 的头收成路由读得懂的表。 */
function collectHeaders(headers: Headers): Record<string, string | string[] | undefined> {
	const out: Record<string, string | string[] | undefined> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

/**
 * 把 WHATWG Request 翻成路由认得的请求。
 *
 * 请求体只读一次：浏览器的 Request 流只能消费一遍，
 * 所以第一次用时就把字节缓存下来，后面再取仍是同一份。
 */
export function createFetchApiRequest(request: Request, url: URL): ApiRequest {
	let bodyPromise: Promise<Uint8Array> | null = null;
	const bodyBytes = (): Promise<Uint8Array> => {
		if (!bodyPromise) {
			bodyPromise = request.arrayBuffer().then((buffer) => new Uint8Array(buffer));
		}
		return bodyPromise;
	};
	return {
		method: request.method,
		pathname: url.pathname,
		searchParams: url.searchParams,
		headers: collectHeaders(request.headers),
		json: async <T>(): Promise<T> => {
			const bytes = await bodyBytes();
			if (bytes.length > MAX_JSON_BYTES) {
				throw new HttpError(413, bodyTooLargeMessage(MAX_JSON_BYTES));
			}
			return parseJsonBytes<T>(bytes);
		},
		raw: async (limitBytes = MAX_UPLOAD_BYTES): Promise<Uint8Array> => {
			const bytes = await bodyBytes();
			if (bytes.length > limitBytes) {
				throw new HttpError(413, fileTooLargeMessage(limitBytes));
			}
			return bytes;
		},
	};
}

/**
 * 跑一次请求，给出一份 Response。
 *
 * 流式的关键在于：Response 必须在第一段字节到达之前就交出去，
 * 否则前端拿到的还是一整段 —— 写作过程就退化成了"转圈等结果"。
 * 所以这里先造一条空流，再让路由往里推进；
 * 状态码与响应头在第一段字节之前就已经定下来了（json() 与 streamNdjson
 * 都是先 writeHead 再写），writeHead 一到就把 Response 拼出来。
 *
 * 万一有处理器在写头之前就翻了：与那段赛跑，输了就补一句 500，
 * 不能让请求悬着 —— 悬着的请求在前端就是"永远转圈"。
 */
export async function handleFetchRequest(router: ApiRouter, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const apiRequest = createFetchApiRequest(request, url);

	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let closed = false;
	let destroyed = false;
	let headersSent = false;
	let status = 200;
	let responseHeaders: Record<string, string> = {};

	const closeHandlers = new Set<() => void>();
	const errorHandlers = new Set<(error: unknown) => void>();

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		// 前端把连接断了：写作那一轮要跟着停。
		cancel() {
			destroyed = true;
			for (const handler of closeHandlers) handler();
		},
	});

	let resolveHeaders: () => void = () => {};
	const headersReady = new Promise<void>((resolve) => {
		resolveHeaders = resolve;
	});

	const sink: ApiSink = {
		writeHead(statusCode: number, headers?: Record<string, string>): void {
			status = statusCode;
			responseHeaders = { ...(headers ?? {}) };
			headersSent = true;
			resolveHeaders();
		},
		setHeader(name: string, value: string): void {
			if (headersSent) return;
			responseHeaders[name] = value;
		},
		write(chunk: string | Uint8Array): void {
			if (closed || destroyed) return;
			try {
				controller?.enqueue(toBytes(chunk));
			} catch (error) {
				destroyed = true;
				for (const handler of errorHandlers) handler(error);
			}
		},
		end(chunk?: string | Uint8Array): void {
			if (chunk !== undefined && !closed && !destroyed) {
				try {
					controller?.enqueue(toBytes(chunk));
				} catch (error) {
					destroyed = true;
					for (const handler of errorHandlers) handler(error);
				}
			}
			if (closed) return;
			closed = true;
			try {
				controller?.close();
			} catch {
				/* 已经关过了。 */
			}
		},
		get headersSent(): boolean {
			return headersSent;
		},
		get ended(): boolean {
			return closed;
		},
		get destroyed(): boolean {
			return destroyed;
		},
		onClose(handler: () => void): () => void {
			closeHandlers.add(handler);
			return () => {
				closeHandlers.delete(handler);
			};
		},
		onError(handler: (error: unknown) => void): () => void {
			errorHandlers.add(handler);
			return () => {
				errorHandlers.delete(handler);
			};
		},
	};

	let routerError: unknown;
	const routerPromise = router(apiRequest, sink).catch((error: unknown) => {
		routerError = error;
	});

	// 头一到就走；路由先跑完（还没写头）也走 —— 后者说明它翻了。
	await Promise.race([headersReady, routerPromise]);

	if (!headersSent) {
		// 路由还没来得及写头就结束了：补一句 500，别把请求悬着。
		const message = routerError instanceof Error ? routerError.message : String(routerError ?? "未知错误");
		const payload = encoder.encode(JSON.stringify({ error: message }));
		return new Response(payload, {
			status: 500,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-length": String(payload.length),
			},
		});
	}

	return new Response(stream as unknown as FetchBody, { status, headers: responseHeaders });
}
