/**
 * 服务端装配。
 *
 * 三种存储模式共用这一条请求管线，差别只在 /api/* 交给谁：
 *   · fs    单机自用：进程启动时开一套 data/ 存储与路由。
 *   · idb   纯浏览器：服务端不碰用户数据，只发静态页 + 无状态中继。
 *   · users 云端账号：先过账号层（登录/注册/配额），再按用户开工作区路由。
 *
 * main.ts 只负责读配置、起 HTTP 服务与日志；所有组装都在这里，
 * 这样 scripts/smoke.ts 之类的测试也能直接 createApp 起一个实例。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
	BUILTIN_PROVIDERS,
	getModels,
	initModelRuntime,
	listAvailableModels,
	listProviderStatus,
	rebuildModels,
	resolveModel,
	syncBuiltinProviders,
} from "../ai/models.ts";
import { FileCredentialStore } from "../config/credential-disk.ts";
import { SettingsStore } from "../config/settings-disk.ts";
import type { AppConfig } from "../config/env.ts";
import { newId } from "../store/project.ts";
import { ProjectStore } from "../store/project-disk.ts";
import { MaterialLibrary } from "../store/library-disk.ts";
import { NovelSourceLibrary } from "../store/novel-source-disk.ts";
import { KindStore } from "../store/kinds-disk.ts";
import { answerQuestion, AskChannel } from "./ask.ts";
import { RECORDS_KEEP } from "./records.ts";
import { RecordStore } from "./records-disk.ts";
import { createApiRouter, json, type ApiRouter, type Session } from "./api-router.ts";
import { createNodeApiRequest, createNodeApiSink } from "./node-http.ts";
import { createRelayRoute } from "./relay-route.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { openCloud, type AuthContext, type CloudRequestContext, type CloudServices } from "./cloud/index.ts";

/** 一次 createApp 得到的运行实例。 */
export interface App {
	readonly config: AppConfig;
	readonly localOnly: boolean;
	readonly multiUser: boolean;
	/** 处理一条已解析出 URL 的请求。 */
	handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
	/** 停服前把内存里的东西写下去。 */
	close(): Promise<void>;
	/** 启动日志的几行。 */
	describe(): Promise<string[]>;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

const INDEX_BOOT_TAG = '<script src="/boot.js"></script>';

export async function createApp(config: AppConfig, publicDir: string): Promise<App> {
	const localOnly = config.storage === "idb";
	const multiUser = config.storage === "users";
	const handleRelay = createRelayRoute(config.relay);

	// ───────────────────────────── 单机模式：一套 data/ 存储
	let singleRouter: ApiRouter | undefined;
	let singleStore: ProjectStore | undefined;

	// ───────────────────────────── 云端模式：账号层 + 每用户工作区
	let cloud: CloudServices | undefined;
	let workspaces: WorkspaceManager | undefined;

	if (localOnly) {
		await warnIdbLeftovers(config.dataDir, publicDir);
	} else if (multiUser) {
		workspaces = new WorkspaceManager(config);
		cloud = await openCloud(config, {
			usage: {
				usageOf: (userId: string) => workspaces!.usageOf(userId),
				invalidate: (userId: string) => workspaces!.invalidate(userId),
				dispose: (userId: string) => workspaces!.dispose(userId),
			},
			// 删号时工作区负责 flush 并删除 data/users/<id>。
			onDeleteUser: (userId: string) => workspaces!.dispose(userId),
		});
	} else {
		const kindStore = await KindStore.open(config.dataDir);
		// 单机模式的全局 kind 表由路由自己刷（refreshKinds 不传时回落到 registerCustomKinds），
		// 这里先登记一次，让启动时的素材校验就认得自建类别。
		const { registerCustomKinds } = await import("../store/project.ts");
		registerCustomKinds(kindStore.list());

		singleStore = await ProjectStore.open(config.dataDir);
		const libraryStore = await MaterialLibrary.open(config.dataDir);
		const novelStore = await NovelSourceLibrary.open(config.dataDir);
		const settingsStore = await SettingsStore.open(config.dataDir);
		const credentialStore = await FileCredentialStore.open(config.dataDir);
		const recordStore = await RecordStore.open(config.dataDir);
		settingsStore.replace(syncBuiltinProviders(settingsStore.get(), config.defaultModel));
		initModelRuntime(settingsStore, credentialStore);

		const sessions = new Map<string, Session>();
		singleRouter = createApiRouter({
			store: singleStore,
			libraryStore,
			novelStore,
			kindStore,
			settingsStore,
			credentialStore,
			recordStore,
			sessions,
			config,
			env: process.env,
			recordsKeep: RECORDS_KEEP,
			newId,
			builtinCatalog: BUILTIN_PROVIDERS.map((spec) => ({
				id: spec.id,
				label: spec.label,
				envVars: [...spec.envVars],
				...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
				...(spec.api ? { api: spec.api } : {}),
			})),
			createAskChannel: (sessionId: string) => new AskChannel(sessionId),
			answerQuestion,
			models: {
				list: listAvailableModels,
				status: listProviderStatus,
				resolve: resolveModel,
				rebuild: rebuildModels,
				current: getModels,
			},
		});
	}

	// 云端模式下 /api/* 的鉴权入口；单机模式返回 null。
	async function authenticateFor(
		req: IncomingMessage,
		url: URL,
		sink: ReturnType<typeof createNodeApiSink>,
		request?: ReturnType<typeof createNodeApiRequest>,
	): Promise<AuthContext | null> {
		if (!cloud) return null;
		const auth = await cloud.authenticate(request ?? createNodeApiRequest(req, url), requestContext(req, config));
		if (!auth) {
			json(sink, 401, { error: "请先登录", code: "unauthorized" });
			return null;
		}
		return auth;
	}

	async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		// 1) 云端账号层：/api/auth/*、/api/account/*、/api/admin/*
		if (cloud) {
			const request = createNodeApiRequest(req, url);
			const sink = createNodeApiSink(res);
			const ctx = requestContext(req, config);
			if (await cloud.handle(request, sink, ctx)) return;

			// 2) 业务接口：先验身份，再按用户拿工作区。
			const auth = await cloud.authenticate(request, ctx);
			if (!auth) {
				json(sink, 401, { error: "请先登录", code: "unauthorized" });
				return;
			}
			const userId = auth.user.id;
			const method = req.method ?? "GET";
			// 删除永远放行：配额满了以后，这是用户唯一能自救的动作。
			const writable = method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && method !== "DELETE";

			// 配额：读请求与删除永远放行（删除是用户自救的唯一途径）。
			if (writable && auth.user.quotaBytes > 0) {
				const usage = await workspaces!.usageOf(userId);
				const declared = Number(req.headers["content-length"]);
				const projected = usage.usedBytes + (Number.isFinite(declared) && declared > 0 ? declared : 0);
				if (usage.usedBytes >= auth.user.quotaBytes || projected > auth.user.quotaBytes) {
					json(sink, 507, {
						error: "云端容量已满，请联系管理员扩容或删除一些作品。",
						code: "quota_exceeded",
						quotaBytes: auth.user.quotaBytes,
						usedBytes: usage.usedBytes,
					});
					return;
				}
			}

			const { workspace, release } = await workspaces!.acquire(userId);
			try {
				await workspace.router(request, sink);
			} finally {
				release();
				// 写请求可能新增/删除文件，用量缓存立刻失效。
				if (writable) workspaces!.invalidate(userId);
			}
			return;
		}

		// 单机模式：整套路由就是一个实例。
		if (singleRouter) {
			await singleRouter(createNodeApiRequest(req, url), createNodeApiSink(res));
			return;
		}

		// idb 模式：服务端不持有用户数据。
		if (url.pathname.startsWith("/api/")) {
			json(createNodeApiSink(res), 503, {
				error: "服务端不持有用户数据。请在浏览器里以本地模式打开（地址后加 ?local=1）。",
			});
			return;
		}
	}

	// 单机模式没有账号系统，但前端仍可能问"要不要登录"。
	async function handleSingleModeAuth(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
		if (cloud || localOnly) return false;
		const method = req.method ?? "GET";
		if (method === "GET" && url.pathname === "/api/auth/config") {
			json(createNodeApiSink(res), 200, {
				mode: "single",
				registration: config.auth.registration,
				minPasswordLength: config.auth.minPasswordLength,
				defaultQuotaBytes: config.auth.defaultQuotaBytes,
				appName: config.auth.appName,
			});
			return true;
		}
		if (method === "GET" && url.pathname === "/api/auth/me") {
			json(createNodeApiSink(res), 200, { mode: "single" });
			return true;
		}
		if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/account/") || url.pathname.startsWith("/api/admin/")) {
			json(createNodeApiSink(res), 404, { error: "这台服务器没有开启账号系统", code: "auth_disabled" });
			return true;
		}
		return false;
	}

	return {
		config,
		localOnly,
		multiUser,
		async handle(req, res, url) {
			res.on("error", (error) => {
				console.error("[server] 响应流出错", error);
			});
			try {
				// 跨端部署（Tauri/手机直连云端）是跨源请求，浏览器先发预检。
				// /api/llm 由中继自己处理 CORS，不要重复加头。
				if (url.pathname.startsWith("/api/") && url.pathname !== "/api/llm") {
					if (applyCors(req, res, config, requestContext(req, config))) return;
				}
				// 中继在所有模式都开着：直连被 CORS 挡住的厂商时，浏览器会走这里。
				if (url.pathname === "/api/llm") {
					// 预检没有 Cookie/Bearer，先放过去让中继答 CORS；否则浏览器连登录请求都发不出。
					if (req.method !== "OPTIONS" && cloud) {
						const sink = createNodeApiSink(res);
						const auth = await authenticateFor(req, url, sink);
						if (!auth) return;
					}
					await handleRelay(req, res);
					return;
				}
				// 本机调试用的同源转发：页面在 127.0.0.1 上直连云端会被 CORS 预检挡住。
				if (url.pathname.startsWith("/__cloud/")) {
					await handleCloudProxy(req, res, url, config);
					return;
				}
				if (url.pathname.startsWith("/api/")) {
					if (await handleSingleModeAuth(url, req, res)) return;
					await handleApi(req, res, url);
					return;
				}
				await serveStatic(res, url.pathname);
			} catch (error) {
				console.error("[server]", error);
				if (!res.headersSent) {
					json(createNodeApiSink(res), 500, { error: error instanceof Error ? error.message : String(error) });
				} else if (!res.writableEnded) {
					res.end();
				}
			}
		},
		async close() {
			cloud?.close();
			await workspaces?.close();
			await singleStore?.flush();
		},
		async describe() {
			const lines: string[] = [];
			if (localOnly) {
				lines.push("存储模式  idb（多用户：数据全部保存在各人的浏览器里，服务端不留存）");
				lines.push(`中继      /api/llm  允许的主机：${relayHostsText(config)}`);
				return lines;
			}
			if (multiUser) {
				lines.push("存储模式  users（云端账号：登录、配额、每用户独立目录）");
				lines.push(`数据目录  ${config.dataDir}`);
				lines.push(`注册策略  ${config.auth.registration === "open" ? "开放注册" : "仅管理员建号"}；默认配额 ${quotaText(config.auth.defaultQuotaBytes)}`);
				return lines;
			}
			lines.push(`数据目录  ${config.dataDir}`);
			// 上次退出时若有没存上的稿，在这里补写一次。磁盘满、文件被占用这类故障
			// 多半是暂时的，重启后往往已经恢复，不补这一下用户就永远丢了那一稿。
			if (singleStore) {
				void singleStore.retryPending().then(() => {
					const pending = singleStore?.pendingWrites() ?? [];
					if (pending.length > 0) console.error("[store] 仍有 " + pending.length + " 部作品未能落盘：" + pending.join(", "));
				});
			}
			const providers = await listProviderStatus();
			const ready = providers.filter((provider) => provider.authSource !== "none" && provider.registered).map((provider) => provider.label);
			lines.push(ready.length > 0 ? `已配置厂商  ${ready.join(", ")}` : "未检测到厂商 API Key，请在 .env 中配置");
			return lines;
		},

		// 静态资源走同一条管线，留在闭包里方便共用 publicDir 与模式标记。
	};

	// ───────────────────────────── 静态文件
	async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
		const sink = createNodeApiSink(res);
		const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
		const target = path.resolve(publicDir, relative);
		// 防止路径遍历越出静态目录。
		if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
			json(sink, 403, { error: "禁止访问" });
			return;
		}
		const raw = await readFile(target).catch(() => undefined);
		if (!raw) {
			json(sink, 404, { error: "未找到" });
			return;
		}
		/*
		 * 模式标记在页面打开的那一刻就要成立：
		 *   · idb：服务端不存数据，boot.js 见到 __NOVEL_LOCAL_MODE__ 就接管 /api/*。
		 *   · users：前端要先走登录门，auth-gate.js 见到 __NOVEL_MULTIUSER__ 就知道
		 *     不能按"单机免登录"处理（单机时它也可以直接问 /api/auth/me）。
		 */
		const markers: string[] = [];
		if (localOnly) markers.push('<script>window.__NOVEL_LOCAL_MODE__ = true;</script>');
		if (multiUser) markers.push('<script>window.__NOVEL_MULTIUSER__ = true;</script>');
		const body =
			relative === "index.html" && markers.length > 0
				? Buffer.from(raw.toString("utf8").replace(INDEX_BOOT_TAG, `${markers.join("\n\t\t")}\n\t\t${INDEX_BOOT_TAG}`), "utf8")
				: raw;

		/*
		 * 缓存策略：
		 *   - 单机自用（fs）：一律 no-store —— 本机开发工具，改完刷新就该看到新版。
		 *   - 多用户部署（idb/users）：脚本、样式、图标给 ETag + max-age=0, must-revalidate。
		 *     没上文件名指纹，所以不敢标 immutable；没变就是 304，变了立刻拿到新版。
		 *     页面本身仍旧 no-store，免得部署方改了配置还得让所有人清缓存。
		 */
		const deploy = localOnly || multiUser;
		const cacheable = deploy && !relative.endsWith(".html") && /\.(?:js|css|mjs|svg|json|webmanifest|woff2?)$/i.test(relative);
		const cacheControl = cacheable ? "private, max-age=0, must-revalidate" : "no-store";
		const info = cacheable ? await stat(target).catch(() => undefined) : undefined;
		const etag = info ? `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"` : undefined;
		if (etag && res.req.headers["if-none-match"] === etag) {
			res.writeHead(304, { etag, "cache-control": cacheControl });
			res.end();
			return;
		}
		const headers: Record<string, string> = {
			"content-type": MIME[path.extname(target)] ?? "application/octet-stream",
			"cache-control": cacheControl,
		};
		if (etag) headers.etag = etag;
		sink.writeHead(200, headers);
		sink.end(body);
	}
}

/** 云端模式里通过鉴权的那一次请求。 */
function requestContext(req: IncomingMessage, config: AppConfig): CloudRequestContext {
	// 反代后面 socket 是代理的地址、协议也变成 http，得听 X-Forwarded-*；
	// 直接暴露在公网时则绝不能信这些头（任何客户端都能伪造）。
	const trust = config.auth.trustProxy;
	const forwardedFor = trust ? firstHeader(req.headers["x-forwarded-for"]) : "";
	const forwardedProto = trust ? firstHeader(req.headers["x-forwarded-proto"]).toLowerCase() : "";
	const forwardedHost = trust ? firstHeader(req.headers["x-forwarded-host"]) : "";
	const socket = req.socket as typeof req.socket & { encrypted?: boolean };
	const secure = forwardedProto ? forwardedProto === "https" : socket.encrypted === true;
	const host = forwardedHost || req.headers.host || "localhost";
	return {
		ip: forwardedFor || req.socket.remoteAddress || "",
		secure,
		// 与浏览器发来的 Origin 头同形，账号模块据此做 CSRF 校验。
		origin: `${secure ? "https" : "http"}://${host}`,
		userAgent: String(req.headers["user-agent"] ?? ""),
	};
}

function firstHeader(value: string | string[] | undefined): string {
	const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
	return raw.split(",")[0]?.trim() ?? "";
}

/**
 * 原生外壳的页面来源。Tauri v2 在 Linux/macOS 用 tauri://localhost，
 * 在 Windows/Android 用 http(s)://tauri.localhost；1420 是 `tauri dev` 的默认端口。
 * 这些来源只会出现在用户自己安装的客户端里，放行它们不为任何网站开后门。
 */
const NATIVE_ORIGINS = [
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
	"http://localhost:1420",
	"http://127.0.0.1:1420",
];

function normalizeOrigin(value: string): string {
	return value.trim().replace(/\/+$/, "").toLowerCase();
}

function originAllowed(origin: string, config: AppConfig, ctx: CloudRequestContext): boolean {
	const wanted = normalizeOrigin(origin);
	if (ctx.origin && normalizeOrigin(ctx.origin) === wanted) return true;
	if (NATIVE_ORIGINS.includes(wanted)) return true;
	return config.corsOrigins.some((allowed) => allowed === "*" || normalizeOrigin(allowed) === wanted);
}

/**
 * 给跨源请求补 CORS 头；返回 true 表示这是一次预检，已经回答完毕。
 *
 * 只对浏览器生效：服务端不做"来源不对就拒绝业务"的判断 —— 带 Cookie 的写请求
 * 由账号层的 CSRF 校验负责，Bearer/原生客户端本来就能自证身份。预检则必须答，
 * 否则浏览器根本不会把登录请求发出来。
 */
function applyCors(req: IncomingMessage, res: ServerResponse, config: AppConfig, ctx: CloudRequestContext): boolean {
	const origin = firstHeader(req.headers.origin);
	if (!origin) return false;
	res.setHeader("vary", "Origin");
	const preflight = req.method === "OPTIONS" && firstHeader(req.headers["access-control-request-method"]).length > 0;
	if (!originAllowed(origin, config, ctx)) {
		if (preflight) {
			json(createNodeApiSink(res), 403, { error: "请求来源不被允许", code: "cors_blocked" });
			return true;
		}
		return false;
	}
	res.setHeader("access-control-allow-origin", origin);
	res.setHeader("access-control-allow-credentials", "true");
	if (!preflight) return false;
	res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
	// 预检里可能一次问好几个头（authorization + content-type + x-novel-client）。
	// 必须把它们全部回出来：浏览器只认同"全部允许"的预检，回一个就整条请求作废。
	const asked = String(req.headers["access-control-request-headers"] ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean)
		.join(", ");
	res.setHeader("access-control-allow-headers", asked || "authorization, content-type, x-novel-client, accept");
	res.setHeader("access-control-max-age", "600");
	res.writeHead(204);
	res.end();
	return true;
}

function relayHostsText(config: AppConfig): string {
	return config.relay.allowedHosts.length > 0 ? config.relay.allowedHosts.join(", ") : "（未设白名单：任何公开 https 主机）";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 本机页面（`pnpm dev` 打开的 http://127.0.0.1:8787）直连云端是跨源请求：
 * 云端只放行自身来源与 Tauri 外壳，预检会 403，浏览器随后报 "Failed to fetch"。
 *
 * 这里给本机调试留一条同源转发 —— 页面请求 `/__cloud/api/…` 并带上
 * `x-cloud-target: https://…`，由本机服务端去取，浏览器看到的仍是同源请求。
 * 只在服务端绑定回环地址时启用：公网部署（HOST=0.0.0.0）不会开这个口子。
 */
async function handleCloudProxy(req: IncomingMessage, res: ServerResponse, url: URL, config: AppConfig): Promise<void> {
	const sink = createNodeApiSink(res);
	if (!LOOPBACK_HOSTS.has(config.host.trim().toLowerCase())) {
		json(sink, 404, { error: "这台服务器不提供本机转发", code: "proxy_disabled" });
		return;
	}
	let target: URL;
	try {
		target = new URL(String(req.headers["x-cloud-target"] ?? "").trim());
	} catch {
		json(sink, 400, { error: "转发目标不是一个合法地址", code: "bad_target" });
		return;
	}
	if (target.protocol !== "https:" && target.protocol !== "http:") {
		json(sink, 400, { error: "只能用 http(s) 转发", code: "bad_target" });
		return;
	}
	const behind = url.pathname.slice("/__cloud".length) || "/";
	const targetUrl = new URL(behind + url.search, target.href.replace(/\/+$/, "") + "/");

	const headers = new Headers();
	for (const name of ["authorization", "content-type", "accept", "x-novel-client", "user-agent"]) {
		const value = req.headers[name];
		if (typeof value === "string" && value) headers.set(name, value);
	}
	// 让云端按"它自己的来源"看待这次请求：CSRF 校验与 CORS 白名单都认这个值。
	headers.set("origin", target.origin);

	let body: Buffer | undefined;
	if (req.method !== "GET" && req.method !== "HEAD") {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		body = Buffer.concat(chunks);
	}

	let upstream: Response;
	try {
		upstream = await fetch(targetUrl, { method: req.method, headers, body, redirect: "manual" });
	} catch (error) {
		json(sink, 502, {
			error: "本机转发到 " + target.host + " 失败：" + (error instanceof Error ? error.message : String(error)),
			code: "upstream_unreachable",
		});
		return;
	}

	const passthrough = ["content-type", "cache-control", "vary"];
	for (const name of passthrough) {
		const value = upstream.headers.get(name);
		if (value) res.setHeader(name, value);
	}
	res.statusCode = upstream.status;
	res.end(Buffer.from(await upstream.arrayBuffer()));
}

function quotaText(bytes: number): string {
	if (bytes <= 0) return "不限";
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(bytes % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GB`;
	return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** idb 模式启动提醒：残留数据与缺失的浏览器构建产物。 */
async function warnIdbLeftovers(dataDir: string, publicDir: string): Promise<void> {
	const leftovers = await readdir(dataDir).catch(() => [] as import("node:fs").Dirent[]);
	if (leftovers.length > 0) {
		console.warn(
			"[server] 多用户模式（STORAGE=idb）下 data/ 目录里还有 " +
				leftovers.length +
				" 项残留，服务端不会读取它们。若要彻底不含用户数据，请清空该目录。",
		);
	}
	// 浏览器版的业务层是构建产物，不是源码：缺了它，页面能打开但每个接口都会 404。
	// 这一步最容易在部署时漏掉，所以在启动日志里直接点出来。
	const bundle = await stat(path.join(publicDir, "browser", "local-api.js")).catch(() => null);
	if (!bundle) {
		console.warn(
			"[server] 缺少 public/browser/local-api.js —— 浏览器里那套接口是构建产物，请先在仓库根目录跑一次：\n" +
				"           pnpm build:browser\n" +
				"         否则用 ?local=1 打开页面后，所有 /api/ 请求都会失败。",
		);
	}
}

/** 给 main.ts 用：把 App 挂到一个 HTTP server 上。 */
export function createHttpServer(app: App): ReturnType<typeof createServer> {
	return createServer((req, res) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		} catch {
			// 畸形请求行（例如扫描器发的 "GET http://["）会让 new URL 直接抛。
			json(createNodeApiSink(res), 400, { error: "请求地址不合法" });
			return;
		}
		void app.handle(req, res, url);
	});
}
