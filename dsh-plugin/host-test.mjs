/**
 * Host-half wiring test: does `apply()` actually publish what it claims?
 *
 * A fake cordis context stands in for the loader. It is deliberately dumb — it
 * records what was registered and lets us dispose everything — because the
 * thing under test is the *wiring*, not cordis itself. A real HTTP server then
 * drives the registered route, so the handler is exercised through the shape the
 * web server really hands it.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(here, '.test-host-'));
process.env.DSH_NOVEL_HOME = root;

const { apply } = await import('./lib/index.js');

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
}

/** Record every registration and hand back disposers. */
function makeHost() {
  const effects = [];
  const routes = [];
  const presets = [];
  const services = new Map();
  const warnings = [];

  const ctx = {
    config: {},
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
    effect(execute, label) {
      const stop = execute();
      effects.push({ label, stop });
      return () => {};
    },
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
    },
    get(name) {
      return services.get(name);
    },
    inject(names, callback) {
      const scope = {
        effect: ctx.effect,
        agentPresets: {
          register(definition) {
            presets.push(definition);
            return Promise.resolve(() => Promise.resolve());
          },
        },
      };
      callback(scope);
      return () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  return { ctx, effects, routes, presets, services, warnings };
}

try {
  const host = makeHost();
  apply(host.ctx);

  ok('publishes the role service', host.services.has('novelRoles'));
  const service = host.services.get('novelRoles');
  ok('role service carries three tool groups',
    ['shared', 'material', 'writing'].every((group) => Array.isArray(service.tools[group])));
  ok('role service carries the adapter slice', Array.isArray(service.tools.adapt));
  ok('adapter slice has the five proposal tools', service.tools.adapt
    .map((definition) => definition.name)
    .sort()
    .join(',') === 'propose_adaptation,read_adapted_chapter,read_original_chapter,rename_chapter,search_adaptation_changes');
  // The whole point of the adapter role: no tool that writes prose, so a
  // proposal can never sneak past the author's accept.
  ok('adapter has no prose-writing tool', !service.tools.adapt
    .some((definition) => ['write_chapter', 'append_chapter', 'revise_chapter', 'update_outline'].includes(definition.name)));
  ok('role service reads a snapshot', typeof service.snapshot === 'function');
  ok('role service can refresh', typeof service.refresh === 'function');
  ok('role service exposes the adaptation context', typeof service.adapt === 'function');
  ok('role service can restamp the adaptation context', typeof service.refreshAdapt === 'function');

  ok('registers exactly one web route', host.routes.length === 1);
  const route = host.routes[0];
  ok('route is a prefix route', route.kind === 'prefix');
  ok('route is namespaced', route.path === '/novel-studio/api');
  ok('boot logged no warnings', host.warnings.length === 0);

  // --- presets are additive, not default-changing -------------------------
  ok('registers three presets', host.presets.length === 3);
  const ids = host.presets.map((preset) => preset.id).sort();
  ok('preset ids are namespaced', ids.join(',') === 'novel-adapt,novel-material,novel-writing');
  for (const preset of host.presets) {
    ok(`preset ${preset.id} names one row`, preset.plugins.length === 1);
    const row = preset.plugins[0];
    ok(`preset ${preset.id} row points at a role module`,
      /^@local\/dsh-novel-studio\/role\/(material|writing|adapt)$/.test(row.name));
    ok(`preset ${preset.id} row id is stable`, typeof row.id === 'string' && row.id.startsWith('novel-'));
    ok(`preset ${preset.id} has a Chinese label`, /[\u4e00-\u9fff]/.test(preset.name));
  }

  // --- drive the route for real ------------------------------------------
  const server = createServer(async (req, res) => {
    try {
      await route.handler(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/novel-studio/api`;

  const send = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  try {
    let step = await send('GET', '/active');
    ok('active starts empty', step.status === 200 && step.payload.active === null);

    step = await send('POST', '/projects', { title: '雨夜', genre: '悬疑' });
    ok('create answers 201', step.status === 201);
    const projectId = step.payload.project.id;

    step = await send('POST', `/projects/${projectId}/outline`, { title: '第一章', summary: '雨夜命案' });
    ok('outline answers 200', step.status === 200);
    const chapterId = step.payload.chapters[0].id;

    step = await send('PUT', '/active', { projectId, chapterId });
    ok('active write answers 200', step.status === 200);
    ok('active write echoes the pointer', step.payload.active.projectId === projectId);

    // The whole point of the pointer: the prompt snapshot already knows what is
    // open, without the author repeating it and without waiting for a refresh.
    const snapshot = service.snapshot();
    ok('active write stamped the snapshot', snapshot.project?.id === projectId);
    ok('snapshot knows the open chapter', snapshot.chapterOutline?.id === chapterId);

    // --- the tools a role would see actually work against the store -------
    const brief = service.tools.shared.find((definition) => definition.name === 'get_project_brief');
    const value = await brief.execute({});
    const text = brief.output.render({}, value)[0].text;
    ok('brief reports the project', text.includes('雨夜'));
    ok('brief reports the chapter count', text.includes('共 1 章'));

    // A chapter write through the tool must mirror the skeleton, because the
    // workbench only ever reads the skeleton.
    const write = service.tools.writing.find((definition) => definition.name === 'write_chapter');
    await write.execute({ chapterId, content: '雨夜，灯下。', mode: 'create' });
    step = await send('GET', `/projects/${projectId}`);
    ok('tool write mirrored the word count', step.payload.project.drafts[chapterId].words === 4);
    ok('tool write advanced the status', step.payload.chapters[0].status === 'drafted');

    // Clearing the pointer must leave the prompt side consistent.
    step = await send('PUT', '/active', { projectId: '', chapterId: '' });
    ok('clearing active answers 200', step.status === 200);
    ok('clearing active drops the pointer', service.snapshot().project === null);

    step = await send('GET', '/active?probe=1');
    ok('probe still answers', step.status === 200 && step.payload.ok === true);

    // --- the adaptation routes ride the same router -----------------------
    // A whole adaptation project through the public surface: upload a book,
    // bind a project to it, then accept one proposal. These are the routes the
    // dual pane and the adapter tool call, so they must work over HTTP and not
    // only when called directly from a test.
    const upload = await fetch(`${base}/sources/upload?filename=old.txt&kind=novel`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: '第一章 开端\n雨夜，灯下。周砚蹲下去。\n\n第二章 追查\n他顺着脚印走到河边。',
    });
    ok('upload answers 201', upload.status === 201);
    const uploaded = await upload.json();
    const bookId = uploaded.source.id;
    ok('upload split the book', uploaded.source.chapterCount === 2);

    step = await send('POST', '/projects', {
      title: '改编稿',
      adaptation: { sourceId: bookId, brief: '把主角换成女刑警' },
    });
    ok('adaptation project answers 201', step.status === 201);
    const adaptId = step.payload.project.id;
    ok('adaptation project copied the outline', step.payload.chapters.length === 2);
    ok('adaptation project records the plan', step.payload.project.adaptation.sourceId === bookId);
    const originalId = step.payload.chapters[0].id;

    step = await send('GET', `/projects/${adaptId}/adaptation`);
    ok('adaptation plan reads back', step.status === 200 && step.payload.source?.id === bookId);

    step = await send('GET', `/projects/${adaptId}/chapters/${originalId}/adapt`);
    ok('dual-pane read answers 200', step.status === 200);
    ok('dual-pane read carries the original', step.payload.original.content.includes('周砚蹲下去'));
    ok('dual-pane read has no proposal yet', step.payload.proposal === null);
    ok('dual-pane read marks the chapter due', step.payload.open === true);

    // Accepting by hand, the "author wrote it directly" path.
    step = await send('POST', `/projects/${adaptId}/chapters/${originalId}/adapt/accept`, {
      content: '雨夜，灯下。林晚蹲下去。',
      summary: '换成林晚',
      changes: [{ kind: 'character', summary: '周砚改为林晚' }],
    });
    ok('accept answers 200', step.status === 200);
    ok('accept wrote the draft', step.payload.chapter.hasDraft === true);
    // Accepting by hand is still an accept: the change I passed is recorded, and
    // so is the fact that the body was edited outside a proposal, because the
    // ledger is the only thing later chapters read.
    ok('accept recorded my change',
      step.payload.adaptation.changes.some((change) => change.kind === 'character'));
    ok('accept recorded the hand edit too',
      step.payload.adaptation.changes.some((change) => change.kind === 'other'));
    ok('accept moved the cursor on', step.payload.adaptation.cursor === step.payload.chapters[1].id);

    // Out of order: chapter two is due now, so chapter one may be reopened but
    // chapter two accepted; jumping back to three would be a 409. Here we check
    // the rename route, which lands immediately instead of waiting for accept.
    step = await send('POST', `/projects/${adaptId}/chapters/${originalId}/adapt/rename`, { title: '第一章 雨夜（改）' });
    ok('rename answers 200', step.status === 200);
    ok('rename landed in the chapter list', step.payload.chapters[0].title === '第一章 雨夜（改）');
    ok('rename recorded a title ledger entry',
      step.payload.adaptation.changes.some((change) => change.kind === 'title'));

    // A plain project has no adaptation plan, and the pane must say so rather
    // than pretend: the route 404s and the client hides the pane.
    step = await send('GET', `/projects/${projectId}/adaptation`);
    ok('a plain project has no plan', step.status === 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // --- disposal ----------------------------------------------------------
  for (const effect of host.effects.reverse()) {
    if (typeof effect.stop === 'function') await effect.stop();
  }
  ok('role service is withdrawn on dispose', !host.services.has('novelRoles'));

  console.log(`HOST OK — ${checks} checks`);
} finally {
  delete process.env.DSH_NOVEL_HOME;
  await rm(root, { recursive: true, force: true });
}
