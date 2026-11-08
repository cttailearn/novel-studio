/**
 * 服务进程入口。
 *
 * 只做三件事：读环境变量、按配置把 App 装配起来、起 HTTP 服务。
 * 具体的存储/账号/路由接线都在 app.ts，方便测试直接 createApp 起一个实例。
 *
 * 三种存储模式（STORAGE）：
 *   · fs（默认）  单机自用：数据全在 data/。
 *   · idb        纯浏览器：服务端不碰用户数据，只发静态页 + 无状态中继。
 *   · users      云端账号：登录、注册、配额，数据在 data/users/<id>/。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, readConfig } from "../config/env.ts";
import { createApp, createHttpServer } from "./app.ts";

loadEnvFile();
const config = readConfig();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/**
 * 兜底：一次没接住的异常，不该把整个服务带走。
 *
 * 进程活着就等于"服务在线"：一次 EPIPE、一次没 await 的拒绝，都会让用户的
 * 下一次点击直接撞上"连不上服务"。记清楚日志，让服务继续跑。
 */
process.on("uncaughtException", (error) => {
	console.error("[server] 未捕获的异常（服务继续跑）：", error);
});
process.on("unhandledRejection", (reason) => {
	console.error("[server] 没接住的 Promise 拒绝（服务继续跑）：", reason);
});

let app: Awaited<ReturnType<typeof createApp>>;
try {
	app = await createApp(config, publicDir);
} catch (error) {
	console.error("[server] 启动失败（配置或数据目录有问题）：", error);
	process.exit(1);
}

const server = createHttpServer(app);

server.on("error", (error) => {
	console.error(`[server] 监听 ${config.host}:${config.port} 失败：`, error);
	process.exit(1);
});

server.listen(config.port, config.host, async () => {
	console.log(`novel-studio 已启动  http://${config.host}:${config.port}`);
	try {
		for (const line of await app.describe()) console.log(line);
	} catch (error) {
		console.error("[server] 启动信息读取失败：", error);
	}
});

/**
 * 收尾：先停止接新连接，再把内存里的稿子 flush 下去。
 *
 * 写作台最怕的是"关服务时正在写的那一章没落盘"。给在途请求留 5 秒，
 * 之后强制断开 —— 宁可少一个长连接的浏览器，也不能让进程永远退不出去。
 */
let closing = false;
async function shutdown(signal: string): Promise<void> {
	if (closing) return;
	closing = true;
	console.log(`\n[server] 收到 ${signal}，正在收尾…`);
	const timer = setTimeout(() => {
		console.warn("[server] 收尾超时，强制退出");
		server.closeAllConnections?.();
		process.exit(0);
	}, 5000);
	timer.unref();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	try {
		await app.close();
	} catch (error) {
		console.error("[server] 收尾时出错：", error);
	}
	clearTimeout(timer);
	console.log("[server] 已停止");
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void shutdown(signal);
	});
}
