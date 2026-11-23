/**
 * Adaptation proposals — the staging area between an adapter agent and the page.
 *
 * The deciding property of the adaptation role is that **it cannot write prose**.
 * Its only exit is `propose_adaptation`, and nothing reaches the chapter body
 * until the author has looked at it and pressed accept. Rewriting the lead
 * character or switching the narration is exactly the kind of instruction whose
 * old version the author must still be able to see.
 *
 * In the original app these lived in a `Map` on the HTTP server, keyed by a
 * per-request uuid, and were lost on restart. Here they live on disk for one
 * reason: the DSH tools are stateless registrations that resolve the project
 * from `active.json`, so there is no per-turn closure to hand the accept
 * callback to. Disk is also the better answer for a 24-hour TTL — an agent turn
 * can span a restart.
 *
 * One pending proposal per chapter, deliberately: a round submits one version,
 * the author accepts or asks for changes, and a second submission supersedes the
 * first. Two live proposals for one chapter would make "the one on screen"
 * ambiguous.
 *
 *   <root>/proposals/<projectId>__<encoded chapterId>.json
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { encodeFileName, newId } from './model.js';

/** Proposals older than this are swept: a draft nobody accepted is not work. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** How many chapters' proposals may sit at once before the oldest are dropped. */
export const PROPOSAL_MAX = 200;

function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await rename(temp, path);
}

export class ProposalError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProposalError';
    this.status = status;
  }
}

export class ProposalStore {
  constructor(root) {
    this.root = root;
  }

  get dir() {
    return join(this.root, 'proposals');
  }

  /** One file per chapter, so a second submission replaces the first. */
  pathFor(projectId, chapterId) {
    return join(this.dir, `${encodeFileName(projectId)}__${encodeFileName(chapterId)}.json`);
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
    const chapterId = typeof raw.chapterId === 'string' ? raw.chapterId.trim() : '';
    if (!id || !projectId || !chapterId) return undefined;
    const changes = Array.isArray(raw.changes)
      ? raw.changes
          .filter((change) => change && typeof change.summary === 'string' && change.summary.trim())
          .map((change) => ({
            kind: typeof change.kind === 'string' ? change.kind : 'other',
            summary: change.summary.trim(),
            ...(typeof change.detail === 'string' && change.detail.trim() ? { detail: change.detail.trim() } : {}),
          }))
      : [];
    return {
      id,
      projectId,
      chapterId,
      baseRevision: Number.isFinite(raw.baseRevision) ? raw.baseRevision : 0,
      content: typeof raw.content === 'string' ? raw.content : '',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      changes,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    };
  }

  /** The pending proposal for one chapter, or undefined. */
  async read(projectId, chapterId) {
    try {
      const raw = JSON.parse(await readFile(this.pathFor(projectId, chapterId), 'utf8'));
      return this.normalize(raw);
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  /**
   * Park one proposal for one chapter, replacing any earlier one.
   *
   * `baseRevision` is recorded from the chapter as it stands *now*. Accepting
   * later compares against it, so a body edited while the author was reading
   * cannot be silently overwritten.
   */
  async submit(input) {
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) throw new ProposalError(400, '改编稿是空的，交不了');
    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    const chapterId = typeof input.chapterId === 'string' ? input.chapterId.trim() : '';
    if (!projectId || !chapterId) throw new ProposalError(400, '提案缺少作品或章节');
    const proposal = {
      id: newId(),
      projectId,
      chapterId,
      baseRevision: Number.isFinite(input.baseRevision) ? input.baseRevision : 0,
      content,
      summary: typeof input.summary === 'string' ? input.summary.trim() : '',
      changes: Array.isArray(input.changes) ? input.changes : [],
      createdAt: Date.now(),
    };
    await writeAtomic(this.pathFor(projectId, chapterId), proposal);
    return this.normalize(proposal);
  }

  async remove(projectId, chapterId) {
    await rm(this.pathFor(projectId, chapterId), { force: true });
  }

  /**
   * Drop expired and surplus proposals, then list what is left.
   *
   * Sweeping on read rather than on a timer keeps the store free of background
   * work: this plugin has no scheduler, and a stale file costs one `rm` at the
   * next look.
   */
  async list() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const now = Date.now();
    const rows = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      let proposal;
      try {
        proposal = this.normalize(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        // A half-written or hand-broken file is not worth failing a list for.
        proposal = undefined;
      }
      if (!proposal || now - proposal.createdAt > PROPOSAL_TTL_MS) {
        await rm(path, { force: true });
        continue;
      }
      rows.push(proposal);
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (rows.length > PROPOSAL_MAX) {
      for (const stale of rows.slice(PROPOSAL_MAX)) {
        await rm(this.pathFor(stale.projectId, stale.chapterId), { force: true });
      }
      return rows.slice(0, PROPOSAL_MAX);
    }
    return rows;
  }

  /** Proposals belonging to one project, newest first. */
  async forProject(projectId) {
    return (await this.list()).filter((proposal) => proposal.projectId === projectId);
  }
}
