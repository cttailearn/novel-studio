/**
 * 作者自建素材种类的磁盘持久化实现。
 *
 * 纯模型（类型、名字转 id、归一化）在 kinds.ts —— 那一层不碰文件系统，
 * 所以浏览器端的 IndexedDB 实现可以照着同一个接口重写一遍。
 * 本文件只负责把那些模型落到 <dataDir>/kinds.json。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MATERIAL_KINDS, newId } from "./project.ts";
import {
	kindIdFromLabel,
	MAX_LABEL,
	normalizeCustomKind,
	type CustomKind,
	type KindFile,
	type KindResult,
} from "./kinds.ts";
import type { KindsStorePort } from "./store-port.ts";

/**
 * 自建种类的存储。
 *
 * 写法与素材库、设置一致：随机临时名 + rename + 重试，
 * 覆盖前留一份 .bak。种类表很短，但它一坏，全书的素材就都成了"其他"，
 * 所以备份不能省。
 */
export class KindStore implements KindsStorePort {
	/**
	 * 落盘路径。
	 *
	 * 这里刻意写成显式字段 + 构造函数赋值，而不是参数属性（`constructor(private x)`）：
	 * 本项目用 `node --experimental-strip-types` 跑，那是 strip-only 模式，
	 * 参数属性属于"要生成代码"的语法，会直接 SyntaxError 起不来服务。
	 */
	private readonly file: string;
	private kinds: CustomKind[];
	private writeChain: Promise<void> = Promise.resolve();

	private constructor(file: string, kinds: CustomKind[]) {
		this.file = file;
		this.kinds = kinds;
	}

	static async open(dataDir: string): Promise<KindStore> {
		await mkdir(dataDir, { recursive: true });
		const file = path.join(dataDir, "kinds.json");
		const raw = await readFile(file, "utf8").catch(() => undefined);
		let kinds: CustomKind[] = [];
		if (raw !== undefined) {
			try {
				const parsed = JSON.parse(raw) as Partial<KindFile> | unknown[];
				const list = Array.isArray(parsed) ? parsed : parsed?.kinds;
				kinds = Array.isArray(list)
					? list.map(normalizeCustomKind).filter((item): item is CustomKind => item !== undefined)
					: [];
			} catch (error) {
				// 损坏时隔离而不是就地覆盖：静默降级成空表之后，
				// 下一次 persist 就会拿空表盖住原文，素材的类别就再也认不出来了。
				const kept = file + ".corrupt";
				await rename(file, kept).catch(() => undefined);
				console.error(
					"[kinds] kinds.json 解析失败，已隔离为 " + path.basename(kept) + "，按空表启动。原文仍在 data/ 目录。:",
					error,
				);
			}
		}
		return new KindStore(file, kinds);
	}

	/** 全部自建种类，按添的先后排。 */
	list(): CustomKind[] {
		return this.kinds.map((item) => ({ ...item }));
	}

	/** 这个 id 是不是自建种类。 */
	has(id: string): boolean {
		return this.kinds.some((item) => item.id === id);
	}

	/**
	 * 添一个种类。
	 *
	 * 名字重了就不添 —— 两个同名种类会让智能体无从选择，
	 * 界面上也会出现两个一样的签。
	 */
	add(label: string): KindResult<CustomKind> {
		const name = label.trim();
		if (!name) return { ok: false, error: "种类名不能为空", status: 400 };
		if (name.length > MAX_LABEL) return { ok: false, error: "种类名太长了，控制在 " + MAX_LABEL + " 字以内", status: 400 };
		if (this.labelTaken(name, "")) {
			return { ok: false, error: "已经有「" + name + "」这一类了", status: 400 };
		}
		const id = this.uniqueId(kindIdFromLabel(name));
		const kind: CustomKind = { id, label: name, createdAt: Date.now() };
		this.kinds.push(kind);
		void this.persist();
		return { ok: true, value: { ...kind } };
	}

	/** 改名。id 不变，认出这条素材的是 id，显示给作者的是名字。 */
	rename(id: string, label: string): KindResult<CustomKind> {
		const name = label.trim();
		if (!name) return { ok: false, error: "种类名不能为空", status: 400 };
		if (name.length > MAX_LABEL) return { ok: false, error: "种类名太长了，控制在 " + MAX_LABEL + " 字以内", status: 400 };
		const target = this.kinds.find((item) => item.id === id);
		if (!target) return { ok: false, error: "没有这个种类", status: 404 };
		if (this.labelTaken(name, id)) {
			return { ok: false, error: "已经有「" + name + "」这一类了", status: 400 };
		}
		target.label = name;
		void this.persist();
		return { ok: true, value: { ...target } };
	}

	/** 删一个自建种类。内置种类不归这里管。 */
	remove(id: string): KindResult<CustomKind> {
		const index = this.kinds.findIndex((item) => item.id === id);
		if (index < 0) return { ok: false, error: "没有这个种类", status: 404 };
		const [removed] = this.kinds.splice(index, 1);
		void this.persist();
		return { ok: true, value: { ...(removed as CustomKind) } };
	}

	/** 名字是不是已经有人用了（ASCII 折叠大小写，中文原样比）。 */
	private labelTaken(label: string, exceptId: string): boolean {
		const key = label.toLowerCase();
		return this.kinds.some((item) => item.id !== exceptId && item.label.toLowerCase() === key);
	}

	/** 撞上已有的 id 就退一步：内置的加前缀，自建的加序号。 */
	private uniqueId(id: string): string {
		if (!(MATERIAL_KINDS as readonly string[]).includes(id)) {
			let candidate = id;
			let n = 2;
			while (this.kinds.some((item) => item.id === candidate)) {
				candidate = id + "-" + n;
				n += 1;
			}
			return candidate;
		}
		let candidate = "c-" + id;
		let n = 2;
		while (this.kinds.some((item) => item.id === candidate)) {
			candidate = "c-" + id + "-" + n;
			n += 1;
		}
		return candidate;
	}

	/**
	 * 串行化落盘，写法与素材库一致：随机临时名 + rename + 重试。
	 *
	 * Windows 上 rename 覆盖已存在文件会偶发 EPERM，所以必须重试；
	 * 覆盖前留一份 .bak —— 种类表一坏，全书的素材类别就认不出来了。
	 */
	private persist(): Promise<void> {
		const snapshot: KindFile = { kinds: this.kinds.map((item) => ({ ...item })) };
		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(async () => {
				const tmp = this.file + "." + newId() + ".tmp";
				await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
				await copyFile(this.file, this.file + ".bak").catch(() => undefined);
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
			.catch((error) => console.error("[kinds] 落盘失败:", error))
			.then(() => undefined);
		return this.writeChain;
	}
}
