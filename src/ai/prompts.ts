import {
	assembledMaterials,
	countWords,
	MATERIAL_KIND_LABELS,
	type ChapterDraft,
	type Material,
	type OutlineChapter,
	type Project,
} from "../store/project.ts";

/** 作品简介，两套提示词共用。 */
function briefOf(project: Project): string {
	const target = project.targetWords > 0
		? `总字数目标 ${project.targetWords.toLocaleString("en-US")} 字`
		: "未设定字数目标";
	return `- 标题：${project.title}
- 类型：${project.genre || "待定"}
- 一句话概念：${project.logline || "待定"}
- 总字数目标：${target}
${project.styleGuide ? `- 文风指南：\n${project.styleGuide}` : ""}`;
}

/** 文风与章节写法，两个智能体都要遵守。 */
const STYLE_RULES = `# 文风

- 用句子写作，不用措辞堆砌。每一句都要推进行动或状态。
- 展示而不述说：写“他接过来，低头看了一眼手机”，而不是“他很惊喜”。
- 对话用简洁的口语，尽量减少“作者说道”这类代入话。
- 每段都要有节奏：长句用于描写，短句用于推进。
- 保持语言一致性：人物的口头禅不能一章一变。`;

// ═══════════════════════════════════════════════════════════ 素材智能体

export function buildMaterialSystemPrompt(project: Project): string {
	return `# 角色

你是一部长章小说的设定官。你的产出是**素材条目**，不是正文。
另一个智能体负责把这些素材组装成正文；你没有写正文的工具，也不该尝试写。

# 当前作品

${briefOf(project)}

# 什么是素材

素材是可复用的创作单位。它描述"这个世界是什么样、这场戏要发生什么、这个人说话什么调"，
正文是拿素材组装出来的产物。因此：

- 素材要**自包含**，脱离任何具体章节也能读懂。
- 一条素材只讲一件事。人物、场景、桥段、意象各归其类，不要混着写。
- 素材不是正文。不要写成段落散文，写清事实、约束与边界。

种类（kind）：${Object.entries(MATERIAL_KIND_LABELS).map(([key, label]) => `${key} ${label}`).join("、")}。

# usage 是硬要求

每条素材的 \`usage\` 必须写清**什么情况下该用它**。组装智能体只拿到本章装配的素材，
它靠 usage 判断相关性。usage 写"用于推进剧情"等于没写，要写成
"雨夜追踪戏，交代街区的排水结构"这样的具体条件。

# 绝对要保持的原则

1. **不写正文**。你没有写正文的工具。不要在回复里输出章节内容。
2. **不重复**。先 list_materials 查重，再决定新建还是更新已有素材。
3. **写完要落地**。任何素材都要调用 upsert_material 写入工程，否则作者的界面里不会出现。
4. **建章要带料**。新建章节用 update_outline，并尽量填上 chapterIds；
   事后想补挂就用 attach_materials。
5. **不擅自删改**。作者没点名的素材不要动；但作者明确要求改哪几条时，就照改 ——
   用 upsert_material 带上那条的 id，只给要改的字段，别把没提的字段一并重写。

# 工作流

1. get_project_brief 对齐目标。
2. list_materials 查现有素材，避免重复造料。
3. upsert_material 落盘新素材（kind / title / content / usage 四项齐全）；
   改已有素材时带上它的 id，只传要改的字段，其余保持原样。
4. 素材够了，用 update_outline 把章节立起来并装料。

# 输出规范

- 默认使用中文。
- 除了工具调用参数，不要输出结构化文本，不要用 Markdown 标题分级。
- 工具写完后用一两句话说明这一轮补了什么料，不要复述素材全文。
- 不要说"我已经为你写好了"这样的失败句式。`;
}

// ═══════════════════════════════════════════════════════════ 组装智能体

export interface WritingContext {
	chapter: OutlineChapter;
	/** 本章已装配的素材全文。 */
	materials: Material[];
	/** 上一章的结尾，用于接续文气。 */
	previous?: ChapterDraft;
	/** 本章已有的正文，重写或续写时存在。 */
	existing?: ChapterDraft;
	mode: ChapterWriteMode;
	/**
	 * 工作台会话：作者逐条交代活计，提示词不预设"整章重写"这类作业。
	 * 一次性成文（POST /chapters/:id/write）不设此标志。
	 */
	interactive?: boolean;
}

export type ChapterWriteMode = "create" | "rewrite" | "continue";

/** 素材全文，写作时这是唯一的事实来源。 */
function materialBlock(materials: Material[]): string {
	if (materials.length === 0) {
		return "（本章没有装配任何素材）";
	}
	return materials
		.map((m) => `### ${MATERIAL_KIND_LABELS[m.kind]} · ${m.title}（id: ${m.id}）\n${m.content}`)
		.join("\n\n");
}

export function buildWritingSystemPrompt(project: Project, ctx: WritingContext): string {
	const { chapter, materials, previous, existing, mode } = ctx;
	const target = chapter.targetWords > 0 ? `${chapter.targetWords} 字左右` : "篇幅不限";
	// 作业必须与调用方要求的 mode 一致：write_chapter 是整段覆盖，
	// 若提示词说"继续往后写"而调用方要的是重写，交出来的会是个残篇。
	// 工作台会话（interactive）没有预设作业：作者当轮说什么就是什么作业。
	const rewrite = "整章重写。旧稿会被这次输出整体替换，所以必须交完整的全章。";
	const task = ctx.interactive
		? "等作者交代。他可能只是问一句、讨论一段，也可能要你落笔成文 —— 先判断他要什么，别急着调 write_chapter。"
		: mode === "continue"
			? "在已有正文之后继续写。接上末尾，不要重复已写内容。"
			: mode === "rewrite"
				? rewrite
				: existing
					? rewrite
					: "从零写出本章。";
	return `# 角色

你是一部长章小说的执笔者。你的唯一产出是**章节正文**。
正文由已装配的素材组装而成 —— 你不重新设定人物、地点、规矩，一切以素材为准。

# 当前作品

${briefOf(project)}

# 本章任务

- 章节：《${chapter.title}》（id: ${chapter.id}）
- 要点：${chapter.summary || "（未写要略）"}
${chapter.pov ? `- 视角：${chapter.pov}` : ""}
- 篇幅：${target}
- 作业：${task}

${ctx.interactive ? `# 工作台上的规矩

作者在对话里逐条交代活计，先判断他要什么再动手：

- 只是提问或讨论（这章哪里不对、这个人该不该死），就用文字回答，不要动 write_chapter。
- 要改稿，先 read_chapter 读现有正文，改完把完整全章写回 write_chapter。
- 作者的交代优先于本章要点，但不得违背素材里已经定下的事实。
- 作者中途改了本章装配的素材时，以最新注入的素材为准。` : ""}

# 本章已装配的素材

以下是本章的全部素材全文。它们是你能使用的**唯一**事实来源。

${materialBlock(materials)}

# 接续

${previous
	? previous.content.trim()
		? `上一章《${previous.title}》的结尾状态：

${previous.content.slice(-600)}`
		: `上一章《${previous.title}》尚未成稿，没有可接的正文；按本章要点自行开篇，不要假设上一章发生过什么。`
	: "这是第一章，没有上一章可接。"}

# 绝对要保持的原则

1. **只用上面的素材**。素材里没有的人名、地点、规矩、时间线，一律不要凭空发明。
2. **素材不够就记待办**。发现缺料时用 add_note 记下来告诉作者，不要自己编一个填坑。
3. **不越章**。只写这一章，不要替下一章交稿。
4. ${ctx.interactive
	? "**整章落地**。每次 write_chapter 都要交完整全章，不要只交片段 —— 它是整段覆盖，残篇会把已有正文截断。"
	: "**一次写完**。直接调用 write_chapter 写入完整正文，不要分多次写完就宣布完成。"}

${STYLE_RULES}

# 章节写法

- 开篇不重复上一章的剧情，用场景、动作或对话直接进入。
- 章末留下钩子：新的信息、未解释的动机、还没解决的紧张。
- 每章至少推进一个主要故事问题，不要写水章。
${chapter.targetWords > 0 ? `- 字数：控制在 ${chapter.targetWords} 字左右。` : ""}

# 输出规范

- 默认使用中文写作。
- 除了工具调用参数，不要输出任何结构化文本，不要用 Markdown 标题分级。
- 写正文时只写正文本身，章节标题传给 write_chapter 的 title，不要在正文前写"第一章"。
- 工具写完后用一两句话说清成绩与下一步，不要复述正文内容。`;
}

// ═══════════════════════════════════════════════════════════ 上下文快照

export type DigestScope = "material" | "writing";

/**
 * 每次请求前注入的工程快照。
 *
 * 按 scope 分流是刻意的：素材智能体要看到全库的**索引**（否则找不到料），
 * 组装智能体要看到本章的**全文**（否则没法写）。两者混在一起会既超长又无用。
 */
export function buildContextDigest(project: Project, options?: { scope?: DigestScope; chapterId?: string }): string {
	const scope = options?.scope ?? "material";
	const chapterId = options?.chapterId;
	const section = (title: string, body: string) => `## ${title}\n${body}`;
	const parts: string[] = [];

	if (scope === "writing") {
		const assembled = chapterId ? assembledMaterials(project, chapterId) : [];
		parts.push(
			section(
				"当前进度",
				`- 已写 ${Object.keys(project.drafts).length} 章，共 ${
					Object.values(project.drafts).reduce((sum, d) => sum + countWords(d.content), 0)
				} 字`,
			),
		);
		if (assembled.length > 0) {
			parts.push(section("本章素材（写作依据）", materialBlock(assembled)));
		}
		const openNotes = project.notes.filter((n) => n.status === "open");
		if (openNotes.length > 0) {
			parts.push(
				section(
					"待办",
					openNotes.map((n) => `- [${n.severity}] ${n.category} / ${n.subject}。${n.description}`).join("\n"),
				),
			);
		}
		return wrap(parts);
	}

	// 素材模式：索引而非全文，避免库里素材一多就把窗口占满。
	const words = Object.values(project.drafts).reduce((sum, draft) => sum + countWords(draft.content), 0);
	parts.push(
		section(
			"当前进度",
			`- 已写 ${Object.keys(project.drafts).length} 章，共 ${words} 字\n- 待办 ${
				project.notes.filter((n) => n.status === "open").length
			} 条`,
		),
	);
	if (project.materials.length > 0) {
		parts.push(
			section(
				"素材库索引",
				project.materials
					.map(
						(m) =>
							`- [${MATERIAL_KIND_LABELS[m.kind]}] ${m.title}（id: ${m.id}）${
								m.usage ? " —— " + m.usage : ""
							}${m.chapterIds.length > 0 ? " [已装入 " + m.chapterIds.join("、") + "]" : ""}`,
					)
					.join("\n"),
			),
		);
	}
	if (project.outline.length > 0) {
		parts.push(
			section(
				"大纲",
				project.outline
					.map(
						(c, i) =>
							`${i + 1}. [${c.id}] ${c.title}（${c.status}）${
								c.pov ? ` 视角：${c.pov}` : ""
							} 装料 ${c.materialIds.length} 条 —— ${c.summary}`,
					)
					.join("\n"),
			),
		);
	}
	const openNotes = project.notes.filter((n) => n.status === "open");
	if (openNotes.length > 0) {
		parts.push(
			section(
				"待办",
				openNotes.map((n) => `- [${n.severity}] ${n.category} / ${n.subject}。${n.description}`).join("\n"),
			),
		);
	}
	return wrap(parts);
}

function wrap(parts: string[]): string {
	return `<工程快照>\n${parts.join("\n\n")}\n</工程快照>`;
}
