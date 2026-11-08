/**
 * 会话令牌与 Cookie 的机械部分：造令牌、算散列、拼 Set-Cookie、
 * 读 Authorization、判断原生客户端、比较同源。
 *
 * 这里全是纯函数，不碰库也不碰业务 —— 方便 auth.ts 与测试各自复用。
 */
import { createHash, randomBytes } from "node:crypto";
import type { ApiRequest } from "../api-router.ts";

/** 会话 Cookie 名。与 docs/cloud-saas-plan.md、前端保持同一份。 */
export const SESSION_COOKIE = "ns_session";

/** 原生客户端（Tauri）用这个头声明自己，好让服务端把 token 塞进响应体。 */
export const NATIVE_CLIENT_HEADER = "x-novel-client";

/** 令牌字节数：32 字节 → 43 个 base64url 字符。 */
const TOKEN_BYTES = 32;

/** 造一个新令牌。库里只存它的 sha256，明文只在这一次响应里出现。 */
export function createToken(): string {
	return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 令牌的库内表示。 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 取一个请求头，多值时按逗号拼起来（这类头一般不会重复）。 */
export function headerValue(req: ApiRequest, name: string): string {
	const raw = req.headers[name.toLowerCase()];
	if (raw === undefined) return "";
	const value = Array.isArray(raw) ? raw.join(", ") : raw;
	return typeof value === "string" ? value.trim() : "";
}

/** 解 `Authorization: Bearer <token>`。没有或不合法时返回空串。 */
export function bearerToken(req: ApiRequest): string {
	const header = headerValue(req, "authorization");
	if (!header) return "";
	const match = /^Bearer[ \t]+(\S+)$/i.exec(header);
	return match?.[1] ?? "";
}

/** 解 `Cookie` 头。同名取第一个。 */
export function parseCookies(req: ApiRequest): Record<string, string> {
	const header = headerValue(req, "cookie");
	const cookies: Record<string, string> = {};
	if (!header) return cookies;
	for (const piece of header.split(";")) {
		const index = piece.indexOf("=");
		if (index <= 0) continue;
		const name = piece.slice(0, index).trim();
		if (!name || name in cookies) continue;
		const value = piece.slice(index + 1).trim();
		// 值里不该有引号；真带了就按原样留着，反正之后还会被 sha256 判死。
		cookies[name] = value;
	}
	return cookies;
}

/** Cookie 里的会话令牌。 */
export function cookieToken(req: ApiRequest): string {
	return parseCookies(req)[SESSION_COOKIE] ?? "";
}

/** 是不是原生客户端发的请求。 */
export function isNativeClient(req: ApiRequest): boolean {
	return headerValue(req, NATIVE_CLIENT_HEADER).toLowerCase() === "native";
}

/** 拼会话 Cookie。`secure` 为真时加 Secure（COOKIE_SECURE=auto 且 HTTPS 时）。 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
	const parts = [
		SESSION_COOKIE + "=" + token,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=" + String(Math.max(0, Math.floor(maxAgeSeconds))),
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/** 清 Cookie：同名、Max-Age=0。 */
export function clearedCookie(secure: boolean): string {
	const parts = [SESSION_COOKIE + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * 两个源是否同一个。
 *
 * 用 URL 解析后比 `origin`：这样大小写、默认端口（https 的 :443）都不会
 * 造成误判。解析不了的一律 false —— CSRF 校验宁可拒。
 */
export function sameOrigin(a: string, b: string): boolean {
	if (!a || !b) return false;
	let left: URL;
	let right: URL;
	try {
		left = new URL(a);
		right = new URL(b);
	} catch {
		return false;
	}
	if (left.protocol !== "http:" && left.protocol !== "https:") return false;
	if (right.protocol !== "http:" && right.protocol !== "https:") return false;
	return left.origin === right.origin;
}

/** 从 User-Agent 猜出"设备"与"客户端"，只是给会话列表看的，猜错也无害。 */
export function describeClient(userAgent: string, native: boolean): { device: string; client: string } {
	const ua = userAgent.trim();
	if (!ua) return { device: native ? "原生客户端" : "未知设备", client: native ? "native" : "web" };
	const device = describeDevice(ua);
	return { device, client: native ? "native" : "web" };
}

function describeDevice(ua: string): string {
	const os = /Windows NT/i.test(ua)
		? "Windows"
		: /iPhone|iPad|iPod/i.test(ua)
			? "iOS"
			: /Android/i.test(ua)
				? "Android"
				: /Mac OS X|Macintosh/i.test(ua)
					? "macOS"
					: /Linux/i.test(ua)
						? "Linux"
						: "";
	const browser = /Edg\//i.test(ua)
		? "Edge"
		: /OPR\/|Opera/i.test(ua)
			? "Opera"
			: /Firefox\//i.test(ua)
				? "Firefox"
				: /Chrome\/|CriOS/i.test(ua)
					? "Chrome"
					: /Safari\//i.test(ua)
						? "Safari"
						: "";
	if (os && browser) return os + " · " + browser;
	if (os) return os;
	if (browser) return browser;
	return "未知设备";
}

/** 把 UA 截断，免得太长的头把库撑大。 */
export function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return value.slice(0, max);
}
