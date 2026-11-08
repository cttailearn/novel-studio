/**
 * 账号相关的 HTTP 路由：`/api/auth/*`、`/api/account/*`、`/api/admin/*`。
 *
 * 只做三件事：认路、取参、写响应。鉴权、限流、护栏全在 auth.ts / admin.ts 里，
 * 这样同一套规则既能被 HTTP 调用，也能被脚本直接调。
 *
 * 响应一律自己写 sink（不借用 app 的 JSON 助手），因为登录类响应需要带
 * Set-Cookie，而中间层的 helper 未必留了加头的位置。
 */
import type { ApiRequest, ApiSink } from "../api-router.ts";
import { HttpError } from "../api-router.ts";
import type { AuthConfig } from "../../config/env.ts";
import type { AdminService, CreateUserInput, UpdateUserInput } from "./admin.ts";
import type { AuthResult, AuthService } from "./auth.ts";
import { CloudError, notFound, unauthorized } from "./errors.ts";
import { bearerToken, cookieToken, headerValue, isNativeClient, sameOrigin } from "./tokens.ts";
import type { AuthContext, CloudRequestContext } from "./types.ts";
import {
	asObject,
	type JsonObject,
	optionalNumber,
	optionalString,
	readPage,
	readQuota,
	readRole,
	readStatus,
	requiredString,
} from "./validate.ts";

/** 三个由本模块接管的路径前缀。 */
const CLOUD_PREFIXES = ["/api/auth", "/api/account", "/api/admin"] as const;

/** 这些方法不写数据，不需要 CSRF 校验。 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 路径归一化：去掉尾部多余的斜杠，避免 `/api/auth/me/` 掉进 404。 */
function normalizePath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
	return pathname;
}

/** 是不是本模块的路径。app.ts 也用它做提前分流，所以导出。 */
export function isCloudPath(pathname: string): boolean {
	const path = normalizePath(pathname);
	return CLOUD_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

export interface CloudRouterOptions {
	auth: AuthService;
	admin: AdminService;
	config: AuthConfig;
	/** 额外放行的来源（CORS 白名单），与 ctx.origin 同等对待。 */
	corsOrigins: readonly string[];
}

export class CloudRouter {
	private readonly auth: AuthService;
	private readonly admin: AdminService;
	private readonly config: AuthConfig;
	private readonly corsOrigins: readonly string[];

	constructor(options: CloudRouterOptions) {
		this.auth = options.auth;
		this.admin = options.admin;
		this.config = options.config;
		this.corsOrigins = options.corsOrigins;
	}

	/** 非本模块路径立刻返回 false（一个字节的 body 都不会读）。 */
	async handle(req: ApiRequest, sink: ApiSink, ctx: CloudRequestContext): Promise<boolean> {
		if (!isCloudPath(req.pathname)) return false;
		try {
			await this.dispatch(req, sink, ctx);
		} catch (error) {
			this.fail(sink, error);
		}
		return true;
	}

	// ── 分发 ──────────────────────────────────

	private async dispatch(req: ApiRequest, sink: ApiSink, ctx: CloudRequestContext): Promise<void> {
		const method = req.method.toUpperCase();
		if (!SAFE_METHODS.has(method)) this.checkCsrf(req, ctx);

		const path = normalizePath(req.pathname);
		const parts = path.split("/").filter((piece) => piece.length > 0);

		if (method === "GET" && path === "/api/auth/config") {
			this.writeJson(sink, 200, {
				mode: "multi",
				registration: this.config.registration,
				minPasswordLength: this.config.minPasswordLength,
				defaultQuotaBytes: this.config.defaultQuotaBytes,
				appName: this.config.appName,
			});
			return;
		}

		if (method === "POST" && path === "/api/auth/register") {
			const body = await this.readBody(req);
			const result = await this.auth.register(
				{
					email: requiredString(body, "email", "邮箱"),
					password: requiredString(body, "password", "密码"),
					username: optionalString(body, "username", "用户名"),
					displayName: optionalString(body, "displayName", "昵称"),
				},
				ctx,
				isNativeClient(req),
			);
			this.authResponse(sink, 201, result, ctx, isNativeClient(req));
			return;
		}

		if (method === "POST" && path === "/api/auth/login") {
			const body = await this.readBody(req);
			const result = await this.auth.login(
				{
					account: requiredString(body, "account", "邮箱或用户名"),
					password: requiredString(body, "password", "密码"),
				},
				ctx,
				isNativeClient(req),
			);
			this.authResponse(sink, 200, result, ctx, isNativeClient(req));
			return;
		}

		if (method === "POST" && path === "/api/auth/logout") {
			// 退出登录做成幂等：Cookie 早已过期时也回 204，前端才能把本地状态干净清掉。
			const auth = await this.auth.authenticate(req, ctx);
			if (auth) this.auth.logout(auth, ctx);
			this.writeEmpty(sink, 204, { "set-cookie": this.auth.clearCookieValue(ctx) });
			return;
		}

		if (method === "GET" && path === "/api/auth/me") {
			const auth = await this.requireAuth(req, ctx);
			const usage = await this.auth.usageOf(auth.user.id);
			this.writeJson(sink, 200, { mode: "multi", user: auth.user, usage });
			return;
		}

		if (method === "POST" && path === "/api/auth/password") {
			const auth = await this.requireAuth(req, ctx);
			const body = await this.readBody(req);
			await this.auth.changePassword(
				auth,
				{
					currentPassword: requiredString(body, "currentPassword", "当前密码"),
					newPassword: requiredString(body, "newPassword", "新密码"),
				},
				ctx,
			);
			this.writeEmpty(sink, 204);
			return;
		}

		if (method === "PATCH" && path === "/api/auth/profile") {
			const auth = await this.requireAuth(req, ctx);
			const body = await this.readBody(req);
			const user = this.auth.updateProfile(
				auth,
				{
					displayName: optionalString(body, "displayName", "昵称"),
					username: optionalString(body, "username", "用户名"),
				},
				ctx,
			);
			this.writeJson(sink, 200, { user });
			return;
		}

		if (method === "GET" && path === "/api/auth/sessions") {
			const auth = await this.requireAuth(req, ctx);
			this.writeJson(sink, 200, { sessions: this.auth.listSessions(auth) });
			return;
		}

		if (method === "POST" && path === "/api/auth/sessions/revoke-others") {
			const auth = await this.requireAuth(req, ctx);
			this.auth.revokeOtherSessions(auth, ctx);
			this.writeEmpty(sink, 204);
			return;
		}

		if (method === "DELETE" && parts.length === 4 && parts[1] === "auth" && parts[2] === "sessions") {
			const sessionId = parts[3] ?? "";
			if (sessionId.length === 0) throw notFound("会话不存在", "session_not_found");
			const auth = await this.requireAuth(req, ctx);
			const wasCurrent = this.auth.revokeSession(auth, sessionId, ctx);
			this.writeEmpty(sink, 204, wasCurrent ? { "set-cookie": this.auth.clearCookieValue(ctx) } : {});
			return;
		}

		if (method === "GET" && path === "/api/account/usage") {
			const auth = await this.requireAuth(req, ctx);
			this.writeJson(sink, 200, await this.auth.usageOf(auth.user.id));
			return;
		}

		if (parts[0] === "api" && parts[1] === "admin") {
			await this.dispatchAdmin(req, sink, ctx, parts);
			return;
		}

		throw notFound("接口不存在", "not_found");
	}

	// ── 管理员 ────────────────────────────────

	private async dispatchAdmin(req: ApiRequest, sink: ApiSink, ctx: CloudRequestContext, parts: string[]): Promise<void> {
		const method = req.method.toUpperCase();
		const auth = await this.requireAuth(req, ctx);
		this.admin.requireAdmin(auth);

		const section = parts[2] ?? "";

		if (section === "users" && parts.length === 3) {
			if (method === "GET") {
				const { offset, limit } = readPage(req.searchParams);
				const search = (req.searchParams.get("query") ?? "").trim();
				this.writeJson(sink, 200, await this.admin.listUsers(search, offset, limit));
				return;
			}
			if (method === "POST") {
				const body = await this.readBody(req);
				const input: CreateUserInput = {
					email: requiredString(body, "email", "邮箱"),
					password: optionalString(body, "password", "密码"),
					username: optionalString(body, "username", "用户名"),
					displayName: optionalString(body, "displayName", "昵称"),
					role: readRole(optionalString(body, "role", "角色")),
					quotaBytes: readQuota(optionalNumber(body, "quotaBytes", "配额")),
				};
				const result = await this.admin.createUser(input, auth, ctx);
				const payload: Record<string, unknown> = { user: result.user };
				if (result.password !== undefined) payload["password"] = result.password;
				this.writeJson(sink, 201, payload);
				return;
			}
		}

		if (section === "users" && parts.length === 4) {
			const id = parts[3] ?? "";
			if (id.length === 0) throw notFound("账号不存在", "user_not_found");
			if (method === "PATCH") {
				const body = await this.readBody(req);
				const input: UpdateUserInput = {
					role: readRole(optionalString(body, "role", "角色")),
					status: readStatus(optionalString(body, "status", "状态")),
					quotaBytes: readQuota(optionalNumber(body, "quotaBytes", "配额")),
					displayName: optionalString(body, "displayName", "昵称"),
				};
				this.writeJson(sink, 200, { user: await this.admin.updateUser(id, input, auth, ctx) });
				return;
			}
			if (method === "DELETE") {
				await this.admin.deleteUser(id, auth, ctx);
				this.writeEmpty(sink, 204);
				return;
			}
		}

		if (section === "users" && parts.length === 5 && parts[4] === "password" && method === "POST") {
			const id = parts[3] ?? "";
			if (id.length === 0) throw notFound("账号不存在", "user_not_found");
			const body = await this.readBody(req);
			const password = await this.admin.resetPassword(id, optionalString(body, "password", "密码"), auth, ctx);
			this.writeJson(sink, 200, { password });
			return;
		}

		if (section === "stats" && parts.length === 3 && method === "GET") {
			this.writeJson(sink, 200, await this.admin.stats());
			return;
		}

		if (section === "audit" && parts.length === 3 && method === "GET") {
			const { offset, limit } = readPage(req.searchParams);
			this.writeJson(sink, 200, { entries: this.admin.auditEntries(offset, limit), total: this.admin.auditTotal() });
			return;
		}

		throw notFound("接口不存在", "not_found");
	}

	// ── 鉴权 / 校验 ───────────────────────────

	private async requireAuth(req: ApiRequest, ctx: CloudRequestContext): Promise<AuthContext> {
		const auth = await this.auth.authenticate(req, ctx);
		if (!auth) throw unauthorized();
		return auth;
	}

	/**
	 * CSRF：带 Cookie 的写请求必须同源。
	 *
	 * 只拦"用 Cookie 认证"的请求 —— 带 Bearer 的请求本来就跨不过浏览器同源策略，
	 * 而原生客户端可能同时留着旧 Cookie，不该被误伤。
	 */
	private checkCsrf(req: ApiRequest, ctx: CloudRequestContext): void {
		if (bearerToken(req).length > 0) return;
		if (cookieToken(req).length === 0) return;
		const origin = headerValue(req, "origin");
		if (origin.length === 0) return;
		const expected = (ctx.origin ?? "").trim();
		if (expected.length === 0) return;
		if (sameOrigin(origin, expected)) return;
		if (this.corsOrigins.some((allowed) => sameOrigin(origin, allowed))) return;
		throw new CloudError(403, "请求来源不受信任", "csrf_blocked");
	}

	private async readBody(req: ApiRequest): Promise<JsonObject> {
		return asObject(await req.json<unknown>());
	}

	// ── 响应 ──────────────────────────────────

	private authResponse(sink: ApiSink, status: number, result: AuthResult, ctx: CloudRequestContext, native: boolean): void {
		const body: Record<string, unknown> = { user: result.user };
		const headers: Record<string, string> = {};
		if (native) {
			// 原生客户端没有可靠的 Cookie 罐，令牌得放在响应体里。
			body["token"] = result.token;
		} else {
			headers["set-cookie"] = this.auth.sessionCookieValue(result.token, ctx);
		}
		this.writeJson(sink, status, body, headers);
	}

	private writeJson(sink: ApiSink, status: number, body: unknown, extra: Record<string, string> = {}): void {
		const headers: Record<string, string> = {
			"content-type": "application/json; charset=utf-8",
			// 账号响应里可能有令牌与配额，任何中间层都不许缓存。
			"cache-control": "no-store",
			...extra,
		};
		sink.writeHead(status, headers);
		sink.end(JSON.stringify(body));
	}

	private writeEmpty(sink: ApiSink, status: number, extra: Record<string, string> = {}): void {
		sink.writeHead(status, extra);
		sink.end();
	}

	/** 把业务错误翻成 JSON。响应一旦开始写就只能记日志了。 */
	private fail(sink: ApiSink, error: unknown): void {
		if (sink.headersSent || sink.ended || sink.destroyed) {
			console.error("[cloud] 响应已开始，无法返回错误", error);
			return;
		}
		if (error instanceof CloudError) {
			const headers: Record<string, string> = {};
			const retryAfter = error.details["retryAfter"];
			if (typeof retryAfter === "number") headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfter)));
			this.writeJson(sink, error.status, { error: error.message, code: error.code, ...error.details }, headers);
			return;
		}
		if (error instanceof HttpError) {
			this.writeJson(sink, error.status, { error: error.message, code: "bad_request" });
			return;
		}
		console.error("[cloud] 账号接口未预期错误", error);
		this.writeJson(sink, 500, { error: "服务器内部错误", code: "internal" });
	}
}
