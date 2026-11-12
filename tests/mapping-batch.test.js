import test from "node:test";
import assert from "node:assert/strict";
import { createBatchSubmissionDraft, createMappingSubmissionDraft } from "../browser/js/services/mappingBatchService.js";
import { createSubmissionDraft } from "../browser/js/services/reviewService.js";

const context = { source: "fixture", packageId: "MIMIC", concepts: [
  { conceptId: "123", vocabularyId: "LOCAL" }, { conceptId: "124", vocabularyId: "LOCAL" },
] };
const mapping = { kind: "mapping", subject_id: "456", source_vocabulary_id: "SOURCE", mapping_author: "Test author",
  mapping_author_affiliation: "Test institution", mapping_reviewer: "", mapping_reviewer_affiliation: "",
  relationships: [{ object_id: "123", target_vocabulary_id: "LOCAL", predicate_id: "exactMatch", relationship_id: "Maps to" }] };
const now = new Date("2026-01-01T00:00:00Z");
const validateConcept = (values) => ({ valid: true, errors: [], draft: {
  kind: "concept", record: { concept_name: values.concept_name, vocabulary_id: values.vocabulary_id, concept_code: values.concept_code },
} });

test("mapping draft validates multiple relationships and preserves author affiliation without publication", () => {
  const result = createMappingSubmissionDraft({ ...mapping, relationships: [...mapping.relationships,
    { object_id: "124", target_vocabulary_id: "local", predicate_id: "broadMatch", relationship_id: "Custom relation" }] }, context, now);
  assert.equal(result.valid, true);
  assert.equal(result.draft.record.relationships.length, 2);
  assert.equal(result.draft.record.relationships[1].relationship_id, "Custom relation");
  assert.equal(result.draft.record.relationships[1].predicate_id, "skos:broadMatch");
  assert.equal(result.draft.metadata.authorAffiliation, "Test institution");
  assert.equal(result.draft.status, "draft-not-submitted");
});

test("mapping validation reports unverified targets, malformed IDs, missing affiliation and predicate", () => {
  const missing = createMappingSubmissionDraft({ ...mapping, mapping_author_affiliation: "", subject_id: "OMOP:456",
    relationships: [{ object_id: "999", target_vocabulary_id: "SNOMED", predicate_id: "invented", relationship_id: "Maps to" }] }, context, now);
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join("\n"), /positive integer/u);
  assert.match(missing.errors.join("\n"), /affiliation/u);
  assert.match(missing.errors.join("\n"), /allowed predicate/u);
  assert.equal(missing.draft, null);
  assert.equal(createMappingSubmissionDraft({ ...mapping, relationships: [{ ...mapping.relationships[0], target_vocabulary_id: "OTHER" }] }, context).valid, false);
  const unknown = createMappingSubmissionDraft({ ...mapping, relationships: [{ ...mapping.relationships[0], object_id: "8876", target_vocabulary_id: "UCUM" }] }, context);
  assert.equal(unknown.valid, true);
  assert.equal(unknown.draft.record.relationships[0].target_verification, "unverified");
  assert.match(unknown.draft.verification_warnings.join(" "), /not verified/u);
  assert.equal(createMappingSubmissionDraft(mapping, context).draft.record.relationships[0].target_verification, "verified-loaded");
});

test("duplicate target IDs across loaded packages are not considered uniquely verified", () => {
  const ambiguous = createMappingSubmissionDraft(mapping, { concepts: [
    { conceptId: "123", vocabularyId: "LOCAL", packageId: "P1" },
    { conceptId: "123", vocabularyId: "LOCAL", packageId: "P2" },
  ] });
  assert.equal(ambiguous.valid, true);
  assert.equal(ambiguous.draft.record.relationships[0].target_verification, "unverified");
  assert.match(ambiguous.draft.verification_warnings.join(" "), /not verified uniquely/u);
});

test("concept draft with null unknown domain and class survives batch round trip", () => {
  const record = { vocabulary_id: "CUSTOM", source_code_set: "SYS", concept_name: "New", concept_code: "CODE",
    domain_id: null, concept_class_id: null, standard_concept: "S", valid_start_date: "2026-01-01", valid_end_date: "2099-12-31", author: "Test author", author_affiliation: "Test institution" };
  const original = createSubmissionDraft({ kind: "concept", ...record }, context, now);
  assert.equal(original.valid, true);
  const batch = createBatchSubmissionDraft([original.draft], context, createSubmissionDraft, now);
  assert.equal(batch.valid, true);
  assert.equal(batch.draft.records[0].record.domain_id, null);
  assert.equal(batch.draft.records[0].record.concept_class_id, null);
  assert.match(batch.draft.verification_warnings.join(" "), /must be resolved/u);
});

test("batch requires author affiliation for concepts and mappings and preserves metadata through JSON round trip", () => {
  const record = { kind: "concept", vocabulary_id: "CUSTOM", source_code_set: "SYS", concept_name: "New", concept_code: "CODE",
    domain_id: null, concept_class_id: null, standard_concept: "S", valid_start_date: "2026-01-01", valid_end_date: "2099-12-31",
    author: "A", author_affiliation: "Institution A", reviewer: "R", reviewer_affiliation: "Institution R" };
  const missingAuthor = createBatchSubmissionDraft([{ ...record, author: "  " }], context, createSubmissionDraft, now);
  assert.equal(missingAuthor.valid, false);
  assert.match(missingAuthor.errors.join(" "), /Record 1: Author is required/u);
  for (const author_affiliation of ["", "  ", null]) {
    const missingAffiliation = createBatchSubmissionDraft([{ ...record, author_affiliation }], context, createSubmissionDraft, now);
    assert.equal(missingAffiliation.valid, false);
    assert.match(missingAffiliation.errors.join(" "), /Record 1: Author affiliation is required/u);
  }
  const missingMappingAffiliation = createBatchSubmissionDraft([{ ...mapping, mapping_author_affiliation: "  " }], context, createSubmissionDraft, now);
  assert.equal(missingMappingAffiliation.valid, false);
  assert.match(missingMappingAffiliation.errors.join(" "), /Record 1: Author affiliation is required/u);
  const withoutReviewerAffiliation = createBatchSubmissionDraft([{ ...record, reviewer: "", reviewer_affiliation: "" }, mapping], context, createSubmissionDraft, now);
  assert.equal(withoutReviewerAffiliation.valid, true, withoutReviewerAffiliation.errors.join("; "));
  assert.equal(withoutReviewerAffiliation.draft.records[0].metadata.reviewerAffiliation, null);
  assert.equal(withoutReviewerAffiliation.draft.records[1].metadata.reviewerAffiliation, null);
  const first = createBatchSubmissionDraft([record], context, createSubmissionDraft, now);
  assert.equal(first.valid, true);
  const serialized = JSON.parse(JSON.stringify(first.draft.records));
  const roundTrip = createBatchSubmissionDraft(serialized, context, createSubmissionDraft, now);
  assert.equal(roundTrip.valid, true);
  assert.equal(roundTrip.draft.records[0].metadata.authorAffiliation, "Institution A");
  assert.equal(roundTrip.draft.records[0].metadata.reviewerAffiliation, "Institution R");
});

test("a complete downloaded batch draft round-trips concepts and mapping metadata", () => {
  const concept = { kind: "concept", vocabulary_id: "CUSTOM", source_code_set: "SYS", concept_name: "New", concept_code: "CODE",
    domain_id: "Unit", concept_class_id: "Unit", standard_concept: "S", valid_start_date: "2026-01-01", valid_end_date: "2099-12-31",
    author: "A", author_affiliation: "Institution A", reviewer: "R", reviewer_affiliation: "Institution R",
    publication_date: "2026-04-03", rationale: "Concept rationale" };
  const mappingWithMetadata = { ...mapping, source_code_set: "Original system", target_system: "Target system", confidence: 0,
    publication_date: "2026-04-04", rationale: "Mapping rationale", mapping_reviewer: "Reviewer", mapping_reviewer_affiliation: "Institute" };
  const original = createBatchSubmissionDraft([concept, mappingWithMetadata], context, createSubmissionDraft, now);
  assert.equal(original.valid, true, original.errors.join("; "));
  const downloadedEnvelope = JSON.parse(JSON.stringify(original.draft));
  const reimport = createBatchSubmissionDraft(downloadedEnvelope, context, createSubmissionDraft, now);
  assert.equal(reimport.valid, true, reimport.errors.join("; "));
  assert.deepEqual(reimport.draft.records.map(({ record, metadata }) => ({ record, metadata })),
    original.draft.records.map(({ record, metadata }) => ({ record, metadata })));
  assert.equal(reimport.draft.records[0].metadata.publicationDate, "2026-04-03");
  assert.equal(reimport.draft.records[1].record.confidence, 0);
  assert.equal(reimport.draft.records[1].metadata.publicationDate, "2026-04-04");
});

test("mapping rejects malformed optional confidence and publication date", () => {
  for (const confidence of [-1, 1.1, "invalid"]) {
    assert.match(createMappingSubmissionDraft({ ...mapping, confidence }, context).errors.join(" "), /Confidence must be/u);
  }
  assert.match(createMappingSubmissionDraft({ ...mapping, publication_date: "2026-02-30" }, context).errors.join(" "), /publication_date/u);
});

test("batch validates every concept and mapping and does not create an issue", () => {
  const valid = createBatchSubmissionDraft({ concepts: [{ concept_name: "Alpha", vocabulary_id: "X", concept_code: "A" }], mappings: [mapping] }, context, validateConcept, now);
  assert.equal(valid.valid, true);
  assert.equal(valid.draft.kind, "batch");
  assert.equal(valid.draft.records.length, 2);
  assert.equal(valid.draft.status, "draft-not-submitted");
  const invalid = createBatchSubmissionDraft({ concepts: [], mappings: [{ ...mapping, subject_id: "0" }] }, context, validateConcept, now);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /Record 1.*positive integer/u);
});

test("flat JSON mapping records accept source and target concept ID field names", () => {
  const result = createBatchSubmissionDraft({ mappings: [{ source_concept_id: "456", source_vocabulary_id: "SOURCE",
    target_concept_id: "123", target_vocabulary_id: "LOCAL", predicate_id: "relatedMatch", relationship_id: "Is a",
    author: "Reviewer", author_affiliation: "Institution" }] }, context, validateConcept, now);
  assert.equal(result.valid, true);
  assert.equal(result.draft.records[0].record.relationships[0].object_id, "123");
});

test("mapping rejects unsafe numeric JSON identifiers and preserves quoted large IDs", () => {
  const fixture = JSON.parse('{"subject_id":9007199254740993,"source_vocabulary_id":"SOURCE","target_concept_id":9007199254740993,"target_vocabulary_id":"LOCAL","predicate_id":"exactMatch","relationship_id":"Maps to","author":"A","author_affiliation":"B"}');
  const unsafe = createMappingSubmissionDraft(fixture, context, now);
  assert.equal(unsafe.valid, false);
  assert.match(unsafe.errors.join("\n"), /Source concept ID is not a safe integer/u);
  assert.match(unsafe.errors.join("\n"), /target concept ID is not a safe integer/u);
  const quoted = createMappingSubmissionDraft({ ...fixture, subject_id: "9007199254740993", target_concept_id: "9007199254740993" }, context, now);
  assert.equal(quoted.valid, true);
  assert.equal(quoted.draft.record.subject_id, "9007199254740993");
  assert.equal(quoted.draft.record.relationships[0].object_id, "9007199254740993");
});

test("invalid relationship object is reported rather than throwing", () => {
  const invalid = createMappingSubmissionDraft({ ...mapping, relationships: [null] }, context, now);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /expected a relationship object/u);
});

test("batch rejects duplicate concept names across vocabularies and codes within vocabulary", () => {
  const batch = [
    { kind: "concept", concept_name: "Name", vocabulary_id: "A", concept_code: "X" },
    { kind: "concept", concept_name: "name", vocabulary_id: "B", concept_code: "Y" },
    { kind: "concept", concept_name: "Another", vocabulary_id: "a", concept_code: "X" },
  ];
  const result = createBatchSubmissionDraft(batch, context, validateConcept, now);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /concept name duplicates/u);
  assert.match(result.errors.join("\n"), /concept code duplicates/u);
  assert.equal(result.draft, null);
});

test("batch uses the same Unicode normalization as loaded-vocabulary uniqueness checks", () => {
  const result = createBatchSubmissionDraft([
    { kind: "concept", concept_name: "Ａlpha", vocabulary_id: "Ａ", concept_code: "X" },
    { kind: "concept", concept_name: "alpha", vocabulary_id: "a", concept_code: "X" },
  ], context, validateConcept, now);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /concept name duplicates/u);
  assert.match(result.errors.join(" "), /concept code duplicates/u);
});

test("batch preserves case-sensitive concept codes and aggregates warnings", () => {
  const batch = [
    { kind: "concept", concept_name: "One", vocabulary_id: "A", concept_code: "x" },
    { kind: "concept", concept_name: "Two", vocabulary_id: "A", concept_code: "X" },
    { ...mapping, relationships: [{ ...mapping.relationships[0], object_id: "8876", target_vocabulary_id: "UCUM" }] },
  ];
  const result = createBatchSubmissionDraft(batch, context, validateConcept, now);
  assert.equal(result.valid, true);
  assert.match(result.draft.verification_warnings.join(" "), /Record 3.*not verified/u);
});

test("batch rejects empty and malformed structures without throwing", () => {
  for (const bad of [[], {}, { concepts: "bad", mappings: [] }, [{ kind: "other" }]]) {
    assert.equal(createBatchSubmissionDraft(bad, context, validateConcept, now).valid, false);
  }
});
