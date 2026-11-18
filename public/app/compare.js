/**
 * 对着原书看改了什么：句级对照、段落切分，读稿台与改编台共用一份。
 *
 * 只求能读，不求学术意义上的最小编辑距离——作者要的是「哪几句被他动了」，
 * 不是一份 diff 补丁。
 */

import { el } from "./core.js";

/**
 * 句级对照：把原文与改编稿都切成句子，用最长公共子序列找出「原样保留」的句子，
 * 剩下的就是改编者动过的地方。
 */
export function diffSegments(original, adapted) {
	const before = splitSentences(original);
	const after = splitSentences(adapted);
	const table = lcsTable(before.map(normalize), after.map(normalize));
	const kept = new Set();
	let i = before.length;
	let j = after.length;
	while (i > 0 && j > 0) {
		if (normalize(before[i - 1]) === normalize(after[j - 1])) {
			kept.add(j - 1);
			i -= 1;
			j -= 1;
		} else if (table[i - 1][j] >= table[i][j - 1]) {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	return after.map((text, index) => ({ text, changed: !kept.has(index) }));
}

export function splitSentences(text) {
	const clean = String(text || "").replace(/\r\n?/g, "\n");
	const parts = clean.match(/[^。！？!?\n]+[。！？!?]?|\n/g) || [];
	return parts.map((part) => part.trim()).filter(Boolean);
}

export function normalize(text) {
	return String(text)
		.replace(/\s+/g, "")
		.replace(/[“”‘’"']/g, "");
}

function lcsTable(left, right) {
	const rows = left.length + 1;
	const cols = right.length + 1;
	const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			table[i][j] = left[i - 1] === right[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
		}
	}
	return table;
}

/** 句子按段换行重排：原稿的段落感比逐句排列更好读。 */
export function groupSegments(segments) {
	const blocks = [];
	let current = [];
	let chars = 0;
	for (const segment of segments) {
		if (segment.text === "\n") {
			if (current.length) blocks.push(current);
			current = [];
			chars = 0;
			continue;
		}
		current.push(segment);
		chars += segment.text.length;
		if (chars > 220) {
			blocks.push(current);
			current = [];
			chars = 0;
		}
	}
	if (current.length) blocks.push(current);
	return blocks.length ? blocks : [[]];
}

/** 按空行切段，段内单换行仍是换行。 */
export function paragraphBlocks(text, className = "reader-p") {
	const blocks = String(text)
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean);
	if (!blocks.length) return [el("p", { class: className, text: "" })];
	return blocks.map((block) =>
		el(
			"p",
			{ class: className },
			...String(block)
				.split("\n")
				.flatMap((line, index) => (index === 0 ? [line] : [el("br"), line])),
		),
	);
}

/**
 * 带高亮的正文：改过的句子垫底色。
 * `markClass` 交给调用方，读稿台用 `.reader-mark`，改编台用 `.adapt-mark`。
 */
export function markedNodes(segments, { paragraphClass = "reader-p", markClass = "reader-mark" } = {}) {
	const blocks = groupSegments(segments);
	return blocks.map((block) =>
		el(
			"p",
			{ class: paragraphClass },
			...block.flatMap((segment) =>
				segment.changed ? [el("mark", { class: markClass, text: segment.text })] : [segment.text],
			),
		),
	);
}
