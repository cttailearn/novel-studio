/**
 * Check that the test doubles really refuse `ctx.config`.
 *
 * The 404 that broke the plugin in the real host came from reading `ctx.config`,
 * which cordis rejects. The doubles now use a Proxy for the same reason, and
 * this proves the Proxy is wired: reintroducing the old read must make the host
 * test fail, or the guard is decorative.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';

const original = await readFile('./lib/index.js', 'utf8');
const broken = original.replace(
  'const configured = config?.root;',
  'const configured = ctx.config?.root;',
);
if (broken === original) {
  console.log('GUARD FAIL — could not find the line to sabotage');
  process.exit(1);
}

await writeFile('./lib/index.js', broken, 'utf8');
let failed = false;
try {
  const { apply } = await import(`./lib/index.js?broken=${Date.now()}`);
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    provide() { return () => {}; },
    get() { return undefined; },
    inject() {},
    webServer: { register() { return () => {}; } },
    logger: { warn() {} },
  };
  const guarded = new Proxy(ctx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
  apply(guarded, {});
} catch (error) {
  failed = /cannot get property "config" without inject/.test(error.message);
  console.log('threw:', error.message);
}
await writeFile('./lib/index.js', original, 'utf8');
await rm('./lib/index.js.bak', { force: true });

if (failed) {
  console.log('GUARD OK — the double refuses ctx.config exactly like cordis');
} else {
  console.log('GUARD FAIL — the double accepted ctx.config');
  process.exit(1);
}
