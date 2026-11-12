import { validateDate } from "../model/concept.js";

const PREDICATES = new Set(["exactMatch", "broadMatch", "narrowMatch", "relatedMatch"]);

function text(value) { return String(value ?? "").trim(); }
function normalizedKey(value) { return text(value).normalize("NFKC").toLocaleLowerCase("en-US"); }
function valuesList(value) { return Array.isArray(value) ? value : [value]; }
function validPositiveId(value) { return /^[0-9]+$/u.test(value) && !/^0+$/u.test(value); }
function unsafeNumericId(value) { return typeof value === "number" && !Number.isSafeInteger(value); }
function normalizeConcepts(context) {
  return context.concepts ?? context.dataset?.concepts ?? [];
}

/** Prepare a review draft, marking targets that cannot be uniquely verified in loaded data. */
export function createMappingSubmissionDraft(values, context = {}, now = new Date()) {
  const errors = [];
  const warnings = [];
  const sourceId = text(values.subject_id ?? values.source_concept_id);
  const sourceVocabulary = text(values.source_vocabulary_id);
  const author = text(values.mapping_author ?? values.author);
  const affiliation = text(values.mapping_author_affiliation ?? values.author_affiliation);
  const reviewer = text(values.mapping_reviewer ?? values.reviewer);
  const reviewerAffiliation = text(values.mapping_reviewer_affiliation ?? values.reviewer_affiliation);
  const sourceCodeSet = text(values.source_code_set);
  const targetSystem = text(values.target_system);
  const rationale = text(values.rationale);
  const publicationDate = text(values.publication_date);
  const confidenceValue = values.confidence;
  let confidence;
  if (confidenceValue !== undefined && confidenceValue !== null && text(confidenceValue) !== "") {
    confidence = Number(confidenceValue);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push("Confidence must be a number between 0 and 1.");
  }
  if (publicationDate) {
    try { validateDate(publicationDate, { source: "draft", rowNumber: 1, field: "publication_date" }); }
    catch (error) { errors.push(error.message); }
  }
  if (unsafeNumericId(values.subject_id ?? values.source_concept_id)) errors.push("Source concept ID is not a safe integer. Enter large IDs as quoted strings in JSON.");
  if (!validPositiveId(sourceId)) errors.push("Source concept ID must be a positive integer.");
  if (!sourceVocabulary || sourceVocabulary.length > 20) errors.push("Source vocabulary ID is required and must not exceed 20 characters.");
  if (!author) errors.push("Author is required.");
  if (!affiliation) errors.push("Author affiliation is required.");
  const relationships = Array.isArray(values.relationships) ? values.relationships :
    valuesList(values.relationship_id).map((relationship, index) => ({
      relationship_id: relationship,
      predicate_id: valuesList(values.predicate_id)[index],
      object_id: valuesList(values.object_id ?? values.target_concept_id)[index],
      target_vocabulary_id: valuesList(values.target_vocabulary_id)[index],
    }));
  if (!relationships.length) errors.push("At least one relationship is required.");
  const concepts = normalizeConcepts(context);
  const mapped = relationships.map((row, index) => {
    const prefix = `Relationship ${index + 1}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`${prefix}: expected a relationship object.`);
      return null;
    }
    if (unsafeNumericId(row.object_id ?? row.target_concept_id)) errors.push(`${prefix}: target concept ID is not a safe integer. Enter large IDs as quoted strings in JSON.`);
    const targetId = text(row.object_id ?? row.target_concept_id);
    const targetVocabulary = text(row.target_vocabulary_id);
    const predicate = text(row.predicate_id).replace(/^skos:/u, "");
    const relationshipId = text(row.relationship_id);
    if (!validPositiveId(targetId)) errors.push(`${prefix}: target concept ID must be a positive integer.`);
    if (!targetVocabulary || targetVocabulary.length > 20) errors.push(`${prefix}: target vocabulary ID is required and must not exceed 20 characters.`);
    if (!PREDICATES.has(predicate)) errors.push(`${prefix}: choose an allowed predicate.`);
    if (!relationshipId) errors.push(`${prefix}: relationship is required.`);
    const idMatches = concepts.filter((concept) => String(concept.conceptId ?? concept.concept_id ?? "") === targetId);
    const vocabularyMatches = idMatches.filter((concept) => text(concept.vocabularyId ?? concept.vocabulary_id).toLocaleLowerCase() === targetVocabulary.toLocaleLowerCase());
    const verified = vocabularyMatches.length === 1;
    if (validPositiveId(targetId) && targetVocabulary && !verified) {
      if (idMatches.length && !vocabularyMatches.length) errors.push(`${prefix}: target ID is present in loaded data under a different vocabulary.`);
      else warnings.push(`${prefix}: target ${targetId} in ${targetVocabulary} was not verified${vocabularyMatches.length > 1 ? " uniquely across loaded packages" : ""}. Confirm it against Athena or the relevant custom vocabulary before publication.`);
    }
    return { object_id: targetId, target_vocabulary_id: targetVocabulary, predicate_id: `skos:${predicate}`, relationship_id: relationshipId, target_verification: verified ? "verified-loaded" : "unverified" };
  });
  if (errors.length) return { valid: false, errors, draft: null };
  return {
    valid: true, errors: [], draft: {
      schema: "cvb-review-draft/1", status: "draft-not-submitted", kind: "mapping", createdAt: now.toISOString(),
      context: { source: context.source ?? null, packageId: context.packageId ?? null },
      record: { subject_id: sourceId, source_vocabulary_id: sourceVocabulary, relationships: mapped,
        ...(sourceCodeSet ? { source_code_set: sourceCodeSet } : {}), ...(targetSystem ? { target_system: targetSystem } : {}),
        ...(confidence !== undefined ? { confidence } : {}) },
      metadata: { author, authorAffiliation: affiliation, reviewer: reviewer || null, reviewerAffiliation: reviewerAffiliation || null,
        ...(publicationDate ? { publicationDate } : {}), ...(rationale ? { rationale } : {}) },
      verification_warnings: warnings,
      notice: "Review draft only; no issue has been submitted or mapping published. Targets were checked only against loaded data, not the full Athena catalog.",
    },
  };
}

function unwrap(item, kind) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const metadata = item.metadata ?? {};
  return {
    ...item, ...(item.record ?? {}), kind,
    author: item.author ?? metadata.author,
    author_affiliation: item.author_affiliation ?? metadata.authorAffiliation,
    reviewer: item.reviewer ?? metadata.reviewer,
    reviewer_affiliation: item.reviewer_affiliation ?? metadata.reviewerAffiliation,
    rationale: item.rationale ?? metadata.rationale,
    publication_date: item.publication_date ?? metadata.publicationDate,
  };
}

/** Validate a JSON batch record by record; no data is transmitted here. */
export function createBatchSubmissionDraft(input, context = {}, validateConcept, now = new Date()) {
  if (typeof validateConcept !== "function") throw new TypeError("A concept validator is required.");
  let entries;
  if (Array.isArray(input)) entries = input.map((item) => ({ kind: item?.kind, item }));
  else if (input && input.schema === "cvb-review-batch/1" && input.kind === "batch" && Array.isArray(input.records)) {
    entries = input.records.map((item) => ({ kind: item?.kind, item }));
  }
  else if (input && typeof input === "object" && (Array.isArray(input.concepts) || Array.isArray(input.mappings)) &&
    (input.concepts === undefined || Array.isArray(input.concepts)) && (input.mappings === undefined || Array.isArray(input.mappings))) {
    entries = [...(input.concepts ?? []).map((item) => ({ kind: "concept", item })), ...(input.mappings ?? []).map((item) => ({ kind: "mapping", item }))];
  } else return { valid: false, errors: ["Provide a JSON array of records with kind concept or mapping, or an object with concepts and mappings arrays."], draft: null };
  if (!entries.length) return { valid: false, errors: ["The batch contains no records."], draft: null };
  const errors = [];
  const records = [];
  const warnings = [];
  const seenNames = new Set();
  const seenCodes = new Set();
  for (let i = 0; i < entries.length; i++) {
    const { kind, item } = entries[i];
    if (!["concept", "mapping"].includes(kind)) { errors.push(`Record ${i + 1}: kind must be concept or mapping.`); continue; }
    const values = unwrap(item, kind);
    if (!values) { errors.push(`Record ${i + 1}: expected an object.`); continue; }
    const result = kind === "concept" ? validateConcept(values, context, now) : createMappingSubmissionDraft(values, context, now);
    if (!result.valid) { errors.push(...result.errors.map((error) => `Record ${i + 1}: ${error}`)); continue; }
    warnings.push(...(result.draft.verification_warnings ?? []).map((warning) => `Record ${i + 1}: ${warning}`));
    if (kind === "concept") {
      const record = result.draft.record;
      const name = normalizedKey(record.concept_name);
      const code = `${normalizedKey(record.vocabulary_id)}\u0000${text(record.concept_code)}`;
      if (seenNames.has(name)) errors.push(`Record ${i + 1}: concept name duplicates another batch record.`);
      if (seenCodes.has(code)) errors.push(`Record ${i + 1}: concept code duplicates another batch record in the same vocabulary.`);
      seenNames.add(name); seenCodes.add(code);
    }
    records.push(result.draft);
  }
  if (errors.length) return { valid: false, errors, draft: null };
  return { valid: true, errors: [], draft: {
    schema: "cvb-review-batch/1", status: "draft-not-submitted", kind: "batch", createdAt: now.toISOString(),
    context: { source: context.source ?? null, packageId: context.packageId ?? null }, records, verification_warnings: warnings,
    notice: "Review draft only. No issue has been submitted and no vocabulary records have been published.",
  } };
}
