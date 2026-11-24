/**
 * Live end-to-end test against the RUNNING DSH host.
 *
 * Every other test in this directory mounts the plugin's own handler on a local
 * http server. This one talks to the real webServer registration inside the
 * real DSH process, which is the only way to catch wiring that only the host
 * can break: the route prefix, the config argument, the fiber phase.
 *
 *   node live-test.mjs [baseUrl]
 *
 * It creates clearly-labelled throwaway projects and deletes them at the end.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = (process.argv[2] || 'http://127.0.0.1:14892').replace(/\/+$/, '');
const API = `${BASE}/novel-studio/api`;

let checks = 0;
const failures = [];
function ok(condition, label) {
  checks += 1;
  if (condition) return;
  failures.push(label);
  console.log('  FAIL', label);
}

async function call(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { status: response.status, body: payload };
}

async function raw(method, path, bytes, headers = {}) {
  const response = await fetch(API + path, { method, headers, body: bytes });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { status: response.status, body: payload };
}

const created = [];
const uploadedSources = [];
// The picked folder is only supposed to survive the *API* delete, so the test
// removes it itself afterwards; otherwise every run leaves a scratch book behind.
let pickedDir = '';

try {
  console.log(`live host: ${BASE}`);

  // 1. the route is actually mounted
  const list = await call('GET', '/projects');
  ok(list.status === 200, `GET /projects is 200 (got ${list.status})`);
  ok(list.body?.ok === true, 'GET /projects returns ok:true');
  ok(Array.isArray(list.body?.projects), 'GET /projects returns an array');
  if (list.status !== 200) throw new Error('route is not mounted; aborting so later steps do not create junk');

  const kinds = await call('GET', '/kinds');
  ok(kinds.status === 200 && kinds.body?.kinds?.length >= 13, 'GET /kinds lists the thirteen built-in kinds');

  // 2. create a plain project
  const created1 = await call('POST', '/projects', { title: '【自检】雨夜' });
  ok(created1.status === 201, `POST /projects is 201 (got ${created1.status})`);
  const project = created1.body?.project;
  ok(Boolean(project?.id), 'created project has an id');
  // A project with no picked folder answers with the path we chose for it, which
  // is also how the next check learns where "our own root" is.
  const internalRoot = created1.body?.dir ? dirname(dirname(created1.body.dir)) : '';
  ok(Boolean(internalRoot), 'POST /projects says where the book was written');
  ok(Array.isArray(created1.body?.chapters), 'POST /projects returns chapters inline');
  created.push(project.id);

  // 3. outline: the route upserts ONE chapter row at a time, which is how the
  // workbench adds a chapter; the agent's bulk `update_outline` tool writes
  // straight to the store instead of going through HTTP.
  const outline1 = await call('POST', `/projects/${project.id}/outline`, {
    title: '第一章 灯下',
    summary: '周砚蹲下去看清了那张脸。',
    pov: '周砚',
    targetWords: 3000,
  });
  ok(outline1.status === 200, `POST outline is 200 (got ${outline1.status})`);
  const outline2 = await call('POST', `/projects/${project.id}/outline`, {
    title: '第二章 脚印',
    summary: '他顺着脚印走到河边。',
    targetWords: 3000,
  });
  ok(outline2.status === 200, `second POST outline is 200 (got ${outline2.status})`);
  const chapters = outline2.body?.chapters ?? [];
  ok(chapters.length === 2, `outline holds two chapters (got ${chapters.length})`);
  ok(chapters.every((chapter) => chapter.id), 'outline chapters got generated ids');
  const [first, second] = chapters;
  ok(Boolean(second?.id), 'the second chapter really exists');

  // 4. write prose, then hit the optimistic lock
  const write1 = await call('PUT', `/projects/${project.id}/chapters/${first.id}`, {
    title: first.title,
    content: '雨夜，灯下。周砚蹲下去，看清了那张脸。',
    summary: '雨夜命案',
    expectedRevision: 0,
  });
  ok(write1.status === 200, `first chapter write is 200 (got ${write1.status})`);
  ok(write1.body?.chapter?.revision === 1, 'first write lands at revision 1');
  // CJK is counted per character, punctuation excluded: 雨夜灯下周砚蹲下去看清了那张脸 = 15.
  ok(write1.body?.chapter?.words === 15, `word count is 15 (got ${write1.body?.chapter?.words})`);

  const stale = await call('PUT', `/projects/${project.id}/chapters/${first.id}`, {
    content: '另一个人写的一版。',
    expectedRevision: 0,
  });
  ok(stale.status === 409, `stale write is 409 (got ${stale.status})`);
  ok(String(stale.body?.error ?? '').includes('改动'), 'stale write explains the conflict');

  const read = await call('GET', `/projects/${project.id}/chapters/${first.id}`);
  ok(read.status === 200 && read.body?.chapter?.content.includes('周砚'), 'chapter reads back');

  // 5. materials and notes
  const material = await call('POST', `/projects/${project.id}/materials`, {
    kind: 'character',
    title: '周砚',
    content: '刑警，三十岁，习惯先蹲下再看。',
    usage: '写他第一次到现场时用',
  });
  ok(material.status === 200, `material create is 200 (got ${material.status})`);
  const materialId = material.body?.project?.materials?.find((item) => item.title === '周砚')?.id;
  ok(Boolean(materialId), 'material created');

  const note = await call('POST', `/projects/${project.id}/notes`, {
    severity: 'warning',
    category: '设定',
    subject: '周砚的眼睛',
    description: '第一章说深灰，第三章不能写成浅褐。',
  });
  ok(note.status === 200, `note create is 200 (got ${note.status})`);
  ok(Boolean(note.body?.project?.notes?.length), 'continuity note created');

  // Attaching is a prose write under the hood: the chapter carries materialIds,
  // so the route is PUT /chapters/:id and it needs the current revision.
  const attach = await call('PUT', `/projects/${project.id}/chapters/${first.id}`, {
    title: first.title,
    content: '雨夜，灯下。周砚蹲下去，看清了那张脸。',
    summary: '雨夜命案',
    materialIds: [materialId],
    expectedRevision: 1,
  });
  ok(attach.status === 200, `attach material is 200 (got ${attach.status})`);
  ok(attach.body?.chapters?.find((row) => row.id === first.id)?.materialIds?.includes(materialId), 'chapter remembers its material');

  // 6. upload a source book and build an adaptation project
  const prose = [
    '第一章 开端',
    '雨夜，灯下。周砚蹲下去，看清了那张脸。',
    '',
    '第二章 追查',
    '他顺着脚印走到河边。',
  ].join('\n');
  const upload = await raw(
    'POST',
    `/sources/upload?filename=${encodeURIComponent('自检原书.txt')}&kind=novel`,
    new TextEncoder().encode(prose),
    { 'content-type': 'application/octet-stream' },
  );
  ok(upload.status === 201, `source upload is 201 (got ${upload.status})`);
  const sourceId = upload.body?.source?.id;
  ok(Boolean(sourceId), 'uploaded source has an id');
  if (sourceId) uploadedSources.push(sourceId);
  ok(upload.body?.source?.chapterCount === 2, `source split into two chapters (got ${upload.body?.source?.chapterCount})`);
  ok(upload.body?.source?.splitMode === 'chapters', 'source used the chapter heading split');

  const adaptCreate = await call('POST', '/projects', {
    title: '【自检】雨夜·改编',
    adaptation: { sourceId, brief: '把主角换成女刑警，人称不变。' },
  });
  ok(adaptCreate.status === 201, `POST adaptation project is 201 (got ${adaptCreate.status})`);
  const adapted = adaptCreate.body?.project;
  created.push(adapted.id);
  ok(Boolean(adapted?.adaptation?.sourceId), 'adaptation project remembers its source');
  ok(adaptCreate.body?.chapters?.length === 2, 'adaptation project casts the whole outline at once');

  const adaptation = await call('GET', `/projects/${adapted.id}/adaptation`);
  ok(adaptation.status === 200, `GET /adaptation is 200 (got ${adaptation.status})`);
  ok(adaptation.body?.source?.id === sourceId, 'GET /adaptation resolves the original book');
  ok(adaptation.body?.adaptation?.cursor === adaptCreate.body.chapters[0].id, 'adaptation cursor starts on chapter one');

  const adaptChapterId = adaptCreate.body.chapters[0].id;
  const desk = await call('GET', `/projects/${adapted.id}/chapters/${adaptChapterId}/adapt`);
  ok(desk.status === 200, `GET chapter /adapt is 200 (got ${desk.status})`);
  ok(String(desk.body?.original?.content ?? '').includes('周砚蹲下去'), 'adaptation desk carries the original text');
  ok(desk.body?.proposal === null, 'no proposal is pending at the start');
  ok(desk.body?.open === true, 'chapter one is open for adaptation');

  const accept = await call('POST', `/projects/${adapted.id}/chapters/${adaptChapterId}/adapt/accept`, {
    content: '雨夜，灯下。林晚蹲下去，看清了那张脸。',
    summary: '把周砚换成林晚，其余照抄。',
    changes: [{ kind: 'character', summary: '主角周砚改为林晚', detail: '只换名字与代词' }],
  });
  ok(accept.status === 200, `accept is 200 (got ${accept.status})`);
  ok(accept.body?.chapter?.hasDraft === true, 'accepted prose is on disk');
  ok(accept.body?.adaptation?.changes?.length >= 1, 'the ledger recorded the change');
  ok(accept.body?.adaptation?.cursor === adaptCreate.body.chapters[1].id, 'cursor advanced to chapter two');

  const rename = await call('POST', `/projects/${adapted.id}/chapters/${adaptChapterId}/adapt/rename`, {
    title: '第一章 雨夜（改）',
  });
  ok(rename.status === 200, `rename is 200 (got ${rename.status})`);
  ok(rename.body?.chapters?.some((chapter) => chapter.title === '第一章 雨夜（改）'), 'rename shows up in the chapter list');
  ok(rename.body?.adaptation?.changes?.some((change) => change.kind === 'title'), 'rename is in the ledger as a title change');

  // 7. a plain project has no adaptation desk
  const noDesk = await call('GET', `/projects/${project.id}/adaptation`);
  ok(noDesk.status === 404, `plain project has no adaptation (got ${noDesk.status})`);

  // 8. a chapter that has been written to cannot be pulled out from under its prose
  const deleteWritten = await call('DELETE', `/projects/${project.id}/outline/${first.id}`);
  ok(deleteWritten.status === 409, `deleting a written chapter is 409 (got ${deleteWritten.status})`);
  const deleteEmpty = await call('DELETE', `/projects/${project.id}/outline/${second.id}`);
  ok(deleteEmpty.status === 200, `deleting an untouched chapter is 200 (got ${deleteEmpty.status})`);
  ok((deleteEmpty.body?.chapters ?? []).length === 1, 'the chapter list lost exactly one row');

  // 9. a book can be told to live in a folder the author picked
  //
  // The folder is chosen through the shell's own dialog, so this is the one
  // feature whose whole promise is "the files are really there". Checking the
  // response alone would not prove it, so the test reads the disk.
  pickedDir = join(tmpdir(), `dsh-novel-live-${Date.now()}`);
  const directed = await call('POST', '/projects', { title: '【自检】外置', dir: pickedDir });
  ok(directed.status === 201, `POST project with a dir is 201 (got ${directed.status})`);
  const directedId = directed.body?.project?.id;
  if (directedId) created.push(directedId);
  ok(directed.body?.dir === pickedDir, 'the response names the folder the book went to');
  ok(existsSync(join(pickedDir, 'project.json')), 'the skeleton is in the picked folder');
  ok(!existsSync(join(internalRoot, 'projects', String(directedId))), 'nothing was written under our own root');

  const relDir = await call('POST', '/projects', { title: '【自检】相对', dir: 'relative/place' });
  ok(relDir.status === 400, `a relative folder is refused (got ${relDir.status})`);
  const clash = await call('POST', '/projects', { title: '【自检】撞目录', dir: pickedDir });
  ok(clash.status === 409, `a folder that already holds a book is refused (got ${clash.status})`);

  const unlisted = directedId ? await call('DELETE', `/projects/${directedId}`) : { status: 0, body: null };
  ok(unlisted.status === 200, `DELETE external project is 200 (got ${unlisted.status})`);
  ok(unlisted.body?.keptFiles === true, 'deleting an external project only unlists it');
  ok(existsSync(join(pickedDir, 'project.json')), 'the folder survived the delete');

  // 10. delete the plain project
  const removed = await call('DELETE', `/projects/${project.id}`);
  ok(removed.status === 200, `DELETE project is 200 (got ${removed.status})`);

  // 11. unknown routes still 404 rather than 500
  const missing = await call('GET', '/nope/nope');
  ok(missing.status === 404, `unknown route is 404 (got ${missing.status})`);

  // Say FAIL here rather than at the end: a summary line that reads OK while
  // failures are pending is exactly the kind of report that gets believed.
  if (failures.length) console.log(`LIVE FAIL — ${failures.length} of ${checks} checks`);
  else console.log(`LIVE OK — ${checks} checks`);
} catch (error) {
  console.log('LIVE FAIL —', error.message);
  process.exitCode = 1;
} finally {
  for (const id of created) {
    try { await call('DELETE', `/projects/${id}`); } catch { /* best effort */ }
  }
  // The uploaded book belongs to the shared library, not to the throwaway
  // project, so deleting the project leaves it behind. Every run would then
  // add another copy of the same test book to the author's shelf.
  for (const id of uploadedSources) {
    try { await call('DELETE', `/sources/${encodeURIComponent(id)}`); } catch { /* best effort */ }
  }
  if (pickedDir) {
    try { await rm(pickedDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (failures.length) {
    console.log(`failed checks:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  }
}
