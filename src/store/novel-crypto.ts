/**
 * `.novel` 包的口令加密。
 *
 * > **现状（2026-10）：这个文件只服务于旧兼容层，新代码不要再用。**
 * > 正式的视频入口是 `novel-package.ts` 的 `exportNovel({ passphrase })` /
 * > `importNovel(bytes, { passphrase })` —— 加密、压缩、信封格式都在那一处收口。
 * > 这里保留是因为 `novel-package.ts` 末尾的摊平旧接口还要用它，删掉会连带打掉兼容层。
 *
 * 威胁模型：用户把包放在网盘/U 盘/微信里传，可能被人看到。所以给一个"口令加密"的选项：
 * 没有口令也能导出（就是普通的 JSON 文件），有口令就整包加密后再存。
 *
 * 参数为什么这么选：
 *   - KDF：PBKDF2-HMAC-SHA256，210000 次迭代。OWASP 对 PBKDF2-HMAC-SHA256 的建议下限
 *     就是 210000 次（2023 版），口令是低熵的，迭代次数就是拖慢暴力破解的唯一东西。
 *     盐 16 字节随机：同一个口令加密两个包，密文完全不同，也堵掉彩虹表。
 *   - 加密：AES-GCM 256 位，12 字节随机 IV（AES-GCM 推荐 96 位），128 位认证标签。
 *     GCM 自带完整性校验，密文被改一个字节就会解密失败，不会悄悄给出错误内容。
 *   - checksum：明文的 SHA-256（base64）。GCM 已经保证密文没被改，这个校验和是
 *     第二道网：万一以后换算法或者中间环节出错，能立刻发现"内容对不上"。
 *
 * 只用 WebCrypto（crypto.subtle），不用 node:crypto —— 浏览器里也能跑。
 * 注意 crypto.subtle 只在**安全上下文**（https 或 localhost）里才有；
 * 局域网 http 访问时它是 undefined，这时会明确报错让人改用不加密的导出。
 */

import { parseNovelPackage, serializeNovelPackage, type NovelPackage } from "./novel-package.ts";

/** 加密包（信封）的判别符。和普通包的 format 故意不一样，导入时好认。 */
export const NOVEL_ENVELOPE_FORMAT = "novel-studio/novel-encrypted";
/** 信封版本号。 */
export const NOVEL_ENVELOPE_VERSION = 1;
/** 密钥派生方式。 */
export const NOVEL_KDF = "pbkdf2-sha256";
/** 加密方式。 */
export const NOVEL_CIPHER = "aes-gcm";
/** PBKDF2 迭代次数。210000 = OWASP 对 PBKDF2-HMAC-SHA256 的建议下限。 */
export const PBKDF2_ITERATIONS = 210_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BITS = 128;
const TAG_BYTES = TAG_BITS / 8;
const KEY_BITS = 256;
/** 迭代次数的合法范围，防止手改过的头部把机器卡死（或者把安全强度降到 0）。 */
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 10_000_000;

/** WebCrypto 的 SubtleCrypto 类型。@types/node 把它放在 webcrypto 命名空间里，没法直接当全局类型用。 */
type SubtleCryptoLike = (typeof globalThis)["crypto"]["subtle"];

/** 加密包的头部（信封）。字段顺序固定，序列化成文件时人也能看懂。 */
export interface NovelEnvelope {
	format: typeof NOVEL_ENVELOPE_FORMAT;
	version: number;
	kdf: typeof NOVEL_KDF;
	/** PBKDF2 迭代次数。 */
	iterations: number;
	/** 盐，base64。 */
	salt: string;
	/** 初始向量，base64。 */
	iv: string;
	cipher: typeof NOVEL_CIPHER;
	/** ISO 时间字符串。 */
	createdAt: string;
	/** 明文的 SHA-256，base64。 */
	checksum: string;
}

/** 落盘用的加密文件：信封 + 密文（base64），整个还是 JSON，方便人看一眼。 */
export interface NovelEncryptedFile extends NovelEnvelope {
	/** 密文（末尾带 16 字节 GCM 标签），base64。 */
	data: string;
}

/** 加密相关的错误码。 */
export type NovelCryptoErrorCode = "no-subtle" | "empty-passphrase" | "bad-passphrase" | "corrupt" | "bad-header";

/** 加密/解密出错。消息一律中文，直接给用户看。 */
export class NovelCryptoError extends Error {
	readonly code: NovelCryptoErrorCode;

	constructor(code: NovelCryptoErrorCode, message: string) {
		super(message);
		this.name = "NovelCryptoError";
		this.code = code;
	}
}

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * 拿到 crypto.subtle，没有就报人话。
 * 局域网 http 这种非安全上下文里，浏览器不给 subtle —— 这时候明确告诉用户改用不加密导出。
 */
function requireSubtle(): SubtleCryptoLike {
	const scope = globalThis as typeof globalThis & { isSecureContext?: boolean };
	const subtle = scope.crypto?.subtle;
	if (!subtle) {
		if (typeof scope.isSecureContext === "boolean" && !scope.isSecureContext) {
			throw new NovelCryptoError(
				"no-subtle",
				"当前环境不是安全上下文（需要 https 或 localhost），无法使用口令加密；可以改用不加密的导出。",
			);
		}
		throw new NovelCryptoError(
			"no-subtle",
			"当前环境没有 WebCrypto 加密接口（crypto.subtle），无法使用口令加密；可以改用不加密的导出。",
		);
	}
	return subtle;
}

/** 当前环境能不能用口令加密。界面据此决定要不要显示"加密导出"。 */
export function isNovelCryptoAvailable(): boolean {
	const scope = globalThis as typeof globalThis & { isSecureContext?: boolean };
	if (!scope.crypto?.subtle) return false;
	if (typeof scope.isSecureContext === "boolean" && !scope.isSecureContext) return false;
	return true;
}

async function deriveKey(subtle: SubtleCryptoLike, passphrase: string, salt: Uint8Array, iterations: number) {
	const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
	return subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		base,
		{ name: "AES-GCM", length: KEY_BITS },
		false,
		["encrypt", "decrypt"],
	);
}

async function checksumOf(subtle: SubtleCryptoLike, data: Uint8Array): Promise<string> {
	const digest = await subtle.digest("SHA-256", data);
	return toBase64(new Uint8Array(digest));
}

// ------------------------------------------------------------------
// 加解密
// ------------------------------------------------------------------

/**
 * 给包加密。
 *
 * 不加密的路径是现成的：直接 `serializeNovelPackage(pkg)` 得到明文 JSON，
 * 那也是一个完整的 `.novel` 文件。加密只是外面再裹一层信封。
 *
 * @param pkg 要加密的包
 * @param passphrase 口令
 */
export async function encryptNovelPackage(
	pkg: NovelPackage,
	passphrase: string,
): Promise<{ bytes: Uint8Array; header: NovelEnvelope }> {
	const subtle = requireSubtle();
	if (!passphrase) throw new NovelCryptoError("empty-passphrase", "口令不能为空。");
	const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(subtle, passphrase, salt, PBKDF2_ITERATIONS);
	const plaintext = new TextEncoder().encode(serializeNovelPackage(pkg));
	const checksum = await checksumOf(subtle, plaintext);
	const encrypted = await subtle.encrypt({ name: NOVEL_CIPHER, iv, tagLength: TAG_BITS }, key, plaintext);
	return {
		bytes: new Uint8Array(encrypted),
		header: {
			format: NOVEL_ENVELOPE_FORMAT,
			version: NOVEL_ENVELOPE_VERSION,
			kdf: NOVEL_KDF,
			iterations: PBKDF2_ITERATIONS,
			salt: toBase64(salt),
			iv: toBase64(iv),
			cipher: NOVEL_CIPHER,
			createdAt: new Date().toISOString(),
			checksum,
		},
	};
}

/**
 * 解密。
 *
 * 失败分几种情况，消息都区分开：
 *   - 口令不对 / 密文被改 → AES-GCM 认证失败 → "口令不对或文件已损坏"
 *   - 头部不对 → "加密包的头部不对……"
 *   - 密文长度不对 → "文件已损坏……"
 *   - 解出来校验和不匹配 → "文件已损坏：校验和不匹配……"
 *
 * @param bytes 密文
 * @param header 信封
 * @param passphrase 口令
 */
export async function decryptNovelPackage(bytes: Uint8Array, header: NovelEnvelope, passphrase: string): Promise<NovelPackage> {
	const subtle = requireSubtle();
	if (!passphrase) throw new NovelCryptoError("empty-passphrase", "口令不能为空。");
	const checked = checkEnvelope(header);
	if (bytes.length < TAG_BYTES) {
		throw new NovelCryptoError("corrupt", "文件已损坏：密文长度不对，连认证标签都不够。");
	}
	let salt: Uint8Array;
	let iv: Uint8Array;
	try {
		salt = fromBase64(checked.salt);
		iv = fromBase64(checked.iv);
	} catch {
		throw new NovelCryptoError("bad-header", "加密包的头部不对：salt 或 iv 不是合法的 base64。");
	}
	if (salt.length !== SALT_BYTES) {
		throw new NovelCryptoError("bad-header", `加密包的头部不对：盐应该是 ${SALT_BYTES} 字节，实际 ${salt.length} 字节。`);
	}
	if (iv.length !== IV_BYTES) {
		throw new NovelCryptoError("bad-header", `加密包的头部不对：初始向量应该是 ${IV_BYTES} 字节，实际 ${iv.length} 字节。`);
	}
	const key = await deriveKey(subtle, passphrase, salt, checked.iterations);
	let plaintext: ArrayBuffer;
	try {
		plaintext = await subtle.decrypt({ name: NOVEL_CIPHER, iv, tagLength: TAG_BITS }, key, bytes);
	} catch {
		throw new NovelCryptoError("bad-passphrase", "口令不对或文件已损坏。");
	}
	const plainBytes = new Uint8Array(plaintext);
	const checksum = await checksumOf(subtle, plainBytes);
	if (checksum !== checked.checksum) {
		throw new NovelCryptoError("corrupt", "文件已损坏：校验和不匹配，内容被改动过。");
	}
	let text: string;
	try {
		text = new TextDecoder().decode(plainBytes);
	} catch {
		throw new NovelCryptoError("corrupt", "文件已损坏：解密后的内容不是合法文本。");
	}
	try {
		return parseNovelPackage(text);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new NovelCryptoError("corrupt", `解密成功，但内容不是有效的 .novel 包：${detail}`);
	}
}

/**
 * 校验信封。头部长得不对就报错，不去猜。
 */
function checkEnvelope(raw: unknown): NovelEnvelope {
	if (!isPlainObject(raw)) {
		throw new NovelCryptoError("bad-header", "加密包的头部不对：不是一个对象。");
	}
	const input = raw as Record<string, unknown>;
	const format = asString(input.format);
	if (format !== NOVEL_ENVELOPE_FORMAT) {
		throw new NovelCryptoError(
			"bad-header",
			`加密包的头部不对：format 是「${format || "（空）"}」，应为「${NOVEL_ENVELOPE_FORMAT}」。`,
		);
	}
	const version = input.version;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		throw new NovelCryptoError("bad-header", "加密包的头部不对：版本号不对。");
	}
	if (version > NOVEL_ENVELOPE_VERSION) {
		throw new NovelCryptoError(
			"bad-header",
			`加密包的版本是 ${version}，比本程序支持的版本 ${NOVEL_ENVELOPE_VERSION} 新。请先升级程序再导入。`,
		);
	}
	const kdf = asString(input.kdf);
	if (kdf !== NOVEL_KDF) {
		throw new NovelCryptoError("bad-header", `不支持的密钥派生方式：${kdf || "（空）"}。`);
	}
	const cipher = asString(input.cipher);
	if (cipher !== NOVEL_CIPHER) {
		throw new NovelCryptoError("bad-header", `不支持的加密方式：${cipher || "（空）"}。`);
	}
	const iterations = input.iterations;
	if (typeof iterations !== "number" || !Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
		throw new NovelCryptoError("bad-header", "加密包的头部不对：迭代次数不对。");
	}
	const salt = asString(input.salt);
	const iv = asString(input.iv);
	const checksum = asString(input.checksum);
	if (!salt || !iv || !checksum) {
		throw new NovelCryptoError("bad-header", "加密包的头部不对：缺少 salt / iv / checksum。");
	}
	return {
		format: NOVEL_ENVELOPE_FORMAT,
		version,
		kdf: NOVEL_KDF,
		iterations,
		salt,
		iv,
		cipher: NOVEL_CIPHER,
		createdAt: asString(input.createdAt),
		checksum,
	};
}

// ------------------------------------------------------------------
// 文件层：加密包也是一个 JSON 文件
// ------------------------------------------------------------------

/**
 * 加密并拼成可以直接落盘的文件内容。
 * @param pkg 要加密的包
 * @param passphrase 口令
 */
export async function encryptNovelPackageToFile(pkg: NovelPackage, passphrase: string): Promise<NovelEncryptedFile> {
	const { bytes, header } = await encryptNovelPackage(pkg, passphrase);
	return { ...header, data: toBase64(bytes) };
}

/**
 * 解开一个加密文件。
 * @param file 加密文件（信封 + 密文）
 * @param passphrase 口令
 */
export async function decryptNovelPackageFile(file: NovelEncryptedFile, passphrase: string): Promise<NovelPackage> {
	const header = checkEnvelope(file);
	const data = asString((file as unknown as Record<string, unknown>).data);
	if (!data) throw new NovelCryptoError("bad-header", "加密包缺少 data（密文）。");
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(data);
	} catch {
		throw new NovelCryptoError("corrupt", "文件已损坏：密文不是合法的 base64。");
	}
	return decryptNovelPackage(bytes, header, passphrase);
}

/** 把加密文件序列化成 JSON 字符串（字段顺序固定，排版一下方便人看）。 */
export function serializeNovelEnvelope(file: NovelEncryptedFile): string {
	return JSON.stringify(
		{
			format: file.format,
			version: file.version,
			kdf: file.kdf,
			iterations: file.iterations,
			salt: file.salt,
			iv: file.iv,
			cipher: file.cipher,
			createdAt: file.createdAt,
			checksum: file.checksum,
			data: file.data,
		},
		null,
		2,
	);
}

/** 读加密文件。头部长得不对直接报错。 */
export function parseNovelEnvelope(text: string): { header: NovelEnvelope; bytes: Uint8Array } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new NovelCryptoError("bad-header", "这不是合法的 JSON 文件，没法当作加密的 .novel 包导入。");
	}
	if (!isPlainObject(parsed)) {
		throw new NovelCryptoError("bad-header", "加密包的头部不对：不是一个对象。");
	}
	const header = checkEnvelope(parsed);
	const data = asString(parsed.data);
	if (!data) throw new NovelCryptoError("bad-header", "加密包缺少 data（密文）。");
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(data);
	} catch {
		throw new NovelCryptoError("corrupt", "文件已损坏：密文不是合法的 base64。");
	}
	return { header, bytes };
}
