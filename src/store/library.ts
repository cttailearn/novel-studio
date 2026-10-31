/**
 * 通用素材库的纯模型层：类型、归一化、取用与回推。
 *
 * 这一层不碰文件系统，因此可以原样搬进浏览器 ——
 * 浏览器端的 IndexedDB 版素材库（IdbMaterialLibrary）只需要实现同一个接口
 * （LibraryStorePort，见 store-port.ts）。
 * 磁盘实现见 library-disk.ts；两侧共用这里定义的数据形状与纯函数。
 */
import { isKnownKind, newId, type Material, type MaterialKind, type MaterialStatus } from "./project.ts";
import type { LibraryStorePort } from "./store-port.ts";

/**
 * 通用素材：不属于任何一部作品，可以被取用到多部作品里。
 *
 * 字段与作品内素材一致，只是没有 chapterIds —— 它不挂在任何章节上。
 * 取用是**复制**而不是引用，理由有三：
 *   1. 作者会为这本书改动副本（人物年龄、地名口径），改动不该反噬别的作品；
 *   2. 删掉库里的条目不该让已有作品缺料；
 *   3. 作品文件因此始终自包含，拷走一个 JSON 就是完整的一本书。
 * 复制时记下 originId，于是"这条料是从库里哪一条来的"可回溯，
 * 也才能支持把作品里的改动推回库里的那一条。
 */
export interface LibraryMaterial {
	id: string;
	kind: MaterialKind;
	title: string;
	content: string;
	tags: string[];
	usage: string;
	status: MaterialStatus;
	createdAt: number;
	updatedAt: number;
}

/** 库文件的形状。用对象包一层而不是裸数组，将来加字段不必改格式。 */
export interface LibraryFile {
	materials: LibraryMaterial[];
}

/** 归一化一条库条目。坏数据在这里被挡掉，不进内存。 */
export function normalizeLibraryMaterial(raw: unknown): LibraryMaterial | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<LibraryMaterial>;
	const now = Date.now();
	return {
		id: typeof input.id === "string" && input.id ? input.id : newId(),
		kind: isKnownKind(String(input.kind ?? "").trim()) ? (String(input.kind).trim() as MaterialKind) : "other",
		title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "未命名素材",
		content: typeof input.content === "string" ? input.content : "",
		tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [],
		usage: typeof input.usage === "string" ? input.usage : "",
		status: input.status === "confirmed" ? "confirmed" : "draft",
		createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
	};
}

/** 新建通用素材的入参。id 与时间戳由 store 负责。 */
export type LibraryMaterialInput = Partial<Omit<LibraryMaterial, "id" | "createdAt" | "updatedAt">>;

/**
 * 取用：库里的条目 → 作品内素材。
 *
 * 新 id、清空 chapterIds，并记下 originId 以便回溯与回推。
 * source 记为 library，界面据此显示"取自素材库"，与书者手写、墨客所拟区分开。
 */
export function materialFromLibrary(entry: LibraryMaterial): Material {
	const now = Date.now();
	return {
		id: newId(),
		kind: entry.kind,
		title: entry.title,
		content: entry.content,
		tags: [...entry.tags],
		usage: entry.usage,
		status: entry.status,
		chapterIds: [],
		source: "library",
		originId: entry.id,
		createdAt: now,
		updatedAt: now,
	};
}

/** 回推：作品内素材 → 库条目的字段（id 与时间戳由 store 决定）。 */
export function libraryFieldsOf(material: Material): LibraryMaterialInput {
	return {
		kind: material.kind,
		title: material.title,
		content: material.content,
		tags: [...material.tags],
		usage: material.usage,
		status: material.status,
	};
}

/**
 * 通用素材库这个角色。
 *
 * 这里只留名字：磁盘实现是 library-disk.ts 里的 MaterialLibrary，
 * 浏览器端是 IndexedDB 版。两者共用同一个接口，
 * 所以依赖它的地方（AI 工具层、提示词）不必知道自己连的是哪一个。
 */
export type MaterialLibrary = LibraryStorePort;
