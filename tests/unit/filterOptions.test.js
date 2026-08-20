import test from "node:test";
import assert from "node:assert/strict";

import { filterLabel, filterValues } from "../../browser/js/ui/filters.js";

test("OMOP enum filters always expose every supported value including null", () => {
  const facets = {
    standardConcept: ["S"],
    invalidReason: [null],
  };

  assert.deepEqual(filterValues("standardConcept", facets), ["S", "C", null]);
  assert.deepEqual(filterValues("invalidReason", facets), ["D", "U", null]);
});

test("OMOP enum filter labels keep source codes and explicit null semantics", () => {
  assert.equal(filterLabel("standardConcept", "S"), "S - Standard");
  assert.equal(filterLabel("standardConcept", "C"), "C - Classification");
  assert.equal(filterLabel("standardConcept", null), "Non-standard");
  assert.equal(filterLabel("invalidReason", "D"), "D - Deprecated");
  assert.equal(filterLabel("invalidReason", "U"), "U - Updated");
  assert.equal(filterLabel("invalidReason", null), "null - Valid");
});

test("data-derived filters retain authoritative facet values", () => {
  const facets = { domainId: ["Measurement", "Observation"] };
  assert.deepEqual(filterValues("domainId", facets), facets.domainId);
});
