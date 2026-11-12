import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBrowserData } from "../../scripts/build-browser-data.mjs";

test("build refuses source overlap and preserves existing output files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cvb-output-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), output = path.join(root, "output");
  await mkdir(source); await mkdir(output);
  await writeFile(path.join(output, "manifest.json"), "valuable existing bytes");
  const options = { source, output, repository: "test/repo", ref: "main", commit: "a".repeat(40) };
  await assert.rejects(buildBrowserData(options), /must be empty/);
  assert.equal(await readFile(path.join(output, "manifest.json"), "utf8"), "valuable existing bytes");
  for (const unsafe of [source, path.join(source, "generated"), root]) {
    await assert.rejects(buildBrowserData({ ...options, output: unsafe }), /must not overlap/);
  }
});
