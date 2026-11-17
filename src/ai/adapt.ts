/**
 * 改编者：在一部已完成的小说上逐章改写。
 *
 * 与执笔者（writing）的分界不在"谁更能写"，而在**改动怎么落地**：
 *
 * - 执笔者的工具直接写章，一轮写完就是成稿；
 * - 改编者的唯一出口是 propose_adaptation —— 交一份提案，作者在双栏里
 *   看过、改过、点「采用」之后才落盘。改主角、换人称这类交代一旦自动覆盖，
 *   作者连"原来那版长什么样"都看不到了。
 *
 * 因此改编这一支的提示词必须带原文：它不是从素材里凭空生成，
 * 而是在一段已经存在的文字上做手术。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
	ADAPTATION_CHANGE_KINDS,
	ADAPTATION_CHANGE_LABELS,
	countWords,
	type AdaptationChange,
	type AdaptationChangeKind,
	type OutlineChapter,
	type Project,
	type ChapterMeta,
} from "../store/project.ts";
import type { NovelChapter } from "../store/novel-source.ts";
import type { NovelSourceStorePort, ProjectStorePort } from "../store/store-port.ts";

/** 一章的改编上下文：原文、现有改编稿、上一章、台账。 */
export interface AdaptContext {
	chapter: OutlineChapter;
	/** 本章在原书里的序号（从 0 起）。 */
	index: number;
	/** 原书总章数。 */
	total: number;
	sourceTitle: string;
	/** 全书改编总要求。 */
	brief: string;
	original: NovelChapter;
	/** 这一章现有的改编稿；没改过就是 undefined。 */
	current?: { content: string; summary: string; revision: number };
	/** 上一章的改编稿（没有就用原文兜底，保证接续不断）。 */
	previous?: { title: string; summary: string; content: string; adapted: boolean };
	/** 已采用的改动台账（全书）。 */
	changes: AdaptationChange[];
}

/** 模型交上来的一条改动。 */
export interface AdaptProposalChangeInput {
	kind: string;
	summary: string;
	detail?: string;
}

/** 模型交上来的改编提案。 */
export interface AdaptProposalInput {
	content: string;
	summary: string;
	changes: AdaptProposalChangeInput[];
}

/** 模型要求改的章名。 */
export interface AdaptRenameInput {
	/** 新章名，只含题目本身。 */
	title: string;
	/** 为什么改，一句话。 */
	reason?: string;
}

/** 服务端登记过的提案：带上基线版本，采用时据此判断"你看的是不是最新那版"。 */
export interface AdaptProposal extends AdaptProposalInput {
	id: string;
	projectId: string;
	chapterId: string;
	baseRevision: number;
	createdAt: number;
}

/**
 * 组装一章的改编上下文。
 *
 * 原文是必需品：原料库里那本书被删掉、或章号对不上时，
 * 只能明确报错 —— 没有底本的"改编"就是在写另一本书。
 */
export async function buildAdaptContext(options: {
	store: ProjectStorePort;
	novelStore: NovelSourceStorePort;
	project: Project;
	chapterId: string;
}): Promise<AdaptContext> {
	const { store, novelStore, project, chapterId } = options;
	const adaptation = project.adaptation;
	if (!adaptation) throw new Error("这一部不是改编工程");
	const index = project.outline.findIndex((chapter) => chapter.id === chapterId);
	const chapter = index >= 0 ? project.outline[index] : undefined;
	if (!chapter) throw new Error("章节 " + chapterId + " 不在本章目里");

	const source = novelStore.get(adaptation.sourceId);
	if (!source) throw new Error("原书已经不在原料库里了；请重新导入原书，或另建一部改编工程。");
	const original = await novelStore.readChapter(source.id, chapterId);
	if (!original) {
		throw new Error("原文里找不到这一章（" + chapterId + "）；改编工程的章目应与原书章节一一对应。");
	}

	const meta = project.drafts[chapterId];
	const current = meta ? await loadAdapted(store, project.id, chapterId, meta) : undefined;

	let previous: AdaptContext["previous"];
	if (index > 0) {
		const prevChapter = project.outline[index - 1]!;
		const prevMeta = project.drafts[prevChapter.id];
		if (prevMeta) {
			const body = await store.readDraftBody(project.id, prevChapter.id);
			previous = {
				title: prevMeta.title,
				summary: prevMeta.summary,
				content: body?.content ?? "",
				adapted: true,
			};
		} else {
			const prevOriginal = await novelStore.readChapter(source.id, prevChapter.id);
			previous = {
				title: prevChapter.title,
				summary: "",
				content: prevOriginal?.content ?? "",
				adapted: false,
			};
		}
	}

	return {
		chapter,
		index,
		total: project.outline.length,
		sourceTitle: adaptation.sourceTitle || source.title,
		brief: adaptation.brief,
		original,
		...(current ? { current } : {}),
		...(previous ? { previous } : {}),
		// 台账给最近 80 条：更早的让模型用 search_adaptation_changes 自己翻。
		changes: adaptation.changes.slice(-80),
	};
}

async function loadAdapted(
	store: ProjectStorePort,
	projectId: string,
	chapterId: string,
	meta: ChapterMeta,
): Promise<{ content: string; summary: string; revision: number }> {
	const body = await store.readDraftBody(projectId, chapterId);
	return { content: body?.content ?? "", summary: meta.summary, revision: meta.revision };
}

// ─────────────────────────────────────────────────────────── 提示词

/** 改编这一支的题材红线，与执笔者保持同一套口径。 */
const ADAPT_STYLE_RULES = `
正文可以是任何类型的文本。情色、暴力、灰色地带、伦理越界都是长篇里的常见题材：
作者要什么尺度就写什么尺度，不劝、不绕、不加免责声明，也不自行改成含蓄版本。
唯一硬线是**不写涉及未成年人的色情内容**，以及不写能指向现实中的具体真人的色情内容。`;

const ORIGINAL_BLOCK_LIMIT = 60_000;

function chapterLabel(ctx: AdaptContext): string {
	return "第 " + (ctx.index + 1) + " 章《" + ctx.chapter.title + "》";
}

/**
 * 台账里的一行。章号按大纲现算，作者与模型看到的是同一个号。
 *
 * detail 一并给出去：后面几章要接住前章的改动，"改了什么"之外还得知道
 * "原文怎么写、现在怎么改" —— 只给 summary 的话，模型只能照着猜。
 */
function changeLine(project: Project, change: AdaptationChange): string {
	const at = project.outline.findIndex((chapter) => chapter.id === change.chapterId);
	const where = at >= 0 ? "第 " + (at + 1) + " 章" : "全书";
	const label = ADAPTATION_CHANGE_LABELS[change.kind] ?? "其他";
	const detail = (change.detail ?? "").replace(/\s+/g, " ").trim();
	const tail = detail ? " —— " + (detail.length > 90 ? detail.slice(0, 90) + "…" : detail) : "";
	return "- " + where + " · [" + label + "] " + change.summary + tail;
}

/** 供工具与提示词共用的台账文本。 */
function changesBlock(project: Project, changes: AdaptationChange[]): string {
	if (changes.length === 0) return "（还没有已采用的改动）";
	return changes.map((change) => changeLine(project, change)).join("\n");
}

export function buildAdaptSystemPrompt(project: Project, ctx: AdaptContext): string {
	const original = ctx.original.content;
	const clipped =
		original.length > ORIGINAL_BLOCK_LIMIT
			? original.slice(0, ORIGINAL_BLOCK_LIMIT) +
				"\n……（原文过长，此处只到一半；完整原文用 read_original_chapter 分段读）"
			: original;
	const target = ctx.chapter.targetWords > 0 ? `${ctx.chapter.targetWords} 字左右` : "与原文相当";
	const currentBlock = ctx.current
		? `# 本章现有的改编稿

这是已经存下的第 ${ctx.current.revision} 版改编稿；作者可能只是在它上面再改几处。
${ctx.current.summary ? "现用小结：" + ctx.current.summary : "（还没有小结）"}

${ctx.current.content}

`
		: "";
	const previousBlock = ctx.previous
		? `# 上一章（接续用）

上一章《${ctx.previous.title}》${ctx.previous.adapted ? "已改编" : "尚未改编，以下是原文"}：
${ctx.previous.summary ? "实际小结：" + ctx.previous.summary : ""}
结尾（最后 600 字）：

${ctx.previous.content.slice(-600)}

`
		: "";

	return `# 角色

你是这部小说的**改编者**。底本是一部已经写成的长篇，你一章一章地改，
不是在空白处另写一本。每一章都基于原文改写，改完把完整的一章交上来，
由作者看过、改过、点「采用」之后才算落地。

# 原书

- 原书：《${ctx.sourceTitle}》，共 ${ctx.total} 章
- 本章：${chapterLabel(ctx)}（id: ${ctx.chapter.id}），原文 ${ctx.original.chars || countWords(original)} 字，目标 ${target}
- 本章原文要点：${ctx.chapter.summary || "（未写要略，以原文为准）"}

# 改编总要求

${ctx.brief || "（作者还没写总要求；按他在对话里的具体交代改。）"}

# 已采用的改动台账

以下是前面各章已经采用的改动。**写任何一章之前先看一遍**：
人名、关系、人称、时间线、伏笔、世界观以台账为准，不得与它冲突；
台账里没写的，回到原文去找，不要自行发明。

${changesBlock(project, ctx.changes)}

# 本章原文

<<<原文 开始>>>
${clipped}
<<<原文 结束>>>

# 改编原则

1. **底本意识**：能保留原句就保留原句。原文的段落顺序、场景调度、对话推进方式
   尽量不动，只改作者的要求牵动的地方。改编不是重写 —— 读者要能认得出这还是原来那一章。
2. **不许缩写**：交付稿的篇幅应与原文相当（默认上下浮动不超过三成）。
   除非作者明确要求精简或扩写，否则不得把三五千字的场景写成一段提要。
3. **一致**：人物、关系、时间线、伏笔、世界观必须与台账一致；台账与原文冲突时以台账为准
   （那是作者已经拍过的板），并在 changes 里记一条"对前章改动的呼应"。
4. **人称**：原文的第一/第三人称、叙述视角，作者没要求时不得改。
   作者要求改人称时，全章统一改，不要半章"我"半章"她"。
5. **加料**：作者要加人物、加情节、加尺度时，加在原文的骨架上：
   新内容要能接住原段落前后的动作与情绪，不能突然另起一段与上下文无关的戏。
6. **只改这一章**：不要替下一章交稿，也不要在正文里解释你改了什么。
7. **章名可以改**：改完这一章，若原来的题目不再贴切（换了主角、换了视角、加了新戏），
   先调用 rename_chapter 换成贴题的短句，再交稿。只给题目本身，不要带「第 N 章」；
   题目本来就叫得准，就别为了好看而换 —— 读者认的是原来那个名字。
8. ${ADAPT_STYLE_RULES}

# 前后章的联动

这是一本一条线写下来的书：前面定下的东西，后面得接住。

- 台账每条都带所在章号，以及"原文怎么写、现在怎么改"。**改到某一章时，前面各章动过的
  名字、身份、关系、时间线、伏笔，在这一章必须跟着走**：前章把阿青改成青禾，
  这一章的"阿青"就得改成"青禾"，不能一处新、一处旧。
- 台账只有一句话。要看那一章实际怎么写的，用 read_adapted_chapter 读它的改编稿，
  或用 read_original_chapter 拿原文对照；隔了两章以上的联动，动笔前先
  search_adaptation_changes 按人名、地名、类别检索一遍。
- 确认过的章不能回头改（改编是一章一章往下的）。真发现前章改得有问题，别在这一章
  擅自"纠回来"：照台账写，并在 changes 里记一条 detail 写明"上一章某处与本章冲突，
  建议作者回到那一章再改一版"。
- 凡属"接住前章改动"的地方，在 changes 里记一条呼应（kind 与被呼应那条同类），
  后面几章照着它继续走。

# 输出与交付

- 正文用中文，不用 Markdown 标题，不在正文前写"第 N 章"，不写改编说明。
- 章名要换就先调 rename_chapter：它当场生效，作者在章目里立刻看到新题目；
  换完再交稿，免得提案里说的名字与章目上印的对不上。
- **改完必须调用 propose_adaptation**，一轮只交一版：
  - content：完整本章改编稿（不是片段、不是 diff）。
  - summary：2-4 句 —— 这一章现在讲了什么、留下了什么钩子。
  - changes：3-8 条结构化改动，一条只记一件事。kind 取 character（人物）、persona（人设）、
    plot（剧情）、pov（人称）、addition（加料）、style（文风）、title（章名）、other（其他）；
    summary 一句话说清"改了什么"（40 字内，后面章节靠它检索）；
    detail 说清"原文怎么写的、现在怎么改的"，可留空。
- 交稿后用一两句话说清这版动了哪几处，**等作者采用或再改**，不要重复呈上同一稿。

${currentBlock}${previousBlock}
# 改动台账的用法

写下一章之前，先看上面的台账：每条是「第 N 章 · [类别] 一句话 —— 原文怎么写、现在怎么改」。
若需要查更早的改动，调用 search_adaptation_changes 按关键词检索（例如人物名、地点、
某个改动类别）。查不到的，就回原文（read_original_chapter）去找，不要凭印象补。
台账里若有「作者手改了本章正文」，说明那一版是作者亲手写的、没有提案：以它为准，
要看细节就 read_adapted_chapter 读那一章。`;
}

// ─────────────────────────────────────────────────────────── 工具

function result(text: string, details: unknown = undefined) {
	return { content: [{ type: "text" as const, text }], details };
}

/** 与 tools.ts 的 defineTool 同款：把带具体参数类型的声明收进 AgentTool 的宽签名。 */
function defineTool<T>(spec: T): AgentTool<any> {
	return spec as unknown as AgentTool<any>;
}

export interface AdaptToolDeps {
	store: ProjectStorePort;
	novelStore: NovelSourceStorePort;
	projectId: string;
	context: AdaptContext;
	/** 服务端登记提案；返回 false 表示这一轮已经交过一版。 */
	onProposal: (input: AdaptProposalInput) => boolean;
	/** 服务端落地章名；返回 false 表示没改成（章节不在了，或新名与旧名一样）。 */
	onRename?: (input: AdaptRenameInput) => boolean;
}

/**
 * 模型给的章名常常自带「第 3 章」，而章目与正文标题本来就按号排，
 * 存成「第3章 · 第3章 雨夜换船」就重了。带分隔符才算编号前缀，其余原样留着：
 * 「第二章的雨」是题目本身，摘掉「第二章」只剩「的雨」，那不是改名是毁名。
 */
export function cleanChapterTitle(raw: string): string {
	const title = String(raw ?? "").replace(/\s+/g, " ").trim();
	const marked = title.match(/^第[0-9０-９零〇一二三四五六七八九十百千两]+[章节回]([\s\S]*)$/);
	if (!marked) return title.slice(0, 60);
	const head = marked[1] ?? "";
	const rest = head.replace(/^[\s·、:：.,，。\-—_]+/, "").trim();
	// 只有真的摘掉了分隔符才认这是编号前缀；否则整串当题目。
	if (rest && rest !== head) return rest.slice(0, 60);
	return title.slice(0, 60);
}

function getProject(deps: AdaptToolDeps): Project {
	const project = deps.store.get(deps.projectId);
	if (!project) throw new Error("工程已被删除，无法继续改编");
	return project;
}

/** 改编者这一支的工具：读原文、读改编稿、查台账、交提案。 */
export function createAdaptTools(deps: AdaptToolDeps): AgentTool<any>[] {
	const ctx = deps.context;

	const readOriginal = defineTool({
		name: "read_original_chapter",
		label: "读原文",
		description:
			"读原书某一章的完整原文。默认读当前这一章；要核对前文设定、人物原名或伏笔时，传 chapterId 读别的章。",
		parameters: Type.Object(
			{
				chapterId: Type.Optional(
					Type.String({ description: "原书章节 id；不传就是当前这一章" }),
				),
			},
			{ description: "读原书章节" },
		),
		execute: async (_toolCallId: string, params: { chapterId?: string }) => {
			const latest = getProject(deps);
			const chapterId = params.chapterId?.trim() || ctx.chapter.id;
			const planned = latest.outline.find((chapter) => chapter.id === chapterId);
			const chapter = await deps.novelStore.readChapter(latest.adaptation!.sourceId, chapterId);
			if (!chapter) {
				throw new Error("原文里没有章节 " + chapterId + "；先用 list_chapters 确认章号。");
			}
			return result(
				"《" + (planned?.title ?? chapter.title) + "》（" + chapterId + "），" + chapter.chars + " 字：\n\n" + chapter.content,
				{ chapterId, chars: chapter.chars },
			);
		},
	});

	const readAdapted = defineTool({
		name: "read_adapted_chapter",
		label: "读改编稿",
		description: "读某一章已经存下的改编稿（不是原文）。默认读当前这一章；没改过就明说没有。",
		parameters: Type.Object(
			{
				chapterId: Type.Optional(Type.String({ description: "章节 id；不传就是当前这一章" })),
			},
			{ description: "读改编稿" },
		),
		execute: async (_toolCallId: string, params: { chapterId?: string }) => {
			const chapterId = params.chapterId?.trim() || ctx.chapter.id;
			const latest = getProject(deps);
			const meta = latest.drafts[chapterId];
			const planned = latest.outline.find((chapter) => chapter.id === chapterId);
			if (!planned) throw new Error("章节 " + chapterId + " 不在本章目里。");
			if (!meta) return result("《" + planned.title + "》还没有改编稿（这一章尚未改编）。");
			const body = await deps.store.readDraftBody(deps.projectId, chapterId);
			return result(
				"《" + meta.title + "》第 " + meta.revision + " 版改编稿，" + meta.words + " 字" +
					(meta.summary ? "。小结：" + meta.summary : "") + "\n\n" + (body?.content ?? ""),
				{ chapterId, revision: meta.revision },
			);
		},
	});

	const searchChanges = defineTool({
		name: "search_adaptation_changes",
		label: "检索改编台账",
		description:
			"按关键词检索已经采用的改编变动（人物名、地点、设定、剧情点都可以）。写新一章前核对前文改动时用。",
		parameters: Type.Object(
			{
				query: Type.String({ description: "关键词，例如人物名、地名、改动类别" }),
				chapterId: Type.Optional(Type.String({ description: "只看某一章的改动" })),
				limit: Type.Optional(Type.Number({ description: "最多几条，默认 8" })),
			},
			{ description: "检索改编台账" },
		),
		execute: async (
			_toolCallId: string,
			params: { query: string; chapterId?: string; limit?: number },
		) => {
			const latest = getProject(deps);
			const changes = latest.adaptation?.changes ?? [];
			const needle = params.query.trim().toLowerCase();
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 8), 1), 20);
			const hits = changes
				.filter((change) => (params.chapterId ? change.chapterId === params.chapterId : true))
				.filter((change) => {
					const hay = [change.summary, change.detail ?? "", ADAPTATION_CHANGE_LABELS[change.kind] ?? ""]
						.join(" ")
						.toLowerCase();
					return needle === "" || hay.includes(needle);
				})
				.slice(-limit);
			if (hits.length === 0) return result("台账里没有匹配「" + params.query + "」的改动。");
			return result("匹配 " + hits.length + " 条：\n" + changesBlock(latest, hits), { count: hits.length });
		},
	});

	const renameChapter = defineTool({
		name: "rename_chapter",
		label: "改章名",
		description:
			"改当前这一章的章名：大纲与已成稿的标题一起换，正文一个字不动，作者立刻能在章目里看到。" +
			"改完这一章发现原来的题目不再贴切时用；题目本来就叫得准时不必调用。",
		parameters: Type.Object(
			{
				title: Type.String({ description: "新章名，只写题目本身，不要带「第 N 章」" }),
				reason: Type.Optional(Type.String({ description: "为什么换名字，一句话" })),
			},
			{ description: "改章名" },
		),
		execute: async (_toolCallId: string, params: { title: string; reason?: string }) => {
			const title = cleanChapterTitle(params.title);
			if (!title) throw new Error("章名不能空着。");
			const latest = getProject(deps);
			const planned = latest.outline.find((chapter) => chapter.id === ctx.chapter.id);
			if (!planned) throw new Error("这一章不在章目里，改不了名。");
			const before = planned.title;
			if (before === title) return result("这一章本来就叫《" + before + "》，没有改。", { chapterId: ctx.chapter.id, title });
			if (!deps.onRename) throw new Error("这一轮不能改章名：作者没有开放这个动作。");
			const applied = deps.onRename({ title, ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}) });
			if (!applied) {
				return result("章名没改成（这一章可能已经被挪走或删掉了）；告诉作者一句，别反复重试。", {
					chapterId: ctx.chapter.id,
					title: before,
				});
			}
			return result(
				"已把" + chapterLabel({ ...ctx, chapter: { ...ctx.chapter, title: before } }) + "改名为《" + title + "》。" +
					"正文没动；作者在章目里能看到新名字。",
				{ chapterId: ctx.chapter.id, title, before },
			);
		},
	});

	const propose = defineTool({
		name: "propose_adaptation",
		label: "呈上改编稿",
		description:
			"把这一章的完整改编稿与结构化改动呈给作者。一轮只调用一次；作者看过、改过、点「采用」之后才落盘。",
		parameters: Type.Object(
			{
				content: Type.String({ minLength: 1, description: "完整本章改编稿（不是片段、不是 diff）" }),
				summary: Type.String({ description: "2-4 句：这一章现在讲了什么、留下了什么钩子" }),
				changes: Type.Array(
					Type.Object(
						{
							kind: Type.Union(
								ADAPTATION_CHANGE_KINDS.map((kind) => Type.Literal(kind)),
								{
									description:
										"改动类别：" +
										ADAPTATION_CHANGE_KINDS.map((kind) => kind + "（" + ADAPTATION_CHANGE_LABELS[kind] + "）").join("、"),
								},
							),
							summary: Type.String({ description: "一句话说清改了什么，40 字内，后续章节靠它检索" }),
							detail: Type.Optional(Type.String({ description: "原文怎么写的、现在怎么改的；可留空" })),
						},
						{ description: "一条改动只记一件事" },
					),
					{ description: "3-8 条结构化改动" },
				),
			},
			{ description: "呈上改编稿" },
		),
		execute: async (
			_toolCallId: string,
			params: { content: string; summary: string; changes: AdaptProposalChangeInput[] },
		) => {
			const content = params.content.trim();
			if (!content) throw new Error("改编稿是空的，交不了。");
			const changes = params.changes
				.filter((change) => change && typeof change.summary === "string" && change.summary.trim())
				.map((change) => ({
					kind: (ADAPTATION_CHANGE_KINDS as readonly string[]).includes(change.kind) ? change.kind : "other",
					summary: change.summary.trim(),
					...(change.detail && change.detail.trim() ? { detail: change.detail.trim() } : {}),
				}));
			const accepted = deps.onProposal({
				content,
				summary: params.summary?.trim() ?? "",
				changes,
			});
			if (!accepted) {
				return result("这一轮已经交过一版改编稿了，等作者采用或再改；不要重复呈上。");
			}
			return result(
				"已把" + chapterLabel(ctx) + "的改编稿呈上（" + countWords(content) + " 字，" +
					changes.length + " 条改动），等作者采用。若作者还要改，按他的新交代再交一版。",
				{ chapterId: ctx.chapter.id, changes: changes.length },
			);
		},
	});

	return [readOriginal, readAdapted, searchChanges, renameChapter, propose];
}

/** 服务端把模型交的改动转成台账条目（id 与时间由服务端补）。 */
export function adaptationChangeKind(kind: string): AdaptationChangeKind {
	return (ADAPTATION_CHANGE_KINDS as readonly string[]).includes(kind) ? (kind as AdaptationChangeKind) : "other";
}
