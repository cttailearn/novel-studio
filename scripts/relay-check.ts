/**
 * 中继验收：转发的、挡住的、限流的、不落盘的。
 *
 * 这条通路直接花用户的钱、也直接拿用户自己的 Key，所以验收不能只看"能转通"。
 * 这里真的起两个服务器：一个假的上游（回显收到的头与体，能慢、能流、能报错），
 * 一个套着中继的 HTTP 服务器（让限流真的按来源 IP 分桶）。
 *
 * 逐项核对：
 *   1. 正常转发 —— 体、鉴权头、附加头都到得了上游。
 *   2. SSRF —— 内网地址、云元数据、http 协议、URL 里夹带的凭据、非标准端口，
 *      以及"白名单非空时名单外的主机"，全部拒掉。
 *   3. 上限 —— 请求体过大 413、上游超时 504、上游 500 原样透传但剥掉
 *      set-cookie / location / authorization 回声。
 *   4. 限流 —— 每分钟配额用完 429 带 Retry-After，并发满 503。
 *   5. 流式 —— 逐块回传，不在内存里攒。
 *   6. 不留痕 —— 审计行里没有 Key、没有请求体；data/ 目录一个字节没变。
 *
 * 跑法：node --experimental-strip-types scripts/relay-check.ts
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayHandler, isPrivateAddress } from "../src/server/llm-relay.ts";
import type { RelayHandler, RelayRequest } from "../src/server/llm-relay.ts";

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

const API_KEY = "sk-relay-check-SECRET-9f3a2b";
const PROMPT_TEXT = "这一段不该出现在任何日志里 · prompt-secret-4c7d1e";
const UPSTREAM_PORT = { value: 0 };
const RELAY_PORT = { value: 0 };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(repoRoot, "data");

/** 审计行按实例分开存，方便逐项断言。 */
const audits = new Map<string, string[]>();
function auditSink(name: string): (line: string) => void {
	return (line: string) => {
		const list = audits.get(name) ?? [];
		list.push(line);
		audits.set(name, list);
	};
}
function auditLines(name: string): string[] {
	return audits.get(name) ?? [];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 目录快照：相对路径 + 大小 + 修改时间。全程一样才叫"没动过"。 */
async function snapshot(dir: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(current: string, prefix: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			const rel = prefix ? prefix + "/" + entry.name : entry.name;
			if (entry.isDirectory()) {
				out.push(rel + "/");
				await walk(full, rel);
				continue;
			}
			try {
				const info = await stat(full);
				out.push(rel + "|" + info.size + "|" + info.mtimeMs);
			} catch {
				out.push(rel + "|missing");
			}
		}
	}
	await walk(dir, "");
	return out.sort();
}

// ─────────────────────────────────────────── 假上游

interface UpstreamEcho {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
	res.on("error", () => {
		/* 客户端被中继掐断时忽略。 */
	});
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		const url = new URL(req.url ?? "/", "http://upstream");
		if (url.pathname === "/echo") {
			const payload: UpstreamEcho = {
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: raw,
			};
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
			return;
		}
		if (url.pathname === "/slow") {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ slow: true }));
			}, 1500);
			return;
		}
		if (url.pathname === "/stream") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write("data: 1\n\n");
			setTimeout(() => {
				res.write("data: 2\n\n");
				setTimeout(() => res.end("data: [DONE]\n\n"), 30);
			}, 30);
			return;
		}
		if (url.pathname === "/fail") {
			const auth = req.headers.authorization ?? "";
			const bare = auth.replace(/^Bearer\s+/i, "");
			res.writeHead(500, {
				"content-type": "application/json",
				"set-cookie": "session=upstream-secret; Path=/",
				"location": "https://evil.example/steal",
				authorization: "Bearer " + bare,
				"x-api-key": bare,
			});
			res.end(JSON.stringify({ error: { message: "upstream boom" } }));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});
});

// ─────────────────────────────────────────── 套着中继的 HTTP 服务器

const instances = new Map<string, RelayHandler>();

interface Wire {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	json: any;
}

async function handleRelayRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	const url = new URL(req.url ?? "/", "http://relay");
	const name = (url.pathname.replace(/^\/r\//, "") || "").trim();
	const handler = instances.get(name);
	if (!handler) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "no such relay instance" }));
		return;
	}
	let parsed: Record<string, unknown> = {};
	try {
		parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		parsed = {};
	}
	const requestHeaders: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		requestHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	const relayRequest: RelayRequest = {
		target: typeof parsed["target"] === "string" ? parsed["target"] : "",
		apiKey: typeof parsed["apiKey"] === "string" ? parsed["apiKey"] : "",
		authHeader: typeof parsed["authHeader"] === "string" ? parsed["authHeader"] : undefined,
		authScheme: typeof parsed["authScheme"] === "string" ? parsed["authScheme"] : undefined,
		headers: parsed["headers"] as Record<string, string> | undefined,
		body: parsed["body"],
		requestHeaders,
		method: typeof parsed["method"] === "string" ? parsed["method"] : req.method,
	};
	// 限流按来源 IP 分桶 —— 走真实 socket，拿到的就是真实来源地址。
	const clientKey = req.socket.remoteAddress ?? "unknown";
	const outcome = await handler(relayRequest, clientKey);

	let streamBase64: string | undefined;
	if (outcome.stream) {
		const parts: Buffer[] = [];
		for await (const chunk of outcome.stream.stream) parts.push(Buffer.from(chunk));
		streamBase64 = Buffer.concat(parts).toString("base64");
	}
	const payload = JSON.stringify({
		ok: outcome.ok,
		status: outcome.status,
		headers: outcome.headers ?? {},
		body: outcome.body,
		error: outcome.error,
		streamBase64,
	});
	const outHeaders: Record<string, string> = {};
	for (const [key, value] of Object.entries(outcome.headers ?? {})) {
		if (typeof value === "string") outHeaders[key] = value;
	}
	outHeaders["content-type"] = "application/json; charset=utf-8";
	if (outcome.status === 204) {
		res.writeHead(204, outHeaders);
		res.end();
		return;
	}
	res.writeHead(outcome.status, outHeaders);
	res.end(payload);
}

const relayServer = createServer((req: IncomingMessage, res: ServerResponse) => {
	void handleRelayRequest(req, res);
});

function post(
	instance: string,
	payload: unknown,
	extraHeaders: Record<string, string> = {},
	method = "POST",
): Promise<Wire> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(payload);
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: RELAY_PORT.value,
				path: "/r/" + instance,
				method,
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(data),
					...extraHeaders,
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json: any = undefined;
					try {
						json = text ? JSON.parse(text) : undefined;
					} catch {
						json = undefined;
					}
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers as Record<string, string | string[] | undefined>,
						json,
					});
				});
			},
		);
		req.on("error", reject);
		req.end(data);
	});
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("拿不到端口"));
		});
	});
}

// ─────────────────────────────────────────── 开跑

const before = await snapshot(dataDir);
const tempDir = await mkdtemp(path.join(tmpdir(), "novel-relay-"));
await writeFile(path.join(tempDir, "probe.txt"), "sentinel", "utf8");

UPSTREAM_PORT.value = await listen(upstream);
const upstreamBase = "http://127.0.0.1:" + UPSTREAM_PORT.value;
const upstreamAllowed = "127.0.0.1:" + UPSTREAM_PORT.value;

instances.set(
	"main",
	createRelayHandler({
		allowedHosts: [upstreamAllowed],
		maxRequestBytes: 1024 * 1024,
		requestsPerMinute: 600,
		maxInflight: 8,
		timeoutMs: 10_000,
		audit: auditSink("main"),
	}),
);
instances.set(
	"small",
	createRelayHandler({
		allowedHosts: [upstreamAllowed],
		maxRequestBytes: 1024,
		requestsPerMinute: 600,
		maxInflight: 8,
		timeoutMs: 10_000,
		audit: auditSink("small"),
	}),
);
instances.set(
	"limit",
	createRelayHandler({
		allowedHosts: [upstreamAllowed],
		maxRequestBytes: 1024 * 1024,
		requestsPerMinute: 2,
		maxInflight: 8,
		timeoutMs: 10_000,
		audit: auditSink("limit"),
	}),
);
instances.set(
	"slow",
	createRelayHandler({
		allowedHosts: [upstreamAllowed],
		maxRequestBytes: 1024 * 1024,
		requestsPerMinute: 600,
		maxInflight: 8,
		timeoutMs: 300,
		audit: auditSink("slow"),
	}),
);
instances.set(
	"busy",
	createRelayHandler({
		allowedHosts: [upstreamAllowed],
		maxRequestBytes: 1024 * 1024,
		requestsPerMinute: 600,
		maxInflight: 1,
		timeoutMs: 10_000,
		audit: auditSink("busy"),
	}),
);
// 白名单为空 = 任何公开 https 主机都可以；用来验证内网目标照样被拒。
instances.set(
	"open",
	createRelayHandler({
		allowedHosts: [],
		maxRequestBytes: 1024 * 1024,
		requestsPerMinute: 600,
		maxInflight: 8,
		timeoutMs: 10_000,
		audit: auditSink("open"),
	}),
);
// 白名单非空 = 只放行名单里的主机。
instances.set(
	"strict",
	createRelayHandler({
		allowedHosts: ["api.openai.com"],
		maxRequestBytes: 1024 * 1024,
		requestsPerMinute: 600,
		maxInflight: 8,
		timeoutMs: 10_000,
		audit: auditSink("strict"),
	}),
);

RELAY_PORT.value = await listen(relayServer);

console.log("\n一、正常转发");
{
	const res = await post("main", {
		target: upstreamBase + "/echo",
		apiKey: API_KEY,
		headers: { "x-custom": "abc", "anthropic-version": "2023-06-01" },
		body: { prompt: PROMPT_TEXT, model: "test-model" },
	});
	check("请求转到上游并拿到 200", res.status === 200 && res.json?.status === 200, "status=" + res.status);
	const upstreamHeaders = res.json?.body?.headers ?? {};
	check("请求体原样送到上游", String(res.json?.body?.body ?? "").includes(PROMPT_TEXT));
	check(
		"鉴权头按 Bearer 发到上游",
		String(upstreamHeaders["authorization"] ?? "") === "Bearer " + API_KEY,
		String(upstreamHeaders["authorization"] ?? ""),
	);
	check("附加请求头也送到了", String(upstreamHeaders["x-custom"] ?? "") === "abc");
	check(
		"响应头带 CORS 放行",
		String(res.headers["access-control-allow-origin"] ?? "") === "*",
		String(res.headers["access-control-allow-origin"] ?? ""),
	);
}
{
	const res = await post("main", {
		target: upstreamBase + "/echo",
		apiKey: API_KEY,
		authHeader: "x-api-key",
		authScheme: "",
		body: { prompt: "hi" },
	});
	const upstreamHeaders = res.json?.body?.headers ?? {};
	check(
		"x-api-key 方式可用（无 Bearer 前缀）",
		String(upstreamHeaders["x-api-key"] ?? "") === API_KEY,
		String(upstreamHeaders["x-api-key"] ?? ""),
	);
	check(
		"换头名时不再发 authorization",
		upstreamHeaders["authorization"] === undefined,
		String(upstreamHeaders["authorization"] ?? ""),
	);
}

const modelList = await post("main", {
	target: `${upstreamBase}/echo?source=models`,
	apiKey: API_KEY,
	method: "GET",
});
const modelListBody = modelList.json?.body ?? undefined;
check("中继 GET 真正到达上游", modelList.status === 200 && modelListBody?.method === "GET");
check("模型列表 GET 的查询串保留", modelListBody?.url === "/echo?source=models");
check("模型列表 GET 不附带请求体", (modelListBody?.body ?? "") === "");
const rejectedMethod = await post("main", { target: `${upstreamBase}/echo`, apiKey: API_KEY, method: "DELETE" });
check("除 GET/POST 以外的方法被 405 拒绝", rejectedMethod.status === 405, JSON.stringify(rejectedMethod.json));

console.log("\n二、SSRF 一律挡下");
{
	const cases: Array<[string, string]> = [
		["回环地址", "https://127.0.0.1/echo"],
		["回环地址带端口", "https://127.0.0.1:" + UPSTREAM_PORT.value + "/echo"],
		["云元数据地址", "https://169.254.169.254/latest/meta-data/"],
		["内网 192.168", "https://192.168.1.10/admin"],
		["内网 10.x", "https://10.0.0.5/admin"],
		["内网 172.16", "https://172.16.3.4/admin"],
		["CGNAT 段", "https://100.64.0.1/admin"],
		["IPv6 回环", "https://[::1]/admin"],
		["IPv6 唯一本地", "https://[fd00::1]/admin"],
		["组播", "https://224.0.0.1/admin"],
		["http 协议", "http://127.0.0.1/echo"],
		["file 协议", "file:///etc/passwd"],
		["gopher 协议", "gopher://127.0.0.1:11211/_stats"],
		["URL 里夹带凭据", "https://user:pass@example.com/v1"],
		["非标准端口", "https://example.com:8080/v1"],
	];
	for (const [label, target] of cases) {
		const res = await post("open", { target, apiKey: API_KEY, body: { prompt: "x" } });
		check("拒绝：" + label, res.json?.status === 400, "status=" + res.json?.status + " " + (res.json?.error ?? ""));
	}
}
{
	const res = await post("strict", { target: "https://api.anthropic.com/v1/messages", apiKey: API_KEY });
	check("白名单非空时名单外主机被拒", res.json?.status === 400, "status=" + res.json?.status);
	const res2 = await post("strict", { target: upstreamBase + "/echo", apiKey: API_KEY });
	check("白名单非空时内网主机也被拒", res2.json?.status === 400, "status=" + res2.json?.status);
}
{
	const res = await post("open", { target: "https://localhost/echo", apiKey: API_KEY });
	check("解析到回环的主机名被拒", res.json?.status !== 200, "status=" + res.json?.status);
}
{
	check("私网判定：127.0.0.1 是内网", isPrivateAddress("127.0.0.1") === true);
	check("私网判定：10.1.2.3 是内网", isPrivateAddress("10.1.2.3") === true);
	check("私网判定：169.254.169.254 是内网", isPrivateAddress("169.254.169.254") === true);
	check("私网判定：100.64.0.1 是内网", isPrivateAddress("100.64.0.1") === true);
	check("私网判定：::1 是内网", isPrivateAddress("::1") === true);
	check("私网判定：fd00::1 是内网", isPrivateAddress("fd00::1") === true);
	check("私网判定：8.8.8.8 是公网", isPrivateAddress("8.8.8.8") === false);
	check("私网判定：1.1.1.1 是公网", isPrivateAddress("1.1.1.1") === false);
	check("私网判定：看不懂的地址按内网处理", isPrivateAddress("not-an-ip") === true);
}

console.log("\n三、上限与错误码");
{
	const res = await post("small", {
		target: upstreamBase + "/echo",
		apiKey: API_KEY,
		body: { prompt: "x".repeat(4096) },
	});
	check("请求体过大返回 413", res.json?.status === 413, "status=" + res.json?.status);
}
{
	const res = await post("slow", { target: upstreamBase + "/slow", apiKey: API_KEY, body: { prompt: "x" } });
	check("上游超时返回 504", res.json?.status === 504, "status=" + res.json?.status);
}
{
	const res = await post("main", { target: upstreamBase + "/fail", apiKey: API_KEY, body: { prompt: "x" } });
	check("上游 500 原样透传", res.json?.status === 500, "status=" + res.json?.status);
	const headers = res.json?.headers ?? {};
	check("透传时剥掉 set-cookie", headers["set-cookie"] === undefined);
	check("透传时剥掉 location", headers["location"] === undefined);
	check("透传时剥掉 authorization 回声", headers["authorization"] === undefined);
	check("透传时剥掉 x-api-key 回声", headers["x-api-key"] === undefined);
	check(
		"剥过之后响应头里没有 Key",
		!Object.values(headers).some((value: unknown) => String(value).includes(API_KEY)),
	);
}

console.log("\n四、限流与并发");
{
	const first = await post("limit", { target: upstreamBase + "/echo", apiKey: API_KEY, body: { prompt: "1" } });
	const second = await post("limit", { target: upstreamBase + "/echo", apiKey: API_KEY, body: { prompt: "2" } });
	const third = await post("limit", { target: upstreamBase + "/echo", apiKey: API_KEY, body: { prompt: "3" } });
	check("配额内的请求照常通过", first.json?.status === 200 && second.json?.status === 200);
	check("超出每分钟配额返回 429", third.json?.status === 429, "status=" + third.json?.status);
	check(
		"429 带 Retry-After",
		typeof third.json?.headers?.["retry-after"] === "string" && Number(third.json.headers["retry-after"]) >= 1,
		String(third.json?.headers?.["retry-after"] ?? ""),
	);
}
{
	const running = post("busy", { target: upstreamBase + "/slow", apiKey: API_KEY, body: { prompt: "x" } });
	await sleep(120);
	const second = await post("busy", { target: upstreamBase + "/slow", apiKey: API_KEY, body: { prompt: "y" } });
	const first = await running;
	const statuses = [first.json?.status, second.json?.status].sort();
	check("并发满时后来的请求拿到 503", statuses.includes(503), JSON.stringify(statuses));
	check("先来的那个正常完成", statuses.includes(200), JSON.stringify(statuses));
}

console.log("\n五、流式");
{
	const res = await post("main", {
		target: upstreamBase + "/stream",
		apiKey: API_KEY,
		body: { stream: true, prompt: PROMPT_TEXT },
	});
	const text = Buffer.from(String(res.json?.streamBase64 ?? ""), "base64").toString("utf8");
	check("流式请求返回 200", res.json?.status === 200, "status=" + res.json?.status);
	check("流式拿到完整事件流", text.includes("data: 1") && text.includes("data: 2") && text.includes("[DONE]"), text.slice(0, 120));
	check("流式响应保留 SSE 类型", String(res.json?.headers?.["content-type"] ?? "").includes("text/event-stream"));
}
{
	const res = await post("main", {
		target: upstreamBase + "/stream",
		apiKey: API_KEY,
		body: { prompt: "x" },
	}, { accept: "text/event-stream" });
	const text = Buffer.from(String(res.json?.streamBase64 ?? ""), "base64").toString("utf8");
	check("Accept: text/event-stream 也走流式", text.includes("data: 2"), text.slice(0, 120));
}
{
	const res = await post("main", { target: upstreamBase + "/echo", apiKey: API_KEY, body: { prompt: "x" } });
	check("非流式请求没有字节流", res.json?.streamBase64 === undefined);
}

console.log("\n六、CORS");
{
	const res = await post("main", { target: upstreamBase + "/echo", apiKey: API_KEY }, { origin: "http://localhost:5173" }, "OPTIONS");
	check("预检返回 204", res.status === 204, "status=" + res.status);
	check("预检放行 GET、POST 与 OPTIONS", String(res.headers["access-control-allow-methods"] ?? "").includes("POST"));
	check("预检回显请求头清单", String(res.headers["access-control-allow-headers"] ?? "").includes("content-type"));
	check("预检带放行来源", res.headers["access-control-allow-origin"] !== undefined);
}

console.log("\n七、不留痕");
{
	const allLines = [...audits.values()].flat();
	check("审计行不为空", allLines.length > 0, "共 " + allLines.length + " 行");
	check("审计行里没有 API Key", !allLines.some((line) => line.includes(API_KEY)));
	check("审计行里没有请求正文", !allLines.some((line) => line.includes(PROMPT_TEXT)));
	const sample = auditLines("main")[0] ?? "";
	check("审计行有客户端哈希", /client=[0-9a-f]{8}/.test(sample), sample);
	check("审计行有上游主机", /host=\S+/.test(sample), sample);
	check("审计行有路径", /path=\S*/.test(sample), sample);
	check("审计行有状态码", /status=\d{3}/.test(sample), sample);
	check("审计行有耗时", /ms=\d+/.test(sample), sample);
	check("审计行有字节数", /bytes=\d+/.test(sample), sample);
}
{
	const relaySource = await readFile(path.join(repoRoot, "src/server/llm-relay.ts"), "utf8");
	check("中继源码没有引入文件模块", !/node:fs/.test(relaySource));
	check("中继源码没有写文件调用", !/writeFile|appendFile|createWriteStream|mkdir/.test(relaySource));
}
{
	const after = await snapshot(dataDir);
	const same = before.length === after.length && before.every((line, index) => line === after[index]);
	check("data/ 目录一个字节没变", same, "变化前 " + before.length + " 项 / 变化后 " + after.length + " 项");
	const probe = await readFile(path.join(tempDir, "probe.txt"), "utf8");
	check("临时目录可写（证明不是被沙箱挡住了）", probe === "sentinel");
}

relayServer.closeAllConnections?.();
upstream.closeAllConnections?.();
await new Promise<void>((resolve) => relayServer.close(() => resolve()));
await new Promise<void>((resolve) => upstream.close(() => resolve()));
await rm(tempDir, { recursive: true, force: true });

console.log(failed === 0 ? "\n全部通过" : "\n有 " + failed + " 项没过");
if (failed > 0) process.exitCode = 1;
