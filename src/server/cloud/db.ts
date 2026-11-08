/**
 * 云端账号库：`<DATA_DIR>/cloud.db`（node:sqlite 的 DatabaseSync）。
 *
 * 只有三种东西进这个库：账号、会话、审计。作品、素材、设置一律在
 * `DATA_DIR/users/<id>/` 里，与单机模式的目录完全同构 —— 库本身不存内容。
 *
 * 这一层不做业务判断（谁能改谁、要不要限流），只负责把 SQL 包成
 * 几组说人话的方法。所有时间戳都是毫秒整数。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
	AuditRecord,
	AuditView,
	SessionRecord,
	UserRecord,
	UserRole,
	UserStatus,
} from "./types.ts";

/**
 * 表结构。与 docs/cloud-saas-plan.md 第 5 节一致。
 *
 * `IF NOT EXISTS` 让老库直接升级：以后加列也走这里补 ALTER。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE COLLATE NOCASE,
	username TEXT UNIQUE COLLATE NOCASE,
	display_name TEXT NOT NULL DEFAULT '',
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'user',
	status TEXT NOT NULL DEFAULT 'active',
	quota_bytes INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	last_login_at INTEGER,
	last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	device TEXT NOT NULL DEFAULT '',
	client TEXT NOT NULL DEFAULT '',
	ip TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	actor_id TEXT,
	user_id TEXT,
	action TEXT NOT NULL,
	detail TEXT NOT NULL DEFAULT '',
	ip TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
`;

// ───────────────────────────────────────────── 行 → 记录

/**
 * `noUncheckedIndexedAccess` 下每一列都是 unknown，所以取值一律走这几个小函数。
 * 库里不可能出现的类型（数组、blob）按空值处理，不让一行坏数据把整页打崩。
 */
function text(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : "";
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
	const value = row[key];
	return typeof value === "string" ? value : null;
}

function integer(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	if (typeof value === "number") return Math.trunc(value);
	if (typeof value === "bigint") return Number(value);
	return 0;
}

function nullableInteger(row: Record<string, unknown>, key: string): number | null {
	const value = row[key];
	if (typeof value === "number") return Math.trunc(value);
	if (typeof value === "bigint") return Number(value);
	return null;
}

function roleOf(row: Record<string, unknown>): UserRole {
	return text(row, "role") === "admin" ? "admin" : "user";
}

function statusOf(row: Record<string, unknown>): UserStatus {
	return text(row, "status") === "disabled" ? "disabled" : "active";
}

function toUser(row: Record<string, unknown>): UserRecord {
	return {
		id: text(row, "id"),
		email: text(row, "email"),
		username: nullableText(row, "username"),
		displayName: text(row, "display_name"),
		passwordHash: text(row, "password_hash"),
		role: roleOf(row),
		status: statusOf(row),
		quotaBytes: integer(row, "quota_bytes"),
		createdAt: integer(row, "created_at"),
		updatedAt: integer(row, "updated_at"),
		lastLoginAt: nullableInteger(row, "last_login_at"),
		lastSeenAt: nullableInteger(row, "last_seen_at"),
	};
}

function toSession(row: Record<string, unknown>): SessionRecord {
	return {
		id: text(row, "id"),
		userId: text(row, "user_id"),
		tokenHash: text(row, "token_hash"),
		device: text(row, "device"),
		client: text(row, "client"),
		ip: text(row, "ip"),
		userAgent: text(row, "user_agent"),
		createdAt: integer(row, "created_at"),
		lastSeenAt: integer(row, "last_seen_at"),
		expiresAt: integer(row, "expires_at"),
		revokedAt: nullableInteger(row, "revoked_at"),
	};
}

function toAudit(row: Record<string, unknown>): AuditRecord {
	return {
		id: integer(row, "id"),
		at: integer(row, "at"),
		actorId: nullableText(row, "actor_id"),
		userId: nullableText(row, "user_id"),
		action: text(row, "action"),
		detail: text(row, "detail"),
		ip: text(row, "ip"),
	};
}

// ───────────────────────────────────────────── 更新载荷

/** 更新账号时可改的字段。没给的字段不动。 */
export interface UserPatch {
	displayName?: string;
	username?: string | null;
	role?: UserRole;
	status?: UserStatus;
	quotaBytes?: number;
	passwordHash?: string;
	lastLoginAt?: number;
	lastSeenAt?: number;
	updatedAt: number;
}

/** 列表查询的筛选与分页。 */
export interface UserQuery {
	search: string;
	offset: number;
	limit: number;
}

/** 审计列表的一行。 */
export interface AuditEntry {
	at: number;
	actorId: string | null;
	userId: string | null;
	action: string;
	detail: string;
	ip: string;
}

// ───────────────────────────────────────────── 库

export class CloudDb {
	private readonly db: DatabaseSync;
	/** 预编译语句缓存。SQL 是有限几种，缓存住省下每请求一次的解析。 */
	private readonly statements = new Map<string, StatementSync>();
	private closed = false;

	private constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** 打开（必要时创建）账号库。目录不存在就先建。 */
	static open(dataDir: string): CloudDb {
		mkdirSync(dataDir, { recursive: true });
		const db = new DatabaseSync(path.join(dataDir, "cloud.db"));
		// WAL 让"读用量/写审计"这类并发不至于互相顶住；busy_timeout 让偶发争用等一等而不是直接报错。
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(SCHEMA);
		return new CloudDb(db);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.statements.clear();
		this.db.close();
	}

	private stmt(sql: string): StatementSync {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	// ── 账号 ────────────────────────────────────

	findUser(id: string): UserRecord | undefined {
		const row = this.stmt("SELECT * FROM users WHERE id = ?").get(id);
		return row ? toUser(row) : undefined;
	}

	/** 按邮箱找（邮箱在写入前已小写化）。 */
	findUserByEmail(email: string): UserRecord | undefined {
		const row = this.stmt("SELECT * FROM users WHERE email = ?").get(email);
		return row ? toUser(row) : undefined;
	}

	/** 按用户名找（大小写不敏感，靠列的 COLLATE NOCASE）。 */
	findUserByUsername(username: string): UserRecord | undefined {
		const row = this.stmt("SELECT * FROM users WHERE username = ?").get(username);
		return row ? toUser(row) : undefined;
	}

	/**
	 * 按邮箱或用户名找：登录框只给一个输入框。
	 * 邮箱列里存的是小写，所以调用方要把邮箱那半转小写再传；用户名靠 NOCASE。
	 */
	findUserByLogin(account: string, emailLower: string): UserRecord | undefined {
		const row = this.stmt("SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1").get(emailLower, account);
		return row ? toUser(row) : undefined;
	}

	countUsers(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM users").get();
		return row ? integer(row, "n") : 0;
	}

	/** 库里的管理员总数（含停用的）—— 判断"首个用户要不要当管理员"用它。 */
	countAdmins(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
		return row ? integer(row, "n") : 0;
	}

	/** 还能用的管理员数。降级/停用/删号前的护栏看它。 */
	countActiveAdmins(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get();
		return row ? integer(row, "n") : 0;
	}

	countUsersByStatus(status: UserStatus): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM users WHERE status = ?").get(status);
		return row ? integer(row, "n") : 0;
	}

	insertUser(record: UserRecord): void {
		this.stmt(
			`INSERT INTO users (
				id, email, username, display_name, password_hash, role, status,
				quota_bytes, created_at, updated_at, last_login_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			record.id,
			record.email,
			record.username,
			record.displayName,
			record.passwordHash,
			record.role,
			record.status,
			record.quotaBytes,
			record.createdAt,
			record.updatedAt,
			record.lastLoginAt,
			record.lastSeenAt,
		);
	}

	updateUser(id: string, patch: UserPatch): void {
		const columns: string[] = ["updated_at = ?"];
		const params: (string | number | null)[] = [patch.updatedAt];
		const push = (column: string, value: string | number | null | undefined): void => {
			if (value === undefined) return;
			columns.push(column + " = ?");
			params.push(value);
		};
		push("display_name", patch.displayName);
		push("username", patch.username);
		push("role", patch.role);
		push("status", patch.status);
		push("quota_bytes", patch.quotaBytes);
		push("password_hash", patch.passwordHash);
		push("last_login_at", patch.lastLoginAt);
		push("last_seen_at", patch.lastSeenAt);
		params.push(id);
		this.stmt("UPDATE users SET " + columns.join(", ") + " WHERE id = ?").run(...params);
	}

	/** 全部账号，管理员的统计页与用户目录清理用。 */
	allUsers(): UserRecord[] {
		return this.stmt("SELECT * FROM users ORDER BY created_at ASC").all().map(toUser);
	}

	/**
	 * 管理页的用户列表。
	 *
	 * 搜索只对邮箱、用户名、昵称做 LIKE；`COLLATE NOCASE` 让拉丁字母不分大小写，
	 * 中文本来就无大小写。
	 */
	listUsers(query: UserQuery): { users: UserRecord[]; total: number } {
		const search = query.search.trim();
		const like = "%" + search.replace(/[%_]/g, (match) => "\\" + match) + "%";
		const where = search
			? " WHERE email LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'"
			: "";
		const filters = search ? [like, like, like] : [];
		const totalRow = this.stmt("SELECT COUNT(*) AS n FROM users" + where).get(...filters);
		const rows = this.stmt(
			"SELECT * FROM users" + where + " ORDER BY created_at ASC LIMIT ? OFFSET ?",
		).all(...filters, query.limit, query.offset);
		return { users: rows.map(toUser), total: totalRow ? integer(totalRow, "n") : 0 };
	}

	deleteUser(id: string): void {
		this.stmt("DELETE FROM users WHERE id = ?").run(id);
	}

	// ── 会话 ────────────────────────────────────

	insertSession(record: SessionRecord): void {
		this.stmt(
			`INSERT INTO sessions (
				id, user_id, token_hash, device, client, ip, user_agent,
				created_at, last_seen_at, expires_at, revoked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			record.id,
			record.userId,
			record.tokenHash,
			record.device,
			record.client,
			record.ip,
			record.userAgent,
			record.createdAt,
			record.lastSeenAt,
			record.expiresAt,
			record.revokedAt,
		);
	}

	findSession(id: string): SessionRecord | undefined {
		const row = this.stmt("SELECT * FROM sessions WHERE id = ?").get(id);
		return row ? toSession(row) : undefined;
	}

	findSessionByTokenHash(tokenHash: string): SessionRecord | undefined {
		const row = this.stmt("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash);
		return row ? toSession(row) : undefined;
	}

	listSessions(userId: string): SessionRecord[] {
		return this.stmt("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC").all(userId).map(toSession);
	}

	/** 滑动续期：只动这一行的时间戳。 */
	touchSession(id: string, lastSeenAt: number, expiresAt: number): void {
		this.stmt("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(lastSeenAt, expiresAt, id);
	}

	/** 撤销一条会话。返回受影响行数，用来区分"撤销了"与"本来就不存在"。 */
	revokeSession(id: string, at: number): number {
		const result = this.stmt("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
		return Number(result.changes);
	}

	/** 撤销一个用户的全部会话；exceptId 留着"当前这一条"。 */
	revokeUserSessions(userId: string, at: number, exceptId?: string): void {
		if (exceptId) {
			this.stmt(
				"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?",
			).run(at, userId, exceptId);
			return;
		}
		this.stmt("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(at, userId);
	}

	deleteUserSessions(userId: string): void {
		this.stmt("DELETE FROM sessions WHERE user_id = ?").run(userId);
	}

	/** 这个用户还有几条能用的会话（列表里那个 sessionCount）。 */
	countActiveSessions(userId: string, now: number): number {
		const row = this.stmt(
			"SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?",
		).get(userId, now);
		return row ? integer(row, "n") : 0;
	}

	/**
	 * 清掉早已作废的会话行。
	 *
	 * 只删"过期/撤销超过 graceMs"的：留一小段时间是为了让"我的设备"列表
	 * 还能显示刚刚过期的那一条，不至于刷新一下就不见了。
	 */
	purgeSessions(before: number): number {
		const result = this.stmt(
			"DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)",
		).run(before, before);
		return Number(result.changes);
	}

	// ── 审计 ────────────────────────────────────

	insertAudit(entry: AuditEntry): void {
		this.stmt(
			"INSERT INTO audit (at, actor_id, user_id, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)",
		).run(entry.at, entry.actorId, entry.userId, entry.action, entry.detail, entry.ip);
	}

	listAudit(offset: number, limit: number): AuditView[] {
		// 账号删了，审计行还留着（"谁在什么时候删了谁"本身就是要留的证据），
		// 但 user_id 已置空，这里 LEFT JOIN 只是为了让还在的账号带上邮箱。
		const rows = this.stmt(
			`SELECT audit.*, users.email AS user_email
			 FROM audit LEFT JOIN users ON users.id = audit.user_id
			 ORDER BY audit.at DESC, audit.id DESC
			 LIMIT ? OFFSET ?`,
		).all(limit, offset);
		return rows.map((row) => {
			const entry = toAudit(row);
			const email = nullableText(row, "user_email");
			return { ...entry, userEmail: email };
		});
	}

	countAudit(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM audit").get();
		return row ? integer(row, "n") : 0;
	}

	/**
	 * 删号时把审计里的关联抹掉。
	 *
	 * 行不删：管理员需要一个"某账号曾被删过"的痕迹；但 id 不再指向任何人，
	 * 也就没法借审计库反推出已删账号的信息。
	 */
	anonymizeAudit(userId: string): void {
		this.stmt("UPDATE audit SET user_id = NULL, actor_id = NULL WHERE user_id = ? OR actor_id = ?").run(
			userId,
			userId,
		);
	}

	// ── meta ────────────────────────────────────

	readMeta(key: string): string | undefined {
		const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key);
		return row ? text(row, "value") : undefined;
	}

	writeMeta(key: string, value: string): void {
		this.stmt(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run(key, value);
	}
}
