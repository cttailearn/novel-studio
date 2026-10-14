import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createNovelAgent } from "../ai/novel-agent.ts";
import {
	BUILTIN_PROVIDERS,
	syncBuiltinProviders,
	getCredentialStore,
	getModels,
	getSettingsStore,
	initModelRuntime,
	listAvailableModels,
	listProviderStatus,
	ModelResolutionError,
	rebuildModels,
	resolveModel,
} from "../ai/models.ts";
import { fetchUpstreamModels, mergeFetched } from "../ai/fetch-models.ts";
import { FileCredentialStore } from "../config/credential-store.ts";
import { SettingsStore } from "../config/settings-store.ts";
import {
	API_FORMATS,
	emptyModel,
	normalizeSettings,
	THINKING_LEVELS,
	type ApiFormat,
	type ModelConfig,
	type ProviderConfig,
	type Settings,
} from "../config/settings.ts";
import { loadEnvFile, readConfig, type AppConfig } from "../config/env.ts";
import { ProjectStore } from "../store/project.ts";

loadEnvFile();
const config = readConfig();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

interface Session {
	id: string;
	projectId: string;
	modelRef: string;
	thinkingLevel: ThinkingLevel;
	agent: Agent;
	createdAt: number;
}

const sessions = new Map<string, Session>();

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
	res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage, limitBytes = 1_000_000): Promise<T> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > limitBytes) throw new Error("请求体过大");
		chunks.push(buf);
	}
	if (chunks.length === 0) return {} as T;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}

function replaceAgent(session: Session, model: Model<any>): void {
	session.agent = createNovelAgent({
		store,
		projectId: session.projectId,
		model,
		models: getModels(),
		config,
		sessionId: session.id,
		thinkingLevel: session.thinkingLevel,
	});
}

/** 把 Agent 事件映射成前端可消费的 NDJSON 事件。 */
function runAgentStream(session: Session, input: string, emit: (event: unknown) => void, signal: { aborted: boolean }): Promise<void> {
	const agent = session.agent;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
	let pendingTool = "";
	let thinking = false;

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "agent_start":
				emit({ type: "run_start", model: session.modelRef });
				break;
			case "turn_start":
				usage.turns += 1;
				thinking = false;
				emit({ type: "turn_start", turn: usage.turns });
				break;
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					if (thinking) {
						emit({ type: "thinking_end" });
						thinking = false;
					}
					emit({ type: "text", delta: inner.delta });
				} else if (inner.type === "thinking_delta") {
					if (!thinking) {
						thinking = true;
						emit({ type: "thinking_start" });
					}
					emit({ type: "thinking", delta: inner.delta });
				} else if (inner.type === "toolcall_end") {
					pendingTool = inner.toolCall.name;
					emit({ type: "tool_call", name: inner.toolCall.name, args: inner.toolCall.arguments });
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					usage.input += event.message.usage?.input ?? 0;
					usage.output += event.message.usage?.output ?? 0;
					usage.cacheRead += event.message.usage?.cacheRead ?? 0;
					usage.cacheWrite += event.message.usage?.cacheWrite ?? 0;
					emit({
						type: "message_end",
						stopReason: event.message.stopReason,
						error: event.message.errorMessage,
						usage: event.message.usage,
					});
				}
				break;
			}
			case "tool_execution_start":
				emit({ type: "tool_start", name: event.toolName, args: event.args });
				break;
			case "tool_execution_end":
				emit({
					type: "tool_end",
					name: event.toolName,
					isError: event.isError,
					durationMs: event.durationMs,
					preview: previewResult(event.result),
				});
				break;
			case "turn_end":
				emit({
					type: "turn_end",
					usage: event.message.role === "assistant" ? event.message.usage : undefined,
					tools: event.toolResults.length,
				});
				break;
			case "agent_end":
				emit({
					type: "run_end",
					aborted: signal.aborted,
					usage: { ...usage, cacheRead: usage.cacheRead || undefined, cacheWrite: usage.cacheWrite || undefined },
					error: agent.state.errorMessage,
				});
				break;
			default:
				break;
		}
	});

	return (async () => {
		try {
			await agent.prompt(input);
		} catch (error) {
			emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
			emit({ type: "run_end", aborted: signal.aborted, usage, error: agent.state.errorMessage });
		} finally {
			unsubscribe();
			void pendingTool;
		}
	})();
}

/** 工具结果截断，避免正文全量进入事件流。 */
function previewResult(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
	const text = (content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 供应商 id：拉丁字母与数字，其余折叠为连字符。中文名会退化为时间戳后缀。 */
function slugify(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || `custom-${Date.now().toString(36)}`;
}

async function statusOf(id: string) {
	return (await listProviderStatus()).find((provider) => provider.id === id);
}

/** 设置页需要的完整视图：配置、运行时状态、内置厂商目录。 */
async function settingsView() {
	const settings = settingsStore.get();
	return {
		defaultModel: settings.defaultModel,
		defaultThinkingLevel: settings.defaultThinkingLevel,
		providers: settings.providers,
		statuses: await listProviderStatus(),
		builtinCatalog: BUILTIN_PROVIDERS.map((spec) => ({
			id: spec.id,
			label: spec.label,
			envVars: [...spec.envVars],
		})),
	};
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const { pathname } = url;

	if (pathname === "/api/bootstrap" && req.method === "GET") {
		const [models, providers, settings] = await Promise.all([listAvailableModels(), listProviderStatus(), settingsView()]);
		return json(res, 200, {
			defaultModel: settings.defaultModel,
			defaultThinkingLevel: settings.defaultThinkingLevel,
			models,
			providers,
			settings,
			projects: store.list().map((project) => ({
				id: project.id,
				title: project.title,
				genre: project.genre,
				updatedAt: project.updatedAt,
				stats: store.stats(project),
			})),
		});
	}

	if (pathname === "/api/models" && req.method === "GET") {
		return json(res, 200, { models: await listAvailableModels() });
	}

	if (pathname === "/api/projects" && req.method === "GET") {
		return json(res, 200, { projects: store.list() });
	}

	if (pathname === "/api/projects" && req.method === "POST") {
		const body = await readJsonBody<Parameters<ProjectStore["create"]>[0]>(req);
		return json(res, 201, { project: store.create(body) });
	}

	// 保存章节正文（稿件视图的直接编辑）
	const chapterMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/chapters\/([^/]+)$/);
	if (chapterMatch && req.method === "PATCH") {
		const project = store.get(chapterMatch[1]!);
		if (!project) return json(res, 404, { error: "工程不存在" });
		const chapterId = decodeURIComponent(chapterMatch[2]!);
		const body = await readJsonBody<{ content?: string; title?: string }>(req);
		if (typeof body.content !== "string") return json(res, 400, { error: "缺少 content" });
		// 取成常量：属性访问的类型收窄无法穿透闭包。
		const content = body.content;
		const saved = store.mutate(project.id, (draft) => {
			const existing = draft.drafts[chapterId];
			draft.drafts[chapterId] = {
				id: chapterId,
				title: body.title?.trim() || existing?.title || chapterId,
				content,
				revision: (existing?.revision ?? 0) + 1,
				updatedAt: Date.now(),
			};
		});
		return json(res, 200, { chapter: saved.drafts[chapterId], stats: store.stats(saved) });
	}

	const projectMatch = pathname.match(/^\/api\/projects\/([\w-]+)$/);
	if (projectMatch && req.method === "GET") {
		const project = store.get(projectMatch[1]!);
		if (!project) return json(res, 404, { error: "工程不存在" });
		return json(res, 200, { project, stats: store.stats(project) });
	}

	if (pathname === "/api/sessions" && req.method === "POST") {
		const body = await readJsonBody<{ projectId?: string; modelRef?: string; thinkingLevel?: ThinkingLevel }>(req);
		if (!body.projectId) return json(res, 400, { error: "缺少 projectId" });
		if (!store.get(body.projectId)) return json(res, 404, { error: "工程不存在" });

		const modelRef = body.modelRef?.trim() || config.defaultModel;
		if (!modelRef) return json(res, 400, { error: "请指定模型" });

		let model: Model<any>;
		try {
			model = await resolveModel(modelRef);
		} catch (error) {
			const status = error instanceof ModelResolutionError ? 400 : 500;
			return json(res, status, { error: (error as Error).message, candidates: error instanceof ModelResolutionError ? error.candidates : [] });
		}

		const session: Session = {
			id: randomUUID(),
			projectId: body.projectId,
			modelRef: `${model.provider}/${model.id}`,
			thinkingLevel: body.thinkingLevel ?? settingsStore.get().defaultThinkingLevel,
			agent: undefined as unknown as Agent,
			createdAt: Date.now(),
		};
		replaceAgent(session, model);
		sessions.set(session.id, session);
		return json(res, 201, { sessionId: session.id, model: session.modelRef, thinkingLevel: session.thinkingLevel });
	}

	const modelMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/model$/);
	if (modelMatch && req.method === "POST") {
		const session = sessions.get(modelMatch[1]!);
		if (!session) return json(res, 404, { error: "会话不存在或已过期" });
		const body = await readJsonBody<{ modelRef?: string; thinkingLevel?: ThinkingLevel }>(req);
		try {
			const model = await resolveModel(body.modelRef ?? "");
			session.modelRef = `${model.provider}/${model.id}`;
			if (body.thinkingLevel) session.thinkingLevel = body.thinkingLevel;
			// 保留对话历史，只更换模型与推理档位。
			const messages = [...session.agent.state.messages];
			replaceAgent(session, model);
			session.agent.state.messages = messages;
			return json(res, 200, { model: session.modelRef, thinkingLevel: session.thinkingLevel });
		} catch (error) {
			const status = error instanceof ModelResolutionError ? 400 : 500;
			return json(res, status, { error: (error as Error).message, candidates: error instanceof ModelResolutionError ? error.candidates : [] });
		}
	}

	const abortMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/abort$/);
	if (abortMatch && req.method === "POST") {
		const session = sessions.get(abortMatch[1]!);
		if (!session) return json(res, 404, { error: "会话不存在" });
		session.agent.abort();
		return json(res, 200, { ok: true });
	}

	const messageMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/messages$/);
	if (messageMatch && req.method === "POST") {
		const session = sessions.get(messageMatch[1]!);
		if (!session) return json(res, 404, { error: "会话不存在或已过期" });
		const body = await readJsonBody<{ input?: string }>(req);
		const input = body.input?.trim();
		if (!input) return json(res, 400, { error: "请求空白" });
		if (session.agent.state.isStreaming) return json(res, 409, { error: "上一条消息还在生成中" });

		res.writeHead(200, {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});

		const state = { aborted: false };
		const emit = (event: unknown) => {
			if (res.writableEnded) return;
			res.write(`${JSON.stringify(event)}\n`);
		};
		req.on("close", () => {
			state.aborted = true;
			session.agent.abort();
		});

		try {
			await runAgentStream(session, input, emit, state);
		} finally {
			if (!res.writableEnded) res.end();
		}
		return;
	}


	// ---------------------------------------------------------------- 设置

	if (pathname === "/api/settings" && req.method === "GET") {
		return json(res, 200, await settingsView());
	}

	if (pathname === "/api/settings" && req.method === "PUT") {
		const body = await readJsonBody<{ defaultModel?: string; defaultThinkingLevel?: string }>(req);
		settingsStore.mutate((settings) => {
			if (typeof body.defaultModel === "string") settings.defaultModel = body.defaultModel.trim();
			if (typeof body.defaultThinkingLevel === "string") {
				const level = body.defaultThinkingLevel as Settings["defaultThinkingLevel"];
				if (THINKING_LEVELS.includes(level)) settings.defaultThinkingLevel = level;
			}
		});
		return json(res, 200, await settingsView());
	}

	// 新增自定义供应商
	if (pathname === "/api/providers" && req.method === "POST") {
		const body = await readJsonBody<{
			label?: string;
			baseUrl?: string;
			api?: ApiFormat;
			apiKey?: string;
			noAuthRequired?: boolean;
		}>(req);

		const label = body.label?.trim();
		const baseUrl = body.baseUrl?.trim();
		const api = body.api;
		if (!label) return json(res, 400, { error: "请填写供应商名称" });
		if (!baseUrl) return json(res, 400, { error: "请填写 Base URL" });
		if (!api || !API_FORMATS.includes(api)) return json(res, 400, { error: "请选择接口格式" });
		try {
			new URL(baseUrl);
		} catch {
			return json(res, 400, { error: "Base URL 不是合法地址" });
		}
		if (settingsStore.getProvider(slugify(label))) {
			return json(res, 409, { error: "同名供应商已存在" });
		}

		const id = slugify(label);
		const created = settingsStore.upsertProvider({
			id,
			label,
			kind: "custom",
			baseUrl,
			api,
			...(body.noAuthRequired === true ? { noAuthRequired: true } : {}),
			models: [],
			enabled: true,
			updatedAt: 0,
		});
		if (body.apiKey?.trim()) await credentialStore.setKey(id, body.apiKey);
		rebuildModels();
		return json(res, 201, { provider: created, status: await statusOf(created.id) });
	}

	const providerMatch = pathname.match(/^\/api\/providers\/([\w-]+)$/);
	if (providerMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const provider = settingsStore.getProvider(providerMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		if (req.method === "DELETE") {
			settingsStore.removeProvider(provider.id);
			await credentialStore.setKey(provider.id, undefined);
			rebuildModels();
			return json(res, 200, await settingsView());
		}
		const body = await readJsonBody<Partial<ProviderConfig> & { apiKey?: string }>(req);
		settingsStore.upsertProvider({
			...provider,
			...(typeof body.label === "string" && body.label.trim() ? { label: body.label.trim() } : {}),
			...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl.trim() } : {}),
			...(body.api && API_FORMATS.includes(body.api) ? { api: body.api } : {}),
			...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
			...(typeof body.noAuthRequired === "boolean" ? { noAuthRequired: body.noAuthRequired } : {}),
		});
		if (typeof body.apiKey === "string") await credentialStore.setKey(provider.id, body.apiKey);
		rebuildModels();
		return json(res, 200, { provider: settingsStore.getProvider(provider.id), status: await statusOf(provider.id) });
	}

	// 清除已保存的 key
	const keyMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/key$/);
	if (keyMatch && req.method === "DELETE") {
		const provider = settingsStore.getProvider(keyMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		await credentialStore.setKey(provider.id, undefined);
		rebuildModels();
		return json(res, 200, { status: await statusOf(provider.id) });
	}

	// 从上游拉取模型列表
	const fetchMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/fetch$/);
	if (fetchMatch && req.method === "POST") {
		const provider = settingsStore.getProvider(fetchMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		if (provider.kind !== "custom" || !provider.baseUrl || !provider.api) {
			return json(res, 400, { error: "只有自定义供应商需要拉取模型" });
		}
		const credential = await credentialStore.read(provider.id);
		const apiKey = credential?.type === "api_key" && credential.key ? credential.key : "";
		try {
			const fetched = await fetchUpstreamModels({
			baseUrl: provider.baseUrl,
			api: provider.api,
			apiKey,
			noAuthRequired: provider.noAuthRequired === true,
		});
			const { models, added } = mergeFetched(provider.models, fetched);
			settingsStore.upsertProvider({ ...provider, models });
			rebuildModels();
			return json(res, 200, {
				provider: settingsStore.getProvider(provider.id),
				fetched: fetched.length,
				added: added.length,
				addedIds: added,
			});
		} catch (error) {
			const status = (error as { status?: number }).status;
			return json(res, status && status < 500 ? 502 : 502, { error: (error as Error).message });
		}
	}

	// 新增 / 更新单个模型的参数
	const upsertModelMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models$/);
	if (upsertModelMatch && req.method === "POST") {
		const provider = settingsStore.getProvider(upsertModelMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		const body = await readJsonBody<Partial<ModelConfig> & { id?: string }>(req);
		const id = body.id?.trim();
		if (!id) return json(res, 400, { error: "缺少模型 id" });
		const normalized = normalizeSettings({ providers: [{ ...provider, models: [{ ...emptyModel(id), ...body } as ModelConfig] }] })
			.providers[0]!.models[0]!;
		const models = provider.models.some((model) => model.id === id)
			? provider.models.map((model) => (model.id === id ? normalized : model))
			: [...provider.models, normalized];
		settingsStore.upsertProvider({ ...provider, models });
		rebuildModels();
		return json(res, 200, { provider: settingsStore.getProvider(provider.id) });
	}

	const modelItemMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/models\/([^/]+)$/);
	if (modelItemMatch && req.method === "DELETE") {
		const provider = settingsStore.getProvider(modelItemMatch[1]!);
		if (!provider) return json(res, 404, { error: "供应商不存在" });
		const modelId = decodeURIComponent(modelItemMatch[2]!);
		settingsStore.upsertProvider({ ...provider, models: provider.models.filter((model) => model.id !== modelId) });
		rebuildModels();
		return json(res, 200, { provider: settingsStore.getProvider(provider.id) });
	}

	return json(res, 404, { error: "未知接口" });
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
	const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	const target = path.resolve(publicDir, relative);
	// 防止路径遍历越出静态目录。
	if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
		return json(res, 403, { error: "禁止访问" });
	}
	const body = await readFile(target).catch(() => undefined);
	if (!body) return json(res, 404, { error: "未找到" });
	res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
	res.end(body);
}

const store = await ProjectStore.open(config.dataDir);
const settingsStore = await SettingsStore.open(config.dataDir);
const credentialStore = await FileCredentialStore.open(config.dataDir);
settingsStore.replace(syncBuiltinProviders(settingsStore.get(), config.defaultModel));
initModelRuntime(settingsStore, credentialStore);

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const run = url.pathname.startsWith("/api/")
		? handleApi(req, res, url)
		: serveStatic(res, url.pathname);
	run.catch((error) => {
		console.error("[server]", error);
		if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		else if (!res.writableEnded) res.end();
	});
});

server.listen(config.port, config.host, () => {
	console.log(`novel-studio 已启动  http://${config.host}:${config.port}`);
	console.log(`数据目录  ${config.dataDir}`);
	void listProviderStatus().then((providers) => {
		const ready = providers.filter((provider) => provider.authSource !== "none" && provider.registered).map((provider) => provider.label);
		console.log(ready.length > 0 ? `已配置厂商  ${ready.join(", ")}` : "未检测到厂商 API Key，请在 .env 中配置");
	});
});
