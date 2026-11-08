/**
 * 账号模块自己的错误类型。
 *
 * 业务层只管抛，routes.ts 统一翻成 JSON —— 这样"账号或密码不正确"这种文案
 * 只在一处定义，不会出现两个端点两种说法。
 */
import type { UserStatus } from "./types.ts";

/** 带 HTTP 语义的错误。`details` 会平铺进响应体（比如限流的 retryAfter）。 */
export class CloudError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details: Record<string, unknown>;

	constructor(status: number, message: string, code: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "CloudError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

/** 401：没登录、令牌无效。 */
export function unauthorized(): CloudError {
	return new CloudError(401, "请先登录", "unauthorized");
}

/** 401：登录用的账号或密码不对（统一文案，不透露是哪半错了）。 */
export function invalidCredentials(): CloudError {
	return new CloudError(401, "账号或密码不正确", "invalid_credentials");
}

/** 403：账号被停用。 */
export function accountDisabled(): CloudError {
	return new CloudError(403, "账号已停用", "disabled");
}

/** 403：权限不够（非管理员）。 */
export function forbidden(message = "没有权限"): CloudError {
	return new CloudError(403, message, "forbidden");
}

/** 400：请求本身有问题。 */
export function badRequest(message: string, code = "bad_request"): CloudError {
	return new CloudError(400, message, code);
}

/** 404：找不到目标。 */
export function notFound(message: string, code = "not_found"): CloudError {
	return new CloudError(404, message, code);
}

/** 409：与现有数据冲突（邮箱/用户名重复）。 */
export function conflict(message: string, code = "conflict"): CloudError {
	return new CloudError(409, message, code);
}

/** 429：太频繁。retryAfter 单位是秒。 */
export function rateLimited(retryAfter: number): CloudError {
	return new CloudError(429, "尝试太频繁，请稍后再试", "rate_limited", {
		retryAfter: Math.max(1, Math.ceil(retryAfter)),
	});
}

/** 507：超配额。账号模块不管文件写入，这里留给 app 用同一份文案。 */
export function quotaExceeded(quotaBytes: number, usedBytes: number): CloudError {
	return new CloudError(507, "云端容量已满，请联系管理员扩容或删除一些作品。", "quota_exceeded", {
		quotaBytes,
		usedBytes,
	});
}

/** 账号状态的可读文案（审计里用）。 */
export function statusLabel(status: UserStatus): string {
	return status === "active" ? "启用" : "停用";
}
