import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserData } from "../../scripts/build-browser-data.mjs";
import { VocabularyRepository } from "../../browser/js/services/dataService.js";
import { materializeCvbFixture } from "../helpers/cvbFixtureRepository.js";

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureProvenance = { repository: "ExampleOrg/FixtureCVB", ref: "fixture", commit: "a".repeat(40), generatedAt: "2026-01-01T00:00:00.000Z" };

test("Public packaging excludes synthetic split metadata; explicit adapter resolves chunks under project subpath", async (t) => {
  const source = await materializeCvbFixture(t, "valid-source");
  const temporary = await mkdtemp(path.join(tmpdir(), "cvb-pages-split-"));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const browser = path.join(temporary, "browser"), scripts = path.join(temporary, "scripts"), data = path.join(browser, "data");
  await mkdir(scripts, { recursive: true });
  await mkdir(browser, { recursive: true });
  for (const name of ["js", "css", "fonts"]) await cp(path.join(projectRoot, "browser", name), path.join(browser, name), { recursive: true });
  for (const name of ["build-site.mjs", "validate-browser-data.mjs", "build-browser-data.mjs"]) {
    await cp(path.join(projectRoot, "scripts", name), path.join(scripts, name));
  }
  await writeFile(path.join(temporary, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(browser, "index.html"), "<!doctype html><title>Synthetic test</title>\n");
  const csv = ["mapping_concept_id,mapping_concept_code,predicate_id,confidence", ...Array.from({length: 40}, (_, i) => `${i+1},0007|| - ||ALPHA_VOC|| - ||CODE-B|| - ||SECOND_VOC,skos:broadMatch,1`)].join("\n") + "\n";
  await writeFile(path.join(source, "ALPHA", "Ontology", "mapping_metadata.csv"), csv);
  const manifest = await buildBrowserData({ source, output: data, metadataChunkLimitBytes: 4096, ...fixtureProvenance });
  const alpha = manifest.vocabularies.find((v) => v.packageId === "ALPHA");
  const metadataPath = path.join(data, ...alpha.artifacts.metadata.split("/"));
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  assert.ok(metadata.mappingMetadataChunks?.length >= 2, "fixture must produce multiple chunks");
  const expected = [];
  for (const chunk of metadata.mappingMetadataChunks) expected.push(...JSON.parse(await readFile(path.join(path.dirname(metadataPath),chunk.file),"utf8")));
  assert.equal(expected.length, 40);
  await execute(process.execPath, [path.join(scripts, "build-site.mjs")], { cwd: temporary });
  const dist = path.join(temporary, "dist");
  await assert.rejects(stat(path.join(dist, "data")), { code: "ENOENT" });
  const loadedManifest = JSON.parse(await readFile(path.join(data,"manifest.json"),"utf8"));
  Object.defineProperty(loadedManifest, "__origin", {value:{mode:"local",baseUrl:"https://example.test/site-name/data/"}});
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.origin,"https://example.test");
    assert.ok(parsed.pathname.startsWith("/site-name/data/"));
    const relative = parsed.pathname.slice("/site-name/data/".length);
    const bytes = await readFile(path.join(data,...relative.split("/")),"utf8");
    return {ok:true,text:async()=>bytes};
  };
  const repository = new VocabularyRepository({ manifest:loadedManifest, source:{provider:"github"}, fetchImpl });
  const details = await repository.loadConceptDetails("ALPHA", "1000000001");
  assert.deepEqual(details.metadata.mappingMetadata, expected, "all metadata rows must survive build and Pages loading in order");
  for (const chunk of metadata.mappingMetadataChunks) assert.ok(requests.includes(`https://example.test/site-name/data/${path.posix.dirname(alpha.artifacts.metadata)}/${chunk.file}`));
});
