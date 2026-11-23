/**
 * Extract files from the DSH asar archive by substring match.
 *
 * The archive is a 16-byte header, an 8-byte pickle, then a JSON directory.
 * `readUInt32LE(12)` is the header size; entry offsets are relative to
 * `16 + headerSize`. Handy for reading shipped reference implementations
 * offline.
 *
 *   node asar-grep.mjs <substring> [--write <dir>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ASAR = 'D:\\Program Files\\dsh\\resources\\app.asar';

const needle = process.argv[2];
if (!needle) {
  console.error('usage: node asar-grep.mjs <substring> [--write <dir>]');
  process.exit(1);
}
const writeIndex = process.argv.indexOf('--write');
const outDir = writeIndex > 0 ? process.argv[writeIndex + 1] : null;

const raw = await readFile(ASAR);
// The header pickle at offset 4 holds its own size, so the data section starts
// `8 + that`; the JSON string then begins at offset 16. Using `16 + jsonLength`
// instead lands two bytes early on this archive.
const headerPickle = raw.readUInt32LE(4);
const jsonLength = raw.readUInt32LE(12);
const dataStart = 8 + headerPickle;
const directory = JSON.parse(raw.subarray(16, 16 + jsonLength).toString('utf8'));

const matches = [];
const walk = (node, prefix) => {
  for (const [key, value] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${key}`;
    if (value.files) {
      walk(value, path);
      continue;
    }
    if (!path.includes(needle)) continue;
    matches.push({ path, size: value.size ?? 0, offset: value.offset });
  }
};
walk(directory, '');

console.log(`${matches.length} match(es) for ${JSON.stringify(needle)}`);
for (const entry of matches) {
  console.log(`  ${entry.size.toString().padStart(9)}  ${entry.path}`);
  if (!outDir || !entry.offset) continue;
  const start = dataStart + Number(entry.offset);
  const bytes = raw.subarray(start, start + entry.size);
  const target = join(resolve(outDir), entry.path.replace(/^\/+/, ''));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
if (outDir) console.log(`wrote ${matches.length} file(s) under ${resolve(outDir)}`);
