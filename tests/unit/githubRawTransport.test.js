import test from "node:test";
import assert from "node:assert/strict";
import { fetchGitHubText, loadSourceManifest, discoverGitHubManifest } from "../../browser/js/services/manifestService.js";
import { VocabularyRepository } from "../../browser/js/services/dataService.js";
import { resolveSource } from "../../browser/js/services/sourceResolver.js";
import { CORE_FILE_NAMES, validSourceContent } from "../helpers/cvbFixtureRepository.js";
const sha = "b".repeat(40);
const source = resolveSource("example/repo@release/2026");
const response = (value, status = 200, type = "text/plain") => ({ ok: status >= 200 && status < 300, status,
  headers: { get: key => key === "content-type" ? type : null }, text: async () => value,
  json: async () => typeof value === "string" ? JSON.parse(value) : value });
const json = value => response(JSON.stringify(value), 200, "application/json");
const rawBase = `https://raw.githubusercontent.com/example/repo/${sha}/`;

test("raw transport preserves JSON, UTF-8 CSV and safe path/ref encoding without API envelopes", async () => {
  for (const [text, type] of [['{"name":"Україна"}', "application/json"], ['name,code\nКиїв,001\n', "text/csv"]]) {
    const requests = [];
    const result = await fetchGitHubText(source, "ALPHA/Ontology/a name #?.csv", { fetchImpl: async (url, options) => {
      requests.push(url); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
      assert.equal(options.headers["X-GitHub-Api-Version"], undefined); return response(text, 200, type);
    } });
    assert.equal(result, text);
    assert.deepEqual(requests, ["https://raw.githubusercontent.com/example/repo/release%2F2026/ALPHA/Ontology/a%20name%20%23%3F.csv"]);
  }
});

test("unsafe source/path values and prior cancellation cause no content request", async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response(""); };
  for (const unsafe of ["../secret", "/secret", "x/./secret", "x//secret", "x\\secret", "x/\u0000secret"]) {
    await assert.rejects(fetchGitHubText(source, unsafe, { fetchImpl }), { code: "UNSAFE_REPOSITORY_PATH" });
  }
  await assert.rejects(fetchGitHubText({ ...source, owner: "example.evil/other" }, "a.csv", { fetchImpl }));
  await assert.rejects(fetchGitHubText({ ...source, ref: "../main" }, "a.csv", { fetchImpl }));
  await assert.rejects(fetchGitHubText({}, "a.csv", { fetchImpl }), { code: "SOURCE_REQUIRED" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchGitHubText(source, "a.csv", { fetchImpl, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("discovered source uses only two API calls and pins every CSV to the verified commit", async () => {
  const requests = [];
  const files = CORE_FILE_NAMES.map(name => `ALPHA/Ontology/${name}`);
  const fetchImpl = async url => {
    requests.push(url);
    if (url.includes("/commits/")) return json({ sha });
    if (url.includes("/git/trees/")) return json({ tree: [{ path: "ALPHA", type: "tree" }, ...files.map(path => ({ path, type: "blob" }))] });
    assert.ok(url.startsWith(rawBase));
    const file = decodeURIComponent(url.slice(rawBase.length));
    return file === "browser/data/manifest.json" ? response("", 404) : response(validSourceContent(file));
  };
  const manifest = await loadSourceManifest(source, { fetchImpl });
  const repository = new VocabularyRepository({ manifest, source, fetchImpl });
  assert.equal((await repository.loadAllPackages()).concepts.length, 2);
  assert.equal(manifest.source.ref, "release/2026"); assert.equal(manifest.source.commit, sha);
  assert.equal(manifest.__origin.contentSource.ref, sha);
  assert.equal(requests.filter(url => url.startsWith("https://api.github.com/")).length, 2);
  assert.ok(requests[0].endsWith("/commits/release%2F2026"));
  assert.ok(requests.some(url => url.includes(`/git/trees/${sha}?recursive=1`)));
  assert.equal(requests.filter(url => url.startsWith(rawBase)).length, 4);
  assert.equal(requests.some(url => url.includes("/contents/")), false);
});

test("prebuilt manifest and artifacts use verified commit, not a commit claimed by the manifest", async () => {
  const requests = [];
  const manifest = { schemaVersion: "2.0", source: { repository: "example/repo", commit: "c".repeat(40) },
    requiredFiles: CORE_FILE_NAMES, vocabularies: [{ packageId: "ALPHA", browseable: true,
      artifacts: { concepts: "vocabularies/ALPHA/concepts.json", search: "vocabularies/ALPHA/search.json" } }] };
  const fetchImpl = async url => {
    requests.push(url);
    if (url.includes("/commits/")) return json({ sha });
    assert.ok(url.startsWith(rawBase));
    if (url.endsWith("manifest.json")) return json(manifest);
    return json(url.endsWith("concepts.json") ? { concepts: [], facets: {} } : { schemaVersion: "2.0", documents: [] });
  };
  const loaded = await loadSourceManifest(source, { fetchImpl });
  assert.equal(loaded.__origin.mode, "github-prebuilt");
  await new VocabularyRepository({ manifest: loaded, source, fetchImpl }).loadPackage("ALPHA");
  assert.equal(requests.filter(url => url.startsWith("https://api.github.com/")).length, 1);
  assert.equal(requests.filter(url => url.startsWith(rawBase)).length, 3);
});

test("rate limits stop immediately without retry or alternate transport", async () => {
  for (const status of [403, 429]) {
    const requests = [];
    await assert.rejects(loadSourceManifest(source, { fetchImpl: async url => { requests.push(url); return response("", status); } }), { code: "GITHUB_RATE_LIMIT" });
    assert.equal(requests.length, 1); assert.ok(requests[0].includes("/commits/"));
  }
  for (const [status, code] of [[403, "GITHUB_REQUEST_FAILED"], [429, "GITHUB_RATE_LIMIT"]]) {
    const requests = [];
    await assert.rejects(loadSourceManifest(source, { fetchImpl: async url => {
      requests.push(url); return url.includes("/commits/") ? json({ sha }) : response("", status);
    } }), { code });
    assert.equal(requests.length, 2); assert.ok(requests[1].startsWith(rawBase));
  }
});

test("failed raw body and malformed manifest do not fall through to discovery", async () => {
  for (const body of [response("not json"), { ok: true, text: async () => { throw Error("stream closed"); } }]) {
    const requests = [];
    await assert.rejects(loadSourceManifest(source, { fetchImpl: async url => { requests.push(url); return url.includes("/commits/") ? json({ sha }) : body; } }));
    assert.equal(requests.length, 2);
  }
});

test("invalid resolved commit cannot become a raw URL or tree request", async () => {
  let calls = 0;
  await assert.rejects(discoverGitHubManifest(source, { fetchImpl: async () => { calls++; return json({ sha: "../../main" }); } }), { code: "INVALID_GITHUB_RESPONSE" });
  assert.equal(calls, 1);
});
