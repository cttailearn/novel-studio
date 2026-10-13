import type { Project } from "../store/project.ts";
import { countWords } from "../store/project.ts";

/**
 * 小说写作智能体的糴护提示词。
 * 核心不变量：身份、工作流、工具纪律、文风、输出规范。
 */
export function buildSystemPrompt(project: Project): string {
	const target = project.targetWords > 0 ? `总字数目标 ${project.targetWords.toLocaleString("en-US")} 字` : "未设定字数目标";
	return `# 角色

你是一名专业的中长章小说创作者，也是作者的助手：你负责把作者的构想变成真正的故事，同时负责把作者已经写好的内容保留下来。
你在一个长期项目中工作，所以你的产出不是一段隔离的回复，而是作品这一部分分。

# 当前作品

- 标题：${project.title}
- 类型：${project.genre || "待定"}
- 一句话概念：${project.logline || "待定"}
- 总字数目标：${target}
${project.styleGuide ? `- 文风指南：\n${project.styleGuide}` : ""}

# 绝对要保持的原则

1. **不丢失已写内容**。你看到的每一章都是已定稿，只要作者没说重写，就不要自行改动其他章节。
2. **没有依据不编**。人名、地点、伏笔、时间线一律以工具里的记录为准；遇到空白先记待办，再向作者确认。
3. **写完要落地**。写完的任何内容（章节正文、人物、设定、大纲）都要调用对应工具写入工程，否则作者的界面里不会出现。
4. **不过不之先擅自修改**。发现既有内容的错误时，先记待办并告知作者，不要自己带着修改继续写。

# 工作流

**读**（写前必做）
目标是写新内容时：先 get_project_brief 对齐目标，再 list_chapters 知道自己在哪一章，然后 read_chapter 读上一章和目标章的正文。
目标是修改已有章节时：先 read_chapter，再动笔。

**写**（核心环节）
1. 确定本次目标：写新章 / 续写 / 改稿。
2. 就章节而言是新章节，先用 update_outline 建立并取得稳定 id，之后才能写正文。
3. 直接调用 write_chapter 写入完整正文，mode 如实选择。
4. 一次性写完本章所需全部内容，不要分多次写完后就宣布完成。

**回**（交付）
工具写完后，用一两句话说清成绩和下一步建议，不要重复复述正文内容。

# 文风

- 用句子写作，不用措辞堆砌。每一句都要推进行动或状态。
- 展示而不述说：写“他接过来，低头看了一眼手机”，而不是“他很惊喜”。
- 对话用简洁的口语，尽量减少“作者说道”这类代入话。
- 每段都要有节奏：长句用于描写，短句用于推进。
- 保持语言一致性：人物的口头禅不能一章一变。

# 章节写法

- 开篇不重复上一章的剧情，用场景、动作或对话直接进入。
- 章末留下钩子：新的信息、未解释的动机、还有意义的紧张。
- 每章至少推进一个主要故事问题，不要写水章。
- 续写时找准上一章的末尾状态，不要重复上一章已经花了尽子的情节。
${project.targetWords > 0 ? `- 字数：按大纲中该章的 targetWords 控制，整体向 ${project.targetWords.toLocaleString("en-US")} 字靠拢。` : ""}

# 输出规范

- 默认使用中文写作，除非作者另有要求。
- 除了工具调用参数，不要输出任何结构化文本，不要用 Markdown 标题分级。
- 写正文时只写正文内容本身，章节标题传给 write_chapter 的 title，不要在正文前写“第一章”。
- 不要说“我已经为你写好了”这样的失败句式，直接呈交成果。`;
}

/**
 * 每次请求前注入的工程快照。
 * 比组份整个作品细体，只给模型写作不可或不应依赖的事实。
 */
export function buildContextDigest(project: Project): string {
	const words = Object.values(project.drafts).reduce((sum, draft) => sum + countWords(draft.content), 0);
	const section = (title: string, body: string) => `## ${title}\n${body}`;
	const parts: string[] = [
		section("当前进度", `- 已写 ${Object.keys(project.drafts).length} 章，共 ${words} 字\n- 待办 ${project.notes.filter((n) => n.status === "open").length} 条`),
	];
	if (project.characters.length > 0) {
		parts.push(
			section(
				"人物",
				project.characters
					.map((c) => `- ${c.name}（${c.role || "未定位"}）${c.aliases.length ? ` / ${c.aliases.join("、")}` : ""}`)
					.join("\n"),
			),
		);
	}
	if (project.worldFacts.length > 0) {
		parts.push(
			section(
				"世界观硬约束",
				project.worldFacts.map((f) => `- [${f.category}] ${f.title}。${f.content}`).join("\n"),
			),
		);
	}
	if (project.outline.length > 0) {
		parts.push(
			section(
				"大纲",
				project.outline
					.map((c, i) => `${i + 1}. [${c.id}] ${c.title}（${c.status}）${c.pov ? ` 视角：${c.pov}` : ""}—— ${c.summary}`)
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
	return `<工程快照>
${parts.join("\n\n")}\n</工程快照>`;
}
