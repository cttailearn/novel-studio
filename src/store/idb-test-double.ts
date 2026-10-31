/**
 * IndexedDB 的内存替身：让 IndexedDB 版的存储能在 Node 里跑测试。
 *
 * 只实现工程存储真正用到的那一小块 IndexedDB：
 * 开库与升级、object store、事务、请求、索引。
 * 但这一小块的行为要**忠实**：请求必须异步回调，事务必须等它所有请求都完成
 * 才触发 oncomplete，中途出错必须回滚 —— 否则测出来的东西不算数。
 *
 * 特意不做的事：不实现 key range、不实现 blob、不实现索引的 unique 约束、
 * 不实现版本冲突。这些是真实 IndexedDB 里最啰嗦的部分，与本项目的存储路径无关。
 */
import type {
	IDBDatabase,
	IDBFactory,
	IDBIndex,
	IDBObjectStore,
	IDBOpenDBRequest,
	IDBRequest,
	IDBTransaction,
	IdbEventHandler,
} from "./project-idb.ts";

/** 主键的规范字符串：Map 的键。数组主键逐段拼起来，段与段之间不会撞。 */
function keyToString(key: unknown): string {
	if (Array.isArray(key)) return "a[" + key.map((part) => keyToString(part)).join(",") + "]";
	if (typeof key === "number") return "n:" + key;
	if (typeof key === "boolean") return "b:" + key;
	return "s:" + String(key);
}

/** 按 keyPath 从一条记录里取主键。字段缺失返回 undefined。 */
function keyOfPath(value: unknown, keyPath: string | string[]): unknown {
	if (Array.isArray(keyPath)) {
		const parts: unknown[] = [];
		for (const part of keyPath) {
			const found = keyOfPath(value, part);
			if (found === undefined) return undefined;
			parts.push(found);
		}
		return parts;
	}
	if (!value || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[keyPath];
}

/** 索引键是否命中查询：复合键逐段比，单键直接比。 */
function keyMatches(indexKey: unknown, query: unknown): boolean {
	if (Array.isArray(indexKey) && Array.isArray(query)) {
		return indexKey.length === query.length && indexKey.every((part, i) => part === query[i]);
	}
	return indexKey === query;
}

/** 结构化克隆：IndexedDB 存的是副本，之后再改原对象不影响已写入的数据。 */
function cloneValue<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

/** 一个假的 IndexedDB 事件。调用方不读它的内容，只当"事情发生了"的信号。 */
function fakeEvent(type: string): { type: string; target: unknown } {
	return { type, target: null };
}

/** 普通请求。 */
class FakeRequest<T> implements IDBRequest<T> {
	onsuccess: IdbEventHandler | null = null;
	onerror: IdbEventHandler | null = null;
	error: unknown = null;
	private value: T;

	constructor(value: T) {
		this.value = value;
	}

	get result(): T {
		return this.value;
	}

	/** 请求成功：回调在微任务里跑，绝不同步。 */
	fireSuccess(): void {
		try {
			this.onsuccess?.(fakeEvent("success"));
		} catch (error) {
			console.error("[fake-indexeddb] onsuccess 回调抛错:", error);
		}
	}

	/** 请求失败。 */
	fireError(error: unknown): void {
		this.error = error;
		try {
			this.onerror?.(fakeEvent("error"));
		} catch (err) {
			console.error("[fake-indexeddb] onerror 回调抛错:", err);
		}
	}
}

/** 开库请求。 */
class FakeOpenRequest implements IDBOpenDBRequest {
	onsuccess: IdbEventHandler | null = null;
	onerror: IdbEventHandler | null = null;
	onupgradeneeded: IdbEventHandler | null = null;
	error: unknown = null;
	transaction: IDBTransaction | null = null;
	private value: IDBDatabase | undefined;

	get result(): IDBDatabase {
		if (!this.value) throw new Error("数据库还没打开");
		return this.value;
	}

	/** 升级阶段就得能拿到库：与真实 IndexedDB 一致（onupgradeneeded 里 request.result 可用）。 */
	attach(db: IDBDatabase): void {
		this.value = db;
	}

	fireUpgradeneeded(): void {
		queueMicrotask(() => {
			try {
				this.onupgradeneeded?.(fakeEvent("upgradeneeded"));
			} catch (error) {
				console.error("[fake-indexeddb] onupgradeneeded 回调抛错:", error);
			}
		});
	}

	succeed(db: IDBDatabase): void {
		this.value = db;
		queueMicrotask(() => {
			try {
				this.onsuccess?.(fakeEvent("success"));
			} catch (error) {
				console.error("[fake-indexeddb] onsuccess 回调抛错:", error);
			}
		});
	}

	fail(error: unknown): void {
		this.error = error;
		queueMicrotask(() => {
			try {
				this.onerror?.(fakeEvent("error"));
			} catch (err) {
				console.error("[fake-indexeddb] onerror 回调抛错:", err);
			}
		});
	}
}

/** 一张表。 */
class FakeStore {
	readonly data = new Map<string, { key: unknown; value: unknown }>();
	readonly indexes = new Map<string, string | string[]>();
	readonly name: string;
	readonly keyPath: string | string[];
	private readonly database: FakeDatabase;

	constructor(name: string, keyPath: string | string[], database: FakeDatabase) {
		this.name = name;
		this.keyPath = keyPath;
		this.database = database;
	}

	/** 主键 → 记录。 */
	find(recordKey: unknown): { key: unknown; value: unknown } | undefined {
		return this.data.get(keyToString(recordKey));
	}

	/** 这个主键是否被注入了"写不进去"。 */
	fails(recordKey: unknown): boolean {
		const failures = this.database.factory.failures.get(this.name);
		if (!failures) return false;
		return failures.has(keyToString(recordKey));
	}
}

/** 索引。 */
class FakeIndex implements IDBIndex {
	readonly name: string;
	private readonly keyPath: string | string[];
	private readonly store: FakeStore;
	private readonly tx: FakeTransaction;

	constructor(name: string, keyPath: string | string[], store: FakeStore, tx: FakeTransaction) {
		this.name = name;
		this.keyPath = keyPath;
		this.store = store;
		this.tx = tx;
	}

	get(key: unknown): IDBRequest<unknown> {
		const found = this.rows().find((row) => keyMatches(row.key, key));
		return this.tx.enqueue(new FakeRequest(found?.value));
	}

	getAll(query?: unknown): IDBRequest<unknown[]> {
		const rows = this.rows()
			.filter((row) => query === undefined || keyMatches(row.key, query))
			.map((row) => row.value);
		return this.tx.enqueue(new FakeRequest(rows));
	}

	count(query?: unknown): IDBRequest<number> {
		const count = this.rows().filter((row) => query === undefined || keyMatches(row.key, query)).length;
		return this.tx.enqueue(new FakeRequest(count));
	}

	private rows(): { key: unknown; value: unknown }[] {
		const out: { key: unknown; value: unknown }[] = [];
		for (const record of this.store.data.values()) {
			const key = keyOfPath(record.value, this.keyPath);
			if (key === undefined) continue;
			out.push({ key, value: record.value });
		}
		return out;
	}
}

/** object store 句柄。 */
class FakeObjectStore implements IDBObjectStore {
	private readonly store: FakeStore;
	private readonly tx: FakeTransaction;

	constructor(store: FakeStore, tx: FakeTransaction) {
		this.store = store;
		this.tx = tx;
	}

	get name(): string {
		return this.store.name;
	}

	get keyPath(): string | string[] {
		return this.store.keyPath;
	}

	put(value: unknown, key?: unknown): IDBRequest<unknown> {
		const cloned = cloneValue(value);
		const recordKey = key === undefined ? keyOfPath(cloned, this.store.keyPath) : key;
		if (recordKey === undefined) throw new Error("记录缺少主键（" + this.store.name + "）");
		// 注入的失败：模拟"这一条就是写不进去"。
		if (this.store.fails(recordKey)) throw new Error("注入的写入失败：" + this.store.name);
		const mapKey = keyToString(recordKey);
		const previous = this.store.data.get(mapKey);
		this.tx.applyChange(
			() => {
				this.store.data.set(mapKey, { key: recordKey, value: cloned });
			},
			() => {
				if (previous) this.store.data.set(mapKey, previous);
				else this.store.data.delete(mapKey);
			},
		);
		return this.tx.enqueue(new FakeRequest(recordKey));
	}

	get(key: unknown): IDBRequest<unknown> {
		const found = this.store.find(key);
		return this.tx.enqueue(new FakeRequest(found?.value));
	}

	delete(key: unknown): IDBRequest<unknown> {
		const mapKey = keyToString(key);
		const previous = this.store.data.get(mapKey);
		this.tx.applyChange(
			() => {
				this.store.data.delete(mapKey);
			},
			() => {
				if (previous) this.store.data.set(mapKey, previous);
			},
		);
		return this.tx.enqueue(new FakeRequest(undefined));
	}

	getAll(query?: unknown): IDBRequest<unknown[]> {
		const values: unknown[] = [];
		for (const record of this.store.data.values()) {
			if (query !== undefined && !keyMatches(record.key, query)) continue;
			values.push(record.value);
		}
		return this.tx.enqueue(new FakeRequest(values));
	}

	clear(): IDBRequest<unknown> {
		const snapshot = new Map(this.store.data);
		this.tx.applyChange(
			() => {
				this.store.data.clear();
			},
			() => {
				this.store.data.clear();
				for (const [key, record] of snapshot) this.store.data.set(key, record);
			},
		);
		return this.tx.enqueue(new FakeRequest(undefined));
	}

	count(query?: unknown): IDBRequest<number> {
		let count = 0;
		for (const record of this.store.data.values()) {
			if (query !== undefined && !keyMatches(record.key, query)) continue;
			count += 1;
		}
		return this.tx.enqueue(new FakeRequest(count));
	}

	createIndex(name: string, keyPath: string | string[], _options?: { unique?: boolean }): IDBIndex {
		this.store.indexes.set(name, keyPath);
		return new FakeIndex(name, keyPath, this.store, this.tx);
	}

	index(name: string): IDBIndex {
		const keyPath = this.store.indexes.get(name);
		if (!keyPath) throw new Error("索引不存在：" + name);
		return new FakeIndex(name, keyPath, this.store, this.tx);
	}
}

/**
 * 事务。
 *
 * 自动提交：请求都发完了、最后一个也回调完了，就触发 oncomplete。
 * 中途 abort：把已经改动的数据按 undo 记录退回去，再触发 onabort。
 */
class FakeTransaction implements IDBTransaction {
	error: unknown = null;
	oncomplete: IdbEventHandler | null = null;
	onerror: IdbEventHandler | null = null;
	onabort: IdbEventHandler | null = null;
	readonly mode: "readonly" | "readwrite" | "versionchange";
	private outstanding = 0;
	private active = true;
	private readonly undo: (() => void)[] = [];
	private readonly db: FakeDatabase;
	private readonly scope: string[];

	constructor(db: FakeDatabase, mode: "readonly" | "readwrite" | "versionchange", scope: string[]) {
		this.db = db;
		this.mode = mode;
		this.scope = scope;
	}

	get objectStoreNames(): { readonly length: number; contains(name: string): boolean } {
		return {
			length: this.scope.length,
			contains: (name: string) => this.scope.includes(name),
		};
	}

	objectStore(name: string): IDBObjectStore {
		if (!this.scope.includes(name)) throw new Error("事务范围内没有 object store：" + name);
		const store = this.db.stores.get(name);
		if (!store) throw new Error("object store 不存在：" + name);
		return new FakeObjectStore(store, this);
	}

	abort(): void {
		if (!this.active) return;
		this.active = false;
		this.error = new Error("事务被中止");
		this.rollback();
		queueMicrotask(() => {
			this.onabort?.(fakeEvent("abort"));
		});
	}

	/** 记一次改动：apply 是真正落下的动作，undo 是回滚时要做的事。 */
	applyChange(apply: () => void, undo: () => void): void {
		if (this.mode === "readonly") throw new Error("只读事务不能写");
		apply();
		this.undo.push(undo);
	}

	/** 登记一个请求。 */
	enqueue<T>(request: FakeRequest<T>): IDBRequest<T> {
		if (!this.active) {
			// 事务已经提交或中止：请求不再执行，直接失败。
			queueMicrotask(() => request.fireError(new Error("事务已结束，请求未执行")));
			return request;
		}
		this.outstanding += 1;
		queueMicrotask(() => {
			if (!this.active) {
				request.fireError(new Error("事务已结束，请求未执行"));
				return;
			}
			request.fireSuccess();
			this.outstanding -= 1;
			// 回调里如果又发了新请求，outstanding 会先涨上来，这里不会误判为"发完了"。
			if (this.outstanding === 0) queueMicrotask(() => this.commit());
		});
		return request;
	}

	private commit(): void {
		if (!this.active || this.outstanding > 0) return;
		this.active = false;
		this.undo.length = 0;
		queueMicrotask(() => {
			this.oncomplete?.(fakeEvent("complete"));
		});
	}

	private rollback(): void {
		for (const undo of this.undo.reverse()) {
			try {
				undo();
			} catch (error) {
				console.error("[fake-indexeddb] 回滚失败:", error);
			}
		}
		this.undo.length = 0;
	}
}

/** 一个库。 */
class FakeDatabase implements IDBDatabase {
	readonly stores = new Map<string, FakeStore>();
	version: number;
	upgradeTransaction: FakeTransaction | null = null;
	closed = false;
	readonly name: string;
	readonly factory: FakeIndexedDB;

	constructor(name: string, version: number, factory: FakeIndexedDB) {
		this.name = name;
		this.version = version;
		this.factory = factory;
	}

	get objectStoreNames(): { readonly length: number; contains(name: string): boolean } {
		return {
			length: this.stores.size,
			contains: (name: string) => this.stores.has(name),
		};
	}

	createObjectStore(name: string, options?: { keyPath?: string | string[] }): IDBObjectStore {
		if (!this.upgradeTransaction) throw new Error("只能在升级事务里建 object store");
		if (this.stores.has(name)) throw new Error("object store 已存在：" + name);
		const keyPath = options?.keyPath ?? "id";
		const store = new FakeStore(name, keyPath, this);
		this.stores.set(name, store);
		return new FakeObjectStore(store, this.upgradeTransaction);
	}

	transaction(names: string | string[], mode: "readonly" | "readwrite" = "readonly"): IDBTransaction {
		if (this.closed) throw new Error("数据库已关闭");
		const scope = (Array.isArray(names) ? names : [names]).map((name) => String(name));
		for (const name of scope) {
			if (!this.stores.has(name)) throw new Error("object store 不存在：" + name);
		}
		return new FakeTransaction(this, mode, scope);
	}

	close(): void {
		this.closed = true;
	}
}

/**
 * 假 IndexedDB 工厂。
 *
 * 用法：
 * ```ts
 * const fake = createFakeIndexedDB();
 * const store = await IdbProjectStore.open({ indexedDB: fake });
 * fake.__dump();               // 看库里到底存了什么
 * fake.__failPut("projects", id); // 让某个主键的写入失败，用来测失败路径
 * ```
 */
export class FakeIndexedDB implements IDBFactory {
	readonly databases = new Map<string, FakeDatabase>();
	/** 注入的写入失败：store 名 → 主键集合。 */
	readonly failures = new Map<string, Set<string>>();

	open(name: string, version = 1): IDBOpenDBRequest {
		const request = new FakeOpenRequest();
		queueMicrotask(() => {
			let existing = this.databases.get(name);
			const fresh = !existing;
			if (!existing) {
				existing = new FakeDatabase(name, version, this);
				this.databases.set(name, existing);
			}
			const db = existing;
			// 新库，或者要求的版本比库里高：都要走一次升级。
			const needsUpgrade = fresh || version > db.version;
			if (!needsUpgrade) {
				request.transaction = null;
				request.succeed(db);
				return;
			}
			db.version = Math.max(db.version, version);
			const tx = new FakeTransaction(db, "versionchange", []);
			db.upgradeTransaction = tx;
			request.transaction = tx;
			// 升级回调里就要能拿到库。
			request.attach(db);
			request.fireUpgradeneeded();
			// 升级事务走完才开库：与真实 IndexedDB 的顺序一致。
			queueMicrotask(() => {
				db.upgradeTransaction = null;
				request.succeed(db);
			});
		});
		return request;
	}

	deleteDatabase(name: string): IDBRequest<unknown> {
		const request = new FakeRequest<unknown>(undefined);
		queueMicrotask(() => {
			this.databases.delete(name);
			request.fireSuccess();
		});
		return request;
	}

	/** 让某个 store 的某个主键写不进去，用来测失败路径。 */
	__failPut(store: string, key: string | string[]): void {
		let set = this.failures.get(store);
		if (!set) {
			set = new Set<string>();
			this.failures.set(store, set);
		}
		set.add(keyToString(key));
	}

	/** 撤掉全部注入的失败。 */
	__clearFailures(): void {
		this.failures.clear();
	}

	/** 看库里到底存了什么：{ 库名: { 表名: 行[] } }。 */
	__dump(databaseName?: string): Record<string, Record<string, unknown[]>> {
		const out: Record<string, Record<string, unknown[]>> = {};
		for (const [name, db] of this.databases) {
			if (databaseName && name !== databaseName) continue;
			const stores: Record<string, unknown[]> = {};
			for (const [storeName, store] of db.stores) {
				stores[storeName] = [...store.data.values()].map((record) => record.value);
			}
			out[name] = stores;
		}
		return out;
	}

	/** 直接往库里塞数据（造场景用）。 */
	__seed(databaseName: string, storeName: string, rows: unknown[]): void {
		const db = this.databases.get(databaseName);
		if (!db) throw new Error("库不存在：" + databaseName);
		const store = db.stores.get(storeName);
		if (!store) throw new Error("object store 不存在：" + storeName);
		const tx = new FakeTransaction(db, "readwrite", [storeName]);
		const handle = tx.objectStore(storeName);
		for (const row of rows) handle.put(row);
	}
}

/** 造一个假 IndexedDB。 */
export function createFakeIndexedDB(): FakeIndexedDB {
	return new FakeIndexedDB();
}
