#!/usr/bin/env node
/**
 * 云端模式端到端验收。
 *
 * 和 scripts/auth-check.ts 的分工：
 *   · auth-check 直接调账号模块，验证密码、令牌、库表这些内部逻辑；
 *   · 本脚本起真实 HTTP 服务，走 createApp 的完整管线 —— 鉴权、配额、
 *     每用户工作区、静态页注入、三种 STORAGE 模式的分流，全部按浏览器的
 *     实际请求方式验一遍。
 *
 *   node --experimental-strip-types scripts/cloud-e2e.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp, createHttpServer } from "../src/server/app.ts";
import { readConfig, type AppConfig } from "../src/config/env.ts";

const PUBLIC_DIR = path.resolve("public");
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "admin-password-123";
const USER_PASSWORD = "user-password-123";

let failed = 0;
let passed = 0;
function check(condition: unknown, message: string): void {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${message}`);
	} else {
		failed += 1;
		console.error(`  FAIL ${message}`);
	}
}

interface Reply {
	status: number;
	data: any;
	text: string;
	headers: Headers;
}

interface Client {
	readonly cookie: string;
	call(method: string, urlPath: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
}

/** 每个 client 自带 cookie 罐，方便同时扮演管理员和普通用户。 */
function makeClient(base: string): Client {
	let cookie = "";
	return {
		get cookie() {
			return cookie;
		},
		async call(method, urlPath, body, headers = {}) {
			const response = await fetch(base + urlPath, {
				method,
				headers: {
					...(body !== undefined ? { "content-type": "application/json" } : {}),
					...(cookie ? { cookie } : {}),
					...headers,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "manual",
			});
			for (const line of response.headers.getSetCookie?.() ?? []) {
				const match = /^ns_session=([^;]+)/.exec(line);
				if (match) cookie = `ns_session=${match[1]}`;
				if (/^ns_session=;/.test(line) || /Max-Age=0/i.test(line)) cookie = "";
			}
			const text = await response.text();
			let data: any = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = text;
			}
			return { status: response.status, data, text, headers: response.headers };
		},
	};
}

interface Running {
	base: string;
	app: Awaited<ReturnType<typeof createApp>>;
	server: ReturnType<typeof createHttpServer>;
	close(): Promise<void>;
}

async function start(mode: "fs" | "idb" | "users", dataDir: string): Promise<Running> {
	process.env.STORAGE = mode;
	process.env.DATA_DIR = dataDir;
	const config: AppConfig = readConfig();
	const app = await createApp(config, PUBLIC_DIR);
	const server = createHttpServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${address.port}`;
	return {
		base,
		app,
		server,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await app.close();
		},
	};
}

const tempDirs: string[] = [];
async function tempDir(label: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), `novel-cloud-${label}-`));
	tempDirs.push(dir);
	return dir;
}

async function main(): Promise<void> {
	// ── 环境：窗外那些厂商 key 一律不参与，云端要按"用户自己配置"来算。
	process.env.STORAGE = "users";
	process.env.DATA_DIR = await tempDir("users");
	process.env.ADMIN_EMAIL = ADMIN_EMAIL;
	process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
	process.env.REGISTRATION = "open";
	process.env.DEFAULT_QUOTA_MB = "1";
	process.env.FIRST_USER_ADMIN = "1";
	process.env.TRUST_PROXY = "0";
	process.env.APP_NAME = "墨耕测试";

	const cloud = await start("users", process.env.DATA_DIR);
	console.log("\n[users] 账号、工作区与配额");

	const admin = makeClient(cloud.base);
	const config = await admin.call("GET", "/api/auth/config");
	check(config.status === 200 && config.data.mode === "multi", "GET /api/auth/config 返回 multi");
	check(config.data.registration === "open", "注册策略透出 open");

	const anonymous = await admin.call("GET", "/api/auth/me");
	check(anonymous.status === 401 && anonymous.data.code === "unauthorized", "未登录 /api/auth/me 返回 401");

	const login = await admin.call("POST", "/api/auth/login", { account: ADMIN_EMAIL, password: ADMIN_PASSWORD });
	check(login.status === 200 && login.data.user?.role === "admin", "管理员播种账号可登录");
	check(/ns_session=/.test(admin.cookie), "登录下发 ns_session Cookie");

	const me = await admin.call("GET", "/api/auth/me");
	check(me.status === 200 && me.data.mode === "multi" && me.data.user.email === ADMIN_EMAIL, "登录后 /api/auth/me 带用户");
	check(me.data.usage && typeof me.data.usage.usedBytes === "number", "/api/auth/me 带用量");

	const page = await fetch(`${cloud.base}/`);
	const pageText = await page.text();
	check(page.status === 200 && pageText.includes("__NOVEL_MULTIUSER__"), "首页注入云端模式标记");

	const created = await admin.call("POST", "/api/projects", { title: "管理员的书" });
	check(created.status === 201 && created.data.project?.id, "管理员能新建作品");
	const adminProjectId = created.data.project?.id as string;

	// ── 两个普通用户，验证目录与配额互相独立
	const alice = makeClient(cloud.base);
	const registered = await alice.call("POST", "/api/auth/register", {
		email: "alice@example.com",
		password: USER_PASSWORD,
		displayName: "爱丽丝",
	});
	check(registered.status === 201 && registered.data.user?.role === "user", "开放注册创建普通用户");
	const aliceId = registered.data.user?.id as string;

	const aliceList = await alice.call("GET", "/api/projects");
	check(aliceList.status === 200 && aliceList.data.projects.length === 0, "新用户看不到别人的作品");

	const aliceCreated = await alice.call("POST", "/api/projects", { title: "爱丽丝的书" });
	check(aliceCreated.status === 201, "普通用户能新建作品");
	const aliceProjectId = aliceCreated.data.project?.id as string;

	const bob = makeClient(cloud.base);
	const registeredBob = await bob.call("POST", "/api/auth/register", {
		email: "bob@example.com",
		password: USER_PASSWORD,
	});
	const bobId = registeredBob.data.user?.id as string;
	const bobList = await bob.call("GET", "/api/projects");
	check(bobList.status === 200 && bobList.data.projects.length === 0, "第二个用户同样从空开始（数据隔离）");

	const listed = await alice.call("GET", "/api/projects");
	check(listed.data.projects.length === 1 && listed.data.projects[0].id === aliceProjectId, "用户只看到自己的作品");

	// ── 管理员：列表、改配额、统计、审计
	const search = await admin.call("GET", `/api/admin/users?query=alice@example.com`);
	check(search.status === 200 && search.data.total === 1, "管理员按邮箱搜到用户");
	check(search.data.users[0]?.usedBytes > 0, "管理员列表带已用容量");

	const tighten = await admin.call("PATCH", `/api/admin/users/${aliceId}`, { quotaBytes: 1024 });
	check(tighten.status === 200 && tighten.data.user.quotaBytes === 1024, "管理员能改配额");

	// 配额只有 1KB，而这次提交的正文有 200KB：必须在落盘前挡住。
	const overflow = await alice.call("POST", "/api/projects", { title: "超配额", synopsis: "字".repeat(200_000) });
	check(overflow.status === 507 && overflow.data.code === "quota_exceeded", "超配额写入返回 507");
	check(overflow.data.usedBytes >= 1024, "507 带回当前用量与配额");

	const deleteAllowed = await alice.call("DELETE", `/api/projects/${aliceProjectId}`);
	check(deleteAllowed.status === 200 || deleteAllowed.status === 204, "配额用满时删除仍然放行");

	const stats = await admin.call("GET", "/api/admin/stats");
	check(stats.status === 200 && stats.data.users >= 3, "管理员统计包含全部账号");
	check(typeof stats.data.totalUsedBytes === "number", "统计带总用量");

	const audit = await admin.call("GET", "/api/admin/audit?limit=50");
	check(audit.status === 200 && Array.isArray(audit.data.entries) && audit.data.entries.length > 0, "审计日志有记录");

	// ── 删号：目录与登录态一起消失
	const removed = await admin.call("DELETE", `/api/admin/users/${bobId}`);
	check(removed.status === 204, "管理员能删除用户");
	const bobAfter = await bob.call("GET", "/api/auth/me");
	check(bobAfter.status === 401, "被删用户的会话立即失效");
	const selfDelete = await admin.call("DELETE", `/api/admin/users/${me.data.user.id}`);
	check(selfDelete.status === 400 || selfDelete.status === 403, "管理员不能删除自己");

	// ── 中继也要求登录
	const relay = await makeClient(cloud.base).call("POST", "/api/llm", {});
	check(relay.status === 401, "未登录访问 /api/llm 返回 401");

	// ── 管理员的书与爱丽丝的书各自落在 users/<id>/ 下
	const adminProjects = await admin.call("GET", "/api/projects");
	check(adminProjects.data.projects.some((item: any) => item.id === adminProjectId), "管理员自己的作品仍在");

	// ── 跨端：Tauri/手机直连云端的 CORS 预检与响应头
	const nativeClient = makeClient(cloud.base);
	const preflight = await nativeClient.call("OPTIONS", "/api/auth/login", undefined, {
		origin: "tauri://localhost",
		"access-control-request-method": "POST",
		"access-control-request-headers": "authorization,content-type,x-novel-client",
	});
	check(preflight.status === 204, "原生客户端预检返回 204");
	check(preflight.headers.get("access-control-allow-origin") === "tauri://localhost", "原生来源拿到 ACAO");
	const corsConfig = await nativeClient.call("GET", "/api/auth/config", undefined, { origin: "tauri://localhost" });
	check(corsConfig.headers.get("access-control-allow-origin") === "tauri://localhost", "跨源普通响应也带 ACAO");
	const evilPreflight = await nativeClient.call("OPTIONS", "/api/auth/login", undefined, {
		origin: "https://evil.example",
		"access-control-request-method": "POST",
	});
	check(evilPreflight.status === 403, "陌生来源的预检被拒");
	const relayPreflight = await nativeClient.call("OPTIONS", "/api/llm", undefined, {
		origin: "tauri://localhost",
		"access-control-request-method": "POST",
	});
	check(relayPreflight.status !== 401, "未登录也能完成 /api/llm 预检");

	await cloud.close();

	// ── 单机模式：不需要登录，账号接口明确关闭
	console.log("\n[fs] 单机模式");
	process.env.STORAGE = "fs";
	process.env.DATA_DIR = await tempDir("fs");
	delete process.env.ADMIN_EMAIL;
	delete process.env.ADMIN_PASSWORD;
	const single = await start("fs", process.env.DATA_DIR);
	const solo = makeClient(single.base);
	const soloMe = await solo.call("GET", "/api/auth/me");
	check(soloMe.status === 200 && soloMe.data.mode === "single", "单机模式 /api/auth/me 返回 single");
	const soloConfig = await solo.call("GET", "/api/auth/config");
	check(soloConfig.status === 200 && soloConfig.data.mode === "single", "单机模式 /api/auth/config 返回 single");
	const soloLogin = await solo.call("POST", "/api/auth/login", { account: "x", password: "y" });
	check(soloLogin.status === 404, "单机模式没有登录接口");
	const soloProjects = await solo.call("GET", "/api/projects");
	check(soloProjects.status === 200, "单机模式业务接口照旧可用");
	const soloPage = await (await fetch(`${single.base}/`)).text();
	check(!soloPage.includes("__NOVEL_MULTIUSER__"), "单机模式不注入云端标记");
	await single.close();

	// ── idb 模式：服务端不碰用户数据
	console.log("\n[idb] 纯浏览器模式");
	process.env.STORAGE = "idb";
	process.env.DATA_DIR = await tempDir("idb");
	const local = await start("idb", process.env.DATA_DIR);
	const localPage = await (await fetch(`${local.base}/`)).text();
	check(localPage.includes("__NOVEL_LOCAL_MODE__"), "首页注入本地模式标记");
	const blocked = await makeClient(local.base).call("GET", "/api/projects");
	check(blocked.status === 503, "idb 模式下业务接口 503");
	await local.close();

	console.log(`\n${failed === 0 ? "通过" : "失败"}：${passed} 项通过，${failed} 项失败`);
	if (failed > 0) process.exitCode = 1;
}

try {
	await main();
} finally {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
