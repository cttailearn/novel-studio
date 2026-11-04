/**
 * 小说拆解库的纯模型层。
 *
 * 作者上传的整本小说不塞进 library.json，也不塞进系统提示词：
 * 一本书按章切成许多段，元数据只留章节名与字数，正文按需读取。
 * 这一层只做解码、拆章、搜索与归一化，不碰文件系统，因此浏览器端
 * （IndexedDB）与磁盘端可以共用同一套规则。
 */
import { newId } from "./project.ts";

/** 一章的元数据。正文不在列表里返回。 */
export interface NovelChapterMeta {
	id: string;
	index: number;
	title: string;
	chars: number;
}

/** 原料类型：普通资料按单章保存，整本小说按章节/定长拆解。 */
export type MaterialSourceKind = "document" | "novel";
export type MaterialSplitMode = "single" | "chapters" | "fixed";

/** 一份已保存原料的元数据。 */
export interface NovelSourceMeta {
	id: string;
	kind: MaterialSourceKind;
	title: string;
	filename: string;
	encoding: string;
	splitMode: MaterialSplitMode;
	totalChars: number;
	chapterCount: number;
	chapters: NovelChapterMeta[];
	createdAt: number;
	updatedAt: number;
}

/** 新建一本拆解小说。正文只在 create 时传入一次。 */
export interface NovelSourceInput {
	title?: string;
	filename: string;
	text: string;
	encoding?: string;
	kind?: MaterialSourceKind;
	splitMode?: MaterialSplitMode;
	fixedChars?: number;
}

/** 读取一章时返回的正文。 */
export interface NovelChapter {
	id: string;
	index: number;
	title: string;
	content: string;
	chars: number;
}

/** 小说检索结果。正文只返回一小段，避免把整章塞进上下文。 */
export interface NovelSearchHit {
	chapterId: string;
	chapterTitle: string;
	score: number;
	snippet: string;
	offset: number;
}

export interface NovelSearchOptions {
	limit?: number;
	offset?: number;
}

/** 单本小说的上限。7M 字是常见长篇，留出余量。 */
export const MAX_NOVEL_CHARS = 30_000_000;
export const MAX_NOVEL_CHAPTERS = 4000;
export const DEFAULT_FIXED_CHARS = 15_000;
const MIN_FIXED_CHARS = 2000;
const MAX_FIXED_CHARS = 50_000;

/** 行首的章节标题。只认章/节/回，不认卷，避免把分卷名当成一章。 */
const CHAPTER_HEADING = /^[\t \u3000]*(第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回][^\n]{0,60}|Chapter[ \t]+\d+[^\n]{0,60})[\t \u3000]*$/gim;

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解码上传的小说。
 *
 * 先看 BOM；没有 BOM 时严格按 UTF-8 试，失败再严格按 GB18030 试。
 * 不做宽松解码：宽松解码会把乱码当正文存下来，后面所有检索和素材都被污染。
 */
export function decodeNovelBytes(bytes: Uint8Array): { text: string; encoding: string } {
	const decode = (label: string, offset = 0): string =>
		new TextDecoder(label, { fatal: true }).decode(bytes.subarray(offset));

	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return { text: stripBom(decode("utf-8", 3)), encoding: "UTF-8" };
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		return { text: stripBom(decode("utf-16le", 2)), encoding: "UTF-16LE" };
	}
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		return { text: stripBom(decode("utf-16be", 2)), encoding: "UTF-16BE" };
	}
	try {
		return { text: decode("utf-8"), encoding: "UTF-8" };
	} catch {
		// 继续试 GB18030。
	}
	try {
		return { text: decode("gb18030"), encoding: "GB18030" };
	} catch {
		throw new Error("无法识别小说编码；请另存为 UTF-8 或 GB18030 文本后重试");
	}
}

/** 统一换行、去 BOM 与 NUL，保留段落。 */
export function normalizeNovelText(text: string): string {
	return stripBom(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\u0000/g, "")
		.trim();
}

interface SplitChapter {
	title: string;
	content: string;
}

function splitByHeadings(text: string): SplitChapter[] {
	const matches = [...text.matchAll(CHAPTER_HEADING)];
	if (matches.length < 2) return [];
	const chapters: SplitChapter[] = [];
	const first = matches[0]!;
	const preface = text.slice(0, first.index ?? 0).trim();
	if (preface) chapters.push({ title: "前言", content: preface });
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i]!;
		const start = match.index ?? 0;
		const lineEnd = text.indexOf("\n", start);
		const contentStart = lineEnd < 0 ? text.length : lineEnd + 1;
		const nextStart = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
		const content = text.slice(contentStart, nextStart).trim();
		chapters.push({ title: match[0].trim(), content });
	}
	return chapters;
}

function splitFixed(text: string, fixedChars: number): SplitChapter[] {
	const size = Math.min(MAX_FIXED_CHARS, Math.max(MIN_FIXED_CHARS, Math.floor(fixedChars)));
	const chapters: SplitChapter[] = [];
	let start = 0;
	let index = 1;
	while (start < text.length) {
		let end = Math.min(text.length, start + size);
		if (end < text.length) {
			// 尽量在段落边界断开，避免一句话被腰斩。
			const boundary = text.lastIndexOf("\n", end);
			if (boundary > start + Math.floor(size * 0.6)) end = boundary;
		}
		const content = text.slice(start, end).trim();
		if (content) chapters.push({ title: `第${index}部分`, content });
		start = end;
		while (start < text.length && text[start] === "\n") start++;
		index++;
	}
	return chapters;
}

/**
 * 拆章：优先按章节标题；标题不足两处时按固定字数切块。
 * 前言/序章作为首块保留，章节 id 固定为 ch001、ch002……
 */
export function splitNovelText(
	text: string,
	options: { splitMode?: MaterialSplitMode; fixedChars?: number } = {},
): { splitMode: MaterialSplitMode; chapters: SplitChapter[] } {
	const normalized = normalizeNovelText(text);
	if (!normalized) throw new Error("原料正文是空的");
	if (normalized.length > MAX_NOVEL_CHARS) {
		throw new Error(`原料超过 ${MAX_NOVEL_CHARS.toLocaleString("en-US")} 字，暂不支持`);
	}
	if (options.splitMode === "single") {
		return { splitMode: "single", chapters: [{ title: "全文", content: normalized }] };
	}
	const byHeading = options.splitMode === "fixed" ? [] : splitByHeadings(normalized);
	const useHeadings = byHeading.length >= 2 && byHeading.length <= MAX_NOVEL_CHAPTERS;
	const chapters = useHeadings ? byHeading : splitFixed(normalized, options.fixedChars ?? DEFAULT_FIXED_CHARS);
	if (chapters.length === 0) throw new Error("没有可拆解的正文");
	return { splitMode: useHeadings ? "chapters" : "fixed", chapters };
}

/** 章节 id 只在本节内使用，固定、可预测，便于工具引用。 */
export function chapterIdAt(index: number): string {
	return `ch${String(index + 1).padStart(3, "0")}`;
}

/** 从磁盘/IDB 的原始元数据归一化。坏记录返回 undefined，不进入内存。 */
export function normalizeNovelSourceMeta(raw: unknown): NovelSourceMeta | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<NovelSourceMeta>;
	if (typeof input.id !== "string" || !input.id) return undefined;
	const chapters = Array.isArray(input.chapters)
		? input.chapters
				.filter((item): item is NovelChapterMeta => !!item && typeof item === "object")
				.map((item, index) => ({
					id: typeof item.id === "string" && item.id ? item.id : chapterIdAt(index),
					index: Number.isFinite(item.index) ? Number(item.index) : index,
					title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : `第${index + 1}部分`,
					chars: Number.isFinite(item.chars) ? Math.max(0, Number(item.chars)) : 0,
				}))
		: [];
	if (chapters.length === 0) return undefined;
	const now = Date.now();
	const kind: MaterialSourceKind = input.kind === "document" ? "document" : "novel";
	const splitMode: MaterialSplitMode =
		input.splitMode === "single" || (kind === "document" && input.splitMode !== "fixed")
			? "single"
			: input.splitMode === "fixed"
				? "fixed"
				: "chapters";
	return {
		id: input.id,
		kind,
		title:
			typeof input.title === "string" && input.title.trim()
				? input.title.trim()
				: kind === "document"
					? "未命名资料"
					: "未命名小说",
		filename: typeof input.filename === "string" ? input.filename : "",
		encoding: typeof input.encoding === "string" ? input.encoding : "UTF-8",
		splitMode,
		totalChars: Number.isFinite(input.totalChars) ? Math.max(0, Number(input.totalChars)) : chapters.reduce((sum, c) => sum + c.chars, 0),
		chapterCount: chapters.length,
		chapters,
		createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
	};
}

/** 新建元数据。create 与浏览器实现共用，避免两边字段漂移。 */
export function makeNovelSourceMeta(
	input: NovelSourceInput,
	split: { splitMode: MaterialSplitMode; chapters: SplitChapter[] },
): NovelSourceMeta {
	const now = Date.now();
	const kind: MaterialSourceKind = input.kind === "document" ? "document" : "novel";
	const title =
		input.title?.trim() ||
		input.filename.replace(/\.[^.]+$/, "").trim() ||
		(kind === "document" ? "未命名资料" : "未命名小说");
	const chapters = split.chapters.map((chapter, index) => ({
		id: chapterIdAt(index),
		index,
		title: chapter.title,
		chars: chapter.content.length,
	}));
	return {
		id: newId(),
		kind,
		title,
		filename: input.filename,
		encoding: input.encoding ?? "UTF-8",
		splitMode: split.splitMode,
		totalChars: split.chapters.reduce((sum, chapter) => sum + chapter.content.length, 0),
		chapterCount: chapters.length,
		chapters,
		createdAt: now,
		updatedAt: now,
	};
}

/** 中文按二元组、英文按单词切查询词。 */
export function queryTokens(query: string): string[] {
	const text = query.toLowerCase().trim();
	if (!text) return [];
	const tokens = new Set<string>();
	for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
		if (run.length === 1) tokens.add(run);
		else for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
	}
	for (const word of text.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);
	return [...tokens].slice(0, 32);
}

function countOccurrences(haystack: string, needle: string, max = 20): number {
	let count = 0;
	let index = 0;
	while (count < max) {
		const found = haystack.indexOf(needle, index);
		if (found < 0) break;
		count++;
		index = found + needle.length;
	}
	return count;
}

/** 单章打分。标题命中额外加分，正文命中按词长加权。 */
export function scoreNovelChapter(title: string, content: string, tokens: string[]): { score: number; offset: number } {
	const lowerTitle = title.toLowerCase();
	const lowerContent = content.toLowerCase();
	let score = 0;
	let offset = -1;
	for (const token of tokens) {
		const titleHits = countOccurrences(lowerTitle, token, 5);
		const contentHits = countOccurrences(lowerContent, token);
		score += titleHits * 8 + contentHits * (token.length >= 2 ? 2 : 1);
		if (offset < 0 && contentHits > 0) offset = lowerContent.indexOf(token);
	}
	return { score, offset };
}

/** 从命中位置取一段可读摘要，尽量从行首开始。 */
export function snippetAround(content: string, offset: number, maxChars = 420): string {
	if (offset < 0) return "";
	const startLine = content.lastIndexOf("\n", Math.max(0, offset - 120));
	const start = Math.max(0, startLine >= 0 ? startLine + 1 : offset - 120);
	const end = Math.min(content.length, start + maxChars);
	const snippet = content.slice(start, end).trim();
	return end < content.length ? `${snippet}…` : snippet;
}

/** 对单章做检索；无命中返回 undefined。 */
export function searchNovelChapter(
	chapter: NovelChapter,
	tokens: string[],
): NovelSearchHit | undefined {
	const { score, offset } = scoreNovelChapter(chapter.title, chapter.content, tokens);
	if (score <= 0 || offset < 0) return undefined;
	return {
		chapterId: chapter.id,
		chapterTitle: chapter.title,
		score,
		snippet: snippetAround(chapter.content, offset),
		offset,
	};
}
