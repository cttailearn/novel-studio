import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	countWords,
	kindLabel,
	kindOptions,
	linkMaterials,
	MAX_DRAFT_HISTORY,
	newId,
	type ContinuityNote,
	type Material,
	type MaterialKind,
	type NoteSeverity,
	type Project,
} from "../store/project.ts";
import type { ProjectStorePort } from "../store/store-port.ts";
import type { LibraryMaterial, MaterialLibrary } from "../store/library.ts";
import type { AskBroker } from "./ask.ts";
import { createWebSearchTools, type WebSearchClient, type WebSearchConfig } from "./web-search.ts";

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

/**
 * 给新卷派个号：v01、v02 …
 *
 * 与章的 ch01 同一套路：号在人读的输出里稳定，作者也好认。
 * 卷 id 撞了就往后挪，别让两卷共用一个号。
 */
function nextVolumeId(project: Project): string {
	const taken = new Set(project.volumes.map((volume) => volume.id));
	let n = project.volumes.length + 1;
	let id = "v" + String(n).padStart(2, "0");
	while (taken.has(id)) {
		n += 1;
		id = "v" + String(n).padStart(2, "0");
	}
	return id;
}

/**
 * 素材 kind 的枚举 schema。
 *
 * 每次建智能体时现取一次种类目录 —— 作者添了新门类，智能体立刻就能用，
 * 不用等谁改代码。枚举里带上中文名，模型才知道「势力」是哪一门。
 */
function materialKindSchema() {
	const options = kindOptions();
	return Type.Union(
		options.map((option) => Type.Literal(option.kind)),
		{ description: "素材种类：" + options.map((option) => option.kind + "（" + option.label + "）").join("、") },
	);
}

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
	store: ProjectStorePort;
	projectId: string;
	/**
	 * 提问通道。给了才有 ask_user 工具 ——
	 * 给模型一个问不出去的工具，比不给更糟。
	 */
	ask?: AskBroker;
	/** writing 会话允许读取、检索和写入的章节范围；低层工具测试可不传。 */
	allowedChapterId?: string;
	previousChapterId?: string;
	/** 由服务端授权后注入，仅供设定官使用。 */
	webSearch?: { client: WebSearchClient; config: WebSearchConfig };
}

function getProject(deps: NovelToolDeps): Project {
	const found = deps.store.get(deps.projectId);
	if (!found) throw new Error("工程已被删除，无法继续操作");
	return found;
}

function assertWritableChapter(deps: NovelToolDeps, chapterId: string): void {
	if (deps.allowedChapterId && chapterId !== deps.allowedChapterId) {
		throw new Error("本次写作只允许操作章节 " + deps.allowedChapterId + "，不能写入或修改 " + chapterId + "。");
	}
}

function assertReadableChapter(deps: NovelToolDeps, chapterId: string): void {
	if (deps.allowedChapterId && chapterId !== deps.allowedChapterId && chapterId !== deps.previousChapterId) {
		throw new Error("本次写作只能读取本章 " + deps.allowedChapterId + (deps.previousChapterId ? " 或上一章 " + deps.previousChapterId : "") + "，不能读取 " + chapterId + "。");
	}
}

/** 续写只交增量；模型若交回完整旧稿 + 新增，去掉旧稿前缀，避免重复。 */
function appendContent(oldContent: string, incoming: string): string {
	if (!oldContent) return incoming;
	if (incoming.startsWith(oldContent)) return oldContent + incoming.slice(oldContent.length);
	const oldTrimmed = oldContent.trimEnd();
	if (oldTrimmed && incoming.startsWith(oldTrimmed)) {
		return oldContent + incoming.slice(oldTrimmed.length);
	}
	return oldContent + (/[\r\n]$/.test(oldContent) || /^[\r\n]/.test(incoming) ? "" : "\n\n") + incoming;
}

const AUTOMATIC_SUMMARY_PREFIX = "【自动摘要】";
function automaticSummary(content: string): string {
	const tail = content.trim().replace(/\s+/g, " ").slice(-240);
	return AUTOMATIC_SUMMARY_PREFIX + (tail || "正文已更新，但没有可提取的正文内容。");
}

function knownMaterialIds(project: Project, ids: string[]): { ids: string[]; dropped: string[] } {
	const known = new Set(project.materials.map((material) => material.id));
	return { ids: [...new Set(ids.filter((id) => known.has(id)))], dropped: [...new Set(ids.filter((id) => !known.has(id)))] };
}

/** 素材的一行摘要，用于工具结果与快照。 */
function materialLine(material: Material): string {
	const label = kindLabel(material.kind);
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
	return `【${kindLabel(hit.material.kind)} · ${hit.material.title}】第 ${hit.from + 1}-${hit.to + 1} 行\n${body}`;
}
// ═══════════════════════════════════════════════════════════ 两套智能体共用的工具

/**
 * 向作者提问。
 *
 * 这一支工具的形状和别的工具不同：它不立刻返回，而是挂在那里等作者作答。
 * 答案到手后作为工具结果回到对话里，智能体在同一轮里接着往下做。
 * 问错了地方比不问更糟，所以只给有提问通道的场合装这一支。
 */
function askUserTool(ask: AskBroker): AgentTool<any> {
	return defineTool({
		name: "ask_user",
		label: "向作者提问",
		description:
			"向作者提一个具体的问题，等他回答。只有作者能拍板的事才问：素材和已有正文里查不到、只有作者作得了主的时候。" +
			"调用之后这一轮会停下等作者回答；作者的回答（或\"没回答\"）会作为工具结果回来，你在这一轮接着干活。",
		parameters: Type.Object(
			{
				question: nonEmpty("要问作者的问题，一句具体的中文提问"),
				options: Type.Optional(stringArray("可选的候选答案，给作者点选用；没有明确几种选择就别给")),
			},
			{ description: "向作者提一个问题" },
		),
		execute: async (_toolCallId, params: { question: string; options?: string[] }, signal) => {
			const answer = await ask.ask({ question: params.question, options: params.options }, signal);
			if (!answer.trim()) {
				// 没回答也是一种回答：作者不想答。按自己的判断往下走，别替他编。
				return result("作者没回答这个问题。按你自己的判断继续，不要替作者编造回答。", {
					question: params.question,
					answered: false,
				});
			}
			return result("作者的回答：" + answer, {
				question: params.question,
				answered: true,
				answer,
			});
		},
	});
}

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
			description:
				"列出大纲的章节、每章状态、已写字数与已装配的素材数。写新章节前应先调用它确认章节号与状态。" +
				"章多时用 offset 与 limit 分段取；要看每章要略再加 withSummary —— 要略最占篇幅，" +
				"没必要时不要带。",
			parameters: Type.Object(
				{
					scope: Type.Optional(
						Type.Union([Type.Literal("all"), Type.Literal("drafted"), Type.Literal("undrafted")], {
							description: "取哪一批章：all 全部（默认）、drafted 只看已落笔、undrafted 只看还没写的",
						}),
					),
					offset: Type.Optional(Type.Number({ description: "从第几章开始（0 起，默认 0）" })),
					limit: Type.Optional(Type.Number({ description: "最多列多少章（默认 40，上限 200）" })),
					withSummary: Type.Optional(Type.Boolean({ description: "是否带上每章要略（默认不带）" })),
				},
				{ description: "无参数即列前 40 章，不带要略" },
			),
			execute: async (_toolCallId, params: { scope?: string; offset?: number; limit?: number; withSummary?: boolean }) => {
				const p = getProject(deps);
				if (p.outline.length === 0) return result("大纲还是空的，需要先用 update_outline 建立。", p.outline);
				const volumeName = (volumeId: string) =>
					volumeId ? (p.volumes.find((volume) => volume.id === volumeId)?.title ?? "") : "";
				// 先按范围筛，再分段取。
				// 一千章的书一次全列出来，光是章号与标题就够把上下文窗撑爆，
				// 而模型多数时候只想看"前面那几章"或"哪些还没写"。
				const scope = params.scope ?? "all";
				const scoped = p.outline.filter((chapter) => {
					const written = p.drafts[chapter.id]?.hasDraft === true;
					if (scope === "drafted") return written;
					if (scope === "undrafted") return !written;
					return true;
				});
				const offset = Math.max(0, Math.floor(params.offset ?? 0));
				const limit = Math.min(200, Math.max(1, Math.floor(params.limit ?? 40)));
				const page = scoped.slice(offset, offset + limit);
				const chapters = lines(
					page.map((chapter, index) => {
						const draft = p.drafts[chapter.id];
						// 字数是元数据里记好的，不必再扫一遍正文。
						const written = draft?.words ?? 0;
						const pct = chapter.targetWords > 0 ? Math.min(100, Math.round((written / chapter.targetWords) * 100)) : 0;
						const rev = draft ? " · 第" + draft.revision + "版" : "";
						const mats = chapter.materialIds.length > 0 ? " · 装料" + chapter.materialIds.length + "条" : " · 未装料";
						const volume = volumeName(chapter.volumeId);
						const summary = params.withSummary && chapter.summary ? "—— " + chapter.summary : "";
						return (
							(offset + index + 1) + ". " + (volume ? "〔" + volume + "〕" : "") +
							"[" + chapter.id + "] " + chapter.title +
							"（" + chapter.status + "） 已写" + written + "字" +
							(chapter.targetWords ? "/" + chapter.targetWords : "") +
							(pct ? " " + pct + "%" : "") + rev + mats +
							summary
						);
					}),
				);
				// 有卷就先报卷：卷要略是"这一卷大致写什么"，比单章要略更早决定情节走向。
				const volumes =
					p.volumes.length > 0
						? "卷：\n" +
							lines(
								p.volumes.map((volume) => {
									const count = p.outline.filter((chapter) => chapter.volumeId === volume.id).length;
									return (
										"[" + volume.id + "] " + volume.title + "（" + count + "章" +
										(volume.targetWords ? "，目标" + volume.targetWords + "字" : "") + "）" +
										(volume.summary ? "：" + volume.summary : "")
									);
								}),
							) + "\n\n章：\n"
						: "";
				const more = scoped.length > offset + page.length
					? "\n（还有 " + (scoped.length - offset - page.length) + " 章没列，用 offset 继续取）"
					: "";
				return result(volumes + chapters + more, {
					chapters: page.map((chapter) => ({
						id: chapter.id,
						title: chapter.title,
						status: chapter.status,
						volumeId: chapter.volumeId,
						targetWords: chapter.targetWords,
						materialCount: chapter.materialIds.length,
						words: p.drafts[chapter.id]?.words ?? 0,
						revision: p.drafts[chapter.id]?.revision ?? 0,
						...(params.withSummary ? { summary: chapter.summary } : {}),
					})),
					volumes: p.volumes.map(({ id, title, targetWords }) => ({ id, title, targetWords })),
					pagination: { offset, limit, total: scoped.length, returned: page.length, hasMore: scoped.length > offset + page.length },
				});
			},
		}),

		defineTool({
			name: "read_chapter",
			label: "读取章节正文",
			description:
				"读取指定章节的已写正文。续写、改稿、评估前必须先读原文，不要凭印象猜写。" +
				"正文很长时用 part 与 chars 取一段：head 取开头、tail 取结尾（接文气用）；" +
				"start 可以把取段的位置往后挪。",
			parameters: Type.Object(
				{
					chapterId: nonEmpty("章节 id，用 list_chapters 获取"),
					part: Type.Optional(
						Type.Union([Type.Literal("full"), Type.Literal("head"), Type.Literal("tail")], {
							description: "取哪一段：full 全文（默认）、head 开头、tail 结尾",
						}),
					),
					chars: Type.Optional(Type.Number({ description: "取多少字（默认 6000，上限 20000）" })),
					start: Type.Optional(Type.Number({ description: "part 为 head/tail 时的起始字位（默认 0）" })),
				},
				{ description: "读取章节" },
			),
			execute: async (_toolCallId, params: { chapterId: string; part?: string; chars?: number; start?: number }) => {
				assertReadableChapter(deps, params.chapterId);
				const p = getProject(deps);
				const draftMeta = p.drafts[params.chapterId];
				if (!draftMeta) return result("章节 " + params.chapterId + " 还没有正文。");
				// 正文在磁盘上（.txt），按需取这一章，不牵动别的章。
				const body = await deps.store.readDraftBody(p.id, params.chapterId);
				const content = body?.content ?? "";
				const meta = p.outline.find((chapter) => chapter.id === params.chapterId);
				const head = meta ? "《" + meta.title + "》大纲要点：" + meta.summary + "\n" : "";
				// 分段取：整章几万字塞进上下文，后面的对话就没地方放了。
				const limit = Math.min(20_000, Math.max(200, Math.floor(params.chars ?? 6000)));
				const start = Math.max(0, Math.floor(params.start ?? 0));
				const part = params.part ?? "full";
				let slice = content;
				let note = "";
				if (part === "head") {
					slice = content.slice(start, start + limit);
					note = content.length > slice.length ? "\n（正文较长，这里只给了开头一段；要中段就再取一次）" : "";
				} else if (part === "tail") {
					slice = content.slice(Math.max(0, content.length - limit - start));
					note = content.length > slice.length ? "\n（正文较长，这里只给了结尾一段）" : "";
				} else if (content.length > limit) {
					slice = content.slice(0, limit);
					note = "\n（正文较长，这里只给了开头一段；要中段就再取一次）";
				}
				return result(
					"《" + draftMeta.title + "》（第" + draftMeta.revision + "版，" + draftMeta.words + " 字）\n" + head + "\n---\n" + slice + note,
					{ id: draftMeta.id, title: draftMeta.title, revision: draftMeta.revision, words: draftMeta.words },
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
					offset: Type.Optional(Type.Number({ description: "从第几条开始（0 起，默认 0）" })),
					limit: Type.Optional(Type.Number({ description: "最多列多少条（默认 40，上限 200）" })),
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
				const offset = Math.max(0, Math.floor(params.offset ?? 0));
				const limit = Math.min(200, Math.max(1, Math.floor(params.limit ?? 40)));
				const page = found.slice(offset, offset + limit);
				const text = page
					.map((m) => materialLine(m) + (params.full === true ? materialBody(m) : ""))
					.join("\n") + (found.length > offset + page.length ? "\n（还有 " + (found.length - offset - page.length) + " 条，用 offset 继续取）" : "");
				return result(text, {
					materials: page.map(({ id, kind, title, usage, tags, chapterIds, status }) => ({ id, kind, title, usage, tags, chapterIds, status })),
					pagination: { offset, limit, total: found.length, returned: page.length, hasMore: found.length > offset + page.length },
				});
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
					id: newId(),
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
				await deps.store.flushForProject(deps.projectId);
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
				await deps.store.flushForProject(deps.projectId);
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
				const allowedId = deps.allowedChapterId;
				if (!allowedId) return result("未指定本章范围，不能检索素材。请由写作会话提供 allowedChapterId。", []);
				const chapter = p.outline.find((item) => item.id === allowedId);
				if (!chapter) return result("找不到允许章节 " + allowedId + "。", []);
				const assembledIds = new Set(chapter.materialIds);
				// 章节大纲的 materialIds 是唯一事实池，不能用素材卡的 chapterIds 代替。
				const assembled = p.materials.filter((m) => assembledIds.has(m.id));
				const pool = params.materialId
					? assembled.filter((m) => m.id === params.materialId)
					: assembled;
				if (pool.length === 0) {
					return result(
						params.materialId
							? "素材 " + params.materialId + " 不存在，或未装配到本章 " + allowedId + "，不能检索。"
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

		// 有提问通道才装这一支：问不出去的工具比没有更糟。
		...(deps.ask ? [askUserTool(deps.ask)] : []),
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
			"之后想单独增删就用 attach_materials。" +
			"卷是可选的：可以先用 volumes 立几卷（卷名、卷要略、卷目标字数），再在章上用 volume 写卷名把章挂进去；" +
			"卷名在章上第一次出现时也会自动立卷。不传 volume 的章保持原来的卷，volume 传空串等于把这一章摘到不分卷。",
		parameters: Type.Object(
			{
				volumes: Type.Optional(
					Type.Array(
						Type.Object(
							{
								id: optionalText("已有卷的 id；新卷留空"),
								title: nonEmpty("卷名，例如「卷一 · 黑水汊」"),
								summary: optionalText("卷要略：这一卷大致写什么，2-4 句"),
								targetWords: Type.Optional(Type.Number({ description: "卷目标字数" })),
							},
							{ description: "卷条目" },
						),
						{ description: "卷的设置。不传就不动已有的卷；作者不打算分卷时整项省略即可" },
					),
				),
				chapters: Type.Array(
					Type.Object(
						{
							id: nonEmpty("章节 id，稳定且唯一，后续手动续写必须用它"),
							title: nonEmpty("标题"),
							summary: nonEmpty("本章要点，2-4 句"),
							pov: optionalText("视角人物"),
							volume: optionalText(
								"所属卷的卷名（与 volumes 里的 title 一致）。不传保持原样，传空串表示不分卷",
							),
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
				// 先立卷：章上的 volume 写的是卷名，得先有这一卷才挂得上。
				for (const item of params.volumes ?? []) {
					const title = item.title.trim();
					if (!title) continue;
					const target = item.id
						? p.volumes.find((volume) => volume.id === item.id)
						: p.volumes.find((volume) => volume.title.trim() === title);
					if (target) {
						target.title = title;
						if (typeof item.summary === "string") target.summary = item.summary;
						if (typeof item.targetWords === "number" && item.targetWords >= 0) {
							target.targetWords = Math.floor(item.targetWords);
						}
						continue;
					}
					p.volumes.push({
						id: item.id && !p.volumes.some((volume) => volume.id === item.id) ? item.id : nextVolumeId(p),
						title,
						summary: item.summary ?? "",
						targetWords:
							typeof item.targetWords === "number" && item.targetWords > 0 ? Math.floor(item.targetWords) : 0,
						notes: "",
					});
				}
				// 卷名 → 卷 id。改卷名之后不必另建，这张表在挂章前重建。
				const byTitle = new Map(p.volumes.map((volume) => [volume.title.trim(), volume.id] as const));
				const volumeForTitle = (title: string): string => {
					const key = title.trim();
					if (!key) return "";
					const hit = byTitle.get(key);
					if (hit) return hit;
					// 章上写了个没立过的卷名：顺手立一卷，别让这条信息掉在地上。
					const id = nextVolumeId(p);
					p.volumes.push({ id, title: key, summary: "", targetWords: 0, notes: "" });
					byTitle.set(key, id);
					return id;
				};
				for (const chapter of params.chapters) {
					const volumeId = typeof chapter.volume === "string" ? volumeForTitle(chapter.volume) : undefined;
					const index = p.outline.findIndex((item) => item.id === chapter.id);
					if (index >= 0) {
						const merged = {
							...p.outline[index]!,
							id: chapter.id,
							title: chapter.title,
							summary: chapter.summary,
							...(chapter.pov !== undefined ? { pov: chapter.pov } : {}),
							...(chapter.status !== undefined ? { status: chapter.status } : {}),
							...(chapter.targetWords !== undefined ? { targetWords: chapter.targetWords } : {}),
							...(chapter.notes !== undefined ? { notes: chapter.notes } : {}),
						};
						// 只有显式传了 chapterIds 才动装配清单：
						// 改个标题不该把这一章的料抖掉。
						if (chapter.chapterIds) merged.materialIds = chapter.chapterIds.filter((id) => known.has(id));
						// 卷同理：不传就保持原样。
						if (volumeId !== undefined) merged.volumeId = volumeId;
						p.outline[index] = merged;
					} else {
						p.outline.push({
							id: chapter.id,
							title: chapter.title,
							summary: chapter.summary,
							pov: chapter.pov ?? "",
							status: (chapter.status ?? "planned") as never,
							targetWords: chapter.targetWords ?? 0,
							notes: chapter.notes ?? "",
							volumeId: volumeId ?? "",
							materialIds: (chapter.chapterIds ?? []).filter((id) => known.has(id)),
						});
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
			await deps.store.flushForProject(deps.projectId);
			// 把被丢弃的 id 报回去。静默过滤会让模型以为装料成功了，
			// 下一步才发现这一章没料可写，却不知道是哪个 id 写错了。
			const requested = (params.chapters ?? []).flatMap((c) => c.chapterIds ?? []);
			const missing = requested.filter((id) => !known.has(id));
			const volumeName = new Map(saved.volumes.map((volume) => [volume.id, volume.title] as const));
			return result(
				"大纲已更新，共 " + saved.outline.length + " 章" +
					(saved.volumes.length > 0 ? "、" + saved.volumes.length + " 卷" : "") + "：\n" +
					lines(
						saved.outline.map((c) => {
							const volume = c.volumeId ? volumeName.get(c.volumeId) : "";
							return (
								"[" + c.id + "] " + (volume ? "〔" + volume + "〕" : "") + c.title +
								"（" + c.status + "）装料" + c.materialIds.length + "条"
							);
						}),
					) +
					(missing.length > 0 ? "\n\n以下素材 id 不存在，未装入（先 upsert_material 确认 id）：" + missing.join("、") : ""),
				{ outline: saved.outline, volumes: saved.volumes },
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
				kind: Type.Optional(materialKindSchema()),
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
			const id = params.id?.trim() || newId();
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
			await deps.store.flushForProject(deps.projectId);
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
			await deps.store.flushForProject(deps.projectId);
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
		...(deps.webSearch?.config.enabled ? createWebSearchTools(deps.webSearch.client, deps.webSearch.config) : []),
	];
}

// ═══════════════════════════════════════════════════════════ 组装智能体专用

interface ChapterWriteInput {
	chapterId: string;
	title: string;
	content: string;
	mode: "create" | "rewrite" | "continue" | "append";
	materialIds?: string[];
	summary?: string;
}

/** 在章节锁内读、拼、算摘要并一次保存，避免 continue 与 append 互相覆盖。 */
async function writeChapter(deps: NovelToolDeps, params: ChapterWriteInput): Promise<AgentToolResult<unknown>> {
	assertWritableChapter(deps, params.chapterId);
	const project = getProject(deps);
	if (!project.outline.some((chapter) => chapter.id === params.chapterId)) {
		throw new Error("章节 " + params.chapterId + " 不在本章目里，不能凭空写入；请先立章或改用已有章节 id。");
	}
	let dropped: string[] = [];
	let autoSummary = false;
	const written = await deps.store.withChapterLock(deps.projectId, params.chapterId, async () => {
		const p = getProject(deps);
		const existing = p.drafts[params.chapterId];
		const oldBody = await deps.store.readDraftBody(deps.projectId, params.chapterId);
		const oldContent = oldBody?.content ?? "";
		if (params.mode === "create" && oldContent.trim()) {
			throw new Error("create 只能用于没有旧稿的章节；《" + params.title + "》已有正文，请改用 rewrite、continue 或 append_chapter。");
		}
		const content = params.mode === "continue" || params.mode === "append"
			? appendContent(oldContent, params.content)
			: params.content;
		const changed = oldContent.trim() !== content.trim();
		autoSummary = changed && !params.summary?.trim();
		const requestedMaterials = params.materialIds ?? existing?.materialIds ?? p.outline.find((chapter) => chapter.id === params.chapterId)?.materialIds ?? [];
		const filtered = knownMaterialIds(p, requestedMaterials);
		dropped = filtered.dropped;
		const meta = await deps.store.saveDraftBody(deps.projectId, params.chapterId, {
			title: params.title,
			content,
			summary: params.summary?.trim() || (autoSummary ? automaticSummary(content) : existing?.summary),
			materialIds: filtered.ids,
			mode: params.mode,
			keepHistory: true,
		});
		const outlineMeta = p.outline.find((chapter) => chapter.id === params.chapterId);
		if (outlineMeta && (outlineMeta.status === "planned" || outlineMeta.status === "outlined")) {
			deps.store.mutate(deps.projectId, (draft) => {
				const target = draft.outline.find((chapter) => chapter.id === params.chapterId);
				if (target && (target.status === "planned" || target.status === "outlined")) target.status = "drafted";
			});
		}
		await deps.store.flushForProject(deps.projectId);
		return meta;
	});
	const summaryNote = autoSummary
		? "未交新小结且正文已改变，已生成自动尾部摘要，避免沿用旧小结。"
		: "小结已记下，下一章靠它接续。";
	return result(
		"已写入《" + written.title + "》：第 " + written.revision + " 版，" + written.words + " 字（" + params.mode + "）。" + summaryNote +
			(dropped.length > 0 ? "\n以下素材 id 不在已装集合中，已丢弃：" + dropped.join("、") : ""),
		{ ...written, droppedMaterialIds: dropped, automaticSummary: autoSummary },
	);
}

function chapterWriteFields() {
	return {
		chapterId: nonEmpty("章节 id"),
		title: nonEmpty("章节标题"),
		content: nonEmpty("create/rewrite 为全章正文；continue/append 只写新增内容"),
		materialIds: Type.Optional(stringArray("本次实际用到的素材 id，只能是已装集合中的真实 id")),
		summary: Type.Optional(Type.String({ description: "实际内容的 2-4 句小结；正文改变但不传时生成明确标记的自动摘要" })),
	};
}

function writeChapterTool(deps: NovelToolDeps): AgentTool<any> {
	return defineTool({
		name: "write_chapter",
		label: "写入或续写章节",
		description:
			"create 从零写全章，已有非空旧稿时拒绝；rewrite 用全章覆盖旧稿；continue 只交新增内容，由工具读取旧稿并安全拼接。" +
			"分段续写优先用 append_chapter。materialIds 如实填写实际使用且已装配的真实素材 id。",
		parameters: Type.Object(
			{
				...chapterWriteFields(),
				mode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("rewrite"), Type.Literal("continue")], {
					description: "create 新建、rewrite 覆盖、continue 增量续写；默认 create",
				})),
			},
			{ description: "写入或续写章节" },
		),
		execute: async (_toolCallId, params) => writeChapter(deps, { ...params, mode: params.mode ?? "create" }),
	});
}

function appendChapterTool(deps: NovelToolDeps): AgentTool<any> {
	return defineTool({
		name: "append_chapter",
		label: "追加章节正文",
		description: "只提交新增正文；工具在章节写锁内读取旧稿并拼接，不要求也不应重复提交旧稿。适合长章分段生成。",
		parameters: Type.Object(chapterWriteFields(), { description: "追加章节正文" }),
		execute: async (_toolCallId, params) => writeChapter(deps, { ...params, mode: "append" }),
	});
}

/**
 * 改一段：在现有正文里换掉一处原文。
 *
 * 整章重写的代价与风险都不对等：作者只嫌一句冷，模型却要重交全章，
 * 一次手滑就是整章截断。局部修改让"改动量"对上"交代量"。
 *
 * 定位用逐字原文，不用行号也不用模糊匹配：正文里"她笑了笑"可能出现好几处，
 * 指错地方比不改更糟。宁可让它报错重来 —— 报错时模型手里就有 read_chapter
 * 给的原文，重试一次就对上了。
 */
function reviseChapterTool(deps: NovelToolDeps): AgentTool<any> {
	return defineTool({
		name: "revise_chapter",
		label: "改写章节里的一段",
		description:
			"把章节正文里的一处原文换成新写法，其余一字不动。只改作者点名的那几处时用它，" +
			"不要用 write_chapter 整章覆盖。" +
			"find 必须与 read_chapter 返回的正文逐字一致（含标点、空格、换行），而且要能在正文里唯一定位 —— " +
			"同一段话出现多次时，前后各多带一句。replace 是替换成的新文字，留空字符串表示删掉这一段。" +
			"每改一处调用一次；改完把改了哪几处告诉作者即可，不必复述全文。",
		parameters: Type.Object(
			{
				chapterId: nonEmpty("章节 id"),
				find: nonEmpty("要被替换掉的原文：逐字复制 read_chapter 返回的那一段，含标点"),
				replace: Type.String({ description: "换成什么。留空字符串表示删掉这一段" }),
				summary: Type.Optional(
					Type.String({
						description: "改过之后这一章实际讲了什么（2-4 句）。小幅修改留空沿用旧小结，大幅修改留空生成自动摘要。",
					}),
				),
			},
			{ description: "局部修改章节" },
		),
		execute: async (_toolCallId, params) => {
			assertWritableChapter(deps, params.chapterId);
			const project = getProject(deps);
			const planned = project.outline.find((chapter) => chapter.id === params.chapterId);
			if (!planned) {
				throw new Error(
					"章节 " + params.chapterId + " 不在本章目里，不能凭空改；先用 list_chapters 确认 id。",
				);
			}
			const meta = project.drafts[params.chapterId];
			if (!meta) {
				return result(
					"《" + planned.title + "》还没有正文，没有可改的原文；从零写起请用 write_chapter。",
				);
			}
			const find = params.find;
			// 加锁：改正文与整章写入走同一把锁，不然两次改动会互相覆盖。
			const revised = await deps.store.withChapterLock(deps.projectId, params.chapterId, async () => {
				const body = await deps.store.readDraftBody(deps.projectId, params.chapterId);
				const content = body?.content ?? "";
				const at = content.indexOf(find);
				if (at < 0) {
					throw new Error(
						"正文里找不到这段原文，没改。把 read_chapter 读到的原文逐字复制进 find（标点、空格、换行都要一致）再试一次；" +
							"要改的那段没读全，就带上它前后各一句。",
					);
				}
				if (content.indexOf(find, at + find.length) >= 0) {
					throw new Error(
						"这段原文在正文里不止一处，指不准该改哪儿，没改。前后各多带一句让它唯一，再试一次。",
					);
				}
				const next = content.slice(0, at) + params.replace + content.slice(at + find.length);
				return deps.store.saveDraftBody(deps.projectId, params.chapterId, {
					title: meta.title,
					content: next,
					// 局部修改通常不改变全章脉络，旧小结仍可用；删除或替换大片正文时用自动摘要更诚实。
					summary: params.summary?.trim() || (Math.min(find.length, params.replace.length) >= 120 ? automaticSummary(next) : meta.summary),
					materialIds: meta.materialIds,
					mode: "patch",
					keepHistory: true,
				});
			});
			await deps.store.flushForProject(deps.projectId);
			const delta = params.replace.length - find.length;
			return result(
				"已改《" + revised.title + "》：第 " + revised.revision + " 版，" + revised.words + " 字。" +
					"这次换掉 " + find.length + " 字、补进 " + params.replace.length + " 字（" +
					(delta >= 0 ? "+" : "") + delta + " 字），其余一字未动。还有别处要改就继续调用。",
				{ ...revised, find, replace: params.replace },
			);
		},
	});
}

/**
 * 组装智能体的工具集。
 *
 * 三个写入工具各管一件事：write_chapter 新建/覆盖/续写，append_chapter 追加增量，revise_chapter 只换点名的几段。
 * 素材只能读不能改 —— 料由素材智能体负责。
 */
export function createWritingTools(deps: NovelToolDeps): AgentTool<any>[] {
	return [
		...sharedTools(deps),
		writeChapterTool(deps),
		appendChapterTool(deps),
		reviseChapterTool(deps),
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
	/**
	 * 提问通道。给了才有 ask_user 工具 ——
	 * 给模型一个问不出去的工具，比不给更糟。
	 */
	ask?: AskBroker;
}

/** 库条目的一行摘要。与作品素材同格式，但不带"已装入"——库里没有章节。 */
function libraryLine(entry: LibraryMaterial): string {
	const head = "[" + kindLabel(entry.kind) + "] " + entry.title + "（id: " + entry.id + "）";
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
					kind: Type.Optional(materialKindSchema()),
					title: optionalText("标题。新建必填，更新时可省"),
					content: optionalText("素材内容：只写事实、约束与边界，一行一个事实，务必精减。新建必填，更新时可省"),
					usage: optionalText("装配提示：什么情况下该用这条素材。新建必填，更新时可省"),
					tags: Type.Optional(stringArray("标签、别名")),
				},
				{ description: "通用素材条目" },
			),
			execute: async (_toolCallId, params) => {
				const id = params.id?.trim() || newId();
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
				await deps.library.flush();
				return result(
					(existing ? "已更新通用素材《" : "已新建通用素材《") + saved.title + "》（id: " + saved.id + "）。" +
						"作者可在任意作品里取用它。",
					saved,
				);
			},
		}),

		// 库作用域同样可以问作者 —— 提示词里也放行了这一支。
		...(deps.ask ? [askUserTool(deps.ask)] : []),
	];
}

function emptyLibraryMaterial(id: string, kind: MaterialKind): LibraryMaterial {
	const now = Date.now();
	return { id, kind, title: "", content: "", tags: [], usage: "", status: "draft", createdAt: now, updatedAt: now };
}
