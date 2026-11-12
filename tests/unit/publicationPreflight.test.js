import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectPublicationCandidates, formatPublicationReport, publicationHasBlockingIssues, SAFE_FILE_LIMIT_BYTES } from "../../scripts/preflight-publication.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, windowsHide: true, stdio: "pipe" });

test("preflight reports the index and worktree separately without disclosing contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cvb-publication-preflight-"));
  try {
    git(root, ["init", "-q"]);
    await mkdir(path.join(root, "browser", "data"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), ".source/\n*.[cC][sS][vV]\n*.[tT][sS][vV]\n");
    await writeFile(path.join(root, "browser", "data", "metadata.json"), "ABC");
    await writeFile(path.join(root, "tracked.csv"), "tracked example");
    git(root, ["add", ".gitignore", "browser/data/metadata.json"]);
    git(root, ["add", "-f", "tracked.csv"]);
    await writeFile(path.join(root, "browser", "data", "metadata.json"), "private test value");
    await writeFile(path.join(root, "tracked.csv"), "different local value");
    await writeFile(path.join(root, "ignored.CSV"), "never print this");
    await writeFile(path.join(root, "notes.txt"), "also not printed");
    const result = await inspectPublicationCandidates(root);
    assert.equal(result.staged.find((v) => v.path === "browser/data/metadata.json").bytes, 3);
    assert.equal(result.worktree.find((v) => v.path === "browser/data/metadata.json").bytes, 18);
    assert.equal(result.worktree.find((v) => v.path === "browser/data/metadata.json").indexedBytes, 3);
    assert.equal(result.worktree.find((v) => v.path === "tracked.csv").state, "modified tracked");
    assert.ok(result.worktree.some((v) => v.path === "notes.txt" && v.state === "untracked"));
    assert.ok(!result.worktree.some((v) => v.path === "ignored.CSV"));
    const report = formatPublicationReport(result);
    assert.match(report, /generated browser data/);
    assert.match(report, /cannot determine whether content is public/);
    assert.doesNotMatch(report, /private test value|never print this|also not printed/);
    assert.match(report, /git add -f/);
    assert.equal(publicationHasBlockingIssues(result), true);
    assert.match(report, /package data is forbidden/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("conservative size threshold is reported with a clear LARGE marker", () => {
  const report = formatPublicationReport({ staged: [{ path: "large.dat", bytes: SAFE_FILE_LIMIT_BYTES, category: "other project file" }], worktree: [] });
  assert.equal(SAFE_FILE_LIMIT_BYTES, 100_000_000);
  assert.match(report, /100000000 bytes \[other project file\] LARGE/);
});

test("ignored generated chunks and staged metadata with absent indexed chunks block preflight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cvb-publication-chunks-"));
  try {
    git(root, ["init", "-q"]);
    const folder = path.join(root, "browser", "data", "vocabularies", "SYNTHETIC");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "/browser/data/vocabularies/**/mapping-metadata-*.json\n");
    await writeFile(path.join(folder, "metadata.json"), JSON.stringify({ mappingMetadataChunks: [{ file: "mapping-metadata-00001.json", count: 1 }] }));
    await writeFile(path.join(folder, "mapping-metadata-00001.json"), '[{"private_marker":"do not print"}]');
    git(root, ["add", ".gitignore", "browser/data/vocabularies/SYNTHETIC/metadata.json"]);
    let result = await inspectPublicationCandidates(root);
    assert.deepEqual(result.ignoredChunks, ["browser/data/vocabularies/SYNTHETIC/mapping-metadata-00001.json"]);
    assert.equal(result.referenceProblems.length, 1);
    assert.match(result.referenceProblems[0].reason, /missing from the index/);
    assert.doesNotMatch(formatPublicationReport(result), /private_marker|do not print/);
    git(root, ["add", "-f", "browser/data/vocabularies/SYNTHETIC/mapping-metadata-00001.json"]);
    result = await inspectPublicationCandidates(root);
    assert.deepEqual(result.ignoredChunks, []);
    assert.deepEqual(result.referenceProblems, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("unstaged oversized data warns without blocking a selectively staged code-only commit", () => {
  const result = { staged: [{ path: "code.js", bytes: 12, category: "other project file" }],
    worktree: [{ path: "browser/data/vocabularies/TEST/metadata.json", state: "modified tracked",
      bytes: 105_975_038, indexedBytes: 1771, category: "generated browser data" }], ignoredChunks: ["browser/data/vocabularies/TEST/mapping-metadata-00001.json"], referenceProblems: [] };
  const report = formatPublicationReport(result);
  assert.match(report, /105975038 bytes; index 1771 bytes/);
  assert.match(report, /LARGE WORKTREE WARNING/);
  assert.match(report, /Do not use git add -A/);
  assert.equal(publicationHasBlockingIssues(result), false);
  result.staged.push({ path: "large.bin", bytes: SAFE_FILE_LIMIT_BYTES });
  assert.equal(publicationHasBlockingIssues(result), true);
});
