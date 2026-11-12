import test from "node:test";
import assert from "node:assert/strict";
import { contextualFilterCounts, filterLabel } from "../../browser/js/ui/filters.js";
import { availablePackages, decodePackageSelection, encodePackageSelection } from "../../browser/js/ui/sourceSelector.js";
const concepts = [
  { vocabularyId: "A", domainId: "Observation", conceptClassId: "Term", standardConcept: null, invalidReason: null },
  { vocabularyId: "A", domainId: "Measurement", conceptClassId: "Term", standardConcept: "S", invalidReason: null },
  { vocabularyId: "B", domainId: "Observation", conceptClassId: "Code", standardConcept: "C", invalidReason: "D" },
  { vocabularyId: "B", domainId: "Observation", conceptClassId: "Term", standardConcept: null, invalidReason: null },
];
test("facet counts apply OR within and AND across facets, excluding own selection", () => {
  const counts = contextualFilterCounts(concepts, { vocabularyId: ["A", "B"], domainId: ["Observation"], standardConcept: [null, "C"] });
  assert.deepEqual([...counts.vocabularyId], [["A", 1], ["B", 2]]);
  assert.deepEqual([...counts.conceptClassId], [["Code", 1], ["Term", 2]]);
  assert.equal(counts.standardConcept.get(null), 2);
  assert.equal(counts.standardConcept.get("C"), 1);
});
test("nullable enum selections and empty input are counted without synthetic values", () => {
  assert.deepEqual([...contextualFilterCounts([], {}).invalidReason], []);
  assert.equal(contextualFilterCounts(concepts, { standardConcept: [null] }).invalidReason.get(null), 2);
  assert.equal(filterLabel("standardConcept", null), "Non-standard");
});
const manifest = { vocabularies: [
  { packageId: "GIS", browseable: true }, { packageId: "HPO", browseable: false },
  { packageId: "MIMIC", browseable: true }, { packageId: "WAVEFORM", browseable: true },
] };
test("package choices exclude unavailable entries and encode subsets deterministically", () => {
  const entries = availablePackages(manifest);
  assert.deepEqual(entries.map((entry) => entry.packageId), ["GIS", "MIMIC", "WAVEFORM"]);
  assert.equal(encodePackageSelection(["WAVEFORM", "GIS"], entries), '["GIS","WAVEFORM"]');
  assert.equal(encodePackageSelection(["GIS"], entries), "GIS");
  assert.equal(encodePackageSelection(["GIS", "MIMIC", "WAVEFORM"], entries), "__all__");
  assert.deepEqual(decodePackageSelection('["WAVEFORM","HPO","GIS"]', entries), ["GIS", "WAVEFORM"]);
});
test("invalid package selection cannot inject unknown or unavailable packages", () => {
  const entries = availablePackages(manifest);
  assert.deepEqual(decodePackageSelection("[bad", entries), []);
  assert.deepEqual(decodePackageSelection("HPO", entries), []);
  assert.equal(encodePackageSelection(["HPO"], entries), "[]");
  assert.deepEqual(decodePackageSelection("__all__", entries), ["GIS", "MIMIC", "WAVEFORM"]);
});
