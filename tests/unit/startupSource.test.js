import test from "node:test";
import assert from "node:assert/strict";
import { readUrlState, createShareableUrl } from "../../browser/js/urlState.js";
import { shouldRestoreRememberedSource } from "../../browser/js/services/startupSource.js";
const preference = source => ({ enabled: true, savedAt: "2026-11-10", source });
const remote = { provider: "github", canonical: "Other/Repository@main" };
const local = { provider: "local-directory", canonical: "Local folder" };
test("remembered local or other remote source wins over first-visit default", () => {
  for (const source of [remote, local]) assert.equal(shouldRestoreRememberedSource(readUrlState(""), preference(source)), true);
  assert.equal(shouldRestoreRememberedSource(readUrlState(""), { enabled: false, savedAt: "date", source: remote }), false);
  assert.equal(shouldRestoreRememberedSource(readUrlState(""), { enabled: true, source: remote }), false);
});
test("explicit remote and local URLs take precedence over different remembered sources", () => {
  const requested = readUrlState("?repository=Other/Repository&ref=main");
  assert.equal(requested.explicitSourceRequested, true);
  assert.equal(shouldRestoreRememberedSource(requested, preference(remote)), true);
  assert.equal(shouldRestoreRememberedSource(requested, preference(local)), false);
  assert.equal(shouldRestoreRememberedSource(readUrlState("?repository=TuftsCTSI/CVB"), preference(remote)), false);
  assert.equal(shouldRestoreRememberedSource(readUrlState("?local-source=1"), preference(local)), true);
  assert.equal(shouldRestoreRememberedSource(readUrlState("?local-source=1"), preference(remote)), false);
  assert.equal(shouldRestoreRememberedSource({ source: null, explicitSourceRequested: true }, preference(remote)), false);
});
test("source-system multi-select URLs round-trip including absent metadata and stay private locally", () => {
  const state = readUrlState("?repository=TuftsCTSI/CVB&source-system=Epic&source-system=~blank~&source-system=LIS");
  assert.deepEqual(state.filters.sourceSystem, ["Epic", null, "LIS"]);
  assert.deepEqual(readUrlState(new URL(createShareableUrl(state, "https://example.test/")).search).filters.sourceSystem, ["Epic", null, "LIS"]);
  assert.equal(createShareableUrl({ ...state, source: local }, "https://example.test/"), "https://example.test/?local-source=1");
});

test("tutorial-style GIS links restore package, vocabulary, class, page size and source-system selections together", async () => {
  const { BrowserStore } = await import("../../browser/js/store.js");
  // Synthetic values deliberately make no claim that a historical tutorial link is current.
  const linked = readUrlState("?repository=TuftsCTSI%2FCVB&ref=main&vocabulary=GIS&vocabulary-id=Tutorial%20Vocabulary&class=Tutorial%20Class&page-size=50&page=2&source-system=Tutorial%20System");
  const concepts = Array.from({ length: 83 }, (_, i) => ({ conceptId: String(i + 1), conceptName: "Tutorial concept " + i,
    vocabularyId: "Tutorial Vocabulary", conceptClassId: "Tutorial Class", sourceSystems: [i < 70 ? "Tutorial System" : "Other System"] }));
  const dataset = { entry: { packageId: "GIS" }, concepts, conceptById: new Map(concepts.map(c => [c.conceptId, c])),
    search: { documents: concepts.map((c, conceptOrdinal) => ({ conceptOrdinal, conceptId: c.conceptId,
      normalizedCode: c.conceptId, normalizedName: c.conceptName.toLowerCase(), normalizedSynonyms: [] })) } };
  const restored = new BrowserStore(readUrlState(new URL(createShareableUrl(linked, "https://example.test/cvb/")).search));
  restored.setDataset(dataset);
  const state = restored.getState();
  assert.equal(state.source.canonical, "TuftsCTSI/CVB@main");
  assert.equal(state.selectedPackageId, "GIS");
  assert.deepEqual(state.filters.vocabularyId, ["Tutorial Vocabulary"]);
  assert.deepEqual(state.filters.conceptClassId, ["Tutorial Class"]);
  assert.deepEqual(state.filters.sourceSystem, ["Tutorial System"]);
  assert.equal(state.pageSize, 50); assert.equal(state.page, 2);
  assert.equal(state.results.total, 70); assert.equal(state.results.items.length, 20);
  const legacy = new BrowserStore(readUrlState("?repository=TuftsCTSI%2FCVB&vocabulary=GIS&vocabulary-id=Tutorial%20Vocabulary&class=Tutorial%20Class&page-size=50&page=2"));
  legacy.setDataset(dataset);
  assert.deepEqual(legacy.getState().filters.sourceSystem, []);
  assert.equal(legacy.getState().results.total, 83);
  assert.equal(legacy.getState().page, 2); assert.equal(legacy.getState().pageSize, 50);
});
