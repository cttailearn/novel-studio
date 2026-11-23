/**
 * A cached snapshot of what the author has open right now.
 *
 * Why a cache exists at all: the prompt registry asks a section for its text
 * through a *synchronous* provider, but finding the open project means reading
 * `active.json`, `project.json` and up to two chapter bodies — all await I/O.
 * So the reads happen off the assembly path and the provider only ever reads
 * whatever was last stamped here.
 *
 * Staleness is bounded and cheap on purpose. The cache is refreshed on every
 * write the workbench makes, on every user message of the given session, and
 * after every novel tool call. A stale entry costs at most one wrong "what is
 * open" line in the opening prompt; it can never cause a wrong write, because
 * chapter writes are guarded by the revision check, not by this.
 *
 * The cache is module-level and keyed by storage root: the top-level plugin and
 * the role rows mounted inside an agent preset import the same module, so one
 * refresh is visible to both.
 */

// `adaptContextFor` pulls the original chapter out of the raw-material library
// and `adaptCursorChapterId` decides which chapter the plan is on. Both are pure
// reads; importing them here keeps the role row and the workbench agreeing about
// which chapter "now" means.
import { adaptContextFor } from './adapt.js';
import { adaptCursorChapterId } from './model.js';

/** @type {Map<string, Snapshot>} */
const cache = new Map();

/**
 * @typedef {object} Snapshot
 * @property {object|null} project      the open project skeleton
 * @property {string} chapterId         open chapter id, or '' when none
 * @property {object|undefined} chapterOutline  the open chapter's outline row
 * @property {object|undefined} previousOutline the chapter before it
 * @property {object|undefined} chapter      the open chapter's stored body
 * @property {object|undefined} previous     the previous chapter's stored body
 * @property {number} stampedAt
 */

/** An empty snapshot: nothing open, nothing known. */
export const EMPTY_SNAPSHOT = Object.freeze({
  project: null,
  chapterId: '',
  chapterOutline: undefined,
  previousOutline: undefined,
  chapter: undefined,
  previous: undefined,
  stampedAt: 0,
});

/**
 * Last stamped snapshot for one storage root.
 *
 * @param {string} root
 * @returns {Snapshot}
 */
export function readSnapshot(root) {
  return cache.get(root) ?? EMPTY_SNAPSHOT;
}

/**
 * Re-read the open project, its open chapter and the chapter before it.
 *
 * A missing pointer, a project deleted since it was opened, and an unreadable
 * chapter body all settle as "nothing there" — none of them is worth throwing
 * at a prompt build.
 *
 * @param {{ root: string, readActive: () => Promise<{projectId: string, chapterId: string}|undefined>, read: (id: string) => Promise<object>, readChapter: (projectId: string, chapterId: string) => Promise<object|undefined> }} store
 * @returns {Promise<Snapshot>}
 */
export async function refreshSnapshot(store) {
  const previousSnapshot = readSnapshot(store.root);
  /** @type {Snapshot} */
  let snapshot = { ...EMPTY_SNAPSHOT, stampedAt: Date.now() };
  try {
    const active = await store.readActive();
    if (!active || !active.projectId) {
      cache.set(store.root, snapshot);
      return snapshot;
    }
    const project = await store.read(active.projectId);
    const chapterId = active.chapterId;
    const index = chapterId ? project.outline.findIndex((row) => row.id === chapterId) : -1;
    const chapterOutline = index >= 0 ? project.outline[index] : undefined;
    const previousOutline = index > 0 ? project.outline[index - 1] : undefined;
    const chapter = chapterOutline ? await store.readChapter(active.projectId, chapterOutline.id) : undefined;
    const previous = previousOutline ? await store.readChapter(active.projectId, previousOutline.id) : undefined;
    snapshot = {
      project,
      chapterId: chapterOutline ? chapterOutline.id : '',
      chapterOutline,
      previousOutline,
      chapter,
      previous,
      stampedAt: Date.now(),
    };
  } catch {
    // A failed refresh keeps the last good answer rather than blanking the
    // prompt: the author mid-edit is better served by a slightly old brief
    // than by one that says "no project open".
    snapshot = previousSnapshot;
  }
  cache.set(store.root, snapshot);
  return snapshot;
}

/**
 * Refresh without blocking the caller.
 *
 * Used from event handlers, which must not delay a turn for a cache fill.
 * Overlapping calls collapse: a refresh already in flight for the same root is
 * reused instead of queueing another disk walk.
 *
 * @param {Parameters<typeof refreshSnapshot>[0]} store
 * @returns {Promise<Snapshot>}
 */
const inFlight = new Map();

export function kickSnapshot(store) {
  const running = inFlight.get(store.root);
  if (running) return running;
  const task = refreshSnapshot(store).finally(() => inFlight.delete(store.root));
  inFlight.set(store.root, task);
  return task;
}

/**
 * Drop a root's snapshot, e.g. after its project directory was removed.
 *
 * @param {string} root
 */
export function forgetSnapshot(root) {
  cache.delete(root);
  inFlight.delete(root);
  adaptCache.delete(root);
  adaptInFlight.delete(root);
}

// ---------------------------------------------------------------- adaptation
//
// The adapter's prompt carries the chapter's **original text**, which can run to
// tens of thousands of characters. Reading it on the assembly path is not an
// option — `systemPrompt.section()` is synchronous — so it is stamped here the
// same way the workbench pointer is, and only for adaptation projects.
//
// It is refreshed on `PUT /active`, after an accept or a rename, and once at
// boot. Between those points the original cannot change: it is an uploaded file
// the author only edits by deleting and re-importing the whole book.

/** @type {Map<string, {project: object, ctx: object}|undefined>} */
const adaptCache = new Map();
const adaptInFlight = new Map();

/**
 * The cached adaptation context for one storage root, if any.
 *
 * @param {string} root
 * @returns {{project: object, ctx: object}|undefined}
 */
export function readAdaptContext(root) {
  return adaptCache.get(root);
}

/**
 * Rebuild the adaptation context for whatever the author has open.
 *
 * A project that is not an adaptation project, or one with no chapter selected,
 * clears the entry rather than keeping an old chapter's original around: a
 * prompt that shows the wrong chapter's text is worse than one that says "pick
 * a chapter".
 *
 * @param {{ root: string, readActive: () => Promise<{projectId: string, chapterId: string}|undefined>, read: (id: string) => Promise<object> }} store
 * @param {{ read: (id: string) => Promise<object|undefined>, readChapter: (id: string, chapterId: string) => Promise<object|undefined> }} sources
 * @returns {Promise<{project: object, ctx: object}|undefined>}
 */
export async function refreshAdaptContext(store, sources) {
  /** @type {{project: object, ctx: object}|undefined} */
  let context;
  try {
    const active = await store.readActive();
    if (active && active.projectId) {
      const project = await store.read(active.projectId);
      if (project.adaptation) {
        const chapterId = active.chapterId || adaptCursorChapterId(project);
        if (chapterId) {
          context = { project, ctx: await adaptContextFor(store, sources, project, chapterId) };
        }
      }
    }
  } catch {
    // Same rule as the workbench snapshot: a failed refresh clears the entry
    // instead of pinning a chapter the author may have already moved past.
    context = undefined;
  }
  if (context) adaptCache.set(store.root, context);
  else adaptCache.delete(store.root);
  return context;
}

/**
 * Refresh the adaptation context without blocking the caller.
 *
 * @param {Parameters<typeof refreshAdaptContext>[0]} store
 * @param {Parameters<typeof refreshAdaptContext>[1]} sources
 * @returns {Promise<unknown>}
 */
export function kickAdaptContext(store, sources) {
  const running = adaptInFlight.get(store.root);
  if (running) return running;
  const task = refreshAdaptContext(store, sources).finally(() => adaptInFlight.delete(store.root));
  adaptInFlight.set(store.root, task);
  return task;
}
