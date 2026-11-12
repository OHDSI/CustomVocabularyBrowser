import test from "node:test";
import assert from "node:assert/strict";
import { validateConceptDraft } from "../browser/js/services/conceptDraftValidation.js";

const standard = {
  vocabulary_id: "MYVOCAB", source_code_set: "source system", concept_name: "A concept",
  concept_code: "A1", domain_id: "Observation", concept_class_id: "Clinical Finding",
  standard_concept: "S", valid_start_date: "2026-11-05", valid_end_date: "2099-12-31",
};
const inspect = (values, context = {}) => validateConceptDraft({ ...standard, ...values }, context);

test("standard draft has no allocated ID and allows an optional hierarchy", () => {
  const { record, errors } = inspect({ parent_concept_ids: "123,456" });
  assert.deepEqual(errors, []);
  assert.deepEqual(record.parent_concept_ids, ["123", "456"]);
  assert.equal(Object.hasOwn(record, "concept_id"), false);
});

test("custom names and codes are checked against loaded vocabularies and known Athena IDs", () => {
  const concepts = [{ conceptName: "A CONCEPT", conceptCode: "A1", vocabularyId: "myvocab" }];
  const result = inspect({}, { customConcepts: concepts });
  assert.match(result.errors.join(" "), /name already exists/iu);
  assert.match(result.errors.join(" "), /code already exists/iu);
  assert.match(inspect({ vocabulary_id: "snomed" }).errors.join(" "), /Athena vocabulary/iu);
  assert.match(inspect({ vocabulary_id: "NewStandard" }, { standardVocabularyIds: new Set(["newstandard"]) }).errors.join(" "), /Athena vocabulary/iu);
  assert.equal(inspect({ concept_code: "A1", vocabulary_id: "different" }, { customConcepts: concepts }).errors.some((e) => /code already/u.test(e)), false);
});

test("mapping and hierarchy enforce allowed standardness and cardinality", () => {
  const loaded = { customConcepts: [{ conceptId: "123" }, { conceptId: "456" }] };
  assert.deepEqual(inspect({ standard_concept: "", maps_to: ["123"], maps_to_value: "456" }, loaded).errors, []);
  assert.match(inspect({ standard_concept: "", maps_to: ["123"] }).warnings.join(" "), /could not be verified/iu);
  assert.match(inspect({ standard_concept: "", maps_to: ["123", "124"], maps_to_value: "456" }).errors.join(" "), /at most one/iu);
  assert.match(inspect({ standard_concept: "S", maps_to: ["123"] }).errors.join(" "), /must be non-standard/iu);
  assert.match(inspect({ standard_concept: "", maps_to: ["123"], child_concept_ids: ["456"] }).errors.join(" "), /cannot be used together/iu);
  assert.match(inspect({ standard_concept: "C" }).errors.join(" "), /requires at least one child/iu);
  assert.deepEqual(inspect({ standard_concept: "C", child_concept_ids: ["456"] }).errors, []);
  assert.match(inspect({ standard_concept: "" }).errors.join(" "), /requires a mapping/iu);
  assert.match(inspect({ standard_concept: "", maps_to: ["bad"] }).errors.join(" "), /positive integer/iu);
});

test("concept hierarchy and mapping fields reject unsafe numeric JSON IDs but keep quoted IDs", () => {
  const unsafe = JSON.parse('{"parent_concept_ids":[9007199254740993],"child_concept_ids":[{"concept_id":9007199254740993}]}');
  assert.match(inspect(unsafe).errors.join(" "), /parent_concept_ids.*not a safe integer/u);
  assert.match(inspect(unsafe).errors.join(" "), /child_concept_ids.*not a safe integer/u);
  assert.match(inspect({ standard_concept: "", maps_to: [9007199254740992] }).errors.join(" "), /maps_to.*not a safe integer/u);
  assert.match(inspect({ standard_concept: "", maps_to_value: 9007199254740992 }).errors.join(" "), /maps_to_value.*not a safe integer/u);
  const safe = inspect({ parent_concept_ids: ["9007199254740993"] });
  assert.deepEqual(safe.errors, []);
  assert.deepEqual(safe.record.parent_concept_ids, ["9007199254740993"]);
});

test("limits, calendar dates and fixed end date are validated", () => {
  assert.match(inspect({ vocabulary_id: "x".repeat(21), concept_name: "x".repeat(256), concept_code: "x".repeat(51), domain_id: "x".repeat(21), concept_class_id: "x".repeat(21) }).errors.join(" "), /20 characters.*255 characters.*50 characters.*20 characters.*20 characters/iu);
  assert.match(inspect({ valid_start_date: "2026-02-29" }).errors.join(" "), /calendar date/iu);
  assert.match(inspect({ valid_start_date: "2100-01-01" }).errors.join(" "), /must not be after/iu);
  assert.match(inspect({ valid_end_date: "2098-01-01" }).errors.join(" "), /must be 2099-12-31/iu);
  const unknown = inspect({ domain_id: "Do not know", concept_class_id: "Do not know" });
  assert.deepEqual(unknown.errors, []);
  assert.equal(unknown.record.domain_id, null);
  assert.equal(unknown.record.concept_class_id, null);
  assert.match(unknown.warnings.join(" "), /must be resolved/iu);
  const roundTrip = inspect({ domain_id: null, concept_class_id: null });
  assert.deepEqual(roundTrip.errors, []);
  assert.equal(roundTrip.record.domain_id, null);
  assert.equal(roundTrip.record.concept_class_id, null);
  assert.match(roundTrip.warnings.join(" "), /must be resolved/iu);
  assert.match(inspect({ domain_id: "" }).errors.join(" "), /Domain is required/iu);
  assert.match(inspect({ concept_class_id: undefined }).errors.join(" "), /Concept class is required/iu);
});
