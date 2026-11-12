import test from "node:test";
import assert from "node:assert/strict";
import { sourceSystemValues } from "../../browser/js/model/sourceSystems.js";
import { contextualFilterCounts, filterLabel } from "../../browser/js/ui/filters.js";
import { SearchService } from "../../browser/js/services/searchService.js";
import { BrowserStore } from "../../browser/js/store.js";

const concepts = [
  { conceptId: "1", conceptName: "Alpha finding", sourceSystems: ["Epic", "Epic", "LIS", " ", null], vocabularyId: "SNOMED", domainId: "Observation", standardConcept: null },
  { conceptId: "2", conceptName: "Beta finding", sourceSystems: ["Epic"], vocabularyId: "LOINC", domainId: "Measurement", standardConcept: "S" },
  { conceptId: "3", conceptName: "Gamma finding", sourceSystems: ["REDCap"], vocabularyId: "SNOMED", domainId: "Observation", standardConcept: null },
  { conceptId: "4", conceptName: "Delta finding", sourceSystems: [], vocabularyId: "Epic", packageId: "LIS", domainId: "Observation", standardConcept: null },
  { conceptId: "5", conceptName: "Epsilon finding", vocabularyId: "TEST", domainId: "Observation", standardConcept: null },
];
const search = { documents: concepts.map((c, conceptOrdinal) => ({
  conceptOrdinal, conceptId: c.conceptId, normalizedCode: c.conceptId,
  normalizedName: c.conceptName.toLowerCase(), normalizedSynonyms: [],
  nameTokens: c.conceptName.toLowerCase().split(" "), synonymTokens: [],
})) };
const service = new SearchService({ concepts, search });
const ids = options => service.search(options).items.map(item => item.concept.conceptId).sort();

test("source system values normalize and deduplicate actual metadata without inference", () => {
  assert.deepEqual(sourceSystemValues({ sourceSystems: [" Epic ", "Epic", "LIS", "", 0, null] }), ["Epic", "LIS"]);
  for (const sourceSystems of [undefined, null, [], [" ", null], "Epic"]) {
    assert.deepEqual(sourceSystemValues({ sourceSystems, vocabularyId: "Epic", packageId: "LIS" }), [null]);
  }
  assert.equal(filterLabel("sourceSystem", null), "Not supplied");
});

test("source system search uses OR within the facet and AND with other filters and query", () => {
  assert.deepEqual(ids({ filters: { sourceSystem: ["LIS", "REDCap"] } }), ["1", "3"]);
  assert.deepEqual(ids({ filters: { sourceSystem: ["Epic"], domainId: ["Observation"] } }), ["1"]);
  assert.deepEqual(ids({ filters: { sourceSystem: [null] } }), ["4", "5"]);
  assert.deepEqual(ids({ filters: { sourceSystem: [null, "LIS"] } }), ["1", "4", "5"]);
  assert.deepEqual(ids({ query: "Alpha", filters: { sourceSystem: ["Epic"] } }), ["1"]);
  assert.deepEqual(ids({ query: "Alpha", filters: { sourceSystem: ["REDCap"] } }), []);
  assert.deepEqual(ids({ filters: { sourceSystem: ["Missing"] } }), []);
});

test("source system facet counts each concept once and excludes its own selections", () => {
  const counts = contextualFilterCounts(concepts, { sourceSystem: ["Epic"], domainId: ["Observation"] });
  assert.deepEqual([...counts.sourceSystem], [[null, 2], ["Epic", 1], ["LIS", 1], ["REDCap", 1]]);
  assert.deepEqual([...counts.domainId], [["Measurement", 1], ["Observation", 1]]);
  assert.deepEqual([...counts.vocabularyId], [["SNOMED", 1]]);
  const blanks = contextualFilterCounts(concepts, { sourceSystem: [null] });
  assert.deepEqual([...blanks.vocabularyId], [["Epic", 1], ["TEST", 1]]);
  const searched = contextualFilterCounts(service.matchingConcepts("Alpha"), { sourceSystem: ["Missing"] });
  assert.deepEqual([...searched.sourceSystem], [["Epic", 1], ["LIS", 1]]);
  assert.deepEqual([...searched.vocabularyId], []);
  assert.deepEqual([...contextualFilterCounts([], {}).sourceSystem], []);
});

test("store source-system selections reset paging, preserve other filters and clear correctly", () => {
  const store = new BrowserStore({ source: null, pageSize: 1, filters: { sourceSystem: ["Epic"] } });
  store.setDataset({ entry: { packageId: "ALL" }, concepts, search, conceptById: new Map(concepts.map(c => [c.conceptId, c])) });
  assert.equal(store.getState().source, null);
  assert.equal(store.getState().results.total, 2);
  store.setPage(2);
  store.setFilter("sourceSystem", ["LIS", "REDCap"]);
  assert.equal(store.getState().page, 1);
  store.setFilter("domainId", ["Observation"]);
  store.clearFilter("sourceSystem");
  assert.deepEqual(store.getState().filters.domainId, ["Observation"]);
  assert.equal(store.getState().results.total, 4);
  store.clearAllFilters();
  assert.deepEqual(store.getState().filters.sourceSystem, []);
  assert.equal(store.getState().results.total, 5);
});
