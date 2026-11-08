/**
 * 账号与会话的核心逻辑：注册、登录、鉴权、改密、设备列表。
 *
 * 这一层不写 HTTP：不碰 sink、不拼响应体，成功就返回数据，失败就抛
 * CloudError，由 routes.ts 统一翻译。这样 auth-check 也能直接调这些方法，
 * 不必每次绕一圈 fake 请求。
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AuthConfig } from "../../config/env.ts";
import type { ApiRequest } from "../api-router.ts";
import { accountDisabled, badRequest, CloudError, conflict, invalidCredentials, notFound, rateLimited } from "./errors.ts";
import type { CloudDb } from "./db.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { SlidingWindowLimiter } from "./rate-limit.ts";
import {
	bearerToken,
	clearedCookie,
	cookieToken,
	createToken,
	describeClient,
	hashToken,
	sessionCookie,
	truncate,
} from "./tokens.ts";
import type {
	AuthContext,
	CloudRequestContext,
	PublicUser,
	SessionRecord,
	Usage,
	UsageProvider,
	UserRecord,
	UserRole,
} from "./types.ts";
import { publicUser } from "./types.ts";
import { assertPassword, normalizeDisplayName, normalizeEmail, normalizeUsername } from "./validate.ts";

/** 滑动续期的最小间隔：`last_seen_at` 最多每 5 分钟写一次。 */
const SESSION_TOUCH_MS = 5 * 60 * 1000;

/** 一天多少毫秒。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 登录失败限流：同 IP、同账号各 10 次 / 15 分钟。 */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** 注册限流：同 IP 20 次 / 小时。 */
const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

/** 改密限流：同账号 5 次 / 15 分钟。 */
const PASSWORD_LIMIT = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;

export interface AuthServiceOptions {
	db: CloudDb;
	config: AuthConfig;
	usage: UsageProvider;
	/** 测试用的时钟注入；生产走 Date.now。 */
	now?: () => number;
}

export interface RegisterInput {
	email: string;
	password: string;
	username?: string;
	displayName?: string;
}

export interface LoginInput {
	account: string;
	password: string;
}

export interface AuthResult {
	user: PublicUser;
	/** 本次新建会话的明文令牌。是否下发到响应体由 routes 决定。 */
	token: string;
}

export interface SessionView {
	id: string;
	current: boolean;
	device: string;
	client: string;
	ip: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
}

export interface ProfileInput {
	displayName?: string;
	username?: string;
}

export interface PasswordInput {
	currentPassword: string;
	newPassword: string;
}

export class AuthService {
	/** 库对 admin.ts / routes.ts 也要用（查用户、查会话），所以直接公开。 */
	readonly db: CloudDb;
	private readonly config: AuthConfig;
	private readonly usage: UsageProvider;
	private readonly now: () => number;
	private readonly loginIp = new SlidingWindowLimiter(LOGIN_LIMIT, LOGIN_WINDOW_MS);
	private readonly loginAccount = new SlidingWindowLimiter(LOGIN_LIMIT, LOGIN_WINDOW_MS);
	private readonly registerIp = new SlidingWindowLimiter(REGISTER_LIMIT, REGISTER_WINDOW_MS);
	private readonly passwordUser = new SlidingWindowLimiter(PASSWORD_LIMIT, PASSWORD_WINDOW_MS);
	/** 账号不存在时也要跑一次 scrypt，否则响应快慢就能看出邮箱有没有注册过。 */
	private dummyHash: Promise<string> | undefined;

	constructor(options: AuthServiceOptions) {
		this.db = options.db;
		this.config = options.config;
		this.usage = options.usage;
		this.now = options.now ?? (() => Date.now());
	}

	/** 会话时长（毫秒）。配置里给的是天。 */
	get sessionMs(): number {
		const days = Number.isFinite(this.config.sessionDays) ? this.config.sessionDays : 30;
		return Math.max(1, Math.floor(days)) * DAY_MS;
	}

	// ── Cookie ────────────────────────────────

	/** 该不该给 Cookie 加 Secure。 */
	cookieSecure(ctx: CloudRequestContext): boolean {
		if (this.config.cookieSecure === "always") return true;
		if (this.config.cookieSecure === "never") return false;
		return ctx.secure;
	}

	/** 登录/注册成功时下发的 Set-Cookie 值。 */
	sessionCookieValue(token: string, ctx: CloudRequestContext): string {
		return sessionCookie(token, Math.floor(this.sessionMs / 1000), this.cookieSecure(ctx));
	}

	/** 登出时清 Cookie 的 Set-Cookie 值。 */
	clearCookieValue(ctx: CloudRequestContext): string {
		return clearedCookie(this.cookieSecure(ctx));
	}

	// ── 鉴权 ──────────────────────────────────

	/**
	 * 解出当前会话。
	 *
	 * 依次检查：令牌格式 → 库里有没有 → 被撤销没 → 过期没 → 账号还是 active 吗。
	 * 任意一步不过都返回 null（调用方一律按 401 处理，不区分原因，免得给爆破者递线索）。
	 * 通过之后做滑动续期：5 分钟内只写一次库。
	 */
	async authenticate(req: ApiRequest, ctx: CloudRequestContext): Promise<AuthContext | null> {
		const token = bearerToken(req) || cookieToken(req);
		if (!token) return null;
		const session = this.db.findSessionByTokenHash(hashToken(token));
		if (!session || session.revokedAt !== null || session.expiresAt <= this.now()) return null;
		const user = this.db.findUser(session.userId);
		if (!user || user.status !== "active") return null;

		let expiresAt = session.expiresAt;
		const now = this.now();
		if (now - session.lastSeenAt >= SESSION_TOUCH_MS) {
			expiresAt = now + this.sessionMs;
			this.db.touchSession(session.id, now, expiresAt);
			// 管理页要显示"最后活跃"，但 updated_at 表示资料变更，这里别动它。
			this.db.updateUser(user.id, { lastSeenAt: now, updatedAt: user.updatedAt });
		}
		return { user: publicUser(user), sessionId: session.id, token, expiresAt };
	}

	// ── 注册 / 登录 ───────────────────────────

	/** 注册并直接登录（成功即下发会话）。 */
	async register(input: RegisterInput, ctx: CloudRequestContext, native: boolean): Promise<AuthResult> {
		const now = this.now();
		if (this.config.registration !== "open") {
			throw new CloudError(403, "当前未开放注册", "registration_closed");
		}
		const wait = this.registerIp.hit("ip:" + ctx.ip, now);
		if (wait > 0) throw rateLimited(wait / 1000);

		const email = normalizeEmail(input.email);
		assertPassword(input.password, this.config.minPasswordLength);
		const username = normalizeUsername(input.username);
		const displayNameInput = normalizeDisplayName(input.displayName);

		if (this.db.findUserByEmail(email)) throw conflict("该邮箱已注册", "email_taken");
		if (username && this.db.findUserByUsername(username)) throw conflict("用户名已被占用", "username_taken");
		if (this.config.maxUsers > 0 && this.db.countUsers() >= this.config.maxUsers) {
			throw new CloudError(403, "账号数量已达上限", "registration_full");
		}

		const passwordHash = await hashPassword(input.password);
		// 首个用户晋升管理员：哈希算完之后再判一次，缩短并发注册的窗口。
		const role: UserRole = this.config.firstUserAdmin && this.db.countAdmins() === 0 ? "admin" : "user";
		const record: UserRecord = {
			id: randomUUID(),
			email,
			username,
			displayName: displayNameInput && displayNameInput.length > 0 ? displayNameInput : username ?? email.split("@")[0] ?? email,
			passwordHash,
			role,
			status: "active",
			quotaBytes: this.config.defaultQuotaBytes,
			createdAt: now,
			updatedAt: now,
			lastLoginAt: now,
			lastSeenAt: now,
		};
		try {
			this.db.insertUser(record);
		} catch (error) {
			throw this.translateConstraint(error);
		}
		const token = this.createSession(record.id, ctx, native, now);
		this.audit("register", "注册账号 " + email + (role === "admin" ? "（首个用户，设为管理员）" : ""), ctx.ip, record.id, record.id);
		return { user: publicUser(record), token };
	}

	/** 账号密码登录。account 可以是邮箱也可以是用户名。 */
	async login(input: LoginInput, ctx: CloudRequestContext, native: boolean): Promise<AuthResult> {
		const now = this.now();
		const account = input.account.trim();
		if (account.length === 0) throw badRequest("请输入邮箱或用户名");
		if (input.password.length === 0) throw badRequest("请输入密码");

		const ipKey = "ip:" + ctx.ip;
		const accountKey = "acct:" + account.toLowerCase();
		const wait = Math.max(this.loginIp.peek(ipKey, now), this.loginAccount.peek(accountKey, now));
		if (wait > 0) throw rateLimited(wait / 1000);
		// 只有真的放行才记一次，被挡住的请求不该继续累积（否则永远出不来）。
		this.loginIp.hit(ipKey, now);
		this.loginAccount.hit(accountKey, now);

		const user = this.db.findUserByLogin(account, account.toLowerCase());
		if (!user) {
			await this.burnPasswordCheck(input.password);
			this.audit("login_failed", "账号不存在：" + account, ctx.ip, null, null);
			throw invalidCredentials();
		}
		const passed = await verifyPassword(input.password, user.passwordHash);
		if (!passed) {
			this.audit("login_failed", "密码错误", ctx.ip, user.id, user.id);
			throw invalidCredentials();
		}
		if (user.status !== "active") {
			this.audit("login_failed", "账号已停用", ctx.ip, user.id, user.id);
			throw accountDisabled();
		}

		this.loginIp.reset(ipKey);
		this.loginAccount.reset(accountKey);
		this.db.updateUser(user.id, { lastLoginAt: now, lastSeenAt: now, updatedAt: user.updatedAt });
		const token = this.createSession(user.id, ctx, native, now);
		this.audit("login", "登录成功", ctx.ip, user.id, user.id);
		return { user: publicUser({ ...user, lastLoginAt: now, lastSeenAt: now }), token };
	}

	/** 登出：只撤销当前这一条会话。 */
	logout(auth: AuthContext, ctx: CloudRequestContext): void {
		this.db.revokeSession(auth.sessionId, this.now());
		this.audit("logout", "退出登录", ctx.ip, auth.user.id, auth.user.id);
	}

	// ── 账号资料 ──────────────────────────────

	/** 改密码：校验旧密码，落新散列，顺手踢掉其它设备。 */
	async changePassword(auth: AuthContext, input: PasswordInput, ctx: CloudRequestContext): Promise<void> {
		const now = this.now();
		const wait = this.passwordUser.hit("user:" + auth.user.id, now);
		if (wait > 0) throw rateLimited(wait / 1000);

		const record = this.db.findUser(auth.user.id);
		if (!record) throw notFound("账号不存在", "user_missing");
		const passed = await verifyPassword(input.currentPassword, record.passwordHash);
		if (!passed) {
			this.audit("password_failed", "当前密码不正确", ctx.ip, auth.user.id, auth.user.id);
			throw badRequest("当前密码不正确", "invalid_password");
		}
		assertPassword(input.newPassword, this.config.minPasswordLength);
		const passwordHash = await hashPassword(input.newPassword);
		this.db.updateUser(record.id, { passwordHash, updatedAt: now });
		// 改密之后旧设备一律失效，只留当前这条（否则"改了密码还被踢"体验很怪）。
		this.db.revokeUserSessions(record.id, now, auth.sessionId);
		this.audit("password", "修改密码，其它设备已退出", ctx.ip, record.id, record.id);
	}

	/** 改昵称/用户名。 */
	updateProfile(auth: AuthContext, input: ProfileInput, ctx: CloudRequestContext): PublicUser {
		const record = this.db.findUser(auth.user.id);
		if (!record) throw notFound("账号不存在", "user_missing");
		const displayName = normalizeDisplayName(input.displayName);
		const username = input.username === undefined ? undefined : normalizeUsername(input.username);
		if (displayName === undefined && username === undefined) return publicUser(record);
		if (username !== undefined && username !== null && username !== record.username) {
			const holder = this.db.findUserByUsername(username);
			if (holder && holder.id !== record.id) throw conflict("用户名已被占用", "username_taken");
		}
		const nextDisplayName = displayName === undefined || displayName.length === 0 ? record.displayName : displayName;
		const now = this.now();
		this.db.updateUser(record.id, {
			displayName: nextDisplayName,
			username: username === undefined ? undefined : username,
			updatedAt: now,
		});
		const detail = [displayName === undefined ? "" : "昵称→" + nextDisplayName, username === undefined ? "" : "用户名→" + (username ?? "（空）")]
			.filter((piece) => piece.length > 0)
			.join("，");
		this.audit("profile", detail || "无改动", ctx.ip, record.id, record.id);
		const fresh = this.db.findUser(record.id);
		return fresh ? publicUser(fresh) : publicUser(record);
	}

	// ── 会话 ──────────────────────────────────

	/** 当前账号所有还有效的会话（管理员看不了别人的，只能看自己的）。 */
	listSessions(auth: AuthContext): SessionView[] {
		const now = this.now();
		return this.db
			.listSessions(auth.user.id)
			.filter((session) => session.revokedAt === null && session.expiresAt > now)
			.map((session) => ({
				id: session.id,
				current: session.id === auth.sessionId,
				device: session.device,
				client: session.client,
				ip: session.ip,
				createdAt: session.createdAt,
				lastSeenAt: session.lastSeenAt,
				expiresAt: session.expiresAt,
			}));
	}

	/** 撤销一条自己的会话。返回它是不是当前这条（是的话调用方顺手清 Cookie）。 */
	revokeSession(auth: AuthContext, sessionId: string, ctx: CloudRequestContext): boolean {
		const session = this.db.findSession(sessionId);
		if (!session || session.userId !== auth.user.id) throw notFound("会话不存在", "session_not_found");
		this.db.revokeSession(session.id, this.now());
		this.audit("revoke_session", "撤销一个登录设备", ctx.ip, auth.user.id, auth.user.id);
		return session.id === auth.sessionId;
	}

	/** 踢掉除当前设备之外的所有会话。 */
	revokeOtherSessions(auth: AuthContext, ctx: CloudRequestContext): void {
		this.db.revokeUserSessions(auth.user.id, this.now(), auth.sessionId);
		this.audit("revoke_sessions", "退出其它设备", ctx.ip, auth.user.id, auth.user.id);
	}

	// ── 用量 ──────────────────────────────────

	usageOf(userId: string): Promise<Usage> {
		return this.usage.usageOf(userId);
	}

	/** 账号被删时通知用量实现丢掉缓存。 */
	dropUsage(userId: string): void {
		this.usage.invalidate(userId);
	}

	// ── 启动播种 ──────────────────────────────

	/**
	 * 按 ADMIN_EMAIL/ADMIN_PASSWORD 播种管理员。
	 *
	 * 只在"库里还没有这个邮箱"时建号；已存在就什么都不做 —— 环境变量是启动参数，
	 * 不能反过来覆盖用户后来改过的密码。
	 */
	async seedAdmin(): Promise<PublicUser | undefined> {
		const email = this.config.adminEmail.trim().toLowerCase();
		const password = this.config.adminPassword;
		if (email.length === 0 || password.length === 0) return undefined;
		if (this.db.findUserByEmail(email)) return undefined;
		const now = this.now();
		const record: UserRecord = {
			id: randomUUID(),
			email,
			username: null,
			displayName: "管理员",
			passwordHash: await hashPassword(password),
			role: "admin",
			status: "active",
			// 管理员默认不限额：超管被自己的配额卡住是最难解释的故障。
			quotaBytes: 0,
			createdAt: now,
			updatedAt: now,
			lastLoginAt: null,
			lastSeenAt: null,
		};
		try {
			this.db.insertUser(record);
		} catch {
			return undefined;
		}
		this.audit("seed_admin", "由 ADMIN_EMAIL 创建管理员 " + email, "启动", null, record.id);
		return publicUser(record);
	}

	/** 清掉过期会话行。graceMs 之内刚过期的先留着，好让设备列表还能显示。 */
	purgeSessions(graceMs = 7 * DAY_MS): number {
		return this.db.purgeSessions(this.now() - graceMs);
	}

	/** 定时清理限流器里的空桶。 */
	pruneRateLimits(): void {
		const now = this.now();
		this.loginIp.prune(now);
		this.loginAccount.prune(now);
		this.registerIp.prune(now);
		this.passwordUser.prune(now);
	}

	/** 关库前把内存里那些东西放掉。 */
	dispose(): void {
		this.loginIp.clear();
		this.loginAccount.clear();
		this.registerIp.clear();
		this.passwordUser.clear();
	}

	// ── 内部 ──────────────────────────────────

	/** 建会话并返回明文令牌。 */
	private createSession(userId: string, ctx: CloudRequestContext, native: boolean, now: number): string {
		const token = createToken();
		const { device, client } = describeClient(ctx.userAgent, native);
		const record: SessionRecord = {
			id: randomUUID(),
			userId,
			tokenHash: hashToken(token),
			device,
			client,
			ip: truncate(ctx.ip, 64),
			userAgent: truncate(ctx.userAgent, 300),
			createdAt: now,
			lastSeenAt: now,
			expiresAt: now + this.sessionMs,
			revokedAt: null,
		};
		this.db.insertSession(record);
		return token;
	}

	/** 账号不存在时也烧掉一次 scrypt 的时间。 */
	private async burnPasswordCheck(password: string): Promise<void> {
		if (!this.dummyHash) {
			this.dummyHash = hashPassword("dummy-" + randomBytes(8).toString("hex"));
		}
		await verifyPassword(password, await this.dummyHash);
	}

	/** 唯一索引冲突翻成人话。 */
	private translateConstraint(error: unknown): CloudError {
		const message = error instanceof Error ? error.message : String(error);
		if (/UNIQUE constraint failed:\s*users\.email/i.test(message)) return conflict("该邮箱已注册", "email_taken");
		if (/UNIQUE constraint failed:\s*users\.username/i.test(message)) return conflict("用户名已被占用", "username_taken");
		console.error("[cloud] 写入账号失败", message);
		return new CloudError(500, "创建账号失败", "create_failed");
	}

	/** 记一条审计。失败不抛：审计挂掉不该把业务请求也带崩。 */
	audit(action: string, detail: string, ip: string, actorId: string | null, userId: string | null): void {
		try {
			this.db.insertAudit({ at: this.now(), actorId, userId, action, detail, ip: truncate(ip, 64) });
		} catch (error) {
			console.error("[cloud] 写审计失败", error);
		}
	}
}
