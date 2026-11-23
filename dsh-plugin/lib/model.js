/**
 * Novel Studio model layer: types, normalization, derived values.
 *
 * Plain JavaScript on purpose — the bundle ships unbuilt, so both halves import
 * the same file directly. Data shapes are documented with JSDoc rather than
 * TypeScript syntax.
 *
 * Ported from novel-studio `src/store/project.ts`; this copy is self-contained
 * so the bundle does not depend on the original repository's build.
 */

/**
 * @typedef {'planned'|'outlined'|'drafting'|'drafted'|'revising'|'done'} ChapterStatus
 * @typedef {'info'|'warning'|'blocker'} NoteSeverity
 * @typedef {'open'|'resolved'} NoteStatus
 * @typedef {'human'|'agent'|'library'} MaterialSource
 * @typedef {'draft'|'confirmed'} MaterialStatus
 */

/**
 * Produce a unique id.
 *
 * `crypto.randomUUID()` is only available in a secure context, so the fallback
 * path through `getRandomValues` matters for plain-HTTP deployments.
 *
 * @returns {string}
 */
export function newId() {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Shape it as UUIDv4: version nibble 4, variant bits 10.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [];
  for (let i = 0; i < bytes.length; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

/** How many historical revisions each chapter keeps. */
export const MAX_DRAFT_HISTORY = 10;

const MAX_ENCODED_NAME = 120;

/**
 * Encode a chapter id into a safe file name.
 *
 * Chapter ids are model-generated and may be any string; on Windows the
 * characters \ / : * ? " < > | are illegal and a trailing dot is silently
 * dropped. Keep only alphanumerics, dashes and underscores, escape the rest
 * reversibly, truncate past the length cap and always append a short hash so
 * two long ids sharing a prefix still map to different files.
 *
 * @param {string} raw
 * @returns {string}
 */
export function encodeFileName(raw) {
  let out = '';
  for (const char of String(raw)) {
    if (/[A-Za-z0-9_-]/.test(char)) out += char;
    else out += '_' + char.codePointAt(0).toString(16) + '_';
  }
  if (out.length > MAX_ENCODED_NAME) out = out.slice(0, MAX_ENCODED_NAME);
  let h = 5381;
  const text = String(raw);
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return out + '_' + (h >>> 0).toString(36);
}

export const MATERIAL_KINDS = [
  'premise',
  'character',
  'world',
  'location',
  'plot',
  'beat',
  'scene',
  'dialogue',
  'imagery',
  'foreshadow',
  'style',
  'research',
  'other',
];

export const MATERIAL_KIND_LABELS = {
  premise: '核心设定',
  character: '人物',
  world: '世界观',
  location: '场景地点',
  plot: '情节线',
  beat: '桥段',
  scene: '场景卡',
  dialogue: '对话',
  imagery: '意象',
  foreshadow: '伏笔',
  style: '文风',
  research: '考据',
  other: '其他',
};

/** Author-defined kinds: id → display name. */
const customKindLabels = new Map();

/**
 * Register author-defined material kinds. Replaces the previous set.
 *
 * @param {ReadonlyArray<{ id: string, label: string }>} list
 */
export function registerCustomKinds(list) {
  customKindLabels.clear();
  for (const item of Array.isArray(list) ? list : []) {
    const id = item && typeof item.id === 'string' ? item.id.trim() : '';
    const label = item && typeof item.label === 'string' ? item.label.trim() : '';
    if (!id || !label) continue;
    customKindLabels.set(id, label);
  }
}

/**
 * The kind catalog: built-ins first, author-defined after.
 *
 * @returns {Array<{ kind: string, label: string, builtin: boolean }>}
 */
export function kindOptions() {
  const out = MATERIAL_KINDS.map((kind) => ({
    kind,
    label: MATERIAL_KIND_LABELS[kind],
    builtin: true,
  }));
  for (const [kind, label] of customKindLabels) out.push({ kind, label, builtin: false });
  return out;
}

/**
 * Display name for any kind: built-in, then author-defined, then the raw id.
 *
 * @param {string} kind
 * @returns {string}
 */
export function kindLabel(kind) {
  return MATERIAL_KIND_LABELS[kind] ?? customKindLabels.get(kind) ?? kind;
}

/**
 * Whether this kind is known.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function isKnownKind(kind) {
  return MATERIAL_KINDS.includes(kind) || customKindLabels.has(kind);
}

export const CHAPTER_STATUSES = ['planned', 'outlined', 'drafting', 'drafted', 'revising', 'done'];

export const CHAPTER_STATUS_LABELS = {
  planned: '待规划',
  outlined: '已立要略',
  drafting: '起草中',
  drafted: '已成稿',
  revising: '修订中',
  done: '定稿',
};

export const ADAPTATION_CHANGE_LABELS = {
  character: '人物',
  persona: '人设',
  plot: '剧情',
  pov: '人称',
  addition: '加料',
  style: '文风',
  title: '章名',
  other: '其他',
};

/**
 * Mixed CJK/Latin word count: CJK counts characters, Latin counts words.
 *
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  const value = typeof text === 'string' ? text : '';
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (
    value
      .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
      .match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g) || []
  ).length;
  return cjk + latin;
}

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} title
 * @property {string} genre
 * @property {string} logline
 * @property {string} synopsis
 * @property {string} styleGuide
 * @property {number} targetWords
 * @property {object} [adaptation]
 * @property {Array<object>} materials
 * @property {Array<object>} volumes
 * @property {Array<object>} outline
 * @property {Record<string, object>} drafts
 * @property {Array<object>} notes
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * Build an empty project.
 *
 * @param {Partial<Pick<Project, 'title'|'genre'|'logline'|'synopsis'|'styleGuide'|'targetWords'>>} [input]
 * @returns {Project}
 */
export function emptyProject(input = {}) {
  const now = Date.now();
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const genre = typeof input.genre === 'string' ? input.genre.trim() : '';
  const logline = typeof input.logline === 'string' ? input.logline.trim() : '';
  const synopsis = typeof input.synopsis === 'string' ? input.synopsis.trim() : '';
  const styleGuide = typeof input.styleGuide === 'string' ? input.styleGuide.trim() : '';
  const target = Number.isFinite(input.targetWords) && input.targetWords > 0 ? Math.floor(input.targetWords) : 0;
  return {
    id: newId(),
    title: title || '未命名作品',
    genre,
    logline,
    synopsis,
    styleGuide,
    targetWords: target,
    materials: [],
    volumes: [],
    outline: [],
    drafts: {},
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
}

const NOTE_SEVERITIES = ['info', 'warning', 'blocker'];
const NOTE_STATUSES = ['open', 'resolved'];
const ADAPTATION_KINDS = Object.keys(ADAPTATION_CHANGE_LABELS);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickStrings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) if (typeof item === 'string' && item.trim()) out.push(item.trim());
  return out;
}

function list(value, map) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const mapped = map(item);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/**
 * Normalize one continuity note.
 *
 * A note missing `status` would silently vanish from stats and from `list_notes`
 * (both filter by status) while still being spliced into the prompt — a
 * contradiction the author can no longer see. So validate every field.
 *
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = text(raw.id).trim();
  if (!id) return undefined;
  return {
    id,
    severity: NOTE_SEVERITIES.includes(raw.severity) ? raw.severity : 'info',
    category: text(raw.category).trim() || '设定',
    subject: text(raw.subject).trim(),
    description: text(raw.description),
    status: NOTE_STATUSES.includes(raw.status) ? raw.status : 'open',
    chapterId: text(raw.chapterId).trim() || undefined,
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
  };
}

/**
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeAdaptationChange(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = text(raw.id).trim();
  if (!id) return undefined;
  return {
    id,
    chapterId: text(raw.chapterId),
    kind: ADAPTATION_KINDS.includes(raw.kind) ? raw.kind : 'other',
    summary: text(raw.summary),
    detail: text(raw.detail) || undefined,
    createdAt: num(raw.createdAt, Date.now()),
  };
}

/**
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeAdaptationPlan(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const now = Date.now();
  const sourceId = text(raw.sourceId).trim();
  // A plan without a source is a plan without an original to adapt: dropping it
  // is better than keeping a card that can never be opened.
  if (!sourceId) return undefined;
  return {
    sourceId,
    sourceTitle: text(raw.sourceTitle),
    brief: text(raw.brief),
    cursor: text(raw.cursor),
    changes: list(raw.changes, normalizeAdaptationChange),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
  };
}

/**
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeMaterial(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = text(raw.id).trim();
  if (!id) return undefined;
  const now = Date.now();
  return {
    id,
    kind: text(raw.kind).trim() || 'other',
    title: text(raw.title).trim() || '未命名素材',
    content: text(raw.content),
    tags: pickStrings(raw.tags),
    usage: text(raw.usage),
    status: raw.status === 'confirmed' ? 'confirmed' : 'draft',
    chapterIds: pickStrings(raw.chapterIds),
    source: raw.source === 'agent' || raw.source === 'library' ? raw.source : 'human',
    originId: text(raw.originId).trim() || undefined,
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
  };
}

/**
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeVolume(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = text(raw.id).trim();
  if (!id) return undefined;
  return {
    id,
    title: text(raw.title).trim() || '未命名卷',
    summary: text(raw.summary),
    targetWords: Math.max(0, Math.floor(num(raw.targetWords))),
    notes: text(raw.notes),
  };
}

/**
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeOutlineChapter(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = text(raw.id).trim();
  if (!id) return undefined;
  return {
    id,
    title: text(raw.title).trim() || '未命名章',
    summary: text(raw.summary),
    pov: text(raw.pov),
    volumeId: text(raw.volumeId),
    status: CHAPTER_STATUSES.includes(raw.status) ? raw.status : 'planned',
    targetWords: Math.max(0, Math.floor(num(raw.targetWords))),
    notes: text(raw.notes),
    materialIds: pickStrings(raw.materialIds),
    source: raw.source === 'agent' ? 'agent' : undefined,
  };
}

/**
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeChapterMeta(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = text(raw.id).trim();
  if (!id) return undefined;
  return {
    id,
    title: text(raw.title).trim() || '未命名章',
    summary: text(raw.summary),
    words: Math.max(0, Math.floor(num(raw.words))),
    revision: Math.max(0, Math.floor(num(raw.revision))),
    updatedAt: num(raw.updatedAt),
    materialIds: pickStrings(raw.materialIds),
    hasDraft: raw.hasDraft === true,
  };
}

/**
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function normalizeDraftRevision(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    revision: Math.max(0, Math.floor(num(raw.revision))),
    title: text(raw.title),
    content: text(raw.content),
    materialIds: pickStrings(raw.materialIds),
    updatedAt: num(raw.updatedAt),
    mode: text(raw.mode) || 'rewrite',
  };
}

/**
 * Normalize a whole project. Conservative: repair rather than drop rows.
 *
 * @param {unknown} raw
 * @returns {Project|undefined}
 */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const now = Date.now();
  const drafts = {};
  if (raw.drafts && typeof raw.drafts === 'object') {
    for (const [key, value] of Object.entries(raw.drafts)) {
      const meta = normalizeChapterMeta(value);
      if (meta) drafts[key] = meta;
    }
  }
  return {
    id: text(raw.id).trim() || newId(),
    title: text(raw.title).trim() || '未命名作品',
    genre: text(raw.genre),
    logline: text(raw.logline),
    synopsis: text(raw.synopsis),
    styleGuide: text(raw.styleGuide),
    targetWords: Math.max(0, Math.floor(num(raw.targetWords))),
    adaptation: normalizeAdaptationPlan(raw.adaptation),
    materials: list(raw.materials, normalizeMaterial),
    volumes: list(raw.volumes, normalizeVolume),
    outline: list(raw.outline, normalizeOutlineChapter),
    drafts,
    notes: list(raw.notes, normalizeNote),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
  };
}

/**
 * Derived stats shown on the workbench header.
 *
 * @param {Project} project
 * @returns {{ chapters: number, drafted: number, words: number, targetWords: number, materials: number, openNotes: number, blockers: number }}
 */
export function projectStats(project) {
  let words = 0;
  let drafted = 0;
  for (const item of project.outline) {
    const meta = project.drafts[item.id];
    if (!meta) continue;
    words += meta.words;
    if (meta.hasDraft) drafted += 1;
  }
  let openNotes = 0;
  let blockers = 0;
  for (const note of project.notes) {
    if (note.status !== 'open') continue;
    openNotes += 1;
    if (note.severity === 'blocker') blockers += 1;
  }
  return {
    chapters: project.outline.length,
    drafted,
    words,
    targetWords: project.targetWords,
    materials: project.materials.length,
    openNotes,
    blockers,
  };
}

/**
 * One-line brief spliced into every role's system prompt.
 *
 * @param {Project} project
 * @returns {string}
 */
export function briefOf(project) {
  const lines = [`标题：${project.title}`];
  if (project.genre.trim()) lines.push(`类型：${project.genre.trim()}`);
  if (project.logline.trim()) lines.push(`一句话概念：${project.logline.trim()}`);
  if (project.targetWords > 0) lines.push(`总字数目标：${project.targetWords}`);
  if (project.styleGuide.trim()) lines.push(`文风指南：${project.styleGuide.trim()}`);
  return lines.join('\n');
}

// ------------------------------------------------------ the adaptation ledger

/**
 * Does this "title" change actually change anything?
 *
 * Models sometimes file 「本章章名维持《…》」 as a change. Saying "unchanged" is
 * not a change: in the ledger it only buries the real ones, and later chapters
 * searching by title find nothing. Only an explicit old→new counts.
 *
 * @param {string} summary
 * @returns {boolean}
 */
export function isTitleChangeSummary(summary) {
  return /改为|改名为|改成|换成|→|->/.test(summary);
}

/**
 * Which name did a "title" change actually rename?
 *
 * Only 「《旧名》改为《新名》」 counts. Having it lets the accept step patch the
 * name in: a model that writes the rename into `changes` and forgets to call
 * `rename_chapter` does happen, and then the ledger says one name while the
 * chapter list prints another.
 *
 * @param {string} summary
 * @returns {{before: string, after: string}|undefined}
 */
export function renamedTitleFromSummary(summary) {
  const quoted = summary.match(/《([^》]+)》\s*(?:改为|改名为|改成|换成|变为)\s*《([^》]+)》/);
  if (quoted) return { before: quoted[1].trim(), after: quoted[2].trim() };
  const arrow = summary.match(/《([^》]+)》\s*(?:→|->)\s*(?:《([^》]+)》|([^》\s]+))/);
  if (arrow) {
    const after = (arrow[2] ?? arrow[3] ?? '').trim();
    if (after) return { before: arrow[1].trim(), after };
  }
  return undefined;
}

/**
 * A title with the 「第 N 章」 layer taken off.
 *
 * Chapters split out of an original often carry a numbering prefix, while the
 * model writes only 《开端》 in the ledger. Comparing both sides after stripping
 * the number keeps a real rename from being read as "the author already renamed
 * it" and dropped.
 *
 * @param {string} title
 * @returns {string}
 */
export function titleCore(title) {
  return title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^第[0-9０-９零〇一二三四五六七八九十百千两]+[章节回][\s·、:：.,，。\-—_]*/, '')
    .trim();
}

/**
 * Drop ledger entries that are not changes, and merge exact duplicates.
 *
 * Two real causes: `rename_chapter` records one line while the proposal's
 * `changes` copies it again, and 「章名维持《…》」 gets filed as a change. Only
 * those two are cleaned — order, id, reason and both names stay. The ledger is
 * how later chapters learn what earlier ones did, so dropping one line costs
 * more than keeping one too many.
 *
 * @param {ReadonlyArray<object>} changes
 * @returns {Array<object>}
 */
export function pruneAdaptationChanges(changes) {
  const kept = [];
  const byKey = new Map();
  for (const change of changes) {
    const summary = String(change.summary ?? '').trim();
    if (!summary) continue;
    if (change.kind === 'title' && !isTitleChangeSummary(summary)) continue;
    const key = `${change.chapterId}\u0000${change.kind}\u0000${summary}`;
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, kept.length);
      kept.push({ ...change, summary });
      continue;
    }
    const existing = kept[at];
    if (!existing.detail && change.detail) kept[at] = { ...existing, detail: change.detail };
  }
  return kept;
}

/**
 * Rename one chapter.
 *
 * The name has two homes — the outline (what the plan calls it) and the draft
 * meta (what the manuscript prints) — and renaming only one leaves them
 * disagreeing. The body and the revision number do not move: a rename is not a
 * new version.
 *
 * @param {Project} project
 * @param {string} chapterId
 * @param {string} title
 * @returns {string|undefined} the old title, or undefined when the chapter is gone
 */
export function renameChapterTitle(project, chapterId, title) {
  const chapter = project.outline.find((item) => item.id === chapterId);
  if (!chapter) return undefined;
  const before = chapter.title;
  chapter.title = title;
  const meta = project.drafts[chapterId];
  if (meta) meta.title = title;
  return before;
}

/**
 * Which chapter the adaptation is on right now.
 *
 * Adaptation only moves forward: once a chapter is accepted it is read-only and
 * the pen moves to the next one. A recorded cursor wins — the author hand-editing
 * a body elsewhere is not the same as accepting that chapter. With no cursor
 * (older projects) it is the first chapter without a draft. An empty string means
 * the whole book has been adapted.
 *
 * @param {Project} project
 * @returns {string}
 */
export function adaptCursorChapterId(project) {
  const recorded = project.adaptation?.cursor;
  if (typeof recorded === 'string') {
    if (!recorded) return '';
    if (project.outline.some((chapter) => chapter.id === recorded)) return recorded;
  }
  const next = project.outline.find((chapter) => !project.drafts[chapter.id]?.hasDraft);
  return next ? next.id : '';
}

/**
 * Where the pen lands after accepting one chapter.
 *
 * @param {Project} project
 * @param {string} chapterId
 * @returns {string}
 */
export function nextAdaptChapterId(project, chapterId) {
  const index = project.outline.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) return adaptCursorChapterId(project);
  const next = project.outline[index + 1];
  return next ? next.id : '';
}
