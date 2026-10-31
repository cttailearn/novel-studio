/**
 * 通用素材库、种类表、应用设置、厂商密钥、生成记录的 IndexedDB 实现。
 *
 * 与磁盘版一一对应：
 *   - library-disk.ts 的 MaterialLibrary   → IdbLibraryStore
 *   - kinds-disk.ts 的 KindStore           → IdbKindStore
 *   - settings-disk.ts 的 SettingsStore    → IdbSettingsStore
 *   - credential-disk.ts 的 FileCredentialStore → IdbCredentialStore
 *   - records-disk.ts 的 RecordStore       → IdbRecordStore
 *
 * 同一套接口（store-port.ts 里的五个端口），同一套语义：
 * 返回值、错误形状、复制还是引用、每块面板的条数上限、超体积的裁剪规则，
 * 都照磁盘版抄，磁盘版怎么做的这里就怎么做。
 *
 * 两处不一样，都是浏览器环境逼出来的：
 *
 * 1. **另起一个库**（novel-studio-meta，而不是工程库的 novel-studio）：
 *    元数据与工程各管各的版本号，谁升级都不会把对方顶掉。
 * 2. **同步接口 + 异步落盘**：端口里有一半方法是同步的（list/get/create…），
 *    而 IndexedDB 只有异步接口。于是每个 store 都在内存里留一份缓存：
 *    读走缓存；写先改缓存（同步），再排队落盘（异步）。
 *    flush() 等队列排空，还有没写进去的就抛错；retryPending() 重试。
 *    落盘失败**不丢内存里的值** —— 失败的那批放回队首，错误记下来。
 *
 * 密钥只留在这个浏览器的 IndexedDB 里：list() 只给元信息，
 * 脱显给的是固定掩码，日志与错误信息里绝不出现密钥本身。
 *
 * 这一层不碰文件系统，浏览器与 Node（测试）都能直接跑。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { MASKED_KEY } from "../config/credential-store.ts";
import { emptySettings, normalizeSettings, type ProviderConfig, type Settings } from "../config/settings.ts";
import {
	normalizeRecord,
	previewOf,
	RECORDS_KEEP,
	scopeKey,
	toSummary,
	trimForStorage,
	type GenerationRecord,
	type RecordFilter,
	type RecordRole,
	type RecordSummary,
} from "../server/records.ts";
import {
	kindIdFromLabel,
	MAX_LABEL,
	normalizeCustomKind,
	type CustomKind,
	type KindResult,
} from "./kinds.ts";
import {
	normalizeLibraryMaterial,
	type LibraryMaterial,
	type LibraryMaterialInput,
} from "./library.ts";
import { isKnownKind, MATERIAL_KINDS, newId, type MaterialKind } from "./project.ts";
import type {
	CredentialStorePort,
	KindsStorePort,
	LibraryStorePort,
	RecordStorePort,
	SettingsStorePort,
} from "./store-port.ts";

// ───────────────────────────────────────────── 最小 IndexedDB 类型

/**
 * 事件回调的参数类型。
 *
 * 只能是 any：DOM 那边 IDBRequest.onsuccess 声明成
 * ((this: IDBRequest<T>, ev: Event) => any) | null，
 * 参数一旦写成 unknown，浏览器那份 indexedDB 就传不进本文件的选项 ——
 * strictFunctionTypes 下函数型属性是逆变的，unknown 不能当 Event 用。
 * 这里只把事件当"到点了"的信号，不读它的字段。
 */
type IdbEvent = any;

/** 一个 IndexedDB 请求。 */
export interface IdbRequest<T = unknown> {
	readonly result: T;
	readonly error: unknown;
	onsuccess: ((event: IdbEvent) => void) | null;
	onerror: ((event: IdbEvent) => void) | null;
}

/** 一张表。 */
export interface IdbObjectStore {
	put(value: unknown, key?: unknown): IdbRequest<unknown>;
	get(key: unknown): IdbRequest<unknown>;
	getAll(): IdbRequest<unknown[]>;
	delete(key: unknown): IdbRequest<unknown>;
	clear(): IdbRequest<unknown>;
}

/** 一个事务。 */
export interface IdbTransaction {
	readonly error: unknown;
	readonly mode: string;
	objectStore(name: string): IdbObjectStore;
	abort(): void;
	onabort: ((event: IdbEvent) => void) | null;
	oncomplete: ((event: IdbEvent) => void) | null;
	onerror: ((event: IdbEvent) => void) | null;
}

/** 一个数据库。 */
export interface IdbDatabase {
	readonly name: string;
	readonly version: number;
	readonly objectStoreNames: { contains(name: string): boolean };
	createObjectStore(
		name: string,
		options?: { keyPath?: string | string[] | null; autoIncrement?: boolean },
	): IdbObjectStore;
	deleteObjectStore(name: string): void;
	transaction(
		storeNames: string | string[] | { contains(name: string): boolean },
		mode?: "readonly" | "readwrite",
	): IdbTransaction;
	close(): void;
}

/** 打开数据库的请求。 */
export interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
	onupgradeneeded: ((event: IdbEvent) => void) | null;
}

/** indexedDB 工厂。浏览器里就是 window.indexedDB。 */
export interface IdbFactory {
	open(name: string, version?: number): IdbOpenRequest;
	deleteDatabase(name: string): IdbOpenRequest;
}

// ───────────────────────────────────────────── 库结构

/** 元数据库的库名。刻意与工程库（novel-studio）分开：版本号各管各的。 */
export const META_DB_NAME = "novel-studio-meta";

/** 元数据库的版本号。 */
export const META_DB_VERSION = 1;

/** 五张表。 */
export const META_STORE = {
	library: "library",
	kinds: "kinds",
	settings: "settings",
	credentials: "credentials",
	records: "records",
} as const;

type MetaStoreName = (typeof META_STORE)[keyof typeof META_STORE];

/** 每张表的主键。 */
const KEY_PATHS: Record<MetaStoreName, string> = {
	library: "id",
	kinds: "id",
	settings: "key",
	credentials: "providerId",
	records: "id",
};

/** settings 表里那一行的键：整份设置放一行里。 */
const SETTINGS_ROW_KEY = "app";

// ───────────────────────────────────────────── 连接

/** 打开选项。 */
export interface IdbStoresOptions {
	/** 默认取 globalThis.indexedDB；测试可以注入别的实现。 */
	indexedDB?: IdbFactory;
	/** 库名，默认 novel-studio-meta。 */
	name?: string;
}

/** 一个已经打开的数据库连接。五个 store 共用一个。 */
interface IdbConnection {
	readonly name: string;
	readonly db: IdbDatabase;
	close(): void;
}

/**
 * 已打开的连接，按库名缓存。
 *
 * 同一页里把同一个库打开两次，两个 open 请求会撞在一起跑 onupgradeneeded，
 * 版本号一旦被抬上去，第二次就再也开不了 —— 所以这里只开一次，后来的人拿同一个。
 */
const connections = new Map<string, Promise<IdbConnection>>();

function resolveFactory(options: IdbStoresOptions): IdbFactory {
	if (options.indexedDB) return options.indexedDB;
	const global = globalThis as unknown as { indexedDB?: IdbFactory };
	if (!global.indexedDB) {
		throw new Error(
			"这个环境没有 IndexedDB（只有浏览器里才有）。服务端请用磁盘版存储，或把一个 indexedDB 实现注入进来。",
		);
	}
	return global.indexedDB;
}

/** 打开（或复用）一个连接。 */
function connect(options: IdbStoresOptions): Promise<IdbConnection> {
	const name = options.name ?? META_DB_NAME;
	const cached = connections.get(name);
	if (cached) return cached;
	const factory = resolveFactory(options);
	const promise = openDatabase(factory, name).then((db) => {
		const connection: IdbConnection = {
			name,
			db,
			close() {
				try {
					db.close();
				} catch {
					// 关不上就算了：连接已经废了，下次 open 会另开一个。
				}
				if (connections.get(name) === promise) connections.delete(name);
			},
		};
		return connection;
	});
	connections.set(name, promise);
	// 开库失败就把缓存清掉，下一次还能再试。
	promise.catch(() => {
		if (connections.get(name) === promise) connections.delete(name);
	});
	return promise;
}

/** 打开数据库，顺手把五张表建好。 */
function openDatabase(factory: IdbFactory, name: string): Promise<IdbDatabase> {
	return new Promise<IdbDatabase>((resolve, reject) => {
		const request = factory.open(name, META_DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			for (const store of Object.values(META_STORE)) {
				if (db.objectStoreNames.contains(store)) continue;
				db.createObjectStore(store, { keyPath: KEY_PATHS[store] });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("打开 IndexedDB 失败：" + name));
	});
}

// ───────────────────────────────────────────── 排队落盘

/** 一条待落盘的写入：作用在某张表上。 */
interface PendingOp {
	store: MetaStoreName;
	apply: (tx: IdbTransaction) => void;
}

/**
 * 排队落盘器。
 *
 * 写先进内存、再排队落盘；落盘失败时**不丢内存里的值**：
 * 那批操作放回队首（顺序不变），错误记下来，
 * 等 flush() 抛错，或 retryPending() 重试。
 */
class PendingWriter {
	private readonly database: () => IdbDatabase;
	private readonly label: string;
	private queue: PendingOp[] = [];
	private chain: Promise<void> = Promise.resolve();
	private error: unknown;

	constructor(database: () => IdbDatabase, label: string) {
		this.database = database;
		this.label = label;
	}

	/** 排一条写入，立刻开始排空队列。 */
	enqueue(op: PendingOp): void {
		this.queue.push(op);
		void this.drain();
	}

	/** 还有没写进去的。 */
	get pending(): boolean {
		return this.queue.length > 0;
	}

	/** 最近一次落盘失败的原因。 */
	get lastError(): unknown {
		return this.error;
	}

	/** 等队列排空。失败也算排空（原因记在 lastError 里）。 */
	settled(): Promise<void> {
		return this.chain;
	}

	/** 等队列排空；还有没写进去的就抛错。 */
	async flush(): Promise<void> {
		await this.chain;
		if (this.queue.length === 0) return;
		throw new Error(this.label + "仍有未落盘数据", { cause: this.error });
	}

	/** 重试没写进去的那些。 */
	async retryPending(): Promise<void> {
		await this.chain;
		if (this.queue.length > 0) void this.drain();
		await this.flush();
	}

	private drain(): Promise<void> {
		this.chain = this.chain.then(
			() => this.runBatch(),
			() => this.runBatch(),
		);
		return this.chain;
	}

	private async runBatch(): Promise<void> {
		if (this.queue.length === 0) return;
		const batch = this.queue;
		this.queue = [];
		try {
			await applyOps(this.database(), batch);
			this.error = undefined;
		} catch (error) {
			// 放回队首：顺序不变，重试时后来的写不会插到前面去。
			this.queue = batch.concat(this.queue);
			this.error = error;
			// 这里只记错误，不记数据：密钥之类的内容绝不能进日志。
			console.error("[idb] " + this.label + " 落盘失败（已标记待重试）:", error);
		}
	}
}

/** 把一批写入落到 IndexedDB：同一张表的写放在同一个事务里。 */
async function applyOps(db: IdbDatabase, ops: PendingOp[]): Promise<void> {
	const groups = new Map<MetaStoreName, PendingOp[]>();
	for (const op of ops) {
		const group = groups.get(op.store) ?? [];
		group.push(op);
		groups.set(op.store, group);
	}
	for (const [store, group] of groups) {
		await runWrite(db, [store], (tx) => {
			for (const op of group) op.apply(tx);
		});
	}
}

/** 跑一个写事务；事务失败（出错或被中止）就抛错。 */
function runWrite(
	db: IdbDatabase,
	stores: string[],
	work: (tx: IdbTransaction) => void,
): Promise<void> {
	const tx = db.transaction(stores, "readwrite");
	const state: { done?: () => void; fail?: (error: unknown) => void } = {};
	const finished = new Promise<void>((resolve, reject) => {
		state.done = resolve;
		state.fail = reject;
	});
	// work 抛错时 finished 没人接，会变成未处理的 rejection。先挂一个空处理。
	finished.catch(() => undefined);
	tx.oncomplete = () => state.done?.();
	tx.onerror = () => state.fail?.(tx.error ?? new Error("IndexedDB 事务失败"));
	tx.onabort = () => state.fail?.(tx.error ?? new Error("IndexedDB 事务被中止"));
	try {
		work(tx);
	} catch (error) {
		try {
			tx.abort();
		} catch {
			// 事务已经结束了，没什么可中止的。
		}
		return Promise.reject(error);
	}
	return finished;
}

/** 读一张表的所有行。请求拿到结果就够了，不必再等事务落定。 */
async function readAll<T>(db: IdbDatabase, store: string): Promise<T[]> {
	const tx = db.transaction([store], "readonly");
	const request = tx.objectStore(store).getAll();
	const rows = await requestResult(request);
	return rows as T[];
}

/** 等一个请求出结果。 */
function requestResult<T>(request: IdbRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
	});
}

/** 深拷贝一份（快照用）。拷贝不了就退回 JSON。 */
function cloneJson<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return JSON.parse(JSON.stringify(value)) as T;
	}
}

// ───────────────────────────────────────────── 通用素材库

/**
 * 通用素材库的 IndexedDB 实现。
 *
 * 内存里留一份全部条目（库不大），读走缓存，写先改缓存再排队落库。
 * list() 返回副本：调用方一个原地 sort/splice 不能把库改坏。
 */
export class IdbLibraryStore implements LibraryStorePort {
	private readonly options: IdbStoresOptions;
	private readonly loading: Promise<void>;
	private materials: LibraryMaterial[] = [];
	private writer: PendingWriter | null = null;
	private connection: IdbConnection | null = null;
	private loadError: unknown = null;

	constructor(options: IdbStoresOptions = {}) {
		this.options = options;
		this.loading = this.initialize();
		this.loading.catch(() => undefined);
	}

	static async open(options: IdbStoresOptions = {}): Promise<IdbLibraryStore> {
		const store = new IdbLibraryStore(options);
		await store.ready();
		return store;
	}

	/** 等这个库读完、可以用了。 */
	ready(): Promise<void> {
		return this.loading;
	}

	private async initialize(): Promise<void> {
		try {
			const connection = await connect(this.options);
			this.connection = connection;
			const rows = await readAll<unknown>(connection.db, META_STORE.library);
			this.materials = rows
				.map((row) => normalizeLibraryMaterial(row))
				.filter((row): row is LibraryMaterial => row !== undefined);
			this.writer = new PendingWriter(() => connection.db, "通用素材库");
		} catch (error) {
			this.loadError = error;
			throw error;
		}
	}

	private requireReady(): PendingWriter {
		if (!this.writer) {
			throw new Error("通用素材库还没打开：先 await IdbLibraryStore.open()", { cause: this.loadError ?? undefined });
		}
		return this.writer;
	}

	/** 库条目。返回副本。 */
	list(): LibraryMaterial[] {
		this.requireReady();
		return this.materials.map((entry) => ({ ...entry, tags: [...entry.tags] }));
	}

	get(id: string): LibraryMaterial | undefined {
		this.requireReady();
		return this.materials.find((material) => material.id === id);
	}

	/** 新建。返回落库后的条目。默认算已确认：库里的料是作者亲手收录的。 */
	create(input: LibraryMaterialInput): LibraryMaterial {
		const writer = this.requireReady();
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
		this.put(writer, entry);
		return entry;
	}

	/** 改已有条目。未传的字段保持原样。 */
	update(id: string, input: LibraryMaterialInput): LibraryMaterial | undefined {
		const writer = this.requireReady();
		const entry = this.get(id);
		if (!entry) return undefined;
		if (input.kind !== undefined && isKnownKind(String(input.kind).trim())) entry.kind = String(input.kind).trim() as MaterialKind;
		if (input.title !== undefined && input.title.trim()) entry.title = input.title.trim();
		if (input.content !== undefined) entry.content = input.content;
		if (input.usage !== undefined) entry.usage = input.usage;
		if (input.tags !== undefined) entry.tags = [...input.tags];
		if (input.status === "confirmed" || input.status === "draft") entry.status = input.status;
		entry.updatedAt = Date.now();
		this.put(writer, entry);
		return entry;
	}

	remove(id: string): boolean {
		const writer = this.requireReady();
		const index = this.materials.findIndex((material) => material.id === id);
		if (index < 0) return false;
		this.materials.splice(index, 1);
		writer.enqueue({
			store: META_STORE.library,
			apply: (tx) => {
				tx.objectStore(META_STORE.library).delete(id);
			},
		});
		return true;
	}

	/** 排一次写入。快照在入队这一刻拍，排队期间改了对象也不跟着变。 */
	private put(writer: PendingWriter, entry: LibraryMaterial): void {
		const row = { ...entry, tags: [...entry.tags] };
		writer.enqueue({
			store: META_STORE.library,
			apply: (tx) => {
				tx.objectStore(META_STORE.library).put(row);
			},
		});
	}

	/** 等全部已排队写入；仍有未落盘数据时抛错。 */
	async flush(): Promise<void> {
		await this.requireReady().flush();
	}

	/** 不改内存地补写最近状态，供启动或显式恢复流程使用。 */
	async retryPending(): Promise<void> {
		await this.requireReady().retryPending();
	}

	/** 关掉共享的数据库连接（五个 store 共用一个）。 */
	close(): void {
		this.connection?.close();
	}
}

// ───────────────────────────────────────────── 自建种类

/**
 * 作者自建素材种类的 IndexedDB 实现。
 *
 * 内置那十三种写死在代码里，不归这里管；这里只管作者自建的那些。
 */
export class IdbKindStore implements KindsStorePort {
	private readonly options: IdbStoresOptions;
	private readonly loading: Promise<void>;
	private kinds: CustomKind[] = [];
	private writer: PendingWriter | null = null;
	private connection: IdbConnection | null = null;
	private loadError: unknown = null;

	constructor(options: IdbStoresOptions = {}) {
		this.options = options;
		this.loading = this.initialize();
		this.loading.catch(() => undefined);
	}

	static async open(options: IdbStoresOptions = {}): Promise<IdbKindStore> {
		const store = new IdbKindStore(options);
		await store.ready();
		return store;
	}

	ready(): Promise<void> {
		return this.loading;
	}

	private async initialize(): Promise<void> {
		try {
			const connection = await connect(this.options);
			this.connection = connection;
			const rows = await readAll<unknown>(connection.db, META_STORE.kinds);
			this.kinds = rows
				.map((row) => normalizeCustomKind(row))
				.filter((row): row is CustomKind => row !== undefined);
			this.writer = new PendingWriter(() => connection.db, "自建种类表");
		} catch (error) {
			this.loadError = error;
			throw error;
		}
	}

	private requireReady(): PendingWriter {
		if (!this.writer) {
			throw new Error("自建种类表还没打开：先 await IdbKindStore.open()", { cause: this.loadError ?? undefined });
		}
		return this.writer;
	}

	/** 全部自建种类，按添的先后排。 */
	list(): CustomKind[] {
		this.requireReady();
		return this.kinds.map((item) => ({ ...item }));
	}

	/** 这个 id 是不是自建种类。 */
	has(id: string): boolean {
		this.requireReady();
		return this.kinds.some((item) => item.id === id);
	}

	/** 添一个种类。名字重了就不添 —— 两个同名种类会让智能体无从选择。 */
	add(label: string): KindResult<CustomKind> {
		const writer = this.requireReady();
		const name = label.trim();
		if (!name) return { ok: false, error: "种类名不能为空", status: 400 };
		if (name.length > MAX_LABEL) return { ok: false, error: "种类名太长了，控制在 " + MAX_LABEL + " 字以内", status: 400 };
		if (this.labelTaken(name, "")) {
			return { ok: false, error: "已经有「" + name + "」这一类了", status: 400 };
		}
		const id = this.uniqueId(kindIdFromLabel(name));
		const kind: CustomKind = { id, label: name, createdAt: Date.now() };
		this.kinds.push(kind);
		this.put(writer, kind);
		return { ok: true, value: { ...kind } };
	}

	/** 改名。id 不变，认出这条素材的是 id，显示给作者的是名字。 */
	rename(id: string, label: string): KindResult<CustomKind> {
		const writer = this.requireReady();
		const name = label.trim();
		if (!name) return { ok: false, error: "种类名不能为空", status: 400 };
		if (name.length > MAX_LABEL) return { ok: false, error: "种类名太长了，控制在 " + MAX_LABEL + " 字以内", status: 400 };
		const target = this.kinds.find((item) => item.id === id);
		if (!target) return { ok: false, error: "没有这个种类", status: 404 };
		if (this.labelTaken(name, id)) {
			return { ok: false, error: "已经有「" + name + "」这一类了", status: 400 };
		}
		target.label = name;
		this.put(writer, target);
		return { ok: true, value: { ...target } };
	}

	/** 删一个自建种类。内置种类不归这里管。 */
	remove(id: string): KindResult<CustomKind> {
		const writer = this.requireReady();
		const index = this.kinds.findIndex((item) => item.id === id);
		if (index < 0) return { ok: false, error: "没有这个种类", status: 404 };
		const removed = this.kinds.splice(index, 1)[0] as CustomKind;
		writer.enqueue({
			store: META_STORE.kinds,
			apply: (tx) => {
				tx.objectStore(META_STORE.kinds).delete(id);
			},
		});
		return { ok: true, value: { ...removed } };
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

	private put(writer: PendingWriter, kind: CustomKind): void {
		const row = { ...kind };
		writer.enqueue({
			store: META_STORE.kinds,
			apply: (tx) => {
				tx.objectStore(META_STORE.kinds).put(row);
			},
		});
	}

	/** 等全部已排队写入；仍有未落盘数据时抛错。 */
	async flush(): Promise<void> {
		await this.requireReady().flush();
	}

	/** 重试没写进去的那些。 */
	async retryPending(): Promise<void> {
		await this.requireReady().retryPending();
	}

	close(): void {
		this.connection?.close();
	}
}

// ───────────────────────────────────────────── 应用设置

/**
 * 应用设置的 IndexedDB 实现。
 *
 * 整份设置放一行（key = "app"）里：设置不大，整体替换最省事。
 * 与凭据分开两张表 —— 设置可以安全分享，凭据不行。
 */
export class IdbSettingsStore implements SettingsStorePort {
	private readonly options: IdbStoresOptions;
	private readonly loading: Promise<void>;
	private settings: Settings = emptySettings();
	private writer: PendingWriter | null = null;
	private connection: IdbConnection | null = null;
	private loadError: unknown = null;

	constructor(options: IdbStoresOptions = {}) {
		this.options = options;
		this.loading = this.initialize();
		this.loading.catch(() => undefined);
	}

	static async open(options: IdbStoresOptions = {}): Promise<IdbSettingsStore> {
		const store = new IdbSettingsStore(options);
		await store.ready();
		return store;
	}

	ready(): Promise<void> {
		return this.loading;
	}

	private async initialize(): Promise<void> {
		try {
			const connection = await connect(this.options);
			this.connection = connection;
			const rows = await readAll<unknown>(connection.db, META_STORE.settings);
			const row = rows.find((item) => (item as { key?: unknown } | undefined)?.key === SETTINGS_ROW_KEY);
			const value = (row as { value?: unknown } | undefined)?.value;
			this.settings = normalizeSettings(value ?? null);
			this.writer = new PendingWriter(() => connection.db, "应用设置");
		} catch (error) {
			this.loadError = error;
			throw error;
		}
	}

	private requireReady(): PendingWriter {
		if (!this.writer) {
			throw new Error("应用设置还没打开：先 await IdbSettingsStore.open()", { cause: this.loadError ?? undefined });
		}
		return this.writer;
	}

	/** 整份设置。 */
	get(): Settings {
		this.requireReady();
		return this.settings;
	}

	/** 取一个供应商。取不到返回 undefined。 */
	getProvider(id: string): ProviderConfig | undefined {
		this.requireReady();
		return this.settings.providers.find((provider) => provider.id === id);
	}

	/** 以一次写入替换整份设置。 */
	replace(next: Settings): Settings {
		const writer = this.requireReady();
		this.settings = normalizeSettings(next);
		const row = { key: SETTINGS_ROW_KEY, value: this.settings };
		writer.enqueue({
			store: META_STORE.settings,
			apply: (tx) => {
				tx.objectStore(META_STORE.settings).put(row);
			},
		});
		return this.settings;
	}

	/** 改一份设置的副本，再整份替换。 */
	mutate(fn: (settings: Settings) => void): Settings {
		this.requireReady();
		const draft = structuredClone(this.settings);
		fn(draft);
		return this.replace(draft);
	}

	/** 添或改一个供应商。 */
	upsertProvider(provider: ProviderConfig): ProviderConfig {
		this.requireReady();
		const next: ProviderConfig = { ...provider, updatedAt: Date.now() };
		this.mutate((settings) => {
			const index = settings.providers.findIndex((item) => item.id === next.id);
			if (index >= 0) settings.providers[index] = next;
			else settings.providers.push(next);
		});
		return next;
	}

	/** 删一个供应商，顺带清掉指向它的默认模型。 */
	removeProvider(id: string): boolean {
		this.requireReady();
		let removed = false;
		this.mutate((settings) => {
			const before = settings.providers.length;
			settings.providers = settings.providers.filter((provider) => provider.id !== id);
			removed = settings.providers.length !== before;
			if (settings.defaultModel.startsWith(id + "/")) settings.defaultModel = "";
		});
		return removed;
	}

	/** 调用方在回复保存成功前必须等待真实落盘。 */
	async flush(): Promise<void> {
		await this.requireReady().flush();
	}

	/** 重试没写进去的那些。 */
	async retryPending(): Promise<void> {
		await this.requireReady().retryPending();
	}

	close(): void {
		this.connection?.close();
	}
}

// ───────────────────────────────────────────── 厂商密钥

/** 存进 IndexedDB 的一行：providerId + 凭据本体。 */
type StoredCredential = Credential & { providerId: string };

/**
 * 厂商密钥的 IndexedDB 实现。
 *
 * 密钥只留在这个浏览器的库里：
 *   - list() 只给 { providerId, type }，不给密钥本身；
 *   - maskedKey() 给的是固定掩码（•••••••）；
 *   - 日志与错误信息里绝不出现密钥。
 *
 * 前四个方法与 pi-ai 的 CredentialStore 签名完全一致，
 * 所以它能直接交给 createModels({ credentials })。
 */
export class IdbCredentialStore implements CredentialStore, CredentialStorePort {
	private readonly options: IdbStoresOptions;
	private readonly loading: Promise<void>;
	private readonly credentials = new Map<string, Credential>();
	private readonly chains = new Map<string, Promise<unknown>>();
	private writer: PendingWriter | null = null;
	private connection: IdbConnection | null = null;
	private loadError: unknown = null;

	constructor(options: IdbStoresOptions = {}) {
		this.options = options;
		this.loading = this.initialize();
		this.loading.catch(() => undefined);
	}

	static async open(options: IdbStoresOptions = {}): Promise<IdbCredentialStore> {
		const store = new IdbCredentialStore(options);
		await store.ready();
		return store;
	}

	ready(): Promise<void> {
		return this.loading;
	}

	private async initialize(): Promise<void> {
		try {
			const connection = await connect(this.options);
			this.connection = connection;
			const rows = await readAll<unknown>(connection.db, META_STORE.credentials);
			for (const row of rows) {
				const parsed = credentialFromRow(row);
				if (parsed) this.credentials.set(parsed.providerId, parsed.credential);
			}
			this.writer = new PendingWriter(() => connection.db, "厂商密钥");
		} catch (error) {
			this.loadError = error;
			throw error;
		}
	}

	private requireReady(): PendingWriter {
		if (!this.writer) {
			throw new Error("厂商密钥还没打开：先 await IdbCredentialStore.open()", { cause: this.loadError ?? undefined });
		}
		return this.writer;
	}

	/** 读一个厂商的凭据。 */
	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		await this.ready();
		return this.credentials.get(providerId);
	}

	/** 列出凭据的元信息 —— 只有 providerId 与类型，没有密钥。 */
	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		await this.ready();
		return [...this.credentials.entries()].map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	/** 唯一的写入路径：拿当前值改出新值。返回 undefined 表示不改。 */
	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		await this.ready();
		const writer = this.requireReady();
		return this.serialized(providerId, async () => {
			const current = this.credentials.get(providerId);
			const result = await fn(current);
			// fn 返回 undefined 表示"调用方决定不修改"，而不是"删除"。
			if (result === undefined) return current;
			this.credentials.set(providerId, result);
			this.putRow(writer, providerId, result);
			// 写不进去要抛错，但不能把内存里的值弄丢 —— flush 只看队列，不动缓存。
			await writer.flush();
			return result;
		});
	}

	/** 删一个厂商的凭据（登出）。 */
	async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		await this.ready();
		const writer = this.requireReady();
		await this.serialized(providerId, async () => {
			if (!this.credentials.delete(providerId)) return undefined;
			writer.enqueue({
				store: META_STORE.credentials,
				apply: (tx) => {
					tx.objectStore(META_STORE.credentials).delete(providerId);
				},
			});
			await writer.flush();
			return undefined;
		});
	}

	/** 应用自身的写入路径：直接设置或清除一个厂商的 key。 */
	async setKey(providerId: string, apiKey: string | undefined): Promise<void> {
		await this.ready();
		const key = apiKey?.trim();
		if (!key) {
			await this.delete(providerId);
			return;
		}
		await this.modify(providerId, async (current) => {
			// 保留其他字段，例如 provider 级 env。
			return { ...(current ?? { type: "api_key" as const }), type: "api_key" as const, key } as Credential;
		});
	}

	/** 只读查询，不暴露密钥本身。 */
	hasKey(providerId: string): boolean {
		this.requireReady();
		const credential = this.credentials.get(providerId);
		return credential?.type === "api_key" && typeof credential.key === "string" && credential.key.length > 0;
	}

	/** 键的脱显写法，仅用于设置页回显。 */
	maskedKey(providerId: string): string {
		if (!this.hasKey(providerId)) return "";
		return MASKED_KEY;
	}

	/** 同一 provider 的串行调用点，避免并发 read-modify-write 互相覆盖。 */
	private serialized<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		this.chains.set(
			providerId,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	/** 排一次凭据写入。落盘的是完整凭据（含 key），日志里绝不出现它。 */
	private putRow(writer: PendingWriter, providerId: string, credential: Credential): void {
		const row: StoredCredential = { providerId, ...credential };
		writer.enqueue({
			store: META_STORE.credentials,
			apply: (tx) => {
				tx.objectStore(META_STORE.credentials).put(row);
			},
		});
	}

	/** 等全部已排队写入；仍有未落盘数据时抛错。 */
	async flush(): Promise<void> {
		await this.requireReady().flush();
	}

	/** 重试没写进去的那些。 */
	async retryPending(): Promise<void> {
		await this.requireReady().retryPending();
	}

	close(): void {
		this.connection?.close();
	}
}

/** 从一行里读出 providerId 与凭据。坏数据在这里被挡掉。 */
function credentialFromRow(raw: unknown): { providerId: string; credential: Credential } | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const row = raw as Record<string, unknown>;
	const providerId = typeof row.providerId === "string" ? row.providerId : "";
	if (!providerId) return undefined;
	if (row.type === "api_key") {
		const credential: Credential = {
			type: "api_key",
			...(typeof row.key === "string" ? { key: row.key } : {}),
			...(row.env && typeof row.env === "object" ? { env: row.env as never } : {}),
		};
		return { providerId, credential };
	}
	if (row.type === "oauth") {
		const rest: Record<string, unknown> = { ...row };
		delete rest.providerId;
		return { providerId, credential: rest as unknown as Credential };
	}
	return undefined;
}

// ───────────────────────────────────────────── 生成记录

/**
 * 生成记录的 IndexedDB 实现。
 *
 * 每块面板（role + 作品 + 章节）只留最近 10 条，落盘前先裁一遍，
 * 所以库的大小有上界，不会随着用得越久越胀。
 */
export class IdbRecordStore implements RecordStorePort {
	private readonly options: IdbStoresOptions;
	private readonly loading: Promise<void>;
	private records: GenerationRecord[] = [];
	private writer: PendingWriter | null = null;
	private connection: IdbConnection | null = null;
	private loadError: unknown = null;

	constructor(options: IdbStoresOptions = {}) {
		this.options = options;
		this.loading = this.initialize();
		this.loading.catch(() => undefined);
	}

	static async open(options: IdbStoresOptions = {}): Promise<IdbRecordStore> {
		const store = new IdbRecordStore(options);
		await store.ready();
		return store;
	}

	ready(): Promise<void> {
		return this.loading;
	}

	private async initialize(): Promise<void> {
		try {
			const connection = await connect(this.options);
			this.connection = connection;
			const rows = await readAll<unknown>(connection.db, META_STORE.records);
			this.records = rows
				.map((row) => normalizeRecord(row))
				.filter((row): row is GenerationRecord => row !== undefined);
			this.writer = new PendingWriter(() => connection.db, "生成记录");
		} catch (error) {
			this.loadError = error;
			throw error;
		}
	}

	private requireReady(): PendingWriter {
		if (!this.writer) {
			throw new Error("生成记录还没打开：先 await IdbRecordStore.open()", { cause: this.loadError ?? undefined });
		}
		return this.writer;
	}

	/** 记录列表（轻量视图，不带消息体），按更新时间倒序。 */
	list(filter: RecordFilter = {}, limit = RECORDS_KEEP): RecordSummary[] {
		this.requireReady();
		return this.records
			.filter((record) => {
				if (filter.role && record.role !== filter.role) return false;
				if (filter.projectId && record.projectId !== filter.projectId) return false;
				if (filter.chapterId && record.chapterId !== filter.chapterId) return false;
				if (filter.libraryScope !== undefined && Boolean(record.libraryScope) !== filter.libraryScope) return false;
				return true;
			})
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, Math.max(1, limit))
			.map((record) => toSummary(record));
	}

	/** 取一条完整记录。取不到返回 undefined。 */
	get(id: string): GenerationRecord | undefined {
		this.requireReady();
		return this.records.find((record) => record.id === id);
	}

	/** 建一条空记录：先占住 id，这一轮怎么收场都能把消息补进去。 */
	async create(input: {
		role: RecordRole;
		projectId: string;
		chapterId?: string;
		libraryScope?: boolean;
		title: string;
	}): Promise<GenerationRecord> {
		const writer = this.requireReady();
		const now = Date.now();
		const record: GenerationRecord = {
			id: newId(),
			role: input.role,
			projectId: input.projectId,
			...(input.chapterId ? { chapterId: input.chapterId } : {}),
			...(input.libraryScope ? { libraryScope: true } : {}),
			title: input.title,
			preview: "",
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
		this.records.push(record);
		this.putRow(writer, record);
		await this.persistWithCap(writer);
		return record;
	}

	/** 一轮跑完（或被中止）后把消息补进记录。 */
	async saveMessages(id: string, messages: AgentMessage[], title?: string): Promise<GenerationRecord | undefined> {
		const writer = this.requireReady();
		const record = this.get(id);
		if (!record) return undefined;
		const kept = trimForStorage(messages);
		record.messages = kept;
		record.preview = previewOf(kept);
		record.updatedAt = Date.now();
		if (title) record.title = title;
		this.putRow(writer, record);
		await this.persistWithCap(writer);
		return record;
	}

	/** 改这条记录的标题。 */
	async rename(id: string, title: string): Promise<void> {
		const writer = this.requireReady();
		const record = this.get(id);
		if (!record) return;
		record.title = title;
		this.putRow(writer, record);
		await this.persistWithCap(writer);
	}

	/** 删一条记录。 */
	async remove(id: string): Promise<boolean> {
		const writer = this.requireReady();
		const before = this.records.length;
		this.records = this.records.filter((record) => record.id !== id);
		if (this.records.length === before) return false;
		writer.enqueue({
			store: META_STORE.records,
			apply: (tx) => {
				tx.objectStore(META_STORE.records).delete(id);
			},
		});
		await this.persistWithCap(writer);
		return true;
	}

	/** 落盘前先按面板裁到 10 条，库的大小才有上界。 */
	private async persistWithCap(writer: PendingWriter): Promise<void> {
		const keptByScope = new Map<string, GenerationRecord[]>();
		for (const record of this.records) {
			const key = scopeKey(record);
			const bucket = keptByScope.get(key) ?? [];
			bucket.push(record);
			keptByScope.set(key, bucket);
		}
		const survivors = new Set<string>();
		for (const bucket of keptByScope.values()) {
			bucket
				.sort((left, right) => right.updatedAt - left.updatedAt)
				.slice(0, RECORDS_KEEP)
				.forEach((record) => survivors.add(record.id));
		}
		const next = this.records.filter((record) => survivors.has(record.id));
		if (next.length !== this.records.length) {
			const evicted = this.records.filter((record) => !survivors.has(record.id));
			this.records = next;
			for (const record of evicted) {
				writer.enqueue({
					store: META_STORE.records,
					apply: (tx) => {
						tx.objectStore(META_STORE.records).delete(record.id);
					},
				});
			}
		}
		await writer.settled();
	}

	/** 排一次记录写入。快照在入队这一刻拍。 */
	private putRow(writer: PendingWriter, record: GenerationRecord): void {
		const row: GenerationRecord = { ...record, messages: cloneJson(record.messages) };
		writer.enqueue({
			store: META_STORE.records,
			apply: (tx) => {
				tx.objectStore(META_STORE.records).put(row);
			},
		});
	}

	/** 等全部已排队写入；仍有未落盘数据时抛错。 */
	async flush(): Promise<void> {
		await this.requireReady().flush();
	}

	/** 重试没写进去的那些。 */
	async retryPending(): Promise<void> {
		await this.requireReady().retryPending();
	}

	close(): void {
		this.connection?.close();
	}
}

// ───────────────────────────────────────────── 一起打开

/** 五个 store。 */
export interface IdbStores {
	library: IdbLibraryStore;
	kinds: IdbKindStore;
	settings: IdbSettingsStore;
	credentials: IdbCredentialStore;
	records: IdbRecordStore;
}

/**
 * 打开一个数据库，拿到五个 store。
 *
 * 同一个库在同一个页面里只开一次连接，后来的人拿同一个 ——
 * 两个 open 请求撞在一起跑 onupgradeneeded 是会把版本号顶坏的。
 */
export async function openIdbStores(options: IdbStoresOptions = {}): Promise<IdbStores> {
	const [library, kinds, settings, credentials, records] = await Promise.all([
		IdbLibraryStore.open(options),
		IdbKindStore.open(options),
		IdbSettingsStore.open(options),
		IdbCredentialStore.open(options),
		IdbRecordStore.open(options),
	]);
	return { library, kinds, settings, credentials, records };
}

/** 关掉共享的数据库连接。五个 store 共用一个，关一个就都关了。 */
export function closeIdbStores(stores: IdbStores): void {
	stores.library.close();
}
