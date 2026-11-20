/**
 * 读缓存：把 GET 的结果存在 IndexedDB 里，下次先用上次的铺界面，再悄悄去取新的。
 *
 * 为什么只缓存读：写有 1.1 秒防抖，本来就落在后台，体感不受影响；
 * 而"点开一本书、换一章"每次都要等一个来回（跨境 300–800ms），
 * 这才是看起来卡的原因。缓存读能把这一段等成 0，冲突面也是 0
 * ——服务端仍然是唯一真相，写完就把对应缓存更新掉。
 *
 * 几条规矩：
 *   1. 缓存按账号分区（key 前缀带用户 id / local / anon），换账号不会串库；
 *   2. 本机模式（/api 走 IndexedDB）不缓存，本来就不用等网络，缓存只会多存一份；
 *   3. 任何写操作都会让相关的缓存失效，见 api.js 的 invalidateAfterWrite；
 *   4. IndexedDB 不可用（隐私模式、配额满）时退回内存缓存，功能不受影响。
 */

const DB_NAME = "novel-studio-cache";
const DB_VERSION = 1;
const STORE = "http";

/** 缓存多久算"可以不急着刷新"。过期不等于不能用：仍然先拿旧的顶上。 */
export const CACHE_TTL = 5 * 60 * 1000;

const memory = new Map();
let dbPromise = null;
let dbBroken = false;

/** 本机模式的 /api 走 IndexedDB，本来就不用等网络，不必再缓存一层。 */
function cacheOn() {
	return typeof window === "undefined" || window.__DSH_LOCAL_MODE__ !== true;
}

function scopeNow() {
	const user = window.__NOVEL_AUTH_STATE__?.user;
	if (user && (user.id || user.email)) return String(user.id || user.email);
	if (window.__NOVEL_MULTIUSER__ === true) return "anon";
	return window.__DSH_LOCAL_MODE__ === true ? "local" : "single";
}

function scoped(key) {
	return `${scopeNow()}\u0000${key}`;
}

function openDb() {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve) => {
		let settled = false;
		let timer = 0;
		const finish = (db) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(db);
		};
		let request;
		try {
			request = indexedDB.open(DB_NAME, DB_VERSION);
		} catch {
			dbBroken = true;
			finish(null);
			return;
		}
		// 另一个标签页正把库删掉、或者 IndexedDB 卡住时，open 会一直悬着。
		// 宁可退回内存缓存，也不能让开书卡在等一个永远不来的回调上。
		timer = setTimeout(() => {
			dbBroken = true;
			finish(null);
		}, 1200);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
		};
		request.onsuccess = () => finish(request.result);
		request.onerror = () => {
			dbBroken = true;
			finish(null);
		};
		request.onblocked = () => finish(null);
	});
	return dbPromise;
}

function withStore(mode, run) {
	return openDb().then(
		(db) =>
			new Promise((resolve) => {
				if (!db) {
					resolve(run(null, null));
					return;
				}
				let transaction;
				try {
					transaction = db.transaction(STORE, mode);
				} catch {
					dbBroken = true;
					resolve(run(null, null));
					return;
				}
				const store = transaction.objectStore(STORE);
				let result = null;
				try {
					run(store, (value) => {
						result = value;
					});
				} catch {
					resolve(null);
					return;
				}
				transaction.oncomplete = () => resolve(result);
				transaction.onerror = () => resolve(result);
				transaction.onabort = () => resolve(result);
			}),
	);
}

/** 读一条；没有就 null。返回 {value, savedAt}。 */
export async function cacheRead(key) {
	if (!cacheOn()) return null;
	const full = scoped(key);
	const hit = memory.get(full);
	if (hit) return hit;
	return withStore("readonly", (store, done) => {
		if (!store) return;
		const request = store.get(full);
		request.onsuccess = () => done(request.result || null);
	});
}

/** 写一条。value 必须是能被结构化克隆的（JSON 得到的东西都行）。 */
export async function cacheWrite(key, value) {
	if (!cacheOn()) return;
	const full = scoped(key);
	const entry = { key: full, value, savedAt: Date.now() };
	memory.set(full, entry);
	await withStore("readwrite", (store) => {
		if (!store) return;
		try {
			store.put(entry);
		} catch {
			/* 配额满/结构不可克隆：内存里那份仍然有效 */
		}
	});
}

/** 删一条。 */
export async function cacheDelete(key) {
	const full = scoped(key);
	memory.delete(full);
	await withStore("readwrite", (store) => {
		if (!store) return;
		try {
			store.delete(full);
		} catch {
			/* 忽略 */
		}
	});
}

/** 删掉某个前缀下的所有条目（用范围删除，按当前账号分区）。 */
export async function cacheDeletePrefix(prefix) {
	const full = scoped(prefix);
	for (const key of [...memory.keys()]) {
		if (key.startsWith(full)) memory.delete(key);
	}
	await withStore("readwrite", (store) => {
		if (!store) return;
		try {
			const range = IDBKeyRange.bound(full, `${full}\uffff`);
			store.delete(range);
		} catch {
			/* 忽略 */
		}
	});
}

/** 清空当前账号的全部缓存（退出登录、切账号时用）。 */
export async function cacheClearScope() {
	const prefix = `${scopeNow()}\u0000`;
	for (const key of [...memory.keys()]) {
		if (key.startsWith(prefix)) memory.delete(key);
	}
	await withStore("readwrite", (store) => {
		if (!store) return;
		try {
			const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
			store.delete(range);
		} catch {
			/* 忽略 */
		}
	});
}

/** 这条缓存该不该去后台取新的。 */
export function isStale(entry, ttl = CACHE_TTL) {
	if (!entry) return true;
	return Date.now() - (entry.savedAt || 0) > ttl;
}

export function cacheStatus() {
	return { enabled: cacheOn(), scope: scopeNow(), broken: dbBroken, memory: memory.size };
}
