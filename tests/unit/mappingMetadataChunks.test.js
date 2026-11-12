import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMetadataArtifact } from "../../scripts/build-browser-data.mjs";
import { validateMetadataArtifact } from "../../scripts/validate-browser-data.mjs";

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "cvb-mapping-chunks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "vocabularies", "ALPHA");
  await mkdir(folder, { recursive: true });
  const filename = path.join(folder, "metadata.json");
  return { root, folder, filename, entry: { packageId: "ALPHA", artifacts: { metadata: "vocabularies/ALPHA/metadata.json" } } };
}
const parse = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const makeMetadata = (rows) => ({ schemaVersion: "2.0", packageId: "ALPHA", tables: { vocabulary: [{ value: "preserved" }], mappingMetadata: rows } });

test("small and missing mapping metadata keep the legacy inline shape", async (t) => {
  const { filename } = await setup(t);
  for (const value of [makeMetadata([]), makeMetadata([{ value: "single" }]), { schemaVersion: "2.0", packageId: "ALPHA", tables: {} }]) {
    await writeMetadataArtifact(filename, value);
    assert.deepEqual(await parse(filename), value);
  }
});

test("large mapping metadata is losslessly split by UTF-8 byte size and validated", async (t) => {
  const { root, folder, filename, entry } = await setup(t);
  const rows = Array.from({ length: 12 }, (_, index) => ({ text: `життя-${index}-🌱`, order: index }));
  const original = makeMetadata(rows);
  await writeMetadataArtifact(filename, original, { chunkLimitBytes: 100 });
  const written = await parse(filename);
  assert.deepEqual(original.tables.mappingMetadata, rows, "input must not mutate");
  assert.deepEqual(written.tables.mappingMetadata, []);
  assert.equal(written.mappingMetadataTotal, rows.length);
  assert.deepEqual(written.tables.vocabulary, original.tables.vocabulary);
  assert.ok(written.mappingMetadataChunks.length > 1);
  let restored = [];
  for (const [index, descriptor] of written.mappingMetadataChunks.entries()) {
    assert.equal(descriptor.file, `mapping-metadata-${String(index + 1).padStart(5, "0")}.json`);
    const f = path.join(folder, descriptor.file);
    assert.ok((await stat(f)).size <= 100);
    const chunk = await parse(f);
    assert.equal(chunk.length, descriptor.count);
    restored.push(...chunk);
  }
  assert.deepEqual(restored, rows);
  const errors = []; await validateMetadataArtifact(root, entry, errors); assert.deepEqual(errors, []);
});

test("validator rejects absent, corrupted, reordered, and count-mismatched chunks", async (t) => {
  const { root, folder, filename, entry } = await setup(t);
  const rows = Array.from({ length: 8 }, (_, order) => ({ order, text: "abc🌱" }));
  await writeMetadataArtifact(filename, makeMetadata(rows), { chunkLimitBytes: 80 });
  const original = await parse(filename);
  const first = path.join(folder, original.mappingMetadataChunks[0].file);
  const firstBytes = await readFile(first);
  const check = async () => { const errors=[]; await validateMetadataArtifact(root, entry, errors); assert.ok(errors.length > 0); };
  await unlink(first); await check(); await writeFile(first, firstBytes);
  await writeFile(first, "broken json"); await check(); await writeFile(first, firstBytes);
  for (const mutate of [
    (m) => { m.mappingMetadataChunks.reverse(); },
    (m) => { m.mappingMetadataChunks[0].count += 1; },
    (m) => { m.mappingMetadataChunks[0].file = "../escape.json"; },
    (m) => { m.mappingMetadataChunks.pop(); },
    (m) => { m.tables.mappingMetadata = [{ value: "ambiguous" }]; },
  ]) { const changed = structuredClone(original); mutate(changed); await writeFile(filename, JSON.stringify(changed)); await check(); }
});

test("a single mapping row too large for a chunk fails explicitly", async (t) => {
  const { filename } = await setup(t);
  await assert.rejects(writeMetadataArtifact(filename, makeMetadata([{ value: "x".repeat(200) }]), { chunkLimitBytes: 100 }), /row exceeds/);
});

test("large legacy inline metadata remains usable locally while chunked index size stays bounded", async (t) => {
  const { root, filename, entry } = await setup(t);
  await writeFile(filename, JSON.stringify(makeMetadata([{ value: "x".repeat(300) }])));
  let errors = [];
  await validateMetadataArtifact(root, entry, errors, { maxMetadataBytes: 100 });
  assert.deepEqual(errors, [], "legacy inline metadata must not be rejected only for size");
  const index = makeMetadata([]);
  index.mappingMetadataChunks = [{ file: "mapping-metadata-00001.json", count: 1 }];
  index.mappingMetadataTotal = 1;
  index.padding = "x".repeat(300);
  await writeFile(filename, JSON.stringify(index));
  errors = [];
  await validateMetadataArtifact(root, entry, errors, { maxMetadataBytes: 100 });
  assert.match(errors.join(" "), /chunked metadata index reaches the publication safety limit/);
});
