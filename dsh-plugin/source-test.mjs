/**
 * Source-library test: splitting, storage, search, and the four read tools.
 *
 * The temporary root lives inside the workspace: `os.tmpdir()` is outside the
 * sandbox, and the atomic write's rename fails there with EPERM.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DEFAULT_FIXED_CHARS,
  chapterIdAt,
  decodeSourceBytes,
  normalizeSourceMeta,
  normalizeSourceText,
  searchSourceChapter,
  sourceTokens,
  snippetAround,
  splitSourceText,
} from './lib/sources.js';
import { SourceLibrary } from './lib/source-store.js';
import { ProjectStore } from './lib/store.js';
import { createToolSet } from './lib/tools.js';

let passes = 0;
function ok(label, condition, detail) {
  if (!condition) {
    console.error(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${label}`);
  }
  passes++;
  console.log(`  ok ${label}`);
}

const here = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(here, '.test-source-'));
const cleanup = () => rm(root, { recursive: true, force: true });

const BOOK = [
  '第一章 雨夜',
  '雨夜，灯下。周砚蹲下去，看清了那张脸。',
  '左肩有一道旧疤，像是十几年前的刀伤。',
  '第二章 城西',
  '周砚去了城西的旧货市场，问了三个人。',
  '没人愿意提那年的案子。',
  '第三章 结案',
  '雨停了。周砚把卷宗合上。',
].join('\n');

try {
  console.log('1) decoding');
  {
    const utf8 = new TextEncoder().encode('周砚 雨夜');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    ok('utf-8 without bom', decodeSourceBytes(utf8).text === '周砚 雨夜');
    ok('utf-8 with bom strips it', decodeSourceBytes(bom).text === '周砚 雨夜');
    ok('encoding label', decodeSourceBytes(utf8).encoding === 'UTF-8');
    let threw = false;
    try {
      decodeSourceBytes(new Uint8Array([0xff, 0xff, 0xff]));
    } catch (error) {
      threw = /无法识别原料编码/.test(error.message);
    }
    ok('undecodable bytes are refused', threw);
  }

  console.log('2) normalising');
  {
    ok('crlf becomes lf', normalizeSourceText('a\r\nb\rc') === 'a\nb\nc');
    ok('nul dropped', normalizeSourceText('a\u0000b') === 'ab');
    ok('bom stripped', normalizeSourceText('\ufeff雨夜') === '雨夜');
    ok('outer blank trimmed', normalizeSourceText('\n  雨夜  \n') === '雨夜');
  }

  console.log('3) splitting');
  {
    const split = splitSourceText(BOOK);
    ok('split by heading', split.splitMode === 'chapters', split.splitMode);
    ok('three chapters', split.chapters.length === 3, split.chapters.map((c) => c.title));
    ok('first title', split.chapters[0].title === '第一章 雨夜', split.chapters[0].title);
    ok('body excludes heading', !split.chapters[0].content.startsWith('第一章'), split.chapters[0].content);
    ok('body kept', split.chapters[0].content.includes('左肩有一道旧疤'));

    const single = splitSourceText(BOOK, { splitMode: 'single' });
    ok('single mode', single.splitMode === 'single' && single.chapters.length === 1);
    ok('single keeps whole text', single.chapters[0].content.startsWith('第一章'));

    const fixed = splitSourceText('abcdefghij'.repeat(400), { fixedChars: 2000 });
    ok('fixed mode when no headings', fixed.splitMode === 'fixed', fixed.splitMode);
    ok('fixed respects the floor', fixed.chapters.every((c) => c.content.length <= 50_000));

    const preface = splitSourceText(`序：写在前面\n${BOOK}`);
    ok('preface kept', preface.chapters[0].title === '前言', preface.chapters[0].title);

    let threw = false;
    try {
      splitSourceText('   ');
    } catch (error) {
      threw = /原料正文是空的/.test(error.message);
    }
    ok('empty text refused', threw);
  }

  console.log('4) chapter ids');
  {
    ok('first id', chapterIdAt(0) === 'ch001');
    ok('tenth id', chapterIdAt(9) === 'ch010');
    ok('padded', chapterIdAt(999) === 'ch1000');
  }

  console.log('5) tokens and scoring');
  {
    ok('cjk bigrams', sourceTokens('周砚').join(',') === '周砚');
    ok('single char kept', sourceTokens('刀').join(',') === '刀');
    ok('latin words', sourceTokens('Rain Night').join(',') === 'rain,night');
    ok('empty query', sourceTokens('   ').length === 0);

    const tokens = sourceTokens('周砚');
    const hit = searchSourceChapter({ id: 'ch001', title: '雨夜', content: '周砚蹲下去。' }, tokens);
    ok('body hit found', !!hit && hit.score > 0, hit && hit.score);
    ok('snippet quoted', !!hit && hit.snippet.includes('周砚'), hit && hit.snippet);
    ok('title hit scores higher', (() => {
      const t = sourceTokens('雨夜');
      const byTitle = searchSourceChapter({ id: 'a', title: '雨夜', content: '雨夜' }, t);
      const byBody = searchSourceChapter({ id: 'b', title: '别章', content: '雨夜' }, t);
      return byTitle.score > byBody.score;
    })());
    ok('no hit returns undefined', searchSourceChapter({ id: 'c', title: 'x', content: 'y' }, tokens) === undefined);
    ok('snippet ellipsis', snippetAround('a'.repeat(2000), 1000, 50).endsWith('…'));
  }

  console.log('6) metadata normalisation');
  {
    const meta = normalizeSourceMeta({
      id: 's1',
      chapters: [{ title: '第一章', chars: 3 }, { id: 'ch002', title: '', index: 1 }],
      kind: 'novel',
    });
    ok('accepted', !!meta);
    ok('ids filled in', meta.chapters[0].id === 'ch001' && meta.chapters[1].id === 'ch002');
    ok('blank title replaced', meta.chapters[1].title === '第2部分', meta.chapters[1].title);
    ok('chapter count derived', meta.chapterCount === 2);
    ok('missing id rejected', normalizeSourceMeta({ chapters: [{ title: 'x' }] }) === undefined);
    ok('empty chapters rejected', normalizeSourceMeta({ id: 's', chapters: [] }) === undefined);
    ok('document forces single', normalizeSourceMeta({ id: 's', kind: 'document', splitMode: 'chapters', chapters: [{ title: 'a' }] }).splitMode === 'single');
  }

  console.log('7) the library on disk');
  {
    const library = new SourceLibrary(root);
    ok('empty at first', (await library.list()).length === 0);

    const created = await library.create({ filename: 'book.txt', text: BOOK, kind: 'novel' });
    ok('created has id', typeof created.id === 'string' && created.id.length > 0);
    ok('three chapters stored', created.chapterCount === 3, created.chapterCount);
    ok('title from filename', created.title === 'book', created.title);

    const listed = await library.list();
    ok('listed once', listed.length === 1);
    ok('list has no bodies', listed[0].chapters.every((c) => c.content === undefined));

    const chapter = await library.readChapter(created.id, 'ch002');
    ok('chapter body read', !!chapter && chapter.content.includes('旧货市场'), chapter && chapter.content);
    ok('chapter title', chapter.title === '第二章 城西', chapter.title);
    ok('unknown chapter', (await library.readChapter(created.id, 'ch999')) === undefined);

    const hits = await library.search(created.id, '周砚');
    ok('search hits', hits.length === 3, hits.map((h) => h.chapterId));
    ok('hits sorted by score', hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));
    ok('hit carries snippet', hits[0].snippet.includes('周砚'), hits[0].snippet);
    ok('hit has no full body', !hits[0].snippet.includes('第三章'));

    const narrow = await library.search(created.id, '旧货市场');
    ok('narrow search', narrow.length === 1 && narrow[0].chapterId === 'ch002', narrow.map((h) => h.chapterId));
    ok('no match empty', (await library.search(created.id, '不存在的词')).length === 0);

    const document = await library.create({ filename: 'notes.md', text: '设定笔记一\n设定笔记二', kind: 'document' });
    ok('document is single', document.splitMode === 'single', document.splitMode);
    ok('two sources', (await library.list()).length === 2);

    await library.remove(document.id);
    ok('removed', (await library.list()).length === 1);

    let threw = false;
    try {
      await library.remove('nope');
    } catch (error) {
      threw = error.status === 404;
    }
    ok('removing a missing source is a 404', threw);
  }

  console.log('8) the four library tools');
  {
    const store = new ProjectStore(root);
    const sources = new SourceLibrary(root);
    const project = await store.create({ title: '雨夜' });
    const book = (await sources.list())[0];

    const tools = createToolSet({ store, resolveProject: async () => project.id, sources });
    const names = (list) => list.map((item) => item.name);
    ok('material tools gain four', names(tools.material).length === 7, names(tools.material));
    ok('writing tools do not', names(tools.writing).length === 3, names(tools.writing));
    ok(
      'library names present',
      ['list_novel_sources', 'list_novel_chapters', 'search_novel_source', 'read_novel_chapter'].every((toolName) =>
        names(tools.material).includes(toolName)
      )
    );

    const byName = (list, toolName) => list.find((item) => item.name === toolName);
    const textOf = async (definition, args) => {
      const value = await definition.execute(args);
      return definition.output.render(args, value)[0].text;
    };

    const listSources = byName(tools.material, 'list_novel_sources');
    const listed = await textOf(listSources, {});
    ok('lists the book', listed.includes('《book》'), listed.slice(0, 60));
    ok('lists sourceId', !!book && listed.includes(book.id));
    ok('says chapters and size', listed.includes('3 章'), listed);

    const listChapters = byName(tools.material, 'list_novel_chapters');
    const chaptersText = await textOf(listChapters, { sourceId: book.id });
    ok('chapter ids listed', chaptersText.includes('ch001') && chaptersText.includes('ch003'), chaptersText);
    ok('query narrows', (await textOf(listChapters, { sourceId: book.id, query: '城西' })).includes('ch002'));
    ok(
      'query can miss',
      (await textOf(listChapters, { sourceId: book.id, query: '不存在的标题' })) === '没有符合条件的章节。'
    );
    ok('unknown source is explained', (await textOf(listChapters, { sourceId: 'nope' })).includes('找不到这份原料'));

    const search = byName(tools.material, 'search_novel_source');
    const searchText = await textOf(search, { sourceId: book.id, query: '周砚' });
    ok('search quotes snippets', searchText.includes('周砚蹲下去'), searchText.slice(0, 80));
    ok('search names chapters', searchText.includes('ch001') && searchText.includes('ch003'));
    ok('search miss suggests retry', (await textOf(search, { sourceId: book.id, query: '不存在' })).includes('换个同义词'));

    const read = byName(tools.material, 'read_novel_chapter');
    const readText = await textOf(read, { sourceId: book.id, chapterId: 'ch001' });
    ok('read returns body', readText.includes('左肩有一道旧疤'), readText);
    ok('read keeps heading', readText.includes('第一章 雨夜'));
    ok('read reports size', readText.includes('字'));
    ok('read unknown chapter', (await textOf(read, { sourceId: book.id, chapterId: 'ch999' })).includes('找不到这一段'));

    const noLibrary = createToolSet({ store, resolveProject: async () => project.id });
    ok('no library, no tools', names(noLibrary.material).length === 3, names(noLibrary.material));
  }

  console.log('9) truncation in read_novel_chapter');
  {
    const library = new SourceLibrary(root);
    const long = '第一章 长章\n' + '雨'.repeat(20_000);
    const created = await library.create({ filename: 'long.txt', text: long });
    const store = new ProjectStore(root);
    const project = await store.create({ title: '长' });
    const tools = createToolSet({ store, resolveProject: async () => project.id, sources: library });
    const read = tools.material.find((item) => item.name === 'read_novel_chapter');
    const value = await read.execute({ sourceId: created.id, chapterId: 'ch001' });
    const text = read.output.render({}, value)[0].text;
    ok('truncated to 12000', text.includes('以上为前 12000 字'), text.slice(-120));
    ok('details drop the body', value.details.content === undefined);
  }

  console.log('10) defaults');
  {
    ok('fixed chars default', DEFAULT_FIXED_CHARS === 15_000);
  }

  console.log(`\nSOURCE OK — ${passes} checks`);
} finally {
  await cleanup();
}
