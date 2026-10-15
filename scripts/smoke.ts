/**
 * 冒烟测试：不需要任何 API Key，验证工程存储、素材工具链路与两套智能体的工具边界。
 * 运行：pnpm test:tools
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ProjectStore,
	assembledMaterials,
	countWords,
	emptyProject,
	linkMaterials,
	removeMaterial,
	type Material,
} from "../src/store/project.ts";
import { libraryFieldsOf, materialFromLibrary, MaterialLibrary } from "../src/store/library.ts";
import { createMaterialTools, createWritingTools } from "../src/ai/tools.ts";
import { buildContextDigest, buildMaterialSystemPrompt, buildWritingSystemPrompt } from "../src/ai/prompts.ts";
import { BUILTIN_PROVIDERS, getModels, initModelRuntime } from "../src/ai/models.ts";
import { FileCredentialStore } from "../src/config/credential-store.ts";
import { SettingsStore } from "../src/config/settings-store.ts";
import { ensureDefaultSettings } from "../src/ai/models.ts";
import { extractText, MAX_TEXT_CHARS } from "../src/server/upload.ts";
import { deflateRawSync } from "node:zlib";

/**
 * 造一个最小的 zip。docx 就是 zip，这里自己拼一份，
 * 好让解包路径在没有外部文件的情况下也被测到。
 * crc32 一律填 0 —— 读取方不校验它。
 */
function makeZip(name: string, content: string, deflate: boolean): Buffer {
	const raw = Buffer.from(content, "utf8");
	const data = deflate ? deflateRawSync(raw) : raw;
	const method = deflate ? 8 : 0;
	const nameBuf = Buffer.from(name, "utf8");

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(method, 8);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(raw.length, 22);
	local.writeUInt16LE(nameBuf.length, 26);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(method, 10);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(raw.length, 24);
	central.writeUInt16LE(nameBuf.length, 28);

	const cdOffset = local.length + nameBuf.length + data.length;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(central.length + nameBuf.length, 12);
	eocd.writeUInt32LE(cdOffset, 16);

	return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

let failures = 0;
function check(label: string, condition: boolean, extra = ""): void {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label} ${extra}`);
	}
}

const dir = await mkdtemp(path.join(tmpdir(), "novel-studio-smoke-"));

try {
	// ---- 存储层 ----
	console.log("\n存储层");
	const store = await ProjectStore.open(dir);
	const project = store.create({
		title: "测试作品",
		genre: "悬疑",
		logline: "一个句子",
		targetWords: 200000,
	});
	check("创建工程", Boolean(project.id));
	check("默认章节为空", project.outline.length === 0);
	check("默认素材为空", project.materials.length === 0);

	// ---- 工具边界（架构的核心约束） ----
	console.log("\n工具边界");
	const materialNames = createMaterialTools({ store, projectId: project.id }).map((t) => t.name);
	const writingNames = createWritingTools({ store, projectId: project.id }).map((t) => t.name);
	check("素材工具集不含 write_chapter", !materialNames.includes("write_chapter"), materialNames.join(","));
	check("写作工具集不含 upsert_material", !writingNames.includes("upsert_material"), writingNames.join(","));
	check("写作工具集不含 attach_materials", !writingNames.includes("attach_materials"), writingNames.join(","));
	check("写作工具集不含 update_outline", !writingNames.includes("update_outline"), writingNames.join(","));
	check("素材工具集含 upsert_material", materialNames.includes("upsert_material"));
	check("素材工具集含 attach_materials", materialNames.includes("attach_materials"));
	check("写作工具集含 write_chapter", writingNames.includes("write_chapter"));
	check("两套都读得到素材", materialNames.includes("list_materials") && writingNames.includes("list_materials"));
	check("两套都有大纲查询", materialNames.includes("list_chapters") && writingNames.includes("list_chapters"));
	check("工具名不重复", new Set(materialNames).size === materialNames.length, materialNames.join(","));

	// ---- 素材智能体工具链路 ----
	console.log("\n素材智能体工具");
	const tools = createMaterialTools({ store, projectId: project.id });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	const call = async (name: string, params: unknown = {}) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`未找到工具 ${name}`);
		return tool.execute("smoke-call", params as never, undefined, undefined);
	};
	const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
		res.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");

	// update_outline
	const outline = await call("update_outline", {
		chapters: [
			{ id: "ch01", title: "第一章 雨夜", summary: "主角发现一件异常的事。", targetWords: 3000, status: "planned" },
			{ id: "ch02", title: "第二章 追查", summary: "调查相关记录，发现相关人。", targetWords: 3500, status: "planned" },
		],
	});
	check("update_outline 写入大纲", textOf(outline).includes("共 2 章"), textOf(outline));
	check("大纲已落盘", store.get(project.id)!.outline.length === 2);

	// upsert_material
	const person = await call("upsert_material", {
		kind: "character",
		title: "林晓",
		content: "痕迹鉴定员，习惯用左手记笔记。",
		usage: "雨夜追踪戏，交代她的职业与观察习惯",
		tags: ["主角"],
	});
	check("upsert_material 新建素材", textOf(person).includes("已新建素材"), textOf(person));
	const materialId = (person.details as { id: string }).id;
	check("素材落盘", store.get(project.id)!.materials.length === 1);
	check("usage 已保存", store.get(project.id)!.materials[0]!.usage.includes("雨夜追踪戏"));
	check("source 记为 agent", store.get(project.id)!.materials[0]!.source === "agent");

	const world = await call("upsert_material", {
		kind: "world",
		title: "湾区的雨",
		content: "游离区常年大雨，三月不断。",
		usage: "任何需要交代气候与地面的场景",
	});
	const worldId = (world.details as { id: string }).id;
	check("两条素材", store.get(project.id)!.materials.length === 2);

	// 更新素材不应丢失未传字段
	await call("upsert_material", { id: materialId, kind: "character", title: "林晓", content: "痕迹鉴定员，习惯用左手记笔记。", usage: "雨夜追踪戏，交代她的职业与观察习惯", tags: ["主角", "改过"] });
	const updated = store.get(project.id)!.materials.find((m) => m.id === materialId)!;
	check("更新素材保留标签", updated.tags.includes("主角"), updated.tags.join(","));

	// schema 层：这四项不能进 required。
	// 一旦进去，「只传 content」会被 pi-ai 的参数校验拦下，报出来的还是
	// 看不懂的 required 异常（- kind: must have required properties ...），模型只能干瞪眼。
	const upsertSchema = byName.get("upsert_material")!.parameters as {
		required?: string[];
		properties?: Record<string, unknown>;
	};
	const requiredFields = upsertSchema.required ?? [];
	const four = ["kind", "title", "content", "usage"];
	check(
		"upsert_material 四项都不在 required",
		!four.some((key) => requiredFields.includes(key)),
		"required=" + JSON.stringify(requiredFields),
	);
	check(
		"upsert_material 仍声明四项属性",
		four.every((key) => key in (upsertSchema.properties ?? {})),
		Object.keys(upsertSchema.properties ?? {}).join(","),
	);

	// 行为层：部分更新。设定官照「选中修改」的指令就是这么调的 —— 只给要改的字段。
	const partial = await call("upsert_material", { id: materialId, content: "痕迹鉴定员，惯用左手记笔记；左耳有旧伤。" });
	check("只传 content 也能更新", textOf(partial).includes("已更新素材"), textOf(partial));
	const partialSaved = store.get(project.id)!.materials.find((m) => m.id === materialId)!;
	check("部分更新写入新内容", partialSaved.content.includes("左耳有旧伤"), partialSaved.content);
	check("部分更新保留 kind", partialSaved.kind === "character", partialSaved.kind);
	check("部分更新保留标题", partialSaved.title === "林晓", partialSaved.title);
	check("部分更新保留 usage", partialSaved.usage.includes("雨夜追踪戏"), partialSaved.usage);

	// 新建时缺字段不抛异常，而是回一句能照做的提示，让模型当轮自己改对。
	const incomplete = await call("upsert_material", { content: "只有内容，没有种类标题用途。" });
	check("新建缺字段给出可读提示", textOf(incomplete).includes("新建素材还缺"), textOf(incomplete));
	check(
		"缺字段时不落盘",
		store.get(project.id)!.materials.length === 2,
		String(store.get(project.id)!.materials.length),
	);

	// attach_materials
	await call("attach_materials", { chapterId: "ch01", materialIds: [materialId, worldId], mode: "add" });
	const ch01 = store.get(project.id)!.outline.find((c) => c.id === "ch01")!;
	check("装料后章节有 2 条", ch01.materialIds.length === 2, String(ch01.materialIds.length));
	check("关联是双向的", store.get(project.id)!.materials.find((m) => m.id === materialId)!.chapterIds.includes("ch01"));
	await call("attach_materials", { chapterId: "ch01", materialIds: [worldId], mode: "remove" });
	check("移除装料生效", store.get(project.id)!.outline.find((c) => c.id === "ch01")!.materialIds.length === 1);
	check("反向关联同步移除", store.get(project.id)!.materials.find((m) => m.id === worldId)!.chapterIds.length === 0);
	await call("attach_materials", { chapterId: "ch01", materialIds: [worldId], mode: "add" });

	// list_materials
	const listed = await call("list_materials", {});
	check("list_materials 列出素材", textOf(listed).includes("林晓") && textOf(listed).includes("湾区的雨"));
	const byKind = await call("list_materials", { kind: "world" });
	check("按 kind 筛选生效", textOf(byKind).includes("湾区的雨") && !textOf(byKind).includes("林晓"));
	const full = await call("list_materials", { kind: "world", full: true });
	check("full 模式带出全文", textOf(full).includes("游离区常年大雨"), textOf(full));

	// ---- 组装智能体工具链路 ----
	console.log("\n组装智能体工具");
	const writingTools = createWritingTools({ store, projectId: project.id });

	// 只改标题不该把该章的装料抖掉：chapterIds 不传时保持原样。
	await call("update_outline", {
		chapters: [{ id: "ch01", title: "第一章 雨夜（改）", summary: "主角发现一件异常的事。", targetWords: 3000 }],
	});
	check(
		"改标题不动装配清单",
		store.get(project.id)!.outline.find((c) => c.id === "ch01")!.materialIds.length === 2,
		String(store.get(project.id)!.outline.find((c) => c.id === "ch01")!.materialIds.length),
	);
	check("标题确实改了", store.get(project.id)!.outline.find((c) => c.id === "ch01")!.title === "第一章 雨夜（改）");

	// 挂一条不存在的素材不该污染章节的装配清单。
	await call("attach_materials", { chapterId: "ch01", materialIds: ["ghost-id"], mode: "add" });
	check(
		"挂幽灵素材被忽略",
		store.get(project.id)!.outline.find((c) => c.id === "ch01")!.materialIds.length === 2,
		String(store.get(project.id)!.outline.find((c) => c.id === "ch01")!.materialIds.length),
	);

	// 重新指定 chapterIds 等于整体替换：被摘掉的章节也要清掉。
	await call("upsert_material", {
		id: worldId,
		kind: "world",
		title: "湾区的雨",
		content: "游离区常年大雨，三月不断。",
		usage: "任何需要交代气候与地面的场景",
		chapterIds: [],
	});
	check(
		"重新指定 chapterIds 会摘掉旧章节",
		store.get(project.id)!.outline.find((c) => c.id === "ch01")!.materialIds.length === 1,
		String(store.get(project.id)!.outline.find((c) => c.id === "ch01")!.materialIds.length),
	);
	await call("attach_materials", { chapterId: "ch01", materialIds: [worldId], mode: "add" });

	// update_outline 反向同步素材的 chapterIds。
	await call("update_outline", {
		chapters: [{ id: "ch02", title: "第二章 追查", summary: "调查相关记录，发现相关人。", targetWords: 3500, status: "outlined", chapterIds: [worldId] }],
	});
	check(
		"update_outline 反向同步素材",
		store.get(project.id)!.materials.find((m) => m.id === worldId)!.chapterIds.includes("ch02"),
		store.get(project.id)!.materials.find((m) => m.id === worldId)!.chapterIds.join(","),
	);
	const writingByName = new Map(writingTools.map((tool) => [tool.name, tool]));
	const callWriting = async (name: string, params: unknown = {}) => {
		const tool = writingByName.get(name);
		if (!tool) throw new Error(`未找到工具 ${name}`);
		return tool.execute("smoke-call", params as never, undefined, undefined);
	};

	const draftText = "雨从午后一直下到天黑。林晓把异常的比子放进口袋，他知道自己不应该拿走。";
	const written = await callWriting("write_chapter", {
		chapterId: "ch01",
		title: "雨夜",
		content: draftText,
		mode: "create",
		materialIds: [materialId, worldId],
	});
	check("write_chapter 写入正文", textOf(written).includes("第 1 版"), textOf(written));
	const stored = store.get(project.id)!;
	check("正文内容一致", stored.drafts.ch01?.content === draftText);
	check("版本号为 1", stored.drafts.ch01?.revision === 1);
	check("记录用到的素材", stored.drafts.ch01?.materialIds.length === 2);
	check("中文字数统计", countWords(draftText) > 0, String(countWords(draftText)));

	await callWriting("write_chapter", { chapterId: "ch01", title: "雨夜", content: draftText + "更多。", mode: "rewrite" });
	check("重写后版本号为 2", store.get(project.id)!.drafts.ch01?.revision === 2);
	// 首次写入时若未显式传素材，应继承本章的装配清单 —— 否则正文与素材的
	// 回溯链会在第一次落笔时就断掉。
	await call("attach_materials", { chapterId: "ch02", materialIds: [worldId], mode: "add" });
	await callWriting("write_chapter", { chapterId: "ch02", title: "追查", content: "第二天，雨还没停。", mode: "create" });
	check("新章正文继承本章装料", store.get(project.id)!.drafts.ch02?.materialIds.length === 1, String(store.get(project.id)!.drafts.ch02?.materialIds.length));
	// outlined 的章节写出正文后也应变成 drafted，否则界面一直显示"未成稿"。
	check(
		"outlined 写出正文后转为 drafted",
		store.get(project.id)!.outline.find((c) => c.id === "ch02")!.status === "drafted",
		String(store.get(project.id)!.outline.find((c) => c.id === "ch02")!.status),
	);
	check("重写后大纲状态自动更新", store.get(project.id)!.outline[0]?.status === "drafted");
	check("重写未传素材时沿用上一版的记录", store.get(project.id)!.drafts.ch01?.materialIds.length === 2);

	const read = await callWriting("read_chapter", { chapterId: "ch01" });
	check("read_chapter 返回正文", textOf(read).includes("更多。"));

	const chapters = await callWriting("list_chapters");
	check("list_chapters 显示装料数", textOf(chapters).includes("装料2条"), textOf(chapters));

	// ---- 待办 ----
	console.log("\n待办");
	const note = await call("add_note", { severity: "warning", category: "时间线", subject: "ch01", description: "雨天与开篇描写的月份不一致。" });
	const noteId = (note.details as { id: string }).id;
	check("add_note 返回 id", typeof noteId === "string");
	const notes = await callWriting("list_notes");
	check("list_notes 列出待办", textOf(notes).includes("月份不一致"));
	await callWriting("resolve_note", { id: noteId });
	check("resolve_note 标记已处理", store.get(project.id)!.notes[0]!.status === "resolved");

	// ---- 概览 ----
	const brief = await call("get_project_brief");
	check("get_project_brief 返回标题", textOf(brief).includes("测试作品"));
	check("get_project_brief 返回统计", textOf(brief).includes("当前进度"));

	// ---- 章节并发锁 ----
	console.log("\n章节写锁");
	const before = store.get(project.id)!.drafts.ch01!.revision;
	await Promise.all([
		store.withChapterLock(project.id, "ch01", async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			store.mutate(project.id, (draft) => {
				draft.drafts.ch01!.revision += 1;
			});
		}),
		store.withChapterLock(project.id, "ch01", () => {
			store.mutate(project.id, (draft) => {
				draft.drafts.ch01!.revision += 1;
			});
		}),
	]);
	check("并发写入都生效", store.get(project.id)!.drafts.ch01!.revision === before + 2, String(store.get(project.id)!.drafts.ch01!.revision));

	// ---- 工作台辅助（人装的料与墨客装的料走同一套索引） ----
	console.log("\n工作台辅助");
	const board = emptyProject({ title: "工作台" });
	board.materials.push(
		{ id: "m1", kind: "character", title: "林晓", content: "内容", tags: [], usage: "用", status: "draft", chapterIds: [], source: "human", createdAt: 0, updatedAt: 0 },
		{ id: "m2", kind: "world", title: "湾区的雨", content: "内容", tags: [], usage: "用", status: "draft", chapterIds: [], source: "human", createdAt: 0, updatedAt: 0 },
	);
	board.outline.push(
		{ id: "c1", title: "第一章", summary: "", pov: "", status: "planned", targetWords: 0, notes: "", materialIds: [] },
		{ id: "c2", title: "第二章", summary: "", pov: "", status: "planned", targetWords: 0, notes: "", materialIds: [] },
	);

	const added = linkMaterials(board, "c1", ["m1", "ghost"], "add");
	check("装料回报 applied 与 skipped", added.applied.join() === "m1" && added.skipped.join() === "ghost");
	check("章节装上料", board.outline[0]!.materialIds.join() === "m1");
	check("素材反向记下章节", board.materials[0]!.chapterIds.join() === "c1");
	check("幽灵 id 不进装配清单", !board.outline[0]!.materialIds.includes("ghost"));

	linkMaterials(board, "c1", ["m1"], "remove");
	check("摘料双向同步", board.outline[0]!.materialIds.length === 0 && board.materials[0]!.chapterIds.length === 0);
	check("重复装料不产生重复项", (() => {
		linkMaterials(board, "c1", ["m1", "m1"], "add");
		return board.outline[0]!.materialIds.length === 1;
	})());
	check("找不到章节时全部算跳过", linkMaterials(board, "nope", ["m1"], "add").skipped.join() === "m1");

	linkMaterials(board, "c2", ["m1"], "add");
	check("assembledMaterials 解析出素材", assembledMaterials(board, "c2").map((m) => m.id).join() === "m1");
	board.outline[1]!.materialIds.push("gone");
	check("assembledMaterials 跳过悬空 id", assembledMaterials(board, "c2").length === 1);
	check("assembledMaterials 对未知章节返回空", assembledMaterials(board, "nope").length === 0);

	removeMaterial(board, "m1");
	check("删素材后库里没有", board.materials.length === 1);
	check("删素材后各章装配清单同步清掉", board.outline.every((c) => !c.materialIds.includes("m1")));
	check("删不存在的素材返回 undefined", removeMaterial(board, "nope") === undefined);

	// ---- 上传解析 ----
	console.log("\n上传解析");
	const plain = extractText("设定.md", Buffer.from("# 标题\n\n正文。", "utf8"));
	check("文本按 UTF-8 解码", plain.text.includes("正文。"), plain.text);
	check("标题取自文件名", plain.title === "设定" && plain.format === "text");
	check("BOM 被剥掉", extractText("a.txt", Buffer.from("\uFEFF内容", "utf8")).text === "内容");
	check("多余空行被折叠", extractText("a.txt", Buffer.from("甲\n\n\n\n乙", "utf8")).text === "甲\n\n乙");

	const fromHtml = extractText("notes.html", Buffer.from("<html><body><p>第一段</p><p>第二段</p></body></html>", "utf8"));
	check("html 剥标签并分段", fromHtml.text === "第一段\n第二段", fromHtml.text);
	check("script 内容不进正文", !extractText("a.html", Buffer.from("<p>x</p><script>var a=1;</script>", "utf8")).text.includes("var a"));

	const docxXml =
		'<?xml version="1.0"?><w:document xmlns:w="http://x"><w:body>' +
		"<w:p><w:r><w:t>裴渡，二十九岁</w:t></w:r></w:p>" +
		"<w:p><w:r><w:t>核载二十人</w:t></w:r><w:br/><w:r><w:t>第二行</w:t></w:r></w:p>" +
		"</w:body></w:document>";
	const fromDocx = extractText("人物表.docx", makeZip("word/document.xml", docxXml, true));
	check("docx 解出文字", fromDocx.text.includes("裴渡，二十九岁"), fromDocx.text);
	check("docx 段落各自成行", fromDocx.text.split("\n").length === 3, JSON.stringify(fromDocx.text));
	check("docx 行内 br 换成换行", fromDocx.text.includes("核载二十人\n第二行"));
	check("docx 格式与标题", fromDocx.format === "docx" && fromDocx.title === "人物表");
	check("docx 实体已解码", extractText("e.docx", makeZip("word/document.xml", "<w:p><w:t>甲&amp;乙</w:t></w:p>", false)).text === "甲&乙");
	check("未压缩条目也能读", extractText("s.docx", makeZip("word/document.xml", "<w:p><w:t>甲</w:t></w:p>", false)).text === "甲");

	const rejected = (() => {
		try {
			extractText("a.pdf", Buffer.from("%PDF-1.4", "utf8"));
			return "";
		} catch (error) {
			return (error as Error).message;
		}
	})();
	check("pdf 明确拒绝并给出去路", rejected.includes(".pdf") && rejected.includes(".docx"), rejected);
	const brokenZip = (() => {
		try {
			extractText("a.docx", Buffer.from("not a zip", "utf8"));
			return "";
		} catch (error) {
			return (error as Error).message;
		}
	})();
	check("坏 docx 报错而不是静默返回空", brokenZip.includes("zip"), brokenZip);

	const long = extractText("long.txt", Buffer.from("字".repeat(MAX_TEXT_CHARS + 10), "utf8"));
	check("超长文本被截断并如实回报", long.truncated && long.text.length === MAX_TEXT_CHARS && long.originalChars === MAX_TEXT_CHARS + 10);

	// ---- 通用素材库（跨作品的一层） ----
	console.log("\n通用素材库");
	const library = await MaterialLibrary.open(dir);
	check("初始是空库", library.list().length === 0);

	const entry = library.create({
		kind: "character",
		title: "裴渡",
		content: "水上巡防的老手。",
		usage: "他在场的戏",
		tags: ["主角"],
	});
	check("新建库条目", library.list().length === 1 && Boolean(entry.id));
	check("新条目算已确认", entry.status === "confirmed");
	check("时间戳已填", entry.createdAt > 0 && entry.updatedAt >= entry.createdAt);

	const updatedEntry = library.update(entry.id, { title: "裴渡（改）" });
	check("改库条目", updatedEntry?.title === "裴渡（改）");
	check("未传字段保持原样", updatedEntry?.content.includes("水上巡防") === true && updatedEntry?.tags.join() === "主角");
	check("改不存在的条目返回 undefined", library.update("ghost", { title: "x" }) === undefined);

	const taken = materialFromLibrary(entry);
	check("取用得到新 id", taken.id !== entry.id);
	check("取用记下来源", taken.originId === entry.id);
	check("取用的来源标为 library", taken.source === "library");
	check("取用清空装配清单", taken.chapterIds.length === 0);
	check("取用带上内容与 usage", taken.content === entry.content && taken.usage === entry.usage);
	check("取用不共享标签数组", taken.tags !== entry.tags);

	const back = libraryFieldsOf(taken);
	check("回推字段不含 id 与时间戳", !("id" in back) && !("createdAt" in back) && !("updatedAt" in back));
	check("回推保留内容与标题", back.content === taken.content && back.title === taken.title);

	check("删除库条目", library.remove(entry.id) && library.list().length === 0);
	check("重复删除返回 false", library.remove(entry.id) === false);

	// 落盘：库文件必须能被重新读回，且不能被 ProjectStore 当成一部作品。
	library.create({ kind: "world", title: "黑水汊", content: "野渡的规矩。", usage: "渡口戏" });
	await new Promise((resolve) => setTimeout(resolve, 80));
	const reopened = await MaterialLibrary.open(dir);
	check("库能落盘并重新读回", reopened.list().length === 1 && reopened.list()[0]!.title === "黑水汊");

	const reread = await ProjectStore.open(dir);
	check("library.json 不被当成作品", reread.list().every((item) => item.id !== "library"));
	check("作品数不受库文件影响", reread.list().length === 1, String(reread.list().length));

	await writeFile(path.join(dir, "library.json"), "{ 不是合法 JSON", "utf8");
	const broken = await MaterialLibrary.open(dir);
	check("库文件损坏时按空库处理", broken.list().length === 0);

	// ---- 提示词 ----
	console.log("\n提示词");
	const final = store.get(project.id)!;
	const materialPrompt = buildMaterialSystemPrompt(final);
	check("素材提示词禁止写正文", materialPrompt.includes("不写正文"));
	check("素材提示词强调 usage", materialPrompt.includes("usage"));
	check("素材提示词不含写作工具声明", !materialPrompt.includes("mode 选 continue"));

	const chapter = final.outline.find((c) => c.id === "ch01")!;
	const assembled = chapter.materialIds
		.map((id) => final.materials.find((m) => m.id === id))
		.filter((m): m is Material => m !== undefined);
	const writingPrompt = buildWritingSystemPrompt(final, { chapter, materials: assembled, mode: "create" });
	check("写作提示词带出素材全文", writingPrompt.includes("游离区常年大雨"), "");
	check("写作提示词只写这一章", writingPrompt.includes("不越章"));
	check("写作提示词声明唯一事实来源", writingPrompt.includes("唯一"));
	const sessionPrompt = buildWritingSystemPrompt(final, { chapter, materials: assembled, mode: "create", interactive: true });
	check("工作台提示词不预设整章重写", sessionPrompt.includes("等作者交代"));
	check("工作台提示词声明整章落地", sessionPrompt.includes("整章落地"));
	check("工作台提示词不出现一次写完", !sessionPrompt.includes("**一次写完**"));
	const oneShotPrompt = buildWritingSystemPrompt(final, { chapter, materials: assembled, mode: "rewrite" });
	check("一次性成文仍要求整章重写", oneShotPrompt.includes("整章重写"));
	check("一次性成文仍要求一次写完", oneShotPrompt.includes("**一次写完**"));
	check("一次性成文不含工作台规矩", !oneShotPrompt.includes("工作台上的规矩"));

	const materialDigest = buildContextDigest(final, { scope: "material" });
	check("素材快照含索引与 usage", materialDigest.includes("林晓") && materialDigest.includes("雨夜追踪戏"));
	check("素材快照不含素材全文", !materialDigest.includes("游离区常年大雨"));
	const writingDigest = buildContextDigest(final, { scope: "writing", chapterId: "ch01" });
	check("写作快照含本章素材全文", writingDigest.includes("游离区常年大雨"));
	check("写作快照不含全库索引", !writingDigest.includes("素材库索引"));

	// ---- 厂商注册 ----
	console.log("\n模型接入层");
	const settingsStore = await SettingsStore.open(dir);
	const credentialStore = await FileCredentialStore.open(dir);
	settingsStore.replace(ensureDefaultSettings(settingsStore.get(), ""));
	initModelRuntime(settingsStore, credentialStore);
	const models = getModels();
	check("注册 provider 数量 > 0", models.getProviders().length > 0, String(models.getProviders().length));
	check("BUILTIN_PROVIDERS 已声明", BUILTIN_PROVIDERS.length === 41, String(BUILTIN_PROVIDERS.length));
	check("首次启动预置了内置供应商", settingsStore.get().providers.length === 41, String(settingsStore.get().providers.length));
	check("全部预置为 builtin", settingsStore.get().providers.every((p) => p.kind === "builtin"));
	check("能列出模型目录", models.getModels().length > 0, String(models.getModels().length));
} finally {
	// 存储层的落盘是异步的，给重试留点缓冲。
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
