/**
 * The client and the host, wired together for real.
 *
 * Every other test stops short of this: `client-test.mjs` fakes fetch with
 * hand-written payloads, and the host tests never load a component. So a
 * payload the host really sends but the client never expected — or the reverse —
 * goes unnoticed until it shows in a browser as an empty rail or a red banner.
 *
 * Here the real router runs on a real socket against the real store, and the
 * real client component drives it with real fetch. Only React is a stand-in,
 * and only because the browser is the one thing this environment cannot open.
 *
 *   node integration-test.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(here, '.test-integration-'));
process.env.DSH_NOVEL_HOME = root;

const { apply } = await import('./lib/index.js');

// ---- host ----------------------------------------------------------------
const effects = [];
const routes = [];
const services = new Map();
const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) { const stop = fn(); effects.push(stop); return () => {}; },
  provide(name, value) { services.set(name, value); return () => services.delete(name); },
  get(name) { return services.get(name); },
  inject() {},
  webServer: { register(route) { routes.push(route); return () => {}; } },
};
const guarded = new Proxy(ctx, {
  get(target, prop) {
    if (prop in target) return target[prop];
    throw new Error(`cannot get property "${String(prop)}" without inject`);
  },
});
apply(guarded, {});

const route = routes.find((entry) => entry.kind === 'prefix');
const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const API = '/novel-studio/api';

let checks = 0;
const failures = [];
function ok(label, condition) {
  checks += 1;
  if (condition) {
    console.log('  ok  ', label);
    return;
  }
  failures.push(label);
  console.log('  FAIL', label);
}

async function http(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(ORIGIN + API + path, init);
  return { status: response.status, body: await response.json().catch(() => null) };
}

// ---- React stand-in ------------------------------------------------------
const cells = [];
let cursor = 0;
let pending = [];
const sameDeps = (a, b) => !!(a && b && a.length === b.length && a.every((v, i) => v === b[i]));
function useState(initial) {
  const i = cursor++;
  if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
  return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }];
}
function useEffect(fn, deps) {
  const i = cursor++;
  const previous = cells[i];
  if (previous && sameDeps(previous.deps, deps)) return;
  cells[i] = { deps };
  pending.push(fn);
}
function useCallback(fn, deps) {
  const i = cursor++;
  const previous = cells[i];
  if (previous && sameDeps(previous.deps, deps)) return previous.value;
  cells[i] = { deps, value: fn };
  return fn;
}
function useMemo(fn, deps) {
  const i = cursor++;
  const previous = cells[i];
  if (previous && sameDeps(previous.deps, deps)) return previous.value;
  const value = fn();
  cells[i] = { deps, value };
  return value;
}
const React = {
  createElement: (type, props, ...children) =>
    typeof type === 'function'
      ? type({ ...(props || {}), children })
      : { type, props: { ...(props || {}), children } },
  useState, useEffect, useCallback, useMemo,
};

// ---- fake browser shell --------------------------------------------------
let captured = null;
const insertedCss = [];
globalThis.window = {
  __ModuleLoader__: { load(definition) { captured = definition; } },
  addEventListener() {}, removeEventListener() {}, confirm: () => true, prompt: () => null,
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild(element) { insertedCss.push(element); } },
  baseURI: `${ORIGIN}/`,
};

// The browser resolves a relative URL against the document; node's fetch will
// not, so the shim does exactly that and nothing else. It also counts in-flight
// requests, because "the tree stopped changing" is not the same as "the host
// answered": a render can be stable while its fetch is still on the wire.
const realFetch = globalThis.fetch;
const requests = [];
let inFlight = 0;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  const absolute = target.startsWith('http') ? target : ORIGIN + (target.startsWith('/') ? '' : '/') + target;
  requests.push(`${(init && init.method) || 'GET'} ${target.replace(ORIGIN, '')}`);
  inFlight += 1;
  try {
    const response = await realFetch(absolute, init);
    // Hand back a response whose body is already read, so the count drops only
    // once the client actually has the payload.
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  } finally {
    inFlight -= 1;
  }
};

// ---- the client ----------------------------------------------------------
new Function('window', 'document', 'fetch', 'styles', 'console', 'URL', await readFile('./lib/client.js', 'utf8'))(
  globalThis.window,
  globalThis.document,
  globalThis.fetch,
  { insert: () => () => {} },
  console,
  URL,
);

const registrations = [];
captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require: ${id}`);
}).apply({
  slots: {
    inject: (key, callback) => { registrations.push([key, callback]); return () => {}; },
    register: (options, component) => ({ options, component }),
  },
  get: (name) => (name === 'locale' ? { getLocale: () => 'zh', subscribe: () => () => {} } : undefined),
  effect: (fn) => fn(),
});

const resolved = registrations.map(([, callback]) => callback());
const mainReg = resolved.find((entry) => entry.options.name === 'main');
const panelReg = resolved.find((entry) => entry.options.name === 'sidebar.panellist');

function flat(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push({ type: '#text', text: String(node) }); return out; }
  if (Array.isArray(node)) { for (const child of node) flat(child, out); return out; }
  out.push(node);
  const kids = node.props && node.props.children;
  if (Array.isArray(kids)) { for (const child of kids) flat(child, out); } else if (kids !== undefined) flat(kids, out);
  return out;
}
const textOf = (tree) => flat(tree).map((node) => node.text || (node.props && node.props.value) || '').join('\u0001');
const buttons = (tree, className) =>
  flat(tree).filter((node) => node.type === 'button'
    && (!className || String(node.props.className).split(' ').includes(className)));
const labelOf = (node) => flat(node.props.children || []).map((child) => child.text || '').join('');

async function settle() {
  let previous = null;
  let stable = 0;
  for (let pass = 0; pass < 120; pass += 1) {
    cursor = 0;
    pending = [];
    const tree = mainReg.component({});
    const run = pending;
    pending = [];
    for (const fn of run) { const stop = fn(); if (typeof stop === 'function') stop(); }
    await new Promise((resolve) => setTimeout(resolve, 12));
    const signature = JSON.stringify(snapshotOf(tree));
    // Stable for two passes and nothing on the wire: the panel has caught up.
    if (signature === previous && inFlight === 0) {
      stable += 1;
      if (stable >= 2) return tree;
    } else {
      stable = 0;
    }
    previous = signature;
  }
  throw new Error('render did not settle');
}

/** A cheap structural summary, used to notice that rendering stopped changing. */
function snapshotOf(node) {
  return flat(node).map((entry) => (entry.type === '#text'
    ? `#${entry.text}`
    : `${entry.type}:${String(entry.props.className || '')}:${String(entry.props.value ?? '').slice(0, 40)}`));
}
async function press(tree, className, index = 0) {
  const nodes = buttons(tree, className);
  if (!nodes[index]) {
    throw new Error(`no button.${className}[${index}]; have ${JSON.stringify(buttons(tree).map((b) => b.props.className))}`);
  }
  nodes[index].props.onClick({ preventDefault() {}, target: { value: '' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return settle();
}

try {
  // ---- seed through HTTP, exactly as the panel would --------------------
  const project = await http('POST', '/projects', { title: '雨夜' });
  ok('seed: project created', project.status === 201);
  const projectId = project.body.project.id;

  const outline = await http('POST', `/projects/${projectId}/outline`, { title: '第一章 灯下' });
  ok('seed: chapter planned', outline.status === 200);
  const chapterId = outline.body.chapters[0].id;

  const written = await http('PUT', `/projects/${projectId}/chapters/${chapterId}`, {
    content: '雨夜，灯下。周砚蹲下去，看清了那张脸。',
    summary: '雨夜命案',
    expectedRevision: 0,
  });
  ok('seed: prose written', written.status === 200 && written.body.chapter.revision === 1);

  const material = await http('POST', `/projects/${projectId}/materials`, {
    title: '周砚', kind: 'character', content: '刑警，失眠', usage: '每次出场',
  });
  ok('seed: material created', material.status === 200 && material.body.project.materials.length === 1);
  const materialId = material.body.project.materials[0].id;

  // Attaching is what makes a material belong to a chapter; the side tab counts
  // what the open chapter carries, not the whole project's shelf.
  const attached = await http('PUT', `/projects/${projectId}/chapters/${chapterId}`, {
    content: '雨夜，灯下。周砚蹲下去，看清了那张脸。',
    summary: '雨夜命案',
    materialIds: [materialId],
    expectedRevision: 1,
  });
  ok('seed: material attached to the chapter', attached.status === 200
    && attached.body.chapter.materialIds.includes(materialId));

  await http('POST', `/projects/${projectId}/notes`, {
    subject: '眼睛颜色', description: '第三章写过是灰的', severity: 'warning',
  });
  await http('PUT', '/active', { projectId: '', chapterId: '' });

  // ---- boot: what the panel shows on first paint -----------------------
  let tree = await settle();
  ok('boot: the plugin registered its panel icon', Boolean(panelReg));
  ok('boot: the label resolves', typeof panelReg.options.label() === 'string' && panelReg.options.label().length > 0);

  const booted = textOf(tree);
  ok('boot: the project from disk is listed', booted.includes('雨夜'));
  ok('boot: no HTTP error banner', !/HTTP\s*\d{3}/.test(booted));
  ok('boot: the stylesheet reached the document', insertedCss.length === 1 && insertedCss[0].textContent.length > 4000);

  // ---- open the project -------------------------------------------------
  const rows = buttons(tree, 'ns-item').map(labelOf);
  ok('rail: the project is a row', rows.some((row) => row.includes('雨夜')));
  tree = await press(tree, 'ns-item', rows.findIndex((row) => row.includes('雨夜')));

  const chapterRows = buttons(tree, 'ns-item').map(labelOf);
  ok('rail: the chapter from disk is listed', chapterRows.some((row) => row.includes('第一章 灯下')));

  // ---- open the chapter: the real prose must appear --------------------
  tree = await press(tree, 'ns-item', chapterRows.findIndex((row) => row.includes('第一章 灯下')));
  await new Promise((resolve) => setTimeout(resolve, 30));
  tree = await settle();

  const areas = flat(tree).filter((node) => node.type === 'textarea');
  ok('editor: the chapter opened', areas.length >= 1);
  ok('editor: the prose came from disk', areas.some((node) => node.props.value === '雨夜，灯下。周砚蹲下去，看清了那张脸。'));
  ok('editor: the summary came with it', areas.some((node) => node.props.value === '雨夜命案'));
  ok('editor: the title input is filled', flat(tree).some((node) => node.type === 'input' && node.props.value === '第一章 灯下'));

  // ---- the material and note really belong to this chapter's project ---
  const tabs = buttons(tree, 'ns-tab').map(labelOf);
  ok('side: the material tab counts the material', tabs.some((tab) => /素材\s*\(1\)/.test(tab)));
  ok('side: the note tab counts the open note', tabs.some((tab) => /连续性\s*\(1\)/.test(tab)));

  // ---- write and save ---------------------------------------------------
  const editor = flat(tree).find((node) => node.type === 'textarea' && node.props.value === '雨夜，灯下。周砚蹲下去，看清了那张脸。');
  editor.props.onChange({ target: { value: '雨夜，灯下。周砚蹲下去，看清了那张脸。窗外有人在等。' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  tree = await settle();

  const save = buttons(tree).find((node) => /^保存$/.test(labelOf(node)) || /^保存/.test(labelOf(node)));
  ok('save: the save control exists', Boolean(save));
  save.props.onClick({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 60));
  tree = await settle();

  const reloaded = await http('GET', `/projects/${projectId}/chapters/${chapterId}`);
  ok('save: the new prose is on disk', reloaded.body?.chapter?.content?.includes('窗外有人在等'));
  ok('save: the revision advanced', reloaded.body?.chapter?.revision === 3);

  // ---- a stale write must be refused, not silently win -----------------
  const stale = await http('PUT', `/projects/${projectId}/chapters/${chapterId}`, {
    content: '覆盖', expectedRevision: 1,
  });
  ok('save: a stale write is refused with 409', stale.status === 409);

  const after = await http('GET', `/projects/${projectId}/chapters/${chapterId}`);
  ok('save: the refused write changed nothing', after.body?.chapter?.content?.includes('窗外有人在等'));

  console.log(`INTEGRATION ${failures.length ? 'FAIL' : 'OK'} — ${checks} checks`);
  console.log('requests:', JSON.stringify([...new Set(requests)]));
} catch (error) {
  console.log('INTEGRATION FAIL —', error.message);
  process.exitCode = 1;
} finally {
  server.close();
  for (const stop of effects) if (typeof stop === 'function') stop();
  await rm(root, { recursive: true, force: true });
  if (failures.length) {
    console.log(`failed checks:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  }
}
