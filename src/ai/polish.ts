/**
 * 局部改写（polish）。
 *
 * 作者在稿纸上选一段，说一句「改成什么样」，执笔者只重写这一段。
 * 与 revise_chapter 的分工：
 *   · revise_chapter 给对话里的执笔者用 —— 它自己找 find、自己落盘；
 *   · polish 给稿纸上的作者用 —— 只出文本、先给作者看，采用才落盘。
 *
 * 这个文件只放「提示词」与「确定性校验」两件事，不碰 store、不碰 HTTP，
 * 好让两边都能单独测。
 */

export interface PolishContext {
	chapterTitle: string;
	chapterSummary: string;
	/** 选区前后的正文，用来做衔接锚点。 */
	before: string;
	after: string;
	selected: string;
	instruction: string;
	/** 作者点名「别动」的东西。 */
	keep: string;
	/** 本章素材里的人物名，用来做事实校验。 */
	characters: string[];
	/** 本章的待办，提醒模型别写反设定。 */
	notes: string[];
	/** 校验没过时，把上一版的问题回灌给它。 */
	feedback?: string;
	/** 第几次尝试，从 1 开始。 */
	attempt?: number;
}

export const POLISH_SYSTEM_PROMPT = `你是一位只做局部改写的中文小说编辑。作者选中了正文里的一段，交代你要改成什么样。

硬规矩，每一条都不许破：
1. 只输出替换后的正文。不要解释、不要寒暄、不要标题、不要 Markdown 代码块、不要用引号包住整段。
2. 只改这一段。不要顺手改前后文，也不要把这一段扩写成新情节。
3. 不改事实：人名、地名、数字、时间、称呼、物件、因果，必须与原文一致；原文没有的人与物不要凭空出现。
4. 保持叙述人称与语感，与给出的「上文」「下文」接得上：第一句要能承接上文，最后一句要能接住下文。
5. 长度控制在原文的 0.7–1.4 倍；段落数不增加，除非作者明确要求拆段。
6. 作者写进「别动」的东西，一个字都不要碰。
7. 要求与原文事实冲突时，按原文写，不要编新设定。
8. 不要写「以下是修改后的段落」这类前言，第一句就是正文。`;

/** 选区上下的取景范围：够接得上，又不至于把整章灌给模型。 */
export const POLISH_WINDOW = 700;

export function buildPolishPrompt(ctx: PolishContext): string {
	const parts: string[] = [];
	parts.push("章节：" + ctx.chapterTitle + "（要略：" + (ctx.chapterSummary || "未写") + "）");
	if (ctx.before.trim()) parts.push("<上文>\n" + ctx.before.trim() + "\n</上文>");
	parts.push("<要改的这一段>\n" + ctx.selected + "\n</要改的这一段>");
	if (ctx.after.trim()) parts.push("<下文>\n" + ctx.after.trim() + "\n</下文>");
	parts.push("改写要求：" + (ctx.instruction.trim() || "保持原意，把句子改顺"));
	if (ctx.keep.trim()) parts.push("别动：" + ctx.keep.trim());
	if (ctx.characters.length > 0) parts.push("本章人物（名字不要改）：" + ctx.characters.join("、"));
	if (ctx.notes.length > 0) parts.push("本章待办（别写反）：\n" + ctx.notes.map((note) => "- " + note).join("\n"));
	if (ctx.feedback) {
		parts.push(
			"上一版没通过检查（第 " + String(ctx.attempt ?? 2) + " 次尝试）：" + ctx.feedback +
				"\n请重写这一版，仍然只输出替换后的正文。",
		);
	}
	return parts.join("\n\n");
}

export interface PolishCheck {
	id: "length" | "paragraphs" | "numbers" | "names";
	label: string;
	ok: boolean;
	/** 没通过时告诉作者哪里不对；通过时给一句人话的量化。 */
	detail: string;
	/** 硬伤：这一版不能采用，自动回灌重写。 */
	hard: boolean;
}

export interface PolishVerdict {
	checks: PolishCheck[];
	hard: boolean;
	feedback: string;
}

function numbersOf(text: string): string[] {
	return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

function blocksOf(text: string): string[] {
	return text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
}

/** 中文按字符算长度；英文按 2 个字符折 1 个，避免译文式的膨胀被漏掉。 */
function weightOf(text: string): number {
	const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
	const rest = text.replace(/[\u4e00-\u9fff]/g, "").trim().length;
	return cjk + rest / 2;
}

/**
 * 把模型吐出来的东西收拾成正文：
 * 去掉代码围栏、去掉「替换后：」这类前言、去掉包住整段的引号。
 * 模型偶尔会带这些东西，它们不该被当成正文写进稿子。
 */
export function sanitizePolish(raw: string): string {
	let text = raw.replace(/\r\n/g, "\n").trim();
	text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
	text = text.replace(/^(?:替换后|改写后|改后|修改后|以下是[^\n]{0,12}?)[：:]\s*/u, "").trim();
	const pairs: Array<[string, string]> = [
		["「", "」"],
		["“", "”"],
		["『", "』"],
		['"', '"'],
	];
	for (const [open, close] of pairs) {
		if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
			const inner = text.slice(open.length, text.length - close.length);
			// 只有整段被一对引号包住时才剥：正文自己以引号收尾不该被误伤。
			if (inner && !inner.startsWith(open) && !inner.endsWith(close)) text = inner.trim();
		}
	}
	return text;
}

/**
 * 确定性校验：模型说自己「只改了这一段」不算数，这里按字面查。
 *
 * 三条硬伤（长度、段数、数字）不过就回灌重写；人名被改掉只提示，不拦 ——
 * 作者的改写要求有时就是要拿掉某个称呼。
 */
export function checkPolish(original: string, next: string, characters: string[]): PolishVerdict {
	const checks: PolishCheck[] = [];
	const weight = weightOf(original);
	const nextWeight = weightOf(next);
	const ratio = weight > 0 ? nextWeight / weight : 1;
	const lengthOk = ratio >= 0.6 && ratio <= 1.7;
	checks.push({
		id: "length",
		label: "篇幅",
		ok: lengthOk,
		detail: lengthOk
			? "约为原文的 " + Math.round(ratio * 100) + "%"
			: "长度为原文的 " + Math.round(ratio * 100) + "%，改动过大或过小",
		hard: !lengthOk,
	});

	const hadBlocks = blocksOf(original);
	const nowBlocks = blocksOf(next);
	// 选区本来就在一段之内时，段数是 1 对 1，不必约束。
	const paragraphOk = hadBlocks.length <= 1 ? true : nowBlocks.length <= hadBlocks.length;
	checks.push({
		id: "paragraphs",
		label: "段数",
		ok: paragraphOk,
		detail: paragraphOk
			? nowBlocks.length + " 段"
			: "从 " + hadBlocks.length + " 段变成了 " + nowBlocks.length + " 段",
		hard: !paragraphOk,
	});

	const before = numbersOf(original);
	const after = new Set(numbersOf(next));
	const lost = before.filter((value) => !after.has(value));
	checks.push({
		id: "numbers",
		label: "数字",
		ok: lost.length === 0,
		detail: lost.length === 0 ? (before.length > 0 ? "原文数字都还在" : "原文不含数字，不涉及") : "丢了数字 " + lost.join("、"),
		hard: lost.length > 0,
	});

	const dropped = characters.filter(
		(name) => name.length >= 2 && original.includes(name) && !next.includes(name),
	);
	checks.push({
		id: "names",
		label: "人物",
		ok: dropped.length === 0,
		detail: dropped.length === 0 ? "人物称呼未改" : "这几个名字没了：" + dropped.join("、"),
		hard: false,
	});

	const feedback = checks
		.filter((check) => check.hard || check.id === "names")
		.map((check) => check.label + "：" + check.detail)
		.join("；");
	return { checks, hard: checks.some((check) => check.hard), feedback };
}
