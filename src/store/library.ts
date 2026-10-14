import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MATERIAL_KINDS, type Material, type MaterialKind, type MaterialStatus } from "./project.ts";

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

function normalizeLibraryMaterial(raw: unknown): LibraryMaterial | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<LibraryMaterial>;
	const now = Date.now();
	return {
		id: typeof input.id === "string" && input.id ? input.id : randomUUID(),
		kind: MATERIAL_KINDS.includes(input.kind as MaterialKind) ? (input.kind as MaterialKind) : "other",
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
		id: randomUUID(),
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
 * 通用素材库的持久化存储。
 *
 * 与工程分开一个文件：库是跨作品的东西，混进工程目录会让
 * ProjectStore 把它当成一部作品读进来。
 */
export class MaterialLibrary {
	private materials: LibraryMaterial[];
	private writeChain: Promise<void> = Promise.resolve();
	private readonly file: string;

	private constructor(file: string, materials: LibraryMaterial[]) {
		this.file = file;
		this.materials = materials;
	}

	static async open(dataDir: string): Promise<MaterialLibrary> {
		await mkdir(dataDir, { recursive: true });
		const file = path.join(dataDir, "library.json");
		const raw = await readFile(file, "utf8").catch(() => undefined);
		let materials: LibraryMaterial[] = [];
		if (raw !== undefined) {
			try {
				const parsed = JSON.parse(raw) as Partial<LibraryFile> | unknown[];
				const list = Array.isArray(parsed) ? parsed : parsed?.materials;
				materials = Array.isArray(list)
					? list.map(normalizeLibraryMaterial).filter((item): item is LibraryMaterial => item !== undefined)
					: [];
			} catch (error) {
				console.warn("[library] 解析 library.json 失败，按空库处理:", error);
			}
		}
		return new MaterialLibrary(file, materials);
	}

	list(): LibraryMaterial[] {
		return this.materials;
	}

	get(id: string): LibraryMaterial | undefined {
		return this.materials.find((material) => material.id === id);
	}

	/** 新建。返回落库后的条目。默认算已确认：库里的料是作者亲手收录的。 */
	create(input: LibraryMaterialInput): LibraryMaterial {
		const now = Date.now();
		const entry: LibraryMaterial = {
			id: randomUUID(),
			kind: MATERIAL_KINDS.includes(input.kind as MaterialKind) ? (input.kind as MaterialKind) : "other",
			title: input.title?.trim() || "未命名素材",
			content: input.content ?? "",
			tags: Array.isArray(input.tags) ? [...input.tags] : [],
			usage: input.usage ?? "",
			status: input.status === "draft" ? "draft" : "confirmed",
			createdAt: now,
			updatedAt: now,
		};
		this.materials.push(entry);
		void this.persist();
		return entry;
	}

	/** 改已有条目。未传的字段保持原样。 */
	update(id: string, input: LibraryMaterialInput): LibraryMaterial | undefined {
		const entry = this.get(id);
		if (!entry) return undefined;
		if (input.kind !== undefined && MATERIAL_KINDS.includes(input.kind)) entry.kind = input.kind;
		if (input.title !== undefined && input.title.trim()) entry.title = input.title.trim();
		if (input.content !== undefined) entry.content = input.content;
		if (input.usage !== undefined) entry.usage = input.usage;
		if (input.tags !== undefined) entry.tags = [...input.tags];
		if (input.status === "confirmed" || input.status === "draft") entry.status = input.status;
		entry.updatedAt = Date.now();
		void this.persist();
		return entry;
	}

	remove(id: string): boolean {
		const index = this.materials.findIndex((material) => material.id === id);
		if (index < 0) return false;
		this.materials.splice(index, 1);
		void this.persist();
		return true;
	}

	/**
	 * 串行化落盘，写法与设置一致：随机临时名 + rename + 重试。
	 * Windows 上 rename 覆盖已存在文件会偶发 EPERM，所以必须重试。
	 */
	private persist(): Promise<void> {
		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(async () => {
				const payload: LibraryFile = { materials: this.materials };
				const tmp = this.file + "." + randomUUID() + ".tmp";
				await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
				for (let attempt = 0; ; attempt++) {
					try {
						await rename(tmp, this.file);
						return;
					} catch (error) {
						if (attempt >= 4) throw error;
						await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
					}
				}
			})
			.catch((error) => console.error("[library] 落盘失败:", error))
			.then(() => undefined);
		return this.writeChain;
	}
}
