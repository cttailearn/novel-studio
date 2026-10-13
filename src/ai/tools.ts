import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
	countWords,
	type ChapterStatus,
	type ContinuityNote,
	type NoteSeverity,
	type Project,
	type ProjectStore,
} from "../store/project.ts";

/** 工具执行结果：content 是模型看到的文本，details 给前端展示。 */
function result(text: string, details: unknown = undefined): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/** 中文段落输出。 */
function lines(items: string[]): string {
	return items.length > 0 ? items.map((item) => "- " + item).join("\n") : "(无)";
}

const nonEmpty = (description: string) => Type.String({ minLength: 1, description });
const optionalText = (description: string) => Type.Optional(Type.String({ description }));

interface ToolSpec<TParams extends TSchema> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	outputSchema?: TSchema;
	executionMode?: "parallel" | "sequential";
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<any>>;
}

/**
 * 工具定义辅助函数。
 * AgentTool 的默认泛型把 params 定为 unknown，这里从 schema 推导出真实参数类型。
 */
function defineTool<TParams extends TSchema>(spec: ToolSpec<TParams>): AgentTool<any> {
	return spec as unknown as AgentTool<any>;
}

export interface NovelToolDeps {
	store: ProjectStore;
	projectId: string;
}

export function createNovelTools({ store, projectId }: NovelToolDeps): AgentTool<any>[] {
	const project = (): Project => {
		const found = store.get(projectId);
		if (!found) throw new Error("工程已被删除，无法继续操作");
		return found;
	};

	return [
		defineTool({
			name: "get_project_brief",
			label: "读取作品概览",
			description:
				"读取作品的基本信息（标题、类型、一句话概念、简介、文风指南、总字数目标）。" +
				"作为程序创作前应先调用它对齐目标。",
			parameters: Type.Object({}, { description: "无参数" }),
			execute: async () => {
				const p = project();
				return result(
					[
						"标题：" + p.title,
						"类型：" + (p.genre || "未设定"),
						"一句话概念：" + (p.logline || "未设定"),
						"简介：" + (p.synopsis || "未设定"),
						"文风指南：" + (p.styleGuide || "未设定"),
						"总字数目标：" + (p.targetWords || "未设定"),
						"当前进度：" + JSON.stringify(store.stats(p)),
					].join("\n"),
					p,
				);
			},
		}),

		defineTool({
			name: "list_chapters",
			label: "查看章节与作进度",
			description:
				"列出大纲的全部章节、每章状态、已写字数。" +
				"写新章节前应先调用它确认章节号与状态。",
			parameters: Type.Object({}, { description: "无参数" }),
			execute: async () => {
				const p = project();
				if (p.outline.length === 0) return result("大纲还是空的，需要先用 update_outline 建立。", p.outline);
				const body = lines(
					p.outline.map((chapter, index) => {
						const draft = p.drafts[chapter.id];
						const written = draft ? countWords(draft.content) : 0;
						const pct = chapter.targetWords > 0 ? Math.min(100, Math.round((written / chapter.targetWords) * 100)) : 0;
						const rev = draft ? " · 第" + draft.revision + "版" : "";
						return (
							index + 1 + ". [" + chapter.id + "] " + chapter.title +
							"（" + chapter.status + "） 已写" + written + "字" +
							(chapter.targetWords ? "/" + chapter.targetWords : "") +
							(pct ? " 数字" + pct + "%" : "") + rev +
							"—— " + chapter.summary
						);
					}),
				);
				return result(body, { outline: p.outline, drafts: p.drafts });
			},
		}),

		defineTool({
			name: "read_chapter",
			label: "读取章节正文",
			description:
				"读取指定章节的已写正文。" +
				"续写、改稿、批量修改前必须先读原文，不要凭印象猜写。",
			parameters: Type.Object({ chapterId: nonEmpty("章节 id，用 list_chapters 获取") }, { description: "读取章节" }),
			execute: async (_toolCallId, params) => {
				const p = project();
				const draft = p.drafts[params.chapterId];
				if (!draft) return result("章节 " + params.chapterId + " 还没有正文。");
				const meta = p.outline.find((chapter) => chapter.id === params.chapterId);
				const head = meta ? "《" + meta.title + "》大纲要点：" + meta.summary + "\n" : "";
				return result(
					"《" + draft.title + "》（第" + draft.revision + "版，" + countWords(draft.content) + " 字）\n" + head + "\n---\n" + draft.content,
					draft,
				);
			},
		}),

		defineTool({
			name: "write_chapter",
			label: "写入章节正文",
			description:
				"写入章节正文。每一次调用会整段覆盖该章节已有内容并保留一个新版本。" +
				"续写时 mode 选 continue 且传入已有正文；改稿选 rewrite；从零写起选 create。",
			parameters: Type.Object(
				{
					chapterId: nonEmpty("章节 id，新章节用 list_chapters 里的 id，或自拟一个稳定 id"),
					title: nonEmpty("章节标题"),
					content: nonEmpty("章节正文全文，含层次和场景描写"),
					mode: Type.Optional(
						Type.Union([Type.Literal("create"), Type.Literal("rewrite"), Type.Literal("continue")], {
							description: "create 从零写起，rewrite 整章重写，continue 在已有正文后续写。默认 create",
						}),
					),
				},
				{ description: "写入章节" },
			),
			execute: async (_toolCallId, params) => {
				const p = project();
				const mode = params.mode ?? "create";
				const existing = p.drafts[params.chapterId];
				const saved = store.mutate(projectId, (draft) => {
					draft.drafts[params.chapterId] = {
						id: params.chapterId,
						title: params.title,
						content: params.content,
						revision: (existing?.revision ?? 0) + 1,
						updatedAt: Date.now(),
					};
					const meta = draft.outline.find((chapter) => chapter.id === params.chapterId);
					if (meta && meta.status === "planned") meta.status = "drafted";
				});
				const draft = saved.drafts[params.chapterId]!;
				return result(
					"已写入《" + draft.title + "》：第 " + draft.revision + " 版，" + countWords(draft.content) + " 字（" + mode + "）。",
					draft,
				);
			},
		}),

		defineTool({
			name: "update_outline",
			label: "维护大纲",
			description:
				"新建或整体更新大纲。每个章节用 id 标识；已存在的 id 会被更新，新 id 则追加。" +
				"结尾收拖时先使用它确保大纲与已写正文一致。",
			parameters: Type.Object(
				{
					chapters: Type.Array(
						Type.Object(
							{
								id: nonEmpty("章节 id，稳定且唯一，后续手动续写必须用它"),
								title: nonEmpty("标题"),
								summary: nonEmpty("本章要点，2-4 句"),
								pov: optionalText("视角人物"),
								status: Type.Optional(
									Type.Union(
										[
											Type.Literal("planned"),
											Type.Literal("outlined"),
											Type.Literal("drafting"),
											Type.Literal("drafted"),
											Type.Literal("revising"),
											Type.Literal("done"),
										],
										{ description: "状态，默认 planned" },
									),
								),
								targetWords: Type.Optional(Type.Number({ description: "本章目标字数" })),
								notes: optionalText("编写备注"),
							},
							{ description: "章节条目" },
						),
						{ minLength: 1, description: "大纲章节列表" },
					),
				},
				{ description: "更新大纲" },
			),
			execute: async (_toolCallId, params) => {
				const saved = store.mutate(projectId, (p) => {
					for (const chapter of params.chapters) {
						const index = p.outline.findIndex((item) => item.id === chapter.id);
						const next = {
							id: chapter.id,
							title: chapter.title,
							summary: chapter.summary,
							pov: chapter.pov ?? "",
							status: (chapter.status ?? "planned") as ChapterStatus,
							targetWords: chapter.targetWords ?? 0,
							notes: chapter.notes ?? "",
						};
						if (index >= 0) p.outline[index] = { ...p.outline[index]!, ...next };
						else p.outline.push(next);
					}
				});
				return result(
					"大纲已更新，当共 " + saved.outline.length + " 章：\n" +
						lines(saved.outline.map((c) => "[" + c.id + "] " + c.title + "（" + c.status + "）")),
					saved.outline,
				);
			},
		}),

		defineTool({
			name: "list_characters",
			label: "查看人物",
			description:
				"列出人物设定。" +
				"写任何含人物的段落前应先调用它对齐姓名、谴翌与关系。",
			parameters: Type.Object({ name: optionalText("按名字或别名筛选") }, { description: "查看人物" }),
			execute: async (_toolCallId, params) => {
				const p = project();
				const filter = params.name?.trim().toLowerCase();
				const found = filter
					? p.characters.filter(
							(c) => c.name.toLowerCase().includes(filter) || c.aliases.some((alias) => alias.toLowerCase().includes(filter)),
						)
					: p.characters;
				if (found.length === 0) {
					return result(filter ? "没有匹配 「" + params.name + "」 的人物。" : "还没有任何人物设定。");
				}
				return result(
					found
						.map(
							(c) =>
								"《" + c.name + "》" + (c.aliases.length ? "（" + c.aliases.join("、") + "）" : "") +
								" · " + c.role + "\n  外貌：" + c.appearance +
								"\n  性格：" + c.personality +
								"\n  背景：" + c.background +
								"\n  关系：" + (c.relations.join("、") || "—") +
								"\n  人物弧光：" + c.arc,
						)
						.join("\n\n"),
					found,
				);
			},
		}),

		defineTool({
			name: "upsert_character",
			label: "新建 / 更新人物",
			description:
				"新建或更新一个人物设定。" +
				"已存在时只覆盖传入的字段，未传的保持不变。",
			parameters: Type.Object(
				{
					id: optionalText("已存在人物的 id，新建时留空"),
					name: nonEmpty("姓名"),
					aliases: Type.Optional(Type.Array(Type.String(), { description: "别名、称号" })),
					role: optionalText("定位，如主角 / 反派 / 支线"),
					appearance: optionalText("外貌特征"),
					personality: optionalText("性格"),
					background: optionalText("背景经历"),
					relations: Type.Optional(Type.Array(Type.String(), { description: "与其他人物的关系" })),
					arc: optionalText("人物弧光"),
					notes: optionalText("其他备注"),
				},
				{ description: "人物设定" },
			),
			execute: async (_toolCallId, params) => {
				const p = project();
				const id = params.id?.trim() || randomUUID();
				const existing = p.characters.find((c) => c.id === id);
				const saved = store.mutate(projectId, (draft) => {
					const index = draft.characters.findIndex((c) => c.id === id);
					const base = index >= 0
						? draft.characters[index]!
						: { id, name: "", aliases: [], role: "", appearance: "", personality: "", background: "", relations: [], arc: "", notes: "" };
					const next = {
						...base,
						name: params.name ?? base.name,
						aliases: params.aliases ?? base.aliases,
						role: params.role ?? base.role,
						appearance: params.appearance ?? base.appearance,
						personality: params.personality ?? base.personality,
						background: params.background ?? base.background,
						relations: params.relations ?? base.relations,
						arc: params.arc ?? base.arc,
						notes: params.notes ?? base.notes,
					};
					if (index >= 0) draft.characters[index] = next;
					else draft.characters.push(next);
				});
				const character = saved.characters.find((c) => c.id === id);
				return result(
					existing
						? "已更新人物《" + (character?.name ?? "") + "》。"
						: "已新建人物《" + (character?.name ?? "") + "》（id: " + id + "）。",
					character,
				);
			},
		}),

		defineTool({
			name: "list_world_facts",
			label: "查看世界观设定",
			description:
				"列出世界观设定（地理、历史、体系、组织、规矩等）。" +
				"写场景前应先调用它避免设定冲突。",
			parameters: Type.Object({ category: optionalText("按类别筛选") }, { description: "查看世界观" }),
			execute: async (_toolCallId, params) => {
				const p = project();
				const filter = params.category?.trim().toLowerCase();
				const found = filter ? p.worldFacts.filter((f) => f.category.toLowerCase() === filter) : p.worldFacts;
				if (found.length === 0) {
					return result(filter ? "没有类别 「" + params.category + "」 的设定。" : "还没有世界观设定。");
				}
				return result(
					found
						.map((f) => "[" + f.category + "] " + f.title + "：" + f.content + (f.tags.length ? "（标签：" + f.tags.join("、") + "）" : ""))
						.join("\n\n"),
					found,
				);
			},
		}),

		defineTool({
			name: "set_world_fact",
			label: "记录世界观设定",
			description:
				"新建或更新一条世界观设定。" +
				"设定是长期有效的约束，以后章节都要遵守，写出前必须查重。",
			parameters: Type.Object(
				{
					id: optionalText("已存在设定的 id，新建时留空"),
					category: nonEmpty("类别，如 地理 / 历史 / 体系 / 组织 / 规矩 / 语言"),
					title: nonEmpty("标题"),
					content: nonEmpty("设定内容，写清约束与边界"),
					tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
				},
				{ description: "世界观设定" },
			),
			execute: async (_toolCallId, params) => {
				const id = params.id?.trim() || randomUUID();
				const saved = store.mutate(projectId, (p) => {
					const index = p.worldFacts.findIndex((f) => f.id === id);
					const base = index >= 0 ? p.worldFacts[index]! : { id, category: "", title: "", content: "", tags: [] };
					const next = {
						...base,
						category: params.category ?? base.category,
						title: params.title ?? base.title,
						content: params.content ?? base.content,
						tags: params.tags ?? base.tags,
					};
					if (index >= 0) p.worldFacts[index] = next;
					else p.worldFacts.push(next);
				});
				const fact = saved.worldFacts.find((f) => f.id === id);
				return result("已记录世界观设定《" + (fact?.title ?? "") + "》。", fact);
			},
		}),

		defineTool({
			name: "add_note",
			label: "记录待办 / 瞲定条目",
			description:
				"记下一条待处理的事项：尚未展开的伏笔、需要修正的前后不一致、待补的细节。" +
				"发现问题时应主动记录而不是等第二次审稿。",
			parameters: Type.Object(
				{
					severity: Type.Optional(
						Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("blocker")], {
							description: "严重程度，blocker 代表必须修复。默认 info",
						}),
					),
					category: nonEmpty("类别，如 剧情逻辑 / 人设 / 时间线 / 地理 / 文风"),
					subject: nonEmpty("所属章节或对象"),
					description: nonEmpty("具体描述，包含依据"),
				},
				{ description: "记录待办" },
			),
			execute: async (_toolCallId, params) => {
				const note: ContinuityNote = {
					id: randomUUID(),
					severity: (params.severity ?? "info") as NoteSeverity,
					category: params.category,
					subject: params.subject,
					description: params.description,
					status: "open",
					createdAt: Date.now(),
				};
				store.mutate(projectId, (p) => {
					p.notes.push(note);
				});
				return result("已记录待办（" + note.severity + "）：" + note.category + " / " + note.subject, note);
			},
		}),

		defineTool({
			name: "list_notes",
			label: "查看待办列表",
			description: "列出待处理事项。修改章节前先调用它，避免重复劳动。",
			parameters: Type.Object(
				{ status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("resolved")], { description: "默认 open" })) },
				{ description: "待办列表" },
			),
			execute: async (_toolCallId, params) => {
				const p = project();
				const status = params.status ?? "open";
				const found = p.notes.filter((note) => note.status === status);
				if (found.length === 0) return result("没有 " + status + " 的待办。", []);
				return result(
					lines(found.map((n) => "[" + n.severity + "] " + n.category + " / " + n.subject + "：" + n.description)),
					found,
				);
			},
		}),

		defineTool({
			name: "resolve_note",
			label: "关闭待办",
			description: "将一条待办标记为已处理。",
			parameters: Type.Object({ id: nonEmpty("待办 id") }, { description: "关闭待办" }),
			execute: async (_toolCallId, params) => {
				const p = project();
				const note = p.notes.find((n) => n.id === params.id);
				if (!note) return result("找不到待办 " + params.id + "。");
				store.mutate(projectId, (draft) => {
					const target = draft.notes.find((n) => n.id === params.id);
					if (target) target.status = "resolved";
				});
				return result("已关闭待办：" + note.category + " / " + note.subject, note);
			},
		}),
	];
}
