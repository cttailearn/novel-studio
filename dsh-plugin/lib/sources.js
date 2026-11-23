/**
 * The raw-material library: decoding, splitting, scoring and normalising.
 *
 * A whole reference novel never goes into a prompt or into the session log.
 * The book is cut into chapters, the metadata keeps only titles and sizes, and
 * a body is read on demand. This module is the pure half — no file system —
 * so the same rules serve the workbench, the tools and the tests.
 *
 * Ported from `src/store/novel-source.ts`; the behaviour is unchanged, the
 * syntax is plain JS with JSDoc types.
 */

import { newId } from './model.js';

/** @typedef {{ id: string, index: number, title: string, chars: number }} ChapterMeta */
/** @typedef {'document' | 'novel'} SourceKind */
/** @typedef {'single' | 'chapters' | 'fixed'} SplitMode */

/**
 * @typedef {object} SourceMeta
 * @property {string} id
 * @property {SourceKind} kind
 * @property {string} title
 * @property {string} filename
 * @property {string} encoding
 * @property {SplitMode} splitMode
 * @property {number} totalChars
 * @property {number} chapterCount
 * @property {ChapterMeta[]} chapters
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** A whole reference book is rare above 7M characters; leave headroom. */
export const MAX_SOURCE_CHARS = 30_000_000;
export const MAX_SOURCE_CHAPTERS = 4000;
export const DEFAULT_FIXED_CHARS = 15_000;
const MIN_FIXED_CHARS = 2000;
const MAX_FIXED_CHARS = 50_000;

/**
 * A chapter heading at the start of a line.
 *
 * Only 章/节/回 count, never 卷 — a volume title would otherwise become a
 * chapter and shift every later id.
 */
const CHAPTER_HEADING =
  /^[\t \u3000]*(第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回][^\n]{0,60}|Chapter[ \t]+\d+[^\n]{0,60})[\t \u3000]*$/gim;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Whether this runtime can decode a label at all (gb18030 needs full ICU). */
function canDecode(label) {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode an uploaded file.
 *
 * BOM first; without one, strict UTF-8, then strict GB18030. Never lenient:
 * a lost character silently poisons every later search and every material
 * quoted from this book.
 *
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: string }}
 */
export function decodeSourceBytes(bytes) {
  const decode = (label, offset = 0) => new TextDecoder(label, { fatal: true }).decode(bytes.subarray(offset));

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: stripBom(decode('utf-8', 3)), encoding: 'UTF-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: stripBom(decode('utf-16le', 2)), encoding: 'UTF-16LE' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: stripBom(decode('utf-16be', 2)), encoding: 'UTF-16BE' };
  }
  try {
    return { text: decode('utf-8'), encoding: 'UTF-8' };
  } catch {
    // Try GB18030 below.
  }
  if (canDecode('gb18030')) {
    try {
      return { text: decode('gb18030'), encoding: 'GB18030' };
    } catch {
      // Fall through to the error below.
    }
  }
  throw new Error('无法识别原料编码；请另存为 UTF-8 或 GB18030 文本后重试');
}

/** Normalise newlines, drop BOM and NUL, keep paragraphs. */
export function normalizeSourceText(text) {
  return stripBom(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function splitByHeadings(text) {
  const matches = [...text.matchAll(CHAPTER_HEADING)];
  if (matches.length < 2) return [];
  /** @type {{ title: string, content: string }[]} */
  const chapters = [];
  const first = matches[0];
  const preface = text.slice(0, first.index ?? 0).trim();
  if (preface) chapters.push({ title: '前言', content: preface });
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index ?? 0;
    const lineEnd = text.indexOf('\n', start);
    const contentStart = lineEnd < 0 ? text.length : lineEnd + 1;
    const nextStart = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const content = text.slice(contentStart, nextStart).trim();
    chapters.push({ title: match[0].trim(), content });
  }
  return chapters;
}

function splitFixed(text, fixedChars) {
  const size = Math.min(MAX_FIXED_CHARS, Math.max(MIN_FIXED_CHARS, Math.floor(fixedChars)));
  /** @type {{ title: string, content: string }[]} */
  const chapters = [];
  let start = 0;
  let index = 1;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      // Prefer a paragraph break so a sentence is not cut in half.
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + Math.floor(size * 0.6)) end = boundary;
    }
    const content = text.slice(start, end).trim();
    if (content) chapters.push({ title: `第${index}部分`, content });
    start = end;
    while (start < text.length && text[start] === '\n') start++;
    index++;
  }
  return chapters;
}

/**
 * Cut a source into chapters: by heading when there are at least two, by a
 * fixed length otherwise. Ids are ch001, ch002… — stable and predictable so a
 * tool result can name one.
 *
 * @param {string} text
 * @param {{ splitMode?: SplitMode, fixedChars?: number }} [options]
 * @returns {{ splitMode: SplitMode, chapters: { title: string, content: string }[] }}
 */
export function splitSourceText(text, options = {}) {
  const normalized = normalizeSourceText(text);
  if (!normalized) throw new Error('原料正文是空的');
  if (normalized.length > MAX_SOURCE_CHARS) {
    throw new Error(`原料超过 ${MAX_SOURCE_CHARS.toLocaleString('en-US')} 字，暂不支持`);
  }
  if (options.splitMode === 'single') {
    return { splitMode: 'single', chapters: [{ title: '全文', content: normalized }] };
  }
  const byHeading = options.splitMode === 'fixed' ? [] : splitByHeadings(normalized);
  const useHeadings = byHeading.length >= 2 && byHeading.length <= MAX_SOURCE_CHAPTERS;
  const chapters = useHeadings ? byHeading : splitFixed(normalized, options.fixedChars ?? DEFAULT_FIXED_CHARS);
  if (chapters.length === 0) throw new Error('没有可拆解的正文');
  return { splitMode: useHeadings ? 'chapters' : 'fixed', chapters };
}

/** Chapter ids are local to one source and fixed: ch001, ch002… */
export function chapterIdAt(index) {
  return `ch${String(index + 1).padStart(3, '0')}`;
}

/**
 * Normalise stored metadata. A bad record returns undefined and never reaches
 * memory.
 *
 * @param {unknown} raw
 * @returns {SourceMeta | undefined}
 */
export function normalizeSourceMeta(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = /** @type {Partial<SourceMeta>} */ (raw);
  if (typeof input.id !== 'string' || !input.id) return undefined;
  const chapters = Array.isArray(input.chapters)
    ? input.chapters
        .filter((item) => !!item && typeof item === 'object')
        .map((item, index) => ({
          id: typeof item.id === 'string' && item.id ? item.id : chapterIdAt(index),
          index: Number.isFinite(item.index) ? Number(item.index) : index,
          title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `第${index + 1}部分`,
          chars: Number.isFinite(item.chars) ? Math.max(0, Number(item.chars)) : 0,
        }))
    : [];
  if (chapters.length === 0) return undefined;
  const now = Date.now();
  const kind = input.kind === 'document' ? 'document' : 'novel';
  const splitMode =
    input.splitMode === 'single' || (kind === 'document' && input.splitMode !== 'fixed')
      ? 'single'
      : input.splitMode === 'fixed'
        ? 'fixed'
        : 'chapters';
  return {
    id: input.id,
    kind,
    title:
      typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : kind === 'document'
          ? '未命名资料'
          : '未命名小说',
    filename: typeof input.filename === 'string' ? input.filename : '',
    encoding: typeof input.encoding === 'string' ? input.encoding : 'UTF-8',
    splitMode,
    totalChars: Number.isFinite(input.totalChars)
      ? Math.max(0, Number(input.totalChars))
      : chapters.reduce((sum, chapter) => sum + chapter.chars, 0),
    chapterCount: chapters.length,
    chapters,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
  };
}

/**
 * Build metadata for a new source. Shared by every caller so the fields cannot
 * drift apart.
 *
 * @param {{ title?: string, filename: string, kind?: SourceKind, encoding?: string }} input
 * @param {{ splitMode: SplitMode, chapters: { title: string, content: string }[] }} split
 * @returns {SourceMeta}
 */
export function makeSourceMeta(input, split) {
  const now = Date.now();
  const kind = input.kind === 'document' ? 'document' : 'novel';
  const title =
    input.title?.trim() ||
    input.filename.replace(/\.[^.]+$/, '').trim() ||
    (kind === 'document' ? '未命名资料' : '未命名小说');
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
    encoding: input.encoding ?? 'UTF-8',
    splitMode: split.splitMode,
    totalChars: split.chapters.reduce((sum, chapter) => sum + chapter.content.length, 0),
    chapterCount: chapters.length,
    chapters,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Query tokens: CJK by bigram, Latin by word.
 *
 * A single CJK character is kept whole, because one character is already a
 * meaningful search term in Chinese; longer runs become overlapping bigrams so
 * a name still matches when it is glued to the next word.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function sourceTokens(query) {
  const text = query.toLowerCase().trim();
  if (!text) return [];
  const tokens = new Set();
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const word of text.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);
  return [...tokens].slice(0, 32);
}

function countOccurrences(haystack, needle, max = 20) {
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

/**
 * Score one chapter. A title hit counts more than a body hit, because a
 * heading usually names its subject.
 *
 * @param {string} title
 * @param {string} content
 * @param {string[]} tokens
 * @returns {{ score: number, offset: number }}
 */
export function scoreSourceChapter(title, content, tokens) {
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

/**
 * A readable excerpt around a hit, starting at a line head where possible.
 *
 * @param {string} content
 * @param {number} offset
 * @param {number} [maxChars]
 */
export function snippetAround(content, offset, maxChars = 420) {
  if (offset < 0) return '';
  const startLine = content.lastIndexOf('\n', Math.max(0, offset - 120));
  const start = Math.max(0, startLine >= 0 ? startLine + 1 : offset - 120);
  const end = Math.min(content.length, start + maxChars);
  const snippet = content.slice(start, end).trim();
  return end < content.length ? `${snippet}…` : snippet;
}

/**
 * Search one chapter. No hit returns undefined so callers can filter.
 *
 * @param {{ id: string, title: string, content: string }} chapter
 * @param {string[]} tokens
 * @returns {{ chapterId: string, chapterTitle: string, score: number, snippet: string, offset: number } | undefined}
 */
export function searchSourceChapter(chapter, tokens) {
  const { score, offset } = scoreSourceChapter(chapter.title, chapter.content, tokens);
  if (score <= 0 || offset < 0) return undefined;
  return {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    score,
    snippet: snippetAround(chapter.content, offset),
    offset,
  };
}
