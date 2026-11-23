import { ProjectStore, StoreError } from './lib/store.js';
import { projectStats, emptyProject, encodeFileName } from './lib/model.js';
import { rm } from 'node:fs/promises';

const root = './.test-data';
await rm(root, { recursive: true, force: true });
const store = new ProjectStore(root);

const project = await store.create(emptyProject({ title: '测试作品', genre: '悬疑' }));
await store.update(project.id, (p) => {
  p.outline.push({ id: '第一章 雨夜', title: '第一章 雨夜', summary: '开场', pov: '', volumeId: '', status: 'planned', targetWords: 3000, notes: '', materialIds: [] });
});
const w1 = await store.writeChapter(project.id, '第一章 雨夜', { content: '雨下了一整夜。' });
// The skeleton mirror is part of `writeChapter` itself, so there is no separate
// sync step to forget here.
const w2 = await store.writeChapter(project.id, '第一章 雨夜', { content: '雨下了一整夜。他推门出去。', expectedRevision: 1 });
const read = await store.read(project.id);
console.log('stats', JSON.stringify(projectStats(read)));
console.log('index', JSON.stringify(await store.list()));

// concurrency: two writers racing on the same chapter, one must lose
const results = await Promise.allSettled([
  store.writeChapter(project.id, '第一章 雨夜', { content: 'A 赢了吗', expectedRevision: 2 }),
  store.writeChapter(project.id, '第一章 雨夜', { content: 'B 赢了吗', expectedRevision: 2 }),
]);
console.log('race ->', results.map((r) => r.status === 'fulfilled' ? 'ok rev ' + r.value.revision : 'rejected ' + r.reason.status).join(' | '));

await store.remove(project.id);
console.log('after remove list len =', (await store.list()).length);
console.log('root probe ->', await store.read(project.id).then(() => 'FAIL', (e) => e.status));
await rm(root, { recursive: true, force: true });
console.log('SMOKE OK');
