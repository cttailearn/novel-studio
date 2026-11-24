import http from 'node:http';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, inject, name } from './lib/index.js';

console.log('plugin name:', name, 'inject:', JSON.stringify(inject));

const root = './.test-http';
await rm(root, { recursive: true, force: true });
process.env.DSH_NOVEL_HOME = root;

const routes = [];
const disposers = [];
const services = new Map();
const ctx = {
  config: {},
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
  webServer: {
    register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
  },
  effect(fn, label) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
  // Enough of the service registry for `apply` to publish the role service and
  // to notice that no agent-preset registry is present.
  provide(name, value) { services.set(name, value); return () => services.delete(name); },
  get(name) { return services.get(name); },
  inject() {},
};
// cordis refuses unknown properties (`cannot get property "config" without
// inject`), and reading one is what broke the plugin in the real host, so the
// double refuses them too instead of quietly returning undefined.
const guarded = new Proxy(ctx, {
  get(target, prop) {
    if (prop in target) return target[prop];
    throw new Error(`cannot get property "${String(prop)}" without inject`);
  },
});
apply(guarded);
console.log('routes:', routes.map((r) => `${r.kind} ${r.path}`).join(','));

const server = http.createServer((req, res) => {
  const route = routes.find((r) => String(req.url).startsWith(r.path));
  if (!route) { res.statusCode = 404; res.end('no route'); return; }
  route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function req(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(base + path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function upload(path, bytes) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

console.log('GET empty   ', JSON.stringify(await req('GET', '/novel-studio/api/projects')));
const created = await req('POST', '/novel-studio/api/projects', { title: 'HTTP 作品' });
console.log('POST create ', created.status, created.json.project.title);
const id = created.json.project.id;

const chapter = await req('POST', `/novel-studio/api/projects/${id}/outline`, { title: '第一章' });
console.log('POST outline', chapter.status, chapter.json.chapters.length);
const cid = chapter.json.chapters[0].id;

const saved = await req('PUT', `/novel-studio/api/projects/${id}/chapters/${cid}`, { content: '雨夜。', expectedRevision: 0 });
console.log('PUT chapter ', saved.status, 'rev', saved.json.chapter.revision, 'words', saved.json.words);

const stale = await req('PUT', `/novel-studio/api/projects/${id}/chapters/${cid}`, { content: '覆盖', expectedRevision: 0 });
console.log('PUT stale   ', stale.status, stale.json.error);

const mat = await req('POST', `/novel-studio/api/projects/${id}/materials`, { title: '林越', kind: 'character', content: '侦探' });
console.log('POST material', mat.status, mat.json.project.materials.length);
const note = await req('POST', `/novel-studio/api/projects/${id}/notes`, { subject: '眼睛颜色', description: '第三章写过是灰的', severity: 'warning' });
console.log('POST note   ', note.status, note.json.project.notes.length);

const fetched = await req('GET', `/novel-studio/api/projects/${id}`);
console.log('GET project ', fetched.status, 'chapters', fetched.json.chapters.length, 'words', fetched.json.stats.words);

const patched = await req('PATCH', `/novel-studio/api/projects/${id}`, { styleGuide: '冷硬，短句' });
console.log('PATCH       ', patched.status, patched.json.project.styleGuide);

console.log('GET kinds   ', (await req('GET', '/novel-studio/api/kinds')).json.kinds.length);

// ---- a book can be created directly in a folder the author picked
const picked = join(process.cwd(), '.test-http-外置');
await rm(picked, { recursive: true, force: true });
const directed = await req('POST', '/novel-studio/api/projects', { title: '外置', dir: picked });
console.log('POST 外置   ', directed.status, JSON.stringify(directed.json.dir));
const deskChapter = await req('POST', `/novel-studio/api/projects/${directed.json.project.id}/outline`, { title: '第一章' });
await req('PUT', `/novel-studio/api/projects/${directed.json.project.id}/chapters/${deskChapter.json.chapters[0].id}`, { content: '雨夜', expectedRevision: 0 });
const deskFiles = await readdir(picked);
console.log('   on disk  ', JSON.stringify(deskFiles));
const relDir = await req('POST', '/novel-studio/api/projects', { title: '相对', dir: 'relative/place' });
console.log('POST 相对   ', relDir.status, relDir.json.error);
const clash = await req('POST', '/novel-studio/api/projects', { title: '第二部', dir: picked });
console.log('POST 撞目录 ', clash.status);
const unlisted = await req('DELETE', `/novel-studio/api/projects/${directed.json.project.id}`);
console.log('DELETE 外置 ', unlisted.status, JSON.stringify(unlisted.json));
console.log('   folder kept', (await readdir(picked)).length > 0);
await rm(picked, { recursive: true, force: true });

// ---- the raw-material library, end to end
const book = ['第一章 雨夜', '雨夜，灯下。周砚蹲下去。', '第二章 城西', '周砚去了旧货市场。'].join('\n');
const uploadedRes = await upload(
  '/novel-studio/api/sources/upload?filename=book.txt&kind=novel',
  new TextEncoder().encode(book)
);
console.log('POST upload ', uploadedRes.status, 'chapters', uploadedRes.json.source.chapterCount);
const sourceId = uploadedRes.json.source.id;

const sourcesList = await req('GET', '/novel-studio/api/sources');
console.log('GET sources ', sourcesList.status, sourcesList.json.sources.length);
const hits = await req('GET', `/novel-studio/api/sources/${sourceId}/search?q=${encodeURIComponent('周砚')}&limit=6`);
console.log('GET search  ', hits.status, 'hits', hits.json.hits.length, JSON.stringify(hits.json.hits[0].chapterId));
const oneChapter = await req('GET', `/novel-studio/api/sources/${sourceId}/chapters/ch001`);
console.log('GET chapter ', oneChapter.status, JSON.stringify(oneChapter.json.chapter.title));
console.log('GET miss    ', (await req('GET', `/novel-studio/api/sources/${sourceId}/chapters/ch999`)).status);
const removedSource = await req('DELETE', `/novel-studio/api/sources/${sourceId}`);
console.log('DELETE src  ', removedSource.status);
console.log('GET gone    ', (await req('GET', '/novel-studio/api/sources')).json.sources.length);

console.log('DELETE      ', (await req('DELETE', `/novel-studio/api/projects/${id}`)).status);
console.log('GET gone    ', (await req('GET', `/novel-studio/api/projects/${id}`)).status);
console.log('bad route   ', (await req('GET', '/novel-studio/api/nope')).status);

server.close();
await rm(root, { recursive: true, force: true });
console.log('HTTP TEST OK');
