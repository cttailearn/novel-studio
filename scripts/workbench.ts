/**
 * 工作台接口集成测试：真起一个服务进程，走真实 HTTP。
 *
 * 前面的 smoke 测的是纯函数与工具链路，这里补上服务端契约 ——
 * 上传、素材增删改、章节装料这些端点，前端全靠它们。
 * 不需要任何 API Key：需要模型的分支只验证前置校验的报错。
 *
 * 运行：pnpm test:server
 */
import { spawn } from "node:child_process";
import dns from "node:dns";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createProbeServer, connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(label: string, condition: boolean, extra = ""): void {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label} ${extra}`);
	}
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(tmpdir(), "novel-studio-workbench-"));

/**
 * 预置一份工程文件。章目只能由设定官经 update_outline 建立，
 * 服务端没有直接建章的接口，所以集成测试从一份落盘的工程起步。
 */
const seedId = "seed-project";
const seed = {
	id: seedId,
	title: "种子工程",
	genre: "悬疑",
	materials: [
		{ id: "seed-mat-1", kind: "character", title: "裴渡", content: "水上巡防的老手。", usage: "他在场的戏", tags: ["主角"], chapterIds: [], status: "confirmed", source: "human", createdAt: 1, updatedAt: 1 },
		{ id: "seed-mat-2", kind: "world", title: "黑水汊", content: "野渡的规矩：只数人头，不认人脸。", usage: "交代渡口", tags: [], chapterIds: [], status: "draft", source: "agent", createdAt: 1, updatedAt: 1 },
	],
	outline: [
		{ id: "ch01", title: "核载二十人", summary: "开场", pov: "裴渡", status: "planned", targetWords: 4000, notes: "", materialIds: [] },
		{ id: "ch02", title: "对数的人", summary: "第二场", pov: "", status: "planned", targetWords: 0, notes: "", materialIds: [] },
	],
};
await writeFile(path.join(dir, seedId + ".json"), JSON.stringify(seed, null, 2), "utf8");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createProbeServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

// ------------------------------------------------------------------ 假上游
//
// 客户端断开要真的把上游请求掐掉，而真实模型需要 Key 与网络。这里起一个
// OpenAI Chat Completions 兼容的本地假上游：回一段持续输出的 SSE，
// 只要消费者断开，服务端那侧的连接就会关掉 —— 正好用来断言"中止真的传到了上游"。
//
// 假上游有四种说话方式：
//   stream —— 持续吐字，不给 finish_reason，也不结束流（默认，用来测中止）。
//   ask    —— 先回一个 ask_user 工具调用；收到带着工具结果的第二轮请求时
//              再回一句话，把整轮收干净（用来测"智能体向作者提问"）。
//   write  —— 第一轮回一个 write_chapter 工具调用（固定正文），第二轮收尾；
//              用来在不碰真模型的前提下落下一版可被局部修改的正文。
//   patch  —— 第一轮回一个 revise_chapter 工具调用（只换 patchTarget 指的那一处），
//              第二轮收尾；用来端到端验证"只改几处，其余一字不动"。
const mockPort = await freePort();
let upstreamHits = 0;
const upstreamBodies: string[] = [];
let mockMode: "stream" | "ask" | "write" | "patch" | "chat" = "stream";
let resolveUpstreamClosed: () => void = () => undefined;
const upstreamClosed = new Promise<void>((resolve) => {
	resolveUpstreamClosed = resolve;
});
const ASK_QUESTION = "主角叫什么，出身如何？";
const ASK_OPTIONS = ["沈砚，寒门", "陆昭，世家"];
// 成文与局部修改共用的固定正文：留一段唯一好认的原文，才能断言"只动了这一处"。
const WRITE_BODY = [
	"裴渡在渡口数人头，数到第十九个就停了。",
	"老周把船缆绕在桩上，等一个不来的客人。",
	"江面起了雾，雾里没有第二条船。",
].join("\n\n");
const PATCH_FIND = "数到第十九个就停了。";
const PATCH_REPLACE = "数到第二十个才停。";
// 局部修改可以指向别的章（比如没装料的空渡章），所以目标由用例在发请求前设定。
let patchTarget = { chapterId: "ch01", find: PATCH_FIND, replace: PATCH_REPLACE };
const mockServer = createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	upstreamHits += 1;
	// 连接一断就报上去：客户端关页时，服务端那侧的请求必须跟着断。
	let timer: NodeJS.Timeout | undefined;
	res.on("close", () => {
		if (timer) clearInterval(timer);
		resolveUpstreamClosed();
	});
	const send = (delta: Record<string, unknown>, finishReason: string | null = null) => {
		if (res.writableEnded) return;
		res.write(
			"data: " +
				JSON.stringify({
					id: "mock-1",
					object: "chat.completion.chunk",
					created: Date.now(),
					model: "mock",
					choices: [{ index: 0, delta, finish_reason: finishReason }],
				}) +
				"\n\n",
		);
	};
	/** 收尾：给 finish_reason，再发 [DONE]，然后关掉这条流。 */
	const finish = (reason: string) => {
		send({}, reason);
		res.write("data: [DONE]\n\n");
		res.end();
	};
	if (mockMode === "ask") {
		// 提问那一轮要看清请求里有没有工具结果，才知道该发问还是该收尾。
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			upstreamBodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
			let hasToolResult = false;
			try {
				const parsed = JSON.parse(body) as { messages?: { role?: string }[] };
				hasToolResult = (parsed.messages ?? []).some((message) => message.role === "tool");
			} catch {
				// 解析不出就当没有工具结果，照常发问。
			}
			if (!hasToolResult) {
				// 第一轮：向作者发问。arguments 必须是一整段 JSON 字符串。
				send({
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_ask_1",
							type: "function",
							function: {
								name: "ask_user",
								arguments: JSON.stringify({ question: ASK_QUESTION, options: ASK_OPTIONS }),
							},
						},
					],
				});
				finish("tool_calls");
				return;
			}
			// 第二轮：作者已经回话，工具结果也回来了，收一句话把这一轮了结。
			send({ role: "assistant", content: "" });
			send({ content: "记下了，接着办。" });
			finish("stop");
		});
		return;
	}
	if (mockMode === "write" || mockMode === "patch") {
		// 成文与局部修改都是两轮：第一轮给工具调用，收到工具结果后第二轮收尾。
		// "第几轮"只看请求里有没有工具结果 —— 服务端不额外喂标记，协议本身就能分。
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			upstreamBodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
			let hasToolResult = false;
			try {
				const parsed = JSON.parse(body) as { messages?: { role?: string }[] };
				hasToolResult = (parsed.messages ?? []).some((message) => message.role === "tool");
			} catch {
				// 解析不出就当第一轮，照常发工具调用。
			}
			if (!hasToolResult) {
				const call =
					mockMode === "write"
						? {
							id: "call_write_1",
							name: "write_chapter",
							arguments: { chapterId: "ch01", title: "核载二十人", content: WRITE_BODY, mode: "create" },
						}
						: {
							id: "call_patch_1",
							name: "revise_chapter",
							arguments: { chapterId: patchTarget.chapterId, find: patchTarget.find, replace: patchTarget.replace },
						};
				// 工具调用的每一片都必须带 index / id / type / function.name，
				// arguments 是整段 JSON 字符串；少了任何一样，pi-ai 都拼不出这次调用。
				send({
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: call.id,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.arguments) },
						},
					],
				});
				finish("tool_calls");
				return;
			}
			send({ role: "assistant", content: "" });
			send({ content: mockMode === "write" ? "本章已写完。" : "只改了那一句，其余没动。" });
			finish("stop");
		});
		return;
	}
	if (mockMode === "chat") {
		req.resume();
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
		send({ role: "assistant", content: "" });
		send({ content: "我想好了，但没有写入正文。" });
		finish("stop");
		return;
	}
	req.resume();
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
	send({ role: "assistant", content: "" });
	send({ content: "正在写。" });
	timer = setInterval(() => send({ content: "……" }), 100);
});
await new Promise<void>((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

// DeepSeek Search 本地替身：拦截 DNS，只让测试进程访问，不泄露真实密钥或访问外网。
const searchPort = await freePort();
const searchRequests: Array<{ auth: string; body: string }> = [];
const searchServer = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		searchRequests.push({ auth: String(req.headers.authorization ?? ""), body });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ results: [{ title: "渡口旧制", url: "https://example.com/ferry", snippet: "渡口旧制摘要", summary: "旧时渡口的公开资料。", content: "" }] }));
	});
});
await new Promise<void>((resolve) => searchServer.listen(searchPort, "127.0.0.1", resolve));
process.env.DEEPSEEK_API_KEY = "test-web-key";
const originalLookup = dns.lookup;
dns.lookup = ((hostname: string, options: any, callback: any) => {
	if (hostname === "api.deepseek.com") return originalLookup("127.0.0.1", options, callback);
	return originalLookup(hostname, options, callback);
}) as typeof dns.lookup;

// 设置页的自定义供应商指向假上游：有它才能在无 Key、无外网的测试里走通生成链路。
await writeFile(
	path.join(dir, "settings.json"),
	JSON.stringify(
		{
			version: 1,
			// 不设默认模型：已有的"无可用模型"断言依赖默认模型为空；
			// 需要假上游的用例会显式传 modelRef。
			defaultModel: "",
			defaultThinkingLevel: "off",
			providers: [
				{
					id: "mock",
					label: "本地假上游",
					kind: "custom",
					baseUrl: `http://127.0.0.1:${mockPort}/v1`,
					api: "openai-completions",
					noAuthRequired: true,
					models: [
						{
							id: "mock",
							name: "mock",
							contextWindow: 100_000,
							maxTokens: 4_000,
							reasoning: false,
							thinkingLevels: ["off"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
					enabled: true,
					updatedAt: 0,
				},
			],
		},
		null,
		2,
	),
	"utf8",
);

// 子进程日志写文件而不是接管道：受限环境里命名管道可能不可用
// （spawn 默认 stdio:"pipe" 会 EPERM），文件描述符在 Windows 与沙箱里都更稳。
const logOut = path.join(dir, "server.out.log");
const logErr = path.join(dir, "server.err.log");
const outFd = openSync(logOut, "w");
const errFd = openSync(logErr, "w");

const child = spawn(process.execPath, ["--experimental-strip-types", "src/server/main.ts"], {
	cwd: root,
	env: {
		...process.env,
		PORT: String(port),
		HOST: "127.0.0.1",
		DATA_DIR: dir,
		DEFAULT_MODEL: "",
		// 别让仓库里的 .env 把端口与数据目录顶掉。
		NOVEL_STUDIO_ENV_FILE: path.join(dir, "absent.env"),
		DEEPSEEK_API_KEY: "test-web-key",
		DEEPSEEK_WEB_SEARCH_BASE_URL: `http://127.0.0.1:${searchPort}`,
	},
	stdio: ["ignore", outFd, errFd],
});
closeSync(outFd);
closeSync(errFd);

/** 子进程日志按需读：只有就绪失败或退出时才需要它。 */
function serverLog(): string {
	return readFileSync(logOut, "utf8") + readFileSync(logErr, "utf8");
}

interface Reply {
	status: number;
	data: Record<string, any>;
}

async function req(method: string, urlPath: string, body?: unknown, raw?: Buffer): Promise<Reply> {
	const res = await fetch(base + urlPath, {
		method,
		headers: raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" },
		body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
	});
	const text = await res.text();
	let data: Record<string, any> = {};
	try {
		data = JSON.parse(text) as Record<string, any>;
	} catch {
		data = { raw: text };
	}
	return { status: res.status, data };
}

/** 导出回的是纯文本，还要看响应头，所以不能走上面那个只认 JSON 的 req。 */
async function reqText(urlPath: string): Promise<{ status: number; text: string; disposition: string; type: string }> {
	const res = await fetch(base + urlPath);
	return {
		status: res.status,
		text: await res.text(),
		disposition: res.headers.get("content-disposition") ?? "",
		type: res.headers.get("content-type") ?? "",
	};
}

async function waitReady(timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("服务进程已退出：\n" + serverLog());
		try {
			const res = await fetch(base + "/api/bootstrap");
			if (res.ok) return;
		} catch {
			// 还没起来，接着等。
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("服务未在超时内就绪：\n" + serverLog());
}

/** 轮询等待某个条件成立，超时返回 false。 */
async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	return false;
}

/** 固定等待一段时间后给出 false，与 Promise.race 配合做超时。 */
function timeout(ms: number): Promise<boolean> {
	return new Promise((resolve) => setTimeout(() => resolve(false), ms));
}

/**
 * 直接发一段原始 HTTP 请求。
 *
 * fetch 造不出畸形请求行，也不会在声明超大 Content-Length 后只发头不发体；
 * 而这两件事正是入口加固要测的边界。
 */
function rawHttp(head: string, timeoutMs = 5_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => socket.write(head));
		let data = "";
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(data);
		}, timeoutMs);
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (data.includes("\r\n\r\n")) {
				clearTimeout(timer);
				socket.destroy();
				resolve(data);
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

/** 发起一次生成请求，读到第一段 NDJSON 即算开始；destroy 用来模拟关页/断网。 */
function streamSessionMessage(sessionId: string): { destroy: () => void; started: Promise<void> } {
	let resolveStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let settled = false;
	const client = httpRequest(base + `/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
	});
	client.on("response", (res) => {
		let buffer = "";
		res.on("data", (chunk) => {
			if (settled) return;
			buffer += chunk.toString("utf8");
			if (buffer.includes("\n")) {
				settled = true;
				resolveStarted();
			}
		});
		res.on("error", () => undefined);
	});
	// 客户端主动 destroy 后必然报错，这里不把它当测试失败。
	client.on("error", () => undefined);
	client.end(JSON.stringify({ input: "写点什么" }));
	return { destroy: () => client.destroy(), started };
}

/**
 * 读完一整条 NDJSON 流，中途遇到提问就当场回话。
 *
 * 提问是"流里插一句话"：智能体在工具里挂着等，作者的回答走另一条 HTTP 请求，
 * 答完这一轮才继续往下走。所以这里必须边读边答，不能先把流读完再说。
 */
async function streamSessionAnswering(
	sessionId: string,
	answer: string,
): Promise<{ events: Record<string, any>[]; questionId: string; answeredStatus: number }> {
	const res = await fetch(base + `/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: "帮我把这本书的设定立起来" }),
	});
	const events: Record<string, any>[] = [];
	let questionId = "";
	let answeredStatus = 0;
	const reader = res.body?.getReader();
	if (!reader) return { events, questionId, answeredStatus };
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let cut = buffer.indexOf("\n");
		while (cut >= 0) {
			const line = buffer.slice(0, cut).trim();
			buffer = buffer.slice(cut + 1);
			if (line) {
				const event = JSON.parse(line) as Record<string, any>;
				events.push(event);
				if (event.type === "question" && !questionId) {
					questionId = String(event.id ?? "");
					const reply = await fetch(base + `/api/questions/${questionId}/answer`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ answer }),
					});
					answeredStatus = reply.status;
				}
			}
			cut = buffer.indexOf("\n");
		}
	}
	return { events, questionId, answeredStatus };
}

/**
 * 跑一次 POST /chapters/:id/write，把整条 NDJSON 流读完。
 *
 * 一次性成文与局部修改都从这个接口起步：它不建常驻会话、不留历史。
 * 校验失败时回的是普通 JSON（400 / 404 / 409），成功时才是 NDJSON 事件流。
 */
async function streamWrite(
	projectId: string,
	chapterId: string,
	body: Record<string, unknown>,
): Promise<{ status: number; events: Record<string, any>[]; data: Record<string, any> }> {
	const res = await fetch(base + `/api/projects/${projectId}/chapters/${chapterId}/write`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		let data: Record<string, any> = {};
		try {
			data = JSON.parse(text) as Record<string, any>;
		} catch {
			data = { raw: text };
		}
		return { status: res.status, events: [], data };
	}
	const events: Record<string, any>[] = [];
	const reader = res.body?.getReader();
	if (!reader) return { status: res.status, events, data: {} };
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let cut = buffer.indexOf("\n");
		while (cut >= 0) {
			const line = buffer.slice(0, cut).trim();
			buffer = buffer.slice(cut + 1);
			if (line) events.push(JSON.parse(line) as Record<string, any>);
			cut = buffer.indexOf("\n");
		}
	}
	return { status: res.status, events, data: {} };
}

try {
	await waitReady();
	console.log("\n启动");
	check("服务已就绪", true);
	const bootstrap = await req("GET", "/api/bootstrap");
	check("bootstrap 列出种子工程", bootstrap.data.projects.some((p: any) => p.id === seedId));
	check("bootstrap 带出模型目录", Array.isArray(bootstrap.data.models));

	console.log("\n联网资料设置");
	const initialSettings = await req("GET", "/api/settings");
	check("联网检索默认关闭", initialSettings.data.webSearch?.enabled === false);
	check("环境密钥仅回传就绪状态", initialSettings.data.webSearch?.configured === true && !JSON.stringify(initialSettings.data).includes("test-web-key"));
	const webOn = await req("PUT", "/api/settings", { webSearch: { enabled: true, maxResults: 3, includeContent: false } });
	check("联网开关与结果数可保存", webOn.data.webSearch?.enabled === true && webOn.data.webSearch?.maxResults === 3);
	const webTest = await req("POST", "/api/settings/web-search/test");
	check("联网测试使用官方 Search 协议", webTest.status === 200 && searchRequests.length === 1);
	check("联网请求带 Bearer 鉴权与条数", searchRequests[0]?.auth === "Bearer test-web-key" && JSON.parse(searchRequests[0]?.body ?? "{}").count === 1);
	const webOff = await req("PUT", "/api/settings", { webSearch: { enabled: false } });
	check("联网检索可关闭", webOff.data.webSearch?.enabled === false);
	await req("POST", "/api/settings/web-search/test");
	check("关闭后不再发起网络搜索", searchRequests.length === 1);

	// ---- 入口与请求体加固 ----
	console.log("\n入口加固");
	// 畸形请求行曾让 new URL 在 createServer 回调里裸抛，直接带走整个进程。
	const malformed = await rawHttp("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
	check("畸形请求行返回 400", malformed.startsWith("HTTP/1.1 400"), malformed.split("\r\n")[0]);
	check("畸形请求后服务仍存活", (await req("GET", "/api/bootstrap")).status === 200);

	const badJson = await req("POST", "/api/projects", undefined, Buffer.from("{ 不是合法 JSON", "utf8"));
	check("坏 JSON 返回 400 而不是 500", badJson.status === 400, String(badJson.status) + " " + JSON.stringify(badJson.data));

	// 只发请求头、不真正传 9 MB：服务端应在读体之前就按 Content-Length 拒绝。
	const oversizedJson = await rawHttp(
		"POST /api/projects HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 9000000\r\nConnection: close\r\n\r\n",
	);
	check("JSON 请求体超 8MB 返回 413", oversizedJson.startsWith("HTTP/1.1 413"), oversizedJson.split("\r\n")[0]);

	const oversizedUpload = await rawHttp(
		"POST /api/uploads?filename=a.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: 40000000\r\nConnection: close\r\n\r\n",
	);
	check("上传声明超 32MB 返回 413", oversizedUpload.startsWith("HTTP/1.1 413"), oversizedUpload.split("\r\n")[0]);

	const storage = await req("GET", "/api/storage");
	check(
		"落盘状态同时给 pending 与 pendingChapters",
		Array.isArray(storage.data.pending) && typeof storage.data.pendingChapters === "object",
		JSON.stringify(storage.data),
	);

	// ---- 工程 ----
	console.log("\n工程");
	const created = await req("POST", "/api/projects", { title: "工作台测试", genre: "悬疑" });
	check("新建工程", created.status === 201 && Boolean(created.data.project?.id));
	const projectId = String(created.data.project.id);
	check("新工程素材为空", created.data.project.materials.length === 0);

	const missing = await req("GET", "/api/projects/does-not-exist");
	check("未知工程返回 404", missing.status === 404);

	// ---- 上传 ----
	console.log("\n上传原料");
	const upload = await req(
		"POST",
		`/api/projects/${projectId}/uploads?filename=${encodeURIComponent("人物表.md")}`,
		undefined,
		Buffer.from("# 裴渡\n\n二十九岁，水上巡防的老手。", "utf8"),
	);
	check("上传文本被解析", upload.status === 200 && upload.data.upload.text.includes("二十九岁"), JSON.stringify(upload.data));
	check("上传回报标题与字数", upload.data.upload.title === "人物表" && upload.data.upload.originalChars > 0);
	check("上传不落盘、不建素材", (await req("GET", `/api/projects/${projectId}`)).data.project.materials.length === 0);

	const badFormat = await req(
		"POST",
		`/api/projects/${projectId}/uploads?filename=${encodeURIComponent("a.pdf")}`,
		undefined,
		Buffer.from("%PDF-1.4", "utf8"),
	);
	check("不支持的格式返回 415", badFormat.status === 415 && String(badFormat.data.error).includes(".pdf"), JSON.stringify(badFormat.data));

	const noName = await req("POST", `/api/projects/${projectId}/uploads`, undefined, Buffer.from("x", "utf8"));
	check("缺少 filename 返回 400", noName.status === 400);

	const emptyFile = await req("POST", `/api/projects/${projectId}/uploads?filename=a.txt`, undefined, Buffer.alloc(0));
	check("空文件返回 400", emptyFile.status === 400);

	const uploadUnknown = await req("POST", "/api/projects/nope/uploads?filename=a.txt", undefined, Buffer.from("x", "utf8"));
	check("往不存在的工程上传返回 404", uploadUnknown.status === 404);

	// ---- 素材增删改 ----
	console.log("\n素材");
	const madeMaterial = await req("POST", `/api/projects/${projectId}/materials`, {
		kind: "character",
		title: "裴渡",
		content: "水上巡防的老手，二十九岁。",
		usage: "任何需要他在场的戏",
		tags: ["主角", "巡防"],
	});
	check("新建素材返回 201", madeMaterial.status === 201 && Boolean(madeMaterial.data.material?.id));
	const materialId = String(madeMaterial.data.material.id);
	check("作者所交的料记为已确认", madeMaterial.data.material.status === "confirmed");
	check("来源记为 human", madeMaterial.data.material.source === "human");
	check("统计随之更新", madeMaterial.data.stats.materials === 1);

	const noTitle = await req("POST", `/api/projects/${projectId}/materials`, { content: "只有内容" });
	check("缺标题返回 400", noTitle.status === 400);
	const noContent = await req("POST", `/api/projects/${projectId}/materials`, { title: "只有标题" });
	check("缺内容返回 400", noContent.status === 400);
	const badKind = await req("POST", `/api/projects/${projectId}/materials`, {
		kind: "不存在的种类",
		title: "兜底",
		content: "内容",
	});
	check("非法 kind 落到 other", badKind.status === 201 && badKind.data.material.kind === "other");

	const patched = await req("PATCH", `/api/projects/${projectId}/materials/${materialId}`, {
		title: "裴渡（改）",
		usage: "改过的用途",
	});
	check("改素材生效", patched.status === 200 && patched.data.material.title === "裴渡（改）");
	check("未传的字段保持原样", patched.data.material.content.includes("水上巡防"), JSON.stringify(patched.data.material));
	const patchMissing = await req("PATCH", `/api/projects/${projectId}/materials/ghost`, { title: "x" });
	check("改不存在的素材返回 404", patchMissing.status === 404);

	const listed = await req("GET", `/api/projects/${projectId}/materials?kind=character`);
	check("按 kind 过滤素材", listed.status === 200 && listed.data.materials.length === 1);
	const listedOther = await req("GET", `/api/projects/${projectId}/materials?kind=world`);
	check("过滤到空集也返回 200", listedOther.status === 200 && listedOther.data.materials.length === 0);
	check("接口带出 kind 目录", listed.data.kinds.length >= 13);

	// ---- 素材种类 ----
	// 内置十三种是笔法上的基本盘，但一本书常有自己的门类：势力、道具、民俗。
	// 这些料硬塞进「其他」就等于埋了 —— 检索、分组、筛选都靠 kind。
	console.log("\n素材种类");
	const kindCatalog = await req("GET", "/api/kinds");
	check("种类目录可读", kindCatalog.status === 200 && Array.isArray(kindCatalog.data.kinds));
	check("内置十三种都在", kindCatalog.data.kinds.filter((k: { builtin: boolean }) => k.builtin).length === 13);
	check("种类带显示名", kindCatalog.data.kinds.some((k: { kind: string; label: string }) => k.kind === "character" && k.label === "人物"));

	const madeKind = await req("POST", "/api/kinds", { label: "势力" });
	check("能添自建种类", madeKind.status === 201 && madeKind.data.kind === "势力", JSON.stringify(madeKind.data));
	check("添完目录里就有", madeKind.data.kinds.some((k: { kind: string }) => k.kind === "势力"));
	const dupKind = await req("POST", "/api/kinds", { label: "势力" });
	check("重名添不进去", dupKind.status === 400 && String(dupKind.data.error).includes("已经有"));
	const emptyKind = await req("POST", "/api/kinds", { label: "  " });
	check("空名添不进去", emptyKind.status === 400);

	const customMaterial = await req("POST", `/api/projects/${projectId}/materials`, {
		kind: "势力",
		title: "漕帮",
		content: "漕帮掌着黑水汊的夜航许可。",
	});
	check("自建种类能存进作品", customMaterial.status === 201 && customMaterial.data.material.kind === "势力", JSON.stringify(customMaterial.data.material?.kind));
	const customMaterialId = String(customMaterial.data.material.id);

	const counted = await req("GET", "/api/kinds");
	const faction = counted.data.kinds.find((k: { kind: string }) => k.kind === "势力");
	check("目录里算得出这一门有几条料", Boolean(faction) && faction.count >= 1, JSON.stringify(faction));

	const renamedKind = await req("PATCH", "/api/kinds/" + encodeURIComponent("势力"), { label: "帮会" });
	check("自建种类能改名", renamedKind.status === 200 && renamedKind.data.label === "帮会");
	check("改名不动 id（料还认得出这一门）", renamedKind.data.kind === "势力");
	check("内置种类不给改名", (await req("PATCH", "/api/kinds/character", { label: "人物" })).status === 400);
	check("内置种类不给删", (await req("DELETE", "/api/kinds/character")).status === 400);
	check("删不存在的种类回 404", (await req("DELETE", "/api/kinds/" + encodeURIComponent("没有这门"))).status === 404);

	const removedKind = await req("DELETE", "/api/kinds/" + encodeURIComponent("势力"));
	check("自建种类能删", removedKind.status === 200);
	check("删完回报被挪走的条数", removedKind.data.moved >= 1, "moved=" + removedKind.data.moved);
	const orphan = await req("GET", `/api/projects/${projectId}/materials`);
	const movedMaterial = orphan.data.materials.find((m: { id: string }) => m.id === customMaterialId);
	check("被删种类的料归到「其他」", Boolean(movedMaterial) && movedMaterial.kind === "other", JSON.stringify(movedMaterial?.kind));
	await req("DELETE", `/api/projects/${projectId}/materials/${customMaterialId}`);

	const bootWithKinds = await req("GET", "/api/bootstrap");
	check("开机数据里也带种类目录", Array.isArray(bootWithKinds.data.kinds) && bootWithKinds.data.kinds.length >= 13);

	// ---- 通用素材库 ----
	console.log("\n通用素材库");
	const emptyLibrary = await req("GET", "/api/library");
	check("库初始为空", emptyLibrary.status === 200 && emptyLibrary.data.materials.length === 0);
	check("库带出种类表", emptyLibrary.data.kinds.length >= 13);

	const libEntry = await req("POST", "/api/library", {
		kind: "character",
		title: "裴渡",
		content: "水上巡防的老手，二十九岁。",
		usage: "任何需要他在场的戏",
		tags: ["主角"],
	});
	check("新建通用素材返回 201", libEntry.status === 201 && Boolean(libEntry.data.material?.id));
	const libraryId = String(libEntry.data.material.id);
	check("库条目算已确认", libEntry.data.material.status === "confirmed");
	check("新建后回整份库视图", libEntry.data.materials.length === 1);
	check("尚无作品取用", libEntry.data.materials[0].usedBy.length === 0);

	const libNoTitle = await req("POST", "/api/library", { content: "只有内容" });
	check("库条目缺标题返回 400", libNoTitle.status === 400);
	const libNoContent = await req("POST", "/api/library", { title: "只有标题" });
	check("库条目缺内容返回 400", libNoContent.status === 400);

	const libPatched = await req("PATCH", `/api/library/${libraryId}`, { title: "裴渡（库改）" });
	check("改库条目生效", libPatched.status === 200 && libPatched.data.material.title === "裴渡（库改）");
	check("未传字段保持原样", libPatched.data.material.content.includes("水上巡防"));
	const libPatchGhost = await req("PATCH", "/api/library/ghost", { title: "x" });
	check("改不存在的库条目返回 404", libPatchGhost.status === 404);

	// ---- 新建作品时取用通用素材 ----
	console.log("\n取用通用素材");
	const withLibrary = await req("POST", "/api/projects", { title: "取料测试", libraryIds: [libraryId, "ghost-id"] });
	check("新建时取用返回 201", withLibrary.status === 201);
	check("取用得到副本（幽灵 id 被忽略）", withLibrary.data.project.materials.length === 1, JSON.stringify(withLibrary.data.project.materials));
	const copy = withLibrary.data.project.materials[0];
	const takeProjectId = String(withLibrary.data.project.id);
	check("副本是独立 id", copy.id !== libraryId);
	check("副本记下来源", copy.originId === libraryId);
	check("副本来源标为 library", copy.source === "library");
	check("副本内容与 usage 一致", copy.content.includes("水上巡防") && copy.usage.includes("他在场"));
	check("副本不带章节装配", copy.chapterIds.length === 0);

	const afterTake = await req("GET", "/api/library");
	check("库里记下被哪部作品取用", afterTake.data.materials[0].usedBy.length === 1, JSON.stringify(afterTake.data.materials[0].usedBy));
	check("取用记录带作品名", afterTake.data.materials[0].usedBy[0].title === "取料测试");

	// ---- 作品素材存回库 ----
	console.log("\n存回素材库");
	const promoted = await req("POST", `/api/projects/${takeProjectId}/materials/${copy.id}/library`, {
		mode: "update",
		title: "裴渡（推回）",
	});
	check("更新库条目返回 200", promoted.status === 200 && promoted.data.mode === "update");
	check("库条目被覆盖", promoted.data.material.title === "裴渡（推回）");

	const asNew = await req("POST", `/api/projects/${takeProjectId}/materials/${copy.id}/library`, {
		mode: "create",
		title: "裴渡（另存）",
	});
	check("另存为新条目返回 200", asNew.status === 200 && asNew.data.mode === "create");
	check("库里多出一条", asNew.data.materials.length === 2);
	const afterAsNew = await req("GET", `/api/projects/${takeProjectId}`);
	check(
		"另存后副本的来源改指新条目",
		afterAsNew.data.project.materials.find((m: any) => m.id === copy.id).originId === asNew.data.material.id,
	);

	// 没有来源条目的作品素材：update 该被拒，create 仍可以。
	const plain = await req("POST", `/api/projects/${takeProjectId}/materials`, {
		kind: "other",
		title: "无来源",
		content: "内容",
	});
	const plainId = String(plain.data.material.id);
	const badUpdate = await req("POST", `/api/projects/${takeProjectId}/materials/${plainId}/library`, { mode: "update" });
	check("无来源条目时 update 返回 409", badUpdate.status === 409, JSON.stringify(badUpdate.data));
	const okCreate = await req("POST", `/api/projects/${takeProjectId}/materials/${plainId}/library`, { mode: "create" });
	check("无来源条目仍可新建", okCreate.status === 200 && okCreate.data.mode === "create");
	const promoteGhost = await req("POST", `/api/projects/${takeProjectId}/materials/ghost/library`, {});
	check("存不存在的素材返回 404", promoteGhost.status === 404);
	const promoteGhostProject = await req("POST", "/api/projects/nope/materials/x/library", {});
	check("存进不存在的工程返回 404", promoteGhostProject.status === 404);

	// ---- 卷宗管理 ----
	console.log("\n卷宗");
	const projectList = await req("GET", "/api/projects");
	check("作品列表带统计", projectList.data.projects.every((p: any) => typeof p.stats?.chapters === "number"));
	check("作品列表带 logline 与规约字段", projectList.data.projects.every((p: any) => "logline" in p && "styleGuide" in p));
	check("library.json 没被当成作品", projectList.data.projects.every((p: any) => p.id !== "library"));

	const projectPatched = await req("PATCH", `/api/projects/${takeProjectId}`, {
		title: "取料测试（改）",
		targetWords: 12345,
	});
	check("改作品信息生效", projectPatched.status === 200 && projectPatched.data.project.title === "取料测试（改）");
	check("改作品保留素材", projectPatched.data.project.materials.length >= 2, String(projectPatched.data.project.materials.length));
	check("改作品字数目标", projectPatched.data.project.targetWords === 12345);
	const patchGhostProject = await req("PATCH", "/api/projects/nope", { title: "x" });
	check("改不存在的作品返回 404", patchGhostProject.status === 404);

	const projectDeleted = await req("DELETE", `/api/projects/${takeProjectId}`);
	check("删作品返回 200", projectDeleted.status === 200);
	check("删后取不到该作品", (await req("GET", `/api/projects/${takeProjectId}`)).status === 404);
	const usageAfterDelete = await req("GET", "/api/library");
	check(
		"删作品后取用记录跟着消失",
		usageAfterDelete.data.materials.every((m: any) => m.usedBy.every((u: any) => u.projectId !== takeProjectId)),
		JSON.stringify(usageAfterDelete.data.materials.map((m: any) => m.usedBy)),
	);
	check("删作品不动素材库", usageAfterDelete.data.materials.length === 3, String(usageAfterDelete.data.materials.length));
	const trash = await req("GET", "/api/projects/trash");
	check("删除的作品进入回收站", trash.status === 200 && trash.data.projects.some((entry: any) => entry.id === takeProjectId), JSON.stringify(trash.data));
	const restored = await req("POST", `/api/projects/trash/${takeProjectId}/restore`);
	check("回收站可恢复作品与素材", restored.status === 200 && restored.data.project.materials.length > 0, JSON.stringify(restored.data));
	check("恢复后能重新取到作品", (await req("GET", `/api/projects/${takeProjectId}`)).status === 200);
	await req("DELETE", `/api/projects/${takeProjectId}`);

	// ---- 删库条目：作品手里的副本不受影响 ----
	const libRemoved = await req("DELETE", `/api/library/${libraryId}`);
	check("删库条目返回 200", libRemoved.status === 200);
	check("重复删库条目返回 404", (await req("DELETE", `/api/library/${libraryId}`)).status === 404);
	const seedStillThere = await req("GET", `/api/projects/${seedId}`);
	check("删库条目不影响已有作品", seedStillThere.data.project.materials.length === 2, String(seedStillThere.data.project.materials.length));

	// ---- 立章：作者自己加一章（此前章节只能由设定官产出）----
	console.log("\n立章");
	check("立章缺标题返回 400", (await req("POST", `/api/projects/${seedId}/chapters`, { summary: "只有要点" })).status === 400);
	check("往不存在的作品立章返回 404", (await req("POST", "/api/projects/nope/chapters", { title: "第一章" })).status === 404);

	const beforeOutline = (await req("GET", `/api/projects/${seedId}`)).data.project.outline.length;
	const made = await req("POST", `/api/projects/${seedId}/chapters`, {
		title: "第三章 空渡",
		summary: "老周在渡口等一个不来的客人。",
		targetWords: 3000,
	});
	check("立章返回 201", made.status === 201, String(made.status));
	const afterOutline = (await req("GET", `/api/projects/${seedId}`)).data.project.outline;
	check("立章后章数 +1", afterOutline.length === beforeOutline + 1, String(afterOutline.length));
	check("新章已落盘", afterOutline.some((c: any) => c.id === made.data.chapter.id));
	check("新章标题正确", made.data.chapter.title === "第三章 空渡", made.data.chapter.title);
	check("新章要点已存", made.data.chapter.summary.includes("不来的客人"), made.data.chapter.summary);
	check("新章字数目标已存", made.data.chapter.targetWords === 3000, String(made.data.chapter.targetWords));
	check("新章状态是 planned", made.data.chapter.status === "planned", made.data.chapter.status);
	check("新章装配清单为空", made.data.chapter.materialIds.length === 0);
	check("新章 id 不撞已有章节", !["ch01", "ch02"].includes(made.data.chapter.id), made.data.chapter.id);

	const second = await req("POST", `/api/projects/${seedId}/chapters`, { title: "第四章" });
	check("连立两章不撞号", second.data.chapter.id !== made.data.chapter.id, `${made.data.chapter.id} / ${second.data.chapter.id}`);
	check("只要标题也能立章", second.data.chapter.summary === "" && second.data.chapter.targetWords === 0);

	// ---- 分卷：卷是独立对象，章挂不挂都行 ----
	console.log("\n分卷");
	const seedProject = (await req("GET", `/api/projects/${seedId}`)).data.project;
	// 分卷之前写下的工程里没有卷，也没有章的 volumeId：得照样读得开。
	check("老工程没有卷字段也读得开", Array.isArray(seedProject.volumes) && seedProject.volumes.length === 0, JSON.stringify(seedProject.volumes));
	check("老章节的卷补成不分卷", seedProject.outline.every((c: any) => c.volumeId === ""), JSON.stringify(seedProject.outline.map((c: any) => c.volumeId)));

	check("立卷缺卷名返回 400", (await req("POST", `/api/projects/${seedId}/volumes`, { summary: "只有要略" })).status === 400);
	check("往不存在的作品立卷返回 404", (await req("POST", "/api/projects/nope/volumes", { title: "卷一" })).status === 404);

	const volume = await req("POST", `/api/projects/${seedId}/volumes`, {
		title: "卷一 · 黑水汊",
		summary: "裴渡在野渡上讨生活，渐渐摸到夜航的门路。",
		targetWords: 30000,
	});
	check("立卷返回 201", volume.status === 201, String(volume.status));
	check("卷名与要略都存下了", volume.data.volume?.title === "卷一 · 黑水汊" && volume.data.volume.summary.includes("夜航"), JSON.stringify(volume.data.volume));
	check("卷目标字数已存", volume.data.volume.targetWords === 30000, String(volume.data.volume.targetWords));

	const chapterInVolume = await req("POST", `/api/projects/${seedId}/chapters`, {
		title: "第五章 夜航",
		volumeId: volume.data.volume.id,
	});
	check("立章可以带上卷", chapterInVolume.data.chapter.volumeId === volume.data.volume.id, String(chapterInVolume.data.chapter.volumeId));
	check("不带卷的章归不分卷", made.data.chapter.volumeId === "", String(made.data.chapter.volumeId));

	const renamedVolume = await req("PATCH", `/api/projects/${seedId}/volumes/${volume.data.volume.id}`, {
		title: "卷一 · 夜航",
		targetWords: 0,
	});
	check("改卷名返回 200", renamedVolume.status === 200 && renamedVolume.data.volume.title === "卷一 · 夜航", String(renamedVolume.status));
	check("卷目标字数可以清零", renamedVolume.data.volume.targetWords === 0, String(renamedVolume.data.volume.targetWords));
	check("改不存在的卷返回 404", (await req("PATCH", `/api/projects/${seedId}/volumes/ghost`, { title: "x" })).status === 404);

	// 直接改章目：标题、要点、所属卷。改完不能把这一章的正文抖掉。
	const rechapter = await req("PATCH", `/api/projects/${seedId}/outline/${made.data.chapter.id}`, {
		title: "第三章 空渡（改）",
		summary: "改过之后的要点。",
		volumeId: volume.data.volume.id,
	});
	check("改章目返回 200", rechapter.status === 200, String(rechapter.status));
	check("章目标题已改", rechapter.data.chapter.title === "第三章 空渡（改）", rechapter.data.chapter.title);
	check("章目要点已改", rechapter.data.chapter.summary === "改过之后的要点。", rechapter.data.chapter.summary);
	check("章目能改挂卷", rechapter.data.chapter.volumeId === volume.data.volume.id, rechapter.data.chapter.volumeId);
	check("改章目空标题返回 400", (await req("PATCH", `/api/projects/${seedId}/outline/${made.data.chapter.id}`, { title: "  " })).status === 400);
	check("改不存在的章节返回 404", (await req("PATCH", `/api/projects/${seedId}/outline/ghost`, { title: "x" })).status === 404);
	const danglingVolume = await req("PATCH", `/api/projects/${seedId}/outline/${made.data.chapter.id}`, { volumeId: "v-not-exist" });
	check("挂到不存在的卷等于不分卷", danglingVolume.data.chapter.volumeId === "", String(danglingVolume.data.chapter.volumeId));
	await req("PATCH", `/api/projects/${seedId}/outline/${made.data.chapter.id}`, { volumeId: volume.data.volume.id });

	// 删卷不删章：这一卷下的章归到不分卷，归了几章要报回来。
	const beforeVolumeDelete = (await req("GET", `/api/projects/${seedId}`)).data.project;
	const inVolume = beforeVolumeDelete.outline.filter((c: any) => c.volumeId === volume.data.volume.id).length;
	const removedVolume = await req("DELETE", `/api/projects/${seedId}/volumes/${volume.data.volume.id}`);
	check("删卷返回 200", removedVolume.status === 200, String(removedVolume.status));
	check("删卷回报归到不分卷的章数", removedVolume.data.moved === inVolume && inVolume === 2, `${removedVolume.data.moved} / ${inVolume}`);
	const afterVolumeDelete = (await req("GET", `/api/projects/${seedId}`)).data.project;
	check("卷已不在作品里", !afterVolumeDelete.volumes.some((v: any) => v.id === volume.data.volume.id));
	check("章没有陪着消失", afterVolumeDelete.outline.length === beforeVolumeDelete.outline.length, String(afterVolumeDelete.outline.length));
	check("原属该卷的章都归了不分卷", afterVolumeDelete.outline.every((c: any) => c.volumeId === ""), JSON.stringify(afterVolumeDelete.outline.map((c: any) => c.volumeId)));
	check("删不存在的卷返回 404", (await req("DELETE", `/api/projects/${seedId}/volumes/ghost`)).status === 404);

	// ---- 导出 ----
	// 导出的稿子要能直接带走：单章、整本、markdown 三种口径，外加中文文件名。
	const draftText = "老周把船缆绕在桩上，等一个不来的客人。\n\n江面起了雾。";
	const savedDraft = await req("PATCH", `/api/projects/${seedId}/chapters/${made.data.chapter.id}`, { content: draftText });
	check("存稿返回 200", savedDraft.status === 200, String(savedDraft.status));
	// 正文不再随存稿回传：一存就是整本，百万字的书会被这一件事拖死。
	check("存稿的响应里没有正文", savedDraft.data.chapter?.content === undefined, JSON.stringify(savedDraft.data.chapter));

	// 大纲里没有的章节不能被正文写入凭空造成 draft（那样正文永远挂不上任何章）。
	const ghostPatch = await req("PATCH", `/api/projects/${seedId}/chapters/ghost-chapter`, { content: "无主正文" });
	check("PATCH 不存在的章节返回 404", ghostPatch.status === 404, String(ghostPatch.status));
	const afterGhost = await req("GET", `/api/projects/${seedId}`);
	check("幽灵章节没有被造出来", afterGhost.data.project.drafts["ghost-chapter"] === undefined);

	// 自动保存只持久化、不构成版本点；显式保存才归档旧稿，内容没变也不留重复版本。
	const autosave1 = await req("PATCH", `/api/projects/${seedId}/chapters/${made.data.chapter.id}`, {
		content: "自动保存第一版",
		autosave: true,
	});
	const autosave2 = await req("PATCH", `/api/projects/${seedId}/chapters/${made.data.chapter.id}`, {
		content: "自动保存第二版",
		autosave: true,
	});
	// 版本与正文都要单独去取：存稿的响应只回元数据。
	const afterAutosave = await req("GET", `/api/projects/${seedId}/chapters/${made.data.chapter.id}/draft?history=1`);
	check(
		"连续两次自动保存不产生版本",
		autosave1.status === 200 && (afterAutosave.data.history?.length ?? 0) === 0,
		JSON.stringify(afterAutosave.data.history),
	);
	check("自动保存的内容已生效", afterAutosave.data.chapter?.content === "自动保存第二版", afterAutosave.data.chapter?.content);
	check("自动保存也递增 revision", afterAutosave.data.chapter?.revision === 3, String(afterAutosave.data.chapter?.revision));
	check("自动保存也刷新 updatedAt", afterAutosave.data.chapter?.updatedAt >= autosave1.data.chapter?.updatedAt);
	const explicitSave = await req("PATCH", `/api/projects/${seedId}/chapters/${made.data.chapter.id}`, { content: "显式保存稿" });
	const afterExplicit = await req("GET", `/api/projects/${seedId}/chapters/${made.data.chapter.id}/draft?history=1`);
	check("显式保存归档旧稿", afterExplicit.data.chapter?.history?.length === 1, String(afterExplicit.data.chapter?.history?.length));
	check(
		"归档的是自动保存的最后一版",
		afterExplicit.data.chapter?.history?.[0]?.content === "自动保存第二版",
		afterExplicit.data.chapter?.history?.[0]?.content,
	);
	const repeatSave = await req("PATCH", `/api/projects/${seedId}/chapters/${made.data.chapter.id}`, { content: "显式保存稿" });
	const afterRepeat = await req("GET", `/api/projects/${seedId}/chapters/${made.data.chapter.id}/draft?history=1`);
	check("内容相同再保存不产生重复版本", afterRepeat.data.chapter?.history?.length === 1, String(afterRepeat.data.chapter?.history?.length));
	// 还原成导出用例的正文：后面的断言依赖这份内容。
	await req("PATCH", `/api/projects/${seedId}/chapters/${made.data.chapter.id}`, { content: draftText });

	// ---- 正文按需取 ----
	// 骨架里只有元数据，正文要单独去取。这是百万字的书不被接口拖死的关键。
	console.log("\n正文按需取");
	const draftView = await req("GET", `/api/projects/${seedId}/chapters/${made.data.chapter.id}/draft`);
	check("按需取正文返回 200", draftView.status === 200, String(draftView.status));
	check("取回来的正文与存进去的一致", draftView.data.chapter?.content === draftText, draftView.data.chapter?.content);
	check("取回来的稿次对得上", typeof draftView.data.chapter?.revision === "number", String(draftView.data.chapter?.revision));
	check("按需取不带历史时不给历史", draftView.data.history === undefined, JSON.stringify(draftView.data.history));
	check("取不存在的章返回 404", (await req("GET", `/api/projects/${seedId}/chapters/ghost/draft`)).status === 404);

	const skeleton = await req("GET", `/api/projects/${seedId}`);
	const skeletonText = JSON.stringify(skeleton.data.project);
	check("整本响应里没有正文", !skeletonText.includes(draftText), skeletonText.slice(0, 120));
	check("整本响应里有章的元数据", typeof skeleton.data.project.drafts?.[made.data.chapter.id]?.words === "number", JSON.stringify(skeleton.data.project.drafts?.[made.data.chapter.id]));
	// 章清单给的是「有正文的那些章」的元数据，按大纲顺序排好；
	// 大纲里还没动笔的章不在其中（它们只有条目，没有稿次与字数可报）。
	const draftedIds = skeleton.data.project.outline
		.filter((chapter: any) => skeleton.data.project.drafts?.[chapter.id] !== undefined)
		.map((chapter: any) => chapter.id);
	check(
		"整本响应给出章的清单",
		Array.isArray(skeleton.data.chapters) &&
			skeleton.data.chapters.length === draftedIds.length &&
			JSON.stringify(skeleton.data.chapters.map((c: any) => c.id)) === JSON.stringify(draftedIds),
		JSON.stringify(skeleton.data.chapters?.map((c: any) => c.id)),
	);
	check(
		"章清单按大纲顺序",
		JSON.stringify(skeleton.data.chapters?.map((c: any) => c.id)) === JSON.stringify(draftedIds),
		JSON.stringify(skeleton.data.chapters?.map((c: any) => c.id)),
	);
	check("元数据里有字数与稿次", typeof skeleton.data.chapters?.[0]?.words === "number" && typeof skeleton.data.chapters?.[0]?.revision === "number", JSON.stringify(skeleton.data.chapters?.[0]));

	const oneChapter = await reqText(`/api/projects/${seedId}/export?chapter=${made.data.chapter.id}`);
	check("单章导出返回 200", oneChapter.status === 200, String(oneChapter.status));
	check(
		"单章导出带章题与正文",
		oneChapter.text.includes("第3章") && oneChapter.text.includes("空渡") && oneChapter.text.includes("等一个不来的客人"),
		oneChapter.text.slice(0, 60),
	);
	check("单章导出不含书名", !oneChapter.text.includes("种子工程"), oneChapter.text.slice(0, 60));
	check("单章导出是纯文本附件", oneChapter.type.includes("text/plain") && oneChapter.disposition.includes("attachment"), oneChapter.disposition);
	// 中文名塞进 filename= 会被浏览器整个丢掉，必须走 RFC 5987。
	check("导出文件名走 RFC 5987", oneChapter.disposition.includes("filename*=UTF-8''"), oneChapter.disposition);

	const wholeBook = await reqText(`/api/projects/${seedId}/export`);
	check("整本导出以书名开头", wholeBook.text.startsWith("种子工程"), wholeBook.text.slice(0, 20));
	check("整本导出收录已落笔的章", wholeBook.text.includes("江面起了雾"), wholeBook.text.slice(0, 60));
	// 空章导出成一片空白没有意义，只会让用户自己回头删。
	check("整本导出跳过没落笔的章", !wholeBook.text.includes("第四章"), wholeBook.text.slice(-60));

	const asMarkdown = await reqText(`/api/projects/${seedId}/export?format=md`);
	check("markdown 导出加书名标题", asMarkdown.text.startsWith("# 种子工程"), asMarkdown.text.slice(0, 20));
	check("markdown 导出加章标题", asMarkdown.text.includes("## 第"), asMarkdown.text.slice(0, 60));
	check("markdown 文件名后缀是 .md", asMarkdown.disposition.includes(".md"), asMarkdown.disposition);

	check("导出不存在的章节返回 404", (await reqText(`/api/projects/${seedId}/export?chapter=ghost`)).status === 404);
	check("导出不存在的作品返回 404", (await reqText("/api/projects/nope/export")).status === 404);

	// 新章要被成文链路认作合法章节：没装料时是 409（缺料），不是 404（章节不存在）。
	// 这条正是「立完章就能装料成文」的最小证据。
	const preflightNew = await req("POST", `/api/projects/${seedId}/chapters/${made.data.chapter.id}/write`, { mode: "create" });
	check("新章被成文链路认作合法章节", preflightNew.status === 409, `${preflightNew.status} ${preflightNew.data?.error ?? ""}`);
	const preflightGhost = await req("POST", `/api/projects/${seedId}/chapters/ghost/write`, { mode: "create" });
	check("成文链路对幽灵章节返回 404", preflightGhost.status === 404, String(preflightGhost.status));

	// ---- 章节装料（作者在工作台里的直接操作）----
	console.log("\n章节装料");
	const chapterMissing = await req("POST", `/api/projects/${seedId}/chapters/nope/materials`, { add: ["seed-mat-1"] });
	check("往不存在的章节装料返回 404", chapterMissing.status === 404);

	const added = await req("POST", `/api/projects/${seedId}/chapters/ch01/materials`, {
		add: ["seed-mat-1", "ghost-id"],
	});
	check("装料返回 200", added.status === 200, JSON.stringify(added.data));
	check("章节记下装料", added.data.chapter.materialIds.join() === "seed-mat-1", JSON.stringify(added.data.chapter.materialIds));
	check("悬空 id 被跳过并回报", added.data.skipped.join() === "ghost-id", JSON.stringify(added.data.skipped));
	check("回传解析后的装配清单", added.data.assembled.join() === "seed-mat-1");

	const afterAdd = await req("GET", `/api/projects/${seedId}`);
	check(
		"双向同步：素材也记下章节",
		afterAdd.data.project.materials.find((m: any) => m.id === "seed-mat-1").chapterIds.includes("ch01"),
		JSON.stringify(afterAdd.data.project.materials.find((m: any) => m.id === "seed-mat-1").chapterIds),
	);
	check("统计里的已装料章节数跟上", afterAdd.data.stats.coveredChapters === 1);

	const removedLink = await req("POST", `/api/projects/${seedId}/chapters/ch01/materials`, { remove: ["seed-mat-1"] });
	check("摘料返回 200", removedLink.status === 200);
	check("摘料后章节清单清空", removedLink.data.chapter.materialIds.length === 0);
	const afterRemove = await req("GET", `/api/projects/${seedId}`);
	check(
		"摘料也双向同步",
		afterRemove.data.project.materials.find((m: any) => m.id === "seed-mat-1").chapterIds.length === 0,
	);
	check("已装料章节数回落到 0", afterRemove.data.stats.coveredChapters === 0);

	const emptyOp = await req("POST", `/api/projects/${seedId}/chapters/ch01/materials`, { add: [], remove: [] });
	check("空的装料请求返回 400", emptyOp.status === 400, JSON.stringify(emptyOp.data));

	// 同批既摘又装时，装是最终意图。
	await req("POST", `/api/projects/${seedId}/chapters/ch01/materials`, { add: ["seed-mat-2"] });
	const bothWays = await req("POST", `/api/projects/${seedId}/chapters/ch01/materials`, {
		add: ["seed-mat-2"],
		remove: ["seed-mat-2"],
	});
	check("同批摘了又装以装为准", bothWays.data.chapter.materialIds.join() === "seed-mat-2", JSON.stringify(bothWays.data.chapter.materialIds));

	// ---- 成文前置校验 ----
	console.log("\n成文前置校验");
	const badMode = await req("POST", `/api/projects/${seedId}/chapters/ch01/write`, { mode: "乱写" });
	check("非法 mode 返回 400", badMode.status === 400 && String(badMode.data.error).includes("create"), JSON.stringify(badMode.data));

	const noMaterials = await req("POST", `/api/projects/${seedId}/chapters/ch02/write`, { mode: "create" });
	check("没有装料的章节返回 409", noMaterials.status === 409, JSON.stringify(noMaterials.data));
	check("409 里说清该找谁备料", String(noMaterials.data.error).includes("设定官"), String(noMaterials.data.error));

	// 装料齐了，前置校验通过，卡在没有可用模型上 —— 这正是要验证的边界。
	const noModelForWrite = await req("POST", `/api/projects/${seedId}/chapters/ch01/write`, { mode: "create" });
	check("素材齐备后不再被 409 拦住", noModelForWrite.status !== 409, JSON.stringify(noModelForWrite.data));
	check("无可用模型时返回 400", noModelForWrite.status === 400, JSON.stringify(noModelForWrite.data));

	const noChapter = await req("POST", `/api/projects/${seedId}/chapters/nope/write`, {});
	check("章节不存在返回 404", noChapter.status === 404);
	const writeUnknownProject = await req("POST", "/api/projects/nope/chapters/ch01/write", {});
	check("工程不存在返回 404", writeUnknownProject.status === 404);

	// ---- 局部修改（第四档写法：只改几处，不整章重交）----
	console.log("\n局部修改");
	// 先装料再成文：patch 用例需要一版真实落盘的正文当底座，而正文只能由执笔者写入。
	const patchLoaded = await req("POST", `/api/projects/${seedId}/chapters/ch01/materials`, { add: ["seed-mat-2"] });
	check(
		"局部修改前先给 ch01 装料",
		patchLoaded.status === 200 && patchLoaded.data.chapter.materialIds.join() === "seed-mat-2",
		JSON.stringify(patchLoaded.data.chapter?.materialIds),
	);

	mockMode = "write";
	const writeRun = await streamWrite(seedId, "ch01", { mode: "create", modelRef: "mock/mock" });
	check("成文流以 run_end 收尾", writeRun.status === 200 && writeRun.events.some((event) => event.type === "run_end"), String(writeRun.status) + " " + JSON.stringify(writeRun.events.map((event) => event.type)));
	const writeToolEnd = writeRun.events.find((event) => event.type === "tool_end" && event.name === "write_chapter");
	check("整章成文调用了 write_chapter", Boolean(writeToolEnd) && writeToolEnd?.isError !== true, JSON.stringify(writeToolEnd));
	const freshDraft = await req("GET", `/api/projects/${seedId}/chapters/ch01/draft`);
	check("成文正文已落地", freshDraft.data.chapter?.content === WRITE_BODY, String(freshDraft.data.chapter?.content));
	check("成文是第 1 版", freshDraft.data.chapter?.revision === 1, String(freshDraft.data.chapter?.revision));
	const runEnd = writeRun.events.find((event) => event.type === "run_end");
	check("完成事件给出真实保存结果", runEnd?.saved === true && runEnd?.savedRevision === 1, JSON.stringify(runEnd));
	check("完成事件带成本字段", runEnd?.cost?.currency === "USD" && typeof runEnd.cost.amount === "number", JSON.stringify(runEnd?.cost));

	// 请求 ID 相同是网络重试：只重放原来那轮事件，不能再调用一次模型或覆盖正文。
	const idemId = "workbench-idem-0001";
	const idemHits = upstreamHits;
	const idemFirst = await streamWrite(seedId, "ch01", { mode: "rewrite", modelRef: "mock/mock", requestId: idemId });
	const idemReplay = await streamWrite(seedId, "ch01", { mode: "rewrite", modelRef: "mock/mock", requestId: idemId });
	check("幂等重试返回同一轮事件", JSON.stringify(idemReplay.events) === JSON.stringify(idemFirst.events), JSON.stringify(idemReplay.events));
	check("幂等重试不重复调用模型", upstreamHits === idemHits + 2, `${idemHits} -> ${upstreamHits}`);

	mockMode = "chat";
	const noSave = await streamWrite(seedId, "ch01", { mode: "rewrite", modelRef: "mock/mock" });
	const noSaveEnd = noSave.events.find((event) => event.type === "run_end");
	check("没有实际保存不算完成", noSaveEnd?.saved === false && noSave.events.some((event) => event.type === "error"), JSON.stringify(noSave.events));

	mockMode = "stream";
	const slowWrite = fetch(base + `/api/projects/${seedId}/chapters/ch01/write`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode: "rewrite", modelRef: "mock/mock", requestId: "workbench-slow-0001" }),
	});
	await new Promise((resolve) => setTimeout(resolve, 250));
	const conflict = await req("POST", `/api/projects/${seedId}/chapters/ch01/write`, { mode: "rewrite", modelRef: "mock/mock" });
	check("同章并发生成被互斥拦截", conflict.status === 409, JSON.stringify(conflict.data));
	const slowResponse = await slowWrite;
	await slowResponse.body?.cancel();
	await new Promise((resolve) => setTimeout(resolve, 300));

	mockMode = "write";

	// 同一章发 mode: patch —— 只换 find 指的那一处，其余一个字都不该动。
	mockMode = "patch";
	patchTarget = { chapterId: "ch01", find: PATCH_FIND, replace: PATCH_REPLACE };
	const patchRun = await streamWrite(seedId, "ch01", { mode: "patch", modelRef: "mock/mock" });
	check(
		"局部修改流正常收尾（有 run_end、没有 error）",
		patchRun.status === 200 &&
			patchRun.events.some((event) => event.type === "run_end") &&
			!patchRun.events.some((event) => event.type === "error"),
		String(patchRun.status) + " " + JSON.stringify(patchRun.events.map((event) => event.type)),
	);
	const patchToolEnd = patchRun.events.find((event) => event.type === "tool_end" && event.name === "revise_chapter");
	check("局部修改调用了 revise_chapter", Boolean(patchToolEnd) && patchToolEnd?.isError !== true, JSON.stringify(patchToolEnd));
	check("工具结果点明其余一字未动", String(patchToolEnd?.preview ?? "").includes("其余一字未动"), String(patchToolEnd?.preview ?? ""));

	const patchedDraft = await req("GET", `/api/projects/${seedId}/chapters/ch01/draft`);
	check("局部修改后是第 2 版", patchedDraft.data.chapter?.revision === 2, String(patchedDraft.data.chapter?.revision));
	check(
		"正文只在 find 那处变了",
		patchedDraft.data.chapter?.content === WRITE_BODY.replace(PATCH_FIND, PATCH_REPLACE),
		String(patchedDraft.data.chapter?.content),
	);
	check(
		"其余一字未动（首尾段落原样）",
		String(patchedDraft.data.chapter?.content ?? "").startsWith("裴渡在渡口数人头，数到第二十个才停。\n\n") &&
			String(patchedDraft.data.chapter?.content ?? "").includes("老周把船缆绕在桩上，等一个不来的客人。") &&
			String(patchedDraft.data.chapter?.content ?? "").endsWith("江面起了雾，雾里没有第二条船。"),
		String(patchedDraft.data.chapter?.content),
	);

	// 正文之外还得有版本记录：历史里最后一版记着这次是 patch 改出来的。
	const patchHistory = await req("GET", `/api/projects/${seedId}/chapters/ch01/draft?history=1`);
	const patchHistoryItems = (patchHistory.data.chapter?.history ?? []) as Record<string, any>[];
	check("局部修改留下了历史版本", patchHistoryItems.length === 1, JSON.stringify(patchHistoryItems));
	check("历史里这一版 mode 是 patch", patchHistoryItems.at(-1)?.mode === "patch", String(patchHistoryItems.at(-1)?.mode));
	check("历史里存着改前的全文", patchHistoryItems.at(-1)?.content === WRITE_BODY, String(patchHistoryItems.at(-1)?.content));
	check("历史稿次是第 1 版", patchHistoryItems.at(-1)?.revision === 1, String(patchHistoryItems.at(-1)?.revision));

	// 没装料的章也能局部修改：料是"写"的来源，不是"改"的前提。
	// 空渡章此前用 mode create 已被 409 拦住（见「成文前置校验」），正好当对照。
	const emptyChapterId = String(made.data.chapter.id);
	mockMode = "patch";
	patchTarget = { chapterId: emptyChapterId, find: "江面起了雾。", replace: "江面起了雾，看不清对岸。" };
	const emptyPatchRun = await streamWrite(seedId, emptyChapterId, { mode: "patch", modelRef: "mock/mock" });
	check(
		"没装料的章：patch 不被素材前置检查拦住",
		emptyPatchRun.status === 200 && emptyPatchRun.events.some((event) => event.type === "run_end"),
		String(emptyPatchRun.status) + " " + JSON.stringify(emptyPatchRun.data),
	);
	const emptyPatched = await req("GET", `/api/projects/${seedId}/chapters/${emptyChapterId}/draft`);
	check(
		"没装料的章：正文只改了那一处",
		emptyPatched.data.chapter?.content === draftText.replace("江面起了雾。", "江面起了雾，看不清对岸。"),
		String(emptyPatched.data.chapter?.content),
	);

	// 没有正文就无从"改"：验证服务端不会把它悄悄退化成"从零写起"。
	const patchNoBody = await req("POST", `/api/projects/${seedId}/chapters/ch02/write`, { mode: "patch", modelRef: "mock/mock" });
	check("没有正文的章发 patch 返回 409", patchNoBody.status === 409, String(patchNoBody.status) + " " + JSON.stringify(patchNoBody.data));
	check("409 说清还没有正文", String(patchNoBody.data.error).includes("还没有正文"), String(patchNoBody.data.error));

	// 非法 mode 仍按白名单拒绝，报错要列出四档写法，作者才知道有 patch 可选。
	const patchBadMode = await req("POST", `/api/projects/${seedId}/chapters/ch01/write`, { mode: "nope", modelRef: "mock/mock" });
	check("非法 mode 返回 400", patchBadMode.status === 400, String(patchBadMode.status) + " " + JSON.stringify(patchBadMode.data));
	check(
		"400 列出四档写法",
		String(patchBadMode.data.error).includes("create / rewrite / continue / patch"),
		String(patchBadMode.data.error),
	);

	// 后面的用例依赖假上游回到持续吐字模式。
	mockMode = "stream";

	// ---- 会话 ----
	console.log("\n会话");
	const noProject = await req("POST", "/api/sessions", { role: "material" });
	check("缺 projectId 返回 400", noProject.status === 400);
	const writingNoChapter = await req("POST", "/api/sessions", { projectId: seedId, role: "writing" });
	check("写作会话缺 chapterId 返回 400", writingNoChapter.status === 400);
	const writingGhostChapter = await req("POST", "/api/sessions", {
		projectId: seedId,
		role: "writing",
		chapterId: "nope",
		modelRef: "不存在的/model",
	});
	check("写作会话指向不存在的章节也报错", writingGhostChapter.status === 400, JSON.stringify(writingGhostChapter.data));
	const noModel = await req("POST", "/api/sessions", { projectId: seedId, role: "material", modelRef: "不存在的/model" });
	check("模型解析失败返回 400 并给出候选", noModel.status === 400 && Array.isArray(noModel.data.candidates), JSON.stringify(noModel.data));

	const ghostSession = await req("POST", "/api/sessions/ghost/messages", { input: "在吗" });
	check("往不存在的会话发消息返回 404", ghostSession.status === 404);
	const ghostAbort = await req("POST", "/api/sessions/ghost/abort");
	check("中止不存在的会话返回 404", ghostAbort.status === 404);

	// ---- 生成中断与换模型 ----
	console.log("\n生成中断");
	const mockSession = await req("POST", "/api/sessions", { projectId: seedId, role: "material", modelRef: "mock/mock" });
	check("本地假上游可建会话", mockSession.status === 201, JSON.stringify(mockSession.data));
	const streamSessionId = String(mockSession.data.sessionId ?? "");
	const stream = streamSessionMessage(streamSessionId);
	const started = await Promise.race([stream.started.then(() => true), timeout(5_000)]);
	check("生成流已开始", started, "等待 NDJSON 首包超时");
	const hitUpstream = await waitFor(() => upstreamHits > 0);
	check("假上游收到生成请求", hitUpstream, String(upstreamHits));
	// 生成途中换模型会把正在跑的智能体换掉：必须先拒绝。
	const busySwitch = await req("POST", `/api/sessions/${streamSessionId}/model`, { modelRef: "mock/mock" });
	check("生成中换模型返回 409", busySwitch.status === 409, String(busySwitch.status) + " " + JSON.stringify(busySwitch.data));
	// 模拟关页：断开客户端连接，服务端必须把上游请求一起掐掉。
	stream.destroy();
	const aborted = await Promise.race([upstreamClosed.then(() => true), timeout(8_000)]);
	check("客户端断开后上游连接被中止", aborted, "上游连接未在超时内关闭");
	check("中止后服务仍存活", (await req("GET", "/api/bootstrap")).status === 200);
	const afterAbortSwitch = await req("POST", `/api/sessions/${streamSessionId}/model`, { modelRef: "mock/mock" });
	check(
		"中止后可以换模型",
		afterAbortSwitch.status === 200,
		String(afterAbortSwitch.status) + " " + JSON.stringify(afterAbortSwitch.data),
	);

	// ---- 智能体向作者提问 ----
	console.log("\n智能体提问");
	mockMode = "ask";
	const bodiesBeforeAsk = upstreamBodies.length;
	const askSession = await req("POST", "/api/sessions", { projectId: seedId, role: "material", modelRef: "mock/mock" });
	check("提问会话可建", askSession.status === 201, JSON.stringify(askSession.data));
	const askSessionId = String(askSession.data.sessionId ?? "");
	const askRun = await streamSessionAnswering(askSessionId, "沈砚，寒门出身");
	const askEvent = askRun.events.find((event) => event.type === "question");
	check("智能体把问题送到了流里", Boolean(askEvent), JSON.stringify(askRun.events.map((event) => event.type)));
	check("问题与候选项原样送达", askEvent?.question === ASK_QUESTION && Array.isArray(askEvent?.options) && askEvent.options.length === 2, JSON.stringify(askEvent));
	check("回答接口回了 200", askRun.answeredStatus === 200, String(askRun.answeredStatus));
	const closedEvent = askRun.events.find((event) => event.type === "question_closed");
	check("问题以已回答收尾", closedEvent?.reason === "answered", JSON.stringify(closedEvent));
	const askToolEnd = askRun.events.find((event) => event.type === "tool_end" && event.name === "ask_user");
	check("提问工具执行成功", Boolean(askToolEnd) && askToolEnd?.isError !== true, JSON.stringify(askToolEnd));
	const askBodies = upstreamBodies.slice(bodiesBeforeAsk);
	check("工具结果回到了上游", askBodies.length >= 2 && (askBodies[1] ?? "").includes("沈砚，寒门出身"), "上游轮次：" + askBodies.length);
	check("这一轮正常走完", askRun.events.some((event) => event.type === "run_end"), JSON.stringify(askRun.events.map((event) => event.type)));
	// 问过之后不该有问号残留：再答一次就该 404。
	const staleAnswer = await req("POST", `/api/questions/${askRun.questionId}/answer`, { answer: "再来一次" });
	check("同一个问题不能答两遍", staleAnswer.status === 404, String(staleAnswer.status) + " " + JSON.stringify(staleAnswer.data));
	mockMode = "stream";

	// ---- 生成记录 ----
	// 每轮落笔都会留档：列表按面板只留最近 10 条，能从旧记录接着写，也能删。
	// 前面的用例已经留下成文、局部修改与两轮会话的记录，先清空再逐条断言，
	// 免得"恰好还有几条"被上一段留下的记录带偏。
	console.log("\n生成记录");
	const recordsReply = (query: string) => req("GET", "/api/records" + query);
	const listRecords = async (query: string): Promise<Record<string, any>[]> => {
		const reply = await recordsReply(query);
		return Array.isArray(reply.data.records) ? (reply.data.records as Record<string, any>[]) : [];
	};
	// 生成轮次在流结束之后才补写记录，留一点余量再清，免得清完又被补回。
	await new Promise((resolve) => setTimeout(resolve, 300));
	for (let round = 0; round < 5; round++) {
		const remaining = await listRecords("?limit=50");
		if (remaining.length === 0) break;
		for (const record of remaining) await req("DELETE", "/api/records/" + String(record.id));
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const emptyAfterClean = await listRecords("?limit=50");
	check("生成记录已清空（不吃前面几段的剩饭）", emptyAfterClean.length === 0, String(emptyAfterClean.length));

	// 一轮成文：mode create 应留下一条带章名与写法的记录。
	const REC_NOTE = "这一轮交代：雨夜追车要克制，别让裴渡先开口。";
	mockMode = "write";
	const firstWrite = await streamWrite(seedId, "ch01", { mode: "create", modelRef: "mock/mock", note: REC_NOTE });
	check(
		"成文一轮正常收尾",
		firstWrite.status === 200 && firstWrite.events.some((event) => event.type === "run_end"),
		String(firstWrite.status) + " " + JSON.stringify(firstWrite.events.map((event) => event.type)),
	);
	const ch01Query = "?role=writing&projectId=" + seedId + "&chapterId=ch01";
	const ch01Appeared = await waitFor(async () => (await listRecords(ch01Query)).length === 1, 8_000);
	const ch01Reply = await recordsReply(ch01Query);
	check("记录列表可查", ch01Reply.status === 200, String(ch01Reply.status) + " " + JSON.stringify(ch01Reply.data));
	const ch01Records = (ch01Reply.data.records ?? []) as Record<string, any>[];
	check(
		"一轮成文在 ch01 面板留下 1 条记录",
		ch01Appeared && ch01Records.length === 1,
		ch01Records.map((record) => String(record.title)).join(" | "),
	);
	const writingRecord = ch01Records[0]!;
	check(
		"记录标题带章名与写法",
		String(writingRecord.title).includes("核载二十人") && String(writingRecord.title).includes("从零写起"),
		String(writingRecord.title),
	);
	check("记录里至少有一问一答", Number(writingRecord.messageCount) >= 2, String(writingRecord.messageCount));
	check(
		"记录归属写作角色与本章",
		writingRecord.role === "writing" && writingRecord.projectId === seedId && writingRecord.chapterId === "ch01",
		JSON.stringify(writingRecord),
	);
	check(
		"记录预览取自这一轮的助手收尾",
		String(writingRecord.preview ?? "").includes("本章已写完"),
		String(writingRecord.preview),
	);

	// 从这条接着写：不开新记录，对话在原记录上继续变长。
	mockMode = "write";
	const secondWrite = await streamWrite(seedId, "ch01", {
		mode: "rewrite",
		modelRef: "mock/mock",
		recordId: writingRecord.id,
	});
	check(
		"带旧记录接着写正常收尾",
		secondWrite.status === 200 && secondWrite.events.some((event) => event.type === "run_end"),
		String(secondWrite.status) + " " + JSON.stringify(secondWrite.events.map((event) => event.type)),
	);
	const resumedGrew = await waitFor(async () => {
		const list = await listRecords(ch01Query);
		return list.length === 1 && Number(list[0]?.messageCount) > Number(writingRecord.messageCount);
	}, 8_000);
	const afterResume = await listRecords(ch01Query);
	check("接着写不开新记录", afterResume.length === 1, String(afterResume.length));
	check("接着写的还是同一条记录", afterResume[0]?.id === writingRecord.id, String(afterResume[0]?.id));
	check(
		"接着写后对话变长",
		resumedGrew && Number(afterResume[0]?.messageCount) > Number(writingRecord.messageCount),
		writingRecord.messageCount + " -> " + String(afterResume[0]?.messageCount),
	);
	const storedRecord = await req("GET", "/api/records/" + String(writingRecord.id));
	const storedMessages = (storedRecord.data.record?.messages ?? []) as unknown[];
	check("记录详情能按 id 取到", storedRecord.status === 200, String(storedRecord.status) + " " + JSON.stringify(storedRecord.data));
	check(
		"详情里的 messages 数与列表一致",
		storedMessages.length === Number(afterResume[0]?.messageCount),
		storedMessages.length + " vs " + String(afterResume[0]?.messageCount),
	);
	check("上一轮的用户交代还在上下文里", JSON.stringify(storedMessages).includes(REC_NOTE));

	// 记录与面板是绑死的：不在、或不属于本章，都不能将就着写。
	const ghostRecordWrite = await streamWrite(seedId, "ch01", { recordId: "ghost-record", mode: "continue", modelRef: "mock/mock" });
	check(
		"带上不存在的记录 id 接着写返回 404",
		ghostRecordWrite.status === 404,
		String(ghostRecordWrite.status) + " " + JSON.stringify(ghostRecordWrite.data),
	);
	const ch02Loaded = await req("POST", "/api/projects/" + seedId + "/chapters/ch02/materials", { add: ["seed-mat-1"] });
	check(
		"临时给 ch02 装一条料（越过 409 才测得到 400）",
		ch02Loaded.status === 200 && ch02Loaded.data.chapter.materialIds.includes("seed-mat-1"),
		JSON.stringify(ch02Loaded.data),
	);
	const crossChapter = await streamWrite(seedId, "ch02", { recordId: String(writingRecord.id), mode: "create", modelRef: "mock/mock" });
	check(
		"拿 ch01 的记录去写 ch02 返回 400",
		crossChapter.status === 400,
		String(crossChapter.status) + " " + JSON.stringify(crossChapter.data),
	);
	check("400 说清记录属于别的章节", String(crossChapter.data.error ?? "").includes("别的章节"), String(crossChapter.data.error));
	const ch02Unloaded = await req("POST", "/api/projects/" + seedId + "/chapters/ch02/materials", { remove: ["seed-mat-1"] });
	check(
		"ch02 的临时材料收回，后面的用例回到原样",
		ch02Unloaded.status === 200 && ch02Unloaded.data.chapter.materialIds.length === 0,
		JSON.stringify(ch02Unloaded.data.chapter?.materialIds),
	);

	// 删除：删掉就取不到，再删一次还是 404。
	const deletedRecord = await req("DELETE", "/api/records/" + String(writingRecord.id));
	check("删除记录返回 200 与 ok", deletedRecord.status === 200 && deletedRecord.data.ok === true, JSON.stringify(deletedRecord.data));
	const goneRecord = await req("GET", "/api/records/" + String(writingRecord.id));
	check("删掉的记录再取返回 404", goneRecord.status === 404, String(goneRecord.status));
	const deleteAgain = await req("DELETE", "/api/records/" + String(writingRecord.id));
	check("重复删除返回 404", deleteAgain.status === 404, String(deleteAgain.status));

	// 设定官的一席：建会话时就落一条记录，一轮跑完消息补进去。
	mockMode = "ask";
	const materialSession = await req("POST", "/api/sessions", { projectId: seedId, role: "material", modelRef: "mock/mock" });
	check(
		"设定官会话返回 recordId",
		materialSession.status === 201 && typeof materialSession.data.recordId === "string" && materialSession.data.recordId.length > 0,
		JSON.stringify(materialSession.data),
	);
	const materialRecordId = String(materialSession.data.recordId ?? "");
	const materialRun = await streamSessionAnswering(String(materialSession.data.sessionId ?? ""), "沈砚，寒门出身");
	check(
		"设定官这一轮正常收尾",
		materialRun.events.some((event) => event.type === "run_end"),
		JSON.stringify(materialRun.events.map((event) => event.type)),
	);
	const materialQuery = "?role=material&projectId=" + seedId;
	const materialSaved = await waitFor(
		async () => (await listRecords(materialQuery)).some((record) => record.id === materialRecordId && Number(record.messageCount) > 0),
		8_000,
	);
	const materialRecords = await listRecords(materialQuery);
	check("设定官的一轮落成 1 条记录", materialRecords.length === 1, materialRecords.map((record) => String(record.title)).join(" | "));
	check("这条记录就是会话建的那条", materialRecords[0]?.id === materialRecordId, String(materialRecords[0]?.id));
	check("设定官记录里对话非空", materialSaved && Number(materialRecords[0]?.messageCount) > 0, String(materialRecords[0]?.messageCount));
	check("设定官记录按面板起名", materialRecords[0]?.title === "设定官的一席", String(materialRecords[0]?.title));

	// 拿这条记录再开一席：沿用同一个 id，面板里仍然只有一条。
	const resumedMaterialSession = await req("POST", "/api/sessions", {
		projectId: seedId,
		role: "material",
		modelRef: "mock/mock",
		recordId: materialRecordId,
	});
	check(
		"带旧记录再开设定官会话返回 201",
		resumedMaterialSession.status === 201,
		String(resumedMaterialSession.status) + " " + JSON.stringify(resumedMaterialSession.data),
	);
	check("沿用同一条记录而不是新开", resumedMaterialSession.data.recordId === materialRecordId, String(resumedMaterialSession.data.recordId));
	const afterMaterialResume = await listRecords(materialQuery);
	check("复用记录后面板里仍然只有 1 条", afterMaterialResume.length === 1, String(afterMaterialResume.length));

	// 库作用域的记录不属于任何工程，不能拿来开工程会话。
	const librarySession = await req("POST", "/api/sessions", { scope: "library", role: "material", modelRef: "mock/mock" });
	check(
		"库作用域会话也带 recordId",
		librarySession.status === 201 && typeof librarySession.data.recordId === "string",
		JSON.stringify(librarySession.data),
	);
	const libraryRecordId = String(librarySession.data.recordId ?? "");
	const libraryCross = await req("POST", "/api/sessions", {
		projectId: seedId,
		role: "material",
		modelRef: "mock/mock",
		recordId: libraryRecordId,
	});
	check(
		"库记录不能拿来开工程会话",
		libraryCross.status === 400,
		String(libraryCross.status) + " " + JSON.stringify(libraryCross.data),
	);
	check("400 说清记录不属于这个面板", String(libraryCross.data.error ?? "").includes("不属于这个面板"), String(libraryCross.data.error));
	const libraryRecordDeleted = await req("DELETE", "/api/records/" + libraryRecordId);
	check("库记录用完即删", libraryRecordDeleted.status === 200, String(libraryRecordDeleted.status));

	// 段末把记录清干净、假上游复位，后面的用例不受这一段影响。
	const remainingAtEnd = await listRecords("?limit=50");
	for (const record of remainingAtEnd) await req("DELETE", "/api/records/" + String(record.id));
	mockMode = "stream";

	// ---- 删除素材的连带清理 ----
	console.log("\n删除素材");
	const beforeDelete = await req("GET", `/api/projects/${seedId}`);
	check("删除前该章装着 1 条料", beforeDelete.data.project.outline.find((c: any) => c.id === "ch01").materialIds.length === 1);

	const removed = await req("DELETE", `/api/projects/${seedId}/materials/seed-mat-2`);
	check("删素材返回 200", removed.status === 200, JSON.stringify(removed.data));
	const afterDelete = await req("GET", `/api/projects/${seedId}`);
	check("素材确实从库里消失", !afterDelete.data.project.materials.some((m: any) => m.id === "seed-mat-2"));
	check(
		"各章装配清单里的悬空引用被清掉",
		afterDelete.data.project.outline.find((c: any) => c.id === "ch01").materialIds.length === 0,
		JSON.stringify(afterDelete.data.project.outline.find((c: any) => c.id === "ch01").materialIds),
	);
	check("已装料章节数跟着回落", afterDelete.data.stats.coveredChapters === 0);

	const removedAgain = await req("DELETE", `/api/projects/${seedId}/materials/seed-mat-2`);
	check("重复删除返回 404", removedAgain.status === 404);

	// ---- 静态资源 ----
	console.log("\n静态资源");
	const index = await fetch(base + "/");
	const indexHtml = await index.text();
	check("首页可访问", index.status === 200 && indexHtml.includes("墨耕"));
	// 案头与写作台是两级：案头是独立的一屏，写作台由「进卷」进入。
	check("首页有案头这一屏", indexHtml.includes('id="view-home"'));
	check("首页有回案头的入口", indexHtml.includes('id="leave-workspace"'));
	check("写作台只剩三个页签", !indexHtml.includes('data-view="projects"') && indexHtml.includes('data-view="writing"'));
	const appJs = await fetch(base + "/app.js");
	const appSource = await appJs.text();
	check("前端脚本可访问", appJs.status === 200 && appSource.includes("renderMaterialsBench"));
	check("脚本里有进卷与回案头", appSource.includes("enterProject") && appSource.includes("leaveWorkspace"));
	const style = await fetch(base + "/style.css");
	const styleSource = await style.text();

	// id 必须唯一：$() 取的是文档里第一个同名元素，重了就会静默取错，
	// 而症状离现场很远（比如"另起一卷点了没反应"）。这类错值得单列一条守住。
	const idCounts = new Map<string, number>();
	for (const match of indexHtml.matchAll(/\sid="([^"]+)"/g)) {
		idCounts.set(match[1]!, (idCounts.get(match[1]!) ?? 0) + 1);
	}
	const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
	check("页面里的 id 不重复", duplicateIds.length === 0, duplicateIds.join(" "));

	// app.js 里 $() 取的每个 id 都得解析得到：要么写在页面上，要么由脚本自己创建。
	// 取到 null 会在那一步炸，而报错现场常常离真正的原因很远。
	const htmlIds = new Set(idCounts.keys());
	const dynamicIds = new Set([...appSource.matchAll(/\.id\s*=\s*"([^"]+)"/g)].map((m) => m[1]!));
	const referenced = new Set([...appSource.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]!));
	const missingIds = [...referenced].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
	check("脚本引用的 id 都存在（静态或脚本自建）", missingIds.length === 0, missingIds.join(" "));

	// 素材种类：作者能自己添。三处分类条、素材表单、种类管理都得从同一份目录来，
	// 而智能体的工具 schema 必须跟着目录走 —— 不然界面能选「势力」，
	// 智能体却不认识，模型只能瞎猜一个种类回来。
	check("首页有种类管理弹层", indexHtml.includes('id="kind-dialog"'));
	check("分类条末尾有添种类的入口", appSource.includes("kindAddChip") && appSource.includes("chip-add"));
	check("种类目录统一由 kindEntries 兜底", appSource.includes("function kindEntries"));
	check("自建种类拼地址做了转义（id 可能是中文）", appSource.includes("/api/kinds/\" + encodeURIComponent("));
	const toolsSource = readFileSync(path.join(root, "src", "ai", "tools.ts"), "utf8");
	check("智能体的 kind 枚举取自种类目录", toolsSource.includes("function materialKindSchema") && toolsSource.includes("kindOptions()"));
	const kindsStore = readFileSync(path.join(root, "src", "store", "kinds.ts"), "utf8");
	check(
		"种类表落盘用临时名 + rename",
		kindsStore.includes(".tmp") && kindsStore.includes("rename("),
	);

	// 分卷：卷是章目之上的一层。章目里要看得出卷，章与卷都要能改，
	// 而卷名会出现在稿面、作业条与右案大纲三处 —— 三处都得跟着走。
	check("有分卷弹层", indexHtml.includes('id="volume-dialog"') && indexHtml.includes('id="volume-list"'));
	check("章目里能立卷", indexHtml.includes('id="add-volume"') && appSource.includes("function openVolumeDialog"));
	check("章目里插卷头", appSource.includes("function volumeHeader") && styleSource.includes(".chapter-volume"));
	check("立章时能选卷", indexHtml.includes('id="chapter-volume"') && appSource.includes("function fillVolumeOptions"));
	check(
		"章目能改（标题、要点、所属卷）",
		appSource.includes("editingChapterId") && appSource.includes("/outline/\" + encodeURIComponent("),
	);
	check("卷名出现在稿面与大纲里", styleSource.includes(".ms-volume") && appSource.includes("〔\" + volume.title + \"〕"));

	// 高度链：桌面是 100vh 网格，里面每一级都得显式 min-height:0，
	// 否则内容一长就把父级顶开，页面出现滚动条、输入框被推到屏幕外。
	// 缺哪一级都看不出来，所以逐条点名守。
	const heightChain: [string, RegExp][] = [
		[".stage", /\.stage\s*\{[^}]*min-height:\s*0/],
		[".view", /\.view\s*\{[^}]*min-height:\s*0/],
		[".bench", /\.bench\s*\{[^}]*min-height:\s*0/],
		[".bench-pane", /\.bench-pane\s*\{[^}]*min-height:\s*0/],
		[".stream", /\.stream\s*\{[^}]*min-height:\s*0/],
	];
	const brokenChain = heightChain.filter(([, re]) => !re.test(styleSource)).map(([name]) => name);
	check("高度链每级都归零了 min-height", brokenChain.length === 0, brokenChain.join(" "));

	// 文稿页是整条高度链上唯一的滚动容器。body 是 overflow:hidden，
	// 这一格不写 overflow，长章节就被直接裁掉：翻不到底，也拖不动。
	check(
		"文稿页自己就是滚动容器",
		/#view-manuscript\s*\{[^}]*overflow:\s*auto/.test(styleSource),
		"#view-manuscript 缺 overflow:auto",
	);
	// 留白必须挂在还活着的选择器上：.ms 曾经是一条谁都不匹配的死规则，
	// 滚动与留白一起静默失效了很久。
	check(
		"稿纸留白没挂在死选择器上",
		!/^\s*\.ms\s*\{/m.test(styleSource) && /#view-manuscript\s*\{[^}]*padding:/.test(styleSource),
		".ms 无人使用；留白应写在 #view-manuscript 上",
	);
	// 章节操作条吸在稿台顶部，排在正文之前：写作时手要够得着「存稿」，
	// 不该被一整章的篇幅压在底下。
	check(
		"章节操作条吸顶",
		styleSource.includes("#view-manuscript .actions-center") &&
			/\.actions-center[^}]*position:\s*sticky/.test(styleSource.replace(/\n/g, " ")) &&
			/\n#view-manuscript \.actions-center \{[^}]*top:/.test(styleSource.replace(/\t/g, "")),
		"缺少吸顶的章节操作条",
	);
	check(
		"操作条排在正文之前",
		/box\.append\(chapterToolbar\([^)]*\)\);\s*\n\s*box\.append\(page\);/.test(appSource),
		"操作条应 append 在 page 之前",
	);
	// 稿纸必须给死宽度。稿台是 flex 纵向容器，margin:auto 会关掉 align-self:stretch，
	// 只写 max-width 的话稿纸退化成 fit-content：读稿时被长句顶到上限看着正常，
	// 一进改稿模式正文成了唯一内容，宽度就塌到 textarea 的 cols 默认值（20 字）。
	check(
		"稿纸有确定宽度（不被 fit-content 收窄）",
		/\.ms-page \{[^}]*width:\s*100%/.test(styleSource.replace(/\n/g, " ")) &&
			/\.front-matter \{[^}]*width:\s*100%/.test(styleSource.replace(/\n/g, " ")),
		".ms-page / .front-matter 缺 width:100%",
	);
	// 改稿框按内容撑开，别把一章关进固定高度的小窗里。
	check(
		"改稿框按内容自动撑高",
		appSource.includes("function fitEditor") &&
			/editor\.addEventListener\("input"[\s\S]{0,160}?fitEditor\(editor\)/.test(appSource) &&
			/\.ms-edit \{[^}]*resize:\s*none/.test(styleSource.replace(/\n/g, " ")),
		"缺少 fitEditor 或 .ms-edit 的 resize:none",
	);
	// 导出：作者要能把稿子带走，单章与整本都得有出口。
	check("脚本里有导出逻辑", appSource.includes("exportProject") && appSource.includes("/export"));
	check("总目与章节工具条都有导出入口", appSource.includes('"导出全书"') && appSource.includes("openExportDialog(chapter.id)"));
	check("导出会解回中文文件名", appSource.includes("exportName") && appSource.includes("filename\\*=UTF-8''"));
	check("没有正文时不导出空文件", appSource.includes("还没有正文可导出"));
	check("样式可访问", style.status === 200 && styleSource.includes(".bench-pane"));
	check("样式里有案头布局", styleSource.includes(".desk.is-home"));
	// 思考过程要能收起：是 <details>，不是一块常驻的文本。
	check(
		"思考块是可收起的 details",
		appSource.includes('el("details", "thinking")') && appSource.includes("thinking-head"),
	);
	check("思考块有折叠样式", styleSource.includes(".thinking[open]"));
	// 素材工作台：点选已有素材，让设定官照着改那几条。
	check("素材工作台有已选中栏", indexHtml.includes('id="material-picked"'));
	check(
		"选中素材会写进指令",
		appSource.includes("withPickedMaterials") && appSource.includes("本次只改这几条已有素材"),
	);
	check("选中条与选中卡有样式", styleSource.includes(".picked-bar") && styleSource.includes(".card.mat.is-picked"));
	// 一轮跑完要重载工程：新素材才会同步进素材库与生文工作台，然后才能装配。
	// 现在收尾走 reloadProjectSafely（先包一层错误提示），所以给足切片长度并只认函数前缀。
	const sendBody = appSource.slice(appSource.indexOf("async function sendMessage"), appSource.indexOf("async function sendMessage") + 3600);
	check("对议跑完会重载工程以同步素材", sendBody.includes("reloadProject"));
	// 断线时浏览器只说英文（"network error" / "Failed to fetch"）。作者读不懂，
	// 也不该看见同一场故障在面板里报成两条。这两条守着那层翻译与去重。
	check(
		"网络层故障翻成中文",
		appSource.includes("function isNetworkFailure") && appSource.includes("function describeFailure") && appSource.includes("服务没接上"),
	);
	check(
		"同一次断线不连报两条红字",
		appSource.includes("options.quiet") && appSource.includes("isNetworkFailure(error)") && appSource.includes("describeFailure(error"),
	);
	// 静默不等于放弃：服务重启往往一两秒就回来。重载要多敲几次门，
	// 端口一回来就把右案补上，否则作者得自己刷新页面才知道稿子写没写成。
	check(
		"断线后的收尾重载会重试",
		appSource.includes("RELOAD_RETRY_DELAYS") &&
			appSource.includes("async function reloadWithRetries") &&
			appSource.includes("noteReconnected"),
	);
	// 服务进程是"在线"本身：一次半路断线的写错误不该把它带走。
	const mainSource = readFileSync(path.join(root, "src", "server", "main.ts"), "utf8");
	check(
		"服务端兜住未捕获异常与断线写错误",
		mainSource.includes('process.on("uncaughtException"') &&
			mainSource.includes('process.on("unhandledRejection"') &&
			mainSource.includes('res.on("error"'),
	);
	// 立一章：章节是装料的落点，没有章就看不了也装不了料。
	check("左卷有立章入口", indexHtml.includes('id="add-chapter"'));
	check("有立章对话框", indexHtml.includes('id="chapter-dialog"') && indexHtml.includes('id="chapter-form"'));
	check("脚本里有立章逻辑", appSource.includes("openChapterDialog") && appSource.includes('"/chapters"'));
	check("立章入口有样式", styleSource.includes(".rail-add"));

	// 存照：误删素材、误改大纲时的退路，只有 API 没有入口等于没有。
	check("作品卡有存照入口", appSource.includes("存照") && appSource.includes("openSnapshotDialog"));
	check("有存照对话框", indexHtml.includes('id="snapshot-dialog"') && indexHtml.includes('id="snapshot-list"'));
	check("存照行有样式", styleSource.includes(".snap-row") && styleSource.includes(".snap-when"));
	check("脚本里有回滚逻辑", appSource.includes("restoreSnapshot") && appSource.includes("/snapshots/"));
	// 回滚是破坏性的，不能一点就生效。
	check("回滚需二次确认", appSource.includes("pendingSnapshotRestore") && appSource.includes("再点一次确认回滚"));
	// 落盘失败必须有可见提示，否则用户以为存上了。
	check("有落盘失败横幅", indexHtml.includes('id="storage-banner"') && styleSource.includes(".storage-banner"));
	check("脚本里有落盘轮询与重试", appSource.includes("refreshStorageStatus") && appSource.includes("/api/storage/retry"));

	// 库作用域：案头上的设定官要能选模型、能收资料。
	// 早先案头把模型下拉藏了，加上智能体之后就没法用它备料。
	check("案头不再藏模型选择", !styleSource.includes(".desk.is-home #model-select"));
	check("库面板有传资料入口", indexHtml.includes('id="library-upload-pick"') && indexHtml.includes('id="library-upload-input"'));
	check("库面板有原料列表", indexHtml.includes('id="library-uploads"'));
	check("库上传走不绑工程的接口", appSource.includes('"/api/uploads"') && appSource.includes('handleFiles([...event.target.files], "library")'));
	check("库原料列表有样式", styleSource.includes(".upload-list.compact"));
	check("库提炼指令要求脱离作品", appSource.includes("脱离本书也成立"));

	// 另起一席：会话是常驻的，作者要能主动清一次，否则历史一直攒。
	check("三个面板都有另起一席", (indexHtml.match(/data-newchat=/g) ?? []).length === 3, String((indexHtml.match(/data-newchat=/g) ?? []).length));
	check("另起一席有二次确认", appSource.includes("pendingNewChat") && appSource.includes("再点一次：弃掉这席"));
	check("另起一席会删服务端会话", appSource.includes('method: "DELETE"') && appSource.includes("/api/sessions/"));
	check("另起一席会清面板与快照", appSource.includes("state.transcripts.delete(key)") && appSource.includes("replaceChildren()"));
	check("发话会收掉确认态", appSource.includes("state.pendingNewChat = null"));
	// 没有章节时也要看得见料：装配区给立章按钮，库里列出全部素材、装配按钮停用。
	check(
		"无章节时仍列出素材",
		appSource.includes("poolShown") && appSource.includes('materialGrid(poolShown, "pool", true)'),
	);
	check("无章节时的提示与停用按钮有样式", styleSource.includes(".bench-hint") && styleSource.includes(".btn:disabled"));

	// 生文工作台的「库中可装」也要能搜、能分类：控件与素材工作台同一套。
	check(
		"生文工作台有素材检索与分类",
		indexHtml.includes('id="pool-search"') &&
			indexHtml.includes('id="pool-filter"') &&
			appSource.includes("poolMatches") &&
			appSource.includes("renderPoolFilter"),
	);
	check("生文工作台复用素材工作台的检索样式", styleSource.includes(".mat-search") && styleSource.includes(".mat-filter"));

	// 作业条（选章 / 写法 / 落笔）挂在执笔者栏里，夹在对话流与输入框之间 ——
	// 原先它在左栏「装配」底下，落笔却要回头看右栏，手和眼睛不在同一处。
	check(
		"写作作业条在执笔者栏里",
		indexHtml.lastIndexOf('id="write-actions"') > indexHtml.lastIndexOf('id="writing-stream"') &&
			indexHtml.lastIndexOf('id="write-actions"') < indexHtml.lastIndexOf('id="writing-composer"'),
	);
	check(
		"作业条能直接选章节",
		appSource.includes("function renderWriteActions") &&
			appSource.includes("function setWriteChapter") &&
			appSource.includes('"write-chapter"'),
	);

	// ---- 昼夜 ----
	// 暗色不是反相，而是把纸压成暖黑、把墨提成月白：两套令牌都要在，
	// 且各自独立定义纸与墨，浓淡关系才不塌。
	check("有主题开关", indexHtml.includes('id="theme-toggle"'));
	check("首帧前定主题（防白闪）", indexHtml.includes("novel-studio-theme") && indexHtml.indexOf("novel-studio-theme") < indexHtml.indexOf("/style.css"));
	check("样式里有暗色主题块", styleSource.includes(':root[data-theme="dark"]'));
	check("暗色声明了 color-scheme", styleSource.includes("color-scheme: dark"));
	check("开关图元有样式", styleSource.includes(".theme-glyph"));
	check("脚本里有主题切换", appSource.includes("THEME_KEY") && appSource.includes("toggleTheme"));
	check("跟随系统偏好", appSource.includes("prefers-color-scheme: dark"));
	// 尊重系统的「减少动态效果」
	check("尊重减少动态效果", styleSource.includes("prefers-reduced-motion"));

	// 令牌块之外不能再有硬编码颜色：漏一处，暗色下那一处就还是亮色的。
	const lightTokens = styleSource.match(/^:root \{([\s\S]*?)^\}/m)?.[1] ?? "";
	const darkTokens = styleSource.match(/^:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m)?.[1] ?? "";
	const outside = styleSource.split(lightTokens).join("").split(darkTokens).join("");
	const hardcoded = outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
	check("令牌块之外没有硬编码颜色", hardcoded.length === 0, hardcoded.slice(0, 4).join(" "));
	// 引用的令牌都要有定义，否则会解析失败。
	// 定义不限于主题块：局部令牌（稿台的留白分量）挂在自己的选择器上是正当写法，
	// 只扫 :root 会把它误判成未定义。主题覆盖另有下面那条专门守。
	const declared = new Set<string>([...styleSource.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
	const undefinedTokens = [...new Set([...styleSource.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]!))]
		.filter((name) => !declared.has(name));
	check("引用的令牌都有定义", undefinedTokens.length === 0, undefinedTokens.join(" "));
	// 两套主题要覆盖同一组「会变色的」令牌
	const lightNames = new Set([...lightTokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
	const darkNames = new Set([...darkTokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
	const themeInvariant = new Set([
		"--serif", "--kai", "--sans", "--mono", "--song", "--noise", "--wash",
		// 排版三件套（字号/行距/版心）是全局设置，不随昼夜变化，故不要求在暗色块里重复。
		"--ms-font-size", "--ms-line-height", "--ms-measure",
		// 移动端度量同理：安全区（刘海/Home Indicator）与最小触控目标由设备决定，与主题无关。
		"--safe-t", "--safe-b", "--safe-l", "--safe-r", "--tap",
		// 排版阶梯（间距/圆角/字号）与墨晕曲线是尺度，不是颜色：换昼夜不该改版心与节奏。
		"--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6",
		"--r-1", "--r-2", "--r-3",
		"--fs-xs", "--fs-sm", "--fs-md", "--fs-lg", "--fs-xl",
		"--brush", "--tap-lg",
	]);
	const uncovered = [...lightNames].filter((n) => !darkNames.has(n) && !themeInvariant.has(n));
	check("会变色的令牌暗色都有覆盖", uncovered.length === 0, uncovered.join(" "));
	const traversal = await fetch(base + "/../package.json");
	check("路径遍历被挡住", traversal.status === 403 || traversal.status === 404, String(traversal.status));
	const unknown = await req("GET", "/api/nope");
	check("未知接口返回 404", unknown.status === 404);

	// 库作用域的上传：不绑工程也要能把资料喂给设定官。
	const libUpload = await req("POST", "/api/uploads?filename=%E9%9B%A8%E5%A4%9C.md", undefined, Buffer.from("赛博都市的雨夜总是酸雨。", "utf8"));
	check(
		"库上传接口可用（不绑工程）",
		libUpload.status === 200 && String(libUpload.data.upload?.text ?? "").includes("酸雨"),
		String(libUpload.status),
	);
	check("库上传带回文件名", libUpload.data.upload?.filename === "雨夜.md", String(libUpload.data.upload?.filename));
	const libUploadNoName = await req("POST", "/api/uploads", undefined, Buffer.from("x"));
	check("库上传缺 filename 报 400", libUploadNoName.status === 400, String(libUploadNoName.status));

	// 库作用域的会话：同样不绑工程。
	// 测试环境没配模型，所以这里注定停在"请指定模型"——
	// 关键是它不该报"缺少 projectId"，那才说明库作用域真的跳过了工程门槛。
	const libSession = await req("POST", "/api/sessions", { scope: "library", role: "material" });
	check(
		"库会话不要求 projectId",
		libSession.status !== 400 || String(libSession.data.error ?? "").includes("模型"),
		libSession.status + " " + String(libSession.data.error ?? ""),
	);
	check("库会话不报缺少 projectId", !String(libSession.data.error ?? "").includes("projectId"), String(libSession.data.error ?? ""));
	// 对照：不带 scope 时缺 projectId 必须被挡下。
	const libSessionNoProject = await req("POST", "/api/sessions", { role: "material" });
	check("缺 projectId 仍报 400", libSessionNoProject.status === 400, String(libSessionNoProject.status));
	check("缺 projectId 的报错点名它", String(libSessionNoProject.data.error ?? "").includes("projectId"), String(libSessionNoProject.data.error ?? ""));

	// 另起一席要能删掉服务端会话，否则它会一直挂到 TTL 到期。
	const goneSession = await req("DELETE", "/api/sessions/does-not-exist");
	check("删不存在的会话返回 404", goneSession.status === 404, String(goneSession.status));
	check("删会话的路由确实注册了", !String(goneSession.data.error ?? "").includes("未知接口"), String(goneSession.data.error ?? ""));
} catch (error) {
	failures += 1;
	console.log("\n运行中断：" + (error as Error).message);
} finally {
	child.kill();
	mockServer.closeAllConnections();
	mockServer.close();
	searchServer.closeAllConnections();
	searchServer.close();
	dns.lookup = originalLookup;
	// 落盘是异步的，给进程与文件句柄一点收尾时间。
	await new Promise((resolve) => setTimeout(resolve, 300));
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
