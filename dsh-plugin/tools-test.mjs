/**
 * Headless check for lib/tools.js.
 *
 * The tools are the contract the three role prompts were written against, so
 * this exercises the behaviour that is easy to break silently: the optimistic
 * lock, the write modes, the "already exists, keep the author's title" rule,
 * the two-way material sync, the uniqueness check in revise, and note merging.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolSet } from './lib/tools.js';
import { ProjectStore } from './lib/store.js';
import { emptyProject } from './lib/model.js';

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
}
function includes(label, text, needle) {
  const ok = typeof text === 'string' && text.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     missing ${JSON.stringify(needle)} in ${JSON.stringify(String(text).slice(0, 300))}`}`);
}

// Keep the scratch tree inside the workspace: the sandbox denies renames in the
// system temp directory, and a rename is exactly what atomic writes do.
const root = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), '.test-tools-'));
const store = new ProjectStore(root);
let current = null;
const { shared, material, writing } = createToolSet({
  store,
  resolveProject: (explicit) => (explicit && String(explicit).trim()) || current,
});

const named = (list, name) => {
  const found = list.find((item) => item.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};
const run = (list, name, args) => named(list, name).execute(args ?? {}, {});

// ---------------------------------------------------------------- the shape

check('shared tool names', shared.map((t) => t.name), [
  'get_project_brief',
  'list_chapters',
  'read_chapter',
  'list_materials',
  'search_materials',
  'add_note',
  'list_notes',
  'resolve_note',
]);
check('material tool names', material.map((t) => t.name), ['update_outline', 'upsert_material', 'attach_materials']);
check('writing tool names', writing.map((t) => t.name), ['write_chapter', 'append_chapter', 'revise_chapter']);

for (const definition of [...shared, ...material, ...writing]) {
  if (typeof definition.description !== 'string' || !definition.description.trim()) {
    throw new Error(`${definition.name}: empty description`);
  }
  if (definition.name === 'run_code') throw new Error('reserved name');
  if (!definition.output || typeof definition.output.render !== 'function') {
    throw new Error(`${definition.name}: missing output.render`);
  }

  // Mirror of the author DSL compiler in `@deepseek-ai/dsh-tools`: parameters
  // are a *property map* (keys are parameter names, `required: true` inside),
  // and every value node may only use the enforced keyword subset. Getting this
  // wrong throws at registration, so the test compiles the same way the host
  // will and then checks the result against the raw-schema subset.
  const CONSTRAINT = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
  ]);
  const ANNOTATION = new Set(['description', 'title', 'default', 'examples']);
  const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

  const compileNode = (input, path) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`${path} must be a value schema object`);
    }
    const authorKeys = new Set([...ANNOTATION, ...(path.includes('.properties.') || path.startsWith('param:') ? ['required'] : [])]);
    for (const key of Object.keys(input)) {
      if (authorKeys.has(key)) continue;
      if (key === 'oneOf' || key === 'type' || key === 'properties' || key === 'additionalProperties' || key === 'items' || key === 'enum' || key === 'const') continue;
      throw new Error(`${path}.${key} is not supported by the value schema DSL`);
    }
    const node = {};
    for (const key of ANNOTATION) if (Object.hasOwn(input, key)) node[key] = input[key];
    if (Object.hasOwn(input, 'oneOf')) {
      if (Object.hasOwn(input, 'type')) throw new Error(`${path} cannot declare both type and oneOf`);
      if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) throw new Error(`${path}.oneOf must have at least 2`);
      for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
        if (Object.hasOwn(input, key)) throw new Error(`${path}.${key} is not supported beside oneOf`);
      }
      node.oneOf = input.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`));
      return node;
    }
    switch (input.type) {
      case 'object': {
        for (const key of Object.keys(input)) {
          if (!['type', 'properties', 'additionalProperties', ...ANNOTATION].includes(key)) {
            throw new Error(`${path}.${key} is not supported by the value schema DSL`);
          }
        }
        if (typeof input.additionalProperties !== 'boolean') {
          throw new Error(`${path}.additionalProperties must be explicitly true or false`);
        }
        node.type = 'object';
        node.additionalProperties = input.additionalProperties;
        if (Object.hasOwn(input, 'properties')) {
          const compiled = compilePropertyMap(input.properties, `${path}.properties`);
          node.properties = compiled.properties;
          if (compiled.required) node.required = compiled.required;
        }
        return node;
      }
      case 'array': {
        for (const key of Object.keys(input)) {
          if (!['type', 'items', ...ANNOTATION].includes(key)) {
            throw new Error(`${path}.${key} is not supported by the value schema DSL`);
          }
        }
        node.type = 'array';
        if (Object.hasOwn(input, 'items')) node.items = compileNode(input.items, `${path}.items`);
        return node;
      }
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null': {
        for (const key of Object.keys(input)) {
          if (!['type', 'enum', 'const', ...ANNOTATION].includes(key)) {
            throw new Error(`${path}.${key} is not supported by the value schema DSL`);
          }
        }
        node.type = input.type;
        if (Object.hasOwn(input, 'enum')) {
          if (!Array.isArray(input.enum) || input.enum.length === 0) throw new Error(`${path}.enum must be non-empty`);
          node.enum = [...input.enum];
        }
        if (Object.hasOwn(input, 'const')) node.const = input.const;
        return node;
      }
      default:
        throw new Error(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
    }
  };

  const compilePropertyMap = (map, path) => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error(`${path} must be an object of value schemas`);
    }
    const properties = {};
    const required = [];
    for (const [name, property] of Object.entries(map)) {
      if (!property || typeof property !== 'object' || Array.isArray(property)) {
        throw new Error(`${path}.${name} must be a value schema object`);
      }
      if (Object.hasOwn(property, 'required') && property.required !== true) {
        throw new Error(`${path}.${name}.required must be true when present`);
      }
      if (property.required === true) required.push(name);
      const { required: _drop, ...rest } = property;
      properties[name] = compileNode(rest, `${path}.${name}`);
    }
    return required.length > 0 ? { properties, required } : { properties };
  };

  const compiledParams = compilePropertyMap(definition.parameters, 'parameters');
  const parameters = { type: 'object', properties: compiledParams.properties };
  if (compiledParams.required) parameters.required = compiledParams.required;

  // The raw-schema subset check the host runs on the compiled result.
  const assertSubset = (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${path} must be a schema object`);
    for (const key of Object.keys(node)) {
      if (CONSTRAINT.has(key) || ANNOTATION.has(key)) continue;
      throw new Error(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
    }
    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) throw new Error(`${path} cannot declare both type and oneOf`);
    if (hasOneOf) {
      for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
        if (Object.hasOwn(node, key)) throw new Error(`${path}.${key} is not supported beside oneOf`);
      }
      node.oneOf.forEach((branch, index) => assertSubset(branch, `${path}.oneOf[${index}]`));
      return;
    }
    if (!hasType) return; // annotation-only: unconstrained JSON
    if (typeof node.type !== 'string' || !SCHEMA_TYPES.includes(node.type)) {
      throw new Error(Array.isArray(node.type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type is not a JSON type`);
    }
    if (node.type === 'object') {
      if (!Object.hasOwn(node, 'additionalProperties')) {
        // Only the compile step omits it at the root; nested must carry it.
        if (path !== 'parameters') throw new Error(`${path}.additionalProperties must be explicitly true or false`);
      }
      if (Object.hasOwn(node, 'properties')) {
        for (const [name, child] of Object.entries(node.properties)) assertSubset(child, `${path}.properties.${name}`);
      }
      for (const name of node.required ?? []) {
        if (!Object.hasOwn(node.properties ?? {}, name)) throw new Error(`${path}.required names unknown property ${name}`);
      }
    }
    if (node.type === 'array' && Object.hasOwn(node, 'items')) assertSubset(node.items, `${path}.items`);
  };
  assertSubset(parameters, 'parameters');
  assertSubset(definition.output.schema, 'output.schema');

  // Presenting every tool keeps the console card sane; a throw here would show
  // up only once the session renders.
  const view = definition.presentCall?.({});
  if (view && (view.card !== 'generic' || typeof view.title !== 'string')) {
    throw new Error(`${definition.name}: bad presentCall`);
  }
  const rendered = definition.output.render({}, { text: 'hi' });
  if (!Array.isArray(rendered) || rendered[0]?.type !== 'text' || rendered[0]?.text !== 'hi') {
    throw new Error(`${definition.name}: bad output.render`);
  }
}
console.log(`ok   ${shared.length + material.length + writing.length} tools declare a valid shape`);


// ------------------------------------------------------------ the fixture

const project = await store.create({
  ...emptyProject({ title: '雨夜', genre: '悬疑', logline: '一具尸体，两个人没说真话。' }),
  styleGuide: '冷硬，短句，不写心理独白。',
  targetWords: 100000,
});
current = project.id;

// ------------------------------------------------------------- brief / list

let out = await run(shared, 'get_project_brief', {});
includes('brief has title', out.text, '标题：雨夜');
includes('brief has style', out.text, '冷硬，短句');
includes('brief has progress', out.text, '正文 0 字');

out = await run(shared, 'list_chapters', {});
includes('empty outline says so', out.text, '大纲还是空的');

// ------------------------------------------------------------- update_outline

out = await run(material, 'update_outline', {
  volumes: [{ title: '卷一 · 黑水汊', summary: '雨夜命案的开端。', targetWords: 40000 }],
  chapters: [
    {
      id: 'c1',
      title: '第一章 雨夜',
      summary: '雨夜，灯下，尸体。',
      pov: '周砚',
      volume: '卷一 · 黑水汊',
      status: 'planned',
      targetWords: 3000,
    },
    {
      id: 'c2',
      title: '第二章 灯下',
      summary: '第二个人的证词。',
      volume: '卷一 · 黑水汊',
      status: 'planned',
    },
  ],
});
includes('outline created', out.text, '大纲已更新，共 2 章、1 卷');
includes('outline lists c1', out.text, '[c1]');
const saved = await store.read(project.id);
check('volume attached to chapter', saved.outline[0].volumeId, saved.volumes[0].id);
check('chapter count', saved.outline.length, 2);

// A second pass re-sends title/summary but must not touch them — the author's
// wording wins, and the tool has to say so rather than claim a rewrite.
out = await run(material, 'update_outline', {
  chapters: [{ id: 'c1', title: '第一章 被改掉的标题', summary: '被改掉的要点' }],
});
includes('untouched is named', out.text, '只按 chapterIds 改了装料');
const after = await store.read(project.id);
check('author title preserved', after.outline[0].title, '第一章 雨夜');
check('author summary preserved', after.outline[0].summary, '雨夜，灯下，尸体。');

// -------------------------------------------------------------- upsert material

out = await run(material, 'upsert_material', { kind: 'character', title: '周砚' });
includes('missing fields reported', out.text, '新建素材还缺');
includes('missing fields name usage', out.text, 'usage（装配提示）');

out = await run(material, 'upsert_material', {
  kind: 'character',
  title: '周砚',
  content: '刑侦支队长，四十二岁。\n左肩有一道旧枪伤，阴雨天后半夜会疼醒。\n不喝酒，喝浓茶。',
  usage: '写他判断现场、与人周旋、或身体不适时用。',
  tags: ['主角', '警察'],
});
includes('material created', out.text, '已新建素材《周砚》');
const zhou = (await store.read(project.id)).materials[0];
check('material kind', zhou.kind, 'character');
check('material status', zhou.status, 'draft');

out = await run(material, 'upsert_material', {
  id: zhou.id,
  content: '刑侦支队长，四十二岁。\n左肩有一道旧枪伤，阴雨天后半夜会疼醒。\n不喝酒，只喝浓茶。',
});
includes('material updated', out.text, '已更新素材《周砚》');
check('material title kept on partial update', (await store.read(project.id)).materials[0].title, '周砚');

await run(material, 'upsert_material', {
  kind: 'world',
  title: '黑水汊',
  content: '老城区，排水系统是民国修的。\n雨夜里巷子会积水到脚踝。',
  usage: '写环境、追捕路线、气味与声音时用。',
});
const world = (await store.read(project.id)).materials[1];

// ------------------------------------------------------------ attach_materials

out = await run(material, 'attach_materials', { chapterId: 'c1', materialIds: [zhou.id, world.id, 'missing-id'], mode: 'add' });
includes('attach reports count', out.text, '装料 2 条');
includes('attach names the bad id', out.text, 'missing-id');
let now = await store.read(project.id);
check('chapter got both', now.outline[0].materialIds, [zhou.id, world.id]);
check('material got chapter back', now.materials[0].chapterIds, ['c1']);

out = await run(material, 'attach_materials', { chapterId: 'c1', materialIds: [world.id], mode: 'remove' });
includes('remove reports count', out.text, '装料 1 条');
now = await store.read(project.id);
check('chapter lost world', now.outline[0].materialIds, [zhou.id]);
check('world lost chapter', now.materials[1].chapterIds, []);

// ------------------------------------------------------------------ search

out = await run(shared, 'search_materials', { chapterId: 'c1', query: '枪伤' });
includes('search finds the wound', out.text, '旧枪伤');
includes('search cites the material', out.text, '【人物 · 周砚】');
check('search hit count', Array.isArray(out.details) && out.details.length, 1);

out = await run(shared, 'search_materials', { chapterId: 'c1', query: '不存在的词' });
includes('search miss suggests retry', out.text, '换个说法');

// A chapter with nothing attached must refuse rather than search the whole
// project — otherwise the writer silently drafts against unapproved material.
out = await run(shared, 'search_materials', { chapterId: 'c2', query: '枪伤' });
includes('unassembled chapter refuses', out.text, '还没有装配任何素材');

// ------------------------------------------------------------------- notes

out = await run(shared, 'add_note', { severity: 'warning', category: '时间线', subject: '第一章', description: '雨夜是否当天' });
includes('note added', out.text, '已记录待办');
out = await run(shared, 'add_note', { severity: 'blocker', category: '时间线', subject: '第一章', description: '雨夜是否当天，需要与前章对齐' });
includes('note merged', out.text, '已并入既有待办');
check('note count after merge', (await store.read(project.id)).notes.length, 1);
check('note severity escalated', (await store.read(project.id)).notes[0].severity, 'blocker');
out = await run(shared, 'list_notes', {});
includes('notes listed', out.text, '[blocker] 时间线 / 第一章');
const noteId = (await store.read(project.id)).notes[0].id;
out = await run(shared, 'resolve_note', { id: noteId });
includes('note resolved', out.text, '已关闭待办');
check('no open notes left', (await run(shared, 'list_notes', {})).text, '没有 open 的待办。');

// ------------------------------------------------------------------ writing

out = await run(writing, 'write_chapter', {
  chapterId: 'c1',
  title: '第一章 雨夜',
  mode: 'create',
  content: '雨夜，灯下。周砚蹲下去，看清了那张脸。',
  summary: '雨夜命案现场，周砚到场。',
  materialIds: [zhou.id, 'ghost-id'],
});
includes('write created', out.text, '第 1 版');
includes('dropped material named', out.text, 'ghost-id');
// 15 CJK characters; punctuation and spaces are not counted.
includes('words counted', out.text, '第 1 版，15 字（create）');
check('status promoted', (await store.read(project.id)).outline[0].status, 'drafted');
check('skeleton mirrored', (await store.read(project.id)).drafts.c1.hasDraft, true);

// create is a one-shot guard: rewriting an existing body needs an explicit mode.
let threw = '';
try {
  await run(writing, 'write_chapter', { chapterId: 'c1', title: '第一章 雨夜', mode: 'create', content: 'x' });
} catch (error) {
  threw = error.message;
}
includes('create refuses existing body', threw, 'create 只能用于没有旧稿的章节');

out = await run(writing, 'append_chapter', {
  chapterId: 'c1',
  title: '第一章 雨夜',
  content: '雨还在下。他抬头看了看屋檐。',
  summary: '雨夜命案现场，周砚到场。',
});
includes('append works', out.text, '（append）');
now = await store.read(project.id);
const body = await store.readChapter(project.id, 'c1');
includes('append kept the old body', body.content, '雨夜，灯下。周砚蹲下去');
includes('append joined with a blank line', body.content, '\n\n雨还在下');
check('append made version 2', body.revision, 2);
check('history kept one entry', body.history.length, 1);
includes('append wrote the given summary', body.summary, '雨夜命案现场');

// No summary and a changed body must NOT silently keep the old one: an honest
// auto-summary beats a stale description the next chapter would draft against.
out = await run(writing, 'append_chapter', {
  chapterId: 'c1',
  title: '第一章 雨夜',
  content: '窗外的雨声停了。',
});
includes('append without summary says so', out.text, '已生成自动尾部摘要');
check('auto summary marked', (await store.readChapter(project.id, 'c1')).summary.startsWith('【自动摘要】'), true);

// The lock: a stale revision must lose rather than overwrite prose.
threw = '';
try {
  await store.writeChapter(project.id, 'c1', { content: '被覆盖', expectedRevision: 1 });
} catch (error) {
  threw = `${error.status} ${error.message}`;
}
includes('stale write is a 409', threw, '409');

// -------------------------------------------------------------- revise

out = await run(writing, 'revise_chapter', {
  chapterId: 'c1',
  find: '他抬头看了看屋檐。',
  replace: '他抬头看了看屋檐，雨水正顺着椽子往下滴。',
});
includes('revise reports the delta', out.text, '其余一字未动');
now = await store.read(project.id);
check('revise made version 4', now.drafts.c1.revision, 4);

threw = '';
try {
  await run(writing, 'revise_chapter', { chapterId: 'c1', find: '雨', replace: '雪' });
} catch (error) {
  threw = error.message;
}
includes('ambiguous find refuses', threw, '不止一处');

threw = '';
try {
  await run(writing, 'revise_chapter', { chapterId: 'c1', find: '这句话不在正文里', replace: 'x' });
} catch (error) {
  threw = error.message;
}
includes('missing find refuses', threw, '找不到这段原文');

// Deleting a passage is expressed by an empty replacement, not a special tool.
out = await run(writing, 'revise_chapter', {
  chapterId: 'c1',
  find: '，雨水正顺着椽子往下滴。',
  replace: '。',
});
includes('delete via empty replace', out.text, '这次换掉');
check('delete wrote version 5', (await store.read(project.id)).drafts.c1.revision, 5);

// -------------------------------------------------------------- guards

threw = '';
try {
  await run(writing, 'write_chapter', { chapterId: 'nope', title: 'x', mode: 'create', content: 'x' });
} catch (error) {
  threw = error.message;
}
includes('unknown chapter refuses', threw, '不在本章目里');

// Reading a chapter that exists in the outline but has no body yet.
out = await run(shared, 'read_chapter', { chapterId: 'c2' });
check('unwritten chapter', out.text, '章节 c2 还没有正文。');

const longBody = '雨'.repeat(299);
await store.writeChapter(project.id, 'c1', {
  title: '第一章 雨夜',
  content: longBody,
  summary: '长正文测试。',
  expectedRevision: 5,
});
out = await run(shared, 'read_chapter', { chapterId: 'c1', part: 'tail', chars: 200 });
includes('tail on a long body is truncated', out.text, '只给了结尾一段');
includes('tail keeps the end', out.text, '雨');

// Project resolution errors are actionable rather than opaque.
const blank = createToolSet({ store, resolveProject: () => '' });
threw = '';
try {
  await blank.shared[0].execute({}, {});
} catch (error) {
  threw = error.message;
}
includes('no project refuses', threw, '还没有作品');

await rm(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nTOOLS OK');
