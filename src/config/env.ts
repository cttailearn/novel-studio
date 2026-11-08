import { existsSync } from "node:fs";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RelayConfig } from "../server/llm-relay.ts";

/** 解析 .env 到 process.env。文件不存在时静默跳过。 */
export function loadEnvFile(): void {
	const file = process.env.NOVEL_STUDIO_ENV_FILE ?? path.resolve(process.cwd(), ".env");
	if (!existsSync(file)) return;
	try {
		process.loadEnvFile(file);
	} catch (error) {
		console.warn(`[config] 读取 ${file} 失败，忽略 `, error);
	}
}

export interface AppConfig {
	port: number;
	host: string;
	dataDir: string;
	/** "provider/modelId"；为空表示由设置页或前端选择。 */
	defaultModel: string;
	defaultThinkingLevel: ThinkingLevel;
	/**
	 * 存储模式：
	 * - "fs"：单机自用模式，所有数据落 data/（默认，保留原有行为）。
	 * - "idb"：多用户模式，服务端不再持有用户数据；页面在浏览器里用 IndexedDB 存，
	 *   服务端只做静态托管与无状态 LLM 中继。
	 * - "users"：云端账号模式，数据落 data/users/<userId>/，带登录、注册与配额。
	 */
	storage: StorageMode;
	/**
	 * 中继允许的浏览器直连来源（逗号分隔）。留空表示只允许同源。
	 * 在 storage="idb" 或 "users" 时用于跨域客户端（含 Tauri）。
	 */
	corsOrigins: string[];
	/**
	 * 无状态 LLM 中继的上限与信任清单。
	 *
	 * allowedHosts 留空 = 允许任何"公开 https 主机"。
	 * **部署时应当写具体厂商主机名清单**，留空等于把服务器变成任意跳板。
	 */
	relay: RelayConfig;
	/** 云端账号模式的认证配置。单机模式读取但不使用。 */
	auth: AuthConfig;
}

/** 存储模式：fs = 服务端落盘（单机自用）；idb = 数据只留浏览器；users = 云端多账号。 */
export type StorageMode = "fs" | "idb" | "users";

/** 注册策略：open 开放注册；closed 只允许管理员建号。 */
export type RegistrationMode = "open" | "closed";

export interface AuthConfig {
	/** 是否开放注册。 */
	registration: RegistrationMode;
	/** 新用户默认配额（字节）；0 = 不限。 */
	defaultQuotaBytes: number;
	/** 注册人数上限；0 = 不限。 */
	maxUsers: number;
	/** 会话有效期（天），滑动续期。 */
	sessionDays: number;
	/** Cookie 的 Secure 策略：auto 按请求协议决定。 */
	cookieSecure: "auto" | "always" | "never";
	/** 是否信任 X-Forwarded-For / X-Forwarded-Proto（反代后面设为 1）。 */
	trustProxy: boolean;
	/** 首次启动播种的管理员邮箱。 */
	adminEmail: string;
	/** 首次启动播种的管理员密码（仅建号时用，不会写日志）。 */
	adminPassword: string;
	/** 没有管理员时，第一个注册用户成为管理员。 */
	firstUserAdmin: boolean;
	/** 密码最短长度。 */
	minPasswordLength: number;
	/** 登录页/标题展示名。 */
	appName: string;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function num(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function bool(value: string | undefined, fallback = false): boolean {
	const trimmed = (value ?? "").trim().toLowerCase();
	if (trimmed === "") return fallback;
	return trimmed === "1" || trimmed === "true" || trimmed === "yes" || trimmed === "on";
}

/** 读 STORAGE 环境变量；只认 "fs" / "idb" / "users"，其余一律回落到 fs。 */
export function readStorageMode(value: string | undefined = process.env.STORAGE): StorageMode {
	const mode = (value ?? "").trim().toLowerCase();
	if (mode === "idb") return "idb";
	if (mode === "users") return "users";
	return "fs";
}

/** 读 CORS 白名单（逗号分隔的来源）。空串表示「只允许同源」。 */
export function readCorsOrigins(value: string | undefined = process.env.CORS_ORIGINS): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** 读注册策略；未知值按 open 处理，避免部署时误把注册关死。 */
export function readRegistrationMode(value: string | undefined = process.env.REGISTRATION): RegistrationMode {
	return (value ?? "").trim().toLowerCase() === "closed" ? "closed" : "open";
}

/** 读认证配置。默认值面向"自建服务器、小范围使用"。 */
export function readAuthConfig(): AuthConfig {
	const quotaMb = num(process.env.DEFAULT_QUOTA_MB);
	const cookie = (process.env.COOKIE_SECURE ?? "").trim().toLowerCase();
	return {
		registration: readRegistrationMode(),
		defaultQuotaBytes: quotaMb === undefined ? 1024 * 1024 * 1024 : Math.max(0, Math.floor(quotaMb * 1024 * 1024)),
		maxUsers: Math.max(0, Math.floor(num(process.env.MAX_USERS) ?? 0)),
		sessionDays: Math.max(1, Math.floor(num(process.env.SESSION_DAYS) ?? 30)),
		cookieSecure: cookie === "always" || cookie === "never" ? cookie : "auto",
		trustProxy: bool(process.env.TRUST_PROXY),
		adminEmail: process.env.ADMIN_EMAIL?.trim() ?? "",
		adminPassword: process.env.ADMIN_PASSWORD ?? "",
		firstUserAdmin: bool(process.env.FIRST_USER_ADMIN, true),
		minPasswordLength: Math.max(6, Math.floor(num(process.env.PASSWORD_MIN_LENGTH) ?? 8)),
		appName: process.env.APP_NAME?.trim() || "墨耕",
	};
}

/**
 * 读中继配置。
 * `RELAY_ALLOWED_HOSTS` 留空 = 允许任何公开 https 主机。
 * **部署时应当写具体厂商主机名清单**，留空等于把服务器变成任意人的跳板
 * （别人的请求可以借你的服务器去访问它能访问的任何公网地址）。
 */
export function readRelayConfig(value: string | undefined = process.env.RELAY_ALLOWED_HOSTS): RelayConfig {
	const allowedHosts = (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return {
		allowedHosts,
		maxRequestBytes: num(process.env.RELAY_MAX_REQUEST_BYTES) ?? 8 * 1024 * 1024,
		requestsPerMinute: num(process.env.RELAY_REQUESTS_PER_MINUTE) ?? 60,
		maxInflight: num(process.env.RELAY_MAX_INFLIGHT) ?? 16,
		timeoutMs: num(process.env.RELAY_TIMEOUT_MS) ?? 180_000,
		maxResponseBytes: num(process.env.RELAY_MAX_RESPONSE_BYTES) ?? 64 * 1024 * 1024,
		allowedOrigin: readCorsOrigins()[0] ?? "*",
	};
}

export function readConfig(): AppConfig {
	const thinking = (process.env.DEFAULT_THINKING_LEVEL ?? "off").trim() as ThinkingLevel;
	const storage = readStorageMode();
	// 多用户/云端模式是要放到公网上的，默认只听回环等于谁都连不上；
	// 但显式设了 HOST 就以设置为准。
	const host = process.env.HOST?.trim() || (storage === "fs" ? "127.0.0.1" : "0.0.0.0");
	return {
		port: num(process.env.PORT) ?? 8787,
		host,
		dataDir: path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || "./data"),
		defaultModel: process.env.DEFAULT_MODEL?.trim() || "",
		defaultThinkingLevel: THINKING_LEVELS.includes(thinking) ? thinking : "off",
		storage,
		corsOrigins: readCorsOrigins(),
		relay: readRelayConfig(),
		auth: readAuthConfig(),
	};
}
