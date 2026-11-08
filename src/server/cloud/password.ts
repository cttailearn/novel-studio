/**
 * 密码散列。
 *
 * scrypt（N=32768, r=8, p=1）+ 16 字节随机盐，散列 64 字节，存成
 * `scrypt$N$r$p$saltB64$hashB64` —— 参数跟着 hash 一起存，
 * 将来调强度时老用户的密码照样能验。
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

/** 当前强度。写进每一行新 hash 里。 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** scrypt 的 keylen 是单独的位置参数，promisify 之后要用 options 带上。 */
const scryptAsync = promisify(scrypt) as (
	password: string,
	salt: Uint8Array,
	keylen: number,
	options: ScryptOptions,
) => Promise<Buffer>;

/** 加到明文密码上的上限，免得一条超长请求把 CPU 拖死。 */
const MAX_PASSWORD_BYTES = 1024;

function scryptOptions(n: number, r: number, p: number): ScryptOptions {
	return {
		N: n,
		r,
		p,
		// scrypt 默认 maxmem = 32 MiB，而 N=32768,r=8 正好卡在 128*N*r = 32 MiB，
		// 内存检查是严格大于，所以给一倍余量，免得 Node 版本一变就抛 "memory limit exceeded"。
		maxmem: 128 * n * r * 2 + 64 * 1024 * 1024,
	};
}

/** 算一个密码散列。 */
export async function hashPassword(password: string): Promise<string> {
	if (password.length === 0) throw new Error("密码不能为空");
	if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw new Error("密码过长");
	const salt = randomBytes(SALT_BYTES);
	const hash = await scryptAsync(password, salt, KEY_BYTES, scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P));
	return [
		"scrypt",
		String(SCRYPT_N),
		String(SCRYPT_R),
		String(SCRYPT_P),
		salt.toString("base64"),
		hash.toString("base64"),
	].join("$");
}

function positiveInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
	return parsed;
}

/**
 * 校验密码。
 *
 * 形参/格式不对、长度对不上、比对失败一律 false —— 不区分"没这个用户"
 * 还是"密码错了"，也绝不因为库里的行坏了而抛异常。
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
	if (!stored) return false;
	if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
	const parts = stored.split("$");
	if (parts.length !== 6) return false;
	const scheme = parts[0];
	if (scheme !== "scrypt") return false;
	const n = positiveInteger(parts[1]);
	const r = positiveInteger(parts[2]);
	const p = positiveInteger(parts[3]);
	if (n === undefined || r === undefined || p === undefined) return false;
	const saltPart = parts[4];
	const hashPart = parts[5];
	if (saltPart === undefined || hashPart === undefined) return false;

	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(saltPart, "base64");
		expected = Buffer.from(hashPart, "base64");
	} catch {
		return false;
	}
	if (salt.length === 0 || expected.length === 0) return false;
	// scrypt 的参数上限：N 必须是 2 的幂，128*N*r 不能大到吃光内存。
	// 库里出现离谱的值说明这行被改过，直接判失败。
	if ((n & (n - 1)) !== 0) return false;
	if (n > 1 << 20 || r > 32 || p > 16) return false;

	try {
		const actual = await scryptAsync(password, salt, expected.length, scryptOptions(n, r, p));
		if (actual.length !== expected.length) return false;
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}
