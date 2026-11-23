/**
 * The domain tools, ported from `src/ai/tools.ts` upstream.
 *
 * Two things changed on the way over, and only two:
 *
 *  1. the definition shape — pi-agent's `AgentTool` became a DSH
 *     `ToolDefinition`, which needs `output: { schema, render }`; and
 *  2. the parameter schema — DSH enforces a *subset* of JSON Schema
 *     (`type/oneOf/properties/required/additionalProperties/items/enum/const`
 *     plus annotations). `minLength`, `minItems`, `minimum` and `maximum` are
 *     rejected outright, so every constraint the upstream schema expressed that
 *     way now lives in the description and is clamped in the body.
 *
 * The tool names, argument names, descriptions and returned prose are the
 * upstream ones verbatim: they are the contract the three role prompts were
 * written against. Changing them would quietly change how the agents behave.
 *
 * Scope rule, unchanged from upstream: **the tool boundary is the job
 * boundary**. The material agent gets no `write_chapter`; the writer gets no
 * `update_outline`. An agent that cannot express an action does not attempt it.
 */

import {
  kindLabel,
  kindOptions,
  newId,
  normalizeMaterial,
  projectStats,
} from './model.js';
import {
  choice,
  clamp,
  optionalBool,
  optionalNumber,
  requiredText,
  stringArray,
  text,
  tool,
} from './tool-kit.js';

// ----------------------------------------------------------------- helpers

const AUTOMATIC_SUMMARY_PREFIX = '【自动摘要】';

/** One hit is capped so a keyword that appears on every line cannot flood. */
const MAX_SNIPPET_LINES = 8;

function lines(items) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '(无)';
}

function appendContent(oldContent, incoming) {
  if (!oldContent) return incoming;
  if (incoming.startsWith(oldContent)) return oldContent + incoming.slice(oldContent.length);
  const trimmed = oldContent.trimEnd();
  if (trimmed && incoming.startsWith(trimmed)) return oldContent + incoming.slice(trimmed.length);
  return oldContent + (/[\r\n]$/.test(oldContent) || /^[\r\n]/.test(incoming) ? '' : '\n\n') + incoming;
}

function automaticSummary(content) {
  const tail = content.trim().replace(/\s+/g, ' ').slice(-240);
  return AUTOMATIC_SUMMARY_PREFIX + (tail || '正文已更新，但没有可提取的正文内容。');
}

function nextVolumeId(project) {
  const taken = new Set(project.volumes.map((volume) => volume.id));
  let n = project.volumes.length + 1;
  let id = `v${String(n).padStart(2, '0')}`;
  while (taken.has(id)) {
    n += 1;
    id = `v${String(n).padStart(2, '0')}`;
  }
  return id;
}

function knownMaterialIds(project, ids) {
  const known = new Set(project.materials.map((material) => material.id));
  return {
    ids: [...new Set(ids.filter((id) => known.has(id)))],
    dropped: [...new Set(ids.filter((id) => !known.has(id)))],
  };
}

function materialLine(material) {
  const head = `[${kindLabel(material.kind)}] ${material.title}（id: ${material.id}）`;
  const bits = [];
  if (material.usage) bits.push(`用于：${material.usage}`);
  if (material.tags.length > 0) bits.push(`标签：${material.tags.join('、')}`);
  if (material.chapterIds.length > 0) bits.push(`已装入：${material.chapterIds.join('、')}`);
  if (material.status === 'confirmed') bits.push('已确认');
  return bits.length > 0 ? `${head}\n  ${bits.join('；')}` : head;
}

function materialBody(material) {
  return material.content ? `\n  ${material.content.split('\n').join('\n  ')}` : '';
}

/**
 * Split a query into searchable pieces.
 *
 * Chinese has no word boundaries, so it is cut into bigrams: 「酸雨霓虹」 →
 * 酸雨/雨霓/霓虹. That way 「霓虹」 still matches 「霓虹灯」 and one stray
 * particle in the middle does not sink the whole phrase.
 */
function queryTokens(query) {
  const tokens = new Set();
  for (const part of String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    if (/^[\x00-\x7f]+$/.test(part) || part.length <= 2) {
      tokens.add(part);
      continue;
    }
    for (let i = 0; i + 2 <= part.length; i += 1) tokens.add(part.slice(i, i + 2));
  }
  return [...tokens];
}

/** Score rows, widen each hit by one line, merge touching ranges. */
function searchMaterials(pool, query, limit) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const hits = [];
  for (const material of pool) {
    const rows = material.content.split('\n');
    const ranges = [];
    for (let i = 0; i < rows.length; i += 1) {
      const lower = rows[i].toLowerCase();
      if (!lower.trim()) continue;
      let score = 0;
      for (const token of tokens) if (lower.includes(token)) score += token.length;
      if (score === 0) continue;
      const from = Math.max(0, i - 1);
      const to = Math.min(rows.length - 1, i + 1);
      const last = ranges[ranges.length - 1];
      const mergedTo = last ? Math.max(last.to, to) : to;
      if (last && from <= last.to + 1 && mergedTo - last.from + 1 <= MAX_SNIPPET_LINES) {
        last.to = mergedTo;
        last.score += score;
      } else {
        const start = last ? Math.max(from, last.to + 1) : from;
        ranges.push({ from: start, to: Math.max(start, to), score });
      }
    }
    for (const range of ranges) hits.push({ material, ...range });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function renderHit(hit) {
  const rows = hit.material.content.split('\n');
  const body = rows
    .slice(hit.from, hit.to + 1)
    .map((row) => `  ${row}`)
    .join('\n');
  return `【${kindLabel(hit.material.kind)} · ${hit.material.title}】第 ${hit.from + 1}-${hit.to + 1} 行\n${body}`;
}

// ------------------------------------------------------- definition helpers

function materialKindSchema() {
  const options = kindOptions();
  return {
    type: 'string',
    enum: options.map((option) => option.kind),
    description: `素材种类：${options.map((option) => `${option.kind}（${option.label}）`).join('、')}`,
  };
}

// ------------------------------------------------------------- the tool sets

/**
 * Build the tool definitions.
 *
 * `store` owns the files; `resolveProject` finds which project a call is about;
 * `sources` is the raw-material library, omitted when the install has none.
 * Nothing here knows about HTTP, sessions or models — that keeps the set
 * reusable from the workbench, an agent preset and a test alike.
 */
export function createToolSet({ store, resolveProject, sources = undefined }) {
  async function projectOf(explicitId) {
    const id = await resolveProject(explicitId);
    if (!id) throw new Error('还没有作品。先在小说工坊里新建一部作品。');
    return store.read(id);
  }

  // ------------------------------------------------------------ read tools

  const getProjectBrief = tool({
    name: 'get_project_brief',
    card: '读取作品概览',
    kind: 'read',
    description:
      '读取作品的基本信息（标题、类型、一句话概念、简介、文风指南、总字数目标）与当前进度。开始任何工作前应先调用它对齐目标。',
    parameters: {},
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const stats = projectStats(project);
      return {
        text: [
          `标题：${project.title}`,
          `类型：${project.genre || '未设定'}`,
          `一句话概念：${project.logline || '未设定'}`,
          `简介：${project.synopsis || '未设定'}`,
          `文风指南：${project.styleGuide || '未设定'}`,
          `总字数目标：${project.targetWords || '未设定'}`,
          `当前进度：共 ${stats.chapters} 章（已写 ${stats.drafted} 章），正文 ${stats.words} 字` +
            (stats.targetWords > 0 ? ` / 目标 ${stats.targetWords} 字` : '') +
            `；素材 ${stats.materials} 条，待办 ${stats.openNotes} 条` +
            (stats.blockers > 0 ? `（含 ${stats.blockers} 条 blocker）` : ''),
        ].join('\n'),
        details: { id: project.id, title: project.title, stats },
      };
    },
  });

  const listChapters = tool({
    name: 'list_chapters',
    card: '查看章节与进度',
    kind: 'read',
    description:
      '列出大纲的章节、每章状态、已写字数与已装配的素材数。写新章节前应先调用它确认章节号与状态。章多时用 offset 与 limit 分段取；要看每章要略再加 withSummary —— 要略最占篇幅，没必要时不要带。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      scope: choice(['all', 'drafted', 'undrafted'], '取哪一批章：all 全部（默认）、drafted 只看已落笔、undrafted 只看还没写的'),
      offset: optionalNumber('从第几章开始（0 起，默认 0）'),
      limit: optionalNumber('最多列多少章（默认 40，上限 200）'),
      withSummary: optionalBool('是否带上每章要略（默认不带）'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      if (project.outline.length === 0) {
        return { text: '大纲还是空的，需要先用 update_outline 建立。', details: [] };
      }
      const volumeName = (volumeId) =>
        volumeId ? (project.volumes.find((volume) => volume.id === volumeId)?.title ?? '') : '';
      const scope = args.scope ?? 'all';
      const scoped = project.outline.filter((chapter) => {
        const written = project.drafts[chapter.id]?.hasDraft === true;
        if (scope === 'drafted') return written;
        if (scope === 'undrafted') return !written;
        return true;
      });
      const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clamp(args.limit, 1, 200, 40);
      const page = scoped.slice(offset, offset + limit);
      const body = lines(
        page.map((chapter, index) => {
          const draft = project.drafts[chapter.id];
          const written = draft?.words ?? 0;
          const pct = chapter.targetWords > 0 ? Math.min(100, Math.round((written / chapter.targetWords) * 100)) : 0;
          const rev = draft ? ` · 第${draft.revision}版` : '';
          const mats = chapter.materialIds.length > 0 ? ` · 装料${chapter.materialIds.length}条` : ' · 未装料';
          const volume = volumeName(chapter.volumeId);
          const summary = args.withSummary && chapter.summary ? `—— ${chapter.summary}` : '';
          return (
            `${offset + index + 1}. ${volume ? `〔${volume}〕` : ''}[${chapter.id}] ${chapter.title}` +
            `（${chapter.status}） 已写${written}字` +
            (chapter.targetWords ? `/${chapter.targetWords}` : '') +
            (pct ? ` ${pct}%` : '') + rev + mats + summary
          );
        })
      );
      const volumes =
        project.volumes.length > 0
          ? `卷：\n${lines(
              project.volumes.map((volume) => {
                const count = project.outline.filter((chapter) => chapter.volumeId === volume.id).length;
                return (
                  `[${volume.id}] ${volume.title}（${count}章` +
                  (volume.targetWords ? `，目标${volume.targetWords}字` : '') +
                  `）` +
                  (volume.summary ? `：${volume.summary}` : '')
                );
              })
            )}\n\n章：\n`
          : '';
      const more =
        scoped.length > offset + page.length
          ? `\n（还有 ${scoped.length - offset - page.length} 章没列，用 offset 继续取）`
          : '';
      return {
        text: volumes + body + more,
        details: {
          chapters: page.map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            status: chapter.status,
            volumeId: chapter.volumeId,
            targetWords: chapter.targetWords,
            materialCount: chapter.materialIds.length,
            words: project.drafts[chapter.id]?.words ?? 0,
            revision: project.drafts[chapter.id]?.revision ?? 0,
            ...(args.withSummary ? { summary: chapter.summary } : {}),
          })),
          volumes: project.volumes.map(({ id, title, targetWords }) => ({ id, title, targetWords })),
          pagination: {
            offset,
            limit,
            total: scoped.length,
            returned: page.length,
            hasMore: scoped.length > offset + page.length,
          },
        },
      };
    },
  });

  const readChapter = tool({
    name: 'read_chapter',
    card: '读取章节正文',
    kind: 'read',
    description:
      '读取指定章节的已写正文。续写、改稿、评估前必须先读原文，不要凭印象猜写。正文很长时用 part 与 chars 取一段：head 取开头、tail 取结尾（接文气用）；start 可以把取段的位置往后挪。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      chapterId: requiredText('章节 id，用 list_chapters 获取'),
      part: choice(['full', 'head', 'tail'], '取哪一段：full 全文（默认）、head 开头、tail 结尾'),
      chars: optionalNumber('取多少字（默认 6000，上限 20000）'),
      start: optionalNumber('part 为 head/tail 时的起始字位（默认 0）'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const meta = project.drafts[args.chapterId];
      if (!meta) return { text: `章节 ${args.chapterId} 还没有正文。`, details: null };
      const body = await store.readChapter(project.id, args.chapterId);
      const content = body?.content ?? '';
      const outline = project.outline.find((chapter) => chapter.id === args.chapterId);
      const head = outline ? `《${outline.title}》大纲要点：${outline.summary}\n` : '';
      const limit = clamp(args.chars, 200, 20000, 6000);
      const start = clamp(args.start, 0, Number.MAX_SAFE_INTEGER, 0);
      const part = args.part ?? 'full';
      let slice = content;
      let note = '';
      if (part === 'head') {
        slice = content.slice(start, start + limit);
        note = content.length > slice.length ? '\n（正文较长，这里只给了开头一段；要中段就再取一次）' : '';
      } else if (part === 'tail') {
        slice = content.slice(Math.max(0, content.length - limit - start));
        note = content.length > slice.length ? '\n（正文较长，这里只给了结尾一段）' : '';
      } else if (content.length > limit) {
        slice = content.slice(0, limit);
        note = '\n（正文较长，这里只给了开头一段；要中段就再取一次）';
      }
      return {
        text: `《${meta.title}》（第${meta.revision}版，${meta.words} 字）\n${head}\n---\n${slice}${note}`,
        details: { id: meta.id, title: meta.title, revision: meta.revision, words: meta.words },
      };
    },
  });

  const listMaterials = tool({
    name: 'list_materials',
    card: '查看素材',
    kind: 'read',
    description:
      '列出素材库条目。每条素材含 id、种类、标题、用途（usage）与已关联章节。full 为 true 时附带全文。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      kind: text('按种类筛选，如 character / world / plot'),
      query: text('按标题或用途筛选'),
      full: optionalBool('为 true 时返回素材全文，默认只给摘要'),
      offset: optionalNumber('从第几条开始（0 起，默认 0）'),
      limit: optionalNumber('最多列多少条（默认 40，上限 200）'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const kind = args.kind ? String(args.kind).trim().toLowerCase() : '';
      const query = args.query ? String(args.query).trim().toLowerCase() : '';
      let found = project.materials;
      if (kind) found = found.filter((material) => material.kind === kind);
      if (query) {
        found = found.filter(
          (material) =>
            material.title.toLowerCase().includes(query) ||
            material.usage.toLowerCase().includes(query) ||
            material.tags.some((tag) => tag.toLowerCase().includes(query))
        );
      }
      if (found.length === 0) {
        return {
          text:
            kind || query
              ? `没有符合条件的素材。素材库共 ${project.materials.length} 条。`
              : '素材库还是空的。',
          details: [],
        };
      }
      const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clamp(args.limit, 1, 200, 40);
      const page = found.slice(offset, offset + limit);
      const more =
        found.length > offset + page.length
          ? `\n（还有 ${found.length - offset - page.length} 条，用 offset 继续取）`
          : '';
      return {
        text: page.map((material) => materialLine(material) + (args.full === true ? materialBody(material) : '')).join('\n') + more,
        details: {
          materials: page.map(({ id, kind: k, title, usage, tags, chapterIds, status }) => ({
            id,
            kind: k,
            title,
            usage,
            tags,
            chapterIds,
            status,
          })),
          pagination: { offset, limit, total: found.length, returned: page.length, hasMore: found.length > offset + page.length },
        },
      };
    },
  });

  const searchMaterialsTool = tool({
    name: 'search_materials',
    card: '检索素材片段',
    kind: 'search',
    description:
      '在本章装配的素材里按关键词找相关片段，返回命中处的原文与出处。长素材的全文没有直接注入系统提示词（会把窗口占满），写与它相关的段落前要用这里取。中文按二元组匹配，所以「霓虹」能命中「霓虹灯」。一次搜不到就换个说法再搜 —— 同一件事在不同素材里可能写作「枪伤」「旧创」「左肩那道疤」，多搜几轮比猜更准。materialId 只搜某一条；不传则搜本章全部装配素材。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      chapterId: text('章节 id；不传则搜全部素材'),
      query: requiredText('要找什么，用自然语言或关键词都行'),
      materialId: text('只在这一条素材里搜；留空则搜本章全部装配素材'),
      limit: optionalNumber('最多返回几处命中，默认 6，上限 20'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      // When a chapter is named, its assembly list is the only source of truth —
      // the material card's own chapterIds are an index, not the decision.
      const chapter = args.chapterId
        ? project.outline.find((item) => item.id === args.chapterId)
        : undefined;
      if (args.chapterId && !chapter) return { text: `找不到允许章节 ${args.chapterId}。`, details: [] };
      const assembledIds = chapter ? new Set(chapter.materialIds) : null;
      const assembled = assembledIds
        ? project.materials.filter((material) => assembledIds.has(material.id))
        : project.materials;
      const pool = args.materialId ? assembled.filter((material) => material.id === args.materialId) : assembled;
      if (pool.length === 0) {
        return {
          text: args.materialId
            ? `素材 ${args.materialId} 不存在，或未装配到本章，不能检索。`
            : '这里还没有装配任何素材，没有可检索的内容。先让设定官用 attach_materials 装料。',
          details: [],
        };
      }
      const limit = clamp(args.limit, 1, 20, 6);
      const hits = searchMaterials(pool, args.query, limit);
      if (hits.length === 0) {
        return {
          text: `没有匹配「${args.query}」的片段（搜了 ${pool.length} 条素材）。换个说法再试：同义、上位词、或只取其中一个词。`,
          details: [],
        };
      }
      return { text: hits.map(renderHit).join('\n\n'), details: hits };
    },
  });

  // ------------------------------------------------------------- note tools

  const addNote = tool({
    name: 'add_note',
    card: '记录待办条目',
    kind: 'edit',
    description:
      '记下一条待处理的事项：尚未展开的伏笔、需要修正的前后不一致、待补的细节。发现问题时应主动记录而不是等第二次审稿。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      severity: choice(['info', 'warning', 'blocker'], '严重程度，blocker 代表必须修复。默认 info'),
      category: requiredText('类别，如 剧情逻辑 / 人设 / 时间线 / 地理 / 文风'),
      subject: requiredText('所属章节或对象'),
      description: requiredText('具体描述，包含依据'),
      chapterId: text('相关章节 id，可省略'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const severity = args.severity ?? 'info';
      const existing = project.notes.find(
        (note) => note.status === 'open' && note.category === args.category && note.subject === args.subject
      );
      if (existing) {
        // The same gap gets re-reported every round in a long draft; by the
        // eighth note the author stops reading them at all.
        const weight = { info: 0, warning: 1, blocker: 2 };
        const nextSeverity = weight[severity] > weight[existing.severity] ? severity : existing.severity;
        const nextDescription =
          args.description.length > existing.description.length ? args.description : existing.description;
        const changed = nextSeverity !== existing.severity || nextDescription !== existing.description;
        const saved = await store.update(project.id, (draft) => {
          const target = draft.notes.find((note) => note.id === existing.id);
          if (!target) return;
          target.severity = nextSeverity;
          target.description = nextDescription;
          if (!target.chapterId && args.chapterId) target.chapterId = args.chapterId;
          target.updatedAt = Date.now();
        });
        return {
          text: `${changed ? '已并入既有待办（' : '这条已在待办里，未重复记录（'}${nextSeverity}）：${existing.category} / ${existing.subject}`,
          details: saved.notes.find((note) => note.id === existing.id) ?? null,
        };
      }
      const note = {
        id: newId(),
        severity,
        category: args.category,
        subject: args.subject,
        description: args.description,
        status: 'open',
        ...(args.chapterId ? { chapterId: args.chapterId } : {}),
        createdAt: Date.now(),
      };
      await store.update(project.id, (draft) => {
        draft.notes.push(note);
      });
      return { text: `已记录待办（${note.severity}）：${note.category} / ${note.subject}`, details: note };
    },
  });

  const listNotes = tool({
    name: 'list_notes',
    card: '查看待办列表',
    kind: 'read',
    description: '列出待处理事项。动手前先调用它，避免重复劳动。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      status: choice(['open', 'resolved'], '默认 open'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const status = args.status ?? 'open';
      const found = project.notes.filter((note) => note.status === status);
      if (found.length === 0) return { text: `没有 ${status} 的待办。`, details: [] };
      return {
        text: lines(found.map((note) => `[${note.severity}] ${note.category} / ${note.subject}：${note.description}`)),
        details: found,
      };
    },
  });

  const resolveNote = tool({
    name: 'resolve_note',
    card: '关闭待办',
    kind: 'edit',
    description: '将一条待办标记为已处理。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      id: requiredText('待办 id'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const note = project.notes.find((item) => item.id === args.id);
      if (!note) return { text: `找不到待办 ${args.id}。`, details: null };
      await store.update(project.id, (draft) => {
        const target = draft.notes.find((item) => item.id === args.id);
        if (target) target.status = 'resolved';
      });
      return { text: `已关闭待办：${note.category} / ${note.subject}`, details: note };
    },
  });

  // ----------------------------------------------------- outline / material

  const updateOutline = tool({
    name: 'update_outline',
    card: '维护大纲',
    kind: 'edit',
    description:
      '新建章节，或给已有章节改装料。每个章节用 id 标识：新 id 才会新增；已存在的 id 只接受 chapterIds（给这一章换装料），标题、要点、卷属、状态一律保持作者原样 —— 那些是作者的定稿，你改不动。chapterIds 是本章打算用的素材 id 列表：传了就整体替换该章的装料，不传则保持原样。之后想单独增删就用 attach_materials。卷是可选的：可以先用 volumes 立几卷（卷名、卷要略、卷目标字数），再在章上用 volume 写卷名把章挂进去；卷名在章上第一次出现时也会自动立卷。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      volumes: {
        type: 'array',
        description: '卷的设置。不传就不动已有的卷；作者不打算分卷时整项省略即可',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: text('已有卷的 id；新卷留空'),
            title: requiredText('卷名，例如「卷一 · 黑水汊」'),
            summary: text('卷要略：这一卷大致写什么，2-4 句'),
            targetWords: optionalNumber('卷目标字数'),
          },
        },
      },
      chapters: {
        type: 'array',
        description: '大纲章节列表（至少一条）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: requiredText('章节 id，稳定且唯一，后续手动续写必须用它'),
            title: requiredText('标题'),
            summary: requiredText('本章要点，2-4 句'),
            pov: text('视角人物'),
            volume: text('所属卷的卷名（与 volumes 里的 title 一致）。不传保持原样，传空串表示不分卷'),
            status: choice(['planned', 'outlined', 'drafting', 'drafted', 'revising', 'done'], '状态，默认 planned'),
            targetWords: optionalNumber('本章目标字数'),
            notes: text('编写备注'),
            chapterIds: stringArray('本章要用的素材 id'),
          },
        },
      },
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const known = new Set(project.materials.map((material) => material.id));
      const untouched = [];
      const saved = await store.update(project.id, (draft) => {
        for (const item of args.volumes ?? []) {
          const title = String(item.title ?? '').trim();
          if (!title) continue;
          const target = item.id
            ? draft.volumes.find((volume) => volume.id === item.id)
            : draft.volumes.find((volume) => volume.title.trim() === title);
          if (target) {
            target.title = title;
            if (typeof item.summary === 'string') target.summary = item.summary;
            if (Number.isFinite(item.targetWords) && item.targetWords >= 0) target.targetWords = Math.floor(item.targetWords);
            continue;
          }
          draft.volumes.push({
            id: item.id && !draft.volumes.some((volume) => volume.id === item.id) ? item.id : nextVolumeId(draft),
            title,
            summary: item.summary ?? '',
            targetWords: Number.isFinite(item.targetWords) && item.targetWords > 0 ? Math.floor(item.targetWords) : 0,
            notes: '',
          });
        }
        // Volume names are what chapters carry, so this map is rebuilt after the
        // volume pass; a chapter naming an unknown volume creates it on the spot.
        const byTitle = new Map(draft.volumes.map((volume) => [volume.title.trim(), volume.id]));
        const volumeForTitle = (title) => {
          const key = String(title ?? '').trim();
          if (!key) return '';
          const hit = byTitle.get(key);
          if (hit) return hit;
          const id = nextVolumeId(draft);
          draft.volumes.push({ id, title: key, summary: '', targetWords: 0, notes: '' });
          byTitle.set(key, id);
          return id;
        };
        for (const chapter of args.chapters ?? []) {
          const index = draft.outline.findIndex((item) => item.id === chapter.id);
          if (index >= 0) {
            const target = draft.outline[index];
            if (Array.isArray(chapter.chapterIds)) {
              const knownIds = chapter.chapterIds.filter((id) => known.has(id));
              target.materialIds = knownIds;
              for (const material of draft.materials) {
                const has = material.chapterIds.includes(chapter.id);
                if (knownIds.includes(material.id) && !has) material.chapterIds.push(chapter.id);
                else if (!knownIds.includes(material.id) && has) {
                  material.chapterIds = material.chapterIds.filter((id) => id !== chapter.id);
                }
              }
            }
            untouched.push(target.title);
            continue;
          }
          const volumeId = typeof chapter.volume === 'string' ? volumeForTitle(chapter.volume) : '';
          draft.outline.push({
            id: chapter.id,
            title: chapter.title,
            summary: chapter.summary,
            pov: chapter.pov ?? '',
            status: chapter.status ?? 'planned',
            targetWords: Number.isFinite(chapter.targetWords) ? Math.floor(chapter.targetWords) : 0,
            notes: chapter.notes ?? '',
            volumeId: volumeId ?? '',
            materialIds: (chapter.chapterIds ?? []).filter((id) => known.has(id)),
            source: 'agent',
          });
          for (const id of (chapter.chapterIds ?? []).filter((cid) => known.has(cid))) {
            const material = draft.materials.find((item) => item.id === id);
            if (material && !material.chapterIds.includes(chapter.id)) material.chapterIds.push(chapter.id);
          }
        }
      });
      const requested = (args.chapters ?? []).flatMap((chapter) => chapter.chapterIds ?? []);
      const missing = requested.filter((id) => !known.has(id));
      const volumeName = new Map(saved.volumes.map((volume) => [volume.id, volume.title]));
      return {
        text:
          `大纲已更新，共 ${saved.outline.length} 章` +
          (saved.volumes.length > 0 ? `、${saved.volumes.length} 卷` : '') +
          `：\n` +
          lines(
            saved.outline.map((chapter) => {
              const volume = chapter.volumeId ? volumeName.get(chapter.volumeId) : '';
              return `[${chapter.id}] ${volume ? `〔${volume}〕` : ''}${chapter.title}（${chapter.status}）装料${chapter.materialIds.length}条`;
            })
          ) +
          (missing.length > 0 ? `\n\n以下素材 id 不存在，未装入（先 upsert_material 确认 id）：${missing.join('、')}` : '') +
          (untouched.length > 0
            ? `\n\n这些章已经存在，只按 chapterIds 改了装料；标题、要点、卷属仍按作者写的原样，不要当成改写成功：\n${lines(untouched)}`
            : ''),
        details: { outline: saved.outline, volumes: saved.volumes },
      };
    },
  });

  const upsertMaterial = tool({
    name: 'upsert_material',
    card: '新建 / 更新素材',
    kind: 'edit',
    description:
      '新建或更新一条素材。素材是可复用的创作单位，不是正文。新建时必须给齐 kind / title / content / usage 四项；更新已有素材（带 id）时只给要改的字段，其余保持原样 —— 只想改内容就只传 content。usage 必填且要写清什么情况下该用这条素材，装配智能体靠它判断相关性；一句说完，别解释。content 必须精减：只留事实、约束、边界，一行一个事实，不写散文与铺垫。chapterIds 传了就整体替换关联（传空表等于从所有章节摘除），不传则保持原样。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      id: text('已存在素材的 id；新建时留空'),
      kind: materialKindSchema(),
      title: text('标题。新建必填，更新时可省'),
      content: text('素材内容：只写事实、约束与边界，一行一个事实，务必精减。新建必填，更新时可省'),
      usage: text('装配提示：什么情况下该用这条素材。新建必填，更新时可省'),
      tags: stringArray('标签、别名'),
      chapterIds: stringArray('关联到的章节 id'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const id = (args.id ?? '').trim() || newId();
      const existing = project.materials.find((material) => material.id === id);
      // All four fields are optional in the schema because an update only sends
      // what changes; creation is completed here so the model gets a sentence it
      // can act on instead of a bare "required" violation.
      if (!existing) {
        const missing = [];
        if (!args.kind) missing.push('kind（素材种类）');
        if (!(args.title ?? '').trim()) missing.push('title（标题）');
        if (!(args.content ?? '').trim()) missing.push('content（素材内容）');
        if (!(args.usage ?? '').trim()) missing.push('usage（装配提示）');
        if (missing.length > 0) {
          return {
            text:
              `新建素材还缺：${missing.join('、')}。请重新调用 upsert_material 补全后再试。` +
              '（若本意是修改已有素材，请带上它的 id；带 id 时只需给要改的字段。）',
            details: null,
          };
        }
      }
      const validChapters = new Set(project.outline.map((chapter) => chapter.id));
      const provided = Array.isArray(args.chapterIds);
      const requested = provided ? args.chapterIds.filter((chapterId) => validChapters.has(chapterId)) : [];
      const saved = await store.update(project.id, (draft) => {
        const index = draft.materials.findIndex((material) => material.id === id);
        const base =
          index >= 0
            ? draft.materials[index]
            : normalizeMaterial({
                id,
                kind: args.kind ?? 'other',
                title: '',
                content: '',
                tags: [],
                usage: '',
                status: 'draft',
                chapterIds: [],
                source: 'agent',
                createdAt: Date.now(),
              });
        const next = {
          ...base,
          kind: args.kind ?? base.kind,
          title: (args.title ?? '').trim() || base.title,
          content: (args.content ?? '').trim() ? args.content : base.content,
          usage: (args.usage ?? '').trim() || base.usage,
          tags: Array.isArray(args.tags) ? args.tags : base.tags,
          chapterIds: provided ? requested : base.chapterIds,
          updatedAt: Date.now(),
        };
        if (index >= 0) draft.materials[index] = next;
        else draft.materials.push(next);
        if (!provided) return;
        for (const chapter of draft.outline) {
          const shouldHave = requested.includes(chapter.id);
          const has = chapter.materialIds.includes(id);
          if (shouldHave && !has) chapter.materialIds.push(id);
          else if (!shouldHave && has) chapter.materialIds = chapter.materialIds.filter((mid) => mid !== id);
        }
      });
      const material = saved.materials.find((item) => item.id === id);
      const unknown = provided ? args.chapterIds.filter((chapterId) => !validChapters.has(chapterId)) : [];
      return {
        text:
          `${existing ? '已更新素材《' : '已新建素材《'}${material?.title ?? ''}》（id: ${id}）` +
          (requested.length > 0 ? `，已关联到 ${requested.length} 章。` : '。') +
          (unknown.length > 0 ? `以下章节 id 不存在，未关联：${unknown.join('、')}` : ''),
        details: material ?? null,
      };
    },
  });

  const attachMaterials = tool({
    name: 'attach_materials',
    card: '装料到章节',
    kind: 'edit',
    description:
      '把已有素材装配到某章，或从某章移除。mode 为 add 时追加，remove 时摘除。两个方向都会同步更新素材的 chapterIds。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      chapterId: requiredText('章节 id'),
      materialIds: { ...stringArray('要装入或摘除的素材 id（至少一条）'), required: true },
      mode: choice(['add', 'remove'], '默认 add'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const mode = args.mode ?? 'add';
      const ids = Array.isArray(args.materialIds) ? args.materialIds : [];
      let skipped = [];
      const saved = await store.update(project.id, (draft) => {
        const chapter = draft.outline.find((item) => item.id === args.chapterId);
        if (!chapter) return;
        const known = new Set(draft.materials.map((material) => material.id));
        skipped = ids.filter((id) => !known.has(id));
        const wanted = ids.filter((id) => known.has(id));
        for (const id of wanted) {
          const shouldHave = mode === 'add';
          const inChapter = chapter.materialIds.includes(id);
          if (shouldHave && !inChapter) chapter.materialIds.push(id);
          else if (!shouldHave && inChapter) chapter.materialIds = chapter.materialIds.filter((mid) => mid !== id);
          const material = draft.materials.find((item) => item.id === id);
          if (!material) continue;
          const inMaterial = material.chapterIds.includes(chapter.id);
          if (shouldHave && !inMaterial) material.chapterIds.push(chapter.id);
          else if (!shouldHave && inMaterial) material.chapterIds = material.chapterIds.filter((cid) => cid !== chapter.id);
        }
      });
      const chapter = saved.outline.find((item) => item.id === args.chapterId);
      if (!chapter) return { text: `找不到章节 ${args.chapterId}。先用 update_outline 建立。`, details: null };
      // Silently dropping bad ids makes the model believe the attach worked,
      // and the failure only surfaces later as "this chapter has nothing".
      return {
        text:
          `《${chapter.title}》现有装料 ${chapter.materialIds.length} 条。` +
          (skipped.length > 0 ? `\n以下素材 id 不存在，未装入（先 upsert_material 确认 id）：${skipped.join('、')}` : ''),
        details: chapter,
      };
    },
  });

  // ------------------------------------------------------------ write tools

  async function writeChapter(args) {
    const project = await projectOf(args.projectId);
    const id = args.chapterId;
    const outline = project.outline.find((chapter) => chapter.id === id);
    if (!outline) {
      throw new Error(`章节 ${id} 不在本章目里，不能凭空写入；请先立章或改用已有章节 id。`);
    }
    const previous = await store.readChapter(project.id, id);
    const oldContent = previous?.content ?? '';
    if (args.mode === 'create' && oldContent.trim()) {
      throw new Error(`create 只能用于没有旧稿的章节；《${args.title}》已有正文，请改用 rewrite、continue 或 append_chapter。`);
    }
    const content =
      args.mode === 'continue' || args.mode === 'append' ? appendContent(oldContent, args.content) : args.content;
    const changed = oldContent.trim() !== content.trim();
    const autoSummary = changed && !(args.summary ?? '').trim();
    const requested = args.materialIds ?? previous?.materialIds ?? outline.materialIds ?? [];
    const filtered = knownMaterialIds(project, requested);
    const record = await store.writeChapter(project.id, id, {
      title: args.title,
      content,
      summary: (args.summary ?? '').trim() || (autoSummary ? automaticSummary(content) : previous?.summary ?? outline.summary),
      materialIds: filtered.ids,
      mode: args.mode,
      expectedRevision: previous?.revision ?? 0,
    });
    const summaryNote = autoSummary
      ? '未交新小结且正文已改变，已生成自动尾部摘要，避免沿用旧小结。'
      : '小结已记下，下一章靠它接续。';
    return {
      text:
        `已写入《${record.title}》：第 ${record.revision} 版，${record.words} 字（${args.mode}）。${summaryNote}` +
        (filtered.dropped.length > 0 ? `\n以下素材 id 不在已装集合中，已丢弃：${filtered.dropped.join('、')}` : ''),
      details: { ...record, droppedMaterialIds: filtered.dropped, automaticSummary: autoSummary },
    };
  }

  const chapterWriteFields = () => ({
    projectId: text('作品 id；只有一部作品时可以省略'),
    chapterId: requiredText('章节 id'),
    title: requiredText('章节标题'),
    content: requiredText('create/rewrite 为全章正文；continue/append 只写新增内容'),
    materialIds: stringArray('本次实际用到的素材 id，只能是已装集合中的真实 id'),
    summary: text('实际内容的 2-4 句小结；正文改变但不传时生成明确标记的自动摘要'),
  });

  const writeChapterTool = tool({
    name: 'write_chapter',
    card: '写入或续写章节',
    kind: 'edit',
    description:
      'create 从零写全章，已有非空旧稿时拒绝；rewrite 用全章覆盖旧稿；continue 只交新增内容，由工具读取旧稿并安全拼接。分段续写优先用 append_chapter。materialIds 如实填写实际使用且已装配的真实素材 id。',
    parameters: {
      ...chapterWriteFields(),
      mode: choice(['create', 'rewrite', 'continue'], 'create 新建、rewrite 覆盖、continue 增量续写；默认 create'),
    },
    run: (args) => writeChapter({ ...args, mode: args.mode ?? 'create' }),
  });

  const appendChapterTool = tool({
    name: 'append_chapter',
    card: '追加章节正文',
    kind: 'edit',
    description: '只提交新增正文；工具在章节写锁内读取旧稿并拼接，不要求也不应重复提交旧稿。适合长章分段生成。',
    parameters: chapterWriteFields(),
    run: (args) => writeChapter({ ...args, mode: 'append' }),
  });

  const reviseChapterTool = tool({
    name: 'revise_chapter',
    card: '改写章节里的一段',
    kind: 'edit',
    description:
      '把章节正文里的一处原文换成新写法，其余一字不动。只改作者点名的那几处时用它，不要用 write_chapter 整章覆盖。find 必须与 read_chapter 返回的正文逐字一致（含标点、空格、换行），而且要能在正文里唯一定位 —— 同一段话出现多次时，前后各多带一句。replace 是替换成的新文字，留空字符串表示删掉这一段。每改一处调用一次；改完把改了哪几处告诉作者即可，不必复述全文。',
    parameters: {
      projectId: text('作品 id；只有一部作品时可以省略'),
      chapterId: requiredText('章节 id'),
      find: requiredText('要被替换掉的原文：逐字复制 read_chapter 返回的那一段，含标点'),
      replace: { ...text('换成什么。留空字符串表示删掉这一段'), required: true },
      summary: text('改过之后这一章实际讲了什么（2-4 句）。小幅修改留空沿用旧小结，大幅修改留空生成自动摘要。'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const planned = project.outline.find((chapter) => chapter.id === args.chapterId);
      if (!planned) {
        throw new Error(`章节 ${args.chapterId} 不在本章目里，不能凭空改；先用 list_chapters 确认 id。`);
      }
      const meta = project.drafts[args.chapterId];
      if (!meta) {
        return {
          text: `《${planned.title}》还没有正文，没有可改的原文；从零写起请用 write_chapter。`,
          details: null,
        };
      }
      const body = await store.readChapter(project.id, args.chapterId);
      const content = body?.content ?? '';
      const find = args.find;
      const at = content.indexOf(find);
      if (at < 0) {
        throw new Error(
          '正文里找不到这段原文，没改。把 read_chapter 读到的原文逐字复制进 find（标点、空格、换行都要一致）再试一次；要改的那段没读全，就带上它前后各一句。'
        );
      }
      if (content.indexOf(find, at + find.length) >= 0) {
        throw new Error('这段原文在正文里不止一处，指不准该改哪儿，没改。前后各多带一句让它唯一，再试一次。');
      }
      const next = content.slice(0, at) + args.replace + content.slice(at + find.length);
      const record = await store.writeChapter(project.id, args.chapterId, {
        title: meta.title,
        content: next,
        // A small edit usually keeps the chapter's thread, so the old summary
        // still holds; replacing a big stretch deserves an honest auto-summary.
        summary:
          (args.summary ?? '').trim() ||
          (Math.min(find.length, args.replace.length) >= 120 ? automaticSummary(next) : meta.summary),
        materialIds: meta.materialIds,
        mode: 'patch',
        expectedRevision: body?.revision ?? meta.revision,
      });
      const delta = args.replace.length - find.length;
      return {
        text:
          `已改《${record.title}》：第 ${record.revision} 版，${record.words} 字。` +
          `这次换掉 ${find.length} 字、补进 ${args.replace.length} 字（${delta >= 0 ? '+' : ''}${delta} 字），其余一字未动。还有别处要改就继续调用。`,
        details: { ...record, find, replace: args.replace },
      };
    },
  });

  // -------------------------------------------------- raw-material library

  /**
   * The four read-only tools over the uploaded library.
   *
   * A whole reference book never enters the prompt or the session log: the
   * settings agent browses titles, searches for a phrase, and reads one chapter
   * only when a snippet is not enough. The drafting agent gets none of these —
   * digesting a reference book is not its job, and a tool it does not have is a
   * detour it cannot take.
   *
   * They appear only when a library exists, so a bare install does not offer
   * four tools that all answer "the library is empty".
   */
  const libraryTools = sources
    ? [
        tool({
          name: 'list_novel_sources',
          card: '查看原料库',
          kind: 'read',
          description:
            '列出作者上传并保存的原料：普通资料与整本小说。每条含 sourceId、标题、类型、编码、章节数、总字数与拆解方式。要基于某份原料提炼素材时，先调用它拿到 sourceId。',
          parameters: {},
          run: async () => {
            const list = await sources.list();
            if (list.length === 0) {
              return {
                text: '原料库还是空的。作者需要在小说工坊的「原料」里上传资料或小说。',
                details: [],
              };
            }
            return {
              text: list
                .map(
                  (source) =>
                    `《${source.title}》（${source.kind === 'document' ? '资料' : '小说'}，sourceId: ${source.id}）\n` +
                    `  ${source.chapterCount} 章 / ${source.totalChars.toLocaleString('en-US')} 字 / ` +
                    `${source.splitMode === 'single' ? '整篇' : source.splitMode === 'fixed' ? '定长拆解' : '章节拆解'} / ${source.encoding}`
                )
                .join('\n'),
              details: list.map(({ chapters: _chapters, ...meta }) => meta),
            };
          },
        }),
        tool({
          name: 'list_novel_chapters',
          card: '查看原料章节',
          kind: 'read',
          description:
            '列出某份原料的章节/分段标题与字数，可按关键词过滤标题。先用它确定要检索或细读的范围。整篇资料只有一段；分页参数 offset/limit 用于长篇，默认返回前 100 条。',
          parameters: {
            sourceId: requiredText('原料 sourceId，来自 list_novel_sources'),
            query: text('按章节/分段标题过滤，如「人物」「结局」'),
            offset: optionalNumber('跳过前几条，默认 0'),
            limit: optionalNumber('最多返回几条，默认 100，上限 200'),
          },
          run: async (args) => {
            const source = await sources.read(args.sourceId);
            if (!source) {
              return { text: '找不到这份原料，先用 list_novel_sources 确认 sourceId。', details: null };
            }
            const query = (args.query ?? '').trim().toLowerCase();
            const chapters = query
              ? source.chapters.filter((chapter) => chapter.title.toLowerCase().includes(query))
              : source.chapters;
            const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
            const limit = clamp(args.limit, 1, 200, 100);
            const page = chapters.slice(offset, offset + limit);
            if (page.length === 0) return { text: '没有符合条件的章节。', details: null };
            return {
              text:
                `《${source.title}》共 ${source.chapterCount} 条，当前显示第 ${offset + 1}–${offset + page.length} 条：\n` +
                page.map((chapter) => `${chapter.id}  ${chapter.title}（${chapter.chars.toLocaleString('en-US')} 字）`).join('\n') +
                (offset + page.length < chapters.length
                  ? `\n（还有 ${chapters.length - offset - page.length} 条没列，用 offset 继续取。）`
                  : ''),
              details: { sourceId: source.id, sourceTitle: source.title, chapters: page, total: chapters.length },
            };
          },
        }),
        tool({
          name: 'search_novel_source',
          card: '检索原料原文',
          kind: 'search',
          description:
            '在一份原料里检索关键词，返回最相关的章节/分段与原文片段。检索是提炼素材的主要手段：按人物名、地点、事件、设定词分别多搜几轮，不要只搜一次就下结论。sourceId 必填；limit 默认 6，最多 12。',
          parameters: {
            sourceId: requiredText('原料 sourceId，来自 list_novel_sources'),
            query: requiredText('检索词；中文可用人物名、地点、事件或设定词'),
            limit: optionalNumber('返回几条，默认 6，上限 12'),
          },
          run: async (args) => {
            const source = await sources.read(args.sourceId);
            if (!source) {
              return { text: '找不到这份原料，先用 list_novel_sources 确认 sourceId。', details: null };
            }
            const limit = clamp(args.limit, 1, 12, 6);
            const hits = await sources.search(args.sourceId, args.query, { limit });
            if (hits.length === 0) {
              return {
                text: `《${source.title}》里没有检索到「${args.query}」。换个同义词、人物别名或地点名再试。`,
                details: [],
              };
            }
            return {
              text:
                `《${source.title}》检索「${args.query}」命中 ${hits.length} 章：\n\n` +
                hits.map((hit) => `[${hit.chapterId}] ${hit.chapterTitle}（相关度 ${hit.score}）\n${hit.snippet}`).join('\n\n') +
                '\n\n片段不够时用 read_novel_chapter 读整章；要交叉核对，再换关键词搜一轮。',
              details: hits,
            };
          },
        }),
        tool({
          name: 'read_novel_chapter',
          card: '细读原料章节',
          kind: 'read',
          description:
            '读一章/一段的正文。默认最多返回 12000 字；超长内容会截断并提示。只在检索命中、需要核对细节时使用，不要逐段通读。',
          parameters: {
            sourceId: requiredText('原料 sourceId'),
            chapterId: requiredText('章节/分段 id，如 ch001'),
          },
          run: async (args) => {
            const chapter = await sources.readChapter(args.sourceId, args.chapterId);
            if (!chapter) {
              return { text: '找不到这一段，先用 list_novel_chapters 确认章节 id。', details: null };
            }
            const limit = 12_000;
            const body = chapter.content.length > limit ? chapter.content.slice(0, limit) : chapter.content;
            return {
              text:
                `[${chapter.id}] ${chapter.title}（${chapter.chars.toLocaleString('en-US')} 字）\n\n${body}` +
                (chapter.content.length > limit
                  ? `\n\n（本章超过 ${limit} 字，以上为前 ${limit} 字；需要后文请用检索定位。）`
                  : ''),
              details: { ...chapter, content: undefined },
            };
          },
        }),
      ]
    : [];

  return {
    shared: [getProjectBrief, listChapters, readChapter, listMaterials, searchMaterialsTool, addNote, listNotes, resolveNote],
    material: [updateOutline, upsertMaterial, attachMaterials, ...libraryTools],
    writing: [writeChapterTool, appendChapterTool, reviseChapterTool],
  };
}
