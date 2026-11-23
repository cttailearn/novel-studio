/**
 * Disk storage for the raw-material library.
 *
 * Layout, under the same root as the projects:
 *
 *   <root>/sources/<id>/meta.json           chapters, sizes, split mode
 *   <root>/sources/<id>/chapters/<k>.txt    one chapter's body, plain text
 *
 * Bodies are `.txt`, not JSON, for the same reason chapter drafts are separate
 * files: a 4000-chapter reference book must never be read as one blob, and a
 * human can open the folder and read it.
 *
 * Listing scans the directory instead of keeping an index file. Sources are
 * added rarely and read often, so the scan is cheaper than a second source of
 * truth that could disagree with the files on disk.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSourceMeta, normalizeSourceMeta, searchSourceChapter, sourceTokens, splitSourceText } from './sources.js';

export class SourceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
  }
}

function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export class SourceLibrary {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
  }

  /** @param {string} id */
  dir(id) {
    return join(this.root, 'sources', id);
  }

  /** @param {string} id */
  metaPath(id) {
    return join(this.dir(id), 'meta.json');
  }

  /**
   * @param {string} id
   * @param {string} chapterId
   */
  chapterPath(id, chapterId) {
    return join(this.dir(id), 'chapters', `${chapterId}.txt`);
  }

  /**
   * Read one source's metadata.
   *
   * @param {string} id
   * @returns {Promise<import('./sources.js').SourceMeta | undefined>}
   */
  async read(id) {
    const text = await readText(this.metaPath(id));
    if (text === undefined) return undefined;
    try {
      return normalizeSourceMeta(JSON.parse(text));
    } catch {
      // A corrupt file is reported as missing rather than crashing a list.
      return undefined;
    }
  }

  /** Every source, newest first. Corrupt directories are skipped. */
  async list() {
    let entries;
    try {
      entries = await readdir(join(this.root, 'sources'), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const sources = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.read(entry.name);
      if (meta) sources.push(meta);
    }
    return sources.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Store a new source: decode nothing here (the caller decodes), split, write
   * bodies, then the metadata last so a half-written source is never listed.
   *
   * @param {{ title?: string, filename: string, kind?: 'document' | 'novel', encoding?: string, text: string, splitMode?: 'single' | 'chapters' | 'fixed', fixedChars?: number }} input
   */
  async create(input) {
    if (typeof input?.text !== 'string') throw new SourceError(400, '原料正文缺失');
    // A plain document is one block by definition: splitting it into "chapters"
    // would invent structure the file does not claim. Upstream forces this the
    // same way, and `normalizeSourceMeta` keeps enforcing it on read.
    const kind = input.kind === 'document' ? 'document' : 'novel';
    const splitMode = kind === 'document' ? 'single' : input.splitMode;
    const split = splitSourceText(input.text, { splitMode, fixedChars: input.fixedChars });
    const meta = makeSourceMeta({ ...input, kind }, split);
    const directory = this.dir(meta.id);
    await mkdir(join(directory, 'chapters'), { recursive: true });
    for (let i = 0; i < split.chapters.length; i++) {
      const chapter = split.chapters[i];
      await writeFile(this.chapterPath(meta.id, meta.chapters[i].id), chapter.content, 'utf8');
    }
    await writeFile(join(directory, 'meta.json'), JSON.stringify(meta, null, '\t'), 'utf8');
    return meta;
  }

  /**
   * Delete one source and its bodies.
   *
   * @param {string} id
   */
  async remove(id) {
    const meta = await this.read(id);
    if (!meta) throw new SourceError(404, '原料不存在');
    await rm(this.dir(id), { recursive: true, force: true });
    return { ok: true };
  }

  /**
   * Read one chapter body.
   *
   * @param {string} id
   * @param {string} chapterId
   */
  async readChapter(id, chapterId) {
    const meta = await this.read(id);
    if (!meta) return undefined;
    const row = meta.chapters.find((chapter) => chapter.id === chapterId);
    if (!row) return undefined;
    const content = (await readText(this.chapterPath(id, chapterId))) ?? '';
    return { id: row.id, index: row.index, title: row.title, content, chars: row.chars };
  }

  /**
   * Search one source. Every chapter is read, because a snippet must come from
   * the body and the body is exactly what the metadata does not hold.
   *
   * @param {string} id
   * @param {string} query
   * @param {{ limit?: number }} [options]
   */
  async search(id, query, options = {}) {
    const meta = await this.read(id);
    if (!meta) throw new SourceError(404, '原料不存在');
    const tokens = sourceTokens(query);
    if (tokens.length === 0) return [];
    const limit = Math.max(1, Math.min(50, options.limit ?? 6));
    const hits = [];
    for (const row of meta.chapters) {
      const content = (await readText(this.chapterPath(id, row.id))) ?? '';
      const hit = searchSourceChapter({ id: row.id, title: row.title, content }, tokens);
      if (hit) hits.push(hit);
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
