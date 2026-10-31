/**
 * 作者自建素材种类的纯模型层：类型、名字转 id、归一化。
 *
 * 这一层不碰文件系统，因此可以原样搬进浏览器 ——
 * 浏览器端的 IndexedDB 版种类表只需要实现同一个接口
 * （KindsStorePort，见 store-port.ts）。
 * 磁盘实现见 kinds-disk.ts；两侧共用这里定义的数据形状与纯函数。
 */
import { newId } from "./project.ts";
import type { KindsStorePort } from "./store-port.ts";

/**
 * 作者自建的素材种类。
 *
 * 内置那十三种是笔法上的基本盘，但一本书常有自己的门类 —— 势力、道具、民俗、
 * 某种行当的规矩。硬塞进「其他」等于把这些料埋了：智能体检索、按类分组、
 * 界面筛选都靠 kind，混在一起就再也分不开了。
 *
 * 所以种类表是**开着口子的**：内置的写死在代码里（它们是所有书共用的笔法），
 * 自建的落在这份 data/kinds.json 里（它们是这位作者自己的门类）。
 * 自建种的 id 就是作者起的那个名字，因此智能体写 kind 时写的是「势力」而不是
 * 一个编号，模型不容易写错，作者回头也认得。
 */

/** 自建的一种。 */
export interface CustomKind {
	/** 稳定 id：作者起的名字（限 24 字，去掉了路径里惹祸的字符）。 */
	id: string;
	/** 显示名：作者写的那个名字。 */
	label: string;
	createdAt: number;
}

/** 库文件的形状。用对象包一层，将来加字段不必改格式。 */
export interface KindFile {
	kinds: CustomKind[];
}

/** 名字里这些字符在路径与查询串里会惹祸，换成短横。 */
const UNSAFE_CHARS = /[\s/\\?#%&:;,'"<>|]+/g;

/** 名字最长多少字。太长的名字在窄栏里也读不全。 */
export const MAX_LABEL = 24;

/**
 * 名字转 id。
 *
 * 保留中文与字母数字，其余换成短横；空了就退回一个随机编号。
 * 不用拼音：作者起什么名，智能体就写什么名，少一道翻译。
 */
export function kindIdFromLabel(label: string): string {
	const cleaned = label
		.trim()
		.replace(UNSAFE_CHARS, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, MAX_LABEL);
	return cleaned || "custom-" + newId().slice(0, 6);
}

/** 增删改的结果。带状态码，服务端直接拿去回话。 */
export type KindResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

/** 归一化一条自建种类。坏数据在这里被挡掉，不进内存。 */
export function normalizeCustomKind(raw: unknown): CustomKind | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<CustomKind>;
	const id = typeof input.id === "string" ? input.id.trim() : "";
	const label = typeof input.label === "string" ? input.label.trim() : "";
	if (!id || !label) return undefined;
	return {
		id,
		label,
		createdAt: typeof input.createdAt === "number" ? input.createdAt : Date.now(),
	};
}

/**
 * 自建种类的存储这个角色。
 *
 * 这里只留名字：磁盘实现是 kinds-disk.ts 里的 KindStore，
 * 浏览器端是 IndexedDB 版。两者共用同一个接口。
 */
export type KindStore = KindsStorePort;
