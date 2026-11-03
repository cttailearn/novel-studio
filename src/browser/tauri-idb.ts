/**
 * 用 SQLite 冒充 IndexedDB 的最小实现。
 *
 * 这一层不是"重新实现一个 IndexedDB"，只覆盖 `project-idb.ts` 与
 * `idb-stores.ts` 真正用到的那一小块：open / createObjectStore / createIndex /
 * transaction / put / get / getAll / delete / clear / index.getAll。
 *
 * 设计取舍：
 *   - 打开库时把整库读进内存，之后读请求直接走内存；写请求按事务批量落到
 *     Rust 的 `sqlite_apply`。小说正文量级（数百万字）在桌面/移动内存里完全放得下，
 *     换来的是与现有 IndexedDB 业务代码零改动。
 *   - 每次 open 都触发 onupgradeneeded：业务代码用 `objectStoreNames.contains`
 *     判断是否建表，重复触发是安全的。这样不需要在 SQLite 里维护版本号。
 *   - 写入先 clone 再入队，避免调用方在 `put` 之后继续改对象，把已入队的数据改脏。
 *
 * 数据形状与 Rust 侧一致：objects(db, store, key, value)，key/value 都是 JSON 字符串。
 */
import { invoke, isTauri } from "./tauri.ts";

type KeyPath = string | string[];

interface Row {
	store: string;
	key: string;
	value: string;
}

interface StoreSpecRow {
	name: string;
	keyPath: string;
}

interface IndexSpecRow {
	store: string;
	name: string;
	keyPath: string;
}

interface StoreState {
	name: string;
	keyPath: KeyPath | null;
	indexes: Map<string, KeyPath>;
	rows: Map<string, unknown>;
}

interface PendingOp {
	kind: "put" | "delete" | "clear";
	store: string;
	key?: string;
	value?: string;
}

interface RequestLike<T = unknown> {
	result: T;
	error: unknown;
	onsuccess: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

interface DbState {
	name: string;
	version: number;
	stores: Map<string, StoreState>;
	storeCreates: Promise<unknown>[];
	closed: boolean;
}

const databases = new Map<string, Promise<DbState>>();

function parseKeyPath(raw: string): KeyPath | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "string") return parsed;
		if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) return parsed as string[];
		return null;
	} catch {
		return raw;
	}
}

function keyPathOf(value: unknown, keyPath: KeyPath | null): unknown {
	if (!keyPath) return undefined;
	if (Array.isArray(keyPath)) {
		if (!value || typeof value !== "object") return undefined;
		return keyPath.map((part) => (value as Record<string, unknown>)[part]);
	}
	if (!value || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[keyPath];
}

function serializeKey(key: unknown): string {
	if (key === undefined) throw new Error("IndexedDB 写入缺少主键");
	return JSON.stringify(key);
}

function keyEquals(left: unknown, right: unknown): boolean {
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((part, index) => keyEquals(part, right[index]));
	}
	return left === right;
}

function clone<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return JSON.parse(JSON.stringify(value)) as T;
	}
}

function request<T>(work: () => T | Promise<T>): RequestLike<T> {
	const req: RequestLike<T> = {
		result: undefined as T,
		error: null,
		onsuccess: null,
		onerror: null,
	};
	queueMicrotask(() => {
		void Promise.resolve()
			.then(work)
			.then((result) => {
				req.result = result;
				req.onsuccess?.({ target: req });
			})
			.catch((error: unknown) => {
				req.error = error;
				req.onerror?.({ target: req });
			});
	});
	return req;
}

async function loadDatabase(name: string, version: number): Promise<DbState> {
	const [specs, rows, indexSpecs] = await Promise.all([
		invoke<StoreSpecRow[]>("sqlite_stores", { db: name }),
		invoke<Row[]>("sqlite_load", { db: name }),
		invoke<IndexSpecRow[]>("sqlite_indexes", { db: name }),
	]);
	const stores = new Map<string, StoreState>();
	for (const spec of specs) {
		stores.set(spec.name, {
			name: spec.name,
			keyPath: parseKeyPath(spec.keyPath),
			indexes: new Map(),
			rows: new Map(),
		});
	}
	for (const index of indexSpecs) {
		const store = stores.get(index.store);
		const keyPath = parseKeyPath(index.keyPath);
		if (store && keyPath) store.indexes.set(index.name, keyPath);
	}
	for (const row of rows) {
		const store = stores.get(row.store);
		if (!store) continue;
		try {
			store.rows.set(row.key, JSON.parse(row.value) as unknown);
		} catch {
			/* 坏行跳过，不让一条脏数据拖垮整个库 */
		}
	}
	return { name, version, stores, storeCreates: [], closed: false };
}

function openDatabase(name: string, version: number): Promise<DbState> {
	const cached = databases.get(name);
	if (cached) return cached;
	const promise = loadDatabase(name, version);
	databases.set(name, promise);
	promise.catch(() => databases.delete(name));
	return promise;
}

class TauriObjectStore {
	readonly name: string;
	readonly keyPath: KeyPath | null;
	private readonly db: TauriDatabase;
	private readonly state: StoreState;

	constructor(db: TauriDatabase, state: StoreState) {
		this.db = db;
		this.state = state;
		this.name = state.name;
		this.keyPath = state.keyPath;
	}

	private tx(): TauriTransaction {
		const tx = this.db.current;
		if (!tx) throw new Error("IndexedDB 请求必须发生在 transaction 内");
		return tx;
	}

	put(value: unknown, key?: unknown): RequestLike<unknown> {
		return this.tx().put(this.name, value, key);
	}

	get(key: unknown): RequestLike<unknown> {
		return this.tx().read(() => clone(this.state.rows.get(serializeKey(key))));
	}

	getAll(query?: unknown): RequestLike<unknown[]> {
		return this.tx().read(() => {
			const values = [...this.state.rows.values()];
			if (query === undefined) return values.map((value) => clone(value));
			return values.filter((value) => keyEquals(keyPathOf(value, this.state.keyPath), query)).map((value) => clone(value));
		});
	}

	delete(key: unknown): RequestLike<unknown> {
		return this.tx().delete(this.name, serializeKey(key));
	}

	clear(): RequestLike<unknown> {
		return this.tx().clear(this.name);
	}

	count(query?: unknown): RequestLike<number> {
		return this.tx().read(() => {
			if (query === undefined) return this.state.rows.size;
			let count = 0;
			for (const value of this.state.rows.values()) {
				if (keyEquals(keyPathOf(value, this.state.keyPath), query)) count += 1;
			}
			return count;
		});
	}

	createIndex(name: string, keyPath: KeyPath, _options?: { unique?: boolean }): TauriIndex {
		this.state.indexes.set(name, keyPath);
		void invoke("sqlite_create_index", {
			db: this.db.state.name,
			store: this.name,
			name,
			keyPath: JSON.stringify(keyPath),
		}).catch(() => undefined);
		return new TauriIndex(this.state, keyPath);
	}

	index(name: string): TauriIndex {
		const keyPath = this.state.indexes.get(name);
		if (!keyPath) throw new Error("索引不存在：" + name);
		return new TauriIndex(this.state, keyPath);
	}
}

class TauriIndex {
	private readonly state: StoreState;
	private readonly keyPath: KeyPath;

	constructor(state: StoreState, keyPath: KeyPath) {
		this.state = state;
		this.keyPath = keyPath;
	}

	getAll(query?: unknown): RequestLike<unknown[]> {
		const values = [...this.state.rows.values()];
		const matched = query === undefined
			? values
			: values.filter((value) => keyEquals(keyPathOf(value, this.keyPath), query));
		return request(() => matched.map((value) => clone(value)));
	}

	get(query: unknown): RequestLike<unknown> {
		const found = [...this.state.rows.values()].find((value) => keyEquals(keyPathOf(value, this.keyPath), query));
		return request(() => clone(found));
	}

	count(query?: unknown): RequestLike<number> {
		const values = [...this.state.rows.values()];
		const count = query === undefined
			? values.length
			: values.filter((value) => keyEquals(keyPathOf(value, this.keyPath), query)).length;
		return request(() => count);
	}
}

class TauriTransaction {
	readonly mode: "readonly" | "readwrite" | "versionchange";
	readonly db: TauriDatabase;
	readonly error: unknown = null;
	readonly objectStoreNames: { length: number; contains(name: string): boolean };
	oncomplete: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onabort: ((event: unknown) => void) | null = null;
	private readonly names: string[];
	private readonly ops: PendingOp[] = [];
	private readonly pending: { req: RequestLike; op?: PendingOp }[] = [];
	private aborted = false;
	private fired = false;

	constructor(db: TauriDatabase, names: string[], mode: "readonly" | "readwrite" | "versionchange") {
		this.db = db;
		this.names = names;
		this.mode = mode;
		const self = this;
		this.objectStoreNames = {
			get length() {
				return self.names.length;
			},
			contains(name: string) {
				return self.names.includes(name);
			},
		};
		queueMicrotask(() => void this.flush());
	}

	objectStore(name: string): TauriObjectStore {
		const state = this.db.state.stores.get(name);
		if (!state) throw new Error("object store 不存在：" + name);
		if (!this.names.includes(name)) throw new Error("事务未包含 object store：" + name);
		this.db.current = this;
		return new TauriObjectStore(this.db, state);
	}

	abort(): void {
		this.aborted = true;
	}

	put(store: string, value: unknown, key?: unknown): RequestLike<unknown> {
		const req = request(() => undefined);
		const state = this.db.state.stores.get(store);
		if (!state) throw new Error("object store 不存在：" + store);
		const primary = key !== undefined ? key : keyPathOf(value, state.keyPath);
		const op: PendingOp = {
			kind: "put",
			store,
			key: serializeKey(primary),
			value: JSON.stringify(clone(value)),
		};
		this.ops.push(op);
		this.pending.push({ req, op });
		return req;
	}

	delete(store: string, key: string): RequestLike<unknown> {
		const req = request(() => undefined);
		const op: PendingOp = { kind: "delete", store, key };
		this.ops.push(op);
		this.pending.push({ req, op });
		return req;
	}

	clear(store: string): RequestLike<unknown> {
		const req = request(() => undefined);
		const op: PendingOp = { kind: "clear", store };
		this.ops.push(op);
		this.pending.push({ req, op });
		return req;
	}

	read<T>(work: () => T): RequestLike<T> {
		return request(work);
	}

	private async flush(): Promise<void> {
		if (this.fired) return;
		if (this.aborted) {
			this.fired = true;
			this.onabort?.({ target: this });
			return;
		}
		if (this.mode !== "readwrite" || this.ops.length === 0) {
			this.fired = true;
			this.oncomplete?.({ target: this });
			return;
		}
		const db = this.db.state;
		try {
			await invoke("sqlite_apply", { db: db.name, ops: this.ops });
			// SQLite 成功了才改内存，失败时内存仍是旧值，和事务回滚一致。
			for (const op of this.ops) {
				const store = db.stores.get(op.store);
				if (!store) continue;
				if (op.kind === "clear") store.rows.clear();
				else if (op.kind === "delete" && op.key) store.rows.delete(op.key);
				else if (op.kind === "put" && op.key && op.value !== undefined) {
					store.rows.set(op.key, JSON.parse(op.value) as unknown);
				}
			}
			for (const item of this.pending) item.req.onsuccess?.({ target: item.req });
			this.fired = true;
			this.oncomplete?.({ target: this });
		} catch (error) {
			for (const item of this.pending) {
				item.req.error = error;
				item.req.onerror?.({ target: item.req });
			}
			this.fired = true;
			this.onerror?.({ target: this });
			this.onabort?.({ target: this });
		}
	}
}

class TauriDatabase {
	readonly name: string;
	readonly version: number;
	readonly state: DbState;
	current: TauriTransaction | null = null;
	onversionchange: ((event: unknown) => void) | null = null;
	readonly objectStoreNames: { length: number; contains(name: string): boolean };

	constructor(state: DbState) {
		this.state = state;
		this.name = state.name;
		this.version = state.version;
		const self = this;
		this.objectStoreNames = {
			get length() {
				return self.state.stores.size;
			},
			contains(name: string) {
				return self.state.stores.has(name);
			},
		};
	}

	createObjectStore(name: string, options?: { keyPath?: KeyPath | null }): TauriObjectStore {
		if (this.state.stores.has(name)) throw new Error("object store 已存在：" + name);
		const state: StoreState = {
			name,
			keyPath: options?.keyPath ?? null,
			indexes: new Map(),
			rows: new Map(),
		};
		this.state.stores.set(name, state);
		const create = invoke("sqlite_create_store", {
			db: this.state.name,
			name,
			keyPath: JSON.stringify(state.keyPath),
		}).catch(() => undefined);
		this.state.storeCreates.push(create);
		return new TauriObjectStore(this, state);
	}

	deleteObjectStore(name: string): void {
		this.state.stores.delete(name);
	}

	transaction(
		names: string | string[],
		mode: "readonly" | "readwrite" | "versionchange" = "readonly",
	): TauriTransaction {
		const list = Array.isArray(names) ? names : [names];
		return new TauriTransaction(this, list, mode);
	}

	close(): void {
		this.state.closed = true;
	}
}

export function createTauriIdbFactory(): {
	open(name: string, version?: number): RequestLike<TauriDatabase> & {
		onupgradeneeded: ((event: unknown) => void) | null;
		transaction: TauriTransaction | null;
	};
	deleteDatabase(name: string): RequestLike<unknown>;
} {
	return {
		open(name: string, version = 1) {
			const req = {
				result: undefined as unknown as TauriDatabase,
				error: null as unknown,
				onsuccess: null as ((event: unknown) => void) | null,
				onerror: null as ((event: unknown) => void) | null,
				onupgradeneeded: null as ((event: unknown) => void) | null,
				transaction: null as TauriTransaction | null,
			};
			queueMicrotask(() => {
				void openDatabase(name, version)
					.then(async (state) => {
						const db = new TauriDatabase(state);
						const upgrade = new TauriTransaction(db, [...state.stores.keys()], "versionchange");
						req.result = db;
						req.transaction = upgrade;
						try {
							req.onupgradeneeded?.({ target: req });
							await Promise.all(state.storeCreates);
						} catch (error) {
							req.error = error;
							req.onerror?.({ target: req });
							return;
						}
						req.onsuccess?.({ target: req });
					})
					.catch((error: unknown) => {
						req.error = error;
						req.onerror?.({ target: req });
					});
			});
			return req;
		},
		deleteDatabase(name: string) {
			databases.delete(name);
			return request(async () => {
				await invoke("sqlite_wipe", { db: name });
			});
		},
	};
}

/** 在 Tauri 里才创建 SQLite 工厂；浏览器/PWA 返回 undefined，继续用 IndexedDB。 */
export function tauriIdbFactory(): ReturnType<typeof createTauriIdbFactory> | undefined {
	return isTauri() ? createTauriIdbFactory() : undefined;
}
