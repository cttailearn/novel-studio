/**
 * 冒烟测试：不需要任何 API Key，验证工程存储与智能体工具链路。
 * 运行：pnpm smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore, countWords } from "../src/store/project.ts";
import { createNovelTools } from "../src/ai/tools.ts";
import { buildContextDigest, buildSystemPrompt } from "../src/ai/prompts.ts";
import { BUILTIN_PROVIDERS, getModels, initModelRuntime } from "../src/ai/models.ts";
import { FileCredentialStore } from "../src/config/credential-store.ts";
import { SettingsStore } from "../src/config/settings-store.ts";
import { ensureDefaultSettings } from "../src/ai/models.ts";

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

	// ---- 工具链路 ----
	console.log("\n智能体工具");
	const tools = createNovelTools({ store, projectId: project.id });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	check("工具数量为 12", tools.length === 12, `实际 ${tools.length}`);

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

	// write_chapter
	const draftText = "雨从午后一直下到天黑。林晓把异常的比子放进口袋，他知道自己不应该拿走。";
	await call("write_chapter", { chapterId: "ch01", title: "雨夜", content: draftText, mode: "create" });
	const stored = store.get(project.id)!;
	check("write_chapter 写入正文", stored.drafts.ch01?.content === draftText);
	check("版本号为 1", stored.drafts.ch01?.revision === 1);
	check("中文字数统计", countWords(draftText) > 0, String(countWords(draftText)));

	await call("write_chapter", { chapterId: "ch01", title: "雨夜", content: draftText + "更多。", mode: "rewrite" });
	check("重写后版本号为 2", store.get(project.id)!.drafts.ch01?.revision === 2);
	check("重写后大纲状态自动更新", store.get(project.id)!.outline[0]?.status === "drafted");

	// read_chapter
	const read = await call("read_chapter", { chapterId: "ch01" });
	check("read_chapter 返回正文", textOf(read).includes("更多。"));

	// list_chapters
	const list = await call("list_chapters");
	check("list_chapters 显示两章", textOf(list).includes("ch01") && textOf(list).includes("ch02"));

	// 人物
	await call("upsert_character", { name: "林晓", role: "主角", personality: "孤僻但坚定" });
	const chars = await call("list_characters");
	check("upsert + list_characters", textOf(chars).includes("林晓"));
	const charId = store.get(project.id)!.characters[0]!.id;
	await call("upsert_character", { id: charId, appearance: "黑眼睛" });
	check("更新人物不覆盖其他字段", store.get(project.id)!.characters[0]!.appearance === "黑眼睛");
	check("更新人物保留原字段", store.get(project.id)!.characters[0]!.personality === "孤僻但坚定");

	// 世界观
	await call("set_world_fact", { category: "地理", title: "湾区", content: "游离区常年大雨，三月不断。" });
	const facts = await call("list_world_facts", { category: "地理" });
	check("set_world_fact + list_world_facts", textOf(facts).includes("湾区"));
	check("类别筛选生效", textOf(facts).includes("三月不断"));

	// 待办
	const note = await call("add_note", { severity: "warning", category: "时间线", subject: "ch01", description: "雨天与开篇描写的月份不一致。" });
	check("add_note 返回 id", typeof note.details === "object" && note.details !== null);
	const noteId = (note.details as { id: string }).id;
	const notes = await call("list_notes");
	check("list_notes 列出待办", textOf(notes).includes("月份不一致"));
	await call("resolve_note", { id: noteId });
	check("resolve_note 标记已处理", store.get(project.id)!.notes[0]!.status === "resolved");

	// 基本信息
	const brief = await call("get_project_brief");
	check("get_project_brief 返回标题", textOf(brief).includes("测试作品"));
	check("get_project_brief 返回统计", textOf(brief).includes("当前进度"));

	// ---- 提示词 ----
	console.log("\n提示词");
	const final = store.get(project.id)!;
	const prompt = buildSystemPrompt(final);
	check("系统提示词含工作流", prompt.includes("工作流"));
	check("系统提示词含文风规则", prompt.includes("文风"));
	check("系统提示词含工具纪律", prompt.includes("write_chapter"));
	check("文风指南被嵌入", prompt.includes("测试作品"));

	const digest = buildContextDigest(final);
	check("快照包含大纲", digest.includes("ch01"));
	check("快照包含人物", digest.includes("林晓"));
	check("快照包含世界观", digest.includes("湾区"));

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
	const totalModels = models.getModels();
	check("能列出模型目录", totalModels.length > 0, String(totalModels.length));
} finally {
	// 存储层的落盘是异步的，给重试留点缓冲。
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
