/**
 * Disk storage for Novel Studio.
 *
 * Layout (one directory per project, so a project is portable as a folder):
 *
 *   <root>/index.json                       project list shown by the workbench
 *   <root>/active.json                      what the author is looking at now
 *   <root>/projects/<id>/project.json       skeleton: outline, materials, notes
 *   <root>/projects/<id>/chapters/<k>.json  one chapter body + its history
 *
 * `active.json` is the bridge between the two halves of the plugin: the
 * workbench writes it whenever the author opens a project or a chapter, and an
 * agent preset reads it so "write this chapter" means the one on screen without
 * the author restating which one. It is a pointer, never a source of truth — a
 * stale pointer costs one 404, and the tools fall back to an explicit id.
 *
 * The skeleton/body split is deliberate and matches the model layer: listing
 * chapters never reads megabytes of prose, and a chapter write only rewrites
 * that one chapter's file.
 *
 * Every write is atomic (write to `<name>.tmp`, then rename) and every chapter
 * write carries an `expected revision`, so two writers cannot silently
 * overwrite each other — the loser gets a 409 the same way the upstream
 * `withChapterLock` produced one.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_DRAFT_HISTORY,
  countWords,
  encodeFileName,
  newId,
  normalizeProject,
  projectStats,
} from './model.js';

/** Where projects live. `DSH_NOVEL_HOME` wins so a user can relocate them. */
export function defaultRoot() {
  const configured = process.env.DSH_NOVEL_HOME;
  if (configured && configured.trim()) return configured.trim();
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(home, 'novel-studio');
}

/** Raised for anything the HTTP layer should turn into a status code. */
export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function readJson(path, fallback) {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (isMissing(error)) return fallback;
    if (error instanceof SyntaxError) throw new StoreError(500, `${path} 不是合法的 JSON：${error.message}`);
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, '\t'), 'utf8');
  await rename(temporary, path);
}

/** Serialize writes per project so two concurrent patches cannot interleave. */
const locks = new Map();

function withLock(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // Keep the chain alive but never let a rejection poison later work.
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

export class ProjectStore {
  constructor(root = defaultRoot()) {
    this.root = root;
  }

  get indexPath() {
    return join(this.root, 'index.json');
  }

  projectDir(id) {
    return join(this.root, 'projects', id);
  }

  skeletonPath(id) {
    return join(this.projectDir(id), 'project.json');
  }

  chapterPath(projectId, chapterId) {
    return join(this.projectDir(projectId), 'chapters', `${encodeFileName(chapterId)}.json`);
  }

  async list() {
    const index = await readJson(this.indexPath, { projects: [] });
    const projects = Array.isArray(index?.projects) ? index.projects : [];
    return projects
      .filter((item) => item && typeof item.id === 'string')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  get activePath() {
    return join(this.root, 'active.json');
  }

  /**
   * What the workbench has open right now.
   *
   * @returns {Promise<{ projectId: string, chapterId: string } | undefined>}
   */
  async readActive() {
    const raw = await readJson(this.activePath, undefined);
    if (!raw || typeof raw.projectId !== 'string' || !raw.projectId) return undefined;
    return {
      projectId: raw.projectId,
      chapterId: typeof raw.chapterId === 'string' ? raw.chapterId : '',
    };
  }

  /**
   * Remember the open project/chapter. Missing or empty ids clear the pointer.
   *
   * @param {{ projectId?: string, chapterId?: string }} selection
   */
  async writeActive(selection) {
    const projectId = typeof selection?.projectId === 'string' ? selection.projectId.trim() : '';
    if (!projectId) {
      await rm(this.activePath, { force: true });
      return { projectId: '', chapterId: '' };
    }
    const chapterId = typeof selection?.chapterId === 'string' ? selection.chapterId.trim() : '';
    const value = { projectId, chapterId, updatedAt: Date.now() };
    await writeJsonAtomic(this.activePath, value);
    return { projectId, chapterId };
  }

  async #touchIndex(entry) {
    const index = await readJson(this.indexPath, { projects: [] });
    const projects = Array.isArray(index?.projects) ? index.projects : [];
    const rest = projects.filter((item) => item && item.id !== entry.id);
    rest.push(entry);
    await writeJsonAtomic(this.indexPath, { projects: rest });
  }

  async #forgetIndex(id) {
    const index = await readJson(this.indexPath, { projects: [] });
    const projects = Array.isArray(index?.projects) ? index.projects : [];
    await writeJsonAtomic(this.indexPath, { projects: projects.filter((item) => item && item.id !== id) });
  }

  /** Read the skeleton, or 404. */
  async read(projectId) {
    const raw = await readJson(this.skeletonPath(projectId), undefined);
    if (raw === undefined) throw new StoreError(404, '工程不存在');
    const project = normalizeProject(raw);
    if (!project) throw new StoreError(500, '工程文件损坏');
    return project;
  }

  async #write(project) {
    project.updatedAt = Date.now();
    await writeJsonAtomic(this.skeletonPath(project.id), project);
    const stats = projectStats(project);
    await this.#touchIndex({
      id: project.id,
      title: project.title,
      genre: project.genre,
      updatedAt: project.updatedAt,
      chapters: stats.chapters,
      words: stats.words,
      targetWords: stats.targetWords,
    });
    return project;
  }

  /** Apply `mutate` to the skeleton under the project lock. */
  async update(projectId, mutate) {
    return withLock(`project:${projectId}`, async () => {
      const project = await this.read(projectId);
      const result = await mutate(project);
      await this.#write(project);
      return result === undefined ? project : result;
    });
  }

  async create(input = {}) {
    const project = normalizeProject({ ...input, id: newId(), outline: input.outline ?? [], materials: input.materials ?? [] });
    if (!project) throw new StoreError(400, '工程参数不合法');
    await this.#write(project);
    return project;
  }

  async remove(projectId) {
    await this.read(projectId);
    await rm(this.projectDir(projectId), { recursive: true, force: true });
    await this.#forgetIndex(projectId);
    return { ok: true };
  }

  async readChapter(projectId, chapterId) {
    const raw = await readJson(this.chapterPath(projectId, chapterId), undefined);
    if (raw === undefined) return undefined;
    return {
      id: typeof raw.id === 'string' ? raw.id : chapterId,
      title: typeof raw.title === 'string' ? raw.title : '',
      content: typeof raw.content === 'string' ? raw.content : '',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      revision: Number.isFinite(raw.revision) ? raw.revision : 0,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      materialIds: Array.isArray(raw.materialIds) ? raw.materialIds.filter((x) => typeof x === 'string') : [],
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  }

  /**
   * Write a chapter body.
   *
   * `expectedRevision` implements the optimistic lock: when supplied and the
   * stored revision differs, the caller gets a 409 instead of losing prose.
   * Each successful write pushes the previous body onto the bounded history so
   * an overwrite — the only destructive action in this workflow — stays undoable.
   *
   * The chapter lock is taken first and the project lock inside it, because the
   * write touches both files: the body and the skeleton that mirrors its word
   * count. Two different chapters of one project therefore serialize, which
   * costs nothing here and removes a lost-update on project.json.
   */
  async writeChapter(projectId, chapterId, body) {
    return withLock(`chapter:${projectId}:${chapterId}`, () =>
      withLock(`project:${projectId}`, async () => {
        const project = await this.read(projectId);
        const outline = project.outline.find((item) => item.id === chapterId);
        const previous = await this.readChapter(projectId, chapterId);
        const currentRevision = previous?.revision ?? 0;
        if (
          body.expectedRevision !== undefined &&
          body.expectedRevision !== null &&
          body.expectedRevision !== currentRevision
        ) {
          throw new StoreError(409, `正文已被改动（期望版本 ${body.expectedRevision}，实际 ${currentRevision}）`);
        }
        const content = typeof body.content === 'string' ? body.content : '';
        const revision = currentRevision + 1;
        const updatedAt = Date.now();
        const title =
          typeof body.title === 'string' && body.title.trim()
            ? body.title.trim()
            : (outline?.title ?? previous?.title ?? '未命名章');
        const summary = typeof body.summary === 'string' ? body.summary : (previous?.summary ?? '');
        const materialIds = Array.isArray(body.materialIds)
          ? body.materialIds.filter((x) => typeof x === 'string')
          : (previous?.materialIds ?? outline?.materialIds ?? []);
        const history = Array.isArray(previous?.history) ? previous.history.slice() : [];
        if (previous) {
          history.push({
            revision: currentRevision,
            title: previous.title,
            content: previous.content,
            materialIds: previous.materialIds,
            updatedAt: previous.updatedAt,
            mode: typeof body.mode === 'string' ? body.mode : 'rewrite',
          });
          if (history.length > MAX_DRAFT_HISTORY) history.splice(0, history.length - MAX_DRAFT_HISTORY);
        }
        const words = countWords(content);
        const record = { id: chapterId, title, content, summary, revision, updatedAt, materialIds, history };
        await writeJsonAtomic(this.chapterPath(projectId, chapterId), record);
        // Mirror the new counts into the skeleton right here: the workbench reads
        // only the skeleton, so a stale mirror shows the chapter as unwritten.
        project.drafts[chapterId] = {
          id: chapterId,
          title,
          summary: summary || (outline?.summary ?? ''),
          words,
          revision,
          updatedAt,
          materialIds,
          hasDraft: content.trim().length > 0,
        };
        if (outline && (outline.status === 'planned' || outline.status === 'outlined')) {
          outline.status = content.trim() ? 'drafted' : 'drafting';
        }
        // The outline row carries the material list too: the workbench draws its
        // chapter list and its side panel from the skeleton alone, so a chapter
        // that remembers its materials only in the body file would look bare.
        if (outline) outline.materialIds = materialIds.slice();
        await this.#write(project);
        return { ...record, words };
      })
    );
  }
}

