import test from "node:test";
import assert from "node:assert/strict";
import { createSubmissionDraft, runQualityChecks } from "../../browser/js/services/reviewService.js";

const concept = {
  conceptId: "2000000001", conceptName: "Example", vocabularyId: "TEST", domainId: "Observation",
  conceptClassId: "Test", conceptCode: "A", standardConcept: null, invalidReason: null,
  validStartDate: "2026-01-01", validEndDate: "2099-12-31", packageId: "A",
};
const state = (concepts = [concept]) => ({
  selectedPackageId: "A", dataset: { entry: { packageId: "A" }, concepts },
  manifest: { vocabularies: [{ packageId: "A" }] },
});
test("quality report distinguishes checked success from missing data and source warnings", () => {
  assert.equal(runQualityChecks(state()).status, "passed");
  assert.equal(runQualityChecks({}).status, "errors");
  const input = state(); input.dataset.entry.warnings = ["Orphan synonym row 2"];
  const report = runQualityChecks(input);
  assert.equal(report.status, "warnings");
  assert.equal(report.findings[0].message, "Orphan synonym row 2");
});
test("quality checks keep cross-package IDs distinct and flag duplicate IDs, codes and date order", () => {
  assert.equal(runQualityChecks(state([concept, { ...concept, packageId: "B" }])).status, "passed");
  const report = runQualityChecks(state([concept, { ...concept, validEndDate: "2025-01-01" }]));
  assert.ok(report.findings.some((finding) => finding.code === "duplicate-id"));
  assert.ok(report.findings.some((finding) => finding.code === "duplicate-code"));
  assert.ok(report.findings.some((finding) => finding.code === "date-order"));
  assert.equal(report.findings[0].conceptId, concept.conceptId);
});
test("all-package quality report includes unavailable package source errors", () => {
  const input = state(); input.selectedPackageId = "__all__";
  input.manifest.vocabularies.push({ packageId: "Broken", errors: ["Missing relationship table"] });
  assert.equal(runQualityChecks(input).status, "errors");
});
const conceptDraft = {
  kind: "concept", concept_name: "New concept", domain_id: "Observation", source_code_set: "Example",
  vocabulary_id: "TEST", concept_class_id: "Test", concept_code: "B", standard_concept: "",
  valid_start_date: "2026-01-01", valid_end_date: "2099-12-31", invalid_reason: "",
  author: "Example author", author_affiliation: "Example institution", rationale: "Review evidence", maps_to: ["123"],
};
test("concept draft validates schema and does not imply submission or ID allocation", () => {
  const result = createSubmissionDraft(conceptDraft, { source: "owner/repo", packageId: "A", customConcepts: [{ conceptId: "123" }] });
  assert.equal(result.valid, true);
  assert.equal(result.draft.status, "draft-not-submitted");
  assert.equal(result.draft.context.source, "owner/repo");
  assert.equal(createSubmissionDraft({ ...conceptDraft, concept_name: "" }).valid, false);
  assert.equal(createSubmissionDraft({ ...conceptDraft, valid_start_date: "2100-01-01" }).valid, false);
  assert.equal("concept_id" in result.draft.record, false);
  assert.equal(createSubmissionDraft(conceptDraft, { customConcepts: [{ conceptName: "NEW CONCEPT" }] }).valid, false);
});
test("concept proposals require author and affiliation and retain optional reviewer affiliation", () => {
  for (const author of ["", "   ", undefined]) {
    const result = createSubmissionDraft({ ...conceptDraft, author });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("Author is required."));
  }
  const result = createSubmissionDraft({ ...conceptDraft, author: "  Author A  ", author_affiliation: "  University A  ",
    reviewer: "  Reviewer B  ", reviewer_affiliation: "  Institute B  " });
  assert.equal(result.valid, true);
  assert.deepEqual(result.draft.metadata, { author: "Author A", authorAffiliation: "University A", reviewer: "Reviewer B",
    reviewerAffiliation: "Institute B", publicationDate: null, rationale: "Review evidence" });
  for (const author_affiliation of ["", "   ", undefined, null]) {
    const missing = createSubmissionDraft({ ...conceptDraft, author_affiliation });
    assert.equal(missing.valid, false);
    assert.ok(missing.errors.includes("Author affiliation is required."));
    assert.equal(missing.draft, null);
  }
  const minimal = createSubmissionDraft({ ...conceptDraft, reviewer: "", reviewer_affiliation: "" });
  assert.equal(minimal.valid, true);
  assert.equal(minimal.draft.metadata.authorAffiliation, "Example institution");
  assert.equal(minimal.draft.metadata.reviewerAffiliation, null);
});
test("mapping draft requires numeric IDs, affiliation and a verifiable loaded target", () => {
  const mapping = { kind: "mapping", subject_id: "1", source_vocabulary_id: "LOCAL", object_id: "123", target_vocabulary_id: "CUSTOM", predicate_id: "exactMatch", relationship_id: "Maps to", author: "Author", author_affiliation: "University" };
  const context = { concepts: [{ conceptId: "123", vocabularyId: "CUSTOM" }] };
  const result = createSubmissionDraft(mapping, context);
  assert.equal(result.valid, true);
  assert.equal(result.draft.record.relationships[0].predicate_id, "skos:exactMatch");
  assert.equal(createSubmissionDraft({ ...mapping, subject_id: "0" }, context).valid, false);
  assert.equal(createSubmissionDraft({ ...mapping, object_id: "unqualified" }, context).valid, false);
  const unknown = createSubmissionDraft(mapping, {});
  assert.equal(unknown.valid, true);
  assert.equal(unknown.draft.record.relationships[0].target_verification, "unverified");
  assert.ok(unknown.draft.verification_warnings.length);
});
test("quality report keeps runtime findings and affected source rows without double counting aggregate warnings", () => {
  const input = state([{ ...concept, validEndDate: "2025-01-01", source: { packageId: "A", file: "A/concept.csv", row: 4 } }]);
  input.selectedPackageId = "__all__";
  input.manifest.vocabularies[0].warnings = ["Existing source warning"];
  input.dataset.packages = [{ entry: { packageId: "A", warnings: ["Existing source warning", "Runtime metadata warning"] } }];
  input.dataset.entry.warnings = ["A: Existing source warning", "A: Runtime metadata warning", "B: Loading failed; omitted"];
  const report = runQualityChecks(input);
  assert.equal(report.findings.filter((item) => item.code === "source-warning").length, 3);
  assert.ok(report.findings.some((item) => item.message === "B: Loading failed; omitted"));
  const dateError = report.findings.find((item) => item.code === "date-order");
  assert.equal(dateError.sourceFile, "A/concept.csv");
  assert.equal(dateError.sourceRow, 4);
  assert.equal(dateError.packageId, "A");
});

test("subset quality reports include selected runtime packages, excluding unselected missing packages", () => {
  const input = state(); input.selectedPackageId = '["A","B"]';
  input.manifest.vocabularies.push({ packageId: "B", warnings: ["Warning B"] }, { packageId: "HPO", errors: ["Missing core"] });
  input.dataset.packages = [{ entry: { packageId: "A" } }, { entry: { packageId: "B", warnings: ["Warning B"] } }];
  input.dataset.entry.warnings = ["B: Warning B"];
  const report = runQualityChecks(input);
  assert.equal(report.status, "warnings");
  assert.equal(report.statistics.packages, 2);
  assert.equal(report.findings.length, 1);
});
