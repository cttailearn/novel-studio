/**
 * 存储分层验收：千万字也不卡。
 *
 * 这套改造要解决的是一句话：一部长篇写到千万字时，
 * 打开工程、存一次稿、让模型看一眼章目，都不该把整本书搬一遍。
 *
 * 这里造一部"大书"，逐项核对四件事：
 *   1. 骨架与正文分离 —— 骨架里没有正文，元数据带字数。
 *   2. 接口分层 —— 整本响应只带骨架，按需取才给正文；统计是加法不是扫描。
 *   3. 存储拆分 —— 每章正文与历史各自成文件，老工程惰性迁移且不删原件。
 *   4. 快照瘦身 —— 快照压成 gzip，仍带着正文，回滚能用。
 *   5. 工具分页 —— 模型的 list_chapters 不再一口气吞下全书。
 *
 * 跑法：node --experimental-strip-types scripts/storage-check.ts
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { ProjectStore, encodeFileName, projectStats, type ChapterDraft } from "../src/store/project.ts";
import { MaterialLibrary } from "../src/store/library.ts";
import { createWritingTools } from "../src/ai/tools.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { RECORDS_KEEP, RecordStore } from "../src/server/records.ts";

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

/** 一章的正文：约 9500 字，与真实长章同量级。 */
const CHAPTER_CHARS = 9504;
const CHAPTERS = Number(process.env.STORAGE_CHECK_CHAPTERS ?? 200);
const SENTENCE = "雨落在铁皮棚上，裴渡把袖口的线头绕在指节上，又松开。";
const BODY = SENTENCE.repeat(Math.ceil(CHAPTER_CHARS / SENTENCE.length)).slice(0, CHAPTER_CHARS);

const dir = await mkdtemp(path.join(tmpdir(), "novel-storage-"));
const store = await ProjectStore.open(dir);
const project = store.create({ title: "存储压测", targetWords: CHAPTERS * CHAPTER_CHARS });

console.log("\n造书");
console.log(`  ${CHAPTERS} 章 × ${CHAPTER_CHARS} 字 ≈ ${((CHAPTERS * CHAPTER_CHARS) / 10000).toFixed(1)} 万字`);

store.mutate(project.id, (p) => {
	for (let i = 0; i < CHAPTERS; i += 1) {
		p.outline.push({
			id: "ch" + String(i + 1).padStart(4, "0"),
			title: "第" + (i + 1) + "章 夜航",
			summary: "这一章要略：裴渡在雨夜把一件不该存在的货交了出去。",
			pov: "裴渡",
			volumeId: "",
			status: "drafted",
			targetWords: CHAPTER_CHARS,
			notes: "",
			materialIds: [],
		});
	}
	// 末尾留三章没动笔：用来验 list_chapters 的 scope 筛选。
	for (let i = 0; i < 3; i += 1) {
		p.outline.push({
			id: "ch-plan-" + i,
			title: "第" + (CHAPTERS + i + 1) + "章 未写",
			summary: "还没动笔的章。",
			pov: "裴渡",
			volumeId: "",
			status: "planned",
			targetWords: CHAPTER_CHARS,
			notes: "",
			materialIds: [],
		});
	}
});

const writeStarted = Date.now();
for (let i = 0; i < CHAPTERS; i += 1) {
	const id = "ch" + String(i + 1).padStart(4, "0");
	await store.saveDraftBody(project.id, id, {
		title: "第" + (i + 1) + "章 夜航",
		content: BODY,
		summary: "这一章实际写了什么的小结。",
		materialIds: [],
		mode: "create",
	});
}
const writeMs = Date.now() - writeStarted;
console.log(`  写完 ${CHAPTERS} 章用时 ${writeMs} ms`);

const bodyChars = CHAPTERS * CHAPTER_CHARS;

// ───────────────────────────────────────────── 1. 骨架与正文分离
console.log("\n骨架与正文分离");
const skeletonRaw = await readFile(path.join(dir, project.id + ".json"), "utf8");
const skeleton = JSON.parse(skeletonRaw) as { drafts?: Record<string, { content?: unknown; words?: number; hasDraft?: boolean }> };
const metas = Object.values(skeleton.drafts ?? {});
check("骨架里有每一章的元数据", metas.length === CHAPTERS, String(metas.length));
check("骨架里没有正文", metas.every((meta) => typeof meta.content !== "string"), "有章带着正文");
check("元数据带字数", metas.every((meta) => typeof meta.words === "number" && (meta.words ?? 0) > 0), "有章缺字数");
check("元数据带成稿标记", metas.every((meta) => meta.hasDraft === true), "有章缺 hasDraft");
const skeletonBytes = Buffer.byteLength(skeletonRaw, "utf8");
const bodyFiles0 = await readdir(path.join(dir, "drafts", project.id));
let bodyBytes = 0;
for (const name of bodyFiles0.filter((n) => n.endsWith(".txt"))) {
	bodyBytes += (await stat(path.join(dir, "drafts", project.id, name))).size;
}
// 骨架的体积只跟"有多少章"有关，跟"每章多长"无关 ——
// 这才是分层存储的意义：一章写十万字，骨架也不会跟着涨。
const perChapterOverhead = skeletonBytes / CHAPTERS;
check("每章骨架开销不到 1KB", perChapterOverhead < 1024, Math.round(perChapterOverhead) + " 字节/章");
check("骨架比正文小一个数量级以上", skeletonBytes * 30 < bodyBytes, `骨架 ${skeletonBytes} 字节，正文 ${bodyBytes} 字节`);
console.log(
	`  骨架 ${skeletonBytes} 字节（${Math.round(perChapterOverhead)} 字节/章）· ` +
		`正文 ${(bodyBytes / 1024 / 1024).toFixed(1)} MB · 比值 1:${Math.round(bodyBytes / skeletonBytes)}`,
);

// ───────────────────────────────────────────── 2. 接口分层
console.log("\n接口分层");
const wholeResponse = JSON.stringify({
	project: store.get(project.id),
	chapters: store.get(project.id)!.outline.map((chapter) => store.get(project.id)!.drafts[chapter.id]),
	stats: projectStats(store.get(project.id)!),
});
const oneChapter = JSON.stringify(await store.readDraftBody(project.id, "ch0001"));
check(
	"整本响应里没有正文",
	!wholeResponse.includes("雨落在铁皮棚上"),
	"整本响应里混进了正文",
);
check(
	"整本响应远小于正文总量",
	Buffer.byteLength(wholeResponse, "utf8") * 10 < bodyBytes,
	`整本 ${Buffer.byteLength(wholeResponse, "utf8")} 字节`,
);
check(
	"按需取一章只给一章",
	Buffer.byteLength(oneChapter, "utf8") < Buffer.byteLength(wholeResponse, "utf8"),
	"按需取反而不比整本小",
);
check(
	"按需取与全书大小无关",
	Buffer.byteLength(oneChapter, "utf8") < (bodyBytes / CHAPTERS) * 1.5,
	`单章 ${Buffer.byteLength(oneChapter, "utf8")} 字节，一章正文 ${Math.round(bodyBytes / CHAPTERS)} 字节`,
);
console.log(
	`  整本响应 ${(Buffer.byteLength(wholeResponse, "utf8") / 1024).toFixed(0)} KB · ` +
		`单章 ${(Buffer.byteLength(oneChapter, "utf8") / 1024).toFixed(0)} KB`,
);

// 统计必须是加法：字数记在元数据里，不能每次扫全书。
const statStarted = Date.now();
for (let i = 0; i < 200; i += 1) projectStats(store.get(project.id)!);
const statMs = Date.now() - statStarted;
check("统计 200 次不扫正文", statMs < 200, statMs + " ms / 200 次");
console.log(`  统计 200 次用时 ${statMs} ms（增量加法）`);

// 换成千万字规模推算：1000 章 × 9504 字。
const scaled = {
	骨架: Math.round((skeletonBytes / CHAPTERS) * 1000 / 1024) + " KB",
	整本响应: Math.round((Buffer.byteLength(wholeResponse, "utf8") / CHAPTERS) * 1000 / 1024) + " KB",
	正文: Math.round((bodyBytes / CHAPTERS) * 1000 / 1024 / 1024) + " MB",
};
console.log(
	`  推算到 1000 章（${((bodyBytes / CHAPTERS) * 1000 / 10000).toFixed(0)} 万字）：` +
		`骨架 ${scaled.骨架} · 整本响应 ${scaled.整本响应} · 正文 ${scaled.正文}`,
);

// ───────────────────────────────────────────── 3. 存储拆分
console.log("\n存储拆分");
const draftDir = path.join(dir, "drafts", project.id);
const names = await readdir(draftDir);
const metaFiles = names.filter((n) => n.endsWith(".meta.json"));
const bodyFiles = names.filter((n) => n.endsWith(".txt"));
check("每章一份元数据文件", metaFiles.length === CHAPTERS, String(metaFiles.length));
check("每章一份正文文件", bodyFiles.length === CHAPTERS, String(bodyFiles.length));
const bodyStat = await stat(path.join(draftDir, bodyFiles[0]!));
check("正文文件确实有内容", bodyStat.size > 9000, String(bodyStat.size));

// 覆盖写要留退路：旧稿进历史目录，每版一个文件。
await store.saveDraftBody(project.id, "ch0001", {
	title: "第1章 夜航",
	content: BODY.slice(0, -100) + "（改过的结尾）",
	materialIds: [],
	mode: "rewrite",
});
const histDir = path.join(draftDir, encodeFileName("ch0001") + ".hist");
const histNames = await readdir(histDir).catch(() => [] as string[]);
check("覆盖写留下历史版本", histNames.length === 1, histNames.join(","));
const histBody = await readFile(path.join(histDir, histNames[0]!), "utf8").catch(() => "");
check("历史里存的是旧正文", histBody.includes("雨落在铁皮棚上"), histBody.slice(0, 20));

// 自动存稿不读取或重写历史；显式存稿只新增当前旧版，不重写保留版本。
const autosaveStart = await readFile(path.join(draftDir, encodeFileName("ch0001") + ".txt"), "utf8");
await store.saveDraftBody(project.id, "ch0001", {
	title: "第1章 夜航",
	content: autosaveStart + "\n自动保存的一小段。",
	materialIds: [],
	keepHistory: false,
});
check("自动存稿不改写历史", histNames.length === (await readdir(histDir)).length);
const retainedHistoryFile = path.join(histDir, histNames[0]!);
const retainedHistoryStat = await stat(retainedHistoryFile);
await store.saveDraftBody(project.id, "ch0001", {
	title: "第1章 夜航",
	content: autosaveStart + "\n另一次显式保存。",
	materialIds: [],
	mode: "rewrite",
});
check("显式存稿只新增当前旧版", (await readdir(histDir)).length === 2);
check("保留的历史文件不被重写", (await stat(retainedHistoryFile)).mtimeMs === retainedHistoryStat.mtimeMs);

// ───────────────────────────────────────────── 4. 老工程惰性迁移
console.log("\n老工程惰性迁移");
const legacyDir = path.join(dir, "legacy");
const legacyStore = await ProjectStore.open(legacyDir);
const legacyProject = legacyStore.create({ title: "老工程" });
await mkdir(path.join(legacyDir, "drafts", legacyProject.id), { recursive: true });
const legacyId = "ch-legacy";
legacyStore.mutate(legacyProject.id, (p) => {
	p.outline.push({
		id: legacyId,
		title: "老章",
		summary: "老要略",
		pov: "",
		volumeId: "",
		status: "drafted",
		targetWords: 0,
		notes: "",
		materialIds: [],
	});
});
// 老格式：正文与历史同处一个 <enc>.json。
await legacyStore.flush();
await writeFile(
	path.join(legacyDir, "drafts", legacyProject.id, encodeFileName(legacyId) + ".json"),
	JSON.stringify({
		id: legacyId,
		title: "老章",
		content: "这是老工程留下来的正文。",
		summary: "老小结",
		revision: 3,
		updatedAt: Date.now(),
		materialIds: [],
		history: [],
	} satisfies ChapterDraft),
	"utf8",
);
const legacyReopened = await ProjectStore.open(legacyDir);
const legacyBody = await legacyReopened.readDraftBody(legacyProject.id, legacyId);
check("老工程的正文读得回来", legacyBody?.content === "这是老工程留下来的正文。", String(legacyBody?.content));
check("老工程的小结读得回来", legacyReopened.get(legacyProject.id)?.drafts[legacyId]?.summary === "老小结", JSON.stringify(legacyReopened.get(legacyProject.id)?.drafts));
const legacyNames = await readdir(path.join(legacyDir, "drafts", legacyProject.id));
check("迁移后正文拆成新文件", legacyNames.some((n) => n.endsWith(".txt")), legacyNames.join(","));
check("老文件改名留存而不是删除", legacyNames.some((n) => n.endsWith(".json.migrated")), legacyNames.join(","));

// ───────────────────────────────────────────── 5. 快照瘦身
console.log("\n快照瘦身");
const snapName = await store.snapshot(store.get(project.id)!, "压测");
check("快照是 gzip", snapName.endsWith(".json.gz"), snapName);
const snapStat = await stat(path.join(dir, "snapshots", project.id, snapName));
const rawSnapshot = JSON.stringify({ project: store.get(project.id)!, bodies: {} });
check("快照比原始 JSON 小一半以上", snapStat.size * 2 < Buffer.byteLength(rawSnapshot, "utf8"), snapStat.size + " 字节");
const restored = await store.readSnapshot(project.id, snapName);
check("快照读得回骨架", restored?.project.outline.length === CHAPTERS + 3, String(restored?.project.outline.length));
check("快照带着正文", Object.keys(restored?.bodies ?? {}).length >= CHAPTERS, String(Object.keys(restored?.bodies ?? {}).length));
const gz = await readFile(path.join(dir, "snapshots", project.id, snapName));
check("gzip 内容能解开", gunzipSync(gz).length > 0);
console.log(`  快照 ${(snapStat.size / 1024).toFixed(0)} KB（原始 JSON 约 ${(Buffer.byteLength(rawSnapshot, "utf8") / 1024).toFixed(0)} KB）`);

// ───────────────────────────────────────────── 6. 工具分页
console.log("\n工具分页");
const tools = createWritingTools({ store, projectId: project.id });
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const callTool = async (name: string, params: unknown = {}) => {
	const tool = byName.get(name);
	if (!tool) throw new Error("未找到工具 " + name);
	const res = (await tool.execute("storage-check", params as never, undefined, undefined)) as {
		content?: { type: string; text?: string }[];
	};
	// 工具结果是一块 content 数组，正文在第一块的 text 里。
	const text = (res.content ?? []).map((part) => part.text ?? "").join("\n");
	return text || JSON.stringify(res);
};

const firstPage = await callTool("list_chapters");
const pageLines = firstPage.split("\n").filter((line) => /^\s*-\s*\d+\./.test(line));
check("默认只列一页", pageLines.length <= 40, String(pageLines.length));
check("默认这一页是开头的章", firstPage.includes("第1章"), firstPage.slice(0, 80));
const secondPage = await callTool("list_chapters", { offset: 40 });
check("翻页能翻到后面的章", secondPage.includes("第41章"), secondPage.slice(0, 80));
const narrowed = await callTool("list_chapters", { scope: "undrafted", limit: 10 });
check("按范围筛生效", narrowed.includes("第201章") && !narrowed.includes("第1章 "), narrowed.slice(0, 120));
const draftedOnly = await callTool("list_chapters", { scope: "drafted", limit: 3 });
check("按范围筛出已写的", draftedOnly.includes("第1章") && !draftedOnly.includes("第201章"), draftedOnly.slice(0, 120));
const withSummary = await callTool("list_chapters", { limit: 3, withSummary: true });
check("要略按需才给", withSummary.includes("裴渡在雨夜把一件不该存在的货交了出去"), withSummary.slice(0, 200));
const withoutSummary = await callTool("list_chapters", { limit: 3 });
check("不要略时不给要略", !withoutSummary.includes("裴渡在雨夜把一件不该存在的货交了出去"));
const limited = await callTool("list_chapters", { limit: 3 });
check(
	"limit 能收窄页大小",
	limited.split("\n").filter((line) => /^\s*-\s*\d+\./.test(line)).length === 3,
	limited.split("\n").filter((line) => /^\s*-\s*\d+\./.test(line)).length + " 行",
);
const full = await callTool("read_chapter", { chapterId: "ch0001" });
const tail = await callTool("read_chapter", { chapterId: "ch0001", part: "tail", chars: 200 });
check("分段取只给一段", tail.length < full.length, tail.length + " vs " + full.length);
check("尾段是结尾而不是开头", tail.includes("雨落在铁皮棚上"), tail.slice(0, 60));

// ───────────────────────────────────────────── 7. 生成记录
console.log("\n生成记录");
const recordsDir = await mkdtemp(path.join(tmpdir(), "novel-records-"));
const records = await RecordStore.open(recordsDir);
const panel = { role: "writing" as const, projectId: "book-a", chapterId: "ch01" };
const opening = await records.create({ ...panel, title: "《第一章》· 从零写起" });
// 一轮里既有用户的交代，也有助手的收尾；preview 只该摘助手那句。
const roundMessages = [
	{ role: "user", content: "这一章写雨夜追车，别让裴渡先开口。" },
	{ role: "assistant", content: [{ type: "text", text: "雨刷把挡风玻璃推出一道亮缝。" }] },
] as unknown as AgentMessage[];
await records.saveMessages(opening.id, roundMessages);
const afterFirstRound = records.list(panel);
check("新建的记录能列出来", afterFirstRound.length === 1, String(afterFirstRound.length));
check(
	"messageCount 数的是写进去的消息",
	afterFirstRound[0]?.messageCount === roundMessages.length,
	String(afterFirstRound[0]?.messageCount),
);
check(
	"preview 摘的是最后一条助手的话",
	String(afterFirstRound[0]?.preview ?? "").includes("雨刷把挡风玻璃推出一道亮缝"),
	String(afterFirstRound[0]?.preview),
);

// 每块面板只留最近 10 条：第 11 条落盘时最老的那条被挤掉。
const capPanel = { role: "writing" as const, projectId: "book-cap", chapterId: "ch-cap" };
const cappedIds: string[] = [];
for (let index = 0; index < RECORDS_KEEP + 1; index++) {
	const created = await records.create({ ...capPanel, title: "第 " + (index + 1) + " 条" });
	cappedIds.push(created.id);
	// 拉开时间戳先后，裁剪顺序才是确定的。
	await new Promise((resolve) => setTimeout(resolve, 2));
}
const cappedList = records.list(capPanel);
check("同一块面板最多留 10 条", cappedList.length === RECORDS_KEEP, String(cappedList.length));
check(
	"最老的一条被挤出去",
	!cappedList.some((record) => record.id === cappedIds[0]!),
	cappedList.map((record) => record.title).join(","),
);
check("被挤掉的记录也取不到了", records.get(cappedIds[0]!) === undefined);

// 不同面板各自计额：另一章的记录不该被这一章的裁剪带走。
const siblingPanel = { role: "writing" as const, projectId: "book-cap", chapterId: "ch-other" };
const sibling = await records.create({ ...siblingPanel, title: "另一块面板的一条" });
check("不同章的记录落在另一块面板", records.list(siblingPanel).length === 1, String(records.list(siblingPanel).length));
check(
	"另一块面板的记录不会被这块面板的裁剪带走",
	records.get(sibling.id) !== undefined && records.list(capPanel).length === RECORDS_KEEP,
	String(records.list(capPanel).length),
);

check("remove 一条存在的记录返回 true", (await records.remove(opening.id)) === true);
check("remove 之后列表少了一条", records.list(panel).length === 0, String(records.list(panel).length));
check("remove 不存在的 id 返回 false", (await records.remove("ghost-record")) === false);

// 落盘要真的读得回来：重新打开同一个目录，条数与内容都对得上。
const latestId = cappedIds[RECORDS_KEEP]!;
await records.saveMessages(latestId, roundMessages);
const beforeReopen = records.list(capPanel);
const reopened = await RecordStore.open(recordsDir);
const afterReopen = reopened.list(capPanel);
check("重新打开同一目录读回全部 10 条", afterReopen.length === RECORDS_KEEP, String(afterReopen.length));
check(
	"读回的记录 id 与落盘前一致",
	afterReopen.map((record) => record.id).sort().join(",") === beforeReopen.map((record) => record.id).sort().join(","),
);
check(
	"读回的记录带着消息",
	reopened.get(latestId)?.messages.length === roundMessages.length,
	String(reopened.get(latestId)?.messages.length),
);
const recordsRaw = JSON.parse(await readFile(path.join(recordsDir, "records.json"), "utf8")) as { version?: number; records?: unknown };
check(
	"records.json 是 version 1 的记录文件",
	recordsRaw.version === 1 && Array.isArray(recordsRaw.records),
	JSON.stringify(recordsRaw).slice(0, 80),
);
await rm(recordsDir, { recursive: true, force: true });

// ───────────────────────────────────────────── 8. 落盘失败与恢复
console.log("\n落盘失败与恢复");
const failureDir = await mkdtemp(path.join(tmpdir(), "novel-failure-"));
const failureStore = await ProjectStore.open(failureDir);
const failureProject = failureStore.create({ title: "故障注入" });
await failureStore.flush();
await mkdir(path.join(failureDir, "drafts", failureProject.id), { recursive: true });
await rm(path.join(failureDir, failureProject.id + ".json"), { force: true });
await mkdir(path.join(failureDir, failureProject.id + ".json"), { recursive: true });
failureStore.mutate(failureProject.id, (p) => { p.title = "故障后的内存标题"; });
await failureStore.flushForProject(failureProject.id).then(
	() => check("ProjectStore 落盘失败会向 flush 抛错", false, "flush 意外成功"),
	() => check("ProjectStore 落盘失败会向 flush 抛错", true),
);
check("ProjectStore 失败后仍保留内存工程", failureStore.get(failureProject.id)?.title === "故障后的内存标题");
check("ProjectStore 失败后保留 dirty", failureStore.pendingWrites().includes(failureProject.id));
await rm(path.join(failureDir, failureProject.id + ".json"), { recursive: true, force: true });
await failureStore.retryPending();
await failureStore.flushForProject(failureProject.id);
check("ProjectStore 后台重试不清除内存且可恢复", failureStore.pendingWrites().length === 0);

const failureLibrary = await MaterialLibrary.open(failureDir);
const failureEntry = failureLibrary.create({ title: "不能丢的素材", content: "原文" });
await failureLibrary.flush();
await rm(path.join(failureDir, "library.json"), { force: true });
await mkdir(path.join(failureDir, "library.json"), { recursive: true });
failureLibrary.update(failureEntry.id, { content: "修改后" });
await failureLibrary.flush().then(
	() => check("MaterialLibrary 落盘失败会向 flush 抛错", false, "flush 意外成功"),
	() => check("MaterialLibrary 落盘失败会向 flush 抛错", true),
);
check("MaterialLibrary 失败后仍保留内存修改", failureLibrary.get(failureEntry.id)?.content === "修改后");
await rm(path.join(failureDir, "library.json"), { recursive: true, force: true });
await failureLibrary.retryPending();
check("MaterialLibrary 后续写入可恢复", (await MaterialLibrary.open(failureDir)).get(failureEntry.id)?.content === "修改后");

const trashDir = await mkdtemp(path.join(tmpdir(), "novel-trash-"));
const trashStore = await ProjectStore.open(trashDir);
const trashProject = trashStore.create({ title: "可恢复作品" });
trashStore.mutate(trashProject.id, (p) => p.outline.push({
	id: "chapter", title: "一章", summary: "", pov: "", volumeId: "", status: "drafted", targetWords: 0, notes: "", materialIds: [],
}));
await trashStore.saveDraftBody(trashProject.id, "chapter", { title: "一章", content: "删除前的正文", keepHistory: false });
await trashStore.flush();
await trashStore.remove(trashProject.id);
check("删除后工程不再在活动列表", trashStore.get(trashProject.id) === undefined);
check("删除后快照进入独立回收站", (await trashStore.listDeleted()).some((item) => item.id === trashProject.id));
const restoredTrash = await trashStore.restoreDeleted(trashProject.id);
check("恢复后工程回到活动列表", restoredTrash.id === trashProject.id && trashStore.get(trashProject.id)?.title === "可恢复作品");
check("恢复后正文仍可读", (await trashStore.readDraftBody(trashProject.id, "chapter"))?.content === "删除前的正文");
check("恢复后回收站条目消失", !(await trashStore.listDeleted()).some((item) => item.id === trashProject.id));
await rm(trashDir, { recursive: true, force: true });
await rm(failureDir, { recursive: true, force: true });

await rm(dir, { recursive: true, force: true });

console.log(failed === 0 ? "\n全部通过" : "\n有 " + failed + " 项没过");
if (failed > 0) process.exitCode = 1;
