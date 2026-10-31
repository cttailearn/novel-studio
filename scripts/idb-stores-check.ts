/**
 * 五个元数据 store 的 IndexedDB 验收。
 *
 * 这一套是给"数据只存在用户自己的浏览器里"兜底的：
 * 通用素材库、自建种类、应用设置、厂商密钥、生成记录，
 * 都要能在没有服务器的浏览器里读写、落盘、关掉重开还在，
 * 写坏了也不能把内存里的东西弄丢。
 *
 * 这里自带一份假的 IndexedDB（不依赖工程里任何别的文件，
 * 免得跟别人正在写的测试替身撞车），
 * 照着真浏览器的语义实现：请求异步出结果、事务成批提交、
 * 一批里有一条写失败就整批不落盘。
 * 唯一的注入口是 factory.failWrites。
 *
 * 跑法：node --experimental-strip-types scripts/idb-stores-check.ts
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MASKED_KEY } from "../src/config/credential-store.ts";
import type { ProviderConfig } from "../src/config/settings.ts";
import { MAX_RECORD_BYTES, RECORDS_KEEP } from "../src/server/records.ts";
import {
	closeIdbStores,
	openIdbStores,
	type IdbDatabase,
	type IdbFactory,
	type IdbObjectStore,
	type IdbOpenRequest,
	type IdbRequest,
	type IdbTransaction,
} from "../src/store/idb-stores.ts";

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

// ───────────────────────────────────────── 假的 IndexedDB

/** 一张假表。 */
interface FakeTable {
	keyPath: string;
	rows: Map<string, unknown>;
}

/** 事务里排着的一条操作。 */
interface FakeOp {
	kind: "put" | "delete" | "clear" | "get" | "getAll";
	table: string;
	key: string;
	value: unknown;
	request: FakeRequest<unknown>;
}

/** 一个请求。 */
class FakeRequest<T> implements IdbRequest<T> {
	result!: T;
	error: unknown = null;
	onsuccess: ((event: any) => void) | null = null;
	onerror: ((event: any) => void) | null = null;
}

/** 打开数据库的请求。 */
class FakeOpenRequest extends FakeRequest<IdbDatabase> implements IdbOpenRequest {
	onupgradeneeded: ((event: any) => void) | null = null;
}

/** 一张表。 */
class FakeObjectStore implements IdbObjectStore {
	private readonly tx: FakeTransaction;
	private readonly name: string;

	constructor(tx: FakeTransaction, name: string) {
		this.tx = tx;
		this.name = name;
	}

	put(value: unknown, _key?: unknown): IdbRequest<unknown> {
		const request = new FakeRequest<unknown>();
		const table = this.tx.database.table(this.name);
		const key = table ? String((value as Record<string, unknown>)[table.keyPath] ?? "") : "";
		this.tx.ops.push({ kind: "put", table: this.name, key, value, request });
		return request;
	}

	get(key: unknown): IdbRequest<unknown> {
		const request = new FakeRequest<unknown>();
		this.tx.ops.push({ kind: "get", table: this.name, key: String(key), value: undefined, request });
		return request;
	}

	getAll(): IdbRequest<unknown[]> {
		const request = new FakeRequest<unknown[]>();
		this.tx.ops.push({ kind: "getAll", table: this.name, key: "", value: undefined, request });
		return request;
	}

	delete(key: unknown): IdbRequest<unknown> {
		const request = new FakeRequest<unknown>();
		this.tx.ops.push({ kind: "delete", table: this.name, key: String(key), value: undefined, request });
		return request;
	}

	clear(): IdbRequest<unknown> {
		const request = new FakeRequest<unknown>();
		this.tx.ops.push({ kind: "clear", table: this.name, key: "", value: undefined, request });
		return request;
	}
}

/** 一个事务。 */
class FakeTransaction implements IdbTransaction {
	readonly mode: string;
	error: unknown = null;
	oncomplete: ((event: any) => void) | null = null;
	onerror: ((event: any) => void) | null = null;
	onabort: ((event: any) => void) | null = null;
	readonly ops: FakeOp[] = [];
	private readonly db: FakeDatabase;
	private settled = false;

	constructor(db: FakeDatabase, mode: string) {
		this.db = db;
		this.mode = mode;
		// 事务在当前这一轮同步代码跑完之后才提交，
		// 所以同一批里发出的操作都能收进来。
		queueMicrotask(() => this.commit());
	}

	get database(): FakeDatabase {
		return this.db;
	}

	objectStore(name: string): IdbObjectStore {
		return new FakeObjectStore(this, name);
	}

	abort(): void {
		this.error = this.error ?? new Error("事务被中止");
	}

	private commit(): void {
		if (this.settled) return;
		this.settled = true;
		for (const op of this.ops) {
			if (op.kind === "put" && this.db.factory.failWrites) {
				// 注入的失败：整批都不落盘。
				this.error = new Error("注入的写入失败");
				this.onerror?.({ target: this });
				this.onabort?.({ target: this });
				return;
			}
			const table = this.db.table(op.table);
			if (!table) continue;
			if (op.kind === "put") {
				table.rows.set(op.key, op.value);
				op.request.result = op.key;
			} else if (op.kind === "delete") {
				table.rows.delete(op.key);
				op.request.result = undefined;
			} else if (op.kind === "clear") {
				table.rows.clear();
				op.request.result = undefined;
			} else if (op.kind === "get") {
				op.request.result = table.rows.get(op.key);
			} else {
				op.request.result = [...table.rows.values()];
			}
			op.request.onsuccess?.({ target: op.request });
		}
		queueMicrotask(() => this.oncomplete?.({ target: this }));
	}
}

/** 一个数据库。 */
class FakeDatabase implements IdbDatabase {
	readonly name: string;
	version = 1;
	readonly factory: FakeFactory;
	closed = false;
	private readonly tables = new Map<string, FakeTable>();

	constructor(factory: FakeFactory, name: string) {
		this.factory = factory;
		this.name = name;
	}

	get objectStoreNames(): { contains(name: string): boolean } {
		return { contains: (name: string) => this.tables.has(name) };
	}

	table(name: string): FakeTable | undefined {
		return this.tables.get(name);
	}

	createObjectStore(
		name: string,
		options?: { keyPath?: string | string[] | null; autoIncrement?: boolean },
	): IdbObjectStore {
		const raw = options?.keyPath;
		const keyPath = Array.isArray(raw) ? raw.join(".") : (raw ?? "");
		this.tables.set(name, { keyPath, rows: new Map() });
		return new FakeObjectStore(new FakeTransaction(this, "versionchange"), name);
	}

	deleteObjectStore(name: string): void {
		this.tables.delete(name);
	}

	transaction(
		storeNames: string | string[] | { contains(name: string): boolean },
		mode: "readonly" | "readwrite" = "readonly",
	): IdbTransaction {
		const names =
			typeof storeNames === "string"
				? [storeNames]
				: Array.isArray(storeNames)
					? storeNames.slice()
					: [...this.tables.keys()].filter((name) => storeNames.contains(name));
		const missing = names.filter((name) => !this.tables.has(name));
		if (missing.length > 0) throw new Error("没有这张表：" + missing.join("、"));
		return new FakeTransaction(this, mode);
	}

	close(): void {
		this.closed = true;
	}
}

/** indexedDB 工厂。 */
class FakeFactory implements IdbFactory {
	readonly databases = new Map<string, FakeDatabase>();
	/** 打开就注入一次写入失败。 */
	failWrites = false;

	open(name: string, version?: number): IdbOpenRequest {
		const request = new FakeOpenRequest();
		queueMicrotask(() => {
			const existing = this.databases.get(name);
			const db = existing ?? new FakeDatabase(this, name);
			if (!existing) this.databases.set(name, db);
			db.version = version ?? db.version;
			request.result = db;
			// 只有第一次打开才需要建表。
			if (!existing) request.onupgradeneeded?.({ target: request, oldVersion: 0, newVersion: db.version });
			request.onsuccess?.({ target: request });
		});
		return request;
	}

	deleteDatabase(name: string): IdbOpenRequest {
		const request = new FakeOpenRequest();
		queueMicrotask(() => {
			this.databases.delete(name);
			request.onsuccess?.({ target: request });
		});
		return request;
	}

	/** 测试用：看某张表里有没有这一行。 */
	row(dbName: string, store: string, key: string): unknown {
		return this.databases.get(dbName)?.table(store)?.rows.get(key);
	}
}

// ───────────────────────────────────────── 造消息

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

/** 让时间戳往前走一格：同毫秒里造的记录分不出新旧。 */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 2));
}

// ───────────────────────────────────────── 通用素材库

const factory = new FakeFactory();
const DB = "novel-studio-meta-check";
const options = { indexedDB: factory, name: DB };

console.log("\n通用素材库");
const stores = await openIdbStores(options);

const material = stores.library.create({
	kind: "character",
	title: "裴渡",
	content: "主角，撑船的",
	tags: ["主角"],
	usage: "第一卷",
});
check("新建后列得出来", stores.library.list().some((item) => item.id === material.id));
check("按 id 取得到", stores.library.get(material.id)?.title === "裴渡");
check("新建默认是已确认", stores.library.get(material.id)?.status === "confirmed");

const edited = stores.library.update(material.id, { title: "裴渡（改过）" });
check("改名生效", edited?.title === "裴渡（改过）");
check("没传的字段保持原样", edited?.content === "主角，撑船的" && edited?.kind === "character");
check("改过的条目 tags 还在", edited?.tags.join(",") === "主角");

const listed = stores.library.list();
listed[0]!.title = "改坏了";
check("list() 返回的是副本", stores.library.list()[0]?.title === "裴渡（改过）");
check("get() 拿的是库里的那一份", stores.library.get(material.id)?.title === "裴渡（改过）");

check("删掉返回 true", stores.library.remove(material.id) === true);
check("删掉之后取不到", stores.library.get(material.id) === undefined);
check("删不存在的返回 false", stores.library.remove("没有这个 id") === false);

// ───────────────────────────────────────── 自建种类

console.log("\n自建种类");
const added = stores.kinds.add("伏笔");
check("加上了", added.ok && added.value.label === "伏笔");
check("id 就是作者起的名字", added.ok && added.value.id === "伏笔");
check("has() 认得", stores.kinds.has("伏笔"));

const duplicated = stores.kinds.add("伏笔");
check("重名被挡", !duplicated.ok);
check("重名的错法与磁盘版一致", !duplicated.ok && duplicated.error === "已经有「伏笔」这一类了" && duplicated.status === 400);
const blank = stores.kinds.add("   ");
check("空名被挡", !blank.ok && blank.error === "种类名不能为空" && blank.status === 400);

const builtinNamed = stores.kinds.add("character");
check("与内置重名时让开一步", builtinNamed.ok && builtinNamed.value.id === "c-character");
check("内置种类本身不在自建表里", !stores.kinds.has("character"));
check("让开后的 id 不与内置相撞", stores.kinds.has("c-character"));

const renamed = stores.kinds.rename("伏笔", "暗线");
check("改名成功", renamed.ok && renamed.value.label === "暗线");
check("改名不改 id", renamed.ok && renamed.value.id === "伏笔");
check("改名后 has() 仍按旧 id 认得", stores.kinds.has("伏笔"));
const renamedMissing = stores.kinds.rename("没有这个", "x");
check("改不存在的名字报 404", !renamedMissing.ok && renamedMissing.status === 404);

const removedKind = stores.kinds.remove("伏笔");
check("删掉了", removedKind.ok && removedKind.value.id === "伏笔");
check("删掉之后 has() 为假", !stores.kinds.has("伏笔"));
const removedMissing = stores.kinds.remove("没有这个");
check("删不存在的报 404", !removedMissing.ok && removedMissing.status === 404);

// ───────────────────────────────────────── 应用设置

console.log("\n应用设置");
const defaults = stores.settings.get();
check("拿得到默认设置", defaults.version === 1 && defaults.providers.length === 0);
check("默认没有默认模型", defaults.defaultModel === "");

stores.settings.replace({ ...stores.settings.get(), defaultModel: "openai/gpt-4o" });
check("replace 换掉整份设置", stores.settings.get().defaultModel === "openai/gpt-4o");

const beforeMutate = stores.settings.get();
const snapshot = structuredClone(beforeMutate);
stores.settings.mutate((draft) => {
	draft.defaultModel = "anthropic/claude";
});
check("mutate 生效了", stores.settings.get().defaultModel === "anthropic/claude");
check("mutate 没就地改旧对象", beforeMutate.defaultModel === snapshot.defaultModel);

const provider: ProviderConfig = {
	id: "my-provider",
	label: "自建厂商",
	kind: "custom",
	baseUrl: "https://api.example.com/v1",
	api: "openai-completions",
	models: [],
	enabled: true,
	updatedAt: 0,
};
const upserted = stores.settings.upsertProvider(provider);
check("供应商添上了", stores.settings.getProvider("my-provider")?.label === "自建厂商");
check("添的时候记了时间", upserted.updatedAt > 0);
stores.settings.upsertProvider({ ...provider, label: "自建厂商（改）" });
check("再添一次是改不是加", stores.settings.getProvider("my-provider")?.label === "自建厂商（改）");
check("供应商还是一个", stores.settings.get().providers.length === 1);

stores.settings.mutate((draft) => {
	draft.defaultModel = "my-provider/gpt-4o";
});
check("默认模型指向了它", stores.settings.get().defaultModel === "my-provider/gpt-4o");
check("删掉供应商返回 true", stores.settings.removeProvider("my-provider") === true);
check("供应商没了", stores.settings.getProvider("my-provider") === undefined);
check("指向它的默认模型被清掉", stores.settings.get().defaultModel === "");
check("删不存在的供应商返回 false", stores.settings.removeProvider("没有这个") === false);

// ───────────────────────────────────────── 厂商密钥

console.log("\n厂商密钥");
const SECRET = "sk-绝不能外泄的一串密钥";
await stores.credentials.setKey("cred-1", SECRET);
check("setKey 之后有钥匙", stores.credentials.hasKey("cred-1"));
check("脱显是掩码", stores.credentials.maskedKey("cred-1") === MASKED_KEY);
check("脱显不是密钥本身", stores.credentials.maskedKey("cred-1") !== SECRET);
check("没配的厂商没有钥匙", !stores.credentials.hasKey("cred-2"));
check("没配的厂商脱显是空", stores.credentials.maskedKey("cred-2") === "");

const credential = await stores.credentials.read("cred-1");
check("read 拿得到凭据", credential?.type === "api_key");
check("read 拿得到密钥本身", credential?.type === "api_key" && credential.key === SECRET);
check("读不存在的返回 undefined", (await stores.credentials.read("没有这个")) === undefined);

const credentialList = await stores.credentials.list();
check("list 列出这一条", credentialList.length === 1 && credentialList[0]?.providerId === "cred-1");
check("list 只给类型", credentialList[0]?.type === "api_key");
check("list 里没有 key 字段", !("key" in (credentialList[0] ?? {})));
check("list 的输出里找不到密钥", !JSON.stringify(credentialList).includes(SECRET));

await stores.credentials.modify("cred-1", async (current) => ({
	type: "api_key",
	key: "sk-换过的一串",
	...(current?.type === "api_key" && current.env ? { env: current.env } : {}),
}));
check("modify 改掉了", (await stores.credentials.read("cred-1"))?.key === "sk-换过的一串");
const unchanged = await stores.credentials.modify("cred-1", async () => undefined);
check("modify 返回 undefined 表示不改", unchanged?.key === "sk-换过的一串");
await stores.credentials.setKey("cred-1", undefined);
check("setKey(undefined) 清掉了", !(await stores.credentials.read("cred-1")));
check("清掉之后 hasKey 为假", !stores.credentials.hasKey("cred-1"));
check("清掉之后 list 里也没有了", (await stores.credentials.list()).length === 0);
await stores.credentials.setKey("cred-2", "sk-第二个");
await stores.credentials.delete("cred-2");
check("delete 删掉了", !(await stores.credentials.read("cred-2")));
check("delete 之后 list 里也没有了", (await stores.credentials.list()).length === 0);

// ───────────────────────────────────────── 生成记录

console.log("\n生成记录");
const record = await stores.records.create({
	role: "writing",
	projectId: "book-1",
	chapterId: "ch-1",
	title: "第一章",
});
check("建出来了", Boolean(record.id));
check("建出来时是空的", (stores.records.get(record.id)?.messages.length ?? 0) === 0);

const saved = await stores.records.saveMessages(record.id, [
	userMessage("写一段雨夜"),
	assistantMessage("雨落在铁皮棚上。"),
]);
check("消息存下来了", saved?.messages.length === 2);
check("get 拿得到消息", stores.records.get(record.id)?.messages.length === 2);
check("预览取的是助手那句话", stores.records.get(record.id)?.preview === "雨落在铁皮棚上。");

const summaries = stores.records.list({ projectId: "book-1" }, 50);
check("列得出记录", summaries.length === 1);
check("列表里没有消息体", !("messages" in (summaries[0] ?? {})));
check("列表里有消息条数", summaries[0]?.messageCount === 2);
check("列表按时间倒序", summaries[0]?.id === record.id);

await stores.records.rename(record.id, "第一章（改）");
check("改名生效", stores.records.get(record.id)?.title === "第一章（改）");

// 同一块面板只留最近的几条。
const scope = { role: "material" as const, projectId: "book-1", chapterId: "ch-2" };
const kept: string[] = [];
for (let index = 0; index < RECORDS_KEEP + 3; index += 1) {
	const created = await stores.records.create({ ...scope, title: "第 " + index + " 轮" });
	kept.push(created.id);
	await tick();
}
const inScope = stores.records.list({ projectId: "book-1", chapterId: "ch-2" }, 100);
check("同一面板只留 " + RECORDS_KEEP + " 条", inScope.length === RECORDS_KEEP, "实际 " + inScope.length);
check("留的是最新的那几条", inScope[0]?.id === kept[kept.length - 1]);
check("最老的那几条被挤掉了", !inScope.some((item) => item.id === kept[0]));

// 超体积的记录要裁。
const bigRecord = await stores.records.create({ role: "writing", projectId: "book-2", title: "大的" });
const fat = "长".repeat(120_000);
const fatMessages: AgentMessage[] = [];
for (let index = 0; index < 10; index += 1) fatMessages.push(userMessage(fat + index));
const trimmed = await stores.records.saveMessages(bigRecord.id, fatMessages);
check("超体积的记录被裁了", (trimmed?.messages.length ?? 0) < fatMessages.length);
check("至少还留着 4 条", (trimmed?.messages.length ?? 0) >= 4);
check("裁完还在体积上限之内", JSON.stringify(trimmed?.messages ?? []).length <= MAX_RECORD_BYTES + 200_000);

check("删记录返回 true", (await stores.records.remove(record.id)) === true);
check("删掉之后取不到", stores.records.get(record.id) === undefined);
check("删不存在的返回 false", (await stores.records.remove("没有这个 id")) === false);

// ───────────────────────────────────────── 关掉重开

console.log("\n关掉重开");
const keptMaterial = stores.library.create({ kind: "world", title: "关掉也在" });
await stores.credentials.setKey("cred-keep", "sk-留着");
stores.settings.mutate((draft) => {
	draft.defaultModel = "留下记号/gpt-4o";
});
await stores.library.flush();
await stores.settings.flush();
await stores.credentials.flush();
await stores.records.flush();

closeIdbStores(stores);
const reopened = await openIdbStores(options);
check("重开后素材还在", reopened.library.get(keptMaterial.id)?.title === "关掉也在");
check("重开后密钥还在", reopened.credentials.hasKey("cred-keep"));
check("重开后设置还在", reopened.settings.get().defaultModel === "留下记号/gpt-4o");
check("重开后记录还在", reopened.records.list({ projectId: "book-2" }, 50).length === 1);
check("重开后自建种类还在", reopened.kinds.list().length >= 1);
check("重开后落盘的表都还在", factory.row(DB, "library", keptMaterial.id) !== undefined);

// ───────────────────────────────────────── 落盘失败

console.log("\n落盘失败");
factory.failWrites = true;
const broken = await openIdbStores({ indexedDB: factory, name: "novel-studio-meta-broken" });
const risky = broken.library.create({ kind: "world", title: "差点丢的一条" });
let flushError: unknown = null;
await broken.library.flush().then(
	() => {
		flushError = null;
	},
	(error: unknown) => {
		flushError = error;
	},
);
check("flush 抛错了", flushError !== null);
check("错误里说清是谁没落盘", String((flushError as Error | undefined)?.message ?? "").includes("通用素材库"));
check("内存里的值还在", broken.library.get(risky.id)?.title === "差点丢的一条");
check("确实没落盘", factory.row("novel-studio-meta-broken", "library", risky.id) === undefined);

factory.failWrites = false;
await broken.library.retryPending();
const recovered = factory.row("novel-studio-meta-broken", "library", risky.id) as { title?: string } | undefined;
check("重试之后补写进去了", recovered?.title === "差点丢的一条");
check("重试之后 flush 不再抛错", await broken.library.flush().then(
	() => true,
	() => false,
));

console.log(failed === 0 ? "\n全部通过" : "\n有 " + failed + " 项没过");
if (failed > 0) process.exitCode = 1;
