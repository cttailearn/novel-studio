import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
	countWords,
	linkMaterials,
	MAX_DRAFT_HISTORY,
	MATERIAL_KINDS,
	MATERIAL_KIND_LABELS,
	type ContinuityNote,
	type Material,
	type MaterialKind,
	type NoteSeverity,
	type Project,
	type ProjectStore,
} from "../store/project.ts";
import type { LibraryMaterial, MaterialLibrary } from "../store/library.ts";

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

/**
 * 一处命中最多的行数。
 *
 * 相邻命中要并成一段以保持原文连续，但并起来没有上限就会失控：
 * 素材里若每行都含这个词（比如通篇写同一种天气），整篇会被并成一段，
 * 检索就退化成了全文注入 —— 正是要避免的那件事。
 */
const MAX_SNIPPET_LINES = 8;

/**
 * 把检索词切开。
 *
 * 中文没有词边界，所以按二元组切：「酸雨霓虹」→ 酸雨/雨霓/霓虹。
 * 这样「霓虹」能命中「霓虹灯」，也不会因为中间多了个「的」就整句落空。
 * 西文按非字母数字切，整词匹配。
 */
function queryTokens(query: string): string[] {
	const tokens = new Set<string>();
	for (const part of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (!part) continue;
		if (/^[\x00-\x7f]+$/.test(part) || part.length <= 2) {
			tokens.add(part);
			continue;
		}
		for (let i = 0; i + 2 <= part.length; i++) tokens.add(part.slice(i, i + 2));
	}
	return [...tokens];
}

/** 一处命中：某条素材的某几行。 */
interface MaterialHit {
	material: Material;
	from: number;
	to: number;
	score: number;
}

/**
 * 在素材里按关键词找相关片段。
 *
 * 逐行打分而不是整篇向量化：素材本来就是"一行一个事实"写的，
 * 行就是天然的语义单位；而且这条路不依赖任何外部服务，离线也准。
 * 命中行向前后各扩一行作上下文，相邻命中合并成一段，免得同一处被切碎。
 */
function searchMaterials(pool: Material[], query: string, limit: number): MaterialHit[] {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return [];
	const hits: MaterialHit[] = [];
	for (const material of pool) {
		const rows = material.content.split("\n");
		const ranges: { from: number; to: number; score: number }[] = [];
		for (let i = 0; i < rows.length; i++) {
			const lower = rows[i]!.toLowerCase();
			if (!lower.trim()) continue;
			let score = 0;
			for (const token of tokens) if (lower.includes(token)) score += token.length;
			if (score === 0) continue;
			const from = Math.max(0, i - 1);
			const to = Math.min(rows.length - 1, i + 1);
			const last = ranges[ranges.length - 1];
			// 与上一处相接或重叠就并起来，保持原文连续 ——
			// 但合并后若超过上限就另起一段，免得密集命中把整篇并成一块。
			const mergedTo = last ? Math.max(last.to, to) : to;
			if (last && from <= last.to + 1 && mergedTo - last.from + 1 <= MAX_SNIPPET_LINES) {
				last.to = mergedTo;
				last.score += score;
			} else {
				// 另起时从上一段末尾之后开始，两段不重叠：同一片原文
				// 被切成互相覆盖的两块，既费字又让人以为读的是两处。
				const start = last ? Math.max(from, last.to + 1) : from;
				ranges.push({ from: start, to: Math.max(start, to), score });
			}
		}
		for (const range of ranges) hits.push({ material, ...range });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 命中片段渲染成模型能直接读的文本，带素材出处与行号。 */
function renderHit(hit: MaterialHit): string {
	const rows = hit.material.content.split("\n");
	const body = rows
		.slice(hit.from, hit.to + 1)
		.map((row) => "  " + row)
		.join("\n");
	return `【${MATERIAL_KIND_LABELS[hit.material.kind]} · ${hit.material.title}】第 ${hit.from + 1}-${hit.to + 1} 行\n${body}`;
}
// ═══════════════════════════════════════════════════════════ 两套智能体共用的工具

/** get_project_brief / list_chapters / read_chapter / list_materials / search_materials / add_note / list_notes / resolve_note */
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

		defineTool({
			name: "search_materials",
			label: "检索素材片段",
			description:
				"在本章装配的素材里按关键词找相关片段，返回命中处的原文与出处。" +
				"长素材的全文没有直接注入系统提示词（会把窗口占满），写与它相关的段落前要用这里取。" +
				"中文按二元组匹配，所以「霓虹」能命中「霓虹灯」。一次搜不到就换个说法再搜 —— " +
				"同一件事在不同素材里可能写作「枪伤」「旧创」「左肩那道疤」，多搜几轮比猜更准。" +
				"materialId 只搜某一条；不传则搜本章全部装配素材。",
			parameters: Type.Object(
				{
					query: nonEmpty("要找什么，用自然语言或关键词都行"),
					materialId: optionalText("只在这一条素材里搜；留空则搜本章全部装配素材"),
					limit: Type.Optional(Type.Number({ description: "最多返回几处命中，默认 6，上限 20" })),
				},
				{ description: "检索素材" },
			),
			execute: async (_toolCallId, params) => {
				const p = getProject(deps);
				// 只搜本章装配的素材：它们是这一章唯一的事实来源，
				// 未装配的料即使相关也不该被拿来写这一章。
				const assembled = p.materials.filter((m) => m.chapterIds.length > 0);
				const pool = params.materialId
					? p.materials.filter((m) => m.id === params.materialId)
					: assembled;
				if (pool.length === 0) {
					return result(
						params.materialId
							? "找不到素材 " + params.materialId + "。"
							: "本章还没有装配任何素材，没有可检索的内容。先让设定官用 attach_materials 装料。",
						[],
					);
				}
				const limit = Math.min(20, Math.max(1, Math.floor(params.limit ?? 6)));
				const hits = searchMaterials(pool, params.query, limit);
				if (hits.length === 0) {
					return result(
						"没有匹配「" + params.query + "」的片段（搜了 " + pool.length + " 条素材）。" +
							"换个说法再试：同义、上位词、或只取其中一个词。",
						[],
					);
				}
				return result(hits.map(renderHit).join("\n\n"), hits);
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
			// 把被丢弃的 id 报回去。静默过滤会让模型以为装料成功了，
			// 下一步才发现这一章没料可写，却不知道是哪个 id 写错了。
			const requested = (params.chapters ?? []).flatMap((c) => c.chapterIds ?? []);
			const missing = requested.filter((id) => !known.has(id));
			return result(
				"大纲已更新，当共 " + saved.outline.length + " 章：\n" +
					lines(saved.outline.map((c) => "[" + c.id + "] " + c.title + "（" + c.status + "）装料" + c.materialIds.length + "条")) +
					(missing.length > 0 ? "\n\n以下素材 id 不存在，未装入（先 upsert_material 确认 id）：" + missing.join("、") : ""),
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
			"新建时必须给齐 kind / title / content / usage 四项；" +
			"更新已有素材（带 id）时只给要改的字段，其余保持原样 —— 只想改内容就只传 content。" +
			"usage 必填且要写清什么情况下该用这条素材，装配智能体靠它判断相关性；一句说完，别解释。" +
			"content 必须精减：只留事实、约束、边界，一行一个事实，不写散文与铺垫。" +
			"chapterIds 传了就整体替换关联（传空表等于从所有章节摘除），不传则保持原样。",
		parameters: Type.Object(
			{
				id: optionalText("已存在素材的 id；新建时留空"),
				kind: Type.Optional(materialKindSchema),
				title: optionalText("标题。新建必填，更新时可省"),
				content: optionalText("素材内容：只写事实、约束与边界，一行一个事实，务必精减。新建必填，更新时可省"),
				usage: optionalText("装配提示：什么情况下该用这条素材。新建必填，更新时可省"),
				tags: Type.Optional(stringArray("标签、别名")),
				chapterIds: Type.Optional(stringArray("关联到的章节 id")),
			},
			{ description: "素材条目" },
		),
		execute: async (_toolCallId, params) => {
			const p = getProject(deps);
			const id = params.id?.trim() || randomUUID();
			const existing = p.materials.find((m) => m.id === id);
			// 四个字段在 schema 里都是可选的，因为更新时只需给要改的那几项。
			// 新建的完整性在这里补校验：缺什么就说清什么，让模型当轮自己改对，
			// 而不是抛一个只显示 required 的校验异常（那种报错模型看不懂）。
			if (!existing) {
				const missing: string[] = [];
				if (!params.kind) missing.push("kind（素材种类）");
				if (!params.title?.trim()) missing.push("title（标题）");
				if (!params.content?.trim()) missing.push("content（素材内容）");
				if (!params.usage?.trim()) missing.push("usage（装配提示）");
				if (missing.length > 0) {
					return result(
						"新建素材还缺：" + missing.join("、") + "。请重新调用 upsert_material 补全后再试。" +
							"（若本意是修改已有素材，请带上它的 id；带 id 时只需给要改的字段。）",
					);
				}
			}
			const validChapters = new Set(p.outline.map((c) => c.id));
			// 关联到章节是双向的：素材记下用在哪，同时把 id 挂进章节的装配清单。
			// 区分"没传"与"传了空表"：没传保持原样，传空表等于从所有章节摘除。
			const provided = params.chapterIds !== undefined;
			const requested = provided ? params.chapterIds!.filter((cid) => validChapters.has(cid)) : [];
			const saved = deps.store.mutate(deps.projectId, (draft) => {
				const index = draft.materials.findIndex((m) => m.id === id);
				const base = index >= 0 ? draft.materials[index]! : emptyMaterial(id, params.kind ?? "other");
				// 只覆盖真正传了的字段：更新时不传的字段保持原样。
				const next: Material = {
					...base,
					kind: params.kind ?? base.kind,
					title: params.title?.trim() || base.title,
					content: params.content?.trim() ? params.content : base.content,
					usage: params.usage?.trim() || base.usage,
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
			// 点名没生效的章节 id：静默丢掉的话，模型会以为关联完成了。
			const unknown = provided ? params.chapterIds!.filter((cid) => !validChapters.has(cid)) : [];
			return result(
				(existing ? "已更新素材《" : "已新建素材《") + (material?.title ?? "") + "》（id: " + id + "）" +
					(requested.length > 0 ? "，已关联到 " + requested.length + " 章。" : "。") +
					(unknown.length > 0 ? "以下章节 id 不存在，未关联：" + unknown.join("、") : ""),
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
			let skipped: string[] = [];
			const saved = deps.store.mutate(deps.projectId, (p) => {
				skipped = linkMaterials(p, params.chapterId, params.materialIds, mode).skipped;
			});
			const chapter = saved.outline.find((c) => c.id === params.chapterId);
			if (!chapter) return result("找不到章节 " + params.chapterId + "。先用 update_outline 建立。");
			// 早先 linkMaterials 算出的 skipped 被丢掉了，模型只看到"现有装料 N 条"，
			// 会以为 id 全都装上了。把没生效的 id 点名，它才知道该先去建素材。
			return result(
				"《" + chapter.title + "》现有装料 " + chapter.materialIds.length + " 条。" +
					(skipped.length > 0 ? "\n以下素材 id 不存在，未装入（先 upsert_material 确认 id）：" + skipped.join("、") : ""),
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
			// 只允许写章目里真有的章。模型偶尔会拿着上一轮的章号自由发挥，
			// 旧实现会照着这个 id 造出一份不在大纲里的「幽灵正文」。
			const project = getProject(deps);
			if (!project.outline.some((chapter) => chapter.id === params.chapterId)) {
				throw new Error(
					"章节 " + params.chapterId + " 不在本章目里，不能凭空写入；请先用 update_outline 立章，或改用已有章节的 id。",
				);
			}
			const written = await deps.store.withChapterLock(deps.projectId, params.chapterId, () => {
				const p = getProject(deps);
				const existing = p.drafts[params.chapterId];
				const planned = p.outline.find((chapter) => chapter.id === params.chapterId);
			return deps.store.mutate(deps.projectId, (draft) => {
					// 覆盖前先把旧稿归档。rewrite / continue 都建立在旧稿之上，
					// 一次写坏就是整章丢失，而 revision 只是个计数器，找不回内容。
					const history = [...(existing?.history ?? [])];
					if (existing && existing.content.trim()) {
						history.push({
							revision: existing.revision,
							title: existing.title,
							content: existing.content,
							materialIds: existing.materialIds,
							updatedAt: existing.updatedAt,
							mode,
						});
						// 只留最近若干版：正文动辄数万字，全量留档会把工程文件撑爆。
						while (history.length > MAX_DRAFT_HISTORY) history.shift();
					}
					draft.drafts[params.chapterId] = {
						id: params.chapterId,
						title: params.title,
						content: params.content,
						revision: (existing?.revision ?? 0) + 1,
						updatedAt: Date.now(),
						// 没显式传素材时，依次回落到上一版记录、本章装配清单。
						materialIds: params.materialIds ?? existing?.materialIds ?? planned?.materialIds ?? [],
						history,
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

// ═══════════════════════════════════════════════════════════ 通用素材库作用域

/**
 * 通用素材库用的工具集。
 *
 * 作者要在开书之前先把料备好，那时还没有工程、也没有大纲 ——
 * 所以这里不是把作品工具换个 store，而是另起一套：库里没有章节可立、
 * 没有装料可挂，给出那些工具只会让模型反复撞空。
 * 能做的只有两件事：看库里有什么，往库里写一条。
 */
export interface LibraryToolDeps {
	library: MaterialLibrary;
}

/** 库条目的一行摘要。与作品素材同格式，但不带"已装入"——库里没有章节。 */
function libraryLine(entry: LibraryMaterial): string {
	const head = "[" + MATERIAL_KIND_LABELS[entry.kind] + "] " + entry.title + "（id: " + entry.id + "）";
	const bits: string[] = [];
	if (entry.usage) bits.push("用于：" + entry.usage);
	if (entry.tags.length > 0) bits.push("标签：" + entry.tags.join("、"));
	if (entry.status === "confirmed") bits.push("已确认");
	return bits.length > 0 ? head + "\n  " + bits.join("；") : head;
}

function libraryBody(entry: LibraryMaterial): string {
	return entry.content ? "\n  " + entry.content.split("\n").join("\n  ") : "";
}

export function createLibraryTools(deps: LibraryToolDeps): AgentTool<any>[] {
	return [
		defineTool({
			name: "list_materials",
			label: "查看通用素材库",
			description:
				"列出通用素材库里已有的条目。每条含 id、种类、标题、用途（usage）与标签；full 为 true 时附带全文。" +
				"写新条目前先调用它，避免和已有的重复。",
			parameters: Type.Object(
				{
					kind: Type.Optional(Type.String({ description: "按种类筛选，如 character / world / plot" })),
					query: optionalText("按标题、用途或标签筛选"),
					full: Type.Optional(Type.Boolean({ description: "为 true 时返回素材全文，默认只给摘要" })),
				},
				{ description: "查看通用素材库" },
			),
			execute: async (_toolCallId, params) => {
				const all = deps.library.list();
				const filter = params.kind?.trim().toLowerCase();
				const query = params.query?.trim().toLowerCase();
				let found = all;
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
						filter || query ? "没有符合条件的条目。库里共 " + all.length + " 条。" : "通用素材库还是空的。",
						[],
					);
				}
				const text = found
					.map((m) => libraryLine(m) + (params.full === true ? libraryBody(m) : ""))
					.join("\n");
				return result(text, found);
			},
		}),

		defineTool({
			name: "upsert_material",
			label: "新建 / 更新通用素材",
			description:
				"新建或更新一条**通用素材**。通用素材不属于任何一部作品，作者会在多部书里取用它们，" +
				"所以要写成脱离具体作品也能看懂的东西：不要写「这是本书」「主角」这类只在这部书里成立的说法。" +
				"新建时必须给齐 kind / title / content / usage 四项；更新（带 id）时只给要改的字段。" +
				"usage 要写清什么情况下该用这条料，一句说完。content 必须精减：只留事实、约束、边界，不写散文。",
			parameters: Type.Object(
				{
					id: optionalText("已存在条目的 id；新建时留空"),
					kind: Type.Optional(materialKindSchema),
					title: optionalText("标题。新建必填，更新时可省"),
					content: optionalText("素材内容：只写事实、约束与边界，一行一个事实，务必精减。新建必填，更新时可省"),
					usage: optionalText("装配提示：什么情况下该用这条素材。新建必填，更新时可省"),
					tags: Type.Optional(stringArray("标签、别名")),
				},
				{ description: "通用素材条目" },
			),
			execute: async (_toolCallId, params) => {
				const id = params.id?.trim() || randomUUID();
				const existing = deps.library.get(id);
				// 四个字段在 schema 里都是可选的（更新时只给要改的那几项），
				// 新建的完整性在这里补校验，让模型当轮自己改对。
				if (!existing) {
					const missing: string[] = [];
					if (!params.kind) missing.push("kind（素材种类）");
					if (!params.title?.trim()) missing.push("title（标题）");
					if (!params.content?.trim()) missing.push("content（素材内容）");
					if (!params.usage?.trim()) missing.push("usage（装配提示）");
					if (missing.length > 0) {
						return result(
							"新建通用素材还缺：" + missing.join("、") + "。请重新调用 upsert_material 补全后再试。" +
								"（若本意是修改已有条目，请带上它的 id。）",
						);
					}
				}
				// create 负责新 id 与默认状态，update 负责逐字段覆盖 ——
				// 按有无 existing 分流，两条路径的字段含义才一致。
				const fields = {
					kind: params.kind ?? existing?.kind ?? ("other" as MaterialKind),
					title: params.title?.trim() || existing?.title,
					content: params.content?.trim() ? params.content : existing?.content,
					usage: params.usage?.trim() || existing?.usage,
					tags: params.tags ?? existing?.tags,
				};
				const saved = existing
					? deps.library.update(existing.id, fields)!
					: deps.library.create(fields);
				return result(
					(existing ? "已更新通用素材《" : "已新建通用素材《") + saved.title + "》（id: " + saved.id + "）。" +
						"作者可在任意作品里取用它。",
					saved,
				);
			},
		}),
	];
}

function emptyLibraryMaterial(id: string, kind: MaterialKind): LibraryMaterial {
	const now = Date.now();
	return { id, kind, title: "", content: "", tags: [], usage: "", status: "draft", createdAt: now, updatedAt: now };
}
