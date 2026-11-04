/**
 * 小说拆解库验收：编码、章节/定长拆解、磁盘持久化、检索与设定官工具。
 * 有测试小说时用真实 20MB 文件跑一遍；没有则用合成文本。
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMaterialTools, createWritingTools } from "../src/ai/tools.ts";
import { ProjectStore } from "../src/store/project-disk.ts";
import { decodeNovelBytes, splitNovelText } from "../src/store/novel-source.ts";
import { NovelSourceLibrary } from "../src/store/novel-source-disk.ts";
import { extractNovelText } from "../src/server/upload.ts";

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? item.text ?? "" : "")).join("\n");
}

console.log("\n编码");
const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from("第1章 开端\n正文", "utf8")]);
check("UTF-8 BOM", decodeNovelBytes(utf8Bom).encoding === "UTF-8" && decodeNovelBytes(utf8Bom).text.startsWith("第1章"));
const utf16 = Uint8Array.from(Buffer.from("\uFEFF第1章 开端\n正文", "utf16le"));
check("UTF-16LE BOM", decodeNovelBytes(utf16).encoding === "UTF-16LE" && decodeNovelBytes(utf16).text.includes("第1章"));
const gb18030 = Uint8Array.from([0xb5, 0xda, 0x31, 0xd5, 0xc2, 0x0a, 0xd5, 0xfd, 0xce, 0xc4]);
check("GB18030", decodeNovelBytes(gb18030).encoding === "GB18030" && decodeNovelBytes(gb18030).text.includes("第1章"));

console.log("\n拆解");
const sample = "第1章 开端\n阿青在渡口等船。\n第2章 转折\n阿青发现船底有洞。\n第3章 结局\n阿青游回了岸。";
const byChapter = splitNovelText(sample);
check("按章节标题拆解", byChapter.splitMode === "chapters" && byChapter.chapters.length === 3, JSON.stringify(byChapter));
check("章节名保留", byChapter.chapters[1]?.title === "第2章 转折", byChapter.chapters[1]?.title);
const plain = "没有章节标题的正文。".repeat(600);
const byFixed = splitNovelText(plain, { fixedChars: 2000 });
check("无标题回退定长", byFixed.splitMode === "fixed" && byFixed.chapters.length >= 2, String(byFixed.chapters.length));
const bySingle = splitNovelText(sample, { splitMode: "single" });
check(
	"资料整篇保存",
	bySingle.splitMode === "single" && bySingle.chapters.length === 1 && bySingle.chapters[0]?.content.includes("第2章") === true,
);

const dir = await mkdtemp(path.join(tmpdir(), "novel-source-check-"));
try {
	const library = await NovelSourceLibrary.open(dir);
	const source = await library.create({ filename: "sample.txt", text: sample, encoding: "UTF-8" });
	check("磁盘建源", source.chapterCount === 3 && library.list().length === 1);
	check("按章读正文", (await library.readChapter(source.id, "ch002"))?.content.includes("船底有洞") === true);
	const hits = await library.search(source.id, "阿青", { limit: 5 });
	check("检索命中多章", hits.length >= 2, JSON.stringify(hits.map((hit) => hit.chapterId)));
	check("检索带片段", hits[0]?.snippet.includes("阿青") === true);

	const document = await library.create({
		kind: "document",
		filename: "notes.txt",
		text: "一份普通资料，讲渡口的风俗。",
		encoding: "UTF-8",
	});
	check("资料按整篇落库", document.kind === "document" && document.splitMode === "single" && document.chapterCount === 1);
	check("资料可读正文", (await library.readChapter(document.id, "ch001"))?.content.includes("渡口") === true);
	check("资料与小说共用列表", library.list().length === 2);

	const projectStore = await ProjectStore.open(dir);
	const project = projectStore.create({ title: "拆解测试", genre: "都市" });
	const tools = createMaterialTools({ store: projectStore, projectId: project.id, novelStore: library });
	const names = tools.map((tool) => tool.name);
	check("设定官拿到小说工具", ["list_novel_sources", "list_novel_chapters", "search_novel_source", "read_novel_chapter"].every((name) => names.includes(name)));
	check("执笔者没有小说工具", !createWritingTools({ store: projectStore, projectId: project.id }).some((tool) => tool.name.startsWith("list_novel") || tool.name.startsWith("search_novel") || tool.name === "read_novel_chapter"));
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const listed = await byName.get("list_novel_sources")!.execute("t1", {}, undefined);
	check("工具列出 sourceId", toolText(listed).includes(source.id), toolText(listed).slice(0, 120));
	check("工具区分资料与小说", toolText(listed).includes("资料") && toolText(listed).includes("小说"), toolText(listed).slice(0, 160));
	const searched = await byName.get("search_novel_source")!.execute("t2", { sourceId: source.id, query: "船底", limit: 3 }, undefined);
	check("工具检索命中", toolText(searched).includes("ch002") && toolText(searched).includes("船底有洞"), toolText(searched).slice(0, 180));
	const read = await byName.get("read_novel_chapter")!.execute("t3", { sourceId: source.id, chapterId: "ch002" }, undefined);
	check("工具读章", toolText(read).includes("船底有洞"), toolText(read).slice(0, 100));

	// 模拟设定官的多轮取料：第二轮换词、读章，再把结论落成素材；同一本书还能接着提炼第二条。
	const secondSearch = await byName.get("search_novel_source")!.execute("t4", { sourceId: source.id, query: "游回", limit: 3 }, undefined);
	check("第二轮换词检索", toolText(secondSearch).includes("ch003"), toolText(secondSearch).slice(0, 140));
	const upsert = byName.get("upsert_material")!;
	await upsert.execute(
		"t5",
		{
			kind: "plot",
			title: "船底有洞",
			content: "阿青发现船底有洞，最后游回岸上。\n来源：《sample》第2–3章",
			usage: "需要写渡船隐患或落水自救的桥段",
		},
		undefined,
	);
	check("检索结果落成素材", projectStore.get(project.id)?.materials.some((m) => m.title === "船底有洞") === true);
	await upsert.execute(
		"t6",
		{
			kind: "character",
			title: "阿青",
			content: "在渡口等船，发现船底有洞后游回岸上。\n来源：《sample》第1–3章",
			usage: "需要写谨慎、会水的渡客",
		},
		undefined,
	);
	check("同一拆解可继续提炼", projectStore.get(project.id)?.materials.length === 2);

	const real = "C:\\Users\\cttai\\Documents\\测试-1.txt";
	if (existsSync(real)) {
		console.log("\n真实小说");
		const bytes = new Uint8Array(await readFile(real));
		const extracted = await extractNovelText("测试-1.txt", bytes);
		check("真实文件识别 UTF-8", extracted.encoding === "UTF-8", extracted.encoding);
		check("真实文件未截断", extracted.text.length > 6_800_000, String(extracted.text.length));
		const realSource = await library.create({ filename: "测试-1.txt", text: extracted.text, encoding: extracted.encoding });
		check("真实文件章节数", realSource.chapterCount === 2145, String(realSource.chapterCount));
		check("真实文件首章", realSource.chapters[1]?.title === "第1章舔狗系统", realSource.chapters[1]?.title);
		const realHits = await library.search(realSource.id, "舔狗", { limit: 6 });
		check("真实文件多章命中", realHits.length >= 3, JSON.stringify(realHits.map((hit) => hit.chapterId)));
		check("真实文件可读章", (await library.readChapter(realSource.id, realHits[0]!.chapterId))?.content.length! > 0);
	} else {
		console.log("\n真实小说：测试文件不存在，跳过");
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`\n失败 ${failed} 项`);
	process.exitCode = 1;
} else {
	console.log("\n小说拆解全部通过");
}
