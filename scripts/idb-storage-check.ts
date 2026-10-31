/**
 * IndexedDB 存储验收：数据只在用户自己的浏览器里。
 *
 * 这套改造的承诺是"多用户 web 应用，服务器什么都不留"。
 * 兑现这条承诺的一半在服务端，另一半在浏览器：工程得能**只存在用户自己的
 * IndexedDB 里**，存得进、取得出、坏得掉也能补写回来。
 *
 * 这里用内存版 IndexedDB 替身在 Node 里逐项核对：
 *   1. 骨架与同步可见性 —— 端口是同步的，改完立刻能读到，重开还在。
 *   2. 正文与历史 —— revision 递增、keepHistory 才归档。
 *   3. 历史条数上限 —— 旧稿不能无限堆。
 *   4. 快照 —— 能拍、能读回、条数有上限。
 *   5. 回收站 —— 删了能整本恢复，正文不丢。
 *   6. 永久删除 —— 删干净了，库里不剩残骸。
 *   7. 写失败 —— 内存里的稿不丢，flush 会抛错，重试能补上。
 *   8. 章节写锁 —— 同一章不交错，不同章能并行。
 *   9. 重开新实例 —— 数据确实落库了，不是只活在内存里。
 *
 * 跑法：node --experimental-strip-types scripts/idb-storage-check.ts
 */
import { MAX_DRAFT_HISTORY } from "../src/store/project.ts";
import { IdbProjectStore, MAX_SNAPSHOTS } from "../src/store/project-idb.ts";
import { createFakeIndexedDB } from "../src/store/idb-test-double.ts";

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

/** 从库里捞出来的一行里取 projectId（行是 unknown，先收窄）。 */
function rowProjectId(row: unknown): string {
	if (typeof row !== "object" || row === null || !("projectId" in row)) return "";
	return String((row as { projectId: unknown }).projectId);
}

/** 库里某一章正文行的正文（用来看确实写进去了）。 */
function rowContent(row: unknown): string {
	if (typeof row !== "object" || row === null || !("content" in row)) return "";
	return String((row as { content: unknown }).content);
}

const fake = createFakeIndexedDB();
const store = await IdbProjectStore.open({ indexedDB: fake });

console.log("\n一、骨架与同步可见性");
const project = store.create({ title: "浏览器里的书", genre: "悬疑", logline: "雨夜，有人敲错了门。" });
check("create 之后 list() 看得到", store.list().some((item) => item.id === project.id));
check("create 之后 get() 取得到", store.get(project.id)?.title === "浏览器里的书");
check("create 之后 get() 拿得到 logline", store.get(project.id)?.logline === "雨夜，有人敲错了门。");
store.mutate(project.id, (p) => {
	p.synopsis = "一桩敲错门的命案。";
	p.outline.push({
		id: "ch1",
		title: "第一章 敲门声",
		summary: "雨夜里有人敲门，喊的是死人的名字。",
		pov: "沈砚",
		volumeId: "",
		status: "drafted",
		targetWords: 3000,
		notes: "",
		materialIds: [],
	});
});
check("mutate 同步可见", store.get(project.id)?.synopsis === "一桩敲错门的命案。");
check("mutate 同步可见（大纲）", store.get(project.id)?.outline.length === 1);
await store.flush();
const reopened = await IdbProjectStore.open({ indexedDB: fake });
check("重开新实例仍看得到工程", reopened.get(project.id)?.title === "浏览器里的书");
check("重开新实例仍看得到改动", reopened.get(project.id)?.synopsis === "一桩敲错门的命案。");
check("重开新实例仍看得到大纲", reopened.get(project.id)?.outline.length === 1);

console.log("\n二、正文与历史");
const meta1 = await store.saveDraftBody(project.id, "ch1", {
	title: "第一章 敲门声",
	content: "第一稿的正文。",
	summary: "有人敲门。",
	keepHistory: true,
});
check("saveDraftBody 带回元数据", meta1.revision === 1 && meta1.hasDraft && meta1.words > 0);
const body1 = await store.readDraftBody(project.id, "ch1");
check("readDraftBody 拿到正文", body1?.content === "第一稿的正文。");
check("第一次写没有历史", (body1?.history.length ?? 0) === 0);
const meta2 = await store.saveDraftBody(project.id, "ch1", {
	title: "第一章 敲门声",
	content: "第二稿的正文。",
	keepHistory: true,
});
check("revision 递增", meta2.revision === 2);
const body2 = await store.readDraftBody(project.id, "ch1", { history: true });
check("旧稿被归档", (body2?.history.length ?? 0) === 1);
check("归档的是上一稿", body2?.history[0]?.content === "第一稿的正文。");
check("归档版本的 revision 是旧稿的号", body2?.history[0]?.revision === 1);
check("骨架里的元数据跟着更新", store.get(project.id)?.drafts["ch1"]?.revision === 2);
await store.saveDraftBody(project.id, "ch2", { title: "第二章", content: "甲稿", keepHistory: false });
await store.saveDraftBody(project.id, "ch2", { title: "第二章", content: "乙稿", keepHistory: false });
const bodyKeep = await store.readDraftBody(project.id, "ch2", { history: true });
check("keepHistory:false 不归档", (bodyKeep?.history.length ?? 0) === 0);
check("keepHistory:false 仍然更新正文", bodyKeep?.content === "乙稿");

console.log("\n三、历史条数上限");
for (let i = 0; i < MAX_DRAFT_HISTORY + 4; i += 1) {
	await store.saveDraftBody(project.id, "ch3", {
		title: "第三章",
		content: "第" + i + "稿",
		keepHistory: true,
	});
}
const body3 = await store.readDraftBody(project.id, "ch3", { history: true });
check("历史不超过上限", (body3?.history.length ?? 0) === MAX_DRAFT_HISTORY);
check("留下的是最近的几版", body3?.history[MAX_DRAFT_HISTORY - 1]?.content === "第" + (MAX_DRAFT_HISTORY + 2) + "稿");
check("正文是最新的一稿", body3?.content === "第" + (MAX_DRAFT_HISTORY + 3) + "稿");

console.log("\n四、快照");
const snapshotName = await store.snapshot(store.get(project.id)!, "动手前");
check("snapshot 回了名字", snapshotName.length > 0);
const snapshots = await store.listSnapshots(project.id);
check("listSnapshots 看得到这份快照", snapshots.some((item) => item.name === snapshotName));
check("快照带体积", (snapshots.find((item) => item.name === snapshotName)?.size ?? 0) > 0);
const snapshotContent = await store.readSnapshot(project.id, snapshotName);
check("readSnapshot 带回骨架", snapshotContent?.project.id === project.id);
check("readSnapshot 带回正文", snapshotContent?.bodies["ch1"]?.content === "第二稿的正文。");
check("readSnapshot 带回历史", (snapshotContent?.bodies["ch1"]?.history.length ?? 0) === 1);
check("readSnapshot 拒绝坏名字", (await store.readSnapshot(project.id, "../../etc/passwd")) === undefined);
for (let i = 0; i < MAX_SNAPSHOTS + 5; i += 1) {
	await store.snapshot(store.get(project.id)!, "第" + i + "次");
}
const manySnapshots = await store.listSnapshots(project.id);
check("快照数不超过上限", manySnapshots.length <= MAX_SNAPSHOTS);
check("留下的是最新的快照", manySnapshots[0]?.name === snapshotName + "" ? false : manySnapshots.length > 0);

console.log("\n五、回收站");
await store.remove(project.id);
check("删除后不在活动列表", store.get(project.id) === undefined);
check("listDeleted 看得到", (await store.listDeleted()).some((item) => item.id === project.id));
const restored = await store.restoreDeleted(project.id);
check("恢复后回到活动列表", restored.id === project.id && store.get(project.id)?.title === "浏览器里的书");
check("恢复后正文完好", (await store.readDraftBody(project.id, "ch1"))?.content === "第二稿的正文。");
check("恢复后历史完好", ((await store.readDraftBody(project.id, "ch1", { history: true }))?.history.length ?? 0) === 1);
check("恢复后回收站条目消失", !(await store.listDeleted()).some((item) => item.id === project.id));

console.log("\n六、永久删除");
const doomed = store.create({ title: "该消失的书" });
await store.saveDraftBody(doomed.id, "ch1", { title: "第一章", content: "不该留下的正文" });
await store.flush();
await store.remove(doomed.id, { permanent: true });
check("永久删除后不在活动列表", store.get(doomed.id) === undefined);
check("永久删除后不在回收站", !(await store.listDeleted()).some((item) => item.id === doomed.id));
const dumped = fake.__dump()["novel-studio"] ?? {};
check("永久删除后库里没有正文残骸", !(dumped["draftBodies"] ?? []).some((row) => rowProjectId(row) === doomed.id));
check("永久删除后库里没有骨架残骸", !(dumped["projects"] ?? []).some((row) => rowProjectId(row) === doomed.id));

console.log("\n七、写入失败");
const fragile = store.create({ title: "写不进去的书" });
await store.flush();
fake.__failPut("projects", fragile.id);
store.mutate(fragile.id, (p) => {
	p.logline = "这一改没能存上";
});
let flushError: unknown = null;
try {
	await store.flush();
} catch (error) {
	flushError = error;
}
check("flush 在有未落盘数据时抛错", flushError !== null);
check("pendingWrites 列出该工程", store.pendingWrites().includes(fragile.id));
check("失败后内存里的修改还在", store.get(fragile.id)?.logline === "这一改没能存上");
fake.__clearFailures();
await store.retryPending();
check("retryPending 之后不再 pending", !store.pendingWrites().includes(fragile.id));
let flushError2: unknown = null;
try {
	await store.flush();
} catch (error) {
	flushError2 = error;
}
check("retryPending 之后 flush 不再抛错", flushError2 === null);

fake.__failPut("draftBodies", [fragile.id, "ch1"]);
let saveError: unknown = null;
try {
	await store.saveDraftBody(fragile.id, "ch1", { title: "第一章", content: "写不进去的正文" });
} catch (error) {
	saveError = error;
}
check("正文写失败会抛错", saveError !== null);
check("pendingChapterWrites 指出是哪一章", (store.pendingChapterWrites()[fragile.id] ?? []).includes("ch1"));
check("写失败后正文没进库", !(fake.__dump()["novel-studio"]?.["draftBodies"] ?? []).some((row) => rowContent(row) === "写不进去的正文"));
fake.__clearFailures();
await store.retryPending();
check("retryPending 补写了正文", (await store.readDraftBody(fragile.id, "ch1"))?.content === "写不进去的正文");
check("补写后 pendingChapterWrites 清空", !(store.pendingChapterWrites()[fragile.id] ?? []).includes("ch1"));
check("补写后 flush 不再抛错", store.pendingWrites().length === 0);

console.log("\n八、章节写锁");
const locked = store.create({ title: "并发写的书" });
await store.flush();
let active = 0;
let overlapped = false;
const order: string[] = [];
const writeOnce = async (label: string): Promise<void> => {
	active += 1;
	if (active > 1) overlapped = true;
	order.push(label + "-进");
	await store.saveDraftBody(locked.id, "ch1", {
		title: "第一章",
		content: label,
		keepHistory: false,
	});
	order.push(label + "-出");
	active -= 1;
};
await Promise.all([
	store.withChapterLock(locked.id, "ch1", () => writeOnce("甲")),
	store.withChapterLock(locked.id, "ch1", () => writeOnce("乙")),
]);
check("同一章的写入不交错", !overlapped);
check("同一章的写入按调用顺序", order.join(",") === "甲-进,甲-出,乙-进,乙-出");
let running = 0;
let parallel = false;
const slowTask = async (): Promise<void> => {
	running += 1;
	if (running > 1) parallel = true;
	await new Promise((resolve) => setTimeout(resolve, 20));
	running -= 1;
};
await Promise.all([
	store.withChapterLock(locked.id, "chA", slowTask),
	store.withChapterLock(locked.id, "chB", slowTask),
]);
check("不同章可以并行", parallel);

console.log("\n九、重开新实例");
const again = await IdbProjectStore.open({ indexedDB: fake });
check("新实例看得到工程", again.list().some((item) => item.id === project.id));
check("新实例看得到标题", again.get(project.id)?.title === "浏览器里的书");
check("新实例能读到正文", (await again.readDraftBody(project.id, "ch1"))?.content === "第二稿的正文。");
check("新实例看得到补写成功的工程", again.get(fragile.id)?.logline === "这一改没能存上");
check("新实例看得到回收站", (await again.listDeleted()).some((item) => item.id === project.id) === false);

console.log(failed === 0 ? "\n全部通过" : "\n有 " + failed + " 项没过");
if (failed > 0) process.exitCode = 1;
