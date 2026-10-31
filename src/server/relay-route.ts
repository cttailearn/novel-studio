/**
 * 把无状态 LLM 中继接到 HTTP 上。
 *
 * 中继本身不认识 HTTP（见 llm-relay.ts）：它只收一个 RelayRequest、吐一个
 * RelayOutcome。这个文件负责两者之间的翻译：
 *
 *   · 读请求体（带上限，超了回 413）
 *   · 把浏览器的 Origin 等头交给中继做 CORS 判定
 *   · 流式结果逐块写回，非流式结果按上游的 content-type 写回
 *
 * 路由是 `/api/llm`，在 /api/ 路由层之前拦下 —— 它不碰作品数据，
 * 也不需要任何会话，所以没有理由进 api-router.ts。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRelayHandler, type RelayConfig, type RelayOutcome, type RelayRequest } from "./llm-relay.ts";

/** 请求体读超了。 */
export class RelayBodyTooLargeError extends Error {
	constructor(limit: number) {
		super("请求体超过 " + Math.round(limit / 1024 / 1024) + " MB 上限");
		this.name = "RelayBodyTooLargeError";
	}
}

/** 读请求体，最多 limit 字节。 */
export async function readRelayBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new RelayBodyTooLargeError(limit);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

/** 把 Node 的请求头摊平成中继认识的形状。 */
export function headerBag(req: IncomingMessage): Record<string, string | undefined> {
	const bag: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		bag[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	return bag;
}

/** 把中继的结果写回 HTTP 响应。 */
export async function writeRelayOutcome(res: ServerResponse, outcome: RelayOutcome): Promise<void> {
	const headers: Record<string, string> = { ...(outcome.headers ?? {}) };
	const status = outcome.status;

	if (outcome.stream) {
		res.writeHead(status, headers);
		try {
			for await (const chunk of outcome.stream.stream) {
				res.write(chunk);
			}
		} catch {
			// 上游半路断了：已经发出去的头收不回来，只能把连接掐了。
			// 浏览器会看到一个不完整的流，这比伪造一个完整回答诚实。
		}
		res.end();
		return;
	}

	const body = outcome.body;
	if (typeof body === "string") {
		res.writeHead(status, headers);
		res.end(body);
		return;
	}
	if (body === undefined) {
		const payload = JSON.stringify({ error: outcome.error ?? "转发失败" });
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
		res.end(payload);
		return;
	}
	res.writeHead(status, headers);
	res.end(JSON.stringify(body));
}

/**
 * 造一个 `/api/llm` 的处理函数。
 *
 * clientKey 用来源 IP：限流按 IP 算，这是唯一拿得到的、客户端改不动的标识。
 */
export function createRelayRoute(config: RelayConfig): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	const handle = createRelayHandler(config);
	return async function handleRelayRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const requestHeaders = headerBag(req);
		const clientKey = (req.headers["x-forwarded-for"]?.toString().split(",", 1)[0]?.trim()) || req.socket.remoteAddress || "unknown";
		const method = (req.method ?? "POST").toUpperCase();

		// 预检：没有请求体，也不该消耗额度。交给中继出政策即可。
		if (method === "OPTIONS") {
			const outcome = await handle({ target: "", apiKey: "", method: "OPTIONS", requestHeaders }, clientKey);
			res.writeHead(outcome.status, outcome.headers ?? {});
			res.end();
			return;
		}

		let payload: RelayRequest;
		try {
			const raw = await readRelayBody(req, config.maxRequestBytes);
			const parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
			if (typeof parsed !== "object" || parsed === null) {
				res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "请求体不是对象" }));
				return;
			}
			// 中继的入口永远是 POST；body.method 才是要转发给上游的 GET/POST。
			payload = { ...(parsed as RelayRequest), requestHeaders };
		} catch (error) {
			if (error instanceof RelayBodyTooLargeError) {
				res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: error.message }));
				return;
			}
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: "请求体不是合法 JSON" }));
			return;
		}

		const outcome = await handle(payload, clientKey);
		await writeRelayOutcome(res, outcome);
	};
}
