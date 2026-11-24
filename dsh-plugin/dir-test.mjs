/**
 * A book can live in a folder the author picked.
 *
 * The point of this test is the layout, not the API: after choosing a folder,
 * everything the book generates — the skeleton, the chapter bodies, their
 * history — has to be under that folder and nothing under our own root. If
 * that ever stops being true, the feature has silently become "a project with a
 * displayed path", which is worse than not having it.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProjectStore, StoreError, normalizeProjectDir } from './lib/store.js';
import { emptyProject } from './lib/model.js';

const root = resolve('./.test-dir');
const picked = resolve('./.test-dir-外置/我的小说');
await rm(root, { recursive: true, force: true });
await rm(resolve('./.test-dir-外置'), { recursive: true, force: true });

const fails = [];
function ok(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) fails.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`, pass ? '' : `→ ${JSON.stringify(actual)}`);
}

async function exists(path) {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

const store = new ProjectStore(root);

// ---- an external project writes only into the chosen folder
const seed = emptyProject({ title: '雨夜' });
const outside = await store.create(seed, { dir: picked });

ok('project dir is the picked one', store.projectDir(outside.id), picked);
ok('skeleton landed there', await exists(picked), true);

await store.update(outside.id, (project) => {
  project.outline.push({
    id: 'c1',
    title: '第一章',
    summary: '',
    pov: '',
    volumeId: '',
    status: 'planned',
    targetWords: 0,
    notes: '',
    materialIds: [],
  });
});
const written = await store.writeChapter(outside.id, 'c1', { content: '雨夜，灯下。', summary: '开场' });
ok('chapter written', written.words, 4);

const chapterFiles = await readdir(join(picked, 'chapters'));
ok('chapter file is in the picked folder', chapterFiles.length, 1);
ok('no project folder was created under our root', await exists(join(root, 'projects', outside.id)), false);

// The body is a plain JSON file next to the skeleton, so an author can read the
// tree: <picked>/project.json and <picked>/chapters/<id>.json.
const skeleton = JSON.parse(await readFile(join(picked, 'project.json'), 'utf8'));
ok('skeleton carries the outline', skeleton.outline.length, 1);

// ---- the index remembers where the book went
const rows = await store.list();
const row = rows.find((item) => item.id === outside.id);
ok('index row records the dir', row.dir, picked);

// A fresh store (a Host restart) must resolve the same paths from index.json.
const restarted = new ProjectStore(root);
await restarted.ready();
ok('restart keeps the dir', restarted.projectDir(outside.id), picked);
ok('restart can read the chapter', (await restarted.readChapter(outside.id, 'c1'))?.content, '雨夜，灯下。');

// ---- an ordinary project still lives under our root
const inside = await store.create(emptyProject({ title: '内部' }));
ok('no dir means our own root', store.projectDir(inside.id).startsWith(join(root, 'projects')), true);
ok('internal chapter dir is created on first write',
  await store.writeChapter(inside.id, 'c1', { content: '框' }).then(() => exists(join(root, 'projects', inside.id, 'chapters'))),
  true);
ok('internal index row has no dir', (await store.list()).find((item) => item.id === inside.id).dir, undefined);

// ---- removing an external project unlists it but never deletes the folder
await store.remove(outside.id);
ok('external folder survives removal', await exists(picked), true);
ok('it is gone from the list', (await store.list()).some((item) => item.id === outside.id), false);
ok('reading it now 404s', await store.read(outside.id).then(() => 'read', (error) => error.status), 404);

// ---- removing an internal project still cleans its files
await store.remove(inside.id);
ok('internal folder removed', await exists(join(root, 'projects', inside.id)), false);

// ---- a relative path is refused rather than silently resolved
ok('relative dir rejected', await store.create(emptyProject({ title: 'x' }), { dir: 'relative/path' })
  .then(() => 'created', (error) => error.status), 400);
ok('empty dir is fine', normalizeProjectDir('   '), '');

// ---- picking a folder that already holds a book is refused, not overwritten
//
// The folder is the author's; a second book written over the first one's
// project.json would destroy prose the workbench never owned.
ok('a folder already holding a book is refused', await store.create(emptyProject({ title: '第二部' }), { dir: picked })
  .then(() => 'created', (error) => [error.status, error.message]), [409, '这个目录里已经有一部书了；换一个空目录，或先把那部书从列表里删掉再用。']);
const keptSkeleton = JSON.parse(await readFile(join(picked, 'project.json'), 'utf8'));
ok('the refused write left the first book alone', keptSkeleton.title, '雨夜');

// ---- a hand-edited index row with a relative dir does not poison the store
await writeFile(join(root, 'index.json'), JSON.stringify({ projects: [
  { id: 'ghost', title: '鬼', dir: 'not/absolute' },
] }), 'utf8');
const forgiving = new ProjectStore(root);
ok('bad dir row falls back to our root', forgiving.projectDir('ghost'), join(root, 'projects', 'ghost'));
ok('a missing ghost still 404s', await forgiving.read('ghost').then(() => 'read', (error) => error.status), 404);

await rm(root, { recursive: true, force: true });
await rm(resolve('./.test-dir-外置'), { recursive: true, force: true });

if (fails.length) {
  console.error(`\nDIR FAILED — ${fails.length} check(s)`);
  for (const line of fails) console.error('  ' + line);
  process.exitCode = 1;
} else {
  console.log('\nDIR OK — a chosen folder holds the whole book');
}
