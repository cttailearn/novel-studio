import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
	countWords,
	linkMaterials,
	MATERIAL_KINDS,
	MATERIAL_KIND_LABELS,
	type ContinuityNote,
	type Material,
	type MaterialKind,
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

/** 素材 kind 的枚举 schema，直接由 MATERIAL_KINDS 生成，新增种类不会漏。 */
const materialKindSchema = Type.Union(
	MATERIAL_KINDS.map((kind) => Type.Literal(kind)),
	{ description: "素材种类" },
);

const stringArray = (description: string) => Type.Array(Type.String(), { description });

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

function getProject(deps: NovelToolDeps): Project {
	const found = deps.store.get(deps.projectId);
	if (!found) throw new Error("工程已被删除，无法继续操作");
	return found;
}

/** 素材的一行摘要，用于工具结果与快照。 */
function materialLine(material: Material): string {
	const label = MATERIAL_KIND_LABELS[material.kind];
	const head = "[" + label + "] " + material.title + "（id: " + material.id + "）";
	const bits: string[] = [];
	if (material.usage) bits.push("用于：" + material.usage);
	if (material.tags.length > 0) bits.push("标签：" + material.tags.join("、"));
	if (material.chapterIds.length > 0) bits.push("已装入：" + material.chapterIds.join("、"));
	if (material.status === "confirmed") bits.push("已确认");
	return bits.length > 0 ? head + "\n  " + bits.join("；") : head;
}

function materialBody(material: Material): string {
	return material.content ? "\n  " + material.content.split("\n").join("\n  ") : "";
}

// ═══════════════════════════════════════════════════════════ 两套智能体共用的工具

/** get_project_brief / list_chapters / read_chapter / list_materials / add_note / list_notes / resolve_note */
function sharedTools(deps: NovelToolDeps): AgentTool<any>[] {
	return [
		defineTool({
			name: "get_project_brief",
			label: "读取作品概览",
			description: "读取作品的基本信息（标题、类型、一句话概念、简介、文风指南、总字数目标）与当前进度。开始任何工作前应先调用它对齐目标。",
			parameters: Type.Object({}, { description: "无参数" }),
			execute: async () => {
				const p = getProject(deps);
				return result(
					[
						"标题：" + p.title,
						"类型：" + (p.genre || "未设定"),
						"一句话概念：" + (p.logline || "未设定"),
						"简介：" + (p.synopsis || "未设定"),
						"文风指南：" + (p.styleGuide || "未设定"),
						"总字数目标：" + (p.targetWords || "未设定"),
						"当前进度：" + JSON.stringify(deps.store.stats(p)),
					].join("\n"),
					p,
				);
			},
		}),

		defineTool({
			name: "list_chapters",
			label: "查看章节与作进度",
			description: "列出大纲的全部章节、每章状态、已写字数与已装配的素材数。写新章节前应先调用它确认章节号与状态。",
			parameters: Type.Object({}, { description: "无参数" }),
			execute: async () => {
				const p = getProject(deps);
				if (p.outline.length === 0) return result("大纲还是空的，需要先用 update_outline 建立。", p.outline);
				const body = lines(
					p.outline.map((chapter, index) => {
						const draft = p.drafts[chapter.id];
						const written = draft ? countWords(draft.content) : 0;
						const pct = chapter.targetWords > 0 ? Math.min(100, Math.round((written / chapter.targetWords) * 100)) : 0;
						const rev = draft ? " · 第" + draft.revision + "版" : "";
						const mats = chapter.materialIds.length > 0 ? " · 装料" + chapter.materialIds.length + "条" : " · 未装料";
						return (
							index + 1 + ". [" + chapter.id + "] " + chapter.title +
							"（" + chapter.status + "） 已写" + written + "字" +
							(chapter.targetWords ? "/" + chapter.targetWords : "") +
							(pct ? " " + pct + "%" : "") + rev + mats +
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
			description: "读取指定章节的已写正文。续写、改稿、评估前必须先读原文，不要凭印象猜写。",
			parameters: Type.Object({ chapterId: nonEmpty("章节 id，用 list_chapters 获取") }, { description: "读取章节" }),
			execute: async (_toolCallId, params) => {
				const p = getProject(deps);
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
			name: "list_materials",
			label: "查看素材",
			description: "列出素材库条目。每条素材含 id、种类、标题、用途（usage）与已关联章节。full 为 true 时附带全文。",
			parameters: Type.Object(
				{
					kind: Type.Optional(Type.String({ description: "按种类筛选，如 character / world / plot" })),
					query: optionalText("按标题或用途筛选"),
					full: Type.Optional(Type.Boolean({ description: "为 true 时返回素材全文，默认只给摘要" })),
				},
				{ description: "查看素材" },
			),
			execute: async (_toolCallId, params) => {
				const p = getProject(deps);
				const filter = params.kind?.trim().toLowerCase();
				const query = params.query?.trim().toLowerCase();
				let found = p.materials;
				if (filter) found = found.filter((m) => m.kind === filter);
				if (query) {
					found = found.filter(
						(m) =>
							m.title.toLowerCase().includes(query) ||
							m.usage.toLowerCase().includes(query) ||
							m.tags.some((tag) => tag.toLowerCase().includes(query)),
					);
				}
				if (found.length === 0) {
					return result(
						filter || query
							? "没有符合条件的素材。素材库共 " + p.materials.length + " 条。"
							: "素材库还是空的。",
						[],
					);
				}
				const text = found
					.map((m) => materialLine(m) + (params.full === true ? materialBody(m) : ""))
					.join("\n");
				return result(text, found);
			},
		}),

		defineTool({
			name: "add_note",
			label: "记录待办条目",
			description: "记下一条待处理的事项：尚未展开的伏笔、需要修正的前后不一致、待补的细节。发现问题时应主动记录而不是等第二次审稿。",
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
				deps.store.mutate(deps.projectId, (p) => {
					p.notes.push(note);
				});
				return result("已记录待办（" + note.severity + "）：" + note.category + " / " + note.subject, note);
			},
		}),

		defineTool({
			name: "list_notes",
			label: "查看待办列表",
			description: "列出待处理事项。动手前先调用它，避免重复劳动。",
			parameters: Type.Object(
				{ status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("resolved")], { description: "默认 open" })) },
				{ description: "待办列表" },
			),
			execute: async (_toolCallId, params) => {
				const p = getProject(deps);
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
				const p = getProject(deps);
				const note = p.notes.find((n) => n.id === params.id);
				if (!note) return result("找不到待办 " + params.id + "。");
				deps.store.mutate(deps.projectId, (draft) => {
					const target = draft.notes.find((n) => n.id === params.id);
					if (target) target.status = "resolved";
				});
				return result("已关闭待办：" + note.category + " / " + note.subject, note);
			},
		}),
	];
}

// ═══════════════════════════════════════════════════════════ 素材智能体专用

function updateOutlineTool(deps: NovelToolDeps): AgentTool<any> {
	return defineTool({
		name: "update_outline",
		label: "维护大纲",
		description:
			"新建或整体更新大纲。每个章节用 id 标识；已存在的 id 会被更新，新 id 则追加。" +
			"chapterIds 是本章打算用的素材 id 列表：传了就整体替换该章的装料，不传则保持原样（只改标题不必重复传）。" +
			"之后想单独增删就用 attach_materials。",
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
							chapterIds: Type.Optional(stringArray("本章要用的素材 id")),
						},
						{ description: "章节条目" },
					),
						{ minItems: 1, description: "大纲章节列表" },
				),
			},
			{ description: "更新大纲" },
		),
		execute: async (_toolCallId, params) => {
			const known = new Set(getProject(deps).materials.map((m) => m.id));
			const saved = deps.store.mutate(deps.projectId, (p) => {
				for (const chapter of params.chapters) {
					const index = p.outline.findIndex((item) => item.id === chapter.id);
					const next = {
						id: chapter.id,
						title: chapter.title,
						summary: chapter.summary,
						pov: chapter.pov ?? "",
						status: (chapter.status ?? "planned") as never,
						targetWords: chapter.targetWords ?? 0,
						notes: chapter.notes ?? "",
					};
					if (index >= 0) {
						const merged = { ...p.outline[index]!, ...next };
						// 只有显式传了 chapterIds 才动装配清单：
						// 改个标题不该把这一章的料抖掉。
						if (chapter.chapterIds) merged.materialIds = chapter.chapterIds.filter((id) => known.has(id));
						p.outline[index] = merged;
					} else {
						p.outline.push({ ...next, materialIds: (chapter.chapterIds ?? []).filter((id) => known.has(id)) });
					}
					// 反向同步素材的 chapterIds，让索引与素材卡上的"已装入"不说谎。
					if (chapter.chapterIds) {
						const target = p.outline.find((item) => item.id === chapter.id)!;
						const linked = new Set(target.materialIds);
						for (const material of p.materials) {
							const has = material.chapterIds.includes(chapter.id);
							if (linked.has(material.id) && !has) material.chapterIds.push(chapter.id);
							else if (!linked.has(material.id) && has) {
								material.chapterIds = material.chapterIds.filter((cid) => cid !== chapter.id);
							}
						}
					}
				}
			});
			return result(
				"大纲已更新，当共 " + saved.outline.length + " 章：\n" +
					lines(saved.outline.map((c) => "[" + c.id + "] " + c.title + "（" + c.status + "）装料" + c.materialIds.length + "条")),
				saved.outline,
			);
		},
	});
}

function upsertMaterialTool(deps: NovelToolDeps): AgentTool<any> {
	return defineTool({
		name: "upsert_material",
		label: "新建 / 更新素材",
		description:
			"新建或更新一条素材。素材是可复用的创作单位，不是正文。" +
			"usage 必填：写清什么情况下该用这条素材，装配智能体靠它判断相关性。" +
			"chapterIds 传了就整体替换关联（传空表等于从所有章节摘除），不传则保持原样。" +
			"已存在时只覆盖传入的字段。",
		parameters: Type.Object(
			{
				id: optionalText("已存在素材的 id，新建时留空"),
				kind: materialKindSchema,
				title: nonEmpty("标题"),
				content: nonEmpty("素材内容，写清约束与边界"),
				usage: nonEmpty("装配提示：什么情况下该用这条素材"),
				tags: Type.Optional(stringArray("标签、别名")),
				chapterIds: Type.Optional(stringArray("关联到的章节 id")),
			},
			{ description: "素材条目" },
		),
		execute: async (_toolCallId, params) => {
			const p = getProject(deps);
			const id = params.id?.trim() || randomUUID();
			const existing = p.materials.find((m) => m.id === id);
			const validChapters = new Set(p.outline.map((c) => c.id));
			// 关联到章节是双向的：素材记下用在哪，同时把 id 挂进章节的装配清单。
			// 区分"没传"与"传了空表"：没传保持原样，传空表等于从所有章节摘除。
			const provided = params.chapterIds !== undefined;
			const requested = provided ? params.chapterIds!.filter((cid) => validChapters.has(cid)) : [];
			const saved = deps.store.mutate(deps.projectId, (draft) => {
				const index = draft.materials.findIndex((m) => m.id === id);
				const base = index >= 0 ? draft.materials[index]! : emptyMaterial(id, params.kind);
				const next: Material = {
					...base,
					kind: params.kind,
					title: params.title,
					content: params.content,
					usage: params.usage,
					tags: params.tags ?? base.tags,
					chapterIds: provided ? requested : base.chapterIds,
					updatedAt: Date.now(),
				};
				if (index >= 0) draft.materials[index] = next;
				else draft.materials.push(next);
				if (!provided) return;
				for (const chapter of draft.outline) {
					const shouldHave = requested.includes(chapter.id);
					const has = chapter.materialIds.includes(id);
					if (shouldHave && !has) chapter.materialIds.push(id);
					// 重新指定 chapterIds 等于整体替换：被摘掉的章节也要清掉，
					// 否则那条料还会被当成该章的写作依据注入进去。
					else if (!shouldHave && has) chapter.materialIds = chapter.materialIds.filter((mid) => mid !== id);
				}
			});
			const material = saved.materials.find((m) => m.id === id);
			return result(
				(existing ? "已更新素材《" : "已新建素材《") + (material?.title ?? "") + "》（id: " + id + "）" +
					(requested.length > 0 ? "，已关联到 " + requested.length + " 章。" : "。"),
				material,
			);
		},
	});
}

function emptyMaterial(id: string, kind: MaterialKind): Material {
	const now = Date.now();
	return {
		id,
		kind,
		title: "",
		content: "",
		tags: [],
		usage: "",
		status: "draft",
		chapterIds: [],
		source: "agent",
		createdAt: now,
		updatedAt: now,
	};
}

function attachMaterialsTool(deps: NovelToolDeps): AgentTool<any> {
	return defineTool({
		name: "attach_materials",
		label: "装料到章节",
		description: "把已有素材装配到某章，或从某章移除。mode 为 add 时追加，remove 时摘除。两个方向都会同步更新素材的 chapterIds。",
		parameters: Type.Object(
			{
				chapterId: nonEmpty("章节 id"),
				materialIds: Type.Array(Type.String(), { minItems: 1, description: "要装入或摘除的素材 id" }),
				mode: Type.Optional(
					Type.Union([Type.Literal("add"), Type.Literal("remove")], { description: "默认 add" }),
				),
			},
			{ description: "装配素材" },
		),
		execute: async (_toolCallId, params) => {
			const mode = params.mode ?? "add";
			const saved = deps.store.mutate(deps.projectId, (p) => {
				linkMaterials(p, params.chapterId, params.materialIds, mode);
			});
			const chapter = saved.outline.find((c) => c.id === params.chapterId);
			if (!chapter) return result("找不到章节 " + params.chapterId + "。先用 update_outline 建立。");
			return result(
				"《" + chapter.title + "》现有装料 " + chapter.materialIds.length + " 条。",
				chapter,
			);
		},
	});
}

/**
 * 素材智能体的工具集。
 *
 * 刻意不含 write_chapter —— 工具边界就是职责边界，
 * 没有写入正文的工具，模型就无法跳过素材直接交正文。
 */
export function createMaterialTools(deps: NovelToolDeps): AgentTool<any>[] {
	return [
		...sharedTools(deps),
		updateOutlineTool(deps),
		upsertMaterialTool(deps),
		attachMaterialsTool(deps),
	];
}

// ═══════════════════════════════════════════════════════════ 组装智能体专用

function writeChapterTool(deps: NovelToolDeps): AgentTool<any> {
	return defineTool({
		name: "write_chapter",
		label: "写入章节正文",
		description:
			"把已装配的素材组装成章节正文。每一次调用会整段覆盖该章节已有内容并保留一个新版本。" +
			"续写时 mode 选 continue；重写选 rewrite；从零写起选 create。" +
			"materialIds 如实填入实际用到的素材 id，供回溯这段正文从什么料而来。",
		parameters: Type.Object(
			{
				chapterId: nonEmpty("章节 id"),
				title: nonEmpty("章节标题"),
				content: nonEmpty("章节正文全文，含层次和场景描写"),
				mode: Type.Optional(
					Type.Union([Type.Literal("create"), Type.Literal("rewrite"), Type.Literal("continue")], {
						description: "create 从零写起，rewrite 整章重写，continue 在已有正文后续写。默认 create",
					}),
				),
				materialIds: Type.Optional(stringArray("本次实际用到的素材 id")),
			},
			{ description: "写入章节" },
		),
		execute: async (_toolCallId, params) => {
			const mode = params.mode ?? "create";
			const written = await deps.store.withChapterLock(deps.projectId, params.chapterId, () => {
				const p = getProject(deps);
				const existing = p.drafts[params.chapterId];
				const planned = p.outline.find((chapter) => chapter.id === params.chapterId);
				return deps.store.mutate(deps.projectId, (draft) => {
					draft.drafts[params.chapterId] = {
						id: params.chapterId,
						title: params.title,
						content: params.content,
						revision: (existing?.revision ?? 0) + 1,
						updatedAt: Date.now(),
						// 没显式传素材时，依次回落到上一版记录、本章装配清单。
						materialIds: params.materialIds ?? existing?.materialIds ?? planned?.materialIds ?? [],
					};
					const meta = draft.outline.find((chapter) => chapter.id === params.chapterId);
					// 有正文就该是 drafted：素材智能体常把章节留在 outlined，
					// 只认 planned 会让写完的章在界面上仍显示"未成稿"。
					if (meta && (meta.status === "planned" || meta.status === "outlined")) meta.status = "drafted";
				});
			});
			const draft = written.drafts[params.chapterId]!;
			return result(
				"已写入《" + draft.title + "》：第 " + draft.revision + " 版，" + countWords(draft.content) + " 字（" + mode + "）。",
				draft,
			);
		},
	});
}

/**
 * 组装智能体的工具集。
 *
 * 写入类工具只有 write_chapter；素材只能读不能改 —— 料由素材智能体负责。
 */
export function createWritingTools(deps: NovelToolDeps): AgentTool<any>[] {
	return [
		...sharedTools(deps),
		writeChapterTool(deps),
	];
}
