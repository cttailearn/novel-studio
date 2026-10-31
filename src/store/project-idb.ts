/**
 * 小说工程的 IndexedDB 实现（浏览器端，多用户模式）。
 *
 * 与 project-disk.ts 的磁盘版行为等价，落点却换了个地方：
 * 工程、正文、历史、快照、回收站全部躺在用户自己浏览器的 IndexedDB 里，
 * 服务器不落盘、不持有、不共享 —— 这是"多用户模式"最核心的一条承诺。
 *
 * 两处与磁盘版不同的地方，都是环境逼出来的：
 *
 * 1. 端口是同步的，IndexedDB 是异步的。
 *    ProjectStorePort 的 list/get/create/mutate/stats 都是同步方法
 *    （src/ai/novel-agent.ts 每轮都同步读 store.get(projectId)），
 *    而 IndexedDB 的每一次读写都是 Promise。折中办法：骨架常驻内存
 *    （Map<string, Project>），开库时一次性装载；同步方法读内存，
 *    落盘在背后按工程排队。正文不常驻内存 —— 按需从 draftBodies 取，
 *    与磁盘版"正文在盘上、不在骨架里"的形状一致。
 *
 * 2. 一次写入就是一次事务。
 *    磁盘版要把正文、历史、元数据分别写成三个文件，靠 rename 的原子性兜底；
 *    IndexedDB 里三者可以放进同一个事务，崩溃永远不会留下半写的章节。
 */
import {
	MAX_DRAFT_HISTORY,
	countWords,
	emptyProject,
	encodeFileName,
	newId,
	normalizeProject,
	projectStats,
	type ChapterMeta,
	type DeletedProject,
	type DraftBody,
	type DraftRevision,
	type Project,
	type ProjectStats,
} from "./project.ts";
import type {
	ProjectCreateInput,
	ProjectStorePort,
	SaveDraftBodyInput,
	SnapshotContent,
	SnapshotInfo,
} from "./store-port.ts";

// ───────────────────────────────────────────── IndexedDB 的最小结构类型
//
// 这个仓库的 tsconfig 只有 lib: ES2023（没有 DOM），@types/node 也不提供
// IndexedDB 类型，所以这里自己声明一套最小结构类型。浏览器里真的 indexedDB
// 是全局变量，用 (globalThis as { indexedDB?: IDBFactory }).indexedDB 取；
// 因为都是结构类型，把真 indexedDB 直接传进构造函数也能用。

/** IndexedDB 事件回调。事件对象用 any：两侧的事件类型不同，这里不读它的内容。 */
export type IdbEventHandler = (event: any) => void;

export interface IDBRequest<T = unknown> {
	readonly result: T;
	readonly error: unknown;
	onsuccess: IdbEventHandler | null;
	onerror: IdbEventHandler | null;
}

export interface IDBIndex {
	readonly name: string;
	get(query?: unknown): IDBRequest<unknown>;
	getAll(query?: unknown): IDBRequest<unknown[]>;
	count(query?: unknown): IDBRequest<number>;
}

export interface IDBObjectStore {
	readonly name: string;
	readonly keyPath: string | string[];
	put(value: unknown, key?: unknown): IDBRequest<unknown>;
	get(key: unknown): IDBRequest<unknown>;
	delete(key: unknown): IDBRequest<unknown>;
	getAll(query?: unknown): IDBRequest<unknown[]>;
	clear(): IDBRequest<unknown>;
	count(query?: unknown): IDBRequest<number>;
	createIndex(name: string, keyPath: string | string[], options?: { unique?: boolean }): IDBIndex;
	index(name: string): IDBIndex;
}

export interface IDBTransaction {
	readonly mode: "readonly" | "readwrite" | "versionchange";
	readonly objectStoreNames: { readonly length: number; contains(name: string): boolean };
	readonly error: unknown;
	objectStore(name: string): IDBObjectStore;
	abort(): void;
	oncomplete: IdbEventHandler | null;
	onerror: IdbEventHandler | null;
	onabort: IdbEventHandler | null;
}

export interface IDBDatabase {
	readonly name: string;
	readonly version: number;
	readonly objectStoreNames: { readonly length: number; contains(name: string): boolean };
	createObjectStore(name: string, options?: { keyPath?: string | string[] }): IDBObjectStore;
	transaction(names: string | string[], mode?: "readonly" | "readwrite"): IDBTransaction;
	close(): void;
	onversionchange?: IdbEventHandler | null;
}

export interface IDBOpenDBRequest extends IDBRequest<IDBDatabase> {
	readonly transaction: IDBTransaction | null;
	onupgradeneeded: IdbEventHandler | null;
}

export interface IDBFactory {
	open(name: string, version?: number): IDBOpenDBRequest;
	deleteDatabase(name: string): IDBRequest<unknown>;
}

// ───────────────────────────────────────────── 表结构

/** 数据库名。 */
const DEFAULT_DB_NAME = "novel-studio";

/** 库版本。改了表结构就 +1，升级时补建新的 object store。 */
const DB_VERSION = 1;

/** 每部作品保留的快照数上限。与磁盘版一致。导出是为了让验收脚本能对上这个数。 */
export const MAX_SNAPSHOTS = 20;

/** 一个 object store 的定义：名字、主键、以及建在它身上的索引。 */
interface StoreSpec {
	name: string;
	keyPath: string | string[];
	indexes: { name: string; keyPath: string | string[] }[];
}

/**
 * 表结构。骨架与正文分表，是磁盘版"骨架一份、正文按章一份"的直译。
 *
 * 与 docs/multi-user-browser-local-plan.md 里的草案有一处不同：
 * 草案把章节元数据单独放一张 draftMetas 表，本实现把元数据留在骨架的
 * drafts 里（骨架本来就只带元数据、不带正文），少一张表少一层同步。
 */
const STORE_SPECS: StoreSpec[] = [
	// 骨架：卷、大纲、素材、备注与各章元数据。对应磁盘版的 data/<pid>.json。
	{ name: "projects", keyPath: "id", indexes: [{ name: "updatedAt", keyPath: "updatedAt" }] },
	// 正文：对应磁盘版的 data/drafts/<pid>/<enc>.txt。
	{ name: "draftBodies", keyPath: ["projectId", "chapterId"], indexes: [{ name: "projectId", keyPath: "projectId" }] },
	// 历史：对应磁盘版的 data/drafts/<pid>/<enc>.hist/<rev>.json。
	{
		name: "draftHistory",
		keyPath: ["projectId", "chapterId", "revision"],
		indexes: [
			{ name: "projectId", keyPath: "projectId" },
			{ name: "chapter", keyPath: ["projectId", "chapterId"] },
		],
	},
	// 快照：对应磁盘版的 data/snapshots/<pid>/*.json.gz。
	{ name: "snapshots", keyPath: ["projectId", "name"], indexes: [{ name: "projectId", keyPath: "projectId" }] },
	// 回收站：对应磁盘版的 data/trash/<pid>/。整部工程连正文带快照一起放这儿。
	{ name: "trash", keyPath: "id", indexes: [] },
];

/** 正文行。 */
interface DraftBodyRow {
	projectId: string;
	chapterId: string;
	content: string;
	revision: number;
	updatedAt: number;
}

/**
 * 历史行。
 *
 * 除了任务书里列的字段，额外存了 materialIds 与 mode：
 * DraftRevision 这两栏（当时装配了哪些料、哪次作业触发的）不回滚就没法回溯。
 */
interface DraftHistoryRow {
	projectId: string;
	chapterId: string;
	revision: number;
	content: string;
	title: string;
	summary: string;
	at: number;
	materialIds: string[];
	mode: string;
}

/** 快照行。content 就是 SnapshotContent：骨架一份，各章正文一份。 */
interface SnapshotRow {
	projectId: string;
	name: string;
	at: number;
	label: string;
	size: number;
	content: SnapshotContent;
}

/** 回收站行：够把一部作品原样搬回来。 */
interface TrashRow {
	id: string;
	deletedAt: number;
	project: Project;
	bodies: Record<string, DraftBody>;
	snapshots: SnapshotRow[];
}

/** 某部作品尚未落库的部分：骨架与失败章分开记。 */
interface PendingWrites {
	/** 骨架（素材、大纲、备注）是否需要重写。 */
	project: boolean;
	/** 哪几章的正文没写成功。 */
	chapters: Set<string>;
}

// ───────────────────────────────────────────── 存储本体

export interface IdbProjectStoreOptions {
	/** Defaults to globalThis.indexedDB. Injectable for tests. */
	indexedDB?: IDBFactory;
	/** Database name, default "novel-studio". */
	name?: string;
}

/**
 * 小说工程的 IndexedDB 存储。
 *
 * 骨架常驻内存（同步读），正文按需取（异步读），写入按工程排队（异步落）。
 */
export class IdbProjectStore implements ProjectStorePort {
	/** 骨架缓存：端口里的同步方法读它。 */
	private readonly projects = new Map<string, Project>();
	/** 同一工程的写入串行化，避免并发写相互覆盖。 */
	private readonly writeChains = new Map<string, Promise<void>>();
	/** 按章的写锁队列，键为 "projectId::chapterId"。 */
	private readonly chapterChains = new Map<string, Promise<unknown>>();
	/**
	 * 尚未落库的部分：骨架与失败章分开记。
	 * 存上才算数，所以失败必须留痕；又因为正文单独一张表，
	 * 失败必须按章记 —— 否则一次成功写入会把上一次失败、这一轮根本没重试的章
	 * 一并从待重试里清掉。
	 */
	private readonly dirty = new Map<string, PendingWrites>();
	/**
	 * 上一轮没写进库的正文（工程 id → 章 id → 原文）。
	 * 原文还在手里才等得到补写；只留一个标记不济事 —— 原文没了就再也补不回来。
	 */
	private readonly pendingBodies = new Map<string, Map<string, SaveDraftBodyInput>>();
	/** 最近一次写入异常，按工程保留，供 flush 把后台失败传回调用方。 */
	private readonly writeErrors = new Map<string, unknown>();

	private factory: IDBFactory | undefined;
	private readonly dbName: string;
	private db: IDBDatabase | undefined;
	private opening: Promise<IDBDatabase> | undefined;

	constructor(options: IdbProjectStoreOptions = {}) {
		this.factory = options.indexedDB;
		this.dbName = options.name?.trim() || DEFAULT_DB_NAME;
	}

	/**
	 * 开库：建表（必要时升级）并把骨架装进内存缓存。
	 *
	 * open() 之前 indexedDB 全局还不存在也不要紧 —— 只要注入了实现。
	 */
	static async open(options?: IdbProjectStoreOptions): Promise<IdbProjectStore> {
		const store = new IdbProjectStore(options);
		await store.ensureOpen();
		return store;
	}

	/** 关掉连接（切页面、退出时用）。缓存里的骨架仍在。 */
	close(): void {
		this.db?.close();
		this.db = undefined;
		this.opening = undefined;
	}

	// ───────────────────────── 同步部分：读内存

	list(): Project[] {
		return [...this.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): Project | undefined {
		return this.projects.get(id);
	}

	create(input?: ProjectCreateInput): Project {
		const project = emptyProject(input);
		this.projects.set(project.id, project);
		void this.persist(project);
		return project;
	}

	/**
	 * 在原对象上实施变更并落盘。传入的对象不应在外部长期持有。
	 *
	 * 这里只管骨架（卷、大纲、素材、备注）。正文另有落点：
	 * 走 saveDraftBody，它自己写正文与历史并更新元数据。
	 */
	mutate(id: string, mutate: (project: Project) => void): Project {
		const project = this.projects.get(id);
		if (!project) throw new Error("工程 " + id + " 不存在");
		mutate(project);
		project.updatedAt = Date.now();
		void this.persist(project);
		return project;
	}

	stats(project: Project): ProjectStats {
		return projectStats(project);
	}

	// ───────────────────────── 落盘队列

	/**
	 * 把一个写入任务挂到该工程的队列上：同一工程的写入严格串行。
	 *
	 * 骨架落盘与正文落盘都走这里，所以两者不会交叉：
	 * 骨架写出去的那一刻，正文那次事务要么已经提交、要么还没开始。
	 */
	private enqueueWrite(projectId: string, task: () => Promise<void>): Promise<void> {
		const previous = this.writeChains.get(projectId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);
		// 队列里只留"不会抛"的尾巴：真正的失败由各自的任务接住并留下痕迹。
		this.writeChains.set(
			projectId,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	/**
	 * 落骨架。失败不静默：挂 dirty 标记，等 retryPending 补写。
	 * 否则调用方（接口照样返回 200）无从得知这一稿其实没存上。
	 */
	private persist(project: Project): Promise<void> {
		return this.enqueueWrite(project.id, async () => {
			try {
				await this.putRow("projects", project);
				this.clearDirtyProject(project.id);
				if (!this.dirty.has(project.id)) this.writeErrors.delete(project.id);
			} catch (error) {
				this.markDirtyProject(project.id);
				this.writeErrors.set(project.id, error);
				console.error("[store] 写入工程 " + project.id + " 失败（已标记待重试）:", error);
			}
		});
	}

	/**
	 * 等指定工程排队中的写入做完；若本次或此前写入仍未落库则抛错。
	 * 同步的 create/mutate 可继续原样使用，需要确认落盘的调用方 await 此方法。
	 */
	async flushForProject(id: string): Promise<void> {
		const chain = this.writeChains.get(id);
		if (chain) await chain;
		const pending = this.dirty.get(id);
		if (!pending) return;
		const cause = this.writeErrors.get(id);
		throw new Error("工程 " + id + " 仍有未落盘数据", { cause });
	}

	/** 等全部后台写入完成；任何工程仍有 dirty 数据都会抛错。 */
	async flush(): Promise<void> {
		await Promise.all([...this.writeChains.values()]);
		for (const id of [...this.dirty.keys()]) await this.flushForProject(id);
	}

	/**
	 * 同一章节的写入串行化。
	 *
	 * 智能体的 write_chapter 与作者在稿面直接保存都会整段覆盖同一章。
	 * 两边并发时后写者会静默吞掉先写者，因此共用一把按章的锁。
	 */
	async withChapterLock<T>(id: string, chapterId: string, fn: () => Promise<T> | T): Promise<T> {
		const key = id + "::" + chapterId;
		const previous = this.chapterChains.get(key) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		this.chapterChains.set(
			key,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	// ───────────────────────── 正文

	/**
	 * 写一章正文，落成元数据。
	 *
	 * 磁盘版把正文、历史、元数据分别写成三个文件；这里三者放进同一个事务：
	 * draftBodies（正文）+ draftHistory（归档的旧稿）+ projects（带新元数据的骨架）
	 * 在一个 readwrite 事务里落盘，要么全成、要么全不成 ——
	 * 崩溃不会留下"元数据说有正文、正文却不在"的半截章节。
	 */
	async saveDraftBody(
		projectId: string,
		chapterId: string,
		input: SaveDraftBodyInput,
	): Promise<ChapterMeta> {
		try {
			return await this.writeDraftBody(projectId, chapterId, input);
		} catch (error) {
			// 写不进去就把原文留在手里，等 retryPending 补写。
			this.markDirtyChapter(projectId, chapterId);
			this.writeErrors.set(projectId, error);
			let chapters = this.pendingBodies.get(projectId);
			if (!chapters) {
				chapters = new Map<string, SaveDraftBodyInput>();
				this.pendingBodies.set(projectId, chapters);
			}
			chapters.set(chapterId, { ...input });
			throw error;
		}
	}

	private async writeDraftBody(
		projectId: string,
		chapterId: string,
		input: SaveDraftBodyInput,
	): Promise<ChapterMeta> {
		const project = this.projects.get(projectId);
		if (!project) throw new Error("工程 " + projectId + " 不存在");
		const existingMeta = project.drafts[chapterId];
		// 自动存稿不需要历史：绝不能为了"不使用它"而先把全部历史读进内存。
		// 这里只读旧正文；保留历史仍留在库里，下面也不会逐个重写。
		const existingBody = await this.readDraftBody(projectId, chapterId, {
			history: input.keepHistory !== false,
		});
		const oldContent = existingBody?.content ?? "";
		const content = input.content;
		// 内容没变就不留版本：连点两次"存稿"不该产生一份重复历史。
		const changed = oldContent.trim() !== content.trim();
		const history: DraftRevision[] = [...(existingBody?.history ?? [])];
		let archived: DraftRevision | undefined;
		if (existingMeta && oldContent.trim() && input.keepHistory !== false && changed) {
			archived = {
				revision: existingMeta.revision,
				title: existingMeta.title,
				content: oldContent,
				materialIds: existingMeta.materialIds,
				updatedAt: existingMeta.updatedAt,
				mode: input.mode ?? "manual",
			};
			history.push(archived);
		}
		while (history.length > MAX_DRAFT_HISTORY) history.shift();

		const meta: ChapterMeta = {
			id: chapterId,
			title: input.title,
			summary: input.summary ?? existingMeta?.summary ?? "",
			words: countWords(content),
			revision: (existingMeta?.revision ?? 0) + 1,
			updatedAt: Date.now(),
			materialIds: input.materialIds ?? existingMeta?.materialIds ?? [],
			hasDraft: content.length > 0,
		};

		// 留存的版本号：被挤出上限的那几版要删掉。
		const keep = new Set(history.map((revision) => revision.revision));
		const dropped = (existingBody?.history ?? [])
			.map((revision) => revision.revision)
			.filter((revision) => !keep.has(revision));

		await this.enqueueWrite(projectId, async () => {
			const db = await this.ensureOpen();
			await this.runTransaction(db, ["draftBodies", "draftHistory", "projects"], (tx) => {
				const bodies = tx.objectStore("draftBodies");
				const historyStore = tx.objectStore("draftHistory");
				const projects = tx.objectStore("projects");
				bodies.put({
					projectId,
					chapterId,
					content,
					revision: meta.revision,
					updatedAt: meta.updatedAt,
				} satisfies DraftBodyRow);
				if (input.keepHistory !== false) {
					// 只新增当前旧版，保留的历史原样不动：
					// 逐个重写保留历史会把 O(1) 的存稿变成 O(历史总字数)。
					if (archived) {
						historyStore.put({
							projectId,
							chapterId,
							revision: archived.revision,
							content: archived.content,
							title: archived.title,
							summary: existingMeta?.summary ?? "",
							at: archived.updatedAt,
							materialIds: archived.materialIds,
							mode: archived.mode,
						} satisfies DraftHistoryRow);
					}
					for (const revision of dropped) historyStore.delete([projectId, chapterId, revision]);
				}
				// 骨架与正文、历史同属一个事务：要么一起成，要么一起不成。
				projects.put({
					...project,
					drafts: { ...project.drafts, [chapterId]: meta },
					updatedAt: meta.updatedAt,
				});
			});
			// 事务提交之后才改内存：与磁盘版"先落盘、后更新内存"的顺序一致。
			project.drafts[chapterId] = meta;
			project.updatedAt = meta.updatedAt;
			// 写成功了：撤下这一章的待重试标记，也不再留着原文副本。
			this.clearDirtyChapter(projectId, chapterId);
			if (!this.dirty.has(projectId)) this.writeErrors.delete(projectId);
			const pending = this.pendingBodies.get(projectId);
			if (pending) {
				pending.delete(chapterId);
				if (pending.size === 0) this.pendingBodies.delete(projectId);
			}
		});
		return meta;
	}

	/**
	 * 读一章的正文与历史。按需从库里取，不常驻内存。
	 *
	 * 没有正文行但骨架里有这一章：返回空正文（与磁盘版一致 ——
	 * 界面照样认得这一章，只是还没写）。
	 */
	async readDraftBody(
		projectId: string,
		chapterId: string,
		options: { history?: boolean } = {},
	): Promise<DraftBody | undefined> {
		const meta = this.projects.get(projectId)?.drafts[chapterId];
		const db = await this.ensureOpen();
		const row = await this.readOne<DraftBodyRow>(db, "draftBodies", [projectId, chapterId]);
		let history: DraftRevision[] = [];
		if (options.history) {
			const rows = await this.readIndex<DraftHistoryRow>(db, "draftHistory", "chapter", [
				projectId,
				chapterId,
			]);
			history = rows
				.map((item) => ({
					revision: item.revision,
					title: item.title,
					content: item.content,
					materialIds: Array.isArray(item.materialIds) ? item.materialIds : [],
					updatedAt: item.at,
					mode: typeof item.mode === "string" ? item.mode : "manual",
				}))
				.sort((a, b) => a.revision - b.revision);
		}
		if (row) return { content: row.content, history };
		return meta ? { content: "", history } : undefined;
	}

	// ───────────────────────── 快照

	/**
	 * 给整部作品拍一份快照。
	 *
	 * 章节内的 history 只覆盖"这一章被反复覆盖"，管不到误删素材、误改大纲、
	 * 误删整部作品。快照是工程级的退路：调用方在破坏性操作前先拍一份，
	 * 出问题能整本回滚。快照带正文，回滚要把两者一起退回去。
	 */
	async snapshot(project: Project, label = ""): Promise<string> {
		const db = await this.ensureOpen();
		const existing = await this.readIndex<SnapshotRow>(db, "snapshots", "projectId", project.id);
		// 正文按需取：快照是显式动作，才付这个读取代价。
		const bodies: Record<string, DraftBody> = {};
		for (const chapterId of Object.keys(project.drafts)) {
			const body = await this.readDraftBody(project.id, chapterId, { history: true });
			if (body) bodies[chapterId] = body;
		}
		const content: SnapshotContent = { project, bodies };
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const base = stamp + (label ? "-" + encodeFileName(label) : "");
		const name = uniqueName(base, existing.map((row) => row.name));
		const row: SnapshotRow = {
			projectId: project.id,
			name,
			at: Date.now(),
			label,
			size: jsonSize(content),
			content,
		};
		// 快照只留最近若干份，旧的清掉，避免浏览器存储无限膨胀。
		// 文件名以 ISO 时间戳开头，字典序即时间序。
		const all = [...existing, row].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		const dropped = all.slice(0, Math.max(0, all.length - MAX_SNAPSHOTS));
		await this.runTransaction(db, ["snapshots"], (tx) => {
			const store = tx.objectStore("snapshots");
			store.put(row);
			for (const old of dropped) store.delete([old.projectId, old.name]);
		});
		return name;
	}

	/** 列出某部作品的快照，最新的在前。 */
	async listSnapshots(projectId: string): Promise<SnapshotInfo[]> {
		const db = await this.ensureOpen();
		const rows = await this.readIndex<SnapshotRow>(db, "snapshots", "projectId", projectId);
		return rows
			.map((row) => ({ name: row.name, at: row.at, size: row.size }))
			.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
	}

	/** 读回一份快照。数据损坏时返回 undefined 而不是抛错。 */
	async readSnapshot(projectId: string, name: string): Promise<SnapshotContent | undefined> {
		// 名字来自 listSnapshots，但仍要挡一手路径穿越。
		if (name.includes("/") || name.includes("\\") || name.includes("..")) return undefined;
		const db = await this.ensureOpen();
		const row = await this.readOne<SnapshotRow>(db, "snapshots", [projectId, name]);
		if (!row || !row.content) return undefined;
		const project = normalizeProject(row.content.project);
		const bodies: Record<string, DraftBody> = {};
		for (const [chapterId, body] of Object.entries(row.content.bodies ?? {})) {
			if (!body || typeof body.content !== "string") continue;
			bodies[chapterId] = {
				content: body.content,
				history: Array.isArray(body.history) ? body.history : [],
			};
		}
		return { project, bodies };
	}

	// ───────────────────────── 回收站

	/**
	 * 删除工程。默认把骨架、正文、历史与快照整体移进回收站，
	 * 因而无需调用方先拍快照也能恢复。传 { permanent: true } 才永久删除。
	 */
	async remove(id: string, options: { permanent?: boolean } = {}): Promise<void> {
		// 先等已经排队的写入，避免 remove 与后台写入交错造成半份回收站。
		const chain = this.writeChains.get(id);
		if (chain) await chain;
		const project = this.projects.get(id);
		if (!project) throw new Error("工程 " + id + " 不存在");
		// 回收站必须拿到完整内存状态，不能把此前失败的 dirty 数据静默丢掉。
		await this.flushForProject(id);
		const db = await this.ensureOpen();
		const bodyRows = await this.readIndex<DraftBodyRow>(db, "draftBodies", "projectId", id);
		const historyRows = await this.readIndex<DraftHistoryRow>(db, "draftHistory", "projectId", id);
		const snapshotRows = await this.readIndex<SnapshotRow>(db, "snapshots", "projectId", id);

		if (options.permanent) {
			await this.runTransaction(db, ["projects", "draftBodies", "draftHistory", "snapshots"], (tx) => {
				tx.objectStore("projects").delete(id);
				for (const row of bodyRows) tx.objectStore("draftBodies").delete([row.projectId, row.chapterId]);
				for (const row of historyRows) {
					tx.objectStore("draftHistory").delete([row.projectId, row.chapterId, row.revision]);
				}
				for (const row of snapshotRows) tx.objectStore("snapshots").delete([row.projectId, row.name]);
			});
			this.forget(id);
			return;
		}

		const trashed = await this.readOne<TrashRow>(db, "trash", id);
		if (trashed) throw new Error("回收站中已存在工程 " + id + "，未执行删除");
		const bodies: Record<string, DraftBody> = {};
		for (const row of bodyRows) {
			const body = await this.readDraftBody(id, row.chapterId, { history: true });
			if (body) bodies[row.chapterId] = body;
		}
		const trashRow: TrashRow = { id, deletedAt: Date.now(), project, bodies, snapshots: snapshotRows };
		// 移入回收站与从活动区删除在同一个事务里：不会留下"回收站有一半、活动区还有一半"。
		await this.runTransaction(
			db,
			["trash", "projects", "draftBodies", "draftHistory", "snapshots"],
			(tx) => {
				tx.objectStore("trash").put(trashRow);
				tx.objectStore("projects").delete(id);
				for (const row of bodyRows) tx.objectStore("draftBodies").delete([row.projectId, row.chapterId]);
				for (const row of historyRows) {
					tx.objectStore("draftHistory").delete([row.projectId, row.chapterId, row.revision]);
				}
				for (const row of snapshotRows) tx.objectStore("snapshots").delete([row.projectId, row.name]);
			},
		);
		this.forget(id);
	}

	/** 回收站列表，最新的在前。 */
	async listDeleted(): Promise<DeletedProject[]> {
		const db = await this.ensureOpen();
		const rows = await this.readAll<TrashRow>(db, "trash");
		return rows
			.filter((row) => row && typeof row.id === "string")
			.map((row) => ({
				id: row.id,
				title: row.project?.title ?? "",
				deletedAt: typeof row.deletedAt === "number" ? row.deletedAt : 0,
			}))
			.sort((a, b) => b.deletedAt - a.deletedAt);
	}

	/** 从回收站恢复整部作品，包含正文、历史和快照。 */
	async restoreDeleted(id: string): Promise<Project> {
		if (this.projects.has(id)) throw new Error("工程 " + id + " 已存在");
		const db = await this.ensureOpen();
		const row = await this.readOne<TrashRow>(db, "trash", id);
		if (!row) throw new Error("回收站中不存在工程 " + id);
		const project = normalizeProject(row.project);
		const bodyRows: DraftBodyRow[] = [];
		const historyRows: DraftHistoryRow[] = [];
		for (const [chapterId, body] of Object.entries(row.bodies ?? {})) {
			const meta = project.drafts[chapterId];
			bodyRows.push({
				projectId: id,
				chapterId,
				content: body.content,
				revision: meta?.revision ?? 1,
				updatedAt: meta?.updatedAt ?? Date.now(),
			});
			for (const revision of body.history ?? []) {
				historyRows.push({
					projectId: id,
					chapterId,
					revision: revision.revision,
					content: revision.content,
					title: revision.title,
					summary: meta?.summary ?? "",
					at: revision.updatedAt,
					materialIds: Array.isArray(revision.materialIds) ? revision.materialIds : [],
					mode: revision.mode ?? "manual",
				});
			}
		}
		await this.runTransaction(
			db,
			["trash", "projects", "draftBodies", "draftHistory", "snapshots"],
			(tx) => {
				tx.objectStore("projects").put(project);
				for (const bodyRow of bodyRows) tx.objectStore("draftBodies").put(bodyRow);
				for (const historyRow of historyRows) tx.objectStore("draftHistory").put(historyRow);
				for (const snapshot of row.snapshots ?? []) tx.objectStore("snapshots").put(snapshot);
				tx.objectStore("trash").delete(id);
			},
		);
		this.projects.set(id, project);
		return project;
	}

	// ───────────────────────── 待重试

	/**
	 * 重试挂起工程的落盘。
	 *
	 * 磁盘满、配额耗尽这类故障常常是暂时的。让启动流程和显式调用都过一遍这里，
	 * 用户不用等到下次编辑才发现上一稿没存上。
	 */
	async retryPending(): Promise<void> {
		for (const [id] of [...this.dirty]) {
			const project = this.projects.get(id);
			if (!project) {
				this.dirty.delete(id);
				continue;
			}
			// 正文写在别处，骨架无论如何都会再写一遍。
			await this.persist(project);
		}
		// 上一轮没写进库的正文：手里还留着原文，趁这时补写。
		for (const [projectId, chapters] of [...this.pendingBodies]) {
			for (const [chapterId, body] of [...chapters]) {
				try {
					await this.saveDraftBody(projectId, chapterId, body);
					chapters.delete(chapterId);
					this.clearDirtyChapter(projectId, chapterId);
				} catch (error) {
					console.error("[store] 补写章节正文仍失败（已标记待重试）:", error);
				}
			}
			if (chapters.size === 0) this.pendingBodies.delete(projectId);
		}
	}

	/** 还有哪些工程没存上，供接口查询。 */
	pendingWrites(): string[] {
		return [...this.dirty.keys()];
	}

	/**
	 * 具体是哪几章没存上。骨架失败时该工程仍会出现在 pendingWrites 里，
	 * 这里的章节表可能为空 —— 接口把两者都给出去，前端只用前者。
	 */
	pendingChapterWrites(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [id, pending] of this.dirty) out[id] = [...pending.chapters];
		return out;
	}

	private pendingOf(projectId: string): PendingWrites {
		let pending = this.dirty.get(projectId);
		if (!pending) {
			pending = { project: false, chapters: new Set<string>() };
			this.dirty.set(projectId, pending);
		}
		return pending;
	}

	/** 记下某一章没写进库。 */
	private markDirtyChapter(projectId: string, chapterId: string): void {
		this.pendingOf(projectId).chapters.add(chapterId);
	}

	/** 记下骨架没写进库。 */
	private markDirtyProject(projectId: string): void {
		this.pendingOf(projectId).project = true;
	}

	/** 某章写成功只摘这一章的标记，别的失败章继续留着。 */
	private clearDirtyChapter(projectId: string, chapterId: string): void {
		const pending = this.dirty.get(projectId);
		if (!pending) return;
		pending.chapters.delete(chapterId);
		this.dropDirtyIfClean(projectId, pending);
	}

	/** 骨架写成功只摘骨架的标记。 */
	private clearDirtyProject(projectId: string): void {
		const pending = this.dirty.get(projectId);
		if (!pending) return;
		pending.project = false;
		this.dropDirtyIfClean(projectId, pending);
	}

	private dropDirtyIfClean(projectId: string, pending: PendingWrites): void {
		if (!pending.project && pending.chapters.size === 0) this.dirty.delete(projectId);
	}

	/** 从内存里忘掉一部工程（删除或移入回收站之后）。 */
	private forget(id: string): void {
		this.projects.delete(id);
		this.dirty.delete(id);
		this.pendingBodies.delete(id);
		this.writeErrors.delete(id);
		this.writeChains.delete(id);
	}

	// ───────────────────────── 库与事务

	/** 取到库；没开就开一次。 */
	private ensureOpen(): Promise<IDBDatabase> {
		if (!this.opening) {
			this.opening = this.openDatabase().then(async (db) => {
				this.db = db;
				await this.loadSkeletons(db);
				return db;
			});
			// 不 await 的人不该看到 unhandled rejection；真正 await 的人仍会拿到错误。
			void this.opening.catch(() => undefined);
		}
		return this.opening;
	}

	private resolveFactory(): IDBFactory {
		if (this.factory) return this.factory;
		const global = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
		if (!global) {
			throw new Error(
				"当前环境没有 IndexedDB：浏览器端实现需要 indexedDB，Node 里请注入一个实现（如 idb-test-double）",
			);
		}
		this.factory = global;
		return global;
	}

	private openDatabase(): Promise<IDBDatabase> {
		const factory = this.resolveFactory();
		return new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(this.dbName, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				for (const spec of STORE_SPECS) {
					if (db.objectStoreNames.contains(spec.name)) continue;
					const store = db.createObjectStore(spec.name, { keyPath: spec.keyPath });
					for (const index of spec.indexes) store.createIndex(index.name, index.keyPath, { unique: false });
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => db.close();
				resolve(db);
			};
			request.onerror = () => reject(request.error ?? new Error("打开 IndexedDB 失败：" + this.dbName));
		});
	}

	/** 把库里的骨架装进内存缓存。归一化，老工程的形状也认得。 */
	private async loadSkeletons(db: IDBDatabase): Promise<void> {
		const rows = await this.readAll<Project>(db, "projects");
		for (const row of rows) {
			const project = normalizeProject(row);
			// 内存里已有的（刚 create 出来的）不覆盖：内存更新。
			if (!this.projects.has(project.id)) this.projects.set(project.id, project);
		}
	}

	/** 写一行。 */
	private async putRow(store: string, value: unknown): Promise<void> {
		const db = await this.ensureOpen();
		await this.runTransaction(db, [store], (tx) => {
			tx.objectStore(store).put(value);
		});
	}

	/**
	 * 跑一个读写事务。
	 *
	 * body 里只发请求、不 await：真实 IndexedDB 里事务一旦空转就会自动提交，
	 * 在事务中间 await 别的 Promise 是拿不到事务的。
	 */
	private runTransaction(
		db: IDBDatabase,
		stores: string[],
		body: (tx: IDBTransaction) => void,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(stores, "readwrite");
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
			try {
				body(tx);
			} catch (error) {
				try {
					tx.abort();
				} catch {
					// 事务已经结束了，报错也没意义。
				}
				reject(error);
			}
		});
	}

	/** 读一行。 */
	private readOne<T>(db: IDBDatabase, store: string, key: unknown): Promise<T | undefined> {
		return new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(store, "readonly");
			const request = tx.objectStore(store).get(key);
			request.onsuccess = () => resolve(request.result as T | undefined);
			request.onerror = () => reject(request.error ?? new Error("读取 " + store + " 失败"));
		});
	}

	/** 读一张表的全量。 */
	private readAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
		return new Promise<T[]>((resolve, reject) => {
			const tx = db.transaction(store, "readonly");
			const request = tx.objectStore(store).getAll();
			request.onsuccess = () => resolve((request.result ?? []) as T[]);
			request.onerror = () => reject(request.error ?? new Error("读取 " + store + " 失败"));
		});
	}

	/** 按索引读一批（索引键就是 projectId 或 [projectId, chapterId]）。 */
	private readIndex<T>(
		db: IDBDatabase,
		store: string,
		index: string,
		query?: unknown,
	): Promise<T[]> {
		return new Promise<T[]>((resolve, reject) => {
			const tx = db.transaction(store, "readonly");
			const request = tx.objectStore(store).index(index).getAll(query);
			request.onsuccess = () => resolve((request.result ?? []) as T[]);
			request.onerror = () => reject(request.error ?? new Error("读取 " + store + " 失败"));
		});
	}
}

// ───────────────────────────────────────────── 小工具

/** 快照名去重：同一毫秒里拍两份也不能互相覆盖。 */
function uniqueName(base: string, taken: readonly string[]): string {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let index = 2; index < 1000; index += 1) {
		const candidate = base + "-" + index;
		if (!used.has(candidate)) return candidate;
	}
	return base + "-" + newId().slice(0, 8);
}

/** 一份内容的字节数。快照清单上显示体积用。 */
function jsonSize(value: unknown): number {
	const json = JSON.stringify(value) ?? "";
	return new TextEncoder().encode(json).length;
}
