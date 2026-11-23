/**
 * Role-row tests: snapshot cache + what a role actually registers.
 *
 * The interesting claims are: the prompt section is `complete` (it replaces the
 * harness persona rather than appending to it), it renders from the live
 * snapshot on every call, and each role registers exactly its own tool slice —
 * the writing role must never see `upsert_material`, and vice versa.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProjectStore } from './lib/store.js';
import { emptyProject, newId } from './lib/model.js';
import { createToolSet } from './lib/tools.js';
import { SourceLibrary } from './lib/source-store.js';
import { ProposalStore } from './lib/proposals.js';
import { createAdaptTools } from './lib/adapt.js';
import {
  EMPTY_SNAPSHOT,
  forgetSnapshot,
  kickSnapshot,
  readAdaptContext,
  readSnapshot,
  refreshAdaptContext,
  refreshSnapshot,
} from './lib/live.js';
import { ROLES, ROLE_SERVICE, defineRole } from './lib/role-kit.js';
import materialRole from './lib/role-material.js';
import writingRole from './lib/role-writing.js';
import adaptRole from './lib/role-adapt.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(here, '.test-role-'));

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
}

/** Minimal cordis-shaped context: just what a role row touches. */
function makeCtx(services) {
  const registered = [];
  const sections = [];
  return {
    registered,
    sections,
    ctx: {
      get: (name) => services[name],
      effect: (fn) => {
        const stop = fn();
        return () => (typeof stop === 'function' ? stop() : undefined);
      },
      logger: { warn: (message) => registered.push({ warning: message }), info: () => {} },
      tools: { register: (definition) => (registered.push(definition), () => {}) },
      systemPrompt: {
        getSectionOrder: (name) => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 1),
        section: (section) => (sections.push(section), () => {}),
      },
    },
  };
}

try {
  const store = new ProjectStore(root);

  // --- snapshot before anything exists ------------------------------------
  ok('empty snapshot is frozen', Object.isFrozen(EMPTY_SNAPSHOT));
  ok('no snapshot before first refresh', readSnapshot(root) === EMPTY_SNAPSHOT);
  const first = await refreshSnapshot(store);
  ok('no active pointer → project null', first.project === null);
  ok('no active pointer → chapter empty', first.chapterId === '');

  // --- one project, three chapters ---------------------------------------
  const project = emptyProject({ title: '雨夜', genre: '悬疑', styleGuide: '冷硬，短句' });
  const chapterA = { id: newId(), title: '第一章', summary: '雨夜命案', status: 'outlined', materialIds: [] };
  const chapterB = { id: newId(), title: '第二章', summary: '追查', status: 'outlined', materialIds: [] };
  const chapterC = { id: newId(), title: '第三章', summary: '收网', status: 'planned', materialIds: [] };
  project.outline.push(chapterA, chapterB, chapterC);
  const material = {
    id: newId(),
    kind: 'character',
    title: '周砚',
    content: '刑侦支队长。左肩有一道旧疤。',
    usage: '写审讯戏时交代他的旧伤',
    tags: [],
    status: 'confirmed',
    chapterIds: [chapterB.id],
    source: 'human',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  project.materials.push(material);
  project.outline[1].materialIds = [material.id];
  project.notes.push({
    id: newId(),
    severity: 'warning',
    category: '设定',
    subject: '周砚年龄',
    description: '没定',
    status: 'open',
    createdAt: Date.now(),
  });
  await store.create(project);
  // `create` always mints a fresh id, so the stored copy — not the seed — is
  // what every later call must address.
  const stored = (await store.list())[0];
  ok('create minted a project id', typeof stored?.id === 'string' && stored.id.length > 0);
  await store.writeChapter(stored.id, chapterA.id, { title: '第一章', content: '雨夜，灯下。', summary: '雨夜命案' });

  // --- what the workbench writes when it opens chapter 2 ------------------
  await store.writeActive({ projectId: stored.id, chapterId: chapterB.id });
  const snapshot = await refreshSnapshot(store);
  ok('snapshot finds the project', snapshot.project?.id === stored.id);
  ok('snapshot finds the open chapter row', snapshot.chapterOutline?.id === chapterB.id);
  ok('snapshot resolves the previous row', snapshot.previousOutline?.id === chapterA.id);
  ok('snapshot loads the previous body', snapshot.previous?.content === '雨夜，灯下。');
  ok('open chapter has no body yet', snapshot.chapter === undefined);
  ok('readSnapshot sees the stamped value', readSnapshot(root) === snapshot);
  ok('kick dedupes onto the in-flight refresh', typeof kickSnapshot(store).then === 'function');
  await kickSnapshot(store);

  // --- the service the top-level plugin publishes -------------------------
  const tools = createToolSet({ store, resolveProject: async (id) => (id ? id : (await store.readActive())?.projectId ?? '') });
  const service = {
    tools,
    store,
    snapshot: () => readSnapshot(root),
    refresh: () => refreshSnapshot(store),
    kick: () => kickSnapshot(store),
  };

  // --- material role ------------------------------------------------------
  const materialCtx = makeCtx({ [ROLE_SERVICE]: service, tools: undefined, systemPrompt: undefined, userQuestions: {} });
  // `inject` names resolve through ctx.get in this stand-in, so give them the
  // same objects the real context would expose.
  materialCtx.ctx.get = (name) => (name === ROLE_SERVICE ? service : name === 'userQuestions' ? {} : materialCtx.ctx[name]);
  materialRole.apply(materialCtx.ctx);

  const materialNames = materialCtx.registered.map((row) => row.name).filter(Boolean).sort();
  ok('material role registers shared+material only', materialNames.length === 11);
  ok('material role has upsert_material', materialNames.includes('upsert_material'));
  ok('material role has attach_materials', materialNames.includes('attach_materials'));
  ok('material role has update_outline', materialNames.includes('update_outline'));
  ok('material role cannot write chapters', !materialNames.includes('write_chapter'));
  ok('material role cannot append', !materialNames.includes('append_chapter'));
  ok('material role cannot revise', !materialNames.includes('revise_chapter'));
  ok('material role warns nothing', materialCtx.registered.every((row) => !row.warning));

  ok('material role registers one section', materialCtx.sections.length === 1);
  const materialSection = materialCtx.sections[0];
  ok('material section replaces the prompt', materialSection.complete === true);
  ok('material section stands at persona order', materialSection.order === 0);
  ok('material section name is namespaced', materialSection.name === 'novel-studio:material');

  const materialText = materialSection.text();
  ok('material prompt names the project', materialText.includes('雨夜'));
  ok('material prompt names the style', materialText.includes('冷硬，短句'));
  ok('material prompt carries the material index', materialText.includes('周砚'));
  ok('material prompt carries the open notes', materialText.includes('周砚年龄'));
  ok('material prompt forbids prose writing', materialText.includes('不写正文'));
  // hasAskTool is live: no userQuestions service means the note fallback.
  const noAsk = materialSection.text();
  ok('material prompt falls back when no ask tool', noAsk.length > 0);

  // --- writing role -------------------------------------------------------
  const writingCtx = makeCtx({});
  writingCtx.ctx.get = (name) => (name === ROLE_SERVICE ? service : name === 'userQuestions' ? {} : undefined);
  writingRole.apply(writingCtx.ctx);

  const writingNames = writingCtx.registered.map((row) => row.name).filter(Boolean).sort();
  ok('writing role registers shared+writing only', writingNames.length === 11);
  ok('writing role has write_chapter', writingNames.includes('write_chapter'));
  ok('writing role has append_chapter', writingNames.includes('append_chapter'));
  ok('writing role has revise_chapter', writingNames.includes('revise_chapter'));
  ok('writing role cannot upsert materials', !writingNames.includes('upsert_material'));
  ok('writing role cannot attach materials', !writingNames.includes('attach_materials'));
  ok('writing role cannot change the outline', !writingNames.includes('update_outline'));

  const writingText = writingCtx.sections[0].text();
  ok('writing prompt names the chapter', writingText.includes('第二章'));
  ok('writing prompt names the chapter summary', writingText.includes('追查'));
  ok('writing prompt carries the attached material', writingText.includes('左肩有一道旧疤'));
  ok('writing prompt carries the previous chapter tail', writingText.includes('雨夜，灯下。'));
  ok('writing prompt forbids inventing facts', writingText.includes('只用上面的素材'));

  // --- no chapter open ----------------------------------------------------
  await store.writeActive({ projectId: stored.id, chapterId: '' });
  await refreshSnapshot(store);
  const noChapter = writingCtx.sections[0].text();
  ok('writing prompt asks for a chapter when none is open', noChapter.includes('没有选中章节'));
  ok('writing prompt does not invent a chapter', !noChapter.includes('第二章'));

  // --- no project open ----------------------------------------------------
  await store.writeActive({ projectId: '', chapterId: '' });
  await refreshSnapshot(store);
  ok('material prompt asks for a project', materialCtx.sections[0].text().includes('没有打开任何作品'));
  ok('writing prompt asks for a project', writingCtx.sections[0].text().includes('没有打开任何作品'));

  // --- adaptation: a book in the library, a project bound to it -----------
  const sources = new SourceLibrary(root);
  const proposals = new ProposalStore(root);
  const book = await sources.create({
    title: '旧雨',
    filename: 'old-rain.txt',
    text: '第一章 开端\n雨夜，灯下。周砚蹲下去，看清了那张脸。\n\n第二章 追查\n他顺着脚印走到河边。',
  });
  ok('the book split into chapters', book.chapterCount === 2);
  ok('the book used heading split', book.splitMode === 'chapters');
  const [sourceChapterA, sourceChapterB] = book.chapters;

  const adaptSeed = emptyProject({ title: '旧雨·改编' });
  adaptSeed.adaptation = {
    sourceId: book.id,
    sourceTitle: book.title,
    brief: '把主角换成女刑警，人称不变。',
    cursor: sourceChapterA.id,
    changes: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  adaptSeed.outline = book.chapters.map((chapter) => ({
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
  await store.create(adaptSeed);
  const adaptStored = (await store.list()).find((row) => row.title === '旧雨·改编');
  ok('adaptation project was stored', typeof adaptStored?.id === 'string');

  const adaptTools = createAdaptTools({
    store,
    sources,
    proposals,
    resolveProject: async () => adaptStored.id,
    resolveChapter: async () => sourceChapterA.id,
  });
  ok('adapter has five tools', adaptTools.length === 5);
  ok('adapter tool names are the upstream ones',
    adaptTools.map((definition) => definition.name).sort().join(',')
      === 'propose_adaptation,read_adapted_chapter,read_original_chapter,rename_chapter,search_adaptation_changes');
  // The distinction from the drafter: nothing that writes prose.
  for (const forbidden of ['write_chapter', 'append_chapter', 'revise_chapter', 'update_outline']) {
    ok(`adapter has no ${forbidden}`, !adaptTools.some((definition) => definition.name === forbidden));
  }

  const readOriginal = adaptTools.find((definition) => definition.name === 'read_original_chapter');
  const originalValue = await readOriginal.execute({});
  ok('read_original_chapter returns the original prose',
    originalValue.text.includes('雨夜，灯下。周砚蹲下去'));
  const readAdapted = adaptTools.find((definition) => definition.name === 'read_adapted_chapter');
  const notYet = await readAdapted.execute({});
  ok('read_adapted_chapter says nothing is written yet', notYet.text.includes('还没有改编稿'));

  const propose = adaptTools.find((definition) => definition.name === 'propose_adaptation');
  await propose.execute({
    content: '雨夜，灯下。林晚蹲下去，看清了那张脸。',
    summary: '把周砚换成林晚，其余照抄。',
    changes: [{ kind: 'character', summary: '主角周砚改为林晚', detail: '只换名字与代词' }],
  });
  const pending = await proposals.read(adaptStored.id, sourceChapterA.id);
  ok('the proposal was parked, not written', typeof pending?.id === 'string');
  ok('the proposal records the baseline revision', pending.baseRevision === 0);
  const beforeAccept = await store.readChapter(adaptStored.id, sourceChapterA.id);
  ok('the chapter body is still empty before accept', beforeAccept === undefined);

  // --- the adapter role row ------------------------------------------------
  const adaptCtx = makeCtx({});
  const adaptService = {
    tools: { ...tools, adapt: adaptTools },
    store,
    sources,
    adapt: () => readAdaptContext(root),
  };
  adaptCtx.ctx.get = (name) => (name === ROLE_SERVICE ? adaptService : name === 'userQuestions' ? {} : undefined);
  // Nothing open yet: the prompt must say so rather than quote a chapter.
  ok('no adaptation context before refresh', readAdaptContext(root) === undefined);
  adaptRole.apply(adaptCtx.ctx);
  ok('adapter role registers its five tools', adaptCtx.registered.filter((row) => row.name).length === 5);
  ok('adapter role has no writing tool',
    !adaptCtx.registered.some((row) => ['write_chapter', 'update_outline', 'upsert_material'].includes(row.name)));
  ok('adapter section replaces the prompt', adaptCtx.sections[0].complete === true);
  ok('adapter section name is namespaced', adaptCtx.sections[0].name === 'novel-studio:adapt');
  ok('adapter prompt asks for an adaptation project', adaptCtx.sections[0].text().includes('没有可以改编的章节'));

  await store.writeActive({ projectId: adaptStored.id, chapterId: sourceChapterA.id });
  await refreshAdaptContext(store, sources);
  const stamped = readAdaptContext(root);
  ok('adaptation context finds the project', stamped?.project?.id === adaptStored.id);
  ok('adaptation context carries the original chapter', stamped?.ctx?.original?.content.includes('雨夜，灯下。'));
  ok('adaptation context knows the chapter index', stamped?.ctx?.index === 0);

  const adaptText = adaptCtx.sections[0].text();
  ok('adapter prompt goes straight into the role', adaptText.startsWith('# 角色'));
  ok('adapter prompt quotes the original', adaptText.includes('周砚蹲下去'));
  ok('adapter prompt carries the brief', adaptText.includes('把主角换成女刑警'));
  ok('adapter prompt forbids gratuitous rewriting', adaptText.includes('改动是例外，不是义务'));
  ok('adapter prompt lists the submission tool', adaptText.includes('propose_adaptation'));

  // --- accepting the proposal --------------------------------------------
  const { acceptProposal } = await import('./lib/adapt.js');
  const accepted = await acceptProposal({
    store,
    proposals,
    projectId: adaptStored.id,
    chapterId: sourceChapterA.id,
    proposalId: pending.id,
  });
  ok('accept writes the chapter', accepted.chapter?.hasDraft === true);
  ok('accept bumps the revision', accepted.chapter?.revision === 1);
  ok('accept records the ledger entry', accepted.adaptation.changes.length === 1);
  ok('the ledger keeps the change kind', accepted.adaptation.changes[0].kind === 'character');
  ok('accept advances the cursor', accepted.adaptation.cursor === sourceChapterB.id);
  ok('accept clears the proposal', (await proposals.read(adaptStored.id, sourceChapterA.id)) === undefined);
  const afterAccept = await store.readChapter(adaptStored.id, sourceChapterA.id);
  ok('accept wrote the prose to disk', afterAccept?.content.includes('林晚蹲下去'));

  // A second accept for the same chapter is the "author went back" path, which
  // is allowed only because the chapter already has a draft. This one has no
  // proposal id, so it is a hand edit — and a hand edit is exactly what the
  // ledger must record, or an adapter two chapters on cannot see it happened.
  const second = await acceptProposal({
    store,
    proposals,
    projectId: adaptStored.id,
    chapterId: sourceChapterA.id,
    content: '雨夜，灯下。林晚蹲下去，看清了那张脸。她没说话。',
    summary: '加一句心理留白。',
    changes: [{ kind: 'style', summary: '章末补一句留白' }],
  });
  ok('re-accepting an adapted chapter is allowed', second.chapter?.revision === 2);
  const secondLedger = second.adaptation.changes.filter((change) => change.chapterId === sourceChapterA.id);
  ok('re-accept drops the previous version\'s changes', !secondLedger.some((change) => change.summary === '主角周砚改为林晚'));
  ok('re-accept keeps the new changes', secondLedger.some((change) => change.kind === 'style'));
  ok('a hand edit lands in the ledger too', secondLedger.some((change) => change.kind === 'other'));

  // Going back to fix an accepted chapter must not rewind the pen: the cursor is
  // what tells the adapter which chapter "now" means.
  ok('re-accepting never moves the cursor backwards',
    (await store.read(adaptStored.id)).adaptation.cursor === sourceChapterB.id);

  // --- restoring a chapter to the original -------------------------------
  const restored = await acceptProposal({
    store,
    proposals,
    projectId: adaptStored.id,
    chapterId: sourceChapterA.id,
    restore: true,
  });
  ok('restore empties the chapter body', (await store.readChapter(adaptStored.id, sourceChapterA.id))?.content === '');
  ok('restore drops the chapter status back to planned',
    restored.adaptation && (await store.read(adaptStored.id)).outline.find((row) => row.id === sourceChapterA.id).status === 'planned');
  // The old summary would be a lie once the chapter is the original text again.
  ok('restore clears the summary', (await store.read(adaptStored.id)).drafts[sourceChapterA.id]?.summary === '');
  ok('restore pulls the cursor back to the chapter', restored.adaptation.cursor === sourceChapterA.id);
  ok('restore drops that chapter\'s changes',
    !restored.adaptation.changes.some((change) => change.chapterId === sourceChapterA.id && change.kind !== 'title'));

  // A queue jump is still refused: with the cursor back on chapter one, chapter
  // two has no draft, so accepting it out of order must 409.
  let jumped = '';
  try {
    await acceptProposal({
      store,
      proposals,
      projectId: adaptStored.id,
      chapterId: sourceChapterB.id,
      content: '抢跑的一版',
      changes: [],
    });
    jumped = 'accepted';
  } catch (error) {
    jumped = error.message;
  }
  ok('a queue jump is refused', jumped !== 'accepted');
  ok('the refusal explains which chapter is due', jumped.includes('一章一章'));

  // --- forgetting ---------------------------------------------------------
  forgetSnapshot(root);
  ok('forget drops the cache', readSnapshot(root) === EMPTY_SNAPSHOT);
  ok('forget drops the adaptation context', readAdaptContext(root) === undefined);

  // --- role table sanity --------------------------------------------------
  ok('role table lists every role', Object.keys(ROLES).sort().join(',') === 'adapt,material,writing');
  ok('role row id is namespaced', defineRole('material').name === 'novel-studio/material');
  ok('adapt role is namespaced too', defineRole('adapt').name === 'novel-studio/adapt');

  // --- a deleted project degrades to "nothing open" -----------------------
  await store.writeActive({ projectId: stored.id, chapterId: chapterB.id });
  await store.remove(stored.id);
  const afterRemoval = await refreshSnapshot(store);
  ok('deleted project degrades to null', afterRemoval.project === null);

  console.log(`ROLE OK — ${checks} checks`);
} finally {
  await rm(root, { recursive: true, force: true });
}
