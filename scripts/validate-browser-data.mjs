import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseIdentifier, parseNullableFlag, validateDate } from "../browser/js/model/concept.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  normalizeSearchText,
  tokenizeSearchText,
} from "../browser/js/services/vocabularyParser.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

export async function validateBrowserData(dataRoot = path.join(PROJECT_ROOT, "browser", "data")) {
  const root = path.resolve(dataRoot);
  const manifest = await readJson(path.join(root, "manifest.json"));
  const errors = [];
  if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    errors.push(`Unsupported manifest schema ${manifest.schemaVersion}.`);
  }
  for (const field of ["repository", "ref", "commit"]) {
    if (!manifest.source?.[field]) errors.push(`Manifest source.${field} is required.`);
  }
  if (manifest.source?.provider !== "github") errors.push("Manifest source.provider must be github.");
  if (!/^[0-9a-f]{40}$/iu.test(manifest.source?.commit ?? "")) {
    errors.push("Manifest source.commit must be a 40-character hexadecimal Git commit SHA.");
  }
  if (!/^\S+\/\S+$/u.test(manifest.source?.repository ?? "")) {
    errors.push("Manifest source.repository must use owner/repository form.");
  }
  if (!Array.isArray(manifest.requiredFiles)
    || !["concept_delta.csv", "concept_synonym_delta.csv", "concept_relationship_delta.csv"]
      .every((filename) => manifest.requiredFiles.includes(filename))) {
    errors.push("Manifest requiredFiles must include all three jointly required core datasets.");
  }
  if (!Array.isArray(manifest.vocabularies)) errors.push("Manifest vocabularies must be an array.");

  for (const entry of manifest.vocabularies ?? []) {
    if (!entry.browseable) continue;
    for (const required of ["concepts", "search", "synonyms", "relationships"]) {
      if (!entry.artifacts?.[required]) {
        errors.push(`${entry.packageId} lacks required ${required} artifact.`);
      }
    }
    if (errors.length > 0 && !entry.artifacts?.concepts) continue;

    const concepts = await readArtifact(root, entry, "concepts", errors);
    const search = await readArtifact(root, entry, "search", errors);
    const synonyms = await readArtifact(root, entry, "synonyms", errors);
    const relationships = await readArtifact(root, entry, "relationships", errors);
    const hierarchy = entry.artifacts?.hierarchy
      ? await readArtifact(root, entry, "hierarchy", errors)
      : null;
    if (!concepts || !search || !synonyms || !relationships) continue;

    if (!Array.isArray(concepts.concepts)) {
      errors.push(`${entry.packageId} concepts artifact must contain a concepts array.`);
      continue;
    }
    const conceptIds = new Set(concepts.concepts.map((concept) => concept.conceptId));
    if (conceptIds.size !== concepts.concepts.length) errors.push(`${entry.packageId} has duplicate artifact concept IDs.`);
    validateConcepts(entry.packageId, concepts.concepts, errors);
    validateFacets(entry.packageId, concepts, errors);
    const synonymRows = validateSynonyms(entry.packageId, synonyms, conceptIds, errors);
    validateRelationships(entry.packageId, relationships, errors);
    if (entry.counts.concepts !== concepts.concepts.length) errors.push(`${entry.packageId} concept count mismatch.`);
    if (entry.counts.synonyms !== synonymRows.length) errors.push(`${entry.packageId} synonym count mismatch.`);
    if (entry.counts.sourceSynonyms !== entry.counts.synonyms + entry.counts.orphanSynonyms) {
      errors.push(`${entry.packageId} source/orphan synonym counts are inconsistent.`);
    }
    if (entry.counts.relationships !== relationships.rows.length) errors.push(`${entry.packageId} relationship count mismatch.`);
    if (search.documents.length !== concepts.concepts.length) errors.push(`${entry.packageId} search document count mismatch.`);

    validateSearch(entry.packageId, search, concepts.concepts, synonyms.byConceptId, errors);
    validateExactIndex(
      entry.packageId,
      relationships.outgoing,
      buildRowIndex(relationships.rows, (row) => row.conceptId1),
      errors,
      "outgoing",
    );
    validateExactIndex(
      entry.packageId,
      relationships.incoming,
      buildRowIndex(relationships.rows, (row) => row.conceptId2),
      errors,
      "incoming",
    );
    validateRelationshipCounts(entry, relationships.rows, conceptIds, errors);
    validateDuplicateCodeCount(entry, concepts.concepts, errors);
    if (!sameArray(entry.vocabularyIds, concepts.facets.vocabularyId.filter((value) => value !== null))) {
      errors.push(`${entry.packageId} vocabularyIds do not match the concept artifact.`);
    }
    if (hierarchy) {
      validateHierarchy(entry.packageId, hierarchy, errors);
      if (entry.counts.ancestorRows !== hierarchy.rows.length) errors.push(`${entry.packageId} hierarchy count mismatch.`);
      validateExactIndex(
        entry.packageId,
        hierarchy.ancestors,
        buildRowIndex(hierarchy.rows, (row) => row.descendantConceptId),
        errors,
        "ancestors",
      );
      validateExactIndex(
        entry.packageId,
        hierarchy.descendants,
        buildRowIndex(hierarchy.rows, (row) => row.ancestorConceptId),
        errors,
        "descendants",
      );
      validateHierarchyCounts(entry, hierarchy.rows, conceptIds, errors);
    } else if (entry.counts.ancestorRows !== 0) {
      errors.push(`${entry.packageId} declares ancestor rows without a hierarchy artifact.`);
    }
  }

  if (errors.length > 0) throw new Error(`Browser artifact validation failed:\n${errors.join("\n")}`);
  return manifest;
}

async function readArtifact(root, entry, key, errors) {
  const relative = entry.artifacts?.[key];
  if (!relative) return null;
  const absolute = path.resolve(root, ...relative.split("/"));
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    errors.push(`${entry.packageId} ${key} artifact escapes the data directory.`);
    return null;
  }
  try {
    const artifact = await readJson(absolute);
    if (artifact.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
      errors.push(`${entry.packageId} ${key} artifact has unsupported schema ${artifact.schemaVersion}.`);
    }
    if (artifact.packageId && artifact.packageId !== entry.packageId) {
      errors.push(`${entry.packageId} ${key} artifact package mismatch.`);
    }
    return artifact;
  } catch (error) {
    errors.push(`${entry.packageId} ${key} artifact cannot be read: ${error.message}`);
    return null;
  }
}

function validateConcepts(packageId, concepts, errors) {
  concepts.forEach((concept, ordinal) => {
    const label = `${packageId} concept row ${ordinal}`;
    validateIdentifierValue(concept.conceptId, `${label} conceptId`, errors);
    for (const field of ["conceptName", "domainId", "vocabularyId", "conceptClassId", "conceptCode"]) {
      validateNonBlankText(concept[field], `${label} ${field}`, errors);
    }
    validateFlagValue(concept.standardConcept, ["S", "C"], `${label} standardConcept`, errors);
    validateFlagValue(concept.invalidReason, ["D", "U"], `${label} invalidReason`, errors);
    validateDateValue(concept.validStartDate, `${label} validStartDate`, errors);
    validateDateValue(concept.validEndDate, `${label} validEndDate`, errors);
    if (!concept.source || concept.source.packageId !== packageId
      || typeof concept.source.file !== "string" || !Number.isInteger(concept.source.row)
      || concept.source.row < 2) {
      errors.push(`${label} has invalid source provenance.`);
    }
  });
}

function validateFacets(packageId, artifact, errors) {
  const expected = {
    vocabularyId: uniqueSorted(artifact.concepts.map((concept) => concept.vocabularyId)),
    domainId: uniqueSorted(artifact.concepts.map((concept) => concept.domainId)),
    conceptClassId: uniqueSorted(artifact.concepts.map((concept) => concept.conceptClassId)),
    standardConcept: uniqueSorted(artifact.concepts.map((concept) => concept.standardConcept)),
    invalidReason: uniqueSorted(artifact.concepts.map((concept) => concept.invalidReason)),
  };
  for (const [field, values] of Object.entries(expected)) {
    if (!sameArray(artifact.facets?.[field], values)) {
      errors.push(`${packageId} ${field} facets do not match concept values.`);
    }
  }
}

function validateSynonyms(packageId, artifact, conceptIds, errors) {
  if (!artifact.byConceptId || typeof artifact.byConceptId !== "object" || Array.isArray(artifact.byConceptId)) {
    errors.push(`${packageId} synonyms artifact must contain byConceptId.`);
    return [];
  }
  const rows = [];
  for (const [conceptId, synonyms] of Object.entries(artifact.byConceptId)) {
    validateIdentifierValue(conceptId, `${packageId} synonym group conceptId`, errors);
    if (!conceptIds.has(conceptId)) errors.push(`${packageId} artifact contains orphan synonyms for ${conceptId}.`);
    if (!Array.isArray(synonyms)) {
      errors.push(`${packageId} synonym group ${conceptId} is not an array.`);
      continue;
    }
    for (const [ordinal, synonym] of synonyms.entries()) {
      const label = `${packageId} synonym ${conceptId}[${ordinal}]`;
      if (synonym.conceptId !== conceptId) errors.push(`${label} is stored under the wrong concept ID.`);
      validateNonBlankText(synonym.conceptSynonymName, `${label} conceptSynonymName`, errors);
      validateIdentifierValue(synonym.languageConceptId, `${label} languageConceptId`, errors);
      if (!Number.isInteger(synonym.sourceRow) || synonym.sourceRow < 2) {
        errors.push(`${label} has invalid sourceRow.`);
      }
      rows.push(synonym);
    }
  }
  return rows;
}

function validateRelationships(packageId, artifact, errors) {
  if (!Array.isArray(artifact.rows)) {
    errors.push(`${packageId} relationships artifact must contain a rows array.`);
    artifact.rows = [];
    return;
  }
  artifact.rows.forEach((row, ordinal) => {
    const label = `${packageId} relationship row ${ordinal}`;
    validateIdentifierValue(row.conceptId1, `${label} conceptId1`, errors);
    validateIdentifierValue(row.conceptId2, `${label} conceptId2`, errors);
    validateNonBlankText(row.relationshipId, `${label} relationshipId`, errors);
    validateDateValue(row.validStartDate, `${label} validStartDate`, errors);
    validateDateValue(row.validEndDate, `${label} validEndDate`, errors);
    validateFlagValue(row.invalidReason, ["D", "U"], `${label} invalidReason`, errors);
    if (!Number.isInteger(row.sourceRow) || row.sourceRow < 2) errors.push(`${label} has invalid sourceRow.`);
  });
}

function validateHierarchy(packageId, artifact, errors) {
  if (!Array.isArray(artifact.rows)) {
    errors.push(`${packageId} hierarchy artifact must contain a rows array.`);
    artifact.rows = [];
    return;
  }
  artifact.rows.forEach((row, ordinal) => {
    const label = `${packageId} hierarchy row ${ordinal}`;
    validateIdentifierValue(row.ancestorConceptId, `${label} ancestorConceptId`, errors);
    validateIdentifierValue(row.descendantConceptId, `${label} descendantConceptId`, errors);
    for (const field of ["minLevelsOfSeparation", "maxLevelsOfSeparation"]) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 0) errors.push(`${label} ${field} is invalid.`);
    }
    if (row.maxLevelsOfSeparation < row.minLevelsOfSeparation) {
      errors.push(`${label} has maxLevelsOfSeparation below minLevelsOfSeparation.`);
    }
    if (!Number.isInteger(row.sourceRow) || row.sourceRow < 2) errors.push(`${label} has invalid sourceRow.`);
  });
}

function validateSearch(packageId, artifact, concepts, synonymsByConceptId, errors) {
  if (!Array.isArray(artifact.documents)) {
    errors.push(`${packageId} search artifact must contain a documents array.`);
    return;
  }
  const expectedLookups = { conceptId: {}, conceptCode: {}, conceptName: {}, synonym: {} };
  artifact.documents.forEach((document, ordinal) => {
    const concept = concepts[ordinal];
    if (document.conceptOrdinal !== ordinal || concept?.conceptId !== document.conceptId) {
      errors.push(`${packageId} search ordinal ${ordinal} resolves to the wrong concept.`);
      return;
    }
    const synonyms = synonymsByConceptId?.[concept.conceptId] ?? [];
    const expected = {
      normalizedCode: normalizeSearchText(concept.conceptCode),
      normalizedName: normalizeSearchText(concept.conceptName),
      normalizedSynonyms: synonyms.map((row) => normalizeSearchText(row.conceptSynonymName)),
      nameTokens: tokenizeSearchText(concept.conceptName),
      synonymTokens: synonyms.map((row) => tokenizeSearchText(row.conceptSynonymName)),
    };
    for (const [field, value] of Object.entries(expected)) {
      const equal = Array.isArray(value) ? sameArray(document[field], value) : document[field] === value;
      if (!equal) errors.push(`${packageId} search ordinal ${ordinal} has stale ${field}.`);
    }
    expectedLookups.conceptId[concept.conceptId] = ordinal;
    addExpectedLookup(expectedLookups.conceptCode, expected.normalizedCode, ordinal);
    addExpectedLookup(expectedLookups.conceptName, expected.normalizedName, ordinal);
    for (const synonym of expected.normalizedSynonyms) addExpectedLookup(expectedLookups.synonym, synonym, ordinal);
  });
  for (const [label, expected] of Object.entries(expectedLookups)) {
    validateExactLookup(packageId, artifact.lookups?.[label], expected, errors, `search ${label}`);
  }
}

function validateRelationshipCounts(entry, rows, conceptIds, errors) {
  const counts = endpointCounts(rows, conceptIds, (row) => row.conceptId1, (row) => row.conceptId2);
  for (const [field, expected] of [
    ["relationshipsLocalBoth", counts.both],
    ["relationshipsOneLocal", counts.one],
    ["relationshipsExternal", counts.neither],
  ]) {
    if (entry.counts[field] !== expected) errors.push(`${entry.packageId} ${field} count mismatch.`);
  }
}

function validateHierarchyCounts(entry, rows, conceptIds, errors) {
  const nonReflexive = rows.filter(
    (row) => row.ancestorConceptId !== row.descendantConceptId || row.maxLevelsOfSeparation > 0,
  );
  const endpoint = endpointCounts(rows, conceptIds, (row) => row.ancestorConceptId, (row) => row.descendantConceptId);
  const usable = nonReflexive.filter(
    (row) => conceptIds.has(row.ancestorConceptId) || conceptIds.has(row.descendantConceptId),
  ).length;
  for (const [field, expected] of [
    ["nonReflexiveAncestorRows", nonReflexive.length],
    ["usableAncestorRows", usable],
    ["locallyRelevantAncestorRows", endpoint.both + endpoint.one],
  ]) {
    if (entry.counts[field] !== expected) errors.push(`${entry.packageId} ${field} count mismatch.`);
  }
  if (Boolean(entry.capabilities?.hierarchy) !== (rows.length > 0 && usable > 0)) {
    errors.push(`${entry.packageId} hierarchy capability does not match usable hierarchy data.`);
  }
}

function validateDuplicateCodeCount(entry, concepts, errors) {
  const groups = new Map();
  for (const concept of concepts) {
    const key = JSON.stringify([concept.vocabularyId, concept.conceptCode]);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const expected = [...groups.values()].filter((count) => count > 1).length;
  if (entry.counts.duplicateCodeGroups !== expected) {
    errors.push(`${entry.packageId} duplicateCodeGroups count mismatch.`);
  }
}

function buildRowIndex(rows, getKey) {
  const index = {};
  rows.forEach((row, ordinal) => addExpectedLookup(index, getKey(row), ordinal));
  return index;
}

function validateExactIndex(packageId, actual, expected, errors, label) {
  validateExactLookup(packageId, actual, expected, errors, label);
}

function validateExactLookup(packageId, actual, expected, errors, label) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    errors.push(`${packageId} ${label} index is not an object.`);
    return;
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const actualValue = actual[key];
    const expectedValue = expected[key];
    const equal = Array.isArray(expectedValue)
      ? sameArray(actualValue, expectedValue)
      : actualValue === expectedValue;
    if (!equal) errors.push(`${packageId} ${label} index for ${key} does not match artifact rows.`);
  }
}

function addExpectedLookup(index, key, ordinal) {
  if (!Object.hasOwn(index, key)) index[key] = [];
  if (index[key][index[key].length - 1] !== ordinal) index[key].push(ordinal);
}

function endpointCounts(rows, conceptIds, first, second) {
  const result = { both: 0, one: 0, neither: 0 };
  for (const row of rows) {
    const resolved = Number(conceptIds.has(first(row))) + Number(conceptIds.has(second(row)));
    if (resolved === 2) result.both += 1;
    else if (resolved === 1) result.one += 1;
    else result.neither += 1;
  }
  return result;
}

function validateIdentifierValue(value, label, errors) {
  if (typeof value !== "string") {
    errors.push(`${label} must be an integer-safe string identifier.`);
    return;
  }
  collectValidation(errors, label, () => parseIdentifier(value, { source: label, rowNumber: 1, field: "value" }));
}

function validateDateValue(value, label, errors) {
  if (typeof value !== "string") {
    errors.push(`${label} must be a source-preserved date string.`);
    return;
  }
  collectValidation(errors, label, () => validateDate(value, { source: label, rowNumber: 1, field: "value" }));
}

function validateFlagValue(value, allowed, label, errors) {
  if (value !== null && typeof value !== "string") {
    errors.push(`${label} must be null or a valid OMOP flag.`);
    return;
  }
  collectValidation(errors, label, () => parseNullableFlag(value ?? "", allowed, {
    source: label,
    rowNumber: 1,
    field: "value",
  }));
}

function validateNonBlankText(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-blank string.`);
}

function collectValidation(errors, label, callback) {
  try {
    callback();
  } catch (error) {
    errors.push(`${label} is invalid: ${error.message}`);
  }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function sameArray(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    const counterpart = expected[index];
    return Array.isArray(value) || Array.isArray(counterpart)
      ? sameArray(value, counterpart)
      : value === counterpart;
  });
}

async function readJson(filename) {
  await stat(filename);
  return JSON.parse(await readFile(filename, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--data");
  const dataRoot = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  try {
    const manifest = await validateBrowserData(dataRoot);
    console.log(`Validated ${manifest.vocabularies.filter((entry) => entry.browseable).length} browseable package(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
