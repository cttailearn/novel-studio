/**
 * 云端账号模块自检。
 *
 * 不依赖测试框架：临时目录里真开一个账号库，用最小的 fake ApiRequest/ApiSink
 * 走真实路由，把注册/登录/鉴权/会话/隔离/管理员/护栏/删号这一串跑一遍。
 *
 * 跑法：node --experimental-strip-types scripts/auth-check.ts
 * 输出逐条 "ok - ..."；任何一条失败都会打印原因并把退出码置 1。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ApiRequest, ApiSink } from "../src/server/api-router.ts";
import { HttpError } from "../src/server/api-router.ts";
import type { AppConfig, AuthConfig } from "../src/config/env.ts";
import { readRelayConfig } from "../src/config/env.ts";
import { AdminService } from "../src/server/cloud/admin.ts";
import { AuthService } from "../src/server/cloud/auth.ts";
import { CloudDb } from "../src/server/cloud/db.ts";
import { CloudError } from "../src/server/cloud/errors.ts";
import { openCloud } from "../src/server/cloud/index.ts";
import { hashToken } from "../src/server/cloud/tokens.ts";
import type { AuthContext, CloudRequestContext, CloudServices, Usage, UsageProvider } from "../src/server/cloud/types.ts";

// ───────────────────────────────────────────── fake 传输层

class FakeSink implements ApiSink {
	headersSent = false;
	ended = false;
	destroyed = false;
	statusCode = 0;
	private readonly headerMap: Record<string, string> = {};
	private readonly chunks: string[] = [];

	get status(): number {
		return this.statusCode;
	}

	get headers(): Record<string, string> {
		return this.headerMap;
	}

	get text(): string {
		return this.chunks.join("");
	}

	writeHead(status: number, headers?: Record<string, string>): void {
		this.statusCode = status;
		for (const key of Object.keys(this.headerMap)) delete this.headerMap[key];
		if (headers) for (const [name, value] of Object.entries(headers)) this.headerMap[name.toLowerCase()] = value;
		this.headersSent = true;
	}

	setHeader(name: string, value: string): void {
		this.headerMap[name.toLowerCase()] = value;
	}

	write(chunk: string | Uint8Array): void {
		this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
	}

	end(chunk?: string | Uint8Array): void {
		if (chunk !== undefined) this.write(chunk);
		this.ended = true;
	}

	onClose(_handler: () => void): () => void {
		return () => {};
	}

	onError(_handler: (error: unknown) => void): () => void {
		return () => {};
	}
}

class FakeRequest implements ApiRequest {
	readonly method: string;
	readonly pathname: string;
	readonly searchParams: URLSearchParams;
	readonly headers: Record<string, string | string[] | undefined>;
	private readonly bodyText: string;

	constructor(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
		const parsed = new URL(url, "http://localhost");
		this.pathname = parsed.pathname;
		this.searchParams = parsed.searchParams;
		this.method = method.toUpperCase();
		const normalized: Record<string, string | string[] | undefined> = {};
		for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = value;
		this.headers = normalized;
		this.bodyText = body === undefined ? "" : JSON.stringify(body);
	}

	async json<T = unknown>(): Promise<T> {
		if (this.bodyText.length === 0) return {} as T;
		try {
			return JSON.parse(this.bodyText) as T;
		} catch {
			throw new HttpError(400, "请求体不是合法 JSON");
		}
	}

	async raw(): Promise<Uint8Array> {
		return Buffer.from(this.bodyText, "utf8");
	}
}

// ───────────────────────────────────────────── 断言

let passed = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = ""): void {
	if (condition) {
		passed += 1;
		console.log("ok - " + label);
		return;
	}
	failures.push(label + (detail.length > 0 ? "：" + detail : ""));
	console.log("not ok - " + label + (detail.length > 0 ? " —— " + detail : ""));
}

function section(title: string): void {
	console.log("\n# " + title);
}

/** 取签名里的错误码，比对时不需要关心具体异常类。 */
function errorCode(error: unknown): string {
	return error instanceof CloudError ? error.code : "unexpected:" + String(error);
}

function obj(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return {};
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

// ───────────────────────────────────────────── 假用量与依赖

class FakeUsage implements UsageProvider {
	readonly touched: string[] = [];
	readonly invalidated: string[] = [];
	readonly disposed: string[] = [];
	private readonly sizes = new Map<string, number>();

	setUsed(userId: string, bytes: number): void {
		this.sizes.set(userId, bytes);
	}

	async usageOf(userId: string): Promise<Usage> {
		this.touched.push(userId);
		const used = this.sizes.get(userId) ?? 0;
		return {
			usedBytes: used,
			quotaBytes: 0,
			breakdown: { projects: used, library: 0, sources: 0, records: 0, settings: 0, other: 0 },
			updatedAt: Date.now(),
		};
	}

	invalidate(userId: string): void {
		this.invalidated.push(userId);
	}

	async dispose(userId: string): Promise<void> {
		this.disposed.push(userId);
	}
}

interface ApiResult {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: Record<string, unknown>;
	handled: boolean;
}

interface CallOptions {
	body?: unknown;
	headers?: Record<string, string>;
	ip?: string;
	secure?: boolean;
	origin?: string;
	userAgent?: string;
}

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function callOn(service: CloudServices, method: string, url: string, options: CallOptions = {}): Promise<ApiResult> {
	const req = new FakeRequest(method, url, options.body, options.headers);
	const sink = new FakeSink();
	const ctx: CloudRequestContext = {
		ip: options.ip ?? "203.0.113.10",
		secure: options.secure ?? false,
		origin: options.origin ?? "http://localhost",
		userAgent: options.userAgent ?? DEFAULT_UA,
	};
	const handled = await service.handle(req, sink, ctx);
	let json: Record<string, unknown> = {};
	if (sink.text.length > 0) {
		try {
			json = obj(JSON.parse(sink.text));
		} catch {
			json = {};
		}
	}
	return { status: sink.status, headers: { ...sink.headers }, text: sink.text, json, handled };
}

/** 从 Set-Cookie 里抠出令牌。 */
function cookieTokenOf(result: ApiResult): string {
	const raw = result.headers["set-cookie"] ?? "";
	const match = /^ns_session=([^;]*)/.exec(raw);
	return match?.[1] ?? "";
}

function cookieHeader(token: string): Record<string, string> {
	return token.length > 0 ? { cookie: "ns_session=" + token } : {};
}

function bearerHeader(token: string): Record<string, string> {
	return { authorization: "Bearer " + token };
}

/** 直接调 authenticate，验证"停用即失效"这类契约。 */
async function authenticateWith(service: CloudServices, headers: Record<string, string>, ctx?: Partial<CloudRequestContext>): Promise<AuthContext | null> {
	const req = new FakeRequest("GET", "/api/auth/me", undefined, headers);
	return service.authenticate(req, {
		ip: ctx?.ip ?? "203.0.113.10",
		secure: ctx?.secure ?? false,
		origin: ctx?.origin ?? "http://localhost",
		userAgent: ctx?.userAgent ?? DEFAULT_UA,
	});
}

function baseAuth(overrides: Partial<AuthConfig> = {}): AuthConfig {
	return {
		registration: "open",
		defaultQuotaBytes: 1024 * 1024,
		maxUsers: 0,
		sessionDays: 30,
		cookieSecure: "auto",
		trustProxy: false,
		adminEmail: "",
		adminPassword: "",
		firstUserAdmin: true,
		minPasswordLength: 8,
		appName: "墨耕-测试",
		...overrides,
	};
}

function baseConfig(dataDir: string, auth: AuthConfig): AppConfig {
	return {
		port: 0,
		host: "127.0.0.1",
		dataDir,
		defaultModel: "",
		defaultThinkingLevel: "off",
		storage: "users",
		corsOrigins: [],
		relay: readRelayConfig(""),
		auth,
	};
}

// ───────────────────────────────────────────── 主流程

async function main(): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "novel-cloud-check-"));
	const dataDir = path.join(root, "主库");
	const closedDir = path.join(root, "关闭注册");
	const seedDir = path.join(root, "播种");
	const deletedUsers: string[] = [];
	const usage = new FakeUsage();
	const services: CloudServices[] = [];

	try {
		const config = baseConfig(dataDir, baseAuth());
		const svc = await openCloud(config, {
			usage,
			onDeleteUser: async (userId) => {
				deletedUsers.push(userId);
			},
		});
		services.push(svc);
		const call = (method: string, url: string, options: CallOptions = {}): Promise<ApiResult> =>
			callOn(svc, method, url, options);

		section("公开配置与路径分流");

		const cfg = await call("GET", "/api/auth/config");
		ok(
			"/api/auth/config 无需登录",
			cfg.status === 200 && str(cfg.json["mode"]) === "multi" && str(cfg.json["appName"]) === "墨耕-测试",
			"status=" + String(cfg.status) + " body=" + cfg.text,
		);
		ok(
			"config 带注册策略、密码下限、默认配额",
			str(cfg.json["registration"]) === "open" && num(cfg.json["minPasswordLength"]) === 8 && num(cfg.json["defaultQuotaBytes"]) === 1024 * 1024,
			cfg.text,
		);
		ok("JSON 响应的 Content-Type 带 charset", (cfg.headers["content-type"] ?? "") === "application/json; charset=utf-8", cfg.headers["content-type"] ?? "");

		const otherPath = await call("GET", "/api/projects");
		ok("非账号路径不接管（返回 false 且不写响应）", otherPath.handled === false && otherPath.status === 0);

		const otherApi = await call("GET", "/api/adminx/users");
		ok("相似前缀不被误接管", otherApi.handled === false);

		section("注册");

		const reg = await call("POST", "/api/auth/register", {
			body: { email: " Admin@Example.com ", password: "secret123", username: "root", displayName: "站长" },
			ip: "203.0.113.20",
		});
		const adminId = str(obj(reg.json["user"])["id"]);
		ok("注册成功返回 201", reg.status === 201, "status=" + String(reg.status) + " body=" + reg.text);
		ok("邮箱被归一化成小写", str(obj(reg.json["user"])["email"]) === "admin@example.com", reg.text);
		ok("首个用户成为管理员", str(obj(reg.json["user"])["role"]) === "admin", reg.text);
		ok("Web 注册不下发 token 字段", reg.json["token"] === undefined, reg.text);
		ok("Web 注册下发 ns_session Cookie", cookieTokenOf(reg).length >= 32);
		const adminCookie = cookieTokenOf(reg);
		const cookieHeaderText = reg.headers["set-cookie"] ?? "";
		ok(
			"Cookie 属性为 Path=/ HttpOnly SameSite=Lax 且带 30 天 Max-Age",
			cookieHeaderText.includes("Path=/") &&
				cookieHeaderText.includes("HttpOnly") &&
				cookieHeaderText.includes("SameSite=Lax") &&
				cookieHeaderText.includes("Max-Age=2592000"),
			cookieHeaderText,
		);
		ok("HTTP 下不加 Secure", !cookieHeaderText.includes("Secure"), cookieHeaderText);

		const badEmail = await call("POST", "/api/auth/register", {
			body: { email: "not-an-email", password: "secret123" },
			ip: "203.0.113.20",
		});
		ok("邮箱格式不对返回 400", badEmail.status === 400, "status=" + String(badEmail.status));

		const shortPassword = await call("POST", "/api/auth/register", {
			body: { email: "short@example.com", password: "123" },
			ip: "203.0.113.20",
		});
		ok("密码短于下限返回 400", shortPassword.status === 400, "status=" + String(shortPassword.status));

		const dup = await call("POST", "/api/auth/register", {
			body: { email: "admin@example.com", password: "secret123" },
			ip: "203.0.113.20",
		});
		ok("重复邮箱返回 409 email_taken", dup.status === 409 && str(dup.json["code"]) === "email_taken", dup.text);

		section("鉴权：Cookie / Bearer / 续期");

		const me = await call("GET", "/api/auth/me", { headers: cookieHeader(adminCookie) });
		ok("Cookie 鉴权 /api/auth/me 正常", me.status === 200 && str(obj(me.json["user"])["id"]) === adminId, me.text);
		ok("me 返回 mode=multi 与用量", str(me.json["mode"]) === "multi" && num(obj(me.json["usage"])["usedBytes"]) === 0, me.text);
		ok("用量查询确实按用户 id 发起", usage.touched.includes(adminId));

		const anonymous = await call("GET", "/api/auth/me");
		ok("未登录 /me 返回 401 unauthorized", anonymous.status === 401 && str(anonymous.json["code"]) === "unauthorized", anonymous.text);

		const nativeLogin = await call("POST", "/api/auth/login", {
			body: { account: "root", password: "secret123" },
			headers: { "x-novel-client": "native" },
			ip: "203.0.113.21",
		});
		const nativeToken = str(nativeLogin.json["token"]);
		ok("原生登录把 token 放进响应体", nativeLogin.status === 200 && nativeToken.length >= 32, nativeLogin.text);
		ok("原生登录不下发 Cookie", nativeLogin.headers["set-cookie"] === undefined);

		const bearerMe = await call("GET", "/api/auth/me", { headers: bearerHeader(nativeToken) });
		ok("Bearer 鉴权 /me 正常", bearerMe.status === 200 && str(obj(bearerMe.json["user"])["id"]) === adminId, bearerMe.text);

		const secureLogin = await call("POST", "/api/auth/login", {
			body: { account: "admin@example.com", password: "secret123" },
			ip: "203.0.113.22",
			secure: true,
		});
		ok("HTTPS 连接下 Cookie 带 Secure", (secureLogin.headers["set-cookie"] ?? "").includes("Secure"), secureLogin.headers["set-cookie"] ?? "");

		const touched = await call("GET", "/api/auth/me", { headers: cookieHeader(adminCookie) });
		ok("滑动续期不影响正常请求", touched.status === 200);

		section("登录失败与限流");

		const wrongPassword = await call("POST", "/api/auth/login", {
			body: { account: "root", password: "definitely-wrong" },
			ip: "203.0.113.23",
		});
		ok(
			"密码错误统一返回 401 invalid_credentials",
			wrongPassword.status === 401 &&
				str(wrongPassword.json["code"]) === "invalid_credentials" &&
				str(wrongPassword.json["error"]) === "账号或密码不正确",
			wrongPassword.text,
		);

		const ghostAccount = await call("POST", "/api/auth/login", {
			body: { account: "ghost@example.com", password: "whatever-1" },
			ip: "203.0.113.24",
		});
		ok("不存在的账号同样返回 401（不透露是否存在）", ghostAccount.status === 401 && str(ghostAccount.json["code"]) === "invalid_credentials");

		for (let attempt = 0; attempt < 10; attempt += 1) {
			await call("POST", "/api/auth/login", {
				body: { account: "ghost@example.com", password: "wrong-" + String(attempt) },
				ip: "203.0.113.24",
			});
		}
		const limited = await call("POST", "/api/auth/login", {
			body: { account: "ghost@example.com", password: "wrong-again" },
			ip: "203.0.113.24",
		});
		ok(
			"同一账号连续失败后返回 429 并带 retryAfter",
			limited.status === 429 && str(limited.json["code"]) === "rate_limited" && num(limited.json["retryAfter"]) > 0,
			limited.text,
		);
		ok("限流响应带 Retry-After 头", (limited.headers["retry-after"] ?? "").length > 0, JSON.stringify(limited.headers));

		// 账号维度之外的 IP 维度：换账号也应当被拦住（防止撞库时绕过账号桶）。
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await call("POST", "/api/auth/login", {
				body: { account: "probe-" + String(attempt) + "@example.com", password: "wrong-ip-pass" },
				ip: "203.0.113.25",
			});
		}
		const ipLimited = await call("POST", "/api/auth/login", {
			body: { account: "yet-another@example.com", password: "wrong-ip-pass" },
			ip: "203.0.113.25",
		});
		ok(
			"同一 IP 换账号也被限流",
			ipLimited.status === 429 && str(ipLimited.json["code"]) === "rate_limited",
			ipLimited.text,
		);

		section("CSRF");

		const csrf = await call("POST", "/api/auth/logout", {
			headers: { ...cookieHeader(adminCookie), origin: "https://evil.example" },
		});
		ok(
			"带 Cookie 的跨源写请求返回 403 csrf_blocked",
			csrf.status === 403 && str(csrf.json["code"]) === "csrf_blocked",
			csrf.text,
		);
		const stillLoggedIn = await call("GET", "/api/auth/me", { headers: cookieHeader(adminCookie) });
		ok("被 CSRF 拦截后会话依然有效", stillLoggedIn.status === 200);

		const sameOrigin = await call("PATCH", "/api/auth/profile", {
			body: { displayName: "站长" },
			headers: { ...cookieHeader(adminCookie), origin: "http://localhost" },
		});
		ok("同源写请求放行", sameOrigin.status === 200, sameOrigin.text);

		section("会话列表与撤销");

		const sessions = await call("GET", "/api/auth/sessions", { headers: cookieHeader(adminCookie) });
		const sessionList = arr(sessions.json["sessions"]);
		ok("会话列表返回多台设备", sessions.status === 200 && sessionList.length >= 2, sessions.text);
		ok("会话列表恰好一条 current", sessionList.filter((item) => obj(item)["current"] === true).length === 1, sessions.text);
		const nativeSession = sessionList.map((item) => obj(item)).find((item) => str(item["client"]) === "native");
		ok("原生会话被识别为 native 客户端", nativeSession !== undefined, sessions.text);

		const revoke = await call("DELETE", "/api/auth/sessions/" + str(nativeSession?.["id"]), { headers: cookieHeader(adminCookie) });
		ok("撤销指定会话返回 204", revoke.status === 204, revoke.text);
		const revokedMe = await call("GET", "/api/auth/me", { headers: bearerHeader(nativeToken) });
		ok("被撤销的令牌立即失效", revokedMe.status === 401, revokedMe.text);

		const revokeOthers = await call("POST", "/api/auth/sessions/revoke-others", { headers: cookieHeader(adminCookie) });
		const afterOthers = await call("GET", "/api/auth/sessions", { headers: cookieHeader(adminCookie) });
		ok(
			"退出其它设备后只剩当前会话",
			revokeOthers.status === 204 && arr(afterOthers.json["sessions"]).length === 1,
			afterOthers.text,
		);
		const adminSessionId = str(obj(arr(afterOthers.json["sessions"])[0])["id"]);

		section("两用户隔离");

		const second = await call("POST", "/api/auth/register", {
			body: { email: "reader@example.com", password: "reader-pass", username: "reader" },
			ip: "203.0.113.30",
		});
		const readerId = str(obj(second.json["user"])["id"]);
		const readerCookie = cookieTokenOf(second);
		ok("第二个用户注册成功且不是管理员", second.status === 201 && str(obj(second.json["user"])["role"]) === "user", second.text);
		ok("两个用户 id 不同", readerId.length > 0 && readerId !== adminId);
		usage.setUsed(readerId, 4096);
		const readerMe = await call("GET", "/api/auth/me", { headers: cookieHeader(readerCookie) });
		ok("第二用户只能看到自己", str(obj(readerMe.json["user"])["id"]) === readerId, readerMe.text);
		ok("第二用户的用量是它自己的", num(obj(readerMe.json["usage"])["usedBytes"]) === 4096, readerMe.text);
		ok("用量按 user id 分别查询", usage.touched.includes(readerId) && usage.touched.includes(adminId));

		const readerUsage = await call("GET", "/api/account/usage", { headers: cookieHeader(readerCookie) });
		ok("/api/account/usage 返回用量对象", readerUsage.status === 200 && num(readerUsage.json["usedBytes"]) === 4096, readerUsage.text);

		const readerAdmin = await call("GET", "/api/admin/users", { headers: cookieHeader(readerCookie) });
		ok("普通用户访问管理接口返回 403", readerAdmin.status === 403, readerAdmin.text);

		const foreignDelete = await call("DELETE", "/api/auth/sessions/" + adminSessionId, { headers: cookieHeader(readerCookie) });
		ok(
			"不能撤销不属于自己的会话",
			foreignDelete.status === 404 && adminSessionId.length > 0,
			foreignDelete.text,
		);

		section("改密码");

		const nativeAgain = await call("POST", "/api/auth/login", {
			body: { account: "root", password: "secret123" },
			headers: { "x-novel-client": "native" },
			ip: "203.0.113.31",
		});
		const secondNativeToken = str(nativeAgain.json["token"]);
		const wrongCurrent = await call("POST", "/api/auth/password", {
			body: { currentPassword: "not-the-real-password", newPassword: "brand-new-pass" },
			headers: cookieHeader(adminCookie),
		});
		ok(
			"当前密码不对返回 400 invalid_password",
			wrongCurrent.status === 400 && str(wrongCurrent.json["code"]) === "invalid_password",
			wrongCurrent.text,
		);
		const changed = await call("POST", "/api/auth/password", {
			body: { currentPassword: "secret123", newPassword: "brand-new-pass" },
			headers: cookieHeader(adminCookie),
		});
		ok("改密码返回 204", changed.status === 204, changed.text);
		const kicked = await call("GET", "/api/auth/me", { headers: bearerHeader(secondNativeToken) });
		ok("改密后其它会话被撤销", kicked.status === 401, kicked.text);
		const oldPassword = await call("POST", "/api/auth/login", {
			body: { account: "root", password: "secret123" },
			ip: "203.0.113.32",
		});
		ok("旧密码不能再登录", oldPassword.status === 401, oldPassword.text);
		const newPassword = await call("POST", "/api/auth/login", {
			body: { account: "root", password: "brand-new-pass" },
			ip: "203.0.113.33",
			headers: { "x-novel-client": "native" },
		});
		ok("新密码可以登录", newPassword.status === 200 && str(obj(newPassword.json["user"])["id"]) === adminId, newPassword.text);

		section("管理员：列表 / 建号 / 改配额 / 重置密码 / 停用");

		const userList = await call("GET", "/api/admin/users", { headers: cookieHeader(adminCookie) });
		const listed = arr(userList.json["users"]).map((item) => obj(item));
		ok("管理员可以列出用户", userList.status === 200 && num(userList.json["total"]) === 2, userList.text);
		ok("列表带 usedBytes 与 sessionCount", num(listed[0]?.["usedBytes"]) >= 0 && num(listed[0]?.["sessionCount"]) >= 0, userList.text);

		const selfRole = await call("PATCH", "/api/admin/users/" + adminId, {
			body: { role: "user" },
			headers: cookieHeader(adminCookie),
		});
		ok("管理员不能给自己降级", selfRole.status === 400 && str(selfRole.json["code"]) === "self_guard", selfRole.text);

		const selfStatus = await call("PATCH", "/api/admin/users/" + adminId, {
			body: { status: "disabled" },
			headers: cookieHeader(adminCookie),
		});
		ok("管理员不能停用自己", selfStatus.status === 400 && str(selfStatus.json["code"]) === "self_guard", selfStatus.text);

		const created = await call("POST", "/api/admin/users", {
			body: { email: "invited@example.com", displayName: "被邀请的人" },
			headers: cookieHeader(adminCookie),
		});
		const invitedId = str(obj(created.json["user"])["id"]);
		const tempPassword = str(created.json["password"]);
		ok("管理员建号返回 201 与 16 位临时密码", created.status === 201 && tempPassword.length === 16, created.text);
		ok("建号默认角色是 user 且配额取默认值", str(obj(created.json["user"])["role"]) === "user" && num(obj(created.json["user"])["quotaBytes"]) === 1024 * 1024, created.text);

		const quota = await call("PATCH", "/api/admin/users/" + invitedId, {
			body: { quotaBytes: 2048 },
			headers: cookieHeader(adminCookie),
		});
		ok("改配额生效", quota.status === 200 && num(obj(quota.json["user"])["quotaBytes"]) === 2048, quota.text);
		ok("改配额后使缓存失效", usage.invalidated.includes(invitedId));

		const reset = await call("POST", "/api/admin/users/" + invitedId + "/password", {
			headers: cookieHeader(adminCookie),
		});
		const resetPassword = str(reset.json["password"]);
		ok("重置密码返回新密码", reset.status === 200 && resetPassword.length >= 8, reset.text);
		const invitedLogin = await call("POST", "/api/auth/login", {
			body: { account: "invited@example.com", password: resetPassword },
			ip: "203.0.113.40",
		});
		const invitedToken = cookieTokenOf(invitedLogin);
		ok("重置后的密码可以登录", invitedLogin.status === 200 && invitedToken.length > 0, invitedLogin.text);

		const disabled = await call("PATCH", "/api/admin/users/" + invitedId, {
			body: { status: "disabled" },
			headers: cookieHeader(adminCookie),
		});
		ok("停用账号返回 200", disabled.status === 200 && str(obj(disabled.json["user"])["status"]) === "disabled", disabled.text);
		const disabledAuth = await authenticateWith(svc, cookieHeader(invitedToken));
		ok("停用后 authenticate 返回 null", disabledAuth === null);
		const disabledLogin = await call("POST", "/api/auth/login", {
			body: { account: "invited@example.com", password: resetPassword },
			ip: "203.0.113.41",
		});
		ok("停用后登录返回 403 disabled", disabledLogin.status === 403 && str(disabledLogin.json["code"]) === "disabled", disabledLogin.text);

		section("最后管理员护栏");

		// 通过 HTTP 触不到这一条：能改到"最后一个管理员"的只能是它自己，而自锁护栏先拦住了。
		// 所以这里直接构造一个"另一个管理员"的服务调用，验证服务层自己也会拒绝。
		const guardDb = CloudDb.open(dataDir);
		const guardAuth = new AuthService({ db: guardDb, config: config.auth, usage });
		const guardAdmin = new AdminService({
			auth: guardAuth,
			db: guardDb,
			config: config.auth,
			usage,
			dataDir,
			onDeleteUser: async () => {},
		});
		const fakeActor: AuthContext = {
			user: {
				id: "actor-not-in-db",
				email: "actor@example.com",
				username: null,
				displayName: "另一个人",
				role: "admin",
				status: "active",
				quotaBytes: 0,
				createdAt: 0,
				lastLoginAt: null,
			},
			sessionId: "fake-session",
			token: "",
			expiresAt: 0,
		};
		const guardCtx: CloudRequestContext = { ip: "203.0.113.50", secure: false, origin: "http://localhost", userAgent: DEFAULT_UA };
		let demoteCode = "";
		try {
			await guardAdmin.updateUser(adminId, { role: "user" }, fakeActor, guardCtx);
		} catch (error) {
			demoteCode = errorCode(error);
		}
		ok("最后一个可用管理员不能被降级", demoteCode === "last_admin", demoteCode);
		let deleteCode = "";
		try {
			await guardAdmin.deleteUser(adminId, fakeActor, guardCtx);
		} catch (error) {
			deleteCode = errorCode(error);
		}
		ok("最后一个可用管理员不能被删除", deleteCode === "last_admin", deleteCode);
		guardDb.close();

		const selfDelete = await call("DELETE", "/api/admin/users/" + adminId, { headers: cookieHeader(adminCookie) });
		ok("管理员不能删除自己", selfDelete.status === 400 && str(selfDelete.json["code"]) === "self_guard", selfDelete.text);

		section("删除用户");

		const remove = await call("DELETE", "/api/admin/users/" + invitedId, { headers: cookieHeader(adminCookie) });
		ok("删除用户返回 204", remove.status === 204, remove.text);
		ok("删除后回调 onDeleteUser 收到 user id", deletedUsers.includes(invitedId), JSON.stringify(deletedUsers));
		ok("删除后通知用量实现 dispose", usage.disposed.includes(invitedId));
		const deletedLogin = await call("POST", "/api/auth/login", {
			body: { account: "invited@example.com", password: resetPassword },
			ip: "203.0.113.42",
		});
		ok("已删账号无法登录", deletedLogin.status === 401 && str(deletedLogin.json["code"]) === "invalid_credentials", deletedLogin.text);
		const afterDelete = await call("GET", "/api/admin/users", { headers: cookieHeader(adminCookie) });
		ok(
			"删除后列表里不再有该用户",
			arr(afterDelete.json["users"]).every((item) => str(obj(item)["id"]) !== invitedId) && num(afterDelete.json["total"]) === 2,
			afterDelete.text,
		);

		section("统计与审计");

		const stats = await call("GET", "/api/admin/stats", { headers: cookieHeader(adminCookie) });
		ok(
			"统计包含用户数与数据目录",
			stats.status === 200 &&
				num(stats.json["users"]) === 2 &&
				num(stats.json["activeUsers"]) === 2 &&
				str(stats.json["dataDir"]) === dataDir,
			stats.text,
		);
		ok("统计汇总已用容量", num(stats.json["totalUsedBytes"]) >= 0);

		const audit = await call("GET", "/api/admin/audit", { headers: cookieHeader(adminCookie) });
		const actions = arr(audit.json["entries"]).map((item) => str(obj(item)["action"]));
		ok("审计列表可读", audit.status === 200 && actions.length > 0, audit.text);
		ok(
			"关键动作都有审计",
			["register", "login", "login_failed", "password", "create_user", "delete_user"].every((action) => actions.includes(action)),
			JSON.stringify(actions),
		);

		section("滑动续期与密码存储");

		// 路由层看不到"5 分钟内只写一次"和"到期时间滑动"，这里直接注入时钟驱动 AuthService。
		const slideDir = path.join(root, "续期");
		const slideDb = CloudDb.open(slideDir);
		try {
			let clock = 1_700_000_000_000;
			const slideAuth = new AuthService({ db: slideDb, config: config.auth, usage: new FakeUsage(), now: () => clock });
			const slideCtx: CloudRequestContext = { ip: "203.0.113.70", secure: false, origin: "http://localhost", userAgent: DEFAULT_UA };
			const slideUser = await slideAuth.register({ email: "slide@example.com", password: "slide-pass-1" }, slideCtx, false);
			const slideRequest = new FakeRequest("GET", "/api/auth/me", undefined, cookieHeader(slideUser.token));
			const created = slideDb.findSessionByTokenHash(hashToken(slideUser.token));
			ok(
				"会话行只存 token 的 sha256 并带到期时间",
				created !== undefined && created.userId === slideUser.user.id && created.expiresAt === clock + slideAuth.sessionMs,
				JSON.stringify(created),
			);
			const storedUser = slideDb.findUserByEmail("slide@example.com");
			ok(
				"密码以 scrypt$N$r$p$salt$hash 形式存储",
				/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/.test(storedUser?.passwordHash ?? ""),
				storedUser?.passwordHash ?? "",
			);

			clock += 60_000;
			const nearAuth = await slideAuth.authenticate(slideRequest, slideCtx);
			const nearRow = slideDb.findSessionByTokenHash(hashToken(slideUser.token));
			ok(
				"5 分钟内的请求不重复写 last_seen_at",
				nearAuth !== null && nearRow?.lastSeenAt === created?.lastSeenAt,
				JSON.stringify(nearRow),
			);

			clock += 5 * 60_000;
			const renewed = await slideAuth.authenticate(slideRequest, slideCtx);
			const renewedRow = slideDb.findSessionByTokenHash(hashToken(slideUser.token));
			ok("超过 5 分钟写入新的 last_seen_at", renewedRow?.lastSeenAt === clock, JSON.stringify(renewedRow));
			ok(
				"到期时间随请求同步滑动",
				renewed?.expiresAt === clock + slideAuth.sessionMs && renewedRow?.expiresAt === clock + slideAuth.sessionMs,
				JSON.stringify(renewedRow),
			);

			clock += slideAuth.sessionMs + 1;
			ok("过期会话不再通过鉴权", (await slideAuth.authenticate(slideRequest, slideCtx)) === null);
		} finally {
			slideDb.close();
		}

		section("登出");

		const logout = await call("POST", "/api/auth/logout", { headers: cookieHeader(adminCookie) });
		ok("登出返回 204 且清 Cookie", logout.status === 204 && (logout.headers["set-cookie"] ?? "").includes("Max-Age=0"), logout.headers["set-cookie"] ?? "");
		const afterLogout = await call("GET", "/api/auth/me", { headers: cookieHeader(adminCookie) });
		ok("登出后原 Cookie 失效", afterLogout.status === 401, afterLogout.text);

		const anonymousLogout = await call("POST", "/api/auth/logout");
		ok(
			"未登录时登出也回 204（幂等）",
			anonymousLogout.status === 204 && (anonymousLogout.headers["set-cookie"] ?? "").includes("Max-Age=0"),
			anonymousLogout.text,
		);

		section("原生注册与播种");

		const nativeRegister = await call("POST", "/api/auth/register", {
			body: { email: "native@example.com", password: "native-pass" },
			headers: { "x-novel-client": "native" },
			ip: "203.0.113.60",
		});
		ok(
			"原生注册把 token 放进响应体且不下发 Cookie",
			nativeRegister.status === 201 && str(nativeRegister.json["token"]).length >= 32 && nativeRegister.headers["set-cookie"] === undefined,
			nativeRegister.text,
		);

		const closedSvc = await openCloud(baseConfig(closedDir, baseAuth({ registration: "closed" })), {
			usage: new FakeUsage(),
			onDeleteUser: async () => {},
		});
		services.push(closedSvc);
		const closedRegister = await callOn(closedSvc, "POST", "/api/auth/register", {
			body: { email: "late@example.com", password: "late-pass-1" },
			ip: "203.0.113.61",
		});
		ok(
			"关闭注册后返回 403 registration_closed",
			closedRegister.status === 403 && str(closedRegister.json["code"]) === "registration_closed",
			closedRegister.text,
		);

		const plainDir = path.join(root, "首个用户非管理员");
		const plainSvc = await openCloud(baseConfig(plainDir, baseAuth({ firstUserAdmin: false, maxUsers: 1 })), {
			usage: new FakeUsage(),
			onDeleteUser: async () => {},
		});
		services.push(plainSvc);
		const firstPlain = await callOn(plainSvc, "POST", "/api/auth/register", {
			body: { email: "plain@example.com", password: "plain-pass-1" },
			ip: "203.0.113.64",
		});
		ok(
			"firstUserAdmin=false 时首个用户是普通用户",
			firstPlain.status === 201 && str(obj(firstPlain.json["user"])["role"]) === "user",
			firstPlain.text,
		);
		const fullHouse = await callOn(plainSvc, "POST", "/api/auth/register", {
			body: { email: "overflow@example.com", password: "overflow-pass-1" },
			ip: "203.0.113.65",
		});
		ok(
			"人数上限已满返回 403 registration_full",
			fullHouse.status === 403 && str(fullHouse.json["code"]) === "registration_full",
			fullHouse.text,
		);

		const seedSvc = await openCloud(
			baseConfig(seedDir, baseAuth({ adminEmail: "boss@example.com", adminPassword: "boss-password" })),
			{ usage: new FakeUsage(), onDeleteUser: async () => {} },
		);
		services.push(seedSvc);
		const bossLogin = await callOn(seedSvc, "POST", "/api/auth/login", {
			body: { account: "boss@example.com", password: "boss-password" },
			ip: "203.0.113.62",
		});
		ok(
			"启动时按 ADMIN_EMAIL 播种管理员",
			bossLogin.status === 200 && str(obj(bossLogin.json["user"])["role"]) === "admin",
			bossLogin.text,
		);
		const secondOpen = await openCloud(baseConfig(seedDir, baseAuth({ adminEmail: "boss@example.com", adminPassword: "other-password" })), {
			usage: new FakeUsage(),
			onDeleteUser: async () => {},
		});
		services.push(secondOpen);
		const stillOld = await callOn(secondOpen, "POST", "/api/auth/login", {
			body: { account: "boss@example.com", password: "boss-password" },
			ip: "203.0.113.63",
		});
		ok("已存在管理员时再次启动不会覆盖密码", stillOld.status === 200, stillOld.text);

		svc.close();
		svc.close();
		ok("close 可以重复调用", true);
	} finally {
		for (const service of services) service.close();
		rmSync(root, { recursive: true, force: true });
	}

	console.log("\n" + String(passed) + " passed, " + String(failures.length) + " failed");
	if (failures.length > 0) {
		console.error("\n失败项：");
		for (const failure of failures) console.error("  - " + failure);
		process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error("auth-check 自身异常：", error);
	process.exitCode = 1;
});
