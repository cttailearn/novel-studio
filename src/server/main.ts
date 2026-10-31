/**
 * 服务进程入口。
 *
 * 这里只管三件事：
 *   · 开好数据（作品、素材库、设置、凭据、记录）与模型运行时
 *   · 把 /api/ 开头的请求交给路由层（api-router.ts）
 *   · 其余路径当静态文件发出去（public/）
 *
 * 路由本身已经与传输方式无关：同一套处理器将来在浏览器里对着 IndexedDB 也能跑，
 * 那边的适配器在 fetch-api.ts，路由在 api-router.ts，本文件只是 Node 侧那一头。
 *
 * 两种存储模式（STORAGE 环境变量）：
 *   · fs（默认）：单机自用。数据全在 data/，跟从前一样。
 *   · idb：多用户。服务端**一个字节的用户数据都不碰**：不开 data/ 下的任何文件，
 *     不读、不写、不建目录；只发静态页面，外加一条无状态 LLM 中继 /api/llm。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { loadEnvFile, readConfig } from "../config/env.ts";
import { newId, registerCustomKinds } from "../store/project.ts";
import { ProjectStore } from "../store/project-disk.ts";
import { MaterialLibrary } from "../store/library-disk.ts";
import { KindStore } from "../store/kinds-disk.ts";
import { answerQuestion, AskChannel } from "./ask.ts";
import { RECORDS_KEEP } from "./records.ts";
import { RecordStore } from "./records-disk.ts";
import { createApiRouter, json, type ApiRouter, type Session } from "./api-router.ts";
import { createNodeApiAdapter, createNodeApiSink } from "./node-http.ts";
import { createRelayRoute } from "./relay-route.ts";

loadEnvFile();
const config = readConfig();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/**
 * 多用户模式：数据只留浏览器。
 *
 * 开了这个模式，服务端就不该碰 data/ —— 连目录都不建。
 * 万一部署时忘了清空旧的 data/，这里会喊一声，免得以为"没上服务器"其实是
 * 上去了、只是没被人看见。
 */
const localOnly = config.storage === "idb";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

// ───────────────────────────────────────────── 本地模式（多用户）需要的运行时

/** 无状态中继：浏览器直连厂商被 CORS 挡住时的绕行通道。 */
const handleRelay = createRelayRoute(config.relay);

/**
 * 本地模式下服务端一个作品数据都不存。
 *
 * 这张表留空是有意的：多用户模式里，/api/ 的业务接口由浏览器里的路由层接管，
 * 服务端只保留静态页面与中继。谁要是漏接了某个接口，这里会直接回 503，
 * 而不是悄悄把某个用户的数据写到共享磁盘上。
 */
let router: ApiRouter | undefined;
let store: ProjectStore | undefined;

if (localOnly) {
	const leftovers = await readdir(config.dataDir).catch(() => [] as string[]);
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
} else {
	// 种类表先开：项目与素材库读进来时就要认得作者自建的类别。
	const kindStore = await KindStore.open(config.dataDir);
	registerCustomKinds(kindStore.list());
	store = await ProjectStore.open(config.dataDir);
	const libraryStore = await MaterialLibrary.open(config.dataDir);
	const settingsStore = await SettingsStore.open(config.dataDir);
	const credentialStore = await FileCredentialStore.open(config.dataDir);
	const recordStore = await RecordStore.open(config.dataDir);
	settingsStore.replace(syncBuiltinProviders(settingsStore.get(), config.defaultModel));
	initModelRuntime(settingsStore, credentialStore);

	/**
	 * 会话表。
	 *
	 * 一席对话就是一次写作或一次取材的现场：模型、智能体、提问通道都在里面。
	 * 进程一重启就没了，但记录留在 data/records.json 里，作者回头捡得回来。
	 */
	const sessions = new Map<string, Session>();

	/**
	 * 把这一侧的依赖递给路由。
	 *
	 * 路由不认文件系统，也不认 Node：它只认这些端口与几个小函数。
	 * 浏览器那边递进来的形状一模一样，只是底下换成 IndexedDB。
	 */
	router = createApiRouter({
		store,
		libraryStore,
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

/** Node 侧的接口处理函数：把请求与响应翻成路由认得的形状。 */
const handleApi = router ? createNodeApiAdapter(router) : undefined;

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
	const sink = createNodeApiSink(res);
	const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	const target = path.resolve(publicDir, relative);
	// 防止路径遍历越出静态目录。
	if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
		return json(sink, 403, { error: "禁止访问" });
	}
	const raw = await readFile(target).catch(() => undefined);
	if (!raw) return json(sink, 404, { error: "未找到" });
	/*
	 * 多用户模式下把本地模式钉死在页面上。
	 *
	 * 服务端不存数据这件事，应该在页面打开的那一刻就成立，而不是等用户
	 * 自己发现地址后面要加 ?local=1。注入的就是一个全局标记，
	 * boot.js 见到它就直接接管 /api/*。
	 */
	const body =
		localOnly && relative === "index.html"
			? Buffer.from(
					raw
						.toString("utf8")
						.replace(
							'<script src="/boot.js"></script>',
							'<script>window.__NOVEL_LOCAL_MODE__ = true;</script>\n\t\t<script src="/boot.js"></script>',
						),
					"utf8",
				)
			: raw;
	/*
	 * 缓存策略分两种活法：
	 *   - 单机自用（fs）：本机开发工具，一律 no-store —— 改完刷新就该看到新版。
	 *   - 多用户部署（idb）：脚本、样式、图标、catalog 这些静态资源给 ETag +
	 *     `max-age=0, must-revalidate`。没上文件名指纹，所以不敢标 immutable：
	 *     每次打开都带条件请求回来，没变就是 304（几百字节），变了立刻拿到新版。
	 *     页面本身仍旧 no-store，免得部署方改了配置还得让所有人清缓存。
	 */
	const cacheable =
		localOnly && !relative.endsWith(".html") && /\.(?:js|css|mjs|svg|json|webmanifest|woff2?)$/i.test(relative);
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

/**
 * 兜底：一次没接住的异常，不该把整个服务带走。
 *
 * 这是本地单人用的写作台，进程活着就等于"服务在线"。一次 EPIPE、
 * 一次没 await 的拒绝，都会让作者的下一次点击直接撞上"连不上服务"，
 * 而此刻他正写到一半 —— 稿子在内存里，页一关就没了。记清楚日志，
 * 让服务继续跑，比"干净地退出"对他有用得多。
 */
process.on("uncaughtException", (error) => {
	console.error("[server] 未捕获的异常（服务继续跑）：", error);
});
process.on("unhandledRejection", (reason) => {
	console.error("[server] 没接住的 Promise 拒绝（服务继续跑）：", reason);
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	// 客户端半路走了，写回话时就会在响应上抛 error。没人接就是未捕获异常。
	res.on("error", (error) => {
		console.error("[server] 响应流出错", error);
	});
	let url: URL;
	try {
		url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	} catch {
		// 畸形请求行（例如扫描器发的 "GET http://["）会让 new URL 直接抛。
		// 合法客户端不会这样请求，回 400 即可，但绝不能让整个进程退出。
		json(createNodeApiSink(res), 400, { error: "请求地址不合法" });
		return;
	}

	const run = (async () => {
		// 中继在所有模式都开着：直连被 CORS 挡住的厂商时，浏览器会走这里。
		if (url.pathname === "/api/llm") {
			await handleRelay(req, res);
			return;
		}
		if (url.pathname.startsWith("/api/")) {
			if (!handleApi) {
				json(createNodeApiSink(res), 503, {
					error: "服务端不持有用户数据。请在浏览器里以本地模式打开（地址后加 ?local=1）。",
				});
				return;
			}
			await handleApi(req, res, url);
			return;
		}
		await serveStatic(res, url.pathname);
	})();

	run.catch((error) => {
		console.error("[server]", error);
		if (!res.headersSent) json(createNodeApiSink(res), 500, { error: error instanceof Error ? error.message : String(error) });
		else if (!res.writableEnded) res.end();
	});
});

server.listen(config.port, config.host, () => {
	console.log(`novel-studio 已启动  http://${config.host}:${config.port}`);
	if (localOnly) {
		console.log("存储模式  idb（多用户：数据全部保存在各人的浏览器里，服务端不留存）");
		console.log(`中继      /api/llm  允许的主机：${config.relay.allowedHosts.length > 0 ? config.relay.allowedHosts.join(", ") : "（未设白名单：任何公开 https 主机）"}`);
		return;
	}
	console.log(`数据目录  ${config.dataDir}`);
	// 上次退出时若有没存上的稿，在这里补写一次。磁盘满、文件被占用这类故障
	// 多半是暂时的，重启后往往已经恢复，不补这一下用户就永远丢了那一稿。
	void store?.retryPending().then(() => {
		const pending = store?.pendingWrites() ?? [];
		if (pending.length > 0) console.error("[store] 仍有 " + pending.length + " 部作品未能落盘：" + pending.join(", "));
	});
	void listProviderStatus().then((providers) => {
		const ready = providers.filter((provider) => provider.authSource !== "none" && provider.registered).map((provider) => provider.label);
		console.log(ready.length > 0 ? `已配置厂商  ${ready.join(", ")}` : "未检测到厂商 API Key，请在 .env 中配置");
	});
});
