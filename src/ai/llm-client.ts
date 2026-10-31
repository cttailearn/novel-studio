/**
 * 浏览器端的 LLM 客户端。
 *
 * 为什么不用 pi-ai 自带的 streamSimple：它的各家适配器依赖 openai /
 * @anthropic-ai/sdk / @google/genai 这些 SDK，浏览器里没法直接跑；而这个项目
 * 没有打包器，也不打算为了跑一次推理引入一整套依赖树。所以这里用 fetch 重新
 * 实现四种 API 格式的请求与 SSE 解析，对外仍然产出 pi-ai 的
 * AssistantMessageEventStream —— agent 循环那一侧一行都不用改。
 *
 * 硬约束（改之前先看一眼）：
 * · 不能 import node: 内置模块 —— 这个文件要能在浏览器里跑。
 * · 运行时只能从 "@earendil-works/pi-ai/utils/event-stream" 这个深层路径取事件流；
 *   pi-ai 的根入口会把各家 SDK 一起拖进来。
 * · 缺 Key 必须同步抛错：agent 循环靠这个区分"用户没配 Key"和"上游报错"。
 *
 * 四种格式：
 * · openai-completions    —— POST {baseUrl}/chat/completions
 * · openai-responses      —— POST {baseUrl}/responses
 * · anthropic-messages    —— POST {baseUrl}/messages
 * · google-generative-ai  —— POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse
 */

import type {
	AssistantMessage,
	ImageContent,
	JsonObject,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	SystemMessage,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

// ───────────────────────────────────────────── 对外类型

/** 项目支持的四种 API 格式。 */
export type ApiFormat = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface LlmClientOptions {
	/** 取用户自己的 API Key。没有就返回 undefined —— 不许抛错。 */
	resolveApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
	/** "direct" = 浏览器直连上游（要过 CORS）；"relay" = 走我们自己的无状态中继。 */
	transport?: "direct" | "relay";
	/** 中继地址。默认 "/api/llm"。 */
	relayUrl?: string;
	/** 可注入的 fetch。默认 globalThis.fetch。 */
	fetchImpl?: typeof fetch;
}

export interface LlmClient {
	/** 与 pi-ai 的 Models.streamSimple 同形，withStreamDefaults() 可以直接拿来用。 */
	streamSimple: (
		model: Model<any>,
		context: TranscriptContext,
		options?: SimpleStreamOptions & { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal },
	) => AssistantMessageEventStream;
}

/** 组请求时用得到的选项。 */
export interface ProviderRequestOptions {
	/** 上游 Key。direct 模式下写进鉴权头；relay 模式下随请求体带给中继。 */
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
	toolChoice?: "auto" | "none";
	/** 思考档位。只会映射成各家认识的 effort 值，不认识的就不发。 */
	reasoning?: ThinkingLevel;
	/** 额外请求头。会覆盖同名默认值。 */
	headers?: Record<string, string>;
}

export interface ProviderRequest {
	url: string;
	init: RequestInit & { headers: Record<string, string> };
}

// ───────────────────────────────────────────── 常量

/** 单次请求的兜底超时（毫秒）。与 novel-agent 的 STREAM_TIMEOUT_MS 一致。 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** 兜底重试次数。与 novel-agent 的 STREAM_MAX_RETRIES 一致。 */
export const DEFAULT_MAX_RETRIES = 2;

/** 重试退避的基数与上限（毫秒）。 */
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 5_000;

/** Anthropic 要求带版本头。 */
const ANTHROPIC_VERSION = "2023-06-01";

// ───────────────────────────────────────────── 转录（transcript）辅助
//
// pi-ai 的语义：系统提示词与工具声明都装在转录里的 system 消息中，
// 不在 context.systemPrompt / context.tools 上。下面这几个函数是 pi-ai
// dist/utils/{text,transcript}.js 的等价实现（那两个文件是浏览器安全的，
// 但这里自己抄一份，好让本文件只有一个运行时依赖：事件流）。

/** 取文本块里的文字。 */
function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** 把一条 system 消息渲染成完整的提示词：正文 + 各小节。 */
function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** 解析转录里当前生效的工具：按顺序回放 toolsRemoved / toolsAdded。 */
function getCurrentTools(messages: readonly Message[]): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
	}
	return [...tools.values()];
}

/**
 * 把所有 system 消息重放成一条打头的 system 消息。
 *
 * 四个 API 都不接受"对话中间插一条 system"，所以统一折叠：正文按顺序拼起来，
 * 小节按名字覆盖，工具按增删回放。
 */
function collapseSystemMessages(messages: readonly Message[]): { system?: SystemMessage; messages: Message[] } {
	const content: string[] = [];
	const sections = new Map<string, string | null>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (message.role !== "system") continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	const rest = messages.filter((message) => message.role !== "system");
	if (content.length === 0 && sections.size === 0 && tools.length === 0) {
		return { messages: rest as Message[] };
	}
	const system: SystemMessage = {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
	return { system, messages: rest as Message[] };
}

/** 工具的参数模式：JSON 往返一次，丢掉 typebox 挂在对象上的 symbol 键。 */
function toolParameters(tool: Tool): Record<string, unknown> {
	try {
		return JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
	} catch {
		return { type: "object", properties: {} };
	}
}

/** 助手消息里的正文（不含思考、不含工具调用）。 */
function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** 助手消息里的工具调用。 */
function assistantToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/** 工具结果里的文字。 */
function toolResultText(message: ToolResultMessage): string {
	const text = contentText(message.content);
	if (text.length > 0) return text;
	return message.content.some((block) => block.type === "image") ? "(see attached image)" : "(no tool output)";
}

// ───────────────────────────────────────────── 各家消息格式

function userContentToOpenAi(content: string | readonly (TextContent | ImageContent)[]): string | unknown[] {
	if (typeof content === "string") return content;
	const parts: unknown[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push({ type: "text", text: block.text });
		} else {
			parts.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
		}
	}
	return parts;
}

function userContentToAnthropic(content: string | readonly (TextContent | ImageContent)[]): string | unknown[] {
	if (typeof content === "string") return content;
	const parts: unknown[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.trim().length > 0) parts.push({ type: "text", text: block.text });
		} else {
			parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		}
	}
	return parts;
}

/** OpenAI Chat Completions 的 messages。 */
function toOpenAiMessages(messages: readonly Message[]): unknown[] {
	const out: unknown[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			out.push({ role: "system", content: getSystemMessageText(message) });
		} else if (message.role === "user") {
			out.push({ role: "user", content: userContentToOpenAi(message.content) });
		} else if (message.role === "assistant") {
			const text = assistantText(message);
			const calls = assistantToolCalls(message);
			if (text.length === 0 && calls.length === 0) continue;
			const entry: Record<string, unknown> = { role: "assistant", content: text.length === 0 ? null : text };
			if (calls.length > 0) {
				entry["tool_calls"] = calls.map((call) => ({
					id: call.id,
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
				}));
			}
			out.push(entry);
		} else if (message.role === "toolResult") {
			out.push({ role: "tool", content: toolResultText(message), tool_call_id: message.toolCallId });
		}
	}
	return out;
}

/** OpenAI Responses 的 input 条目 + instructions。 */
function toResponsesInput(messages: readonly Message[]): { instructions?: string; input: unknown[] } {
	const input: unknown[] = [];
	let instructions: string | undefined;
	let counter = 0;
	for (const message of messages) {
		if (message.role === "system") {
			const text = getSystemMessageText(message);
			if (text.length === 0) continue;
			if (instructions === undefined) instructions = text;
			else input.push({ role: "system", content: text });
		} else if (message.role === "user") {
			const content = message.content;
			if (typeof content === "string") {
				input.push({ role: "user", content: [{ type: "input_text", text: content }] });
			} else {
				const parts: unknown[] = [];
				for (const block of content) {
					if (block.type === "text") {
						if (block.text.length > 0) parts.push({ type: "input_text", text: block.text });
					} else {
						parts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}
				if (parts.length > 0) input.push({ role: "user", content: parts });
			}
		} else if (message.role === "assistant") {
			const text = assistantText(message);
			if (text.length > 0) {
				counter += 1;
				input.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text, annotations: [] }],
					status: "completed",
					id: `msg_pi_${counter}`,
				});
			}
			for (const call of assistantToolCalls(message)) {
				counter += 1;
				input.push({
					type: "function_call",
					id: `fc_${counter}`,
					call_id: call.id,
					name: call.name,
					arguments: JSON.stringify(call.arguments ?? {}),
				});
			}
		} else if (message.role === "toolResult") {
			input.push({ type: "function_call_output", call_id: message.toolCallId, output: toolResultText(message) });
		}
	}
	return instructions === undefined ? { input } : { instructions, input };
}

/** Anthropic 的 system 块与 messages。 */
function toAnthropicMessages(messages: readonly Message[]): { system: unknown[]; messages: unknown[] } {
	const system: unknown[] = [];
	const out: unknown[] = [];
	let pendingToolResults: unknown[] = [];

	const flushToolResults = (): void => {
		if (pendingToolResults.length === 0) return;
		out.push({ role: "user", content: pendingToolResults });
		pendingToolResults = [];
	};

	for (const message of messages) {
		if (message.role === "system") {
			const text = getSystemMessageText(message);
			if (text.length > 0) system.push({ type: "text", text });
		} else if (message.role === "user") {
			flushToolResults();
			const content = userContentToAnthropic(message.content);
			if (typeof content === "string") {
				if (content.trim().length > 0) out.push({ role: "user", content });
			} else if (content.length > 0) {
				out.push({ role: "user", content });
			}
		} else if (message.role === "assistant") {
			flushToolResults();
			const blocks: unknown[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const thinking = block as ThinkingContent;
					blocks.push({
						type: "thinking",
						thinking: thinking.thinking,
						...(thinking.thinkingSignature ? { signature: thinking.thinkingSignature } : {}),
					});
				} else {
					blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} });
				}
			}
			if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
		} else if (message.role === "toolResult") {
			pendingToolResults.push({
				type: "tool_result",
				tool_use_id: message.toolCallId,
				content: [{ type: "text", text: toolResultText(message) }],
				is_error: message.isError,
			});
		}
	}
	flushToolResults();
	return { system, messages: out };
}

/** Google Generative AI 的 contents 与 systemInstruction。 */
function toGeminiContents(messages: readonly Message[]): { systemInstruction?: unknown; contents: unknown[] } {
	const contents: unknown[] = [];
	let systemText = "";
	const pushUser = (parts: unknown[]): void => {
		const last = contents[contents.length - 1] as { role?: string; parts?: unknown[] } | undefined;
		if (last && last.role === "user" && Array.isArray(last.parts)) {
			last.parts.push(...parts);
			return;
		}
		contents.push({ role: "user", parts });
	};

	for (const message of messages) {
		if (message.role === "system") {
			systemText += getSystemMessageText(message);
		} else if (message.role === "user") {
			const parts: unknown[] = [];
			if (typeof message.content === "string") {
				parts.push({ text: message.content });
			} else {
				for (const block of message.content) {
					if (block.type === "text") parts.push({ text: block.text });
					else parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
				}
			}
			if (parts.length > 0) pushUser(parts);
		} else if (message.role === "assistant") {
			const parts: unknown[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.length > 0) parts.push({ text: block.text });
				} else if (block.type === "thinking") {
					const thinking = block as ThinkingContent;
					if (thinking.thinking.length > 0) parts.push({ thought: true, text: thinking.thinking });
				} else {
					parts.push({ functionCall: { name: block.name, args: block.arguments ?? {} } });
				}
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
		} else if (message.role === "toolResult") {
			const response = message.isError ? { error: toolResultText(message) } : { output: toolResultText(message) };
			pushUser([{ functionResponse: { name: message.toolName, response, id: message.toolCallId } }]);
		}
	}
	const systemInstruction = systemText.length > 0 ? { parts: [{ text: systemText }] } : undefined;
	return systemInstruction === undefined ? { contents } : { systemInstruction, contents };
}

// ───────────────────────────────────────────── 请求构造

interface PreparedRequest {
	url: string;
	body: Record<string, unknown>;
	/** 不含鉴权头的上游请求头。 */
	headers: Record<string, string>;
	/** 鉴权头名与前缀（x-api-key 这种没有前缀，前缀是空串）。 */
	authHeader: string;
	authScheme: string;
}

function baseUrlOf(model: Model<any>): string {
	return (model.baseUrl ?? "").replace(/\/+$/u, "");
}

/** 把思考档位映射成上游认识的 effort 值。不认识就不发。 */
function resolveReasoningEffort(model: Model<any>, reasoning: ThinkingLevel | undefined): string | undefined {
	if (!reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (typeof mapped === "string" && mapped.length > 0) return mapped;
	if (reasoning === "minimal" || reasoning === "low" || reasoning === "medium" || reasoning === "high") return reasoning;
	return undefined;
}

function prepareRequest(
	format: ApiFormat,
	model: Model<any>,
	context: TranscriptContext,
	options: ProviderRequestOptions,
): PreparedRequest {
	const { system, messages } = collapseSystemMessages(context.messages);
	const tools = getCurrentTools(context.messages);
	const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
	for (const [name, value] of Object.entries(model.headers ?? {})) {
		if (typeof value === "string") headers[name.toLowerCase()] = value;
	}
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		if (typeof value === "string") headers[name.toLowerCase()] = value;
	}

	if (format === "openai-completions") {
		const body: Record<string, unknown> = {
			model: model.id,
			messages: toOpenAiMessages(system ? [system, ...messages] : messages),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (tools.length > 0) {
			body["tools"] = tools.map((tool) => ({
				type: "function",
				function: { name: tool.name, description: tool.description, parameters: toolParameters(tool) },
			}));
		}
		if (options.toolChoice) body["tool_choice"] = options.toolChoice;
		if (typeof options.maxTokens === "number") body["max_tokens"] = options.maxTokens;
		if (typeof options.temperature === "number") body["temperature"] = options.temperature;
		const effort = resolveReasoningEffort(model, options.reasoning);
		if (effort) body["reasoning_effort"] = effort;
		return {
			url: `${baseUrlOf(model)}/chat/completions`,
			body,
			headers,
			authHeader: "authorization",
			authScheme: "Bearer ",
		};
	}

	if (format === "openai-responses") {
		const { instructions, input } = toResponsesInput(system ? [system, ...messages] : messages);
		const body: Record<string, unknown> = { model: model.id, input, stream: true };
		if (instructions !== undefined) body["instructions"] = instructions;
		if (tools.length > 0) {
			body["tools"] = tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: toolParameters(tool),
			}));
		}
		if (typeof options.maxTokens === "number") body["max_output_tokens"] = options.maxTokens;
		if (typeof options.temperature === "number") body["temperature"] = options.temperature;
		const effort = resolveReasoningEffort(model, options.reasoning);
		if (effort) body["reasoning"] = { effort };
		return {
			url: `${baseUrlOf(model)}/responses`,
			body,
			headers,
			authHeader: "authorization",
			authScheme: "Bearer ",
		};
	}

	if (format === "anthropic-messages") {
		const { system: systemBlocks, messages: anthropicMessages } = toAnthropicMessages(
			system ? [system, ...messages] : messages,
		);
		const body: Record<string, unknown> = {
			model: model.id,
			max_tokens: options.maxTokens ?? model.maxTokens,
			messages: anthropicMessages,
			stream: true,
		};
		if (systemBlocks.length > 0) body["system"] = systemBlocks;
		if (tools.length > 0) {
			body["tools"] = tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: toolParameters(tool),
			}));
		}
		if (options.toolChoice) body["tool_choice"] = { type: options.toolChoice };
		if (typeof options.temperature === "number") body["temperature"] = options.temperature;
		headers["anthropic-version"] = ANTHROPIC_VERSION;
		return {
			url: `${baseUrlOf(model)}/messages`,
			body,
			headers,
			authHeader: "x-api-key",
			authScheme: "",
		};
	}

	// google-generative-ai
	const { systemInstruction, contents } = toGeminiContents(system ? [system, ...messages] : messages);
	const body: Record<string, unknown> = { contents };
	if (systemInstruction !== undefined) body["systemInstruction"] = systemInstruction;
	if (tools.length > 0) {
		body["tools"] = [
			{
				functionDeclarations: tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: toolParameters(tool),
				})),
			},
		];
	}
	const generationConfig: Record<string, unknown> = {};
	if (typeof options.temperature === "number") generationConfig["temperature"] = options.temperature;
	if (typeof options.maxTokens === "number") generationConfig["maxOutputTokens"] = options.maxTokens;
	if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;
	return {
		url: `${baseUrlOf(model)}/models/${model.id}:streamGenerateContent?alt=sse`,
		body,
		headers,
		authHeader: "x-goog-api-key",
		authScheme: "",
	};
}

/**
 * 造出某个格式的上游请求。
 *
 * 这是 direct（浏览器直连上游）的样子：鉴权头已经写进去。
 * relay 模式另走一条路 —— 见 createLlmClient() 里的 buildRelayRequest()。
 */
export function buildProviderRequest(
	format: ApiFormat,
	model: Model<any>,
	context: TranscriptContext,
	options: ProviderRequestOptions = {},
): ProviderRequest {
	const prepared = prepareRequest(format, model, context, options);
	const headers: Record<string, string> = { ...prepared.headers, ...extraAuthHeaders(format, options.apiKey) };
	if (options.apiKey) headers[prepared.authHeader] = prepared.authScheme + options.apiKey;
	if (format === "anthropic-messages") headers["anthropic-dangerous-direct-browser-access"] = "true";
	return {
		url: prepared.url,
		init: {
			method: "POST",
			headers,
			body: JSON.stringify(prepared.body),
		},
	};
}

/**
 * 有些网关两种鉴权都认。
 *
 * Google 官方是 x-goog-api-key，但不少 OpenAI 兼容网关只认
 * Authorization: Bearer —— 两个都带上，省得用户为这个换 Key。
 */
function extraAuthHeaders(format: ApiFormat, apiKey: string | undefined): Record<string, string> {
	if (format === "google-generative-ai" && apiKey) return { authorization: `Bearer ${apiKey}` };
	return {};
}

// ───────────────────────────────────────────── 事件流骨架

interface TextBlock {
	kind: "text";
	content: TextContent;
	closed: boolean;
}

interface ThinkingBlock {
	kind: "thinking";
	content: ThinkingContent;
	closed: boolean;
}

interface ToolBlock {
	kind: "toolCall";
	content: ToolCall;
	/** 累积的原始 JSON 文本。 */
	raw: string;
	closed: boolean;
}

type Block = TextBlock | ThinkingBlock | ToolBlock;

/** 流的状态：partial 消息、块表、停止原因。 */
class StreamSession {
	readonly stream: AssistantMessageEventStream;
	readonly model: Model<any>;
	readonly format: ApiFormat;
	readonly output: AssistantMessage;
	readonly blocks: Block[] = [];
	readonly toolBlocks = new Map<string, ToolBlock>();
	textBlock?: TextBlock;
	thinkingBlock?: ThinkingBlock;
	stopReason: StopReason = "pending";
	rawStopReason?: string;
	errorMessage?: string;

	constructor(model: Model<any>, format: ApiFormat) {
		this.model = model;
		this.format = format;
		this.stream = new AssistantMessageEventStream();
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	indexOf(block: Block): number {
		return this.blocks.indexOf(block);
	}

	ensureText(): TextBlock {
		const existing = this.textBlock;
		if (existing) return existing;
		const block: TextBlock = { kind: "text", content: { type: "text", text: "" }, closed: false };
		this.textBlock = block;
		this.blocks.push(block);
		this.output.content.push(block.content);
		this.stream.push({ type: "text_start", contentIndex: this.blocks.length - 1, partial: this.output });
		return block;
	}

	ensureThinking(): ThinkingBlock {
		const existing = this.thinkingBlock;
		if (existing) return existing;
		const block: ThinkingBlock = {
			kind: "thinking",
			content: { type: "thinking", thinking: "" },
			closed: false,
		};
		this.thinkingBlock = block;
		this.blocks.push(block);
		this.output.content.push(block.content);
		this.stream.push({ type: "thinking_start", contentIndex: this.blocks.length - 1, partial: this.output });
		return block;
	}

	/** 取（或开）一个工具调用块。key 是上游给的稳定标识（index / call_id / item id）。 */
	ensureTool(key: string, id: string, name: string): ToolBlock {
		const existing = this.toolBlocks.get(key);
		if (existing) {
			if (!existing.content.id && id) existing.content.id = id;
			if (!existing.content.name && name) existing.content.name = name;
			return existing;
		}
		// 工具调用之前先把还开着的文本/思考块收掉：块序与事件序必须一致。
		this.closeText();
		this.closeThinking();
		const block: ToolBlock = {
			kind: "toolCall",
			content: { type: "toolCall", id, name, arguments: {} },
			raw: "",
			closed: false,
		};
		this.toolBlocks.set(key, block);
		this.blocks.push(block);
		this.output.content.push(block.content);
		this.stream.push({ type: "toolcall_start", contentIndex: this.blocks.length - 1, partial: this.output });
		return block;
	}

	closeText(): void {
		const block = this.textBlock;
		if (!block || block.closed) return;
		block.closed = true;
		this.stream.push({
			type: "text_end",
			contentIndex: this.indexOf(block),
			content: block.content.text,
			partial: this.output,
		});
	}

	closeThinking(): void {
		const block = this.thinkingBlock;
		if (!block || block.closed) return;
		block.closed = true;
		this.stream.push({
			type: "thinking_end",
			contentIndex: this.indexOf(block),
			content: block.content.thinking,
			partial: this.output,
		});
	}

	closeTool(block: ToolBlock): void {
		if (block.closed) return;
		block.closed = true;
		block.content.arguments = parseToolArguments(block.raw);
		this.stream.push({
			type: "toolcall_end",
			contentIndex: this.indexOf(block),
			toolCall: block.content,
			partial: this.output,
		});
	}

	/** 收尾：所有还开着的块都关上。 */
	closeAll(): void {
		this.closeText();
		this.closeThinking();
		for (const block of this.toolBlocks.values()) this.closeTool(block);
	}

	hasToolCalls(): boolean {
		return this.blocks.some((block) => block.kind === "toolCall");
	}
}

/** 工具参数：上游给的是 JSON 文本，这里解析成对象。 */
function parseToolArguments(raw: string): JsonObject {
	const text = raw.trim();
	if (text.length === 0) return {};
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as JsonObject;
		}
		return { value: parsed } as JsonObject;
	} catch {
		return {};
	}
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** 按模型的费率算钱。费率是"每百万 token"。 */
function applyCost(model: Model<any>, usage: Usage): void {
	const rates = model.cost;
	const perToken = (rate: number | undefined): number => (typeof rate === "number" ? rate : 0) / 1_000_000;
	usage.cost.input = perToken(rates?.input) * usage.input;
	usage.cost.output = perToken(rates?.output) * usage.output;
	usage.cost.cacheRead = perToken(rates?.cacheRead) * usage.cacheRead;
	usage.cost.cacheWrite = perToken(rates?.cacheWrite) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

// ───────────────────────────────────────────── SSE 解析

interface SseEvent {
	/** event: 字段；没有就是空串。 */
	name: string;
	/** data: 字段拼起来的内容。 */
	data: string;
}

function parseSseBlock(block: string): SseEvent | undefined {
	let name = "";
	const dataLines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.length === 0 || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") dataLines.push(value);
		else if (field === "event") name = value;
	}
	if (dataLines.length === 0 && name.length === 0) return undefined;
	return { name, data: dataLines.join("\n") };
}

/** 从缓冲区里切出完整的事件，剩下的留在 rest 里等下一块。 */
function splitSse(buffer: string): { events: SseEvent[]; rest: string } {
	let text = buffer.replace(/\r\n/gu, "\n");
	let heldCarriageReturn = false;
	const lastCarriageReturn = text.lastIndexOf("\r");
	if (text.length > 0 && lastCarriageReturn === text.length - 1) {
		// 结尾这个 \r 可能是被切开的 \r\n 的前半截，先留着。
		text = text.slice(0, -1);
		heldCarriageReturn = true;
	} else if (lastCarriageReturn >= 0) {
		text = text.split("\r").join("\n");
	}
	const events: SseEvent[] = [];
	let index = 0;
	for (;;) {
		const boundary = text.indexOf("\n\n", index);
		if (boundary === -1) break;
		const parsed = parseSseBlock(text.slice(index, boundary));
		if (parsed) events.push(parsed);
		index = boundary + 2;
	}
	return { events, rest: text.slice(index) + (heldCarriageReturn ? "\r" : "") };
}

/** 增量 SSE 解析器。 */
function createSseParser(): { push: (chunk: string) => SseEvent[]; flush: () => SseEvent[] } {
	let buffer = "";
	return {
		push(chunk: string): SseEvent[] {
			buffer += chunk;
			const { events, rest } = splitSse(buffer);
			buffer = rest;
			return events;
		},
		flush(): SseEvent[] {
			const rest = buffer.trim();
			buffer = "";
			if (rest.length === 0) return [];
			const parsed = parseSseBlock(rest);
			return parsed ? [parsed] : [];
		},
	};
}

// ───────────────────────────────────────────── 各家事件处理

function parseJson(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		return undefined;
	} catch {
		return undefined;
	}
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** 上游报错时给人看的消息。 */
function describeProviderError(payload: unknown): string {
	const record = asRecord(payload);
	if (!record) return typeof payload === "string" ? payload : JSON.stringify(payload);
	const error = asRecord(record["error"]) ?? record;
	const message = error["message"];
	if (typeof message === "string" && message.length > 0) return message;
	return JSON.stringify(payload);
}

function mapStopReason(reason: unknown): StopReason {
	if (reason === null || reason === undefined) return "pending";
	if (typeof reason !== "string") return "error";
	switch (reason) {
		case "stop":
		case "end":
		case "end_turn":
		case "stop_sequence":
		case "STOP":
			return "stop";
		case "length":
		case "max_tokens":
		case "MAX_TOKENS":
			return "length";
		case "tool_calls":
		case "tool_use":
		case "function_call":
		case "TOOL_CALL":
			return "toolUse";
		case "content_filter":
		case "network_error":
		case "SAFETY":
		case "RECITATION":
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
			return "error";
		default:
			return "error";
	}
}

/** OpenAI Chat Completions 的流。 */
function handleOpenAiCompletions(session: StreamSession, event: SseEvent): void {
	if (event.data.trim() === "[DONE]") return;
	const json = parseJson(event.data);
	if (!json) return;
	if (json["error"]) throw new Error(describeProviderError(json["error"]));

	const choices = asArray(json["choices"]);
	const choice = asRecord(choices[0]);
	if (choice) {
		const delta = asRecord(choice["delta"]) ?? {};
		const content = firstString(delta["content"]);
		if (content.length > 0) {
			const block = session.ensureText();
			block.content.text += content;
			session.stream.push({
				type: "text_delta",
				contentIndex: session.indexOf(block),
				delta: content,
				partial: session.output,
			});
		}
		const reasoning = firstString(delta["reasoning_content"], delta["reasoning"], delta["reasoning_text"]);
		if (reasoning.length > 0) {
			const block = session.ensureThinking();
			block.content.thinking += reasoning;
			session.stream.push({
				type: "thinking_delta",
				contentIndex: session.indexOf(block),
				delta: reasoning,
				partial: session.output,
			});
		}
		for (const raw of asArray(delta["tool_calls"])) {
			const toolCall = asRecord(raw);
			if (!toolCall) continue;
			const fn = asRecord(toolCall["function"]) ?? {};
			const index = typeof toolCall["index"] === "number" ? toolCall["index"] : undefined;
			const id = typeof toolCall["id"] === "string" ? toolCall["id"] : "";
			const key = index === undefined ? `id:${id}` : `i:${index}`;
			const block = session.ensureTool(key, id, firstString(fn["name"]));
			const fragment = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
			block.raw += fragment;
			session.stream.push({
				type: "toolcall_delta",
				contentIndex: session.indexOf(block),
				delta: fragment,
				partial: session.output,
			});
		}
		if (choice["finish_reason"]) {
			session.rawStopReason = String(choice["finish_reason"]);
			session.stopReason = mapStopReason(choice["finish_reason"]);
		}
	}
	const usage = asRecord(json["usage"]);
	if (usage) applyOpenAiUsage(session, usage);
}

function applyOpenAiUsage(session: StreamSession, usage: Record<string, unknown>): void {
	const promptDetails = asRecord(usage["prompt_tokens_details"]) ?? {};
	const cacheRead =
		typeof promptDetails["cached_tokens"] === "number"
			? promptDetails["cached_tokens"]
			: typeof usage["prompt_cache_hit_tokens"] === "number"
				? (usage["prompt_cache_hit_tokens"] as number)
				: 0;
	const cacheWrite = typeof promptDetails["cache_write_tokens"] === "number" ? promptDetails["cache_write_tokens"] : 0;
	const promptTokens = typeof usage["prompt_tokens"] === "number" ? usage["prompt_tokens"] : 0;
	const completionTokens = typeof usage["completion_tokens"] === "number" ? usage["completion_tokens"] : 0;
	const target = session.output.usage;
	target.input = Math.max(0, promptTokens - cacheRead - cacheWrite);
	target.output = completionTokens;
	target.cacheRead = cacheRead;
	target.cacheWrite = cacheWrite;
	target.totalTokens = target.input + target.output + cacheRead + cacheWrite;
	applyCost(session.model, target);
}

/** OpenAI Responses 的流。 */
function handleOpenAiResponses(session: StreamSession, event: SseEvent): void {
	const json = parseJson(event.data);
	if (!json) return;
	const type = firstString(json["type"], event.name);
	switch (type) {
		case "response.created":
		case "response.in_progress":
			return;
		case "response.output_item.added": {
			const item = asRecord(json["item"]);
			if (!item) return;
			const itemType = firstString(item["type"]);
			if (itemType === "message") {
				session.ensureText();
			} else if (itemType === "reasoning") {
				session.ensureThinking();
			} else if (itemType === "function_call") {
				const id = firstString(item["call_id"], item["id"]);
				const name = firstString(item["name"]);
				const key = `item:${firstString(item["id"], id)}`;
				session.ensureTool(key, id, name);
			}
			return;
		}
		case "response.output_text.delta":
		case "response.refusal.delta": {
			const delta = firstString(json["delta"]);
			if (delta.length === 0) return;
			const block = session.ensureText();
			block.content.text += delta;
			session.stream.push({
				type: "text_delta",
				contentIndex: session.indexOf(block),
				delta,
				partial: session.output,
			});
			return;
		}
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta": {
			const delta = firstString(json["delta"]);
			if (delta.length === 0) return;
			const block = session.ensureThinking();
			block.content.thinking += delta;
			session.stream.push({
				type: "thinking_delta",
				contentIndex: session.indexOf(block),
				delta,
				partial: session.output,
			});
			return;
		}
		case "response.function_call_arguments.delta": {
			const delta = firstString(json["delta"]);
			const block = session.ensureTool(`item:${firstString(json["item_id"])}`, "", "");
			block.raw += delta;
			session.stream.push({
				type: "toolcall_delta",
				contentIndex: session.indexOf(block),
				delta,
				partial: session.output,
			});
			return;
		}
		case "response.function_call_arguments.done": {
			const argumentsText = firstString(json["arguments"]);
			const block = session.ensureTool(`item:${firstString(json["item_id"])}`, "", "");
			if (argumentsText.length > 0) {
				const delta = argumentsText.startsWith(block.raw)
					? argumentsText.slice(block.raw.length)
					: argumentsText;
				block.raw = argumentsText;
				if (delta.length > 0) {
					session.stream.push({
						type: "toolcall_delta",
						contentIndex: session.indexOf(block),
						delta,
						partial: session.output,
					});
				}
			}
			return;
		}
		case "response.output_item.done": {
			const item = asRecord(json["item"]);
			if (!item) return;
			const itemType = firstString(item["type"]);
			if (itemType === "message") {
				session.closeText();
			} else if (itemType === "reasoning") {
				session.closeThinking();
			} else if (itemType === "function_call") {
				const key = `item:${firstString(item["id"])}`;
				const block = session.toolBlocks.get(key);
				if (block) {
					const argumentsText = firstString(item["arguments"]);
					if (argumentsText.length > 0 && argumentsText !== block.raw) {
						const delta = argumentsText.startsWith(block.raw)
							? argumentsText.slice(block.raw.length)
							: argumentsText;
						block.raw = argumentsText;
						session.stream.push({
							type: "toolcall_delta",
							contentIndex: session.indexOf(block),
							delta,
							partial: session.output,
						});
					}
					session.closeTool(block);
				}
			}
			return;
		}
		case "response.completed":
		case "response.incomplete": {
			const response = asRecord(json["response"]);
			const usage = asRecord(response?.["usage"]);
			if (usage) applyResponsesUsage(session, usage);
			const status = firstString(response?.["status"]);
			if (type === "response.incomplete" || status === "incomplete") session.stopReason = "length";
			else if (session.stopReason === "pending") session.stopReason = "stop";
			return;
		}
		case "response.failed":
		case "error":
			throw new Error(describeProviderError(json["error"] ?? json["response"] ?? json));
		default:
			return;
	}
}

function applyResponsesUsage(session: StreamSession, usage: Record<string, unknown>): void {
	const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
	const cachedTokens = typeof usage["cached_tokens"] === "number" ? usage["cached_tokens"] : 0;
	const cacheWriteTokens =
		typeof usage["cache_write_tokens"] === "number"
			? usage["cache_write_tokens"]
			: typeof usage["cache_creation_input_tokens"] === "number"
				? (usage["cache_creation_input_tokens"] as number)
				: 0;
	const outputTokens = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
	const totalTokens = typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : 0;
	const target = session.output.usage;
	target.input = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
	target.output = outputTokens;
	target.cacheRead = cachedTokens;
	target.cacheWrite = cacheWriteTokens;
	target.totalTokens = totalTokens > 0 ? totalTokens : target.input + target.output + cachedTokens + cacheWriteTokens;
	applyCost(session.model, target);
}

/** Anthropic Messages 的流。 */
function handleAnthropicMessages(session: StreamSession, event: SseEvent): void {
	const json = parseJson(event.data);
	if (!json) return;
	const type = firstString(json["type"], event.name);
	switch (type) {
		case "message_start": {
			const message = asRecord(json["message"]) ?? {};
			const usage = asRecord(message["usage"]) ?? {};
			const target = session.output.usage;
			const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
			const cacheRead =
				typeof usage["cache_read_input_tokens"] === "number" ? usage["cache_read_input_tokens"] : 0;
			const cacheWrite =
				typeof usage["cache_creation_input_tokens"] === "number" ? usage["cache_creation_input_tokens"] : 0;
			target.input = Math.max(0, inputTokens - cacheRead - cacheWrite);
			target.cacheRead = cacheRead;
			target.cacheWrite = cacheWrite;
			target.totalTokens = target.input + target.output + cacheRead + cacheWrite;
			applyCost(session.model, target);
			return;
		}
		case "content_block_start": {
			const block = asRecord(json["content_block"]) ?? {};
			const index = typeof json["index"] === "number" ? json["index"] : 0;
			const blockType = firstString(block["type"]);
			if (blockType === "text") {
				const text = firstString(block["text"]);
				if (text.length > 0) {
					const target = session.ensureText();
					target.content.text += text;
				}
			} else if (blockType === "thinking") {
				const thinking = firstString(block["thinking"]);
				if (thinking.length > 0) {
					const target = session.ensureThinking();
					target.content.thinking += thinking;
				}
			} else if (blockType === "tool_use") {
				const id = firstString(block["id"]);
				const name = firstString(block["name"]);
				const toolBlock = session.ensureTool(`b:${index}`, id, name);
				const input = asRecord(block["input"]);
				if (input && Object.keys(input).length > 0) {
					// 有的网关不流式送参数，直接把整个对象塞在 content_block_start 里。
					const raw = JSON.stringify(input);
					toolBlock.raw = raw;
					session.stream.push({
						type: "toolcall_delta",
						contentIndex: session.indexOf(toolBlock),
						delta: raw,
						partial: session.output,
					});
				}
			}
			return;
		}
		case "content_block_delta": {
			const index = typeof json["index"] === "number" ? json["index"] : 0;
			const delta = asRecord(json["delta"]) ?? {};
			const deltaType = firstString(delta["type"]);
			if (deltaType === "text_delta") {
				const text = firstString(delta["text"]);
				if (text.length === 0) return;
				const block = session.ensureText();
				block.content.text += text;
				session.stream.push({
					type: "text_delta",
					contentIndex: session.indexOf(block),
					delta: text,
					partial: session.output,
				});
			} else if (deltaType === "thinking_delta") {
				const thinking = firstString(delta["thinking"]);
				if (thinking.length === 0) return;
				const block = session.ensureThinking();
				block.content.thinking += thinking;
				session.stream.push({
					type: "thinking_delta",
					contentIndex: session.indexOf(block),
					delta: thinking,
					partial: session.output,
				});
			} else if (deltaType === "input_json_delta") {
				const partialJson = firstString(delta["partial_json"]);
				const block = session.ensureTool(`b:${index}`, "", "");
				block.raw += partialJson;
				session.stream.push({
					type: "toolcall_delta",
					contentIndex: session.indexOf(block),
					delta: partialJson,
					partial: session.output,
				});
			}
			return;
		}
		case "content_block_stop": {
			const index = typeof json["index"] === "number" ? json["index"] : 0;
			const toolBlock = session.toolBlocks.get(`b:${index}`);
			if (toolBlock) session.closeTool(toolBlock);
			else {
				session.closeText();
				session.closeThinking();
			}
			return;
		}
		case "message_delta": {
			const delta = asRecord(json["delta"]) ?? {};
			const usage = asRecord(json["usage"]) ?? {};
			if (typeof usage["output_tokens"] === "number") {
				session.output.usage.output = usage["output_tokens"];
			}
			const target = session.output.usage;
			target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
			applyCost(session.model, target);
			if (delta["stop_reason"]) {
				session.rawStopReason = String(delta["stop_reason"]);
				session.stopReason = mapStopReason(delta["stop_reason"]);
			}
			return;
		}
		case "message_stop":
			return;
		case "error":
			throw new Error(describeProviderError(json["error"] ?? json));
		default:
			return;
	}
}

/** Google Generative AI 的流。 */
function handleGoogleGenerativeAi(session: StreamSession, event: SseEvent): void {
	const json = parseJson(event.data);
	if (!json) return;
	if (json["error"]) throw new Error(describeProviderError(json["error"]));
	const candidates = asArray(json["candidates"]);
	const candidate = asRecord(candidates[0]);
	if (candidate) {
		const content = asRecord(candidate["content"]) ?? {};
		for (const raw of asArray(content["parts"])) {
			const part = asRecord(raw);
			if (!part) continue;
			const functionCall = asRecord(part["functionCall"]);
			if (functionCall) {
				const name = firstString(functionCall["name"]);
				const args = asRecord(functionCall["args"]) ?? {};
				const block = session.ensureTool(`fn:${name}`, `${name}_${session.blocks.length}`, name);
				const raw = JSON.stringify(args);
				block.raw = raw;
				session.stream.push({
					type: "toolcall_delta",
					contentIndex: session.indexOf(block),
					delta: raw,
					partial: session.output,
				});
				session.closeTool(block);
				continue;
			}
			const text = firstString(part["text"]);
			if (text.length === 0) continue;
			if (part["thought"] === true) {
				const block = session.ensureThinking();
				block.content.thinking += text;
				session.stream.push({
					type: "thinking_delta",
					contentIndex: session.indexOf(block),
					delta: text,
					partial: session.output,
				});
			} else {
				const block = session.ensureText();
				block.content.text += text;
				session.stream.push({
					type: "text_delta",
					contentIndex: session.indexOf(block),
					delta: text,
					partial: session.output,
				});
			}
		}
		if (candidate["finishReason"]) {
			session.rawStopReason = String(candidate["finishReason"]);
			session.stopReason = mapStopReason(candidate["finishReason"]);
		}
	}
	const usage = asRecord(json["usageMetadata"]);
	if (usage) applyGoogleUsage(session, usage);
}

function applyGoogleUsage(session: StreamSession, usage: Record<string, unknown>): void {
	const promptTokens = typeof usage["promptTokenCount"] === "number" ? usage["promptTokenCount"] : 0;
	const cachedTokens =
		typeof usage["cachedContentTokenCount"] === "number" ? usage["cachedContentTokenCount"] : 0;
	const candidateTokens = typeof usage["candidatesTokenCount"] === "number" ? usage["candidatesTokenCount"] : 0;
	const thoughtTokens = typeof usage["thoughtsTokenCount"] === "number" ? usage["thoughtsTokenCount"] : 0;
	const totalTokens = typeof usage["totalTokenCount"] === "number" ? usage["totalTokenCount"] : 0;
	const target = session.output.usage;
	target.input = Math.max(0, promptTokens - cachedTokens);
	target.output = candidateTokens + thoughtTokens;
	target.cacheRead = cachedTokens;
	target.totalTokens = totalTokens > 0 ? totalTokens : target.input + target.output + cachedTokens;
	applyCost(session.model, target);
}

/** 非流式响应：整包 JSON 当成一次完整回复处理。 */
function handleNonStreamingJson(session: StreamSession, json: Record<string, unknown>): void {
	if (session.format === "openai-completions") {
		const choice = asRecord(asArray(json["choices"])[0]);
		const message = asRecord(choice?.["message"]) ?? {};
		const content = firstString(message["content"]);
		if (content.length > 0) {
			const block = session.ensureText();
			block.content.text = content;
			session.stream.push({
				type: "text_delta",
				contentIndex: session.indexOf(block),
				delta: content,
				partial: session.output,
			});
		}
		const reasoning = firstString(message["reasoning_content"], message["reasoning"]);
		if (reasoning.length > 0) {
			const block = session.ensureThinking();
			block.content.thinking = reasoning;
			session.stream.push({
				type: "thinking_delta",
				contentIndex: session.indexOf(block),
				delta: reasoning,
				partial: session.output,
			});
		}
		for (const raw of asArray(message["tool_calls"])) {
			const toolCall = asRecord(raw);
			if (!toolCall) continue;
			const fn = asRecord(toolCall["function"]) ?? {};
			const id = firstString(toolCall["id"]);
			const block = session.ensureTool(`id:${id}`, id, firstString(fn["name"]));
			const fragment = firstString(fn["arguments"]);
			block.raw = fragment;
			session.stream.push({
				type: "toolcall_delta",
				contentIndex: session.indexOf(block),
				delta: fragment,
				partial: session.output,
			});
		}
		if (choice && choice["finish_reason"]) session.stopReason = mapStopReason(choice["finish_reason"]);
		const usage = asRecord(json["usage"]);
		if (usage) applyOpenAiUsage(session, usage);
		return;
	}

	if (session.format === "openai-responses") {
		for (const raw of asArray(json["output"])) {
			const item = asRecord(raw);
			if (!item) continue;
			const itemType = firstString(item["type"]);
			if (itemType === "message") {
				for (const content of asArray(item["content"])) {
					const part = asRecord(content);
					const text = firstString(part?.["text"]);
					if (text.length === 0) continue;
					const block = session.ensureText();
					block.content.text += text;
					session.stream.push({
						type: "text_delta",
						contentIndex: session.indexOf(block),
						delta: text,
						partial: session.output,
					});
				}
			} else if (itemType === "function_call") {
				const id = firstString(item["call_id"], item["id"]);
				const block = session.ensureTool(`item:${firstString(item["id"], id)}`, id, firstString(item["name"]));
				const fragment = firstString(item["arguments"]);
				block.raw = fragment;
				session.stream.push({
					type: "toolcall_delta",
					contentIndex: session.indexOf(block),
					delta: fragment,
					partial: session.output,
				});
			}
		}
		const usage = asRecord(json["usage"]);
		if (usage) applyResponsesUsage(session, usage);
		if (session.stopReason === "pending") session.stopReason = "stop";
		return;
	}

	if (session.format === "anthropic-messages") {
		for (const raw of asArray(json["content"])) {
			const block = asRecord(raw);
			if (!block) continue;
			const blockType = firstString(block["type"]);
			if (blockType === "text") {
				const text = firstString(block["text"]);
				if (text.length === 0) continue;
				const target = session.ensureText();
				target.content.text += text;
				session.stream.push({
					type: "text_delta",
					contentIndex: session.indexOf(target),
					delta: text,
					partial: session.output,
				});
			} else if (blockType === "tool_use") {
				const id = firstString(block["id"]);
				const toolBlock = session.ensureTool(`id:${id}`, id, firstString(block["name"]));
				const raw = JSON.stringify(asRecord(block["input"]) ?? {});
				toolBlock.raw = raw;
				session.stream.push({
					type: "toolcall_delta",
					contentIndex: session.indexOf(toolBlock),
					delta: raw,
					partial: session.output,
				});
			}
		}
		const usage = asRecord(json["usage"]);
		if (usage) {
			const target = session.output.usage;
			const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
			const outputTokens = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
			const cacheRead =
				typeof usage["cache_read_input_tokens"] === "number" ? usage["cache_read_input_tokens"] : 0;
			const cacheWrite =
				typeof usage["cache_creation_input_tokens"] === "number" ? usage["cache_creation_input_tokens"] : 0;
			target.input = Math.max(0, inputTokens - cacheRead - cacheWrite);
			target.output = outputTokens;
			target.cacheRead = cacheRead;
			target.cacheWrite = cacheWrite;
			target.totalTokens = target.input + target.output + cacheRead + cacheWrite;
			applyCost(session.model, target);
		}
		if (json["stop_reason"]) session.stopReason = mapStopReason(json["stop_reason"]);
		return;
	}

	// google-generative-ai
	const candidate = asRecord(asArray(json["candidates"])[0]);
	const content = asRecord(candidate?.["content"]) ?? {};
	for (const raw of asArray(content["parts"])) {
		const part = asRecord(raw);
		if (!part) continue;
		const text = firstString(part["text"]);
		if (text.length > 0) {
			const block = session.ensureText();
			block.content.text += text;
			session.stream.push({
				type: "text_delta",
				contentIndex: session.indexOf(block),
				delta: text,
				partial: session.output,
			});
		}
		const functionCall = asRecord(part["functionCall"]);
		if (functionCall) {
			const name = firstString(functionCall["name"]);
			const block = session.ensureTool(`fn:${name}`, `${name}_${session.blocks.length}`, name);
			const raw = JSON.stringify(asRecord(functionCall["args"]) ?? {});
			block.raw = raw;
			session.stream.push({
				type: "toolcall_delta",
				contentIndex: session.indexOf(block),
				delta: raw,
				partial: session.output,
			});
		}
	}
	if (candidate && candidate["finishReason"]) session.stopReason = mapStopReason(candidate["finishReason"]);
	const usage = asRecord(json["usageMetadata"]);
	if (usage) applyGoogleUsage(session, usage);
}

// ───────────────────────────────────────────── 错误与重试

/** 上游返回了非 2xx。 */
class HttpFailure extends Error {
	readonly status: number;
	readonly retryable: boolean;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpFailure";
		this.status = status;
		this.retryable = status === 408 || status === 429 || status >= 500;
	}
}

/** 请求被中断（用户中止）。 */
class AbortedFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AbortedFailure";
	}
}

function isRetryable(error: unknown): boolean {
	if (error instanceof HttpFailure) return error.retryable;
	// 网络层错误（连不上、DNS 挂了）算可重试。
	if (error instanceof TypeError) return true;
	return false;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new AbortedFailure("请求被中止"));
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new AbortedFailure("请求被中止"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function backoffDelay(attempt: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

// ───────────────────────────────────────────── 客户端

/** relay 请求体：与 src/server/llm-relay.ts 的 RelayRequest 对齐。 */
interface RelayRequestBody {
	target: string;
	apiKey: string;
	authHeader: string;
	authScheme: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function buildRelayRequest(
	prepared: PreparedRequest,
	apiKey: string,
	format: ApiFormat,
): { url: string; init: RequestInit & { headers: Record<string, string> } } {
	const body: RelayRequestBody = {
		target: prepared.url,
		apiKey,
		authHeader: prepared.authHeader,
		authScheme: prepared.authScheme,
		headers: { ...prepared.headers, ...extraAuthHeaders(format, apiKey) },
		body: prepared.body,
	};
	return {
		url: prepared.url,
		init: {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	};
}

/**
 * 造一个浏览器端的 LLM 客户端。
 *
 * 产出的对象有 streamSimple()，形状与 pi-ai 的 Models.streamSimple 一致，
 * 所以 novel-agent.ts 里的 withStreamDefaults() 可以直接套上来。
 */
export function createLlmClient(options: LlmClientOptions): LlmClient {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const transport = options.transport ?? "direct";
	const relayUrl = options.relayUrl ?? "/api/llm";

	function streamSimple(
		model: Model<any>,
		context: TranscriptContext,
		streamOptions?: SimpleStreamOptions & { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal },
	): AssistantMessageEventStream {
		const format = resolveFormat(model);
		const session = new StreamSession(model, format);

		// Key：调用方给了就用调用方的（agent 循环会先解好塞进来），
		// 否则问 resolveApiKey。同步拿到解不开就同步抛错 —— agent 循环靠这个
		// 区分"用户没配 Key"和"上游报错"。
		const provided = streamOptions?.apiKey;
		if (provided) {
			void run(session, context, provided, streamOptions);
			return session.stream;
		}
		const resolved = options.resolveApiKey(model.provider);
		if (isPromiseLike(resolved)) {
			void (async () => {
				try {
					const apiKey = await resolved;
					if (!apiKey) {
						throw new Error(missingKeyMessage(model));
					}
					await run(session, context, apiKey, streamOptions);
				} catch (error) {
					emitError(session, "error", error);
				}
			})();
			return session.stream;
		}
		if (!resolved) throw new Error(missingKeyMessage(model));
		void run(session, context, resolved, streamOptions);
		return session.stream;
	}

	async function run(
		session: StreamSession,
		context: TranscriptContext,
		apiKey: string,
		streamOptions?: SimpleStreamOptions & { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal },
	): Promise<void> {
		const userSignal = streamOptions?.signal;
		const timeoutMs = streamOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxRetries = streamOptions?.maxRetries ?? DEFAULT_MAX_RETRIES;
		const prepared = prepareRequest(session.format, session.model, context, {
			apiKey,
			...(typeof streamOptions?.temperature === "number" ? { temperature: streamOptions.temperature } : {}),
			...(typeof streamOptions?.maxTokens === "number" ? { maxTokens: streamOptions.maxTokens } : {}),
			...(streamOptions?.toolChoice ? { toolChoice: streamOptions.toolChoice } : {}),
			...(streamOptions?.reasoning ? { reasoning: streamOptions.reasoning } : {}),
			...(streamOptions?.headers ? { headers: normalizeHeaders(streamOptions.headers) } : {}),
		});

		const controller = new AbortController();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const arm = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
		};
		const onUserAbort = (): void => controller.abort();
		if (userSignal) {
			if (userSignal.aborted) controller.abort();
			else userSignal.addEventListener("abort", onUserAbort, { once: true });
		}
		arm();

		try {
			let attempt = 0;
			for (;;) {
				try {
					const response = await sendRequest(prepared, apiKey, session.format, transport, relayUrl, fetchImpl, controller.signal);
					// 头到了才算"开始生成"：这时才推 start。
					session.stream.push({ type: "start", partial: session.output });
					await consumeResponse(session, response, arm);
					finalize(session);
					return;
				} catch (error) {
					if (isAbortError(error, userSignal)) {
						emitError(session, "aborted", error);
						return;
					}
					if (timedOut) {
						emitError(session, "error", new Error(`请求超时（${timeoutMs} 毫秒内没有拿到数据）`));
						return;
					}
					if (isRetryable(error) && attempt < maxRetries) {
						attempt += 1;
						try {
							await delay(backoffDelay(attempt), userSignal);
						} catch (abortError) {
							emitError(session, "aborted", abortError);
							return;
						}
						arm();
						continue;
					}
					emitError(session, "error", error);
					return;
				}
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
		}
	}

	return { streamSimple };
}

function missingKeyMessage(model: Model<any>): string {
	return `服务商「${model.provider}」还没有配置 API Key。`;
}

function isPromiseLike(value: unknown): value is Promise<string | undefined> {
	return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

function normalizeHeaders(headers: Record<string, string | null>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string") out[name.toLowerCase()] = value;
	}
	return out;
}

function resolveFormat(model: Model<any>): ApiFormat {
	switch (model.api) {
		case "openai-completions":
		case "openai-responses":
		case "anthropic-messages":
		case "google-generative-ai":
			return model.api;
		default:
			return "openai-completions";
	}
}

/** 发一次请求。非 2xx 抛 HttpFailure。 */
async function sendRequest(
	prepared: PreparedRequest,
	apiKey: string,
	format: ApiFormat,
	transport: "direct" | "relay",
	relayUrl: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<Response> {
	let url: string;
	let init: RequestInit;
	if (transport === "relay") {
		const relay = buildRelayRequest(prepared, apiKey, format);
		url = relayUrl;
		init = relay.init;
	} else {
		const headers: Record<string, string> = {
			...prepared.headers,
			...extraAuthHeaders(format, apiKey),
			[prepared.authHeader]: prepared.authScheme + apiKey,
		};
		if (format === "anthropic-messages") headers["anthropic-dangerous-direct-browser-access"] = "true";
		url = prepared.url;
		init = { method: "POST", headers, body: JSON.stringify(prepared.body) };
	}
	const response = await fetchImpl(url, { ...init, signal });
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new HttpFailure(response.status, httpErrorMessage(response.status, text));
	}
	return response;
}

function httpErrorMessage(status: number, text: string): string {
	const trimmed = text.trim();
	if (trimmed.length > 0) {
		const json = parseJson(trimmed);
		if (json) {
			const message = describeProviderError(json["error"] ?? json);
			if (message.length > 0) return `上游返回 ${status}：${message}`;
		}
		return `上游返回 ${status}：${trimmed.slice(0, 500)}`;
	}
	return `上游返回 ${status}`;
}

/** 读响应体：SSE 就增量解析，普通 JSON 就整包解析。 */
async function consumeResponse(session: StreamSession, response: Response, arm: () => void): Promise<void> {
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	const body = response.body;
	if (!body) {
		const text = await response.text();
		handleWholeBody(session, text);
		return;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const parser = createSseParser();
	let mode: "sse" | "json" | "unknown" = contentType.includes("text/event-stream")
		? "sse"
		: contentType.includes("application/json")
			? "json"
			: "unknown";
	let buffered = "";

	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		arm();
		const text = decoder.decode(chunk.value, { stream: true });
		if (mode === "json") {
			buffered += text;
			continue;
		}
		if (mode === "unknown") {
			buffered += text;
			const probe = buffered.trimStart();
			if (probe.length === 0) continue;
			if (probe.startsWith("{")) {
				mode = "json";
				continue;
			}
			mode = "sse";
			const events = parser.push(buffered);
			buffered = "";
			for (const event of events) dispatchSse(session, event);
			continue;
		}
		for (const event of parser.push(text)) dispatchSse(session, event);
	}

	const tail = decoder.decode();
	if (mode === "json") {
		handleWholeBody(session, buffered + tail);
		return;
	}
	if (mode === "unknown") {
		handleWholeBody(session, buffered + tail);
		return;
	}
	if (tail.length > 0) {
		for (const event of parser.push(tail)) dispatchSse(session, event);
	}
	for (const event of parser.flush()) dispatchSse(session, event);
}

function dispatchSse(session: StreamSession, event: SseEvent): void {
	switch (session.format) {
		case "openai-completions":
			handleOpenAiCompletions(session, event);
			return;
		case "openai-responses":
			handleOpenAiResponses(session, event);
			return;
		case "anthropic-messages":
			handleAnthropicMessages(session, event);
			return;
		case "google-generative-ai":
			handleGoogleGenerativeAi(session, event);
			return;
		default:
			return;
	}
}

/** 整包文本：JSON 就当完整回复，SSE 就再解析一遍。 */
function handleWholeBody(session: StreamSession, text: string): void {
	const trimmed = text.trim();
	if (trimmed.length === 0) return;
	if (trimmed.startsWith("{")) {
		const json = parseJson(trimmed);
		if (json) handleNonStreamingJson(session, json);
		return;
	}
	const parser = createSseParser();
	for (const event of parser.push(trimmed)) dispatchSse(session, event);
	for (const event of parser.flush()) dispatchSse(session, event);
}

/** 收尾：推 done。 */
function finalize(session: StreamSession): void {
	session.closeAll();
	let reason = session.stopReason;
	if (reason === "pending") reason = session.hasToolCalls() ? "toolUse" : "stop";
	if (reason === "stop" && session.hasToolCalls()) reason = "toolUse";
	if (reason !== "stop" && reason !== "length" && reason !== "toolUse" && reason !== "deferred") {
		emitError(session, "error", new Error(session.errorMessage ?? "上游没有给出可用的结束原因"));
		return;
	}
	session.output.stopReason = reason;
	session.stream.push({ type: "done", reason, message: session.output });
	session.stream.end();
}

/** 出错：推 error 事件并收流。不补 *_end —— 半截的块就这么留着。 */
function emitError(session: StreamSession, reason: "aborted" | "error", error: unknown): void {
	session.output.stopReason = reason;
	session.output.errorMessage = error instanceof Error ? error.message : String(error);
	session.stream.push({ type: "error", reason, error: session.output });
	session.stream.end();
}

/**
 * 是不是"用户中止"了。
 *
 * 只有用户自己 abort 才算 aborted；内部超时算 error —— 这跟 pi-ai 的
 * `options.signal?.aborted ? "aborted" : "error"` 一个口径。
 */
function isAbortError(error: unknown, userSignal: AbortSignal | undefined): boolean {
	if (userSignal?.aborted) return true;
	if (error instanceof AbortedFailure) return true;
	return false;
}
