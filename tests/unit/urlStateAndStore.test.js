import test from "node:test";
import assert from "node:assert/strict";

import { BrowserStore } from "../../browser/js/store.js";
import { createShareableUrl, readUrlState } from "../../browser/js/urlState.js";

const concepts = [
  concept("2000000001", "Alpha finding", "A", "Observation", "Finding", null, null),
  concept("2000000002", "Beta procedure", "A", "Procedure", "Procedure", "S", null),
  concept("2000000003", "Gamma finding", "B", "Observation", "Finding", "C", "D"),
];

const search = {
  documents: concepts.map((item, conceptOrdinal) => ({
    conceptOrdinal,
    conceptId: item.conceptId,
    normalizedCode: item.conceptCode.toLowerCase(),
    normalizedName: item.conceptName.toLowerCase(),
    normalizedSynonyms: [],
    nameTokens: item.conceptName.toLowerCase().split(" "),
    synonymTokens: [],
  })),
  lookups: {
    conceptId: Object.fromEntries(concepts.map((item, index) => [item.conceptId, index])),
    conceptCode: Object.fromEntries(concepts.map((item, index) => [item.conceptCode.toLowerCase(), [index]])),
    conceptName: Object.fromEntries(concepts.map((item, index) => [item.conceptName.toLowerCase(), [index]])),
    synonym: {},
  },
};

test("shareable URL round-trips source, search, nullable filters, paging, sort, and selection", () => {
  const state = {
    source: Object.freeze({ owner: "owner", repository: "repo", ref: "release/2026", canonical: "owner/repo@release/2026" }),
    selectedPackageId: "ALPHA",
    query: "beta & gamma",
    filters: {
      vocabularyId: ["A"],
      domainId: ["Observation"],
      conceptClassId: [],
      standardConcept: [null, "S"],
      invalidReason: [null],
    },
    page: 3,
    pageSize: 50,
    sort: { field: "conceptName", direction: "desc" },
    selectedConceptId: "2000000002",
  };

  const url = createShareableUrl(state, "https://example.test/browser/?old=value#section");
  const parsed = readUrlState(new URL(url).search);

  assert.equal(parsed.source.canonical, "owner/repo@release/2026");
  assert.equal(parsed.selectedPackageId, "ALPHA");
  assert.equal(parsed.query, "beta & gamma");
  assert.deepEqual(parsed.filters.standardConcept, [null, "S"]);
  assert.deepEqual(parsed.filters.invalidReason, [null]);
  assert.equal(parsed.page, 3);
  assert.equal(parsed.pageSize, 50);
  assert.deepEqual(parsed.sort, { field: "conceptName", direction: "desc" });
  assert.equal(parsed.selectedConceptId, "2000000002");
});

test("URL parsing rejects unsafe repository input and falls back for invalid positive integers", () => {
  assert.throws(() => readUrlState("?repository=owner%2F..%2Frepo&ref=main"));
  const state = readUrlState("?page=-2&page-size=unsafe");
  assert.equal(state.page, 1);
  assert.equal(state.pageSize, 25);
});

test("local source URLs contain no private state, while the live store retains it", () => {
  const local = { provider: "local-directory", folderName: "Secret folder", canonical: "Local folder - Secret folder" };
  const store = new BrowserStore({ source: local });
  store.setSelectedPackage("Secret package");
  store.setQuery("sensitive query");
  store.setFilter("domainId", ["sensitive domain"]);
  store.selectConcept("2099999999");
  const url = createShareableUrl(store.getState(), "https://example.test/browser/?old=secret#secret");
  assert.equal(url, "https://example.test/browser/?local-source=1");
  assert.equal(store.getState().query, "sensitive query");
  assert.deepEqual(store.getState().filters.domainId, ["sensitive domain"]);
  assert.equal(store.getState().selectedConceptId, "2099999999");
  const parsed = readUrlState(new URL(url).search);
  assert.equal(parsed.localSourceRequested, true);
  assert.equal(parsed.source.provider, "local-directory");
  assert.equal(parsed.selectedPackageId, null);
  assert.equal(parsed.query, "");
  assert.equal(parsed.selectedConceptId, null);
});

test("legacy local URLs do not restore query, filters, selected IDs or other view state", () => {
  const parsed = readUrlState("?local-source=1&q=private&domain=private&vocabulary=private&concept=123&page=4&sort=private");
  assert.equal(parsed.query, "");
  assert.deepEqual(parsed.filters, {});
  assert.equal(parsed.selectedPackageId, null);
  assert.equal(parsed.selectedConceptId, null);
  assert.equal(parsed.page, 1);
  assert.equal(parsed.sort, null);
});

test("switching from a local to a remote source never emits local state with remote URLs", () => {
  const local = { provider: "local-directory", folderName: "Private" };
  const store = new BrowserStore({ source: local });
  store.setSelectedPackage("Private package");
  store.setQuery("Private query");
  store.setFilter("domainId", ["Private domain"]);
  store.selectConcept("2099999999");
  store.setSort("conceptName");
  const emitted = [];
  store.subscribe((state) => emitted.push(createShareableUrl(state, "https://example.test/browser/")));
  store.setSource({ provider: "github", owner: "owner", repository: "repo", ref: "main" });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], "https://example.test/browser/?repository=owner%2Frepo&ref=main");
  assert.equal(store.getState().query, "");
  assert.deepEqual(store.getState().filters.domainId, []);
  assert.equal(store.getState().sort, null);
});

test("store composes filters without discarding unrelated state and preserves OMOP blanks", () => {
  const store = createLoadedStore();
  store.setFilter("domainId", ["Observation"]);
  assert.equal(store.getState().results.total, 2);

  store.setFilter("standardConcept", [null]);
  assert.equal(store.getState().results.total, 1);
  assert.equal(store.getState().results.items[0].concept.conceptId, "2000000001");
  assert.deepEqual(store.getState().filters.domainId, ["Observation"]);

  store.clearFilter("standardConcept");
  assert.equal(store.getState().results.total, 2);
  assert.deepEqual(store.getState().filters.domainId, ["Observation"]);

  store.clearAllFilters();
  assert.equal(store.getState().results.total, 3);
  assert.ok(Object.values(store.getState().filters).every((values) => values.length === 0));
});

test("store resets paging after search/filter changes and clamps pages deterministically", () => {
  const store = createLoadedStore({ pageSize: 1 });
  store.setPage(99);
  assert.equal(store.getState().page, 3);
  store.setQuery("beta");
  assert.equal(store.getState().page, 1);
  assert.equal(store.getState().results.total, 1);
  store.setFilter("domainId", ["Observation"]);
  assert.equal(store.getState().page, 1);
  assert.equal(store.getState().results.total, 0);
});

function createLoadedStore(initial = {}) {
  const store = new BrowserStore(initial);
  store.setDataset({
    entry: { packageId: "ALPHA" },
    concepts,
    search,
    conceptById: new Map(concepts.map((item) => [item.conceptId, item])),
  });
  return store;
}

function concept(conceptId, conceptName, vocabularyId, domainId, conceptClassId, standardConcept, invalidReason) {
  return {
    conceptId,
    conceptName,
    vocabularyId,
    domainId,
    conceptClassId,
    standardConcept,
    invalidReason,
    conceptCode: `CODE-${conceptId.at(-1)}`,
    validStartDate: "2026-01-01",
    validEndDate: "2099-12-31",
  };
}
