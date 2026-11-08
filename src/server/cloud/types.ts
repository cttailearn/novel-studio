/**
 * 云端账号模块的对外类型。
 *
 * 这些形状是 app.ts、前端与测试共用的契约：库里怎么存（db.ts）不外泄，
 * 出了这一层的一律是 PublicUser / Usage 这类"能给客户端看"的形状。
 * 密码散列、令牌散列这类东西永远不进 PublicUser。
 */
import type { ApiRequest, ApiSink } from "../api-router.ts";

/** 账号角色。 */
export type UserRole = "admin" | "user";

/** 账号状态。停用后 authenticate 一律返回 null。 */
export type UserStatus = "active" | "disabled";

/** 云端容量明细。单位一律是字节。 */
export interface UsageBreakdown {
	/** 所有作品目录。 */
	projects: number;
	/** 通用素材库。 */
	library: number;
	/** 拆解库（novel 原料）。 */
	sources: number;
	/** 生成记录。 */
	records: number;
	/** 设置与凭据。 */
	settings: number;
	/** 其余文件。 */
	other: number;
}

/** 一个用户的云端用量。与 docs/cloud-saas-plan.md 第 4.1 节一致。 */
export interface Usage {
	usedBytes: number;
	/** 0 表示不限。 */
	quotaBytes: number;
	breakdown: UsageBreakdown;
	updatedAt: number;
}

/**
 * 用量的来源。
 *
 * 实现由调用方（app.ts 的 WorkspaceManager）提供 —— 账号模块只知道"问谁要用量"，
 * 不知道目录怎么扫。
 */
export interface UsageProvider {
	usageOf(userId: string): Promise<Usage>;
	invalidate(userId: string): void;
	dispose(userId: string): Promise<void>;
}

/** 能安全交给客户端的用户字段。 */
export interface PublicUser {
	id: string;
	email: string;
	username: string | null;
	displayName: string;
	role: UserRole;
	status: UserStatus;
	/** 0 表示不限。 */
	quotaBytes: number;
	createdAt: number;
	lastLoginAt: number | null;
}

/** 管理员列表里多出来的几项。 */
export interface AdminUser extends PublicUser {
	usedBytes: number;
	lastSeenAt: number | null;
	sessionCount: number;
}

/** 一次请求通过鉴权之后的上下文。 */
export interface AuthContext {
	user: PublicUser;
	sessionId: string;
	/** 本次使用的令牌（不下发，只用于比对与续期）。 */
	token: string;
	/** 续期之后的失效时刻（毫秒）。 */
	expiresAt: number;
}

/**
 * 一次账号请求的传输层信息。
 *
 * ip 与 secure 由 app.ts 从连接与反代头里算好再递进来 ——
 * 这一层不解析 X-Forwarded-*，免得两处各算一遍还算得不一样。
 */
export interface CloudRequestContext {
	ip: string;
	/** 这条连接是不是 HTTPS（决定 Cookie 要不要带 Secure）。 */
	secure: boolean;
	/** 本站源，形如 https://example.com；空串表示算不出来，此时跳过 CSRF 同源校验。 */
	origin?: string;
	userAgent: string;
}

/** 账号模块要用、但不由它实现的两件事。 */
export interface CloudDeps {
	/** 用量查询（WorkspaceManager）。 */
	usage: UsageProvider;
	/** 删除账号之后收尾：关工作区、清目录。失败只记日志，不影响 204。 */
	onDeleteUser(userId: string): Promise<void>;
}

/** 云端账号服务。app.ts 拿到它之后只在 storage="users" 时使用。 */
export interface CloudServices {
	/** 目前只有云端多账号这一种形态。 */
	readonly mode: "users";
	/** 接管 /api/auth/*、/api/account/*、/api/admin/*；其余路径返回 false。 */
	handle(req: ApiRequest, sink: ApiSink, ctx: CloudRequestContext): Promise<boolean>;
	/** 解出头像（Bearer 或 Cookie）。无效一律 null。 */
	authenticate(req: ApiRequest, ctx: CloudRequestContext): Promise<AuthContext | null>;
	/** 关库。重复调用无副作用。 */
	close(): void;
}

// ───────────────────────────────────────────── 库表行
//
// 以下是 db.ts 的读写形状，纯内部使用。字段名用 camelCase，
// 库里那套 snake_case 只在 db.ts 的 SQL 里出现。

export interface UserRecord {
	id: string;
	email: string;
	username: string | null;
	displayName: string;
	passwordHash: string;
	role: UserRole;
	status: UserStatus;
	quotaBytes: number;
	createdAt: number;
	updatedAt: number;
	lastLoginAt: number | null;
	lastSeenAt: number | null;
}

export interface SessionRecord {
	id: string;
	userId: string;
	tokenHash: string;
	device: string;
	client: string;
	ip: string;
	userAgent: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
	revokedAt: number | null;
}

export interface AuditRecord {
	id: number;
	at: number;
	actorId: string | null;
	userId: string | null;
	action: string;
	detail: string;
	ip: string;
}

/** 审计行 + 关联账号邮箱（账号删了就为 null）。 */
export interface AuditView extends AuditRecord {
	userEmail: string | null;
}

/** 把库里的行投影成能给客户端看的那一份。 */
export function publicUser(record: UserRecord): PublicUser {
	return {
		id: record.id,
		email: record.email,
		username: record.username,
		displayName: record.displayName,
		role: record.role,
		status: record.status,
		quotaBytes: record.quotaBytes,
		createdAt: record.createdAt,
		lastLoginAt: record.lastLoginAt,
	};
}
