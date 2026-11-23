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
const ok = (extra) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...extra }) });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  urls.push(`${method} ${u.replace('http://127.0.0.1:3080', '')}`);
  if (method === 'PUT' && u.includes('/chapters/c1')) {
    savedPayload = JSON.parse(init.body);
    return ok({ chapter: { ...chapter, ...savedPayload, revision: chapter.revision + 1 } });
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
        { id: 'p2', title: '旧雨·改编', genre: '改编', words: 0, chapters: 1 },
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
captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
}).apply({
  slots: {
    inject: (key, cb) => { regs.push([key, cb]); return () => {}; },
    register: (options, component) => ({ options, component }),
  },
  get: (n) => (n === 'locale' ? { getLocale: () => 'zh', subscribe: () => () => {} } : undefined),
  effect: (fn) => fn(),
});

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

console.log('12) api calls:', JSON.stringify([...new Set(urls)]));
console.log('CLIENT OK');
