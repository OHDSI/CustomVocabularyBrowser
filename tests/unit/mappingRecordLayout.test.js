import test from "node:test";
import assert from "node:assert/strict";
import { mappingRecordFields } from "../../browser/js/ui/conceptDetails.js";

test("additional mapping statement follows source, predicate, confidence, target code, target name order", () => {
  const original = Object.freeze({ subjectCode: "GIS1000234", subjectVocabulary: "OMOP SDOH",
    objectCode: "POS_MEAN_DIST_ED", objectVocabulary: "None", predicate_id: "skos:narrowMatch", confidence: "1",
    associationStatus: "target-unverified", sourceRow: 102448 });
  assert.deepEqual(mappingRecordFields(original), [
    ["Source", "GIS1000234"], ["Predicate", "skos:narrowMatch"], ["Confidence", "1"],
    ["Target code", "POS_MEAN_DIST_ED"], ["Target name", "Not supplied"],
  ]);
  assert.equal(original.sourceRow, 102448);
  assert.equal(original.associationStatus, "target-unverified");
});

test("mapping statement uses supplied names, displays zero confidence, and never invents target identity", () => {
  assert.deepEqual(mappingRecordFields({ source_description: "Source name", subjectCode: "A",
    predicate_id: "skos:relatedMatch", confidence: 0, objectCode: "B", object_label: "Target name" }), [
    ["Source", "Source name (A)"], ["Predicate", "skos:relatedMatch"], ["Confidence", 0],
    ["Target code", "B"], ["Target name", "Target name"],
  ]);
});
