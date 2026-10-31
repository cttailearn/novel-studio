/**
 * llm-client 的自检脚本。
 *
 * 要验的是"浏览器里那套 fetch 版 LLM 客户端"到底对不对：
 *   1. 四种 API 格式的 SSE 都能解析成 pi-ai 的事件序列；
 *   2. 工具调用能拼成完整的 ToolCall（参数是对象，不是字符串）；
 *   3. 请求体形状对得上各家规范（system、工具结果怎么映射）；
 *   4. 鉴权头对得上各家规范；
 *   5. 中断、重试、中继三条边界路径 behave 得对。
 *
 * 上游用 node:http 在 127.0.0.1 上起一个假服务器冒充，不连外网、不写任何文件。
 *
 * 跑法：node --experimental-strip-types scripts/llm-client-check.ts
 */
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	Tool,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { buildProviderRequest, createLlmClient, type ApiFormat } from "../src/ai/llm-client.ts";

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

// ───────────────────────────────────────────── 小工具

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
	return typeof value === "number" ? value : Number.NaN;
}

/** 按路径取值：at(body, "messages", 0, "role") */
function at(value: unknown, ...path: (string | number)[]): unknown {
	let current: unknown = value;
	for (const key of path) {
		if (typeof key === "number") current = arr(current)[key];
		else current = obj(current)[key];
	}
	return current;
}

function eventTypes(events: readonly AssistantMessageEvent[]): string[] {
	return events.map((event) => event.type);
}

/** 收完整条事件流。 */
async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

// ───────────────────────────────────────────── 假上游的 SSE 素材

function sse(lines: string[]): string {
	return lines.map((line) => `${line}\n\n`).join("");
}

/** 正文：她推开门，风雪灌了进来。 */
const TEXT_A = "她推开门，";
const TEXT_B = "风雪灌了进来。";
const TEXT_ALL = TEXT_A + TEXT_B;
/** 工具参数：分两段流式送过来。 */
const ARGS_A = '{"chapter":1,';
const ARGS_B = '"title":"风雪夜"}';
const ARGS_ALL = ARGS_A + ARGS_B;

const SSE_OPENAI_COMPLETIONS = sse([
	'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
	`data: {"choices":[{"index":0,"delta":{"content":"${TEXT_A}"},"finish_reason":null}]}`,
	`data: {"choices":[{"index":0,"delta":{"content":"${TEXT_B}"},"finish_reason":null}]}`,
	'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"save_draft","arguments":"{\\"chapter\\":1,"}}]},"finish_reason":null}]}',
	'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"title\\":\\"风雪夜\\"}"}}]},"finish_reason":null}]}',
	'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
	'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":20}}}',
	"data: [DONE]",
]);

const SSE_OPENAI_RESPONSES = sse([
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","status":"in_progress"}}',
	'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_test","type":"message","role":"assistant","content":[]}}',
	`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_test","delta":"${TEXT_A}"}`,
	`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_test","delta":"${TEXT_B}"}`,
	`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_test","type":"message","role":"assistant","content":[{"type":"output_text","text":"${TEXT_ALL}"}]}}`,
	'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_test","type":"function_call","call_id":"call_abc","name":"save_draft","arguments":""}}',
	`event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_test","delta":"{\\"chapter\\":1,"}`,
	`event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_test","delta":"\\"title\\":\\"风雪夜\\"}"}`,
	`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"id":"fc_test","type":"function_call","call_id":"call_abc","name":"save_draft","arguments":"{\\"chapter\\":1,\\"title\\":\\"风雪夜\\"}"}}`,
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed","usage":{"input_tokens":100,"output_tokens":40,"cached_tokens":20,"total_tokens":120}}}',
]);

const SSE_ANTHROPIC = sse([
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":0}}}',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${TEXT_A}"}}`,
	`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${TEXT_B}"}}`,
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
	'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_test","name":"save_draft","input":{}}}',
	`event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"chapter\\":1,"}}`,
	`event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"title\\":\\"风雪夜\\"}"}}`,
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":40}}',
	'event: message_stop\ndata: {"type":"message_stop"}',
]);

const SSE_GOOGLE = sse([
	`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"${TEXT_A}"}]},"index":0}]}`,
	`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"${TEXT_B}"}]},"index":0}]}`,
	'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"save_draft","args":{"chapter":1,"title":"风雪夜"}}}]},"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"cachedContentTokenCount":20,"totalTokenCount":120}}',
]);

// ───────────────────────────────────────────── 假上游服务器

interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}

const captured: CapturedRequest[] = [];
const relayRequests: Record<string, unknown>[] = [];
let requestCount = 0;

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string") out[name.toLowerCase()] = value;
	}
	return out;
}

/** 分小块吐 SSE，顺带考验增量解析器。 */
async function writeSse(res: ServerResponse, payload: string): Promise<void> {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const size = 24;
	for (let index = 0; index < payload.length; index += size) {
		res.write(payload.slice(index, index + size));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	res.end();
}

function route(request: CapturedRequest, res: ServerResponse): void {
	const path = request.url.split("?")[0] ?? "";
	if (path === "/api/llm") {
		relayRequests.push(obj(JSON.parse(request.body)));
		if (str(obj(JSON.parse(request.body))["target"]).includes("/boom")) {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "中继炸了" }));
			return;
		}
		void writeSse(res, SSE_OPENAI_COMPLETIONS);
		return;
	}
	if (path.includes("/boom")) {
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "上游炸了" }));
		return;
	}
	if (path.includes("/hang")) {
		// 故意不回应 —— 用来测中断。
		return;
	}
	if (path.endsWith("/chat/completions")) {
		void writeSse(res, SSE_OPENAI_COMPLETIONS);
		return;
	}
	if (path.endsWith("/responses")) {
		void writeSse(res, SSE_OPENAI_RESPONSES);
		return;
	}
	if (path.endsWith("/messages")) {
		void writeSse(res, SSE_ANTHROPIC);
		return;
	}
	if (path.includes(":streamGenerateContent")) {
		void writeSse(res, SSE_GOOGLE);
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: `没有这个路径：${path}` }));
}

const server: Server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		requestCount += 1;
		const request: CapturedRequest = {
			method: req.method ?? "",
			url: req.url ?? "",
			headers: normalizeHeaders(req.headers),
			body: Buffer.concat(chunks).toString("utf8"),
		};
		captured.push(request);
		route(request, res);
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
const port = address.port;
const origin = `http://127.0.0.1:${port}`;

// ───────────────────────────────────────────── 测试用素材

const TOOL: Tool = {
	name: "save_draft",
	description: "保存草稿",
	parameters: {
		type: "object",
		properties: { chapter: { type: "number" }, title: { type: "string" } },
		required: ["chapter"],
	} as unknown as Tool["parameters"],
};

const USAGE_ZERO = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MESSAGES: Message[] = [
	{ role: "system", content: "你是一个长篇小说写作助手。", toolsAdded: [TOOL], timestamp: 1 },
	{ role: "user", content: "写第一章。", timestamp: 2 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "好。" },
			{ type: "toolCall", id: "call_prev", name: "save_draft", arguments: { chapter: 0 } },
		],
		api: "openai-completions",
		provider: "test-provider",
		model: "test-model",
		usage: USAGE_ZERO,
		stopReason: "toolUse",
		timestamp: 3,
	},
	{
		role: "toolResult",
		toolCallId: "call_prev",
		toolName: "save_draft",
		content: [{ type: "text", text: "已保存" }],
		isError: false,
		timestamp: 4,
	},
];

const CONTEXT = { messages: MESSAGES } as unknown as TranscriptContext;

function makeModel(api: string, baseUrl: string, id = "test-model"): Model<any> {
	return {
		id,
		name: "测试模型",
		api,
		provider: "test-provider",
		baseUrl,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function doneMessage(events: readonly AssistantMessageEvent[]): AssistantMessage | undefined {
	for (const event of events) {
		if (event.type === "done") return event.message;
	}
	return undefined;
}

function toolCallOf(message: AssistantMessage | undefined): { id: string; name: string; arguments: unknown } | undefined {
	const block = message?.content.find((item) => item.type === "toolCall");
	if (!block || block.type !== "toolCall") return undefined;
	return { id: block.id, name: block.name, arguments: block.arguments };
}

// ───────────────────────────────────────────── 逐个格式核对

interface FormatCase {
	format: ApiFormat;
	baseUrl: string;
	expectedPath: string;
	expectedEvents: string[];
	expectedUsage: { input: number; output: number; cacheRead: number; totalTokens: number };
	authHeader: string;
	authValue: string;
}

const CASES: FormatCase[] = [
	{
		format: "openai-completions",
		baseUrl: `${origin}/v1`,
		expectedPath: "/v1/chat/completions",
		expectedEvents: [
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		],
		expectedUsage: { input: 80, output: 40, cacheRead: 20, totalTokens: 140 },
		authHeader: "authorization",
		authValue: "Bearer test-key",
	},
	{
		format: "openai-responses",
		baseUrl: `${origin}/v1`,
		expectedPath: "/v1/responses",
		expectedEvents: [
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		],
		expectedUsage: { input: 80, output: 40, cacheRead: 20, totalTokens: 120 },
		authHeader: "authorization",
		authValue: "Bearer test-key",
	},
	{
		format: "anthropic-messages",
		baseUrl: `${origin}/v1`,
		expectedPath: "/v1/messages",
		expectedEvents: [
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		],
		expectedUsage: { input: 80, output: 40, cacheRead: 20, totalTokens: 140 },
		authHeader: "x-api-key",
		authValue: "test-key",
	},
	{
		format: "google-generative-ai",
		baseUrl: `${origin}/v1beta`,
		expectedPath: "/v1beta/models/test-model:streamGenerateContent?alt=sse",
		expectedEvents: [
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		],
		expectedUsage: { input: 80, output: 20, cacheRead: 20, totalTokens: 120 },
		authHeader: "x-goog-api-key",
		authValue: "test-key",
	},
];

for (const testCase of CASES) {
	console.log(`\n【${testCase.format}】`);
	const client = createLlmClient({ resolveApiKey: () => "test-key" });
	const model = makeModel(testCase.format, testCase.baseUrl);
	const before = captured.length;
	const events = await collect(client.streamSimple(model, CONTEXT));
	const request = captured[before];

	check(
		"事件序列正确",
		eventTypes(events).join(",") === testCase.expectedEvents.join(","),
		`实际 ${eventTypes(events).join(",")}`,
	);
	check("请求是 POST", request?.method === "POST", String(request?.method));
	check("请求路径正确", request?.url === testCase.expectedPath, String(request?.url));
	check(
		`鉴权头 ${testCase.authHeader} 正确`,
		request?.headers[testCase.authHeader] === testCase.authValue,
		String(request?.headers[testCase.authHeader]),
	);

	const message = doneMessage(events);
	check("done 事件带回了完整消息", message !== undefined);
	const text = message?.content.find((item) => item.type === "text");
	check("正文拼对了", text?.type === "text" && text.text === TEXT_ALL, JSON.stringify(text));
	const call = toolCallOf(message);
	check("工具调用名字对", call?.name === "save_draft", String(call?.name));
	check("工具调用 id 对", call?.id.length !== 0, String(call?.id));
	check(
		"工具参数解析成对象",
		!!call && typeof call.arguments === "object" && num(at(call.arguments, "chapter")) === 1,
		JSON.stringify(call?.arguments),
	);
	check("工具参数里的字符串也对", str(at(call?.arguments, "title")) === "风雪夜");
	check(
		"usage 记下来了",
		!!message &&
			message.usage.input === testCase.expectedUsage.input &&
			message.usage.output === testCase.expectedUsage.output &&
			message.usage.cacheRead === testCase.expectedUsage.cacheRead &&
			message.usage.totalTokens === testCase.expectedUsage.totalTokens,
		JSON.stringify(message?.usage),
	);
	check("stopReason 是 toolUse", message?.stopReason === "toolUse", String(message?.stopReason));

	const body = obj(JSON.parse(request?.body ?? "{}"));
	if (testCase.format === "openai-completions") {
		check("body 里 model 对", str(body["model"]) === "test-model");
		check("body 里 stream 是 true", body["stream"] === true);
		check("body 里带了 include_usage", at(body, "stream_options", "include_usage") === true);
		check("system 消息在第一条", at(body, "messages", 0, "role") === "system");
		check("system 内容对", str(at(body, "messages", 0, "content")) === "你是一个长篇小说写作助手。");
		check("user 消息在第二条", at(body, "messages", 1, "role") === "user");
		check("助手消息带 tool_calls", at(body, "messages", 2, "tool_calls", 0, "function", "name") === "save_draft");
		check("工具结果映射成 role=tool", at(body, "messages", 3, "role") === "tool");
		check("工具结果带上 tool_call_id", at(body, "messages", 3, "tool_call_id") === "call_prev");
		check("工具声明是 function 形状", at(body, "tools", 0, "type") === "function");
		check("工具声明里有参数表", at(body, "tools", 0, "function", "parameters", "type") === "object");
	} else if (testCase.format === "openai-responses") {
		check("body 里 model 对", str(body["model"]) === "test-model");
		check("body 里 stream 是 true", body["stream"] === true);
		check("系统提示词进了 instructions", str(body["instructions"]) === "你是一个长篇小说写作助手。");
		check("user 条目是 input_text", at(body, "input", 0, "content", 0, "type") === "input_text");
		check("助手消息是 message 条目", at(body, "input", 1, "type") === "message");
		check("工具调用是 function_call 条目", at(body, "input", 2, "type") === "function_call");
		check("function_call 带 call_id", at(body, "input", 2, "call_id") === "call_prev");
		check("工具结果是 function_call_output", at(body, "input", 3, "type") === "function_call_output");
		check("工具结果带上 call_id", at(body, "input", 3, "call_id") === "call_prev");
		check("工具声明是平铺的 function", at(body, "tools", 0, "type") === "function");
		check("工具声明里有参数表", at(body, "tools", 0, "parameters", "type") === "object");
	} else if (testCase.format === "anthropic-messages") {
		check("body 里 model 对", str(body["model"]) === "test-model");
		check("body 里 stream 是 true", body["stream"] === true);
		check("body 里带 max_tokens", num(body["max_tokens"]) === 4096);
		check("系统提示词进了 system 块", at(body, "system", 0, "text") === "你是一个长篇小说写作助手。");
		check("user 消息在第一条", at(body, "messages", 0, "role") === "user");
		check("助手消息带 tool_use 块", at(body, "messages", 1, "content", 1, "type") === "tool_use");
		check("工具结果是 tool_result 块", at(body, "messages", 2, "content", 0, "type") === "tool_result");
		check("tool_result 对上 tool_use_id", at(body, "messages", 2, "content", 0, "tool_use_id") === "call_prev");
		check("工具声明用 input_schema", at(body, "tools", 0, "input_schema", "type") === "object");
		check("anthropic-version 头对", request?.headers["anthropic-version"] === "2023-06-01");
		check(
			"浏览器直连头对",
			request?.headers["anthropic-dangerous-direct-browser-access"] === "true",
			String(request?.headers["anthropic-dangerous-direct-browser-access"]),
		);
	} else {
		check("系统提示词进了 systemInstruction", at(body, "systemInstruction", "parts", 0, "text") === "你是一个长篇小说写作助手。");
		check("user 轮次在第一条", at(body, "contents", 0, "role") === "user");
		check("助手轮次是 model", at(body, "contents", 1, "role") === "model");
		check("助手轮次带 functionCall", at(body, "contents", 1, "parts", 1, "functionCall", "name") === "save_draft");
		check("工具结果是 functionResponse", at(body, "contents", 2, "parts", 0, "functionResponse", "name") === "save_draft");
		check("工具声明用 functionDeclarations", at(body, "tools", 0, "functionDeclarations", 0, "name") === "save_draft");
	}
}

// ───────────────────────────────────────────── buildProviderRequest 直接调用

console.log("\n【buildProviderRequest】");
{
	const model = makeModel("anthropic-messages", `${origin}/v1/`);
	const request = buildProviderRequest("anthropic-messages", model, CONTEXT, { apiKey: "test-key" });
	check("URL 对", request.url === `${origin}/v1/messages`, request.url);
	check("方法是 POST", request.init.method === "POST");
	check("鉴权头对", request.init.headers["x-api-key"] === "test-key");
	check("版本头对", request.init.headers["anthropic-version"] === "2023-06-01");
	check("body 是 JSON 字符串", typeof request.init.body === "string");
	const body = obj(JSON.parse(str(request.init.body)));
	check("body 里 model 对", str(body["model"]) === "test-model");
}

// ───────────────────────────────────────────── 缺 Key 同步抛错

console.log("\n【缺 Key】");
{
	const client = createLlmClient({ resolveApiKey: () => undefined });
	let threw = false;
	try {
		client.streamSimple(makeModel("openai-completions", `${origin}/v1`), CONTEXT);
	} catch {
		threw = true;
	}
	check("缺 Key 时同步抛错", threw);
}

// ───────────────────────────────────────────── 中断

console.log("\n【中断】");
{
	const client = createLlmClient({ resolveApiKey: () => "test-key" });
	const controller = new AbortController();
	const model = makeModel("openai-completions", `${origin}/hang`);
	const stream = client.streamSimple(model, CONTEXT, { signal: controller.signal, maxRetries: 0 });
	setTimeout(() => controller.abort(), 60);
	const events = await collect(stream);
	const last = events[events.length - 1];
	check("中断后收到 error 事件", last?.type === "error", String(last?.type));
	check("中断原因是 aborted", last?.type === "error" && last.reason === "aborted", String(last?.type));
	check("中断时没有 done", !eventTypes(events).includes("done"));
}

// ───────────────────────────────────────────── 超时

console.log("\n【超时】");
{
	const client = createLlmClient({ resolveApiKey: () => "test-key" });
	const model = makeModel("openai-completions", `${origin}/hang`);
	const events = await collect(client.streamSimple(model, CONTEXT, { timeoutMs: 80, maxRetries: 0 }));
	const last = events[events.length - 1];
	check("超时后收到 error 事件", last?.type === "error", String(last?.type));
	check("超时的原因是 error（不是 aborted）", last?.type === "error" && last.reason === "error", String(last?.type));
	check("超时了也没有 done", !eventTypes(events).includes("done"));
}

// ───────────────────────────────────────────── 重试

console.log("\n【重试】");
{
	const client = createLlmClient({ resolveApiKey: () => "test-key" });
	const model = makeModel("openai-completions", `${origin}/boom`);
	const before = requestCount;
	const events = await collect(client.streamSimple(model, CONTEXT, { maxRetries: 2 }));
	const last = events[events.length - 1];
	check("500 最后变成 error 事件", last?.type === "error", String(last?.type));
	check("错误消息里带着 500", last?.type === "error" && str(last.error.errorMessage).includes("500"), String(last?.type));
	check("一共试了 3 次（1 次 + 2 次重试）", requestCount - before === 3, String(requestCount - before));
}

// ───────────────────────────────────────────── 中继

console.log("\n【中继】");
{
	const client = createLlmClient({
		resolveApiKey: () => "test-key",
		transport: "relay",
		relayUrl: `${origin}/api/llm`,
	});
	const model = makeModel("openai-completions", `${origin}/upstream`);
	const before = relayRequests.length;
	const events = await collect(client.streamSimple(model, CONTEXT));
	const relay = obj(relayRequests[before]);
	check("中继收到一条请求", relayRequests.length === before + 1);
	check("target 指向上游地址", str(relay["target"]) === `${origin}/upstream/chat/completions`, str(relay["target"]));
	check("apiKey 单独带给中继", str(relay["apiKey"]) === "test-key");
	check("鉴权头名带过去了", str(relay["authHeader"]) === "authorization");
	check("鉴权前缀带过去了", str(relay["authScheme"]) === "Bearer ");
	check("headers 里没有夹带鉴权头", relay["headers"] !== undefined && !("authorization" in obj(relay["headers"])));
	check("headers 里有 content-type", at(relay, "headers", "content-type") === "application/json");
	check("上游请求体带过去了", at(relay, "body", "model") === "test-model");
	check("上游请求体带 stream", at(relay, "body", "stream") === true);
	const message = doneMessage(events);
	check("中继回来的 SSE 也解析了", message !== undefined);
	check("中继回来的正文对", str(at(message?.content, 0, "text")) === TEXT_ALL);
	check("中继回来的工具调用对", toolCallOf(message)?.name === "save_draft");
}
{
	const client = createLlmClient({
		resolveApiKey: () => "test-key",
		transport: "relay",
		relayUrl: `${origin}/api/llm`,
	});
	const model = makeModel("openai-completions", `${origin}/boom`);
	const events = await collect(client.streamSimple(model, CONTEXT, { maxRetries: 0 }));
	const last = events[events.length - 1];
	check("中继报错时给 error 事件", last?.type === "error", String(last?.type));
	check(
		"中继的报错消息透出来了",
		last?.type === "error" && str(last.error.errorMessage).includes("中继炸了"),
		last?.type === "error" ? str(last.error.errorMessage) : "",
	);
}

// ───────────────────────────────────────────── 收尾

server.closeAllConnections();
server.close();

console.log(failed === 0 ? "\n全部通过" : `\n有 ${failed} 项没过`);
if (failed > 0) process.exitCode = 1;
