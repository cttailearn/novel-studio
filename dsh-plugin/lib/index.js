/**
 * Host half of Novel Studio.
 *
 * Responsibilities, deliberately narrow:
 *  - own the project and reference-library files on disk (nothing else may write them)
 *  - expose them to the workbench over a same-origin HTTP route
 *
 * Everything else belongs to the harness: models, credentials, conversation,
 * settings and the agent loop are all DSH services, not this plugin's business.
 *
 * The browser cannot touch the filesystem, so the Client half calls this route
 * with `fetch()`, the same pattern the shipped decoration template and the
 * desk-clock bundle use.
 */

import { StoreError, ProjectStore, defaultRoot } from './store.js';
import { SourceError, SourceLibrary } from './source-store.js';
import { decodeSourceBytes } from './sources.js';
import {
  adaptCursorChapterId,
  countWords,
  emptyProject,
  kindOptions,
  newId,
  projectStats,
} from './model.js';
import { createToolSet } from './tools.js';
import { ProposalError, ProposalStore } from './proposals.js';
import { acceptProposal, createAdaptTools } from './adapt.js';
import {
  kickAdaptContext,
  kickSnapshot,
  readAdaptContext,
  readSnapshot,
  refreshAdaptContext,
  refreshSnapshot,
} from './live.js';
import { roleRow } from './role-kit.js';

const ROUTE_PREFIX = '/novel-studio/api';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** A reference book is uploaded whole, so this route gets its own, larger cap. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const ROLE_SERVICE = 'novelRoles';

export const name = 'novel-studio';
export const inject = ['webServer'];

// NOTE: no `Config` export on purpose. A cordis Config schema is a schemastery
// descriptor (`@deepseek-ai/schemastery`) and this bundle does not depend on it
// yet; a plain object here would be rejected at boot. `ctx.config.root` is still
// read below, so a patch row may set it — the value just is not validated.
// Root resolution order lives in `store.js#defaultRoot`. If validation is ever
// wanted, add the schemastery import (as `dsh-free-search` does) and export a
// real descriptor instead of extending this object.

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new StoreError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError(400, '请求体不是合法 JSON');
  }
}

async function readRawBody(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new StoreError(413, '文件过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function pick(input, keys) {
  const out = {};
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
  return out;
}

const PROJECT_FIELDS = ['title', 'genre', 'logline', 'synopsis', 'styleGuide', 'targetWords'];

export function apply(ctx, config) {
  // The patch row's `config:` block arrives as the second apply argument, NOT as
  // `ctx.config`: cordis resolves only services (and the built-in `logger`,
  // `effect`, ...) through the context proxy, so reading `ctx.config` throws
  // `cannot get property "config" without inject` and leaves this fiber failed.
  const configured = config?.root;
  const root = configured && String(configured).trim() ? String(configured).trim() : defaultRoot();
  const store = new ProjectStore(root);
  const sources = new SourceLibrary(root);
  const proposals = new ProposalStore(root);

  /** Which project a tool call is about when it names none. */
  async function resolveProject(explicitId) {
    if (typeof explicitId === 'string' && explicitId.trim()) return explicitId.trim();
    const active = await store.readActive();
    return active?.projectId ?? '';
  }

  /** Which chapter a tool call is about when it names none. */
  async function resolveChapter() {
    const active = await store.readActive();
    return active?.chapterId ?? '';
  }

  const tools = createToolSet({ store, resolveProject, sources });
  const adaptTools = createAdaptTools({ store, sources, proposals, resolveProject, resolveChapter });

  /**
   * Publish the role service. Registered here rather than in a role row because
   * the preset rows import *this* package's role modules, and a row that
   * `provide`d the service would land in the preset's isolate realm, out of
   * reach of its siblings.
   */
  ctx.effect(() => ctx.provide(ROLE_SERVICE, {
    // `adapt` is a separate slice: the shared / material / writing groups must
    // never reach the adapter role (no `write_chapter`, no `update_outline`),
    // and no other role may reach `propose_adaptation`.
    tools: { ...tools, adapt: adaptTools },
    store,
    sources,
    proposals,
    snapshot: () => readSnapshot(store.root),
    refresh: () => refreshSnapshot(store),
    kick: () => kickSnapshot(store),
    adapt: () => readAdaptContext(store.root),
    refreshAdapt: () => refreshAdaptContext(store, sources),
    kickAdapt: () => kickAdaptContext(store, sources),
  }), 'novel-studio: role service');

  /** Chapter list entry: outline row joined with its skeleton meta. */
  function chapterList(project) {
    return project.outline.map((item) => {
      const meta = project.drafts[item.id];
      return {
        id: item.id,
        title: item.title,
        summary: item.summary,
        pov: item.pov,
        volumeId: item.volumeId,
        status: item.status,
        targetWords: item.targetWords,
        notes: item.notes,
        materialIds: item.materialIds,
        words: meta?.words ?? 0,
        revision: meta?.revision ?? 0,
        hasDraft: meta?.hasDraft ?? false,
        updatedAt: meta?.updatedAt ?? 0,
      };
    });
  }

  function upsert(list, item) {
    const index = list.findIndex((entry) => entry.id === item.id);
    if (index >= 0) list[index] = { ...list[index], ...item };
    else list.push(item);
    return index >= 0 ? list[index] : item;
  }

  async function handle(req, res) {
    const url = String(req.url || '');
    const [rawPath, rawQuery = ''] = url.split('?');
    if (!rawPath.startsWith(ROUTE_PREFIX)) {
      sendJson(req, res, 404, { ok: false, error: 'not found' });
      return;
    }
    const path = rawPath.slice(ROUTE_PREFIX.length) || '/';
    const query = new URLSearchParams(rawQuery);
    const method = req.method || 'GET';

    // GET /projects
    if (path === '/projects' && method === 'GET') {
      sendJson(req, res, 200, { ok: true, root: store.root, projects: await store.list() });
      return;
    }

    // POST /projects
    if (path === '/projects' && method === 'POST') {
      const body = await readJsonBody(req);
      // An adaptation project binds one uploaded book as its original: the
      // outline is copied from the book's chapters in one go and is never
      // edited afterwards, because chapter ids have to keep matching the
      // original or the adapter cannot read what it is adapting.
      const adaptationInput = body.adaptation;
      const sourceId =
        adaptationInput && typeof adaptationInput.sourceId === 'string' ? adaptationInput.sourceId.trim() : '';
      const source = sourceId ? await sources.read(sourceId) : undefined;
      if (sourceId && !source) throw new SourceError(404, '原书不在原料库里了；请重新导入原书再建改编工程');
      const project = emptyProject(
        source ? { ...pick(body, PROJECT_FIELDS), title: pick(body, PROJECT_FIELDS).title || source.title } : pick(body, PROJECT_FIELDS)
      );
      if (source) {
        const now = Date.now();
        project.adaptation = {
          sourceId: source.id,
          sourceTitle: source.title,
          brief: typeof adaptationInput.brief === 'string' ? adaptationInput.brief.trim() : '',
          cursor: source.chapters[0]?.id ?? '',
          changes: [],
          createdAt: now,
          updatedAt: now,
        };
        project.outline = source.chapters.map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          summary: '',
          pov: '',
          volumeId: '',
          status: 'planned',
          targetWords: chapter.chars,
          notes: '',
          materialIds: [],
        }));
        if (!project.genre) project.genre = '改编';
      }
      const created = await store.create(project);
      // The chapter list comes back with the project: an adaptation project gets
      // a whole outline minted at once, and the workbench would otherwise need a
      // second round trip before it could show anything.
      sendJson(req, res, 201, {
        ok: true,
        project: created,
        stats: projectStats(created),
        chapters: chapterList(created),
      });
      return;
    }

    // GET /kinds
    if (path === '/kinds' && method === 'GET') {
      sendJson(req, res, 200, { ok: true, kinds: kindOptions() });
      return;
    }

    let match = path.match(/^\/projects\/([\w-]+)$/);
    if (match) {
      const projectId = match[1];
      if (method === 'GET') {
        const project = await store.read(projectId);
        sendJson(req, res, 200, {
          ok: true,
          project,
          stats: projectStats(project),
          chapters: chapterList(project),
        });
        return;
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readJsonBody(req);
        const project = await store.update(projectId, (current) => {
          Object.assign(current, pick(body, PROJECT_FIELDS));
          return undefined;
        });
        sendJson(req, res, 200, { ok: true, project, stats: projectStats(project) });
        return;
      }
      if (method === 'DELETE') {
        sendJson(req, res, 200, await store.remove(projectId));
        return;
      }
    }

    // GET /projects/:id/chapters
    match = path.match(/^\/projects\/([\w-]+)\/chapters$/);
    if (match && method === 'GET') {
      const project = await store.read(match[1]);
      sendJson(req, res, 200, { ok: true, chapters: chapterList(project) });
      return;
    }

    // GET|PUT /projects/:id/chapters/:chapterId
    match = path.match(/^\/projects\/([\w-]+)\/chapters\/([^/]+)$/);
    if (match) {
      const [, projectId, rawChapterId] = match;
      const chapterId = decodeURIComponent(rawChapterId);
      if (method === 'GET') {
        const chapter = await store.readChapter(projectId, chapterId);
        sendJson(req, res, 200, { ok: true, chapter: chapter ?? null });
        return;
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJsonBody(req);
        const written = await store.writeChapter(projectId, chapterId, body);
        const project = await store.read(projectId);
        sendJson(req, res, 200, {
          ok: true,
          chapter: written,
          words: countWords(written.content),
          stats: projectStats(project),
          chapters: chapterList(project),
        });
        return;
      }
    }

    // POST /projects/:id/outline  (upsert one chapter row)
    match = path.match(/^\/projects\/([\w-]+)\/outline$/);
    if (match && (method === 'POST' || method === 'PUT')) {
      const projectId = match[1];
      const body = await readJsonBody(req);
      const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : newId();
      const project = await store.update(projectId, (current) => {
        const row = {
          id,
          title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '未命名章',
          summary: typeof body.summary === 'string' ? body.summary : '',
          pov: typeof body.pov === 'string' ? body.pov : '',
          volumeId: typeof body.volumeId === 'string' ? body.volumeId : '',
          status: typeof body.status === 'string' ? body.status : 'planned',
          targetWords: Number.isFinite(body.targetWords) ? body.targetWords : 0,
          notes: typeof body.notes === 'string' ? body.notes : '',
          materialIds: Array.isArray(body.materialIds) ? body.materialIds.filter((x) => typeof x === 'string') : [],
        };
        upsert(current.outline, row);
        return undefined;
      });
      sendJson(req, res, 200, { ok: true, project, chapters: chapterList(project) });
      return;
    }

    // DELETE /projects/:id/outline/:chapterId
    //
    // Only for the empty shells the settings agent leaves behind: a chapter that
    // has been written to keeps its row, because deleting it would orphan the
    // prose, its revision history and the material index in three places at once
    // — and a reused chapter id would resurrect the old draft.
    match = path.match(/^\/projects\/([\w-]+)\/outline\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const projectId = match[1];
      const chapterId = decodeURIComponent(match[2]);
      const current = await store.read(projectId);
      if (!current.outline.some((item) => item.id === chapterId)) throw new StoreError(404, '章节不存在');
      const meta = current.drafts[chapterId];
      if (meta && (meta.words > 0 || meta.hasDraft || meta.revision > 0)) {
        throw new StoreError(409, '这一章已经动过笔了，不能整章撤掉；要留着标题改就别用撤销。');
      }
      const project = await store.update(projectId, (draft) => {
        draft.outline = draft.outline.filter((item) => item.id !== chapterId);
        delete draft.drafts[chapterId];
        // The "attached to" index on each material card points at chapter ids:
        // leaving a deleted chapter there leaves a card claiming a chapter that
        // no longer exists.
        for (const material of draft.materials) {
          if (material.chapterIds.includes(chapterId)) {
            material.chapterIds = material.chapterIds.filter((id) => id !== chapterId);
          }
        }
        return undefined;
      });
      sendJson(req, res, 200, { ok: true, project, chapters: chapterList(project) });
      return;
    }

    // POST /projects/:id/materials  (upsert one material)
    match = path.match(/^\/projects\/([\w-]+)\/materials$/);
    if (match && (method === 'POST' || method === 'PUT')) {
      const projectId = match[1];
      const body = await readJsonBody(req);
      const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : newId();
      const now = Date.now();
      const project = await store.update(projectId, (current) => {
        const existing = current.materials.find((item) => item.id === id);
        const row = {
          id,
          kind: typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : (existing?.kind ?? 'other'),
          title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : (existing?.title ?? '未命名素材'),
          content: typeof body.content === 'string' ? body.content : (existing?.content ?? ''),
          tags: Array.isArray(body.tags) ? body.tags.filter((x) => typeof x === 'string') : (existing?.tags ?? []),
          usage: typeof body.usage === 'string' ? body.usage : (existing?.usage ?? ''),
          status: body.status === 'confirmed' ? 'confirmed' : (existing?.status ?? 'draft'),
          chapterIds: Array.isArray(body.chapterIds)
            ? body.chapterIds.filter((x) => typeof x === 'string')
            : (existing?.chapterIds ?? []),
          source: body.source === 'agent' || body.source === 'library' ? body.source : (existing?.source ?? 'human'),
          originId: existing?.originId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        upsert(current.materials, row);
        return undefined;
      });
      sendJson(req, res, 200, { ok: true, project, stats: projectStats(project) });
      return;
    }

    // DELETE /projects/:id/materials/:materialId
    match = path.match(/^\/projects\/([\w-]+)\/materials\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const projectId = match[1];
      const materialId = decodeURIComponent(match[2]);
      const project = await store.update(projectId, (current) => {
        current.materials = current.materials.filter((item) => item.id !== materialId);
        return undefined;
      });
      sendJson(req, res, 200, { ok: true, project, stats: projectStats(project) });
      return;
    }

    // POST /projects/:id/notes
    match = path.match(/^\/projects\/([\w-]+)\/notes$/);
    if (match && method === 'POST') {
      const projectId = match[1];
      const body = await readJsonBody(req);
      const project = await store.update(projectId, (current) => {
        const now = Date.now();
        const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : newId();
        const existing = current.notes.find((item) => item.id === id);
        const row = {
          id,
          severity: ['info', 'warning', 'blocker'].includes(body.severity) ? body.severity : (existing?.severity ?? 'info'),
          category: typeof body.category === 'string' ? body.category : (existing?.category ?? '设定'),
          subject: typeof body.subject === 'string' ? body.subject : (existing?.subject ?? ''),
          description: typeof body.description === 'string' ? body.description : (existing?.description ?? ''),
          status: body.status === 'resolved' ? 'resolved' : (existing?.status ?? 'open'),
          chapterId: typeof body.chapterId === 'string' && body.chapterId ? body.chapterId : existing?.chapterId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: existing ? now : undefined,
        };
        upsert(current.notes, row);
        return undefined;
      });
      sendJson(req, res, 200, { ok: true, project, stats: projectStats(project) });
      return;
    }

    // GET|PUT /active  — what the author has open
    if (path === '/active') {
      if (method === 'GET') {
        sendJson(req, res, 200, { ok: true, active: (await store.readActive()) ?? null });
        return;
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJsonBody(req);
        const active = await store.writeActive({
          projectId: typeof body.projectId === 'string' ? body.projectId : '',
          chapterId: typeof body.chapterId === 'string' ? body.chapterId : '',
        });
        // The agent roles read this through the prompt snapshot: stamp it now
        // so the next turn already knows which chapter "this chapter" means.
        // The adaptation context is stamped too — its prompt carries the
        // chapter's original text, which cannot be fetched on the assembly path.
        await Promise.all([refreshSnapshot(store), refreshAdaptContext(store, sources)]);
        sendJson(req, res, 200, { ok: true, active });
        return;
      }
    }

    // GET /sources — every uploaded reference, metadata only
    if (path === '/sources' && method === 'GET') {
      sendJson(req, res, 200, { ok: true, sources: await sources.list() });
      return;
    }

    // POST /sources/upload?filename=…&kind=…  — raw bytes in, metadata out
    //
    // The body is the file itself, not JSON: a 7M-character novel would cost
    // more than double as a JSON string, and the browser already has the bytes.
    if (path === '/sources/upload' && (method === 'POST' || method === 'PUT')) {
      const bytes = await readRawBody(req);
      if (bytes.length === 0) throw new StoreError(400, '文件是空的');
      const rawName = query.get('filename') ?? 'uploaded.txt';
      const filename = rawName.split(/[\\/]/).pop() || 'uploaded.txt';
      const decoded = decodeSourceBytes(new Uint8Array(bytes));
      const created = await sources.create({
        title: query.get('title') ?? undefined,
        filename,
        encoding: decoded.encoding,
        kind: query.get('kind') === 'document' ? 'document' : 'novel',
        text: decoded.text,
      });
      sendJson(req, res, 201, { ok: true, source: created });
      return;
    }

    // GET|DELETE /sources/:id
    match = path.match(/^\/sources\/([\w-]+)$/);
    if (match) {
      const sourceId = match[1];
      if (method === 'GET') {
        const source = await sources.read(sourceId);
        if (!source) throw new SourceError(404, '原料不存在');
        sendJson(req, res, 200, { ok: true, source });
        return;
      }
      if (method === 'DELETE') {
        sendJson(req, res, 200, await sources.remove(sourceId));
        return;
      }
    }

    // GET /sources/:id/chapters/:chapterId  — one body, read on demand
    match = path.match(/^\/sources\/([\w-]+)\/chapters\/([^/]+)$/);
    if (match && method === 'GET') {
      const chapter = await sources.readChapter(match[1], decodeURIComponent(match[2]));
      if (!chapter) throw new SourceError(404, '章节不存在');
      sendJson(req, res, 200, { ok: true, chapter });
      return;
    }

    // GET /sources/:id/search?q=…  — snippets only, never whole chapters
    match = path.match(/^\/sources\/([\w-]+)\/search$/);
    if (match && method === 'GET') {
      const hits = await sources.search(match[1], query.get('q') ?? '', {
        limit: Number(query.get('limit') ?? 6) || 6,
      });
      sendJson(req, res, 200, { ok: true, hits });
      return;
    }

    // ------------------------------------------------------------- adaptation
    //
    // Adaptation differs from writing in one way that shapes every route here:
    // a finished turn does **not** land. The agent hands over a proposal, the
    // author reads it beside the original, edits it, and presses accept — only
    // then is prose written and the change recorded in the ledger. "Broke it"
    // therefore costs at most a re-proposal, never a lost version.

    // GET|PATCH /projects/:id/adaptation — the plan and its brief
    match = path.match(/^\/projects\/([\w-]+)\/adaptation$/);
    if (match) {
      const projectId = match[1];
      if (method === 'GET') {
        const project = await store.read(projectId);
        if (!project.adaptation) throw new StoreError(404, '这一部不是改编工程');
        const source = await sources.read(project.adaptation.sourceId);
        sendJson(req, res, 200, { ok: true, adaptation: project.adaptation, source: source ?? null });
        return;
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readJsonBody(req);
        const project = await store.update(projectId, (current) => {
          if (!current.adaptation) throw new StoreError(404, '这一部不是改编工程');
          if (typeof body.brief === 'string') current.adaptation.brief = body.brief.trim();
          current.adaptation.updatedAt = Date.now();
          return undefined;
        });
        await kickAdaptContext(store, sources);
        sendJson(req, res, 200, { ok: true, adaptation: project.adaptation, stats: projectStats(project) });
        return;
      }
    }

    // POST /projects/:id/adaptation/cursor — step back to the last chapter
    //
    // Only allowed once the whole book is done, and only to the final chapter:
    // if "adapt whichever chapter you like" were legal, the one-chapter-at-a-time
    // rule would not be a rule. The last chapter is the exception because fixing
    // the chapter you just accepted is a normal thing to want.
    match = path.match(/^\/projects\/([\w-]+)\/adaptation\/cursor$/);
    if (match && method === 'POST') {
      const projectId = match[1];
      const project = await store.read(projectId);
      if (!project.adaptation) throw new StoreError(404, '这一部不是改编工程');
      const body = await readJsonBody(req);
      const cursorId = adaptCursorChapterId(project);
      if (cursorId) {
        const at = project.outline.findIndex((chapter) => chapter.id === cursorId);
        throw new StoreError(
          409,
          `改编是一章一章往下的：现在轮到第 ${at + 1} 章《${project.outline[at]?.title ?? ''}》，不能先改后面。`
        );
      }
      const last = project.outline[project.outline.length - 1]?.id ?? '';
      const wanted = typeof body.chapterId === 'string' && body.chapterId.trim() ? body.chapterId.trim() : last;
      if (!wanted || wanted !== last) throw new StoreError(409, '只能回到最后一章再改一版。');
      const saved = await store.update(projectId, (current) => {
        if (current.adaptation) current.adaptation.cursor = wanted;
        return undefined;
      });
      await kickAdaptContext(store, sources);
      sendJson(req, res, 200, { ok: true, cursor: wanted, adaptation: saved.adaptation });
      return;
    }

    // GET /projects/:id/chapters/:chapterId/adapt — what the dual pane shows
    //
    // The original text, the current draft and the pending proposal in one
    // response: the author needs all three side by side, and three round trips
    // would let them drift apart mid-read.
    match = path.match(/^\/projects\/([\w-]+)\/chapters\/([^/]+)\/adapt$/);
    if (match && method === 'GET') {
      const projectId = match[1];
      const chapterId = decodeURIComponent(match[2]);
      const project = await store.read(projectId);
      if (!project.adaptation) throw new StoreError(404, '这一部不是改编工程');
      const planned = project.outline.find((chapter) => chapter.id === chapterId);
      if (!planned) throw new StoreError(404, '章节不存在');
      const original = await sources.readChapter(project.adaptation.sourceId, chapterId);
      if (!original) throw new SourceError(404, '原文里找不到这一章；改编工程的章目应与原书章节一一对应。');
      const current = await store.readChapter(projectId, chapterId);
      const proposal = await proposals.read(projectId, chapterId);
      const cursorId = adaptCursorChapterId(project);
      const reopened = Boolean(project.drafts[chapterId]?.hasDraft);
      sendJson(req, res, 200, {
        ok: true,
        chapter: planned,
        original,
        current: current ?? null,
        proposal: proposal ?? null,
        cursor: cursorId,
        // Whether this chapter may be submitted at all right now — the pane
        // says so up front instead of letting the author write into a 409.
        open: cursorId === chapterId || reopened,
      });
      return;
    }

    // POST /projects/:id/chapters/:chapterId/adapt/accept — the only write path
    match = path.match(/^\/projects\/([\w-]+)\/chapters\/([^/]+)\/adapt\/accept$/);
    if (match && method === 'POST') {
      const projectId = match[1];
      const chapterId = decodeURIComponent(match[2]);
      const body = await readJsonBody(req);
      const result = await acceptProposal({
        store,
        proposals,
        projectId,
        chapterId,
        ...(typeof body.proposalId === 'string' && body.proposalId ? { proposalId: body.proposalId } : {}),
        ...(typeof body.content === 'string' ? { content: body.content } : {}),
        ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        ...(Array.isArray(body.changes) ? { changes: body.changes } : {}),
        ...(body.restore === true ? { restore: true } : {}),
      });
      // The adapter's prompt quotes the original *and* the current draft, so
      // accepting invalidates it: restamp before the next turn reads it.
      await Promise.all([refreshSnapshot(store), refreshAdaptContext(store, sources)]);
      const project = await store.read(projectId);
      sendJson(req, res, 200, {
        ok: true,
        chapter: result.chapter,
        adaptation: result.adaptation,
        stats: projectStats(project),
        chapters: chapterList(project),
      });
      return;
    }

    // POST /projects/:id/chapters/:chapterId/adapt/rename — a rename is live
    //
    // Not folded into the proposal on purpose: a name changed and changed back
    // is cheap, but "the proposal says one name while the chapter list prints
    // another" is a real inconsistency the author would have to reason about.
    match = path.match(/^\/projects\/([\w-]+)\/chapters\/([^/]+)\/adapt\/rename$/);
    if (match && method === 'POST') {
      const projectId = match[1];
      const chapterId = decodeURIComponent(match[2]);
      const body = await readJsonBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) throw new StoreError(400, '章名不能空着');
      const project = await store.update(projectId, (current) => {
        if (!current.adaptation) throw new StoreError(404, '这一部不是改编工程');
        const planned = current.outline.find((chapter) => chapter.id === chapterId);
        if (!planned) throw new StoreError(404, '章节不存在');
        const before = planned.title;
        planned.title = title;
        const meta = current.drafts[chapterId];
        if (meta) meta.title = title;
        const now = Date.now();
        current.adaptation.changes.push({
          id: `${chapterId}-title-${now}`,
          chapterId,
          kind: 'title',
          summary: `《${before}》改为《${title}》`,
          ...(typeof body.reason === 'string' && body.reason.trim() ? { detail: body.reason.trim() } : {}),
          createdAt: now,
        });
        current.adaptation.updatedAt = now;
        return undefined;
      });
      await kickAdaptContext(store, sources);
      sendJson(req, res, 200, { ok: true, adaptation: project.adaptation, chapters: chapterList(project) });
      return;
    }

    if (query.get('probe') === '1') {
      sendJson(req, res, 200, { ok: true, root: store.root });
      return;
    }
    sendJson(req, res, 404, { ok: false, error: `未知路由 ${method} ${path}` });
  }

  async function handleRoute(req, res) {
    try {
      await handle(req, res);
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      const status =
        error instanceof StoreError
          ? error.status
          : error instanceof SourceError
            ? error.status
            : error instanceof ProposalError
              ? error.status
              : typeof error?.status === 'number'
                ? error.status
                : 500;
      const message = error && typeof error.message === 'string' ? error.message : String(error);
      if (status >= 500) ctx.logger?.warn?.(`novel-studio: ${message}`);
      sendJson(req, res, status, { ok: false, error: message });
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleRoute }),
    'novel-studio: projects api'
  );

  // Seeds the prompt snapshot for a session that starts before the workbench
  // has written `active.json` once — otherwise the first turn of a role agent
  // would open with "no project open" even though one is.
  kickSnapshot(store);
  kickAdaptContext(store, sources);

  /**
   * Publish the two role presets.
   *
   * Additive only: the roster gets two more entries beside `standard`, and no
   * session is switched. `default` is left alone — silently changing which
   * preset a new chat gets would be a surprise far beyond this plugin.
   *
   * Skipped entirely when the registry is absent, so the plugin still installs
   * in a profile without agent presets.
   */
  ctx.inject(['agentPresets'], (scope) => {
    const roles = [
      { id: 'material', label: '小说设定', description: '只补设定、立章、装料的设定官。不写正文。' },
      { id: 'writing', label: '小说执笔', description: '照本章素材写正文的执笔者。不越章、不改设定。' },
      {
        id: 'adapt',
        label: '小说改编',
        description: '照原书一章一章改编的改编者。交提案，不直接写正文。',
      },
    ];
    for (const role of roles) {
      scope.effect(
        () => {
          let dispose;
          const pending = scope.agentPresets
            .register({
              id: `novel-${role.id}`,
              name: role.label,
              description: role.description,
              order: 20,
              plugins: [roleRow(role.id)],
            })
            .then((unregister) => {
              dispose = unregister;
            })
            .catch((error) => {
              ctx.logger?.warn?.(`novel-studio: preset ${role.id} did not mount: ${error?.message ?? error}`);
            });
          return async () => {
            await pending;
            await dispose?.();
          };
        },
        `novel-studio: preset ${role.id}`
      );
    }
  });

  ctx.logger?.info?.(`novel-studio: projects live in ${store.root}`);
}
