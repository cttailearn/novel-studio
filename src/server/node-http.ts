/**
 * Node 侧的适配器：把 http.IncomingMessage / ServerResponse 翻译成路由认得的形状。
 *
 * 路由本身不知道 Node 的存在（见 api-router.ts）。这里只做三件事：
 *   · 把请求读成 ApiRequest（方法、路径、查询串、头、请求体）
 *   · 把响应接成 ApiSink（writeHead / setHeader / write / end 全部直通）
 *   · 保住"客户端断开"这件事：流式回复要靠它停笔
 *
 * 状态码、响应头与响应体与拆出路由之前逐字节一致。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	concatBytes,
	fileTooLargeMessage,
	HttpError,
	MAX_JSON_BYTES,
	parseJsonBytes,
	type ApiRequest,
	type ApiRouter,
	type ApiSink,
} from "./api-router.ts";
import { MAX_UPLOAD_BYTES } from "./upload.ts";

/**
 * 读请求体字节。
 *
 * 体积上限两道闸：先看声明的 content-length（不必先把几 MB 收进内存
 * 再发现它太大），再边收边数实际长度。
 */
async function readBodyBytes(req: IncomingMessage, limitBytes: number): Promise<Uint8Array> {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limitBytes) {
		throw new HttpError(413, fileTooLargeMessage(limitBytes));
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = chunk as Uint8Array;
		size += bytes.length;
		if (size > limitBytes) {
			throw new HttpError(413, fileTooLargeMessage(limitBytes));
		}
		chunks.push(bytes);
	}
	return concatBytes(chunks);
}

/** 把 Node 的请求翻成路由认得的请求。 */
export function createNodeApiRequest(req: IncomingMessage, url: URL): ApiRequest {
	return {
		method: req.method ?? "GET",
		pathname: url.pathname,
		searchParams: url.searchParams,
		headers: req.headers,
		json: async <T>(): Promise<T> => parseJsonBytes<T>(await readBodyBytes(req, MAX_JSON_BYTES)),
		raw: async (limitBytes = MAX_UPLOAD_BYTES): Promise<Uint8Array> => readBodyBytes(req, limitBytes),
	};
}

/** 把 Node 的响应接成路由认得的出口。 */
export function createNodeApiSink(res: ServerResponse): ApiSink {
	return {
		writeHead: (status: number, headers?: Record<string, string>): void => {
			res.writeHead(status, headers ?? {});
		},
		setHeader: (name: string, value: string): void => {
			res.setHeader(name, value);
		},
		write: (chunk: string | Uint8Array): void => {
			res.write(chunk);
		},
		end: (chunk?: string | Uint8Array): void => {
			if (chunk === undefined) res.end();
			else res.end(chunk);
		},
		get headersSent(): boolean {
			return res.headersSent;
		},
		get ended(): boolean {
			return res.writableEnded;
		},
		get destroyed(): boolean {
			return res.destroyed;
		},
		onClose: (handler: () => void): (() => void) => {
			res.on("close", handler);
			return () => {
				res.off("close", handler);
			};
		},
		onError: (handler: (error: unknown) => void): (() => void) => {
			res.on("error", handler);
			return () => {
				res.off("error", handler);
			};
		},
	};
}

/**
 * 造一个 Node 侧的接口处理函数。
 *
 * 返回的函数签名与原来 main.ts 里那个 handleApiSafely 一样：
 * 收请求、收响应、收已经解析好的 URL。
 */
export function createNodeApiAdapter(router: ApiRouter): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> {
	return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
		await router(createNodeApiRequest(req, url), createNodeApiSink(res));
	};
}
