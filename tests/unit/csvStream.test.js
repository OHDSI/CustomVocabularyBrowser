import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../browser/js/services/csv.js';
import { createCsvParser, parseCsvStream } from '../../browser/js/services/csvStream.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const counts = { splitCases: 0, byteSplitCases: 0, randomFixtures: 0, randomPartitions: 0, exhaustiveInputs: 0, cleanupCases: 0, realFiles: 0 };
const sha = data => createHash('sha256').update(data).digest('hex');
const outcome = fn => {
  try { return { table: fn() }; }
  catch (e) { return { error: { name: e.name, message: e.message, details: e.details } }; }
};
function splitCheck(text) {
  const expected = outcome(() => parseCsv(text));
  for (let i = 0; i <= text.length; i++) {
    const actual = outcome(() => {
      const p = createCsvParser(); p.feed(text.slice(0, i)); p.feed(''); p.feed(text.slice(i)); return p.finish();
    });
    assert.deepEqual(actual, expected, `split ${i}: ${JSON.stringify(text)}`);
    counts.splitCases++;
  }
}
const valid = [
  'a', 'a\n', 'a\r\n', 'a\n\n', 'a,b\n,', 'a,b\r\n"x,y","q""r"\r\n"x\r\ny", end ',
  '\uFEFFa,b\nУкраїна,🙂', '"\uFEFFa",b\n"",""', 'a\n""',
  '__proto__,constructor,2\nvalue,x,y', 'a\n"one\rtwo\nthree"', 'a,b\n"""",x',
  'a,b\n \uFEFF ,e\u0301', 'a\r\r', 'a\n\uFEFFx', 'a,b\n"x",',
];
const invalid = ['', '\n', ',', 'a,a', '\uFEFFa,a', 'a,b\n1', 'a\n1,2', 'a\nx"y', 'a\n"x"z',
  'a\n"x', 'a\n"""', 'a,a\n"x', ',a\nx"', 'a\n1,2\n"x', 'a\n1,2\nx"', '\uFEFF"a"\nx'];
for (const text of [...valid, ...invalid]) splitCheck(text);
// Exhaustively exercise small valid/invalid strings and exact error details.
const alphabet = ['a', ',', '"', '\r', '\n'];
function exhaustive(prefix, depth) {
  const expected = outcome(() => parseCsv(prefix));
  const actual = outcome(() => {
    const p = createCsvParser(); for (const c of prefix) p.feed(c); return p.finish();
  });
  assert.deepEqual(actual, expected, `exhaustive: ${JSON.stringify(prefix)}`);
  counts.exhaustiveInputs++;
  if (depth) for (const c of alphabet) exhaustive(prefix + c, depth - 1);
}
exhaustive('', 6);

function bytesStream(chunks, hooks = {}) {
  return new ReadableStream({ start(controller) { for (const c of chunks) controller.enqueue(c); if (!hooks.open) controller.close(); },
    cancel(reason) { hooks.cancelled = true; hooks.reason = reason; return hooks.cancelResult; } });
}
for (const text of valid) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i <= bytes.length; i++) {
    const stream = bytesStream([bytes.subarray(0, i), bytes.subarray(i)]);
    const { table } = await parseCsvStream(stream, { chunkBytes: 3 });
    assert.deepEqual(table, parseCsv(text)); assert.equal(stream.locked, false);
    counts.byteSplitCases++;
  }
}
let seed = 0x12345678;
const random = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const atoms = ['a', ',', '"', '\r', '\n', ' ', 'é', '🙂', '\uFEFF', 'Україна', '\u0301'];
const encodeField = field => '"' + field.replaceAll('"', '""') + '"';
for (let f = 0; f < 250; f++) {
  const width = 1 + random(7), records = 1 + random(15);
  const lines = [Array.from({ length: width }, (_, i) => `h${i}`).join(',')];
  for (let r = 0; r < records; r++) {
    lines.push(Array.from({ length: width }, () => Array.from({ length: random(30) }, () => atoms[random(atoms.length)]).join('')).map(encodeField).join(','));
  }
  const text = lines.join(['\r', '\n', '\r\n'][random(3)]) + (random(2) ? '\r\n' : '');
  const expected = parseCsv(text);
  for (let partition = 0; partition < 4; partition++) {
    const p = createCsvParser();
    for (let i = 0; i < text.length;) { const size = 1 + random(17); p.feed(text.slice(i, i + size)); i += size; }
    assert.deepEqual(p.finish(), expected); counts.randomPartitions++;
  }
  counts.randomFixtures++;
}

// Long escaped field and a giant upstream chunk: no per-character append ropes.
const largeText = 'a,b\n' + encodeField('🙂,abc\r\n"'.repeat(60000)) + ',end';
const largeBytes = new TextEncoder().encode(largeText);
const large = await parseCsvStream(bytesStream([largeBytes]));
assert.deepEqual(large.table, parseCsv(largeText));
assert.equal(large.stats.maxDecoderPieceBytes, 65536);
assert.equal(large.stats.maxInputChunkBytes, largeBytes.length);
assert.ok(large.stats.yields > 0);

// Abort while an upstream read is pending, even if cancel never settles.
{
  const hooks = { open: true, cancelResult: new Promise(() => {}) }, controller = new AbortController();
  const stream = bytesStream([], hooks);
  const pending = parseCsvStream(stream, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(hooks.cancelled); assert.equal(stream.locked, false); counts.cleanupCases++;
}
// Timer abort cannot be starved by already-buffered synchronous read promises.
{
  const hooks = { open: true }, controller = new AbortController();
  const bytes = new TextEncoder().encode('a\n' + 'x\n'.repeat(1000000));
  const stream = bytesStream([bytes], hooks); let progress = 0;
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(parseCsvStream(stream, { signal: controller.signal, onProgress() { progress++; } }), { name: 'AbortError' });
  assert.ok(hooks.cancelled); assert.equal(stream.locked, false); assert.ok(progress > 0); counts.cleanupCases++;
}
for (const mode of ['syntax', 'callback', 'alreadyAborted', 'wrongChunk']) {
  const hooks = { open: true }, controller = new AbortController();
  const bytes = mode === 'wrongChunk' ? 'not bytes' : new TextEncoder().encode(mode === 'syntax' ? 'a\nx"' : 'a\n' + 'x\n'.repeat(300000));
  const stream = bytesStream([bytes], hooks);
  if (mode === 'alreadyAborted') controller.abort();
  await assert.rejects(parseCsvStream(stream, { signal: controller.signal, onProgress() { if (mode === 'callback') throw new Error('callback failed'); } }));
  assert.ok(hooks.cancelled); assert.equal(stream.locked, false); counts.cleanupCases++;
}
{
  const stream = new ReadableStream({ pull(controller) { controller.error(new Error('source failed')); } });
  await assert.rejects(parseCsvStream(stream), /source failed/); assert.equal(stream.locked, false); counts.cleanupCases++;
}

console.log('Synthetic tests passed', counts);
