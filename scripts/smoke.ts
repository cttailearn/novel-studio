/**
 * 冒烟测试：不需要任何 API Key，验证工程存储、素材工具链路与两套智能体的工具边界。
 * 运行：pnpm test:tools
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ProjectStore,
	assembledMaterials,
	countWords,
	emptyProject,
	encodeFileName,
	linkMaterials,
	removeMaterial,
	type ChapterDraft,
	type Material,
} from "../src/store/project.ts";
import { libraryFieldsOf, materialFromLibrary, MaterialLibrary } from "../src/store/library.ts";
import { createLibraryTools, createMaterialTools, createWritingTools } from "../src/ai/tools.ts";
import { buildContextDigest, buildLibrarySystemPrompt, buildMaterialSystemPrompt, buildWritingSystemPrompt } from "../src/ai/prompts.ts";
import { BUILTIN_PROVIDERS, getModels, initModelRuntime } from "../src/ai/models.ts";
import { FileCredentialStore } from "../src/config/credential-store.ts";
import { SettingsStore } from "../src/config/settings-store.ts";
import { ensureDefaultSettings } from "../src/ai/models.ts";
import { extractText, MAX_INFLATED_BYTES, MAX_TEXT_CHARS, UnsupportedUploadError, UploadTooLargeError } from "../src/server/upload.ts";
import { deflateRawSync } from "node:zlib";

/**
 * 造一个最小的 zip。docx 就是 zip，这里自己拼一份，
 * 好让解包路径在没有外部文件的情况下也被测到。
 * crc32 一律填 0 —— 读取方不校验它。
 * declaredSize 可伪造中央目录里声明的解压体积，用来测 zip 炸弹的提前拒绝。
 */
function makeZip(name: string, content: string, deflate: boolean, declaredSize?: number): Buffer {
	const raw = Buffer.from(content, "utf8");
	const data = deflate ? deflateRawSync(raw) : raw;
	const method = deflate ? 8 : 0;
	const nameBuf = Buffer.from(name, "utf8");
	const uncompressed = declaredSize ?? raw.length;

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(method, 8);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(uncompressed, 22);
	local.writeUInt16LE(nameBuf.length, 26);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(method, 10);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(uncompressed, 24);
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

/** 轮询等待异步落盘完成；超时返回 false，由调用方记成失败而不是直接抛。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	return false;
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

	// ---- 通用素材库作用域 ----
	console.log("\n通用素材库作用域");
	// 单独开一个库实例：这一节要真写盘，不该借用后面那节的库。
	const libScope = await MaterialLibrary.open(path.join(dir, "libscope"));
	const libraryTools = createLibraryTools({ library: libScope });
	const libraryNames = libraryTools.map((t) => t.name);
	// 库里没有章节、没有大纲、没有备注：给出那些工具只会让模型反复撞空。
	check("库工具集只含素材读写", libraryNames.length === 2 && libraryNames.includes("list_materials") && libraryNames.includes("upsert_material"), libraryNames.join(","));
	check("库工具集不含章节工具", !libraryNames.includes("update_outline") && !libraryNames.includes("list_chapters") && !libraryNames.includes("attach_materials"), libraryNames.join(","));
	check("库工具集不含写正文", !libraryNames.includes("write_chapter"), libraryNames.join(","));

	// 写一条通用素材，确认真的落到 library.json 而不是某部作品里。
	const libUpsert = libraryTools.find((t) => t.name === "upsert_material")!;
	await libUpsert.execute("call-lib-1", {
		kind: "world",
		title: "赛博都市的雨夜",
		content: "酸雨。霓虹在积水里碎成片。",
		usage: "赛博朋克作品的雨夜开场",
	});
	check("库工具写进了库", libScope.list().some((m) => m.title === "赛博都市的雨夜"));
	check("库工具没污染作品", !store.get(project.id)!.materials.some((m) => m.title === "赛博都市的雨夜"));

	// 新建缺字段时要给出可读的点名，而不是抛校验异常。
	const missing = await libUpsert.execute("call-lib-2", { kind: "world", title: "缺内容的条目" });
	check("库新建缺字段会点名", JSON.stringify(missing).includes("content") && JSON.stringify(missing).includes("usage"), JSON.stringify(missing).slice(0, 120));
	check("缺字段不落库", !libScope.list().some((m) => m.title === "缺内容的条目"));

	// 带上 id 就是更新，且只改传了的字段。
	const target = libScope.list().find((m) => m.title === "赛博都市的雨夜")!;
	await libUpsert.execute("call-lib-3", { id: target.id, content: "酸雨。霓虹碎在积水里。街灯是钠黄。" });
	const libUpdated = libScope.get(target.id)!;
	check("库更新只改传了的字段", libUpdated.content.includes("钠黄") && libUpdated.title === "赛博都市的雨夜" && libUpdated.usage === "赛博朋克作品的雨夜开场", libUpdated.content);

	// 提示词：库作用域必须是独立的一份，不能提到"本章"这类只对作品成立的说法。
	const libPrompt = buildLibrarySystemPrompt(libScope.list());
	check("库提示词声明不写正文", libPrompt.includes("不要写正文"));
	check("库提示词强调脱离具体作品", libPrompt.includes("脱离任何一部具体作品也能读懂"));
	check("库提示词声明题材不设边界", libPrompt.includes("题材不设边界"));
	check("库提示词不含作品内说法", !libPrompt.includes("本章已装配的素材"), libPrompt.slice(0, 80));
	await new Promise((resolve) => setTimeout(resolve, 60));
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
	// 覆盖写必须留退路：旧稿进 history，否则 rewrite 写坏就是整章不可恢复地丢失。
	const afterRewrite = store.get(project.id)!.drafts.ch01!;
	check("重写后旧稿进入历史", afterRewrite.history.length === 1 && afterRewrite.history[0]!.content === draftText, JSON.stringify(afterRewrite.history.length));
	check("历史记录了作业类型", afterRewrite.history[0]!.mode === "rewrite", afterRewrite.history[0]!.mode);
	// 首次写入时若未显式传素材，应继承本章的装配清单 —— 否则正文与素材的
	// 回溯链会在第一次落笔时就断掉。
	await call("attach_materials", { chapterId: "ch02", materialIds: [worldId], mode: "add" });
	await callWriting("write_chapter", { chapterId: "ch02", title: "追查", content: "第二天，雨还没停。", mode: "create" });
	// 首次写入没有前序，不该凭空造出一条空历史。
	check("首次写入无历史", store.get(project.id)!.drafts.ch02?.history.length === 0);
	check("新章正文继承本章装料", store.get(project.id)!.drafts.ch02?.materialIds.length === 1, String(store.get(project.id)!.drafts.ch02?.materialIds.length));
	// outlined 的章节写出正文后也应变成 drafted，否则界面一直显示"未成稿"。
	check(
		"outlined 写出正文后转为 drafted",
		store.get(project.id)!.outline.find((c) => c.id === "ch02")!.status === "drafted",
		String(store.get(project.id)!.outline.find((c) => c.id === "ch02")!.status),
	);
	check("重写后大纲状态自动更新", store.get(project.id)!.outline[0]?.status === "drafted");
	check("重写未传素材时沿用上一版的记录", store.get(project.id)!.drafts.ch01?.materialIds.length === 2);

	// 模型偶尔会自由发挥一个章号。写入工具必须以章目为准，
	// 否则会凭空造出一份不在大纲里的正文，界面上查不到、也删不掉。
	let ghostError = "";
	try {
		await callWriting("write_chapter", { chapterId: "ghost-chapter", title: "幽灵", content: "不该落盘的字。", mode: "create" });
	} catch (error) {
		ghostError = (error as Error).message;
	}
	check("write_chapter 拒绝不存在的章节", ghostError.includes("不在本章目里"), ghostError);
	check("没有造出幽灵 draft", store.get(project.id)!.drafts["ghost-chapter"] === undefined);

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
		{ id: "c1", title: "第一章", summary: "", pov: "", volumeId: "", status: "planned", targetWords: 0, notes: "", materialIds: [] },
		{ id: "c2", title: "第二章", summary: "", pov: "", volumeId: "", status: "planned", targetWords: 0, notes: "", materialIds: [] },
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

	// zip 的偏移与解压体积都来自文件本身：坏文件要报可读的错（而不是 500 或 OOM）。
	check("解压上限是 64 MB", MAX_INFLATED_BYTES === 64 * 1024 * 1024, String(MAX_INFLATED_BYTES));
	const bomb = (() => {
		try {
			extractText("bomb.docx", makeZip("word/document.xml", "<w:p><w:t>炸弹</w:t></w:p>", true, MAX_INFLATED_BYTES + 1));
			return undefined;
		} catch (error) {
			return error;
		}
	})();
	check("声明解压体积超限被拒绝", bomb instanceof UploadTooLargeError, String(bomb));
	check("超限错误说明是解压上限", bomb instanceof Error && bomb.message.includes("解压后"), bomb instanceof Error ? bomb.message : "");

	const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
	const evilOffset = makeZip("word/document.xml", "<w:p><w:t>甲</w:t></w:p>", true);
	evilOffset.writeUInt32LE(0x7ffffff0, evilOffset.indexOf(centralSignature) + 42);
	const offsetError = (() => {
		try {
			extractText("evil.docx", evilOffset);
			return undefined;
		} catch (error) {
			return error;
		}
	})();
	check(
		"本地头偏移越界报可读错误",
		offsetError instanceof UnsupportedUploadError && /越界|文件之外/.test(offsetError.message),
		String(offsetError),
	);

	const evilSize = makeZip("word/document.xml", "<w:p><w:t>甲</w:t></w:p>", true);
	evilSize.writeUInt32LE(0x7ffffff0, evilSize.indexOf(centralSignature) + 20);
	const sizeError = (() => {
		try {
			extractText("evil-size.docx", evilSize);
			return undefined;
		} catch (error) {
			return error;
		}
	})();
	check("压缩长度越界报可读错误", sizeError instanceof UnsupportedUploadError && sizeError.message.includes("越界"), String(sizeError));

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

	// 每次覆盖前都留一份上一版：库里可能有作者手写很久的条目，误写就全没了。
	// 这一条守的是"丢了还能捞回来"这件事本身。
	const bak = await readFile(path.join(dir, "library.json.bak"), "utf8").catch(() => undefined);
	check("落盘前留了上一版备份", bak !== undefined, String(bak));
	if (bak !== undefined) {
		const bakParsed = JSON.parse(bak) as { materials: unknown[] };
		// 备份是"上一次写入"的内容：那次写入时库里是空的（条目已删），所以是 0 条。
		check("备份是覆盖前的内容", Array.isArray(bakParsed.materials) && bakParsed.materials.length === 0, String(bakParsed.materials.length));
	}

	// list() 必须给副本：早先直接返回内部数组，调用方一个原地改动就能把库改坏。
	const listedCopy = reopened.list();
	listedCopy.length = 0;
	check("改 list() 的返回值不影响库", reopened.list().length === 1, String(reopened.list().length));

	const reread = await ProjectStore.open(dir);
	check("library.json 不被当成作品", reread.list().every((item) => item.id !== "library"));
	check("作品数不受库文件影响", reread.list().length === 1, String(reread.list().length));

	await writeFile(path.join(dir, "library.json"), "{ 不是合法 JSON", "utf8");
	const broken = await MaterialLibrary.open(dir);
	check("库文件损坏时按空库处理", broken.list().length === 0);

	// 作品文件损坏必须隔离而不是丢弃：那是这本书唯一的副本。
	// 早先这里只 console.warn 后跳过，用户的整部作品就从列表里凭空消失了。
	const corruptName = "corrupt-probe.json";
	await writeFile(path.join(dir, corruptName), "{ 截断的 JSON", "utf8");
	const afterCorrupt = await ProjectStore.open(dir);
	check("损坏的作品文件不计入作品", !afterCorrupt.list().some((p) => p.id === "corrupt-probe"), String(afterCorrupt.list().length));
	const isolated = await readFile(path.join(dir, corruptName + ".corrupt"), "utf8").catch(() => undefined);
	check("损坏的作品文件被改名保留", isolated !== undefined && isolated.includes("截断"), String(isolated));
	await rm(path.join(dir, corruptName + ".corrupt"), { force: true });

	// ---- 正文按章拆文件 ----
	console.log("\n正文分文件与快照");
	// 主文件不应再带正文：早先 drafts 内联在同一个 JSON 里，
	// 一次 upsert 就要重写整本书，写放大随书稿一起膨胀。
	await new Promise((resolve) => setTimeout(resolve, 120));
	const mainRaw = await readFile(path.join(dir, project.id + ".json"), "utf8");
	const mainJson = JSON.parse(mainRaw) as { drafts?: Record<string, unknown> };
	check("主文件不再内联正文", Object.keys(mainJson.drafts ?? {}).length === 0, JSON.stringify(Object.keys(mainJson.drafts ?? {})));
	const draftFiles = await readdir(path.join(dir, "drafts", project.id));
	check("章节正文各自成文件", draftFiles.filter((n) => n.endsWith(".json")).length === 2, String(draftFiles.length));
	const ch01File = draftFiles.find((n) => n.endsWith(".json"))!;
	const draftJson = JSON.parse(await readFile(path.join(dir, "drafts", project.id, ch01File), "utf8")) as ChapterDraft;
	check("章节文件内容完整", draftJson.content.length > 0 && typeof draftJson.history === "object", draftJson.content.slice(0, 20));

	// 重新打开必须能把拆出去的正文读回来，否则等于把稿子丢了。
	const reopenedStore = await ProjectStore.open(dir);
	const restoredProject = reopenedStore.get(project.id)!;
	check("重开后正文仍在", Object.keys(restoredProject.drafts).length === 2, String(Object.keys(restoredProject.drafts).length));
	check("重开后正文内容一致", restoredProject.drafts.ch01?.content === store.get(project.id)!.drafts.ch01?.content);

	// 快照：章节 history 只管本章覆盖，误删素材这类要靠工程级快照退回去。
	const snapName = await reopenedStore.snapshot(restoredProject, "test");
	const snaps = await reopenedStore.listSnapshots(project.id);
	check("快照已生成", snaps.some((s) => s.name === snapName), String(snaps.length));
	const snapProject = await reopenedStore.readSnapshot(project.id, snapName);
	check("快照可读回", snapProject !== undefined && snapProject.materials.length === restoredProject.materials.length);
	// 路径穿越必须挡住。
	check("快照拒绝路径穿越", (await reopenedStore.readSnapshot(project.id, "../../settings.json")) === undefined);
	// 回滚演练：删掉一条素材再从快照恢复。
	reopenedStore.mutate(project.id, (p) => {
		p.materials = [];
	});
	check("回滚前素材已清空", reopenedStore.get(project.id)!.materials.length === 0);
	reopenedStore.mutate(project.id, (draft) => {
		draft.materials = snapProject!.materials;
	});
	check("从快照回滚后素材回来了", reopenedStore.get(project.id)!.materials.length === snapProject!.materials.length);

	// library.json 损坏必须隔离，不能被空库覆盖。
	await writeFile(path.join(dir, "library.json"), "{ 坏掉的库", "utf8");
	const brokenLib = await MaterialLibrary.open(dir);
	check("库损坏后按空库启动", brokenLib.list().length === 0);
	const keptLib = await readFile(path.join(dir, "library.json.corrupt"), "utf8").catch(() => undefined);
	check("损坏的库被改名保留", keptLib?.includes("坏掉") === true, String(keptLib));
	await rm(path.join(dir, "library.json.corrupt"), { force: true });

	// ---- 章稿文件名上限 ----
	console.log("\n章稿文件名");
	// 章节 id 由模型生成，可能是几百字的中文。旧编码把每个非 ASCII 字符转义成
	// "_4e2d_" 这样的 6 个 ASCII 字符，文件名直接越过 255 字节上限，永久 EPERM。
	const nameDir = path.join(dir, "long-chapter-name");
	const nameStore = await ProjectStore.open(nameDir);
	const nameProject = nameStore.create({ title: "超长章号" });
	const longChapterId = "第" + "一".repeat(200) + "章";
	nameStore.mutate(nameProject.id, (draft) => {
		draft.outline.push({
			id: longChapterId,
			title: "超长章号",
			summary: "",
			pov: "",
			volumeId: "",
			status: "planned",
			targetWords: 0,
			notes: "",
			materialIds: [],
		});
		draft.drafts[longChapterId] = {
			id: longChapterId,
			title: "超长章号",
			content: "超长章号也写得下。",
			summary: "",
			revision: 1,
			updatedAt: Date.now(),
			materialIds: [],
			history: [],
		};
	});
	const nameChaptersDir = path.join(nameDir, "drafts", nameProject.id);
	const nameWritten = await waitFor(async () => {
		const names = await readdir(nameChaptersDir).catch(() => [] as string[]);
		return names.some((name) => name.endsWith(".json"));
	});
	const nameFiles = await readdir(nameChaptersDir).catch(() => [] as string[]);
	const longFile = nameFiles.find((name) => name.endsWith(".json")) ?? "";
	check("超长中文章号能落盘", nameWritten, nameFiles.join(","));
	check("文件名不超过 120 字符 + .json", longFile.length > 0 && longFile.length <= 125, String(longFile.length));
	check("落盘后没有待重试章节", nameStore.pendingWrites().length === 0, JSON.stringify(nameStore.pendingChapterWrites()));
	// 文件名截断后仍有短哈希兜底：映射必须稳定，重开能按 id 读回同一份正文。
	const nameReopened = await ProjectStore.open(nameDir);
	check("超长章号重开可读回", nameReopened.get(nameProject.id)?.drafts[longChapterId]?.content === "超长章号也写得下。");

	// ---- 落盘失败按章记录 ----
	console.log("\n落盘失败按章记录");
	const dirtyDir = path.join(dir, "dirty-chapters");
	const dirtyStore = await ProjectStore.open(dirtyDir);
	const dirtyProject = dirtyStore.create({ title: "失败章" });
	const badChapter = "bad-chapter";
	const goodChapter = "good-chapter";
	const draftOf = (id: string, content: string): ChapterDraft => ({
		id,
		title: id,
		content,
		summary: "",
		revision: 1,
		updatedAt: Date.now(),
		materialIds: [],
		history: [],
	});
	dirtyStore.mutate(dirtyProject.id, (draft) => {
		draft.drafts[badChapter] = draftOf(badChapter, "旧稿");
		draft.drafts[goodChapter] = draftOf(goodChapter, "旧稿");
	});
	const dirtyChaptersDir = path.join(dirtyDir, "drafts", dirtyProject.id);
	const badFile = path.join(dirtyChaptersDir, encodeFileName(badChapter) + ".json");
	const initialWritten = await waitFor(async () => {
		const names = await readdir(dirtyChaptersDir).catch(() => [] as string[]);
		return names.filter((name) => name.endsWith(".json")).length === 2;
	});
	check("初始两章都落盘", initialWritten, JSON.stringify(await readdir(dirtyChaptersDir).catch(() => [])));
	// 用同名目录占住坏章的文件路径：写 tmp 能成功，rename 覆盖目录必然失败。
	await rm(badFile, { force: true });
	await mkdir(badFile, { recursive: true });
	dirtyStore.mutate(dirtyProject.id, (draft) => {
		// 与真实存稿一致：换新对象并递增 revision，changedChapters 才认得出这一章动过。
		draft.drafts[badChapter] = { ...draft.drafts[badChapter]!, content: "改不进去的新稿", revision: 2, updatedAt: Date.now() };
	});
	const chapterPending = await waitFor(
		async () => (dirtyStore.pendingChapterWrites()[dirtyProject.id] ?? []).includes(badChapter),
	);
	check("写失败的章进入待重试", chapterPending, JSON.stringify(dirtyStore.pendingChapterWrites()));
	// 再成功写另一章：不能把上面失败的那章一起从待重试里清掉。
	dirtyStore.mutate(dirtyProject.id, (draft) => {
		draft.drafts[goodChapter] = { ...draft.drafts[goodChapter]!, content: "另一章的新稿", revision: 2, updatedAt: Date.now() };
	});
	const goodWritten = await waitFor(async () => {
		const pending = dirtyStore.pendingChapterWrites()[dirtyProject.id] ?? [];
		const raw = await readFile(path.join(dirtyChaptersDir, encodeFileName(goodChapter) + ".json"), "utf8").catch(() => "");
		return raw.includes("另一章的新稿") && pending.includes(badChapter) && !pending.includes(goodChapter);
	});
	check("别的章写成功不会清掉失败章", goodWritten, JSON.stringify(dirtyStore.pendingChapterWrites()));
	check("待重试里仍能列出该作品", dirtyStore.pendingWrites().includes(dirtyProject.id));
	// 让坏章重新可写，手动重试补上。
	await rm(badFile, { recursive: true, force: true });
	await dirtyStore.retryPending();
	const retried = await waitFor(async () => {
		const raw = await readFile(badFile, "utf8").catch(() => "");
		return raw.includes("改不进去的新稿") && dirtyStore.pendingWrites().length === 0;
	});
	check("恢复后重试能把失败章补上", retried, JSON.stringify(dirtyStore.pendingChapterWrites()));
	const dirtyReopened = await ProjectStore.open(dirtyDir);
	check("重试后重开可读回坏章新稿", dirtyReopened.get(dirtyProject.id)?.drafts[badChapter]?.content === "改不进去的新稿");

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
	// rewrite / continue 建立在旧稿之上，模型必须看得见原文 ——
	// 看不见却执行整段覆盖，就是一次静默截断。
	const rewritePrompt = buildWritingSystemPrompt(final, {
		chapter,
		materials: assembled,
		mode: "rewrite",
		existing: final.drafts.ch01,
	});
	check("重写提示词带出现有正文", rewritePrompt.includes(final.drafts.ch01!.content.slice(0, 40)), "");
	check("重写提示词声明可回退", rewritePrompt.includes("历史版本"));
	// 没有旧稿时不该留一节空的「现有正文」。
	check("无旧稿时不带该节", !writingPrompt.includes("# 现有正文"), "");
	check("一次性成文仍要求整章重写", oneShotPrompt.includes("整章重写"));
	check("一次性成文仍要求一次写完", oneShotPrompt.includes("**一次写完**"));
	check("一次性成文不含工作台规矩", !oneShotPrompt.includes("工作台上的规矩"));

	// ---- 长素材分流与检索 ----
	console.log("\n长素材分流与检索");
	const shortMat: Material = {
		...assembled[0]!,
		id: "mat-short",
		title: "短料",
		content: "一句话就说完的设定。",
		chapterIds: [chapter.id],
	};
	// 造一条超阈值的长料：它不该进系统提示词，只该留索引。
	const longBody = Array.from({ length: 120 }, (_, i) => `第${i + 1}行：酸雨落在霓虹招牌上，积水映出碎裂的光。`).join("\n");
	const longMat: Material = {
		...assembled[0]!,
		id: "mat-long",
		title: "长设定集",
		content: longBody,
		usage: "写雨夜街景时取用",
		chapterIds: [chapter.id],
	};
	const mixed = [shortMat, longMat];
	const mixedPrompt = buildWritingSystemPrompt(final, { chapter, materials: mixed, mode: "create" });
	check("短素材给全文", mixedPrompt.includes("一句话就说完的设定"));
	check("长素材不给全文", !mixedPrompt.includes("第120行"), String(longBody.length));
	check("长素材给索引", mixedPrompt.includes("长设定集") && mixedPrompt.includes("search_materials"));
	check("索引里报出字数", mixedPrompt.includes(`全文 ${longBody.length} 字`));
	check("索引里带用途", mixedPrompt.includes("写雨夜街景时取用"));
	check("提示词说明分流规则", mixedPrompt.includes("短素材直接给了全文"));
	check("提示词鼓励多轮检索", mixedPrompt.includes("多搜几轮比猜更准"));

	// 总量预算：条条不超单条阈值，但加起来超预算时也要降级。
	const manyShort = Array.from({ length: 40 }, (_, i) => ({
		...assembled[0]!,
		id: "mat-bulk-" + i,
		title: "批量短料" + i,
		content: "第" + i + "条：" + "填".repeat(1000),
		chapterIds: [chapter.id],
	})) as Material[];
	const bulkPrompt = buildWritingSystemPrompt(final, { chapter, materials: manyShort, mode: "create" });
	const inlined = (bulkPrompt.match(/填{1000}/g) ?? []).length;
	check("总量超预算时降级为索引", inlined < manyShort.length, `${inlined}/${manyShort.length}`);
	check("预算内至少注入了若干条", inlined >= 10, String(inlined));

	// 检索工具：中文二元组要能命中。
	const searchTool = createWritingTools({ store, projectId: project.id }).find((t) => t.name === "search_materials")!;
	check("写作工具集含 search_materials", searchTool !== undefined);
	// 检索搜的是工程里的素材，所以先把这两条放进去。
	store.mutate(project.id, (draft) => {
		draft.materials.push(shortMat, longMat);
	});
	const hit = await searchTool.execute("s1", { query: "霓虹" });
	const hitText = JSON.stringify(hit);
	check("检索命中素材内容", hitText.includes("霓虹招牌"), hitText.slice(0, 120));
	check("检索带出处与行号", hitText.includes("长设定集") && hitText.includes("第"));
	// 二元组：整句里夹个「的」也能命中。
	const loose = await searchTool.execute("s2", { query: "酸雨的霓虹" });
	check("中文二元组能模糊命中", JSON.stringify(loose).includes("霓虹招牌"));
	// 搜不到时要说清怎么办，而不是空手而归。
	const miss = await searchTool.execute("s3", { query: "完全不存在的词xyzzy" });
	check("搜不到时给出换词建议", JSON.stringify(miss).includes("换个说法"));
	// 只搜本章装配的素材：未装配的料不该被拿来写这一章。
	const strayMat: Material = {
		...assembled[0]!,
		id: "mat-stray",
		title: "未装配的料",
		content: "独有标记词：孤舟蓑笠。",
		chapterIds: [],
	};
	store.mutate(project.id, (draft) => {
		draft.materials.push(strayMat);
	});
	const stray = await searchTool.execute("s4", { query: "孤舟蓑笠" });
	check("检索不越出本章装配范围", JSON.stringify(stray).includes("没有匹配"), JSON.stringify(stray).slice(0, 120));
	// 指定 materialId 时可以单独搜某一条。
	const byId = await searchTool.execute("s5", { query: "霓虹", materialId: "mat-long" });
	check("可按 materialId 限定检索", JSON.stringify(byId).includes("霓虹招牌"));
	const badId = await searchTool.execute("s6", { query: "霓虹", materialId: "no-such-id" });
	check("materialId 不存在时明说", JSON.stringify(badId).includes("找不到素材"));
	const capped = await searchTool.execute("s7", { query: "酸雨", limit: 999 });
	// limit 要有上限，免得一次把整库吐出来。

	// 密集命中不能并成一大块：素材若每行都含这个词，全并起来就等于全文注入，
	// 检索也就白做了。每段有上限，且相邻两段不重叠。
	const dense = await searchTool.execute("s8", { query: "酸雨", limit: 20 });
	const denseHits = dense.details as { from: number; to: number }[];
	check("密集命中不并成整篇", denseHits.every((h) => h.to - h.from + 1 <= 8), denseHits.map((h) => h.to - h.from + 1).join(","));
	const byLine = [...denseHits].sort((a, b) => a.from - b.from);
	check(
		"命中段互不重叠",
		byLine.every((h, i) => i === 0 || h.from > byLine[i - 1]!.to),
		byLine.map((h) => `${h.from + 1}-${h.to + 1}`).join(" "),
	);
	check("检索条数有上限", (capped.details as unknown[]).length <= 20, String((capped.details as unknown[]).length));
	// 撤掉这一节塞进去的料，别影响后面的快照断言。
	store.mutate(project.id, (draft) => {
		const drop = new Set(["mat-short", "mat-long", "mat-stray"]);
		draft.materials = draft.materials.filter((m) => !drop.has(m.id));
	});
	const materialDigest = buildContextDigest(final, { scope: "material" });
	check("素材快照含索引与 usage", materialDigest.includes("林晓") && materialDigest.includes("雨夜追踪戏"));
	check("素材快照不含素材全文", !materialDigest.includes("游离区常年大雨"));
	const writingDigest = buildContextDigest(final, { scope: "writing", chapterId: "ch01" });
	// 素材全文由系统提示词带出（见上面 writingPrompt 的断言），快照里不再重复一遍：
	// 同一段文字在一次请求里出现两次，等于白白花掉一半上下文预算。
	check("写作快照不重复注入素材全文", !writingDigest.includes("游离区常年大雨"));
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
