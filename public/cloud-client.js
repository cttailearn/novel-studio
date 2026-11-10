// 云端账号的浏览器端小封装。
//
// 两种运行方式共用同一套调用：
//   · 同源 Cookie 模式：页面由服务端直接提供，直接 fetch 相对路径；
//   · 原生客户端云端模式：boot.js 会设置 window.__NOVEL_CLOUD__，
//     这里从 localStorage["novel-studio/cloud"] 或该对象取服务器地址，
//     自动带 Authorization: Bearer 与 x-novel-client: native。
//
// 这一层只管请求与错误，不碰界面。失败时抛出的 Error 带 status/code/data，
// 调用方可以据此决定是提示、重试还是回登录页。

const CONFIG_KEY = "novel-studio/cloud";

/**
 * 官方云端地址：连接页据此预填，用户改成自己的服务器地址就会覆盖它。
 * 只在这里写一次，免得登录页、账户页各写一份。
 */
export const DEFAULT_CLOUD_BASE = "https://novel.cttai.art/";

/** 把用户填的服务器地址归一成不带末尾斜杠的 http(s) 地址。 */
export function normalizeCloudBase(value) {
	let base = typeof value === "string" ? value.trim() : "";
	if (!base) return "";
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = "https://" + base;
	return base.replace(/\/+$/, "");
}

function readStoredConfig() {
	try {
		const raw = window.localStorage.getItem(CONFIG_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const base = normalizeCloudBase(parsed.base);
		if (!base) return null;
		return { base, token: typeof parsed.token === "string" ? parsed.token : "" };
	} catch {
		// 隐私模式、禁用存储、坏 JSON：都当作没有云端配置。
		return null;
	}
}

/** 读 localStorage 里的云端配置；没有或坏掉时返回 null。 */
export function getCloudConfig() {
	return readStoredConfig();
}

/**
 * 写入云端配置。boot.js 已经启动时同步更新内存里的 __NOVEL_CLOUD__，
 * 免得下次请求还拿着旧 token。
 */
export function setCloudConfig(value = {}) {
	const base = normalizeCloudBase(value.base);
	if (!base) throw new Error("云端地址不能为空。");
	const token = typeof value.token === "string" ? value.token : "";
	const next = { base, token };
	try {
		window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
	} catch {
		// 存储不可用时仍然让本次登录生效（__NOVEL_CLOUD__ 会拿到新 token）。
	}
	const cloud = window.__NOVEL_CLOUD__;
	if (cloud && typeof cloud.setToken === "function" && cloud.token !== token) {
		try {
			cloud.setToken(token);
		} catch {
			// boot.js 没接好也不该挡住登录。
		}
	}
	return next;
}

/** 清掉云端配置并让 boot.js 的 __NOVEL_CLOUD__ 一起失效。 */
export function clearCloudConfig() {
	const cloud = window.__NOVEL_CLOUD__;
	if (cloud && typeof cloud.clear === "function") {
		try {
			cloud.clear();
		} catch {
			// 忽略。
		}
	}
	// boot.js 的 clear() 只清 token、故意保留 base，方便下次连接；
	// 但“断开云端 / 先本地使用”要求连 base 也清掉，所以最后再删一次。
	try {
		window.localStorage.removeItem(CONFIG_KEY);
	} catch {
		// 忽略：内存里的配置已经清掉了。
	}
}

/** 当前请求该发往哪个服务器；空字符串表示同源 Cookie 模式。 */
export function cloudBase() {
	const stored = readStoredConfig();
	if (stored && stored.base) return stored.base;
	const cloud = window.__NOVEL_CLOUD__;
	return cloud && typeof cloud.base === "string" ? normalizeCloudBase(cloud.base) : "";
}

/** 当前 Bearer token；同源 Cookie 模式下为空。 */
export function cloudToken() {
	const stored = readStoredConfig();
	if (stored && stored.token) return stored.token;
	const cloud = window.__NOVEL_CLOUD__;
	return cloud && typeof cloud.token === "string" ? cloud.token : "";
}

/** 原生壳里才带 x-novel-client，服务端据此在响应里回 token。 */
export function isNativeClient() {
	return Boolean(window.__TAURI_INTERNALS__);
}

function isJsonBody(body) {
	if (!body || typeof body !== "object") return false;
	if (Object.prototype.toString.call(body) !== "[object Object]") return false;
	if (typeof FormData !== "undefined" && body instanceof FormData) return false;
	if (typeof Blob !== "undefined" && body instanceof Blob) return false;
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return false;
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return false;
	return true;
}

function defaultStatusMessage(status) {
	switch (status) {
		case 400:
			return "请求内容不完整或格式不对。";
		case 401:
			return "请先登录。";
		case 403:
			return "当前账号无权进行这个操作。";
		case 404:
			return "服务端没有这个接口。";
		case 409:
			return "这个操作和当前状态冲突，请刷新后再试。";
		case 413:
			return "内容太大，超出了服务端允许的范围。";
		case 429:
			return "尝试太频繁，请稍后再试。";
		case 507:
			return "云端容量已满，请清理后再试。";
		default:
			return "请求失败（HTTP " + status + "）。";
	}
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 本机页面（http://127.0.0.1:8787）直连云端是跨源请求，云端只放行自身来源与
 * Tauri 外壳，预检会被 403，浏览器随后报 "Failed to fetch"。这种情况下改走
 * 本机服务端的 /__cloud 同源转发，由它带上 x-cloud-target 去取。
 * 云端部署的网页与桌面外壳不走这条路。
 */
function loopbackRelay(base) {
	if (!base || typeof window === "undefined") return "";
	const page = window.location;
	if (!page || !LOOPBACK_HOSTS.has(page.hostname)) return "";
	try {
		if (new URL(base).origin === page.origin) return "";
	} catch {
		return "";
	}
	return page.origin + "/__cloud";
}

/**
 * 发一个 JSON 请求。
 * @param {string} path 以 / 开头的 API 路径（可带查询串）
 * @param {RequestInit} [options]
 */
export async function api(path, options = {}) {
	const base = cloudBase();
	const relay = base ? loopbackRelay(base) : "";
	const target = relay ? relay + (path.startsWith("/") ? path : "/" + path) : base ? base + (path.startsWith("/") ? path : "/" + path) : path;

	const headers = new Headers(options.headers || {});
	if (relay) headers.set("x-cloud-target", base);
	let body = options.body;
	if (isJsonBody(body)) {
		if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
		body = JSON.stringify(body);
	}
	if (!headers.has("accept")) headers.set("accept", "application/json");
	if (base) {
		const token = cloudToken();
		if (token) headers.set("authorization", "Bearer " + token);
		if (isNativeClient()) headers.set("x-novel-client", "native");
	}

	let response;
	try {
		response = await fetch(target, {
			...options,
			headers,
			body,
			credentials: options.credentials || "same-origin",
		});
	} catch (cause) {
		let host = "";
		try {
			host = new URL(relay ? base : target, window.location.href).host;
		} catch {
			// 拼不出 host 就用通用文案。
		}
		const error = new Error(host ? "连不上 " + host + "，请检查网络或服务器地址。" : "连不上服务器，请检查网络。");
		error.network = true;
		error.cause = cause;
		throw error;
	}

	let text = "";
	try {
		text = await response.text();
	} catch {
		text = "";
	}
	let data = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = null;
		}
	}

	if (response.status === 204) return null;

	if (!response.ok) {
		const message =
			data && typeof data.error === "string" && data.error.trim()
				? data.error.trim()
				: defaultStatusMessage(response.status);
		const error = new Error(message);
		error.status = response.status;
		error.code = data && typeof data.code === "string" ? data.code : "";
		error.data = data;
		throw error;
	}

	return data;
}

/** 把 api() 抛出的错误翻成一句适合给人看的中文。 */
export function apiErrorMessage(error, fallback = "操作没有成功，请稍后再试。") {
	if (!error) return fallback;
	const data = error.data;
	if (data && typeof data.error === "string" && data.error.trim()) {
		let message = data.error.trim();
		if (error.status === 429 && Number(data.retryAfter) > 0) {
			message += "（约 " + Math.ceil(Number(data.retryAfter)) + " 秒后可再试）";
		}
		return message;
	}
	return error.message || fallback;
}

// ── 认证 ────────────────────────────────────────────────────

export function authConfig() {
	return api("/api/auth/config");
}

export function me() {
	return api("/api/auth/me");
}

export function login(account, password) {
	return api("/api/auth/login", { method: "POST", body: { account, password } });
}

export function register(payload) {
	return api("/api/auth/register", { method: "POST", body: payload });
}

export function logout() {
	return api("/api/auth/logout", { method: "POST" });
}

export function changePassword(currentPassword, newPassword) {
	return api("/api/auth/password", { method: "POST", body: { currentPassword, newPassword } });
}

export function updateProfile(patch) {
	return api("/api/auth/profile", { method: "PATCH", body: patch });
}

// ── 账户 ────────────────────────────────────────────────────

export function usage() {
	return api("/api/account/usage");
}

export async function sessions() {
	const data = await api("/api/auth/sessions");
	return data && Array.isArray(data.sessions) ? data.sessions : [];
}

export function revokeSession(id) {
	return api("/api/auth/sessions/" + encodeURIComponent(String(id)), { method: "DELETE" });
}

export function revokeOtherSessions() {
	return api("/api/auth/sessions/revoke-others", { method: "POST" });
}

// ── 管理员 ──────────────────────────────────────────────────

export function listUsers({ query = "", offset = 0, limit = 50 } = {}) {
	const params = new URLSearchParams();
	if (query) params.set("query", query);
	params.set("offset", String(offset));
	params.set("limit", String(limit));
	return api("/api/admin/users?" + params.toString());
}

export function createUser(payload) {
	return api("/api/admin/users", { method: "POST", body: payload });
}

export function patchUser(id, patch) {
	return api("/api/admin/users/" + encodeURIComponent(String(id)), { method: "PATCH", body: patch });
}

export function resetPassword(id, password) {
	return api("/api/admin/users/" + encodeURIComponent(String(id)) + "/password", {
		method: "POST",
		body: password ? { password } : {},
	});
}

export function deleteUser(id) {
	return api("/api/admin/users/" + encodeURIComponent(String(id)), { method: "DELETE" });
}

export function stats() {
	return api("/api/admin/stats");
}

export function audit(limit = 100, offset = 0) {
	return api("/api/admin/audit?limit=" + encodeURIComponent(String(limit)) + "&offset=" + encodeURIComponent(String(offset)));
}
