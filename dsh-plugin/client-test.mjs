// Headless exercise of lib/client.js with a React stand-in.
import { readFile } from 'node:fs/promises';

// ---- React stand-in (hook order + dep memoization, like React)
const cells = [];
let cursor = 0;
let pending = [];
const sameDeps = (a, b) => !!(a && b && a.length === b.length && a.every((v, i) => v === b[i]));
function useState(initial) {
  const i = cursor++;
  if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
  return [cells[i], (n) => { cells[i] = typeof n === 'function' ? n(cells[i]) : n; }];
}
function useEffect(fn, deps) {
  const i = cursor++;
  const p = cells[i];
  if (p && sameDeps(p.deps, deps)) return;
  cells[i] = { deps };
  pending.push(fn);
}
function useCallback(fn, deps) {
  const i = cursor++;
  const p = cells[i];
  if (p && sameDeps(p.deps, deps)) return p.value;
  cells[i] = { deps, value: fn };
  return fn;
}
function useMemo(fn, deps) {
  const i = cursor++;
  const p = cells[i];
  if (p && sameDeps(p.deps, deps)) return p.value;
  const v = fn();
  cells[i] = { deps, value: v };
  return v;
}
const React = {
  createElement: (type, props, ...children) =>
    typeof type === 'function' ? type({ ...(props || {}), children }) : { type, props: { ...(props || {}), children } },
  useState, useEffect, useCallback, useMemo,
};

// ---- fake browser
let captured = null;
const inserted = [];
globalThis.window = {
  __ModuleLoader__: { load(d) { captured = d; } },
  addEventListener() {}, removeEventListener() {}, confirm: () => true,
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild(el) { inserted.push(el); } },
  baseURI: 'http://127.0.0.1:3080/',
};

// ---- fake API over the real route shapes
const project = {
  id: 'p1', title: '雨夜', genre: '推理', logline: '一句话', synopsis: '', styleGuide: '冷硬', targetWords: 90000,
  materials: [{
    id: 'm1', kind: 'character', title: '林越', content: '侦探，失眠', usage: '出场时',
    tags: [], status: 'confirmed', chapterIds: [], source: 'human',
  }],
  volumes: [],
  outline: [{
    id: 'c1', title: '第一章', summary: '雨夜命案', pov: '林越', volumeId: '',
    status: 'drafting', targetWords: 3000, notes: '', materialIds: ['m1'],
  }],
  notes: [{
    id: 'n1', severity: 'warning', category: '细节', subject: '眼睛颜色',
    description: '第三章写过是灰的', status: 'open',
  }],
  adaptation: null, createdAt: '', updatedAt: '',
};
const chapter = {
  id: 'c1', title: '第一章', content: '雨夜，灯下。', summary: '雨夜命案',
  revision: 3, materialIds: ['m1'], updatedAt: '',
};
const urls = [];
let savedPayload = null;
let uploaded = false;
let searched = null;
let deleted = null;
let accepted = null;
let createdFrom = null;
let removedProject = null;
const ok = (extra) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...extra }) });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  urls.push(`${method} ${u.replace('http://127.0.0.1:3080', '')}`);
  if (method === 'PUT' && u.includes('/chapters/c1')) {
    savedPayload = JSON.parse(init.body);
    return ok({ chapter: { ...chapter, ...savedPayload, revision: chapter.revision + 1 } });
  }
  // Removing a book. `keptFiles` decides the notice: an external project is
  // only unlisted, and telling the author "deleted" would send them hunting for
  // a folder that never went anywhere. It has to be answered before the project
  // reads below, or a DELETE gets served as if it were a GET.
  if (method === 'DELETE' && /\/projects\/[^/]+$/.test(u)) {
    const id = u.split('/projects/')[1];
    removedProject = { id, keptFiles: id === 'p2' };
    return ok({ ok: true, keptFiles: id === 'p2' });
  }
  if (u.endsWith('/projects')) {
    if (method === 'POST') {
      createdFrom = JSON.parse(init.body);
      return ok({
        project: { ...project, id: 'p3', title: '新改编', adaptation: { sourceId: 's1' } },
        chapters: [{ id: 'ch001', title: '第一章 雨夜', status: 'planned', words: 0 }],
      });
    }
    return ok({
      root: '/x',
      projects: [
        { id: 'p1', title: '雨夜', genre: '推理', words: 6, chapters: 1 },
        { id: 'p2', title: '旧雨·改编', genre: '改编', words: 0, chapters: 1, dir: 'D:\\小说\\旧雨' },
      ],
    });
  }
  // The adaptation project: one chapter bound to a chapter of the uploaded book.
  if (u.endsWith('/projects/p2')) {
    return ok({
      project: {
        ...project,
        id: 'p2',
        title: '旧雨·改编',
        adaptation: { sourceId: 's1', sourceTitle: '素材书', brief: '换成女刑警', cursor: 'c2', changes: [], createdAt: '', updatedAt: '' },
        outline: [{ id: 'c2', title: '第一章 雨夜', summary: '', pov: '', volumeId: '', status: 'planned', targetWords: 3000, notes: '', materialIds: [] }],
        drafts: {},
      },
      chapters: [{ id: 'c2', title: '第一章 雨夜', status: 'planned', words: 0, hasDraft: false, revision: 0 }],
      stats: { words: 0, chapters: 1 },
    });
  }
  if (u.includes('/projects/p2/chapters/c2/adapt')) {
    if (method === 'POST') {
      accepted = JSON.parse(init.body);
      return ok({
        chapter: { id: 'c2', title: '第一章 雨夜', content: accepted.content, revision: 1, materialIds: [], hasDraft: true },
        adaptation: { sourceId: 's1', sourceTitle: '素材书', brief: '换成女刑警', cursor: '', changes: [], createdAt: '', updatedAt: '' },
        chapters: [{ id: 'c2', title: '第一章 雨夜', status: 'drafted', words: 6, hasDraft: true, revision: 1 }],
      });
    }
    return ok({
      chapter: { id: 'c2', title: '第一章 雨夜' },
      original: { id: 'c2', title: '第一章 雨夜', content: '雨夜，灯下。周砚蹲下去，看清了那张脸。', chars: 18 },
      current: null,
      proposal: {
        id: 'ap1', chapterId: 'c2', baseRevision: 0,
        content: '雨夜，灯下。林晚蹲下去，看清了那张脸。',
        summary: '换成林晚', changes: [{ kind: 'character', summary: '周砚改为林晚' }],
      },
      cursor: 'c2',
      open: true,
    });
  }
  if (u.includes('/projects/p2/chapters/c2')) {
    return ok({ chapter: { id: 'c2', title: '第一章 雨夜', content: '', summary: '', revision: 0, materialIds: [] } });
  }
  if (u.endsWith('/projects/p2/adaptation')) return ok({ adaptation: { sourceId: 's1' }, source: null });
  if (u.includes('/sources/upload')) {
    uploaded = true;
    return ok({ source: { id: 's2', title: '新书', chapterCount: 2, filename: 'new.txt' } });
  }
  if (u.includes('/sources/s1/search')) {
    searched = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
    return ok({
      hits: [
        { chapterId: 'ch001', title: '第一章 雨夜', score: 12, snippet: '周砚蹲下去，看清了那张脸。' },
      ],
    });
  }
  if (u.endsWith('/sources')) {
    return ok({
      sources: [
        { id: 's1', title: '素材书', filename: 'book.txt', chapterCount: 3, kind: 'novel', splitMode: 'chapters' },
      ],
    });
  }
  if (u.includes('/sources/') && method === 'DELETE') {
    deleted = u.split('/sources/')[1];
    return ok({});
  }
  // The host remembers what was open, so the panel must reopen it by itself.
  if (u.endsWith('/active')) return ok({ active: { projectId: 'p1', chapterId: 'c1' } });
  if (u.endsWith('/projects/p1')) {
    return ok({ project, chapters: [{ id: 'c1', title: '第一章', status: 'drafting', words: 6, hasDraft: true, revision: 3 }], stats: { words: 6, chapters: 1 } });
  }
  if (u.includes('/chapters/c1')) return ok({ chapter });
  if (u.endsWith('/kinds')) return ok({ kinds: [] });
  return ok({});
};

// ---- load the bundle exactly as the shell does
new Function('window', 'document', 'fetch', 'styles', 'console', 'URL', await readFile('./lib/client.js', 'utf8'))(
  globalThis.window, globalThis.document, globalThis.fetch, { insert: () => () => {} }, console, URL
);
console.log('module id:', captured.id);

const regs = [];
let pickCalls = 0;
const sessions = [];
const panels = [];
// A shell that reports Workspaces. The last case empties this list to prove the
// panel refuses to claim a session it could not open.
const shell = { workspaceCount: 1 };
const ctx = {
  slots: {
    inject: (key, cb) => { regs.push([key, cb]); return () => {}; },
    register: (options, component) => ({ options, component }),
  },
  get: (n) => {
    if (n === 'locale') return { getLocale: () => 'zh', subscribe: () => () => {} };
    // The host's own folder chooser. Only the Client-side service can hand back
    // a real path, so the workbench must reach it through ctx rather than
    // through a file input.
    if (n === 'uiWorkspace') {
      return {
        pickDirectory: async () => { pickCalls += 1; return 'D:\\小说\\雨夜'; },
        // The three AI steps open a role Session rather than calling a model
        // from here, so this is the one call that proves they are wired to the
        // shipped agent presets.
        startSession: (workspaceId, options) => {
          sessions.push({ workspaceId: workspaceId === undefined ? null : workspaceId, ...options });
        },
      };
    }
    if (n === 'layout') {
      return { selectPanel: (panel) => { panels.push(panel); } };
    }
    if (n === 'workspaces') {
      return {
        list: {
          getSnapshot: () => ({
            items: new Array(shell.workspaceCount).fill(null),
            ...(shell.phase === undefined ? {} : { phase: shell.phase }),
          }),
        },
      };
    }
    return undefined;
  },
  effect: (fn) => fn(),
};
captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
}).apply(ctx);

const resolved = regs.map(([, cb]) => cb());
const panelReg = resolved.find((r) => r.options.name === 'sidebar.panellist');
const mainReg = resolved.find((r) => r.options.name === 'main');
if (!panelReg || !mainReg) throw new Error('slots not registered');
console.log('slots:', resolved.map((r) => `${r.options.name}:${r.options.key || r.options.id}`).join(' | '));
console.log('panel label:', panelReg.options.label());

// ---- tree helpers
function flat(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push({ type: '#text', text: String(node) }); return out; }
  if (Array.isArray(node)) { for (const c of node) flat(c, out); return out; }
  out.push(node);
  const kids = node.props && node.props.children;
  if (Array.isArray(kids)) { for (const c of kids) flat(c, out); } else if (kids !== undefined) flat(kids, out);
  return out;
}
const textOf = (tree) => flat(tree).map((n) => n.text || (n.props && n.props.value) || '').join('\u0001');
const buttons = (tree, cls) =>
  flat(tree).filter((n) => n.type === 'button' && (!cls || String(n.props.className).split(' ').includes(cls)));
// Buttons living inside the first element carrying `cls`. The AI row is a div,
// so asking for `button.ns-airow` would find nothing.
const buttonsIn = (tree, cls) => {
  const host = flat(tree).find((n) => n.props && String(n.props.className || '').split(' ').includes(cls));
  return host ? flat(host.props.children).filter((n) => n.type === 'button') : [];
};
const label = (node) => flat(node.props.children || []).map((n) => n.text || '').join('');

async function settle() {
  for (let pass = 0; pass < 40; pass += 1) {
    cursor = 0;
    pending = [];
    const tree = mainReg.component({});
    if (!pending.length) return tree;
    const run = pending;
    pending = [];
    for (const fn of run) { const stop = fn(); if (typeof stop === 'function') stop(); }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('render did not settle');
}
async function press(tree, cls, index = 0) {
  const nodes = buttons(tree, cls);
  if (!nodes[index]) throw new Error(`no button.${cls}[${index}]; have ${buttons(tree).map((b) => b.props.className)}`);
  nodes[index].props.onClick({ preventDefault() {}, target: { value: '' } });
  await new Promise((r) => setTimeout(r, 2));
  return settle();
}

// ---- 1. boot
let tree = await settle();
console.log('1) boot: project 雨夜 listed:', textOf(tree).includes('雨夜'), '| rows:', buttons(tree, 'ns-item').length);
if (!textOf(tree).includes('雨夜')) throw new Error('project list not rendered');

// ---- 2. open the project (row 0), then its first chapter (row 1: project + chapter)
tree = await press(tree, 'ns-item', 0);
const rowLabels = buttons(tree, 'ns-item').map(label);
console.log('2) after project: rail rows =', JSON.stringify(rowLabels));
const chapterIndex = rowLabels.findIndex((l) => l.includes('第一章'));
if (chapterIndex < 0) throw new Error('chapter row missing');
tree = await press(tree, 'ns-item', chapterIndex);

const areas = flat(tree).filter((n) => n.type === 'textarea');
console.log('3) chapter open: textareas =', areas.length, '| editor text =', areas[0] ? JSON.stringify(areas[0].props.value) : 'none');
console.log('   heading input =', JSON.stringify((flat(tree).find((n) => n.type === 'input') || { props: {} }).props.value));
if (areas.length < 2) throw new Error('editor textarea missing');
if (!areas.some((a) => a.props.value === '雨夜，灯下。')) throw new Error('chapter prose not loaded');

// ---- 3. side tabs
const tabs = buttons(tree, 'ns-tab').map(label);
console.log('4) side tabs =', JSON.stringify(tabs));
const noteTab = buttons(tree, 'ns-tab')[1];
if (!noteTab) throw new Error('notes tab missing');
noteTab.props.onClick({});
await new Promise((r) => setTimeout(r, 2));
const notesTree = await settle();
console.log('   notes tab shows 眼睛颜色:', textOf(notesTree).includes('眼睛颜色'));

// ---- 4. save round-trip
tree = notesTree;
const saveBtn = buttons(tree).find((b) => /保存/.test(label(b)));
if (!saveBtn) throw new Error('save button missing');
console.log('5) save button found:', JSON.stringify(label(saveBtn)));
saveBtn.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
await settle();
if (!savedPayload) throw new Error('PUT never sent');
console.log('   PUT body: title=%s expectedRevision=%d contentChars=%d summary=%s',
  savedPayload.title, savedPayload.expectedRevision, savedPayload.content.length, JSON.stringify(savedPayload.summary));

// ---- 4b. the raw-material tab
tree = buttons(tree, 'ns-tab')[2] ? (() => { buttons(tree, 'ns-tab')[2].props.onClick({}); return tree; })() : tree;
await new Promise((r) => setTimeout(r, 2));
tree = await settle();
const sourceTabIndex = buttons(tree, 'ns-tab').map(label).findIndex((l) => l.includes('原料'));
console.log('6) source tab label =', JSON.stringify(buttons(tree, 'ns-tab').map(label)[sourceTabIndex]));
if (sourceTabIndex < 0) throw new Error('sources tab missing');
buttons(tree, 'ns-tab')[sourceTabIndex].props.onClick({});
await new Promise((r) => setTimeout(r, 2));
tree = await settle();
const sourceText = textOf(tree);
console.log('   listed source:', sourceText.includes('素材书'), '| chapters tag:', sourceText.includes('3 章'));
if (!sourceText.includes('素材书')) throw new Error('source row missing');

const searchInput = flat(tree).find((n) => n.type === 'input' && n.props.className === 'ns-input');
const searchButton = buttons(tree).find((b) => /检索/.test(label(b)));
if (!searchInput || !searchButton) throw new Error('search controls missing');
searchInput.props.onChange({ target: { value: '周砚' } });
await new Promise((r) => setTimeout(r, 2));
tree = await settle();
buttons(tree).find((b) => /检索/.test(label(b))).props.onClick({});
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('   searched:', JSON.stringify(searched), '| snippet shown:', textOf(tree).includes('周砚蹲下去'));
if (searched !== '周砚') throw new Error('search query not sent');
if (!textOf(tree).includes('周砚蹲下去')) throw new Error('hit snippet missing');

const picker = flat(tree).find((n) => n.type === 'input' && n.props.type === 'file');
const uploadLabel = flat(tree).find((n) => n.type === 'label' && String(n.props.htmlFor) === 'ns-source-file');
if (!picker || !uploadLabel) throw new Error('upload control missing');
await picker.props.onChange({ target: { files: [{ name: 'new.txt', size: 12 }], value: '' } });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('   upload posted:', uploaded, '| notice:', textOf(tree).includes('新书'));
if (!uploaded) throw new Error('upload never posted');

const removeButton = buttons(tree).find((b) => /移除/.test(label(b)));
if (!removeButton) throw new Error('remove button missing');
removeButton.props.onClick({});
await new Promise((r) => setTimeout(r, 8));
await settle();
console.log('   delete sent for:', JSON.stringify(deleted));
if (deleted !== 's1') throw new Error('delete never sent');

// "Adapt from this": the outline is copied from the book, so the client only
// sends the source id and lets the host mint the chapters.
const adaptFromBtn = buttons(tree).find((b) => /据此改编/.test(label(b)));
if (!adaptFromBtn) throw new Error('adapt-from button missing');
adaptFromBtn.props.onClick({});
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('   adapt-from posted:', createdFrom && JSON.stringify(createdFrom.adaptation));
if (!createdFrom || createdFrom.adaptation.sourceId !== 's1') throw new Error('adapt-from never posted');

// back to materials so the remaining steps see the editor
buttons(tree, 'ns-tab')[0].props.onClick({});
await new Promise((r) => setTimeout(r, 2));
tree = await settle();

// ---- 5. stylesheet + API surface
console.log('7) style tags inserted:', inserted.length, '| css bytes:', inserted[0] && inserted[0].textContent.length);

// ---- 5b. the adaptation pane: original beside draft, proposal, accept
const adaptRowIndex = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('旧雨'));
if (adaptRowIndex < 0) throw new Error('adaptation project row missing');
tree = await press(tree, 'ns-item', adaptRowIndex);
const adaptChapterIndex = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('第一章 雨夜'));
if (adaptChapterIndex < 0) throw new Error('adaptation chapter row missing');
tree = await press(tree, 'ns-item', adaptChapterIndex);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const dualText = textOf(tree);
console.log('9) dual pane: original shown:', dualText.includes('周砚蹲下去'),
  '| draft header:', dualText.includes('改编稿'), '| original header:', dualText.includes('原书原文'));
if (!dualText.includes('周砚蹲下去')) throw new Error('original text missing from the dual pane');
if (!dualText.includes('改编稿')) throw new Error('draft pane missing');

const applyBtn = buttons(tree).find((b) => /载入这一版|改编者交来/.test(label(b)));
if (!applyBtn) throw new Error('proposal button missing');
applyBtn.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 4));
tree = await settle();
console.log('10) proposal loaded into the editor:', textOf(tree).includes('林晚蹲下去'));
if (!textOf(tree).includes('林晚蹲下去')) throw new Error('proposal not loaded');

const acceptBtn = buttons(tree).find((b) => /采用这一版/.test(label(b)));
if (!acceptBtn) throw new Error('accept button missing');
acceptBtn.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('11) accept posted:', accepted && JSON.stringify({ id: accepted.proposalId, chars: accepted.content.length }));
if (!accepted) throw new Error('accept never posted');
if (accepted.proposalId !== 'ap1') throw new Error('accept did not carry the proposal id');
if (!accepted.content.includes('林晚蹲下去')) throw new Error('accepted content lost the edit');
if (!Array.isArray(accepted.changes) || accepted.changes[0].kind !== 'character') throw new Error('ledger entries not carried');

// ---- 5c. a new book can be given its own folder on disk
//
// The folder must come from the host's own chooser: a browser file input never
// reveals a real path, so without `uiWorkspace.pickDirectory()` the author has
// no way to say where the book should live.
createdFrom = null;
const newProjectBtn = buttons(tree).find((b) => /新建作品/.test(label(b)));
if (!newProjectBtn) throw new Error('new-project button missing');
newProjectBtn.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 2));
tree = await settle();

const titleField = flat(tree).find((n) => n.type === 'input' && String(n.props.className).includes('ns-form-title'));
const dirField = flat(tree).find((n) => n.type === 'input' && String(n.props.className).includes('ns-form-dir'));
console.log('13) new-project form: title field:', Boolean(titleField), '| dir field:', Boolean(dirField));
if (!titleField || !dirField) throw new Error('new-project form missing');

titleField.props.onChange({ target: { value: '雨夜' } });
await new Promise((r) => setTimeout(r, 2));
tree = await settle();

const pickBtn = buttons(tree).find((b) => /选目录/.test(label(b)));
if (!pickBtn) throw new Error('folder button missing');
pickBtn.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const pickedField = flat(tree).find((n) => n.type === 'input' && String(n.props.className).includes('ns-form-dir'));
console.log('14) folder picked:', pickCalls, 'call(s) | field shows:', JSON.stringify(pickedField && pickedField.props.value));
if (pickCalls !== 1) throw new Error('host folder chooser never called');
if (!pickedField || !String(pickedField.props.value).includes('小说')) throw new Error('picked folder not shown');

const createBtn = buttons(tree).find((b) => /^建这部$/.test(label(b).trim()));
if (!createBtn) throw new Error('create button missing');
createBtn.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('15) create posted:', createdFrom && JSON.stringify({ title: createdFrom.title, dir: createdFrom.dir }));
if (!createdFrom) throw new Error('create never posted');
if (createdFrom.dir !== 'D:\\小说\\雨夜') throw new Error('chosen folder not sent with the project');
const formGone = !flat(tree).some((n) => n.type === 'input' && String(n.props.className).includes('ns-form-dir'));
console.log('   form closed after create:', formGone);
if (!formGone) throw new Error('new-project form stayed open');

// ---- 5d. the new-project row answers the keyboard like a host dialog
//
// A row above the desk rather than a real modal, so the keys have to be wired
// by hand: Escape backs out, Enter submits. Typing a title and reaching for the
// mouse is the one thing every author does on the first try.
const openForm = async () => {
  const btn = buttons(tree).find((b) => /新建作品/.test(label(b)));
  if (!btn) throw new Error('new-project button missing');
  btn.props.onClick({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 2));
  tree = await settle();
  const row = flat(tree).find((n) => n.type === 'div' && String(n.props.className) === 'ns-form');
  if (!row || typeof row.props.onKeyDown !== 'function') throw new Error('new-project row has no key handler');
  return row;
};

let row = await openForm();
row.props.onKeyDown({ key: 'Escape', preventDefault() {} });
await new Promise((r) => setTimeout(r, 2));
tree = await settle();
const escaped = !flat(tree).some((n) => n.type === 'input' && String(n.props.className).includes('ns-form-dir'));
console.log('16) Escape closed the form:', escaped);
if (!escaped) throw new Error('Escape did not close the form');

createdFrom = null;
row = await openForm();
row.props.onKeyDown({ key: 'Enter', preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('17) Enter submitted:', createdFrom && JSON.stringify({ title: createdFrom.title, dir: createdFrom.dir }));
if (!createdFrom) throw new Error('Enter did not submit the form');
if (createdFrom.dir) throw new Error('an unnamed folder should not be sent');

// ---- 5e. removing a book words its notice from where the book lives
//
// An external project is only taken off our list. If the panel says "deleted"
// the author goes looking for a folder that never moved, so the two cases must
// not share a sentence.
// Reopen the book that lives in its own folder: the steps above left the panel
// on a freshly created project.
const folderRow = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('旧雨'));
if (folderRow < 0) throw new Error('the external book is not in the rail');
tree = await press(tree, 'ns-item', folderRow);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();

const deleteBtn = buttons(tree).find((b) => /删除作品/.test(label(b)));
console.log('18) delete-book button present:', Boolean(deleteBtn));
if (!deleteBtn) throw new Error('delete-book button missing');

removedProject = null;
const confirms = [];
const realConfirm = globalThis.window.confirm;
globalThis.window.confirm = (text) => { confirms.push(text); return true; };
deleteBtn.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
globalThis.window.confirm = realConfirm;
console.log('19) removed:', removedProject && removedProject.id, '| keptFiles:', removedProject && removedProject.keptFiles,
  '| prompt mentions the folder:', /文件夹/.test(confirms[0] || ''));
if (!removedProject) throw new Error('delete never posted');
if (!removedProject.keptFiles) throw new Error('this fixture book lives in its own folder');
if (!/文件夹/.test(confirms[0] || '')) throw new Error('the confirmation did not warn that the folder survives');

// ---- 5. the three AI steps
//
// Materials, assembly and prose are each produced by a role agent, so the panel
// must hand the open book and chapter to the matching preset through
// `uiWorkspace.startSession` — not call a model itself. The assertions below
// check the preset id, that the brief names the actual chapter, and that the
// three buttons appear only where they make sense.
const bookRow = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('雨夜') && !l.includes('改编'));
if (bookRow < 0) throw new Error('the writing book is not in the rail');
tree = await press(tree, 'ns-item', bookRow);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const chapterRow = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('第一章'));
tree = await press(tree, 'ns-item', chapterRow);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();

const aiRow = buttonsIn(tree, 'ns-airow');
const aiLabels = aiRow.map(label);
console.log('20) ai row:', JSON.stringify(aiLabels));
if (aiRow.length !== 3) throw new Error(`expected three AI buttons, got ${aiRow.length}`);

const aiMaterial = aiRow.find((b) => /补素材/.test(label(b)));
const aiAssemble = aiRow.find((b) => /装配/.test(label(b)));
const aiWrite = aiRow.find((b) => /落笔/.test(label(b)));
if (!aiMaterial || !aiAssemble || !aiWrite) throw new Error('an AI button is missing');

aiMaterial.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('21) materials session:', sessions.length, sessions[0] && sessions[0].agentPreset,
  '| brief names the book:', /雨夜/.test((sessions[0] || {}).prompt || ''),
  '| draft policy:', (sessions[0] || {}).whenDraftExists);
if (!sessions.length) throw new Error('materials button opened no session');
if (sessions[0].agentPreset !== 'novel-material') throw new Error('wrong preset: ' + sessions[0].agentPreset);
if (!/雨夜/.test(sessions[0].prompt)) throw new Error('brief does not name the book');
if (sessions[0].whenDraftExists !== 'keep') throw new Error('a hand-written draft must never be replaced');
if (panels[0] !== null) throw new Error('the panel should have switched to the conversation');

sessions.length = 0;
aiAssemble.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('22) assemble session:', sessions[0] && sessions[0].agentPreset,
  '| names the chapter:', /第一章/.test((sessions[0] || {}).prompt || ''));
if (!sessions.length) throw new Error('assemble button opened no session');
if (sessions[0].agentPreset !== 'novel-material') throw new Error('assembly is still a materials-layer errand');
if (!/第一章/.test(sessions[0].prompt)) throw new Error('assembly brief does not name the chapter');

sessions.length = 0;
aiWrite.props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('23) writing session:', sessions[0] && sessions[0].agentPreset,
  '| brief says no invention:', /不要凭空发明/.test((sessions[0] || {}).prompt || ''));
if (!sessions.length) throw new Error('writing button opened no session');
if (sessions[0].agentPreset !== 'novel-writing') throw new Error('wrong preset: ' + sessions[0].agentPreset);

// An adaptation project never gets the writing button: the adapter has no
// writing tool at all, and the writer may not touch an adaptation chapter.
sessions.length = 0;
const adaptRow = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('旧雨·改编'));
tree = await press(tree, 'ns-item', adaptRow);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const adaptChapterRow = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('第一章 雨夜'));
if (adaptChapterRow >= 0) {
  tree = await press(tree, 'ns-item', adaptChapterRow);
  await new Promise((r) => setTimeout(r, 8));
  tree = await settle();
}
const adaptAi = buttonsIn(tree, 'ns-airow');
const adaptLabels = adaptAi.map(label);
console.log('24) adaptation ai row:', JSON.stringify(adaptLabels));
if (adaptLabels.some((l) => /落笔/.test(l))) throw new Error('a writer button must not appear on an adaptation project');
if (!adaptLabels.some((l) => /改编/.test(l))) throw new Error('the adapter button is missing');
adaptAi.find((b) => /改编/.test(label(b))).props.onClick({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('25) adapter session:', sessions[0] && sessions[0].agentPreset);
if (!sessions.length) throw new Error('adapt button opened no session');
if (sessions[0].agentPreset !== 'novel-adapt') throw new Error('wrong preset: ' + sessions[0].agentPreset);

// Opening a book clears the chapter. The row must survive that: "fill in the
// materials" is a whole-book errand, and losing the button until a chapter is
// picked would hide the first step of the workflow exactly when it is needed.
const reopenRow = buttons(tree, 'ns-item').map(label).findIndex((l) => l.includes('雨夜') && !l.includes('改编'));
tree = await press(tree, 'ns-item', reopenRow);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const idleAi = buttonsIn(tree, 'ns-airow');
const idleLabels = idleAi.map(label);
const byLabel = (labels, buttons2, re) => buttons2[labels.findIndex((l) => re.test(l))];
console.log('26) ai row without a chapter:', JSON.stringify(idleLabels),
  '| assemble disabled:', Boolean((byLabel(idleLabels, idleAi, /装配/) || {}).props?.disabled),
  '| write disabled:', Boolean((byLabel(idleLabels, idleAi, /落笔/) || {}).props?.disabled));
if (idleLabels.length !== 3) throw new Error('the AI row disappeared when no chapter is open');
if ((byLabel(idleLabels, idleAi, /补素材/) || {}).props?.disabled) {
  throw new Error('materials must work on a whole book, not only on a chapter');
}
if (!(byLabel(idleLabels, idleAi, /装配/) || {}).props?.disabled) throw new Error('assembly without a chapter makes no sense');
if (!(byLabel(idleLabels, idleAi, /落笔/) || {}).props?.disabled) throw new Error('drafting without a chapter makes no sense');

console.log('12) api calls:', JSON.stringify([...new Set(urls)]));

// ---- 7. a shell with no Workspace
//
// `startSession` only shows a notice when it has nowhere to put the session, so
// the panel would otherwise report success for a session that never existed.
// The refusal has to be visible here, before the button claims anything.
sessions.length = 0;
shell.workspaceCount = 0;
tree = await press(tree, 'ns-item', reopenRow);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const emptyAi = buttonsIn(tree, 'ns-airow');
(emptyAi[0] || { props: {} }).props.onClick?.({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const refusal = /工作区/.test(textOf(tree));
console.log('27) no workspace: sessions opened:', sessions.length, '| notice mentions the workspace:', refusal);
if (sessions.length) throw new Error('a session was pushed with no Workspace to hold it');
if (!refusal) throw new Error('the panel claimed success with nowhere to put the session');
shell.workspaceCount = 1;

// ---- 8. a shell whose workspace list has not loaded yet
//
// `phase` is only 'ready' once the Host has answered. An empty list at any
// other phase is a placeholder, not a fact — refusing on it would break the
// first click after a reload, when the panel is already on screen.
sessions.length = 0;
shell.workspaceCount = 0;
shell.phase = 'loading';
tree = await press(tree, 'ns-item', reopenRow);
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
const loadingAi = buttonsIn(tree, 'ns-airow');
(loadingAi[0] || { props: {} }).props.onClick?.({ preventDefault() {} });
await new Promise((r) => setTimeout(r, 8));
tree = await settle();
console.log('28) list still loading: sessions opened:', sessions.length, '| preset:', sessions[0] && sessions[0].agentPreset);
if (sessions.length !== 1) throw new Error('an unloaded list must not be read as "no workspaces"');
if (sessions[0].agentPreset !== 'novel-material') throw new Error('wrong preset while loading');
shell.phase = undefined;
shell.workspaceCount = 1;

console.log('CLIENT OK');