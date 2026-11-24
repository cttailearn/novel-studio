/**
 * Every path the client can call must be a path the host answers.
 *
 * The panel shows red `HTTP 404` text when a call misses, and a missed call is
 * invisible in every other test: the client test fakes fetch, and the host tests
 * invent their own paths. This one reads the call sites out of `lib/client.js`
 * and drives them through the real router, so a rename on either side fails here
 * instead of in the browser.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(here, '.test-routes-'));
process.env.DSH_NOVEL_HOME = root;

const { apply } = await import('./lib/index.js');

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
assert.ok(route, 'the plugin registered a prefix route');

const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
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

async function call(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(base + API + path, init);
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

/** Read every call site, keeping the template so placeholders stay visible. */
async function callTemplates() {
  const source = await readFile('./lib/client.js', 'utf8');
  const pattern = /call\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*')/g;
  const found = new Map();
  let match;
  while ((match = pattern.exec(source))) {
    const method = match[1];
    const template = match[2].slice(1, -1);
    found.set(`${method} ${template}`, { method, template });
  }
  return [...found.values()];
}

try {
  // Seed one of everything, so each call site has something to point at.
  const created = await call('POST', '/projects', { title: '接口巡检' });
  ok('POST /projects', created.status === 201);
  const projectId = created.body.project.id;

  const outlined = await call('POST', `/projects/${projectId}/outline`, { title: '第一章' });
  ok('POST /projects/:id/outline', outlined.status === 200);
  const chapterId = outlined.body.chapters[0].id;

  const written = await call('PUT', `/projects/${projectId}/chapters/${chapterId}`, {
    content: '雨夜，灯下。',
    expectedRevision: 0,
  });
  ok('PUT /projects/:id/chapters/:cid', written.status === 200);

  const material = await call('POST', `/projects/${projectId}/materials`, {
    title: '林越',
    kind: 'character',
    content: '侦探，失眠',
  });
  ok('POST /projects/:id/materials', material.status === 200);
  const materialId = material.body.project.materials[0].id;

  await call('POST', `/projects/${projectId}/notes`, {
    subject: '眼睛颜色',
    description: '第三章写过是灰的',
    severity: 'warning',
  });

  const book = ['第一章 雨夜', '雨夜，灯下。周砚蹲下去。', '第二章 城西', '周砚去了旧货市场。'].join('\n');
  const uploaded = await fetch(`${base}${API}/sources/upload?filename=book.txt&kind=novel`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new TextEncoder().encode(book),
  });
  const uploadBody = await uploaded.json();
  ok('POST /sources/upload', uploaded.status === 201);
  const sourceId = uploadBody.source.id;
  const sourceChapterId = uploadBody.source.chapters[0].id;

  const adapted = await call('POST', '/projects', {
    title: '接口巡检·改编',
    adaptation: { sourceId, brief: '换成女刑警' },
  });
  ok('POST /projects with adaptation', adapted.status === 201);
  const adaptedId = adapted.body.project.id;
  const adaptedChapterId = adapted.body.chapters[0].id;

  // Proposal, so the accept path has something real to accept.

  const samples = {
    id: projectId,
    pid: projectId,
    projectId,
    cid: chapterId,
    chapterId,
    materialId,
    noteId: '',
    sourceId,
    query: '周砚',
  };

  /** Resolve `${pid}` and `${encodeURIComponent(cid)}` against the seed data. */
  function fill(template, values) {
    return template.replace(/\$\{([^}]+)\}/g, (whole, expression) => {
      const name = expression.trim();
      const wrapped = /^encodeURIComponent\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(name);
      const key = wrapped ? wrapped[1] : name;
      if (!(key in values)) return whole;
      return wrapped ? encodeURIComponent(values[key]) : values[key];
    });
  }

  const templates = await callTemplates();
  ok(`found ${templates.length} call sites in the client`, templates.length > 15);

  // Reads first and deletes last: a delete early in the run would pull the
  // record out from under the reads that follow it, and a 404 from a missing
  // record looks the same as a 404 from a missing route.
  const order = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 9 };
  templates.sort((a, b) => (order[a.method] ?? 5) - (order[b.method] ?? 5));

  for (const { method, template } of templates) {
    // Each call has to point at the record that actually belongs to it: the
    // adaptation paths belong to the adaptation project, the chapter deletes to
    // a chapter id, and the source paths to the uploaded book.
    const adapting = /\/adapt\b|\/adaptation\b/.test(template);
    const onSources = /\/sources\//.test(template);
    const onOutline = /\/outline\//.test(template);
    const values = {
      id: onSources ? sourceId : onOutline ? chapterId : adapting ? adaptedId : projectId,
      pid: adapting ? adaptedId : projectId,
      projectId: adapting ? adaptedId : projectId,
      cid: adapting ? adaptedChapterId : chapterId,
      chapterId: adapting ? adaptedChapterId : chapterId,
      adaptedId,
      adaptedChapterId,
      materialId,
      sourceId,
      query: '周砚',
    };
    const path = fill(template, values);
    const leftover = path.match(/\$\{[^}]+\}/);
    ok(`no unresolved placeholder in ${method} ${template}`, !leftover);
    if (leftover) continue;

    const result = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
    // A 404 that does not say `未知路由` is a route that ran and rejected the
    // request (missing record, stale revision) — that is a routed path.
    const routed = result.status !== 404 || !/未知路由/.test(result.body?.error ?? '');
    ok(`${method} ${path} is routed (got ${result.status})`, routed);
  }

  console.log(`ROUTES ${failures.length ? 'FAIL' : 'OK'} — ${checks} checks`);
} catch (error) {
  console.log('ROUTES FAIL —', error.message);
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

