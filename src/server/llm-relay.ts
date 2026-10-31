/**
 * 无状态 LLM 中继。
 *
 * 浏览器把自己的 API Key 随请求带来，服务端只在这一次转发里用它 ——
 * 不落盘、不写日志、不缓存、不记正文，转完就忘。
 *
 * 这条通路是唯一花钱的出口，也是唯一可能被拿来当 SSRF 跳板的地方。
 * 所以这个文件里最要紧的不是"转发"，而是"挡住不该转发的目标"：
 * 目标地址由用户给，所以它必须当成敌意输入来审 ——
 * 协议、私网地址、非标准端口、URL 里夹带的凭据、解析后指向内网的域名，
 * 一律在发出任何字节之前就拒掉。
 *
 * 审计只记元数据：时间、客户端（哈希后）、上游主机、路径、状态、耗时、字节数。
 * Key、请求头、请求体、响应体都不入日志。
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";

// ───────────────────────────────────────────── 配置

export interface RelayConfig {
	/**
	 * 允许的上游主机。空数组 = 任何"公开 https 主机"都可以。
	 *
	 * 每一项可以写 "主机名" 或 "主机名:端口"：
	 * · 只写主机名 → 该主机的 80 / 443 / 8443 都放行；
	 * · 写了端口 → 只有这个端口放行。
	 *
	 * 列入清单的主机就是运维方的显式信任：它不再受"必须 https"与
	 * "不许指向私网"两条约束的束缚 —— 这是本地联调（127.0.0.1 自建网关）
	 * 需要的开关。清单之外的任何地址都仍然要过全部检查。
	 */
	allowedHosts: string[];
	/** 请求体上限（字节）。默认 8 MiB。 */
	maxRequestBytes: number;
	/** 每个客户端每分钟允许的请求数。默认 60。 */
	requestsPerMinute: number;
	/** 全局并发上限。默认 16。 */
	maxInflight: number;
	/** 上游超时（毫秒）。默认 180 秒。 */
	timeoutMs: number;
	/** 上游响应体上限（字节）。默认 64 MiB。 */
	maxResponseBytes?: number;
	/** CORS 放行的来源。默认 "*"。 */
	allowedOrigin?: string;
	/** 审计行的去处。默认 console.log（只记元数据）。 */
	audit?: (line: string) => void;
}

/** 中继的默认上限。 */
export const RELAY_DEFAULTS = {
	maxRequestBytes: 8 * 1024 * 1024,
	requestsPerMinute: 60,
	maxInflight: 16,
	timeoutMs: 180_000,
	maxResponseBytes: 64 * 1024 * 1024,
	allowedOrigin: "*",
} as const;

// ───────────────────────────────────────────── 请求与结果

export interface RelayRequest {
	/** 上游端点的绝对 URL。 */
	target: string;
	/** 用户自己的 Key。默认作为 `Authorization: Bearer <key>` 发出。 */
	apiKey: string;
	/** 鉴权头名。默认 "authorization"；Anthropic 用 "x-api-key"。 */
	authHeader?: string;
	/** 鉴权头前缀。默认 "Bearer "；x-api-key 那种传空串。 */
	authScheme?: string;
	/** 转发给上游的额外请求头（如 anthropic-version、content-type）。 */
	headers?: Record<string, string>;
	/** 请求体。字符串按原文转发，其余按 JSON 序列化。 */
	body?: unknown;
	/** 浏览器发来的原始请求头。只用于 CORS 判定，不转发。 */
	requestHeaders?: Record<string, string | undefined>;
	/** HTTP 方法。默认 POST；OPTIONS 走 CORS 预检。 */
	method?: string;
}

/** 流式转发时的原始字节。 */
export interface RelayByteStream {
	kind: "bytes";
	stream: AsyncIterable<Uint8Array>;
}

export interface RelayOutcome {
	ok: boolean;
	status: number;
	headers?: Record<string, string>;
	/** 非流式时的响应体：JSON 就给 JSON，其它给文本。 */
	body?: unknown;
	error?: string;
	/** 流式时的原始字节流。 */
	stream?: RelayByteStream;
}

/** 中继处理函数。第二个参数是客户端标识（通常是来源 IP），只用于限流与审计。 */
export type RelayHandler = (req: RelayRequest, clientKey: string) => Promise<RelayOutcome>;

// ───────────────────────────────────────────── 内部类型

/** 内部错误：带 HTTP 状态码，用异常在几层之间传状态。 */
class RelayError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RelayError";
		this.status = status;
	}
}

/** 白名单里的一项。 */
interface AllowedEntry {
	host: string;
	/** undefined = 该主机的允许端口由通用规则决定。 */
	port: number | undefined;
}

interface RelaySettings {
	allowed: AllowedEntry[];
	/** 白名单为空 = 允许任何公开 https 主机。 */
	allowAnyPublic: boolean;
	maxRequestBytes: number;
	requestsPerMinute: number;
	maxInflight: number;
	timeoutMs: number;
	maxResponseBytes: number;
	allowedOrigin: string;
	audit: (line: string) => void;
}

/** 通过全部检查的目标。 */
interface ValidatedTarget {
	url: URL;
	/** 去括号、小写化之后的主机名。 */
	hostname: string;
	port: number;
	secure: boolean;
	/** 校验通过后钉住的地址。 */
	address: string;
	family: number;
	allowlisted: boolean;
}

/** 令牌桶。 */
interface Bucket {
	tokens: number;
	updatedAt: number;
}

// ───────────────────────────────────────────── 常量

/** 头部名必须是 RFC 7230 的 token。 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 请求头里不许由调用方自定义的：它们要么由我们管，要么会破坏连接。 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"te",
	"trailer",
	"expect",
	"proxy-authorization",
	"proxy-authenticate",
]);

/** 响应头里要剥掉的：Set-Cookie 与 Location 会把浏览器带去别处，authorization 是上游的回声。 */
const STRIPPED_RESPONSE_HEADERS = new Set([
	"set-cookie",
	"set-cookie2",
	"location",
	"authorization",
	"proxy-authorization",
	"cookie",
	"content-length",
	"connection",
	"date",
	"server",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"te",
	"trailer",
	"proxy-authenticate",
]);

/** 不放行的端口。80 只对白名单里的主机开放。 */
const PUBLIC_PORTS = [443, 8443];
const ALLOWED_HOST_PORTS = [80, 443, 8443];

/** 读上游响应体时的超时标记。 */
const TIMEOUT_MARK = "relay-upstream-timeout";

// ───────────────────────────────────────────── 小工具

function positiveInt(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 主机名归一化：去括号、去尾点、小写。
 *
 * 尾点是 FQDN 的写法（"example.com."），不归一化就会和白名单对不上。
 */
function normalizeHost(host: string): string {
	let text = host.trim().toLowerCase();
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	while (text.endsWith(".")) text = text.slice(0, -1);
	return text;
}

/** 解析白名单项。写不出合法主机名的一律丢掉。 */
function parseAllowedEntry(raw: string): AllowedEntry | undefined {
	const text = raw.trim().toLowerCase();
	if (!text) return undefined;
	if (text.startsWith("[")) {
		const end = text.indexOf("]");
		if (end < 0) return undefined;
		const host = text.slice(1, end);
		const rest = text.slice(end + 1);
		if (rest === "") return { host, port: undefined };
		if (!rest.startsWith(":")) return undefined;
		const port = Number(rest.slice(1));
		return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : undefined;
	}
	// 多个冒号 = 裸 IPv6 字面量（没有端口可言）。
	if ((text.split(":").length - 1) > 1) return { host: text, port: undefined };
	const colon = text.lastIndexOf(":");
	if (colon > 0) {
		const maybePort = text.slice(colon + 1);
		if (/^\d{1,5}$/.test(maybePort)) {
			const port = Number(maybePort);
			if (port > 0 && port <= 65535) return { host: text.slice(0, colon), port };
		}
	}
	return { host: text, port: undefined };
}

/**
 * 客户端标识的短哈希。
 *
 * 审计里不能出现 IP 原文（那是个人信息），但又要能看出"是不是同一个客户端"。
 * FNV-1a 够用：它不是为了抗碰撞，只是为了脱敏。
 */
function shortHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** 一次请求的编号。用在响应头上，方便把一次转发和它的日志对上。 */
let requestCounter = 0;
function randomId(): string {
	const webCrypto = globalThis.crypto;
	if (webCrypto && typeof webCrypto.randomUUID === "function") {
		try {
			return webCrypto.randomUUID();
		} catch {
			/* 非安全上下文下可能拿不到，退回下面的兜底。 */
		}
	}
	requestCounter += 1;
	return (
		Date.now().toString(36) +
		"-" +
		requestCounter.toString(36) +
		"-" +
		Math.floor(Math.random() * 0xffffff).toString(36)
	);
}

// ───────────────────────────────────────────── IP 判定

function parseIPv4(text: string): number[] | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	const out: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const value = Number(part);
		if (value > 255) return undefined;
		out.push(value);
	}
	return out;
}

/** 把 IPv6 文本拆成 8 个 16 位组。 */
function parseIPv6(text: string): number[] | undefined {
	let source = text.trim().toLowerCase();
	const zone = source.indexOf("%");
	if (zone >= 0) source = source.slice(0, zone);
	if (!source.includes(":")) return undefined;

	// 末尾写成 IPv4 的形式（::ffff:192.168.0.1）先摘出来。
	let trailing: number[] = [];
	const lastColon = source.lastIndexOf(":");
	const lastPart = source.slice(lastColon + 1);
	if (lastPart.includes(".")) {
		const v4 = parseIPv4(lastPart);
		if (!v4) return undefined;
		trailing = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
		source = source.slice(0, lastColon + 1) + "0:0";
	}

	const halves = source.split("::");
	if (halves.length > 2) return undefined;
	const toGroups = (part: string): number[] | undefined => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const piece of part.split(":")) {
			if (piece === "" || piece.length > 4 || !/^[0-9a-f]+$/.test(piece)) return undefined;
			groups.push(Number.parseInt(piece, 16));
		}
		return groups;
	};
	const left = toGroups(halves[0] ?? "");
	const right = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
	if (!left || !right) return undefined;
	const total = left.length + right.length + trailing.length;
	if (halves.length === 2) {
		if (total > 7) return undefined;
		const fill = 8 - total;
		return [...left, ...new Array<number>(fill).fill(0), ...right, ...trailing];
	}
	if (total !== 8) return undefined;
	return [...left, ...right, ...trailing];
}

function isPrivateIPv4(octets: number[]): boolean {
	const a = octets[0]!;
	const b = octets[1]!;
	const c = octets[2]!;
	if (a === 0) return true; // 0.0.0.0/8 本网络
	if (a === 10) return true; // 10.0.0.0/8 私网
	if (a === 127) return true; // 127.0.0.0/8 回环
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（含云厂商元数据 169.254.169.254）
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 私网
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 私网
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 组播
	if (a >= 240) return true; // 240.0.0.0/4 保留（含 255.255.255.255）
	if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF 协议保留
	if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 文档用
	if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 中继
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
	if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 文档用
	if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 文档用
	return false;
}

function isPrivateIPv6(groups: number[]): boolean {
	const g = groups;
	if (g.every((value) => value === 0)) return true; // ::
	if (g.slice(0, 7).every((value) => value === 0) && g[7] === 1) return true; // ::1 回环
	// IPv4 映射 ::ffff:0:0/96 —— 内嵌的 IPv4 也要判。
	if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
		return isPrivateIPv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
	}
	if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
	if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
	if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（已废弃）
	if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 组播
	if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 丢弃段
	if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 文档用
	// NAT64 64:ff9b::/96
	if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
		return isPrivateIPv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
	}
	// 6to4 2002::/16 —— 内嵌 IPv4 是私网时也不该放行。
	if (g[0] === 0x2002) {
		return isPrivateIPv4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]);
	}
	// Teredo 2001:0::/32 —— 内嵌 IPv4 取反。
	if (g[0] === 0x2001 && g[1] === 0) {
		return isPrivateIPv4([255 - (g[6]! >> 8), 255 - (g[6]! & 255), 255 - (g[7]! >> 8), 255 - (g[7]! & 255)]);
	}
	return false;
}

/**
 * 这个地址是不是"不该从公网访问到"的地址。
 *
 * 看不懂的地址一律当成不安全 —— 宁可错杀，不可放过。
 */
export function isPrivateAddress(address: string): boolean {
	const v4 = parseIPv4(address);
	if (v4) return isPrivateIPv4(v4);
	const v6 = parseIPv6(address);
	if (v6) return isPrivateIPv6(v6);
	return true;
}

function isIpLiteral(host: string): boolean {
	return parseIPv4(host) !== undefined || parseIPv6(host) !== undefined;
}

// ───────────────────────────────────────────── 目标校验

async function resolveHost(hostname: string): Promise<Array<{ address: string; family: number }>> {
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await dnsLookup(hostname, { all: true, verbatim: true });
	} catch {
		throw new RelayError(502, "解析不了目标主机名：" + hostname);
	}
	if (addresses.length === 0) throw new RelayError(502, "目标主机名没有解析结果：" + hostname);
	return addresses.map((item) => ({ address: item.address, family: item.family }));
}

/**
 * 把用户给的目标地址审一遍。
 *
 * 顺序有讲究：先看白名单（决定能不能破例），再看协议与端口，
 * 最后才做 DNS 与私网判定。任何一个不通过都在发出字节之前就拒掉。
 */
async function validateTarget(rawTarget: string, settings: RelaySettings): Promise<ValidatedTarget> {
	if (typeof rawTarget !== "string" || !rawTarget.trim()) {
		throw new RelayError(400, "目标地址不能为空");
	}
	let url: URL;
	try {
		url = new URL(rawTarget);
	} catch {
		throw new RelayError(400, "目标地址不是合法 URL");
	}
	// URL 里夹带凭据：既是钓鱼手段，也会让审计与日志带上不该有的东西。
	if (url.username || url.password) {
		throw new RelayError(400, "目标地址里不许带用户名或密码");
	}
	const hostname = normalizeHost(url.hostname);
	if (!hostname) throw new RelayError(400, "目标地址没有主机名");

	const secure = url.protocol === "https:";
	if (!secure && url.protocol !== "http:") {
		throw new RelayError(400, "协议不放行：" + url.protocol + "（只允许 https）");
	}
	const port = url.port ? Number(url.port) : secure ? 443 : 80;

	// 白名单：非空时，主机必须在里面。
	const entry = settings.allowed.find(
		(item) => item.host === hostname && (item.port === undefined || item.port === port),
	);
	const allowlisted = entry !== undefined;
	if (!allowlisted && !settings.allowAnyPublic) {
		throw new RelayError(400, "主机不在允许清单里：" + hostname);
	}

	// 协议：白名单里的主机可以用 http（本地联调），其余必须是 https。
	if (!secure && !allowlisted) {
		throw new RelayError(400, "协议不放行：http（只允许 https）");
	}

	// 端口：白名单里写死了端口就只认它，否则按通用规则。
	const allowedPorts = allowlisted
		? entry!.port !== undefined
			? [entry!.port]
			: ALLOWED_HOST_PORTS
		: PUBLIC_PORTS;
	if (!allowedPorts.includes(port)) {
		throw new RelayError(400, "端口不放行：" + port);
	}

	// 私网判定。字面量 IP 直接判，域名要解析后逐个判。
	let address: string;
	let family: number;
	if (isIpLiteral(hostname)) {
		if (!allowlisted && isPrivateAddress(hostname)) {
			throw new RelayError(400, "目标指向内网地址，已拒绝");
		}
		address = hostname;
		family = parseIPv4(hostname) ? 4 : 6;
	} else {
		const resolved = await resolveHost(hostname);
		if (!allowlisted && resolved.some((item) => isPrivateAddress(item.address))) {
			throw new RelayError(400, "目标解析到了内网地址，已拒绝");
		}
		// 钉住第一个地址：DNS 检查与真正连上的是同一个 IP，中间没有改绑的窗口。
		address = resolved[0]!.address;
		family = resolved[0]!.family;
	}

	return { url, hostname, port, secure, address, family, allowlisted };
}

// ───────────────────────────────────────────── 限流

/**
 * 令牌桶。
 *
 * 桶容量就是每分钟配额：允许一次性突发这么多，之后按每分钟 requestsPerMinute 个的速度回填。
 */
function takeToken(
	buckets: Map<string, Bucket>,
	capacity: number,
	windowMs: number,
	key: string,
	now: number,
): { allowed: boolean; retryAfterSec: number } {
	const refillPerMs = capacity / windowMs;
	const existing = buckets.get(key);
	let tokens = existing ? existing.tokens : capacity;
	let updatedAt = existing ? existing.updatedAt : now;
	tokens = Math.min(capacity, tokens + (now - updatedAt) * refillPerMs);
	updatedAt = now;
	if (tokens < 1) {
		buckets.set(key, { tokens, updatedAt });
		const waitMs = (1 - tokens) / refillPerMs;
		return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
	}
	tokens -= 1;
	buckets.set(key, { tokens, updatedAt });
	return { allowed: true, retryAfterSec: 0 };
}

/** 桶太多时清一遍旧的，免得被一堆伪造 IP 把内存撑起来。 */
function sweepBuckets(buckets: Map<string, Bucket>, windowMs: number, now: number): void {
	if (buckets.size <= 4096) return;
	for (const [key, bucket] of buckets) {
		if (now - bucket.updatedAt > windowMs * 2) buckets.delete(key);
	}
}

// ───────────────────────────────────────────── CORS

function headerBag(req: RelayRequest): Record<string, string | undefined> {
	const bag: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(req.requestHeaders ?? {})) {
		bag[name.toLowerCase()] = value;
	}
	for (const [name, value] of Object.entries(req.headers ?? {})) {
		bag[name.toLowerCase()] = value;
	}
	return bag;
}

/**
 * CORS 头。
 *
 * 默认放行所有来源（"*"）：中继不读 Cookie、不设 Cookie、不依赖任何环境凭据，
 * 调用方的凭据是请求体里的 API Key —— 它不受同源策略管。所以 "*" 是安全的。
 * 若部署方给中继本身加了鉴权，就必须把 allowedOrigin 设成具体来源。
 */
function corsHeadersFor(settings: RelaySettings, bag: Record<string, string | undefined>): Record<string, string> {
	const headers: Record<string, string> = {
		"access-control-allow-origin": settings.allowedOrigin,
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-max-age": "600",
	};
	// 浏览器点名要哪些头，就回哪些。
	const requested = bag["access-control-request-headers"];
	if (requested) headers["access-control-allow-headers"] = requested;
	if (settings.allowedOrigin !== "*") headers["vary"] = "origin";
	return headers;
}

/**
 * 给路由层用的 CORS 头。
 *
 * 预检与正常响应都要它，单独导出来，路由不必自己拼。
 */
export function relayCorsHeaders(
	config: RelayConfig,
	requestHeaders?: Record<string, string | undefined>,
): Record<string, string> {
	const settings = normalizeConfig(config);
	const bag: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(requestHeaders ?? {})) {
		bag[name.toLowerCase()] = value;
	}
	return corsHeadersFor(settings, bag);
}

// ───────────────────────────────────────────── 审计

/**
 * 审计一行。
 *
 * 只有这些：时间、客户端（哈希）、上游主机、路径、状态、耗时、字节数。
 * Key、请求头、请求体、响应体一个都不进来。路径只取 pathname ——
 * 查询串里可能夹着 key。
 */
function audit(
	settings: RelaySettings,
	fields: { clientKey: string; host: string; path: string; status: number; durationMs: number; bytes: number },
): void {
	const line = [
		new Date().toISOString(),
		"client=" + shortHash(fields.clientKey),
		"host=" + fields.host,
		"path=" + fields.path,
		"status=" + fields.status,
		"ms=" + fields.durationMs,
		"bytes=" + fields.bytes,
	].join(" ");
	settings.audit(line);
}

/** 审计里的主机与路径：解析不了就给空串，绝不把原始 target 抄进去。 */
function auditTarget(target: string): { host: string; path: string } {
	try {
		const url = new URL(target);
		return { host: normalizeHost(url.hostname), path: url.pathname };
	} catch {
		return { host: "", path: "" };
	}
}

// ───────────────────────────────────────────── 请求与响应

function isStreamRequest(req: RelayRequest): boolean {
	const body = req.body;
	if (body && typeof body === "object" && (body as { stream?: unknown }).stream === true) return true;
	const bag = headerBag(req);
	const accept = bag["accept"];
	if (typeof accept === "string" && accept.toLowerCase().includes("text/event-stream")) return true;
	return false;
}

/** 请求体编码 + 体积检查。 */
function encodeBody(body: unknown, settings: RelaySettings): string | undefined {
	if (body === undefined || body === null) return undefined;
	let text: string;
	if (typeof body === "string") {
		text = body;
	} else {
		try {
			const encoded = JSON.stringify(body);
			if (encoded === undefined) throw new Error("序列化结果是 undefined");
			text = encoded;
		} catch {
			throw new RelayError(400, "请求体序列化失败");
		}
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > settings.maxRequestBytes) {
		throw new RelayError(413, "请求体超过 " + Math.round(settings.maxRequestBytes / 1024 / 1024) + " MB 上限");
	}
	return text;
}

/** 鉴权头名必须像个头名，也不许是连接级的头。 */
function normalizeAuthHeader(raw: string | undefined): string {
	const name = (raw ?? "authorization").trim().toLowerCase();
	if (!HEADER_NAME_RE.test(name)) throw new RelayError(400, "鉴权头名不合法");
	if (FORBIDDEN_REQUEST_HEADERS.has(name)) throw new RelayError(400, "鉴权头名不能用：" + name);
	return name;
}

/** 组装转发给上游的请求头。鉴权头最后放，调用方覆盖不了它。 */
function buildUpstreamHeaders(req: RelayRequest, settings: RelaySettings): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(req.headers ?? {})) {
		if (typeof rawValue !== "string") continue;
		const name = rawName.trim().toLowerCase();
		if (!HEADER_NAME_RE.test(name)) continue;
		if (FORBIDDEN_REQUEST_HEADERS.has(name)) continue;
		// 头里带换行就是注入，一概丢掉。
		if (/[\r\n\0]/.test(rawValue)) continue;
		headers[name] = rawValue;
	}
	const authHeader = normalizeAuthHeader(req.authHeader);
	const scheme = req.authScheme === undefined ? "Bearer " : req.authScheme;
	headers[authHeader] = scheme + (typeof req.apiKey === "string" ? req.apiKey : "");
	if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
	if (headers["accept"] === undefined) {
		headers["accept"] = isStreamRequest(req) ? "text/event-stream" : "application/json";
	}
	// 不让上游压缩：字节要原样回来，体积与长度才算得准。
	headers["accept-encoding"] = "identity";
	headers["user-agent"] = headers["user-agent"] ?? "novel-studio-relay/1";
	void settings;
	return headers;
}

/** 响应头脱敏：剥掉 Set-Cookie、Location 与任何 authorization 回声。 */
function sanitizeResponseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(headers)) {
		if (rawValue === undefined) continue;
		const name = rawName.toLowerCase();
		if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
		if (/authorization/i.test(name) || /api[-_]?key/i.test(name) || /secret/i.test(name)) continue;
		out[name] = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
	}
	return out;
}

/**
 * 钉住连接地址。
 *
 * 校验时解析出来的 IP 直接给 socket 用，DNS 再解析一次的话，
 * 中间那个空隙就是改绑（DNS rebinding）窗口 —— 第一次解析给公网、
 * 第二次解析给 127.0.0.1，就绕过了所有检查。
 */
function pinnedLookup(target: ValidatedTarget): LookupFunction {
	return (_hostname, options, callback) => {
		if (options.all) {
			callback(null, [{ address: target.address, family: target.family }]);
			return;
		}
		callback(null, target.address, target.family);
	};
}

/** 发请求，等响应头。超时与连接失败在这里就变成状态码。 */
async function openUpstream(
	target: ValidatedTarget,
	headers: Record<string, string>,
	payload: string | undefined,
	settings: RelaySettings,
	method: "GET" | "POST" = "POST",
): Promise<IncomingMessage> {
	const options: RequestOptions = {
		method,
		host: target.hostname,
		port: target.port,
		path: target.url.pathname + target.url.search,
		headers,
		// 不复用连接：每一次转发都用刚校验过的地址新建一条连接。
		agent: false,
		lookup: pinnedLookup(target),
	};
	// SNI 必须是主机名（不是 IP），证书才验得对。
	if (target.secure && !isIpLiteral(target.hostname)) options.servername = target.hostname;

	return await new Promise<IncomingMessage>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const onResponse = (response: IncomingMessage): void => {
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(response);
		};
		const upstream = target.secure
			? httpsRequest(options, onResponse)
			: httpRequest(options, onResponse);
		upstream.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			reject(new RelayError(502, "连不上上游：" + error.message));
		});
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			upstream.destroy();
			reject(new RelayError(504, "上游超时：" + settings.timeoutMs + " 毫秒内没回话"));
		}, settings.timeoutMs);
		if (payload !== undefined) upstream.write(payload);
		upstream.end();
	});
}

/** 响应体尽量还原成 JSON；不是 JSON 就给文本。 */
function parseBody(buffer: Buffer, contentType: string | undefined): unknown {
	const text = buffer.toString("utf8");
	if (text === "") return undefined;
	const type = (contentType ?? "").toLowerCase();
	if (type.includes("json") || text.startsWith("{") || text.startsWith("[")) {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text;
		}
	}
	return text;
}

/** 非流式：把整个响应读进来（有上限）。 */
async function readBody(
	response: IncomingMessage,
	settings: RelaySettings,
): Promise<{ value: unknown; bytes: number }> {
	const chunks: Buffer[] = [];
	let size = 0;
	response.setTimeout(settings.timeoutMs, () => {
		response.destroy(new Error(TIMEOUT_MARK));
	});
	try {
		for await (const chunk of response) {
			size += chunk.length;
			if (size > settings.maxResponseBytes) {
				response.destroy();
				throw new RelayError(502, "上游响应超过 " + Math.round(settings.maxResponseBytes / 1024 / 1024) + " MB 上限");
			}
			chunks.push(chunk as Buffer);
		}
	} catch (error) {
		if (error instanceof RelayError) throw error;
		if (error instanceof Error && error.message === TIMEOUT_MARK) {
			throw new RelayError(504, "读上游响应超时");
		}
		throw new RelayError(502, "上游响应中断：" + (error instanceof Error ? error.message : String(error)));
	}
	const buffer = Buffer.concat(chunks);
	return { value: parseBody(buffer, response.headers["content-type"]), bytes: size };
}

/**
 * 流式：把上游的字节一块块交出去，不在内存里攒。
 *
 * 调用方写完（或者中途放弃）时 finally 会把上游连接拆掉，
 * 并发计数也在这里归还 —— 流还没读完就不该把名额放出去。
 */
async function* streamBody(
	response: IncomingMessage,
	settings: RelaySettings,
	onDone: (bytes: number) => void,
): AsyncGenerator<Uint8Array> {
	let size = 0;
	response.setTimeout(settings.timeoutMs, () => {
		response.destroy(new Error(TIMEOUT_MARK));
	});
	try {
		for await (const chunk of response) {
			size += chunk.length;
			if (size > settings.maxResponseBytes) {
				response.destroy();
				throw new RelayError(502, "上游响应超过 " + Math.round(settings.maxResponseBytes / 1024 / 1024) + " MB 上限");
			}
			yield chunk as Uint8Array;
		}
	} finally {
		onDone(size);
		response.destroy();
	}
}

// ───────────────────────────────────────────── 主入口

function normalizeConfig(config: RelayConfig): RelaySettings {
	const allowed = (config.allowedHosts ?? [])
		.map(parseAllowedEntry)
		.filter((entry): entry is AllowedEntry => entry !== undefined);
	return {
		allowed,
		allowAnyPublic: allowed.length === 0,
		maxRequestBytes: positiveInt(config.maxRequestBytes, RELAY_DEFAULTS.maxRequestBytes),
		requestsPerMinute: positiveInt(config.requestsPerMinute, RELAY_DEFAULTS.requestsPerMinute),
		maxInflight: positiveInt(config.maxInflight, RELAY_DEFAULTS.maxInflight),
		timeoutMs: positiveInt(config.timeoutMs, RELAY_DEFAULTS.timeoutMs),
		maxResponseBytes: positiveInt(config.maxResponseBytes, RELAY_DEFAULTS.maxResponseBytes),
		allowedOrigin: (config.allowedOrigin ?? RELAY_DEFAULTS.allowedOrigin).trim() || RELAY_DEFAULTS.allowedOrigin,
		audit: config.audit ?? ((line: string) => console.log("[relay] " + line)),
	};
}

/**
 * 造一个中继处理函数。
 *
 * 返回的函数做四件事：限流、挡 SSRF、转发、脱敏。
 * 它不碰磁盘，也不把任何用户数据留在内存里（转发完就释放）。
 */
export function createRelayHandler(config: RelayConfig): RelayHandler {
	const settings = normalizeConfig(config);
	const buckets = new Map<string, Bucket>();
	let inflight = 0;

	return async function handleRelay(req: RelayRequest, clientKey: string): Promise<RelayOutcome> {
		const startedAt = Date.now();
		const requestId = randomId();
		const method = (req.method ?? "POST").toUpperCase();
		const cors = corsHeadersFor(settings, headerBag(req));

		// CORS 预检：不碰上游，只回政策。
		if (method === "OPTIONS") {
			return { ok: true, status: 204, headers: { ...cors, "x-relay-request-id": requestId } };
		}
		if (method !== "POST" && method !== "GET") {
			return { ok: false, status: 405, headers: { ...cors, "x-relay-request-id": requestId }, error: "只允许 GET、POST、OPTIONS" };
		}

		// 限流：按客户端（通常是来源 IP）。
		sweepBuckets(buckets, 60_000, startedAt);
		const limit = takeToken(buckets, settings.requestsPerMinute, 60_000, clientKey, startedAt);
		if (!limit.allowed) {
			return {
				ok: false,
				status: 429,
				headers: { ...cors, "retry-after": String(limit.retryAfterSec), "x-relay-request-id": requestId },
				error: "请求太频繁，等 " + limit.retryAfterSec + " 秒再来。",
			};
		}

		// 全局并发上限：这是唯一花钱的出口，不能被一个人占满。
		if (inflight >= settings.maxInflight) {
			return {
				ok: false,
				status: 503,
				headers: { ...cors, "retry-after": "1", "x-relay-request-id": requestId },
				error: "服务器正忙，稍后再试。",
			};
		}
		inflight += 1;
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			inflight -= 1;
		};

		try {
			const target = await validateTarget(req.target, settings);
			const payload = encodeBody(req.body, settings);
			const headers = buildUpstreamHeaders(req, settings);
			const response = await openUpstream(target, headers, payload, settings, method);
			const status = response.statusCode ?? 502;
			const outHeaders = sanitizeResponseHeaders(response.headers);
			const replyHeaders: Record<string, string> = {
				...outHeaders,
				...cors,
				"x-relay-request-id": requestId,
			};

			if (isStreamRequest(req)) {
				const stream = streamBody(response, settings, (bytes) => {
					release();
					audit(settings, {
						clientKey,
						host: target.hostname,
						path: target.url.pathname,
						status,
						durationMs: Date.now() - startedAt,
						bytes,
					});
				});
				return {
					ok: status >= 200 && status < 300,
					status,
					headers: replyHeaders,
					stream: { kind: "bytes", stream },
					error: status >= 300 ? describeStatus(status) : undefined,
				};
			}

			const body = await readBody(response, settings);
			release();
			audit(settings, {
				clientKey,
				host: target.hostname,
				path: target.url.pathname,
				status,
				durationMs: Date.now() - startedAt,
				bytes: body.bytes,
			});
			return {
				ok: status >= 200 && status < 300,
				status,
				headers: replyHeaders,
				body: body.value,
				error: status >= 300 ? describeStatus(status) : undefined,
			};
		} catch (error) {
			release();
			const status = error instanceof RelayError ? error.status : 502;
			const message = error instanceof RelayError ? error.message : "转发失败：" + (error as Error).message;
			const target = auditTarget(req.target);
			audit(settings, {
				clientKey,
				host: target.host,
				path: target.path,
				status,
				durationMs: Date.now() - startedAt,
				bytes: 0,
			});
			return {
				ok: false,
				status,
				headers: { ...cors, "x-relay-request-id": requestId },
				error: message,
			};
		}
	};
}

/** 非 2xx 的说明。3xx 特别说明一句：中继不跟随重定向。 */
function describeStatus(status: number): string {
	if (status >= 300 && status < 400) return "上游返回重定向（" + status + "），中继不跟随。";
	return "上游返回 " + status;
}
