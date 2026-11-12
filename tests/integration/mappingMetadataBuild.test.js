import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBrowserData } from "../../scripts/build-browser-data.mjs";
import { validateBrowserData } from "../../scripts/validate-browser-data.mjs";
import { materializeCvbFixture } from "../helpers/cvbFixtureRepository.js";

const json = async (p) => JSON.parse(await readFile(p, "utf8"));
const provenance = { repository: "Fixture/Public", ref: "main", commit: "a".repeat(40) };

test("prebuilt metadata chunks preserve every record and package isolation across builds", async (t) => {
  const source = await materializeCvbFixture(t, "valid-source");
  for (const [folder, id] of [["ALPHA/Ontology", "1000000001"], ["BETA", "2000000001"]]) {
    const rows = Array.from({ length: 18 }, (_, i) => `OMOP:${id},OMOP:${i + 1},skos:broadMatch,Author ${i}`);
    await writeFile(path.join(source, folder, "mapping_metadata.csv"), `subject_id,object_id,predicate_id,author_label\n${rows.join("\n")}\n`);
  }
  const parent = await mkdtemp(path.join(tmpdir(), "cvb-chunk-integration-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const inlineRoot = path.join(parent, "inline"), chunkRoot = path.join(parent, "chunked");
  const inlineManifest = await buildBrowserData({ source, output: inlineRoot, ...provenance });
  const chunkManifest = await buildBrowserData({ source, output: chunkRoot, metadataChunkLimitBytes: 2000, ...provenance });
  for (const packageId of ["ALPHA", "BETA"]) {
    const inlineEntry = inlineManifest.vocabularies.find((e) => e.packageId === packageId);
    const chunkEntry = chunkManifest.vocabularies.find((e) => e.packageId === packageId);
    const inline = await json(path.join(inlineRoot, inlineEntry.artifacts.metadata));
    const filename = path.join(chunkRoot, chunkEntry.artifacts.metadata);
    const chunked = await json(filename);
    assert.equal(inline.tables.mappingMetadata.length, 18);
    assert.ok(chunked.mappingMetadataChunks.length > 1);
    const restored = [];
    for (const descriptor of chunked.mappingMetadataChunks) restored.push(...await json(path.join(path.dirname(filename), descriptor.file)));
    assert.deepEqual(restored, inline.tables.mappingMetadata);
    assert.equal(chunked.mappingMetadataTotal, restored.length);
    const { mappingMetadataChunks, mappingMetadataTotal, ...rest } = chunked;
    assert.deepEqual({ ...rest, tables: { ...rest.tables, mappingMetadata: restored } }, inline);
  }
  await validateBrowserData(inlineRoot);
  await validateBrowserData(chunkRoot);
});
