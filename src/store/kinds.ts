import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MATERIAL_KINDS } from "./project.ts";

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
const MAX_LABEL = 24;

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
	return cleaned || "custom-" + randomUUID().slice(0, 6);
}

/** 增删改的结果。带状态码，服务端直接拿去回话。 */
export type KindResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

function normalizeCustomKind(raw: unknown): CustomKind | undefined {
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
 * 自建种类的存储。
 *
 * 写法与素材库、设置一致：随机临时名 + rename + 重试，
 * 覆盖前留一份 .bak。种类表很短，但它一坏，全书的素材就都成了"其他"，
 * 所以备份不能省。
 */
export class KindStore {
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
				const tmp = this.file + "." + randomUUID() + ".tmp";
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
