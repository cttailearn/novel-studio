/**
 * 通用素材库的磁盘持久化实现。
 *
 * 纯模型（类型、归一化、取用与回推）在 library.ts —— 那一层不碰文件系统，
 * 所以浏览器端的 IndexedDB 实现（IdbMaterialLibrary）可以照着同一个接口重写一遍。
 * 本文件只负责把那些模型落到 <dataDir>/library.json。
 */
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isKnownKind, newId, type MaterialKind } from "./project.ts";
import {
	normalizeLibraryMaterial,
	type LibraryFile,
	type LibraryMaterial,
	type LibraryMaterialInput,
} from "./library.ts";
import type { LibraryStorePort } from "./store-port.ts";

/**
 * 通用素材库的持久化存储。
 *
 * 与工程分开一个文件：库是跨作品的东西，混进工程目录会让
 * ProjectStore 把它当成一部作品读进来。
 */
export class MaterialLibrary implements LibraryStorePort {
	private materials: LibraryMaterial[];
	private writeChain: Promise<void> = Promise.resolve();
	private dirty = false;
	private writeError: unknown;
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
				// 损坏时隔离而不是就地覆盖。通用素材库里同样可能有作者手写很久的条目，
				// 静默降级成空库之后，下一次 persist 就会拿空库覆盖原文 —— 那些条目永远没了。
				// 改名为 .corrupt 保留，用户确认后可自行改名恢复。
				const kept = file + ".corrupt";
				await rename(file, kept).catch(() => undefined);
				console.error(
					"[library] library.json 解析失败，已隔离为 " + path.basename(kept) + "，按空库启动。原文仍在 data/ 目录。:",
					error,
				);
			}
		}
		return new MaterialLibrary(file, materials);
	}

	/**
	 * 库条目。
	 *
	 * 返回副本而不是内部数组：早先这里直接 return this.materials，
	 * 调用方一个原地 sort/splice 就能把库改坏，而落盘时写的是同一个数组 ——
	 * 界面上看不见任何异常，磁盘上的条目却没了。
	 */
	list(): LibraryMaterial[] {
		return this.materials.map((entry) => ({ ...entry, tags: [...entry.tags] }));
	}

	get(id: string): LibraryMaterial | undefined {
		return this.materials.find((material) => material.id === id);
	}

	/** 新建。返回落库后的条目。默认算已确认：库里的料是作者亲手收录的。 */
	create(input: LibraryMaterialInput): LibraryMaterial {
		const now = Date.now();
		const entry: LibraryMaterial = {
			id: newId(),
			kind: isKnownKind(String(input.kind ?? "").trim()) ? (String(input.kind).trim() as MaterialKind) : "other",
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
		if (input.kind !== undefined && isKnownKind(String(input.kind).trim())) entry.kind = String(input.kind).trim() as MaterialKind;
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
	 *
	 * 覆盖前把当前内容留一份为 library.json.bak：库里可能有作者手写很久的条目，
	 * 一次误写就全没了，而库不像工程那样有快照可退。备份是这里唯一的退路，
	 * 所以哪怕多一次拷贝也要做。
	 */
	private persist(): Promise<void> {
		// 快照必须在调用这一刻拍，不能等链上轮到它再读 this.materials ——
		// payload 若只是引用，排队期间后续改动会把它一起改掉，
		// 于是每一次写入序列化的都是"最后那个状态"，备份也就永远等于当前内容。
		this.dirty = true;
		const snapshot: LibraryFile = { materials: this.materials.map((entry) => ({ ...entry, tags: [...entry.tags] })) };
		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(async () => {
				const tmp = this.file + "." + newId() + ".tmp";
				try {
					await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
					// 备份失败不该挡住正事：拿不到旧内容也要把新内容写下去。
					await copyFile(this.file, this.file + ".bak").catch(() => undefined);
					for (let attempt = 0; ; attempt++) {
						try {
							await rename(tmp, this.file);
							break;
						} catch (error) {
							if (attempt >= 4) throw error;
							await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
						}
					}
					this.dirty = false;
					this.writeError = undefined;
				} catch (error) {
					this.dirty = true;
					this.writeError = error;
					await rm(tmp, { force: true }).catch(() => undefined);
					console.error("[library] 落盘失败（已标记待重试）:", error);
				}
			});
		return this.writeChain;
	}

	/** 等全部已排队写入；本次或此前写入仍未落盘时抛错。 */
	async flush(): Promise<void> {
		await this.writeChain;
		if (!this.dirty) return;
		throw new Error("通用素材库仍有未落盘数据", { cause: this.writeError });
	}

	/** 不改内存地补写最近状态，供启动或显式恢复流程使用。 */
	async retryPending(): Promise<void> {
		await this.writeChain;
		if (this.dirty) this.persist();
		await this.flush();
	}
}
