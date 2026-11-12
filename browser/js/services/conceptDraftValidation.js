import { sameConceptCode } from "../model/codeMatching.js";
import { validateDate } from "../model/concept.js";

// A conservative local denylist, not a complete or current Athena catalogue.
export const KNOWN_ATHENA_VOCABULARIES = Object.freeze([
  "SNOMED", "LOINC", "ICD10CM", "ICD9CM", "ICD10", "ICD9Proc", "RxNorm",
  "RxNorm Extension", "CPT4", "HCPCS", "NDC", "UCUM", "ATC", "MeSH", "OMOP Extension",
]);

const text = (value) => String(value ?? "").trim();
const key = (value) => text(value).normalize("NFKC").toLocaleLowerCase("en-US");

function list(value) {
  const input = Array.isArray(value) ? value : text(value).split(/[\n,;]/u);
  return input.map((item) => text(typeof item === "object" && item !== null
    ? item.target_concept_id ?? item.concept_id ?? "" : item)).filter(Boolean);
}

/** Validate a proposed concept without assigning a concept ID or implying publication. */
export function validateConceptDraft(values, context = {}) {
  const errors = [];
  const warnings = ["Vocabulary names were checked against known Athena names only; the full Athena catalog was not checked. Concept name and code uniqueness were checked only in loaded custom vocabularies."];
  for (const field of ["maps_to", "maps_to_value", "parent_concept_ids", "child_concept_ids"]) {
    const items = Array.isArray(values[field]) ? values[field] : [values[field]];
    for (const item of items) {
      const id = item && typeof item === "object" ? item.target_concept_id ?? item.concept_id : item;
      if (typeof id === "number" && !Number.isSafeInteger(id)) {
        errors.push(`${field} contains a numeric ID that is not a safe integer. Enter large IDs as quoted strings in JSON.`);
      }
    }
  }
  const required = (field, label, maximum) => {
    if ((field === "domain_id" || field === "concept_class_id") && values[field] === null) return "Do not know";
    const value = text(values[field]);
    if (!value) errors.push(`${label} is required.`);
    if (maximum && [...value].length > maximum) errors.push(`${label} must be at most ${maximum} characters.`);
    return value;
  };
  const record = {
    vocabulary_id: required("vocabulary_id", "Custom vocabulary name", 20),
    source_code_set: required("source_code_set", "Source system"),
    concept_name: required("concept_name", "Concept name", 255),
    concept_code: required("concept_code", "Concept code", 50),
    domain_id: required("domain_id", "Domain", 20),
    concept_class_id: required("concept_class_id", "Concept class", 20),
    standard_concept: text(values.standard_concept),
    valid_start_date: required("valid_start_date", "Valid start date"),
    valid_end_date: text(values.valid_end_date),
    invalid_reason: "",
    maps_to: list(values.maps_to),
    maps_to_value: text(values.maps_to_value),
    parent_concept_ids: list(values.parent_concept_ids),
    child_concept_ids: list(values.child_concept_ids),
  };

  const known = new Set([...KNOWN_ATHENA_VOCABULARIES, ...(context.standardVocabularyIds ?? [])].map(key));
  if (record.vocabulary_id && known.has(key(record.vocabulary_id))) {
    errors.push("Custom vocabulary name matches a known Athena vocabulary. Choose a custom vocabulary name.");
  }

  const concepts = context.customConcepts ?? context.concepts ?? [];
  const duplicateName = record.concept_name && concepts.some((concept) => key(concept.conceptName ?? concept.concept_name) === key(record.concept_name));
  if (duplicateName) errors.push("Concept name already exists in the loaded custom vocabularies (case-insensitive).");
  const duplicateCode = record.concept_code && record.vocabulary_id && concepts.some((concept) =>
    key(concept.vocabularyId ?? concept.vocabulary_id) === key(record.vocabulary_id)
    && sameConceptCode(text(concept.conceptCode ?? concept.concept_code), record.concept_code));
  if (duplicateCode) errors.push("Concept code already exists in this loaded vocabulary.");

  if (!['', 'S', 'C'].includes(record.standard_concept)) errors.push("Standard concept must be non-standard, S, or C.");
  const hasMapping = record.maps_to.length > 0 || Boolean(record.maps_to_value);
  const hasHierarchy = record.parent_concept_ids.length > 0 || record.child_concept_ids.length > 0;
  if (hasMapping && hasHierarchy) errors.push("Mappings and hierarchy cannot be used together for this concept.");
  if (hasMapping && record.standard_concept !== "") errors.push("A mapped concept must be non-standard.");
  if (record.maps_to_value && record.maps_to.length > 1) errors.push("Maps to value allows at most one Maps to target.");
  if (hasHierarchy && !['S', 'C'].includes(record.standard_concept)) errors.push("Hierarchy requires standard or classification status.");
  if (record.standard_concept === 'C' && !record.child_concept_ids.length) errors.push("A classification concept requires at least one child.");
  if (record.standard_concept === '' && !hasMapping) errors.push("A non-standard concept requires a mapping.");

  for (const [name, identifiers] of Object.entries({ maps_to: record.maps_to, maps_to_value: record.maps_to_value ? [record.maps_to_value] : [], parent_concept_ids: record.parent_concept_ids, child_concept_ids: record.child_concept_ids })) {
    for (const identifier of identifiers) {
      if (!/^[1-9]\d*$/u.test(identifier)) errors.push(`${name} must contain positive integer concept IDs.`);
    }
  }
  for (const identifier of [...record.maps_to, ...(record.maps_to_value ? [record.maps_to_value] : [])]) {
    if (!/^[1-9]\d*$/u.test(identifier)) continue;
    const matches = concepts.filter((concept) => String(concept.conceptId ?? concept.concept_id ?? "") === identifier);
    if (matches.length !== 1) warnings.push(`Mapping target ${identifier} could not be verified uniquely in loaded vocabularies. Confirm it against Athena or the relevant custom vocabulary before publication.`);
  }

  let startValid = false;
  try {
    validateDate(record.valid_start_date, { source: "draft", rowNumber: 1, field: "valid_start_date" });
    startValid = true;
  } catch (error) { errors.push(error.message); }
  if (record.valid_end_date !== '2099-12-31') errors.push("Valid end date must be 2099-12-31.");
  if (startValid && record.valid_start_date.replaceAll('-', '') > '20991231') errors.push("Valid start date must not be after valid end date.");
  for (const field of ["domain_id", "concept_class_id"]) {
    if (key(record[field]) === "do not know") {
      record[field] = null;
      warnings.push(`${field} is unknown and must be resolved before publication.`);
    }
  }
  return { record, errors, warnings };
}
