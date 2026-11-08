/**
 * 管理员侧：账号列表、建号、改配额/角色/状态、重置密码、删号、统计、审计。
 *
 * 所有写操作都记审计。护栏放在这一层而不是路由层 —— 无论是 HTTP 调用还是
 * 以后加的命令行工具，都得过同一道闸。
 */
import { randomInt, randomUUID } from "node:crypto";
import type { AuthConfig } from "../../config/env.ts";
import type { AuthService } from "./auth.ts";
import type { CloudDb } from "./db.ts";
import { badRequest, conflict, forbidden, notFound } from "./errors.ts";
import { hashPassword } from "./password.ts";
import type {
	AdminUser,
	AuditView,
	AuthContext,
	CloudRequestContext,
	PublicUser,
	UsageProvider,
	UserRecord,
	UserRole,
	UserStatus,
} from "./types.ts";
import { publicUser } from "./types.ts";
import { assertPassword, normalizeDisplayName, normalizeEmail, normalizeUsername, readQuota } from "./validate.ts";

/** 临时密码用的字符集：去掉 0/O/1/l/I 这些认不出来的，方便念给用户。 */
const TEMP_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 临时密码长度。 */
const TEMP_LENGTH = 16;

/** 生成一次性密码。 */
export function generatePassword(length: number): string {
	const size = Math.max(8, Math.floor(length));
	let out = "";
	for (let index = 0; index < size; index += 1) {
		out += TEMP_ALPHABET.charAt(randomInt(0, TEMP_ALPHABET.length));
	}
	return out;
}

export interface AdminServiceOptions {
	auth: AuthService;
	db: CloudDb;
	config: AuthConfig;
	usage: UsageProvider;
	dataDir: string;
	onDeleteUser(userId: string): Promise<void>;
	now?: () => number;
}

/** 建号入参。已由路由层做过形状校验，这里再做语义校验。 */
export interface CreateUserInput {
	email: string;
	password?: string;
	username?: string;
	displayName?: string;
	role?: UserRole;
	quotaBytes?: number;
}

/** 改号入参。undefined 表示"这一项不动"。 */
export interface UpdateUserInput {
	role?: UserRole;
	status?: UserStatus;
	quotaBytes?: number;
	displayName?: string;
}

/** 管理统计。 */
export interface AdminStats {
	users: number;
	activeUsers: number;
	disabledUsers: number;
	totalUsedBytes: number;
	totalQuotaBytes: number;
	dataDir: string;
}

export class AdminService {
	private readonly auth: AuthService;
	private readonly db: CloudDb;
	private readonly config: AuthConfig;
	private readonly usage: UsageProvider;
	private readonly dataDir: string;
	private readonly onDeleteUser: (userId: string) => Promise<void>;
	private readonly now: () => number;

	constructor(options: AdminServiceOptions) {
		this.auth = options.auth;
		this.db = options.db;
		this.config = options.config;
		this.usage = options.usage;
		this.dataDir = options.dataDir;
		this.onDeleteUser = options.onDeleteUser;
		this.now = options.now ?? (() => Date.now());
	}

	/** 非管理员一律 403。 */
	requireAdmin(auth: AuthContext): void {
		if (auth.user.role !== "admin") throw forbidden("需要管理员权限");
	}

	/** 管理员列表。用量逐条问 UsageProvider，失败的按 0 显示，不让一个人把整页拖崩。 */
	async listUsers(search: string, offset: number, limit: number): Promise<{ users: AdminUser[]; total: number }> {
		const { users, total } = this.db.listUsers({ search, offset, limit });
		const now = this.now();
		const rows = await Promise.all(
			users.map(async (record) => {
				const usedBytes = await this.usedBytesOf(record.id);
				return this.toAdminUser(record, usedBytes, this.db.countActiveSessions(record.id, now));
			}),
		);
		return { users: rows, total };
	}

	async createUser(input: CreateUserInput, actor: AuthContext, ctx: CloudRequestContext): Promise<{ user: AdminUser; password?: string }> {
		const now = this.now();
		const email = normalizeEmail(input.email);
		const username = normalizeUsername(input.username);
		const displayName = normalizeDisplayName(input.displayName);
		const quotaBytes = readQuota(input.quotaBytes) ?? this.config.defaultQuotaBytes;
		const role: UserRole = input.role ?? "user";

		// 管理员手输密码时也得合规；没给就生成一个够长的。
		const generated = input.password === undefined || input.password.length === 0;
		const password = generated ? generatePassword(TEMP_LENGTH) : input.password ?? "";
		assertPassword(password, this.config.minPasswordLength);

		if (this.db.findUserByEmail(email)) throw conflict("该邮箱已注册", "email_taken");
		if (username && this.db.findUserByUsername(username)) throw conflict("用户名已被占用", "username_taken");

		const passwordHash = await hashPassword(password);
		const record: UserRecord = {
			id: randomUUID(),
			email,
			username,
			displayName: displayName && displayName.length > 0 ? displayName : username ?? email.split("@")[0] ?? email,
			passwordHash,
			role,
			status: "active",
			quotaBytes,
			createdAt: now,
			updatedAt: now,
			lastLoginAt: null,
			lastSeenAt: null,
		};
		try {
			this.db.insertUser(record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/users\.email/i.test(message)) throw conflict("该邮箱已注册", "email_taken");
			if (/users\.username/i.test(message)) throw conflict("用户名已被占用", "username_taken");
			console.error("[cloud] 管理员建号失败", message);
			throw new Error("创建账号失败");
		}
		this.audit("create_user", "创建账号 " + email + "（" + (role === "admin" ? "管理员" : "普通用户") + "，配额 " + String(quotaBytes) + "B）", actor, record.id, ctx);
		return { user: this.toAdminUser(record, 0, 0), ...(generated ? { password } : {}) };
	}

	async updateUser(id: string, input: UpdateUserInput, actor: AuthContext, ctx: CloudRequestContext): Promise<AdminUser> {
		const target = this.db.findUser(id);
		if (!target) throw notFound("账号不存在", "user_not_found");
		const role = input.role ?? target.role;
		const status = input.status ?? target.status;
		const displayName = normalizeDisplayName(input.displayName);
		const quotaBytes = readQuota(input.quotaBytes);

		// 自锁护栏：把自己降级或停用，等于把最后一个能救场的人关在门外。
		if (target.id === actor.user.id) {
			if (role !== target.role) throw badRequest("不能修改自己的角色", "self_guard");
			if (status !== target.status) throw badRequest("不能修改自己的状态", "self_guard");
		}
		// 最后一个可用管理员：降级、停用都不行（删号由 deleteUser 单独挡）。
		if (target.role === "admin" && target.status === "active" && (role !== "admin" || status !== "active")) {
			if (this.db.countActiveAdmins() <= 1) {
				throw badRequest("至少要保留一个可用的管理员", "last_admin");
			}
		}

		this.db.updateUser(target.id, {
			role: role === target.role ? undefined : role,
			status: status === target.status ? undefined : status,
			quotaBytes: quotaBytes === undefined || quotaBytes === target.quotaBytes ? undefined : quotaBytes,
			displayName: displayName === undefined || displayName.length === 0 || displayName === target.displayName ? undefined : displayName,
			updatedAt: this.now(),
		});
		if (quotaBytes !== undefined && quotaBytes !== target.quotaBytes) {
			// 配额变了，用量缓存里那个数字就旧了。
			this.usage.invalidate(target.id);
		}
		const changes: string[] = [];
		if (role !== target.role) changes.push("角色 " + target.role + " → " + role);
		if (status !== target.status) changes.push("状态 " + target.status + " → " + status);
		if (quotaBytes !== undefined && quotaBytes !== target.quotaBytes) {
			changes.push("配额 " + String(target.quotaBytes) + " → " + String(quotaBytes));
		}
		if (displayName !== undefined && displayName.length > 0 && displayName !== target.displayName) {
			changes.push("昵称 → " + displayName);
		}
		this.audit("update_user", "修改 " + target.email + "：" + (changes.length > 0 ? changes.join("，") : "无改动"), actor, target.id, ctx);

		const fresh = this.db.findUser(target.id) ?? target;
		return this.toAdminUser(fresh, await this.usedBytesOf(fresh.id), this.db.countActiveSessions(fresh.id, this.now()));
	}

	/** 重置密码：不传就生成一个并回传。所有旧会话立刻失效。 */
	async resetPassword(id: string, password: string | undefined, actor: AuthContext, ctx: CloudRequestContext): Promise<string> {
		const target = this.db.findUser(id);
		if (!target) throw notFound("账号不存在", "user_not_found");
		const generated = password === undefined || password.length === 0;
		const next = generated ? generatePassword(TEMP_LENGTH) : password ?? "";
		assertPassword(next, this.config.minPasswordLength);
		const now = this.now();
		this.db.updateUser(target.id, { passwordHash: await hashPassword(next), updatedAt: now });
		this.db.revokeUserSessions(target.id, now);
		this.audit("reset_password", "重置 " + target.email + " 的密码，已退出全部设备", actor, target.id, ctx);
		return next;
	}

	/**
	 * 删号。
	 *
	 * 顺序是有讲究的：先撤会话（立刻踢下线），再把库里的行删掉，
	 * 最后才让 WorkspaceManager 清目录 —— 目录清理可能慢，也可能失败，
	 * 但账号本身必须当场消失，否则就会出现"已删账号还能登录"的鬼状态。
	 */
	async deleteUser(id: string, actor: AuthContext, ctx: CloudRequestContext): Promise<void> {
		const target = this.db.findUser(id);
		if (!target) throw notFound("账号不存在", "user_not_found");
		if (target.id === actor.user.id) throw badRequest("不能删除自己的账号", "self_guard");
		if (target.role === "admin" && target.status === "active" && this.db.countActiveAdmins() <= 1) {
			throw badRequest("至少要保留一个可用的管理员", "last_admin");
		}

		this.db.deleteUserSessions(target.id);
		this.db.anonymizeAudit(target.id);
		this.db.deleteUser(target.id);
		this.audit("delete_user", "删除账号 " + target.email, actor, target.id, ctx);
		this.usage.invalidate(target.id);

		// 下面两步都不影响响应：数据行已经删了，目录晚一点清也不会有权限问题。
		try {
			await this.usage.dispose(target.id);
		} catch (error) {
			console.error("[cloud] 清理用量数据失败 " + target.email, error);
		}
		try {
			await this.onDeleteUser(target.id);
		} catch (error) {
			console.error("[cloud] 删除用户目录失败 " + target.email, error);
		}
	}

	/** 首页统计。总量把每个人问一遍，几十个用户量级足够快。 */
	async stats(): Promise<AdminStats> {
		const users = this.db.allUsers();
		const used = await Promise.all(users.map(async (user) => this.usedBytesOf(user.id)));
		let totalUsedBytes = 0;
		for (const bytes of used) totalUsedBytes += bytes;
		let totalQuotaBytes = 0;
		for (const user of users) {
			// 0 表示不限，加进"总容量"只会让这个数字失去意义。
			if (user.quotaBytes > 0) totalQuotaBytes += user.quotaBytes;
		}
		return {
			users: users.length,
			activeUsers: users.filter((user) => user.status === "active").length,
			disabledUsers: users.filter((user) => user.status === "disabled").length,
			totalUsedBytes,
			totalQuotaBytes,
			dataDir: this.dataDir,
		};
	}

	auditEntries(offset: number, limit: number): AuditView[] {
		return this.db.listAudit(offset, limit);
	}

	/** 审计总条数，列表分页要用。 */
	auditTotal(): number {
		return this.db.countAudit();
	}

	/** 简单包装：用量查失败按 0 —— 管理员不该因为某个目录读不了就打不开用户列表。 */
	private async usedBytesOf(userId: string): Promise<number> {
		try {
			const usage = await this.usage.usageOf(userId);
			return Math.max(0, Math.floor(usage.usedBytes));
		} catch (error) {
			console.error("[cloud] 读取用量失败 " + userId, error);
			return 0;
		}
	}

	private toAdminUser(record: UserRecord, usedBytes: number, sessionCount: number): AdminUser {
		const base: PublicUser = publicUser(record);
		return { ...base, usedBytes, lastSeenAt: record.lastSeenAt, sessionCount };
	}

	private audit(action: string, detail: string, actor: AuthContext, userId: string | null, ctx: CloudRequestContext): void {
		this.auth.audit(action, detail, ctx.ip, actor.user.id, userId);
	}
}
