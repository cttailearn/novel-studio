/**
 * 请求体取值与字段校验。
 *
 * `req.json<unknown>()` 回来的东西不能直接当对象用 —— 客户端完全可能发数组、
 * 发字符串、把字段写成数字。这里把"取值"和"报错文案"收在一处，
 * 上层（auth.ts / admin.ts）只拿到已经收窄好的值。
 */
import { badRequest } from "./errors.ts";

/** 一个 JSON 对象。 */
export type JsonObject = Record<string, unknown>;

/** 邮箱长度上界。RFC 5321 的 254 是常见上限。 */
const MAX_EMAIL_LENGTH = 254;

/** 昵称长度上界。 */
const MAX_DISPLAY_NAME = 40;

/** 用户名长度上下界。 */
const USERNAME_MIN = 2;
const USERNAME_MAX = 32;

/** 密码长度上界（字符）。scrypt 对超长输入不友好，先挡住。 */
const MAX_PASSWORD_LENGTH = 200;

/** 邮箱格式：本地部@域名，域名至少要有一个点，且不允许空白。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** 用户名：字母、数字、下划线、点、连字符、汉字；不含空白与 @。 */
const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u;

/** 收窄成对象；不是对象就 400。 */
export function asObject(value: unknown): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw badRequest("请求体必须是 JSON 对象");
	}
	return value as JsonObject;
}

/** 必填字符串。 */
export function requiredString(body: JsonObject, key: string, label: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw badRequest("缺少 " + label);
	}
	return value;
}

/** 可选字符串：字段不存在返回 undefined；存在但不是字符串 → 400。 */
export function optionalString(body: JsonObject, key: string, label: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (value === null) return "";
	if (typeof value !== "string") throw badRequest(label + " 必须是字符串");
	return value;
}

/** 可选数字：字段不存在返回 undefined；存在但不是有限数 → 400。 */
export function optionalNumber(body: JsonObject, key: string, label: string): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw badRequest(label + " 必须是数字");
	return value;
}

/**
 * 归一化邮箱：去空白、转小写。
 *
 * 大小写不敏感是刻意的 —— 邮箱域名本来就大小写不敏感，而现实里同一个人的
 * 邮箱在不同键盘上大小写不一样，统一小写能少一批"重复注册"。
 */
export function normalizeEmail(raw: string): string {
	const email = raw.trim().toLowerCase();
	if (email.length === 0) throw badRequest("请输入邮箱");
	if (email.length > MAX_EMAIL_LENGTH) throw badRequest("邮箱太长了");
	if (!EMAIL_PATTERN.test(email)) throw badRequest("邮箱格式不正确");
	return email;
}

/** 归一化用户名：空串/未填 → null。返回 null 表示"不使用用户名"。 */
export function normalizeUsername(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	const username = raw.trim();
	if (username.length === 0) return null;
	if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
		throw badRequest("用户名需为 " + String(USERNAME_MIN) + "–" + String(USERNAME_MAX) + " 个字符");
	}
	if (!USERNAME_PATTERN.test(username)) {
		throw badRequest("用户名只能包含字母、数字、下划线、点和连字符");
	}
	return username;
}

/** 校验密码长度，并做上限保护。 */
export function assertPassword(password: string, minLength: number): void {
	if (password.length < minLength) {
		throw badRequest("密码至少 " + String(minLength) + " 位");
	}
	if (password.length > MAX_PASSWORD_LENGTH) {
		throw badRequest("密码最多 " + String(MAX_PASSWORD_LENGTH) + " 位");
	}
}

/** 归一化昵称：去空白；空串回落到默认值由调用方决定。 */
export function normalizeDisplayName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const name = raw.trim();
	if (name.length > MAX_DISPLAY_NAME) throw badRequest("昵称最多 " + String(MAX_DISPLAY_NAME) + " 个字");
	return name;
}

/** 角色取值校验。空值当作"不改"。 */
export function readRole(raw: string | undefined): "admin" | "user" | undefined {
	if (raw === undefined || raw.length === 0) return undefined;
	if (raw === "admin" || raw === "user") return raw;
	throw badRequest("角色只能是 admin 或 user");
}

/** 状态取值校验。空值当作"不改"。 */
export function readStatus(raw: string | undefined): "active" | "disabled" | undefined {
	if (raw === undefined || raw.length === 0) return undefined;
	if (raw === "active" || raw === "disabled") return raw;
	throw badRequest("状态只能是 active 或 disabled");
}

/** 配额：整数、>= 0；0 表示不限。 */
export function readQuota(raw: number | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (!Number.isSafeInteger(raw) || raw < 0) throw badRequest("配额必须是非负整数");
	return raw;
}

/** 分页参数：负数按 0、超出上限按上限，避免一次拉几万行。 */
export function readPage(searchParams: URLSearchParams): { offset: number; limit: number } {
	const rawOffset = Number(searchParams.get("offset") ?? "0");
	const rawLimit = Number(searchParams.get("limit") ?? "50");
	const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 50;
	return { offset, limit };
}
