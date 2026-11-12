import test from "node:test";
import assert from "node:assert/strict";
import { contextualFilterValues } from "../../browser/js/ui/filters.js";
import { sourceSystemLabel } from "../../browser/js/ui/table.js";
import { DAILY_WISDOM, wisdomForDate } from "../../browser/js/ui/search.js";

const concepts = [
  { vocabularyId: "Exposome", domainId: "Observation", conceptClassId: "Exposure", standardConcept: null, invalidReason: null },
  { vocabularyId: "GIS", domainId: "Measurement", conceptClassId: "Geography", standardConcept: "S", invalidReason: null },
  { vocabularyId: "GIS", domainId: "Observation", conceptClassId: "Location", standardConcept: null, invalidReason: "D" },
];
test("facet options follow other active filters but retain alternatives within their own facet", () => {
  const facets = contextualFilterValues(concepts, { vocabularyId: ["Exposome"], domainId: [], conceptClassId: [] });
  assert.deepEqual(facets.domainId, ["Observation"]);
  assert.deepEqual(facets.conceptClassId, ["Exposure"]);
  assert.deepEqual(facets.vocabularyId, ["Exposome", "GIS"]);
});
test("facet context composes nullable filters and never invents reference-only vocabularies", () => {
  const facets = contextualFilterValues(concepts, { domainId: ["Observation"], standardConcept: [null], invalidReason: [null] });
  assert.deepEqual(facets.vocabularyId, ["Exposome"]);
  assert.deepEqual(facets.conceptClassId, ["Exposure"]);
  assert.deepEqual(contextualFilterValues([], {}).vocabularyId, []);
});
test("source systems remain separate from OMOP vocabulary membership", () => {
  assert.equal(sourceSystemLabel({ vocabularyId: "SNOMED", sourceSystems: ["Epic", "Epic", "LIS", ""] }), "Epic · LIS");
  assert.equal(sourceSystemLabel({ vocabularyId: "SNOMED" }), "Not supplied");
});
test("daily thought is deterministic for a local calendar day", () => {
  assert.equal(wisdomForDate(new Date(2026, 10, 3, 1)), wisdomForDate(new Date(2026, 10, 3, 23)));
  assert.ok(DAILY_WISDOM.includes(wisdomForDate(new Date(2026, 10, 3))));
});
