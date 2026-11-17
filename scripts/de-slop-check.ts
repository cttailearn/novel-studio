/**
 * 去 AI 味的守则与扫描：字面命中数对不对、原文本来就有的算不算、提示词接没接上。
 *
 * 这一套的重点是**不误伤**：它只报"新添的套话"，不评价文笔好坏，也不拦落盘。
 * 所以下面既验命中，也验不命中 —— 一段有"忽然""轻轻""破折号"的好文字，
 * 一条规则都不该被算成 AI 腔。误报比漏报更糟：作者会因此不敢用这个功能。
 */
import { DE_SLOP_RULES, DE_SLOP_RULES_SCAN, deSlopSummary, newDeSlopHits, scanDeSlop } from "../src/ai/de-slop.ts";
import { checkPolish } from "../src/ai/polish.ts";
import { buildWritingSystemPrompt } from "../src/ai/prompts.ts";
import { emptyProject, type Material, type OutlineChapter, type Project } from "../src/store/project.ts";

let failures = 0;
function check(label: string, condition: boolean, extra = ""): void {
	if (condition) console.log("  ✓ " + label);
	else {
		failures += 1;
		console.log("  ✗ " + label + " " + extra);
	}
}

// ── 清单本身
console.log("\n清单");
check("守则块提到破折号是叙事工具", DE_SLOP_RULES.includes("破折号") && DE_SLOP_RULES.includes("叙事工具"));
check("守则块不超过 400 字", DE_SLOP_RULES.length <= 400, String(DE_SLOP_RULES.length));
check("规则 id 不重复", new Set(DE_SLOP_RULES_SCAN.map((rule) => rule.id)).size === DE_SLOP_RULES_SCAN.length);
check("每条规则都有中文标签", DE_SLOP_RULES_SCAN.every((rule) => rule.label.length >= 2));
check("每条规则都带 g 标志", DE_SLOP_RULES_SCAN.every((rule) => rule.pattern.flags.includes("g")));

// ── 命中
console.log("\n命中");
const throat = scanDeSlop("首先，他不是好相处的人。总之这件事就这么定了。");
check("清嗓开场两处都数进去", throat.some((hit) => hit.rule === "throat-clearing" && hit.count === 2), JSON.stringify(throat));
const power = scanDeSlop("这是一个真正的瞬间，意义重大。");
check("万能强调与空泛断言各抓一处", power.some((hit) => hit.rule === "power-words") && power.some((hit) => hit.rule === "empty-claim"), JSON.stringify(power));
check("二元对比命中", scanDeSlop("这不是一次失败，而是一次开始。").some((hit) => hit.rule === "binary-contrast"));
check("假拟人命中两处", scanDeSlop("真相忽然浮现在他眼前，气氛凝固了。").some((hit) => hit.rule === "false-agency" && hit.count === 2));
check("命中按次数从多到少排", scanDeSlop("不得不说，不得不说，首先。").every((hit, index, list) => index === 0 || list[index - 1]!.count >= hit.count));
check("重复的词条样例去重", scanDeSlop("不得不说。不得不说。不得不说。")[0]?.samples.length === 1);
const many = scanDeSlop("首先，其次，总之，不得不说。");
check("样例默认最多三个，次数仍是真实值", many[0]?.samples.length === 3 && many[0]?.count === 4, JSON.stringify(many[0]));

// ── 不误伤：好句子一条都不该命中
console.log("\n不误伤");
const good =
	"天还没亮，他推开门，风把雪末子送进来。\n\n" +
	"她忽然笑了一下，轻轻把碗推过来——手在抖。\n\n" +
	"“喝吧。”她说。\n\n" +
	"他没动。慢慢地，屋子里只剩下火塘的声音。";
check("白描、破折号、忽然、轻轻都不算 AI 腔", scanDeSlop(good).length === 0, JSON.stringify(scanDeSlop(good)));
check("短句与无主语句不算 AI 腔", scanDeSlop("下雨了。很冷。他没带伞。").length === 0);
check("空串返回空数组", scanDeSlop("").length === 0);
check("跨调用不漏命中（g 正则不复用 lastIndex）", scanDeSlop("首先，其次。").length === 2 || scanDeSlop("首先，其次。")[0]?.count === 2);
const twice = scanDeSlop("不得不说。");
const again = scanDeSlop("不得不说。");
check("连扫两次结果一致", JSON.stringify(twice) === JSON.stringify(again));

// ── 只算新添的
console.log("\n只算新添的");
const original = "不得不说，这条路他走了很多年。";
check("原文本来就有的不算回归", newDeSlopHits(original, original).length === 0, JSON.stringify(newDeSlopHits(original, original)));
const worse = original + "\n\n首先，这是一次真正的开始。";
const fresh = newDeSlopHits(original, worse);
check("新添的清嗓开场被算出来", fresh.some((hit) => hit.rule === "throat-clearing" && hit.count === 1), JSON.stringify(fresh));
check("新添的万能强调被算出来", fresh.some((hit) => hit.rule === "power-words"), JSON.stringify(fresh));
check("原有的那处不计入新增", newDeSlopHits(original, "不得不说。首先，其次。").find((hit) => hit.rule === "throat-clearing")?.count === 2);
check("改干净了就是空的", newDeSlopHits(original, "这条路他走了很多年。").length === 0);

// ── 摘要文案
console.log("\n摘要");
check("没有命中就没有摘要", deSlopSummary([]) === "");
const summary = deSlopSummary(scanDeSlop("首先，总之，真正的意义重大。"), "新添了 ");
check("摘要带前缀与总次数", summary.startsWith("新添了 ") && /^\S+ \d+ 处/.test(summary), summary);
check("摘要最多报三类", deSlopSummary([
	{ rule: "a", label: "甲", samples: ["x"], count: 1 },
	{ rule: "b", label: "乙", samples: [], count: 1 },
	{ rule: "c", label: "丙", samples: [], count: 1 },
	{ rule: "d", label: "丁", samples: [], count: 1 },
]).includes("等 4 类"));

// ── 接进 checkPolish
console.log("\n接进校验");
const characters = ["沈砚"];
const verdict = checkPolish("沈砚走进来。", "沈砚走进来。首先，这是一个真正的开始。", characters);
const deSlopCheck = verdict.checks.find((item) => item.id === "deSlop");
check("润色校验里有 AI 腔这一行", Boolean(deSlopCheck), JSON.stringify(verdict.checks.map((item) => item.id)));
check("有套话时这一行不过", deSlopCheck?.ok === false && (deSlopCheck?.detail ?? "").includes("新添了"), deSlopCheck?.detail ?? "");
check("不是硬伤，照样能采用", verdict.hard === false && deSlopCheck?.hard === false);
const cleanVerdict = checkPolish("沈砚走进来。", "沈砚推门进来。", characters);
check("干净的一版这一行过", cleanVerdict.checks.find((item) => item.id === "deSlop")?.ok === true);
const ids = cleanVerdict.checks.map((item) => String(item.id));
check("原有四项检查都还在", ["length", "paragraphs", "numbers", "names"].every((id) => ids.includes(id)), JSON.stringify(ids));
check("关掉就不加这一行", checkPolish("沈砚走进来。", "首先。", characters, { deSlop: false }).checks.every((item) => item.id !== "deSlop"));

// ── 接进写作提示词
console.log("\n提示词");
const project: Project = emptyProject({ title: "夜航船", genre: "悬疑", styleGuide: "短句，白描。" });
const chapter: OutlineChapter = {
	id: "ch01",
	title: "渡口",
	summary: "有人上了船。",
	pov: "",
	volumeId: "",
	status: "planned",
	targetWords: 3000,
	notes: "",
	materialIds: [],
};
const material: Material = {
	id: "m1",
	kind: "character",
	title: "沈砚",
	content: "摆渡人，话很少。",
	tags: [],
	usage: "",
	status: "confirmed",
	chapterIds: [],
	source: "human",
	createdAt: 1,
	updatedAt: 1,
};
const prompt = buildWritingSystemPrompt(project, { chapter, materials: [material], mode: "create" });
check("执笔者提示词里有去 AI 味这一段", prompt.includes("# 去 AI 味"));
check("原有文风块还在", prompt.includes("# 文风") && prompt.includes("展示而不述说"));
check("守则原文整段进了提示词", prompt.includes(DE_SLOP_RULES));
check("素材与章节信息没被挤掉", prompt.includes("沈砚") && prompt.includes("《渡口》"));

process.exit(failures === 0 ? 0 : 1);
