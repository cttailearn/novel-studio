/**
 * 去 AI 味：把「读起来像模型写的」这件事拆成可执行的守则与可字面命中的清单。
 *
 * 由来：stop-slop（hardikpandya/stop-slop，MIT）那套规则治的是英文说理文，
 * 逐条照搬会误伤中文小说 —— 它要杀副词、禁破折号、强推主动语态、删"金句感"，
 * 每一条在叙事文里都是正常手法。中文这边真正该借的是它的检测清单：
 * 清嗓开场、万能强调、元评论、二元对比、假拟人、空泛断言。
 *
 * 所以这里只放两样东西，也只需要两样：
 *   1. 提示词守则（软约束，接进写作系统提示词）；
 *   2. 字面扫描（硬事实，用来在改完的稿子上把套话数出来）。
 *
 * 两条都刻意不碰叙事本身：不删副词、不删破折号、不要求每句都补主语。
 * 这一层是**干净的表达**，不是 AI 检测器 —— 它判断不了文章是谁写的。
 */

/**
 * 提示词守则。
 *
 * 控制在 400 字内：写作系统提示词本来就长（素材、接续、章节写法都在里面），
 * 再加一大段规则会把真正要写的那一章挤到窗口边缘。
 *
 * 末尾那条"反过来"不是客套：没有它，模型会把破折号和"忽然"一起当病删掉。
 */
export const DE_SLOP_RULES = `# 去 AI 味

- 直接从场景、动作、对话进入。不写"首先""总之""不得不说""值得一提的是"这类清嗓开场。
- 少用万能强调：真正、切实、深度、极致、令人震撼、意味深长、细思极恐、充满张力。
- 不写"不是 X，而是 Y"的排比；一句话说得清的，不硬拆成三段。
- 别让抽象物当主语（"决定浮现了""气氛凝固了"），落回到具体的人做具体的事。
- 少下空泛断言（"这一切都变了""意义重大"），换成看得见的细节。
- 反过来，下面这些是叙事工具，不是毛病：该有的"忽然""轻轻""慢慢"照用；破折号、短句、无主语句都正当。
- 句子长短要有起伏，别连着几句同一个节奏。`;

/** 一条字面规则。 */
export interface DeSlopRule {
	/** 稳定的规则 id，测试与日志用它，不用中文标签。 */
	id: string;
	/** 给作者看的中文名。 */
	label: string;
	/** 命中一处算一次；一律带 g，扫描时再复制一份，免得 lastIndex 串味。 */
	pattern: RegExp;
}

/**
 * 字面清单。
 *
 * 只收"确定性看得见"的东西：能用一个正则指出来给作者看的，才放进来自动查。
 * 节奏、语气、结构这些要人判断的，留在 DE_SLOP_RULES 里交给模型。
 */
export const DE_SLOP_RULES_SCAN: readonly DeSlopRule[] = [
	{
		id: "throat-clearing",
		label: "清嗓开场",
		pattern: /(?:首先|其次|总之|说到底|不得不说|值得一提的是|值得注意的是|众所周知|显而易见)/g,
	},
	{
		id: "power-words",
		label: "万能强调",
		pattern: /(?:真正的?|切实|深度的?|极致|令人震撼|意味深长|细思极恐|发人深省|令人深思|充满张力|张力十足)/g,
	},
	{
		id: "meta-commentary",
		label: "元评论",
		pattern: /(?:不难看出|毋庸置疑|应该说|可以说|换句话说)/g,
	},
	{
		id: "binary-contrast",
		label: "二元对比",
		pattern: /(?:不是[^，。！？\n]{1,20}?[，,]?\s*而是|与其说[^，。！？\n]{1,20}?[，,]?\s*不如说)/g,
	},
	{
		id: "false-agency",
		label: "假拟人",
		pattern: /(?:决定|气氛|空气|时间|局面|真相|沉默|情绪|命运|目光)(?:就这样|忽然|突然|悄然|无声地?|终于|慢慢)?(?:浮现|凝固|蔓延|拉开|降临|反转|涌动|沉淀)/g,
	},
	{
		id: "empty-claim",
		label: "空泛断言",
		pattern: /(?:这一切都(?:变了|不同了)|意义重大|影响深远|从此(?:不同|改变)|无法言说|只可意会)/g,
	},
];

/** 一次扫描的结果。 */
export interface DeSlopHit {
	rule: string;
	label: string;
	/** 命中的原文片段，去重后最多几个。 */
	samples: string[];
	/** 命中总次数；`samples` 被截断时它仍是真实值。 */
	count: number;
}

/**
 * 字面扫描。
 *
 * `sampleLimit` 只影响回给作者看的例子数量，"命中 3 处"说的永远是真实次数 ——
 * 数量说错比不说更糟。
 */
export function scanDeSlop(text: string, sampleLimit = 3): DeSlopHit[] {
	if (!text) return [];
	const hits: DeSlopHit[] = [];
	for (const rule of DE_SLOP_RULES_SCAN) {
		// 每次都新建：带 g 的正则在实例上记 lastIndex，复用会漏命中。
		const found = text.match(new RegExp(rule.pattern.source, "g"));
		if (!found || found.length === 0) continue;
		const samples: string[] = [];
		for (const raw of found) {
			const clean = raw.trim();
			if (!clean || samples.includes(clean)) continue;
			if (samples.length >= sampleLimit) break;
			samples.push(clean);
		}
		hits.push({ rule: rule.id, label: rule.label, samples, count: found.length });
	}
	return hits.sort((left, right) => right.count - left.count);
}

/** 按规则 id 取命中数，没命中就是 0。 */
function countOf(hits: DeSlopHit[], rule: string): number {
	return hits.find((hit) => hit.rule === rule)?.count ?? 0;
}

/**
 * 只挑「这一版新添的」套话。
 *
 * 段落里原本就有的"真正""不得不说"是作者的写法，改写不该把它算在自己头上；
 * 模型新加进去的才是回归。逐条比较命中次数，多出来的才算。
 */
export function newDeSlopHits(original: string, next: string): DeSlopHit[] {
	const before = scanDeSlop(original);
	const fresh: DeSlopHit[] = [];
	for (const hit of scanDeSlop(next)) {
		const added = hit.count - countOf(before, hit.rule);
		if (added > 0) fresh.push({ ...hit, count: added });
	}
	return fresh.sort((left, right) => right.count - left.count);
}

/**
 * 把命中结果写成一句给作者看的话。
 *
 * 命中很多时只报前三条规则：报全了反而看不出该先改哪句。
 */
export function deSlopSummary(hits: DeSlopHit[], prefix = ""): string {
	if (hits.length === 0) return "";
	const total = hits.reduce((sum, hit) => sum + hit.count, 0);
	const head = hits
		.slice(0, 3)
		.map((hit) => hit.label + (hit.samples[0] ? "（" + hit.samples[0] + "）" : ""))
		.join("、");
	const more = hits.length > 3 ? "等 " + hits.length + " 类" : "";
	return prefix + total + " 处：" + head + more;
}
