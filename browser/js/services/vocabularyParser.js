import { conceptCodeKey, sameConceptCode } from "../model/codeMatching.js";
import { parseCsv } from "./csv.js";
import {
  parseAncestorRows,
  parseConceptRows,
  parseRelationshipRows,
  parseSynonymRows,
} from "../model/concept.js";

// Isolated streaming adapter; domain and provenance logic below is unchanged.
function hasSource(source) { return source?.hasContent ?? Boolean(source?.text); }
function parseSource(source) {
  if (source.parseError) throw source.parseError;
  return source.parsed ?? parseCsv(source.text, { source: source.path });
}

export const ARTIFACT_SCHEMA_VERSION = "2.0";
export const REQUIRED_DATASET_KEYS = Object.freeze(["concept", "synonym", "relationship"]);

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, " ");
}

export function tokenizeSearchText(value) {
  return normalizeSearchText(value).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

export function buildVocabularyArtifacts({ packageId, sources }) {
  for (const required of REQUIRED_DATASET_KEYS) {
    if (!hasSource(sources[required])) {
      throw new Error(`Package ${packageId} is missing required ${required} data.`);
    }
  }

  const parsedConcepts = parseSource(sources.concept);
  const { concepts, byId } = parseConceptRows(parsedConcepts, {
    source: sources.concept.path,
    packageId,
  });
  const synonymResult = parseSynonymRows(parseSource(sources.synonym), {
    source: sources.synonym.path,
    conceptById: byId,
  });
  const synonyms = synonymResult.synonyms;
  const coreSynonymCount = synonyms.length;
  const relationships = parseRelationshipRows(
    parseSource(sources.relationship),
    { source: sources.relationship.path },
  );

  let ancestors = [];
  let hierarchyWarning = null;
  if (hasSource(sources.ancestor)) {
    try {
      ancestors = parseAncestorRows(parseSource(sources.ancestor), {
        source: sources.ancestor.path,
      });
    } catch (error) {
      hierarchyWarning = `Hierarchy disabled: ${error.message}`;
    }
  }

  const mappingEvidence = new Map();
  const provenanceWarnings = attachMappingProvenance(sources, concepts, relationships, { synonyms, ancestors, mappingEvidence });
  const mappingResult = parseMappingMetadata(sources.mappingMetadata, concepts, relationships, mappingEvidence);
  const synonymsByConcept = groupSynonyms(synonyms);
  const conceptsArtifact = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    packageId,
    concepts,
    facets: buildFacets(concepts),
  };
  const searchArtifact = buildSearchArtifact(concepts, synonymsByConcept);
  const synonymArtifact = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    packageId,
    byConceptId: Object.fromEntries(synonymsByConcept),
  };
  const relationshipArtifact = buildRelationshipArtifact(packageId, relationships);
  const hierarchyArtifact = ancestors.length > 0 ? buildHierarchyArtifact(packageId, ancestors) : null;
  const metadataResult = buildMetadataArtifact(packageId, sources);
  if (mappingResult.rows.length) {
    metadataResult.artifact ??= { schemaVersion: ARTIFACT_SCHEMA_VERSION, packageId, tables: {} };
    metadataResult.artifact.tables.mappingMetadata = mappingResult.rows;
  }
  const conceptIds = new Set(concepts.map((concept) => concept.conceptId));
  const relationshipStats = endpointStats(
    relationships,
    conceptIds,
    (row) => row.conceptId1,
    (row) => row.conceptId2,
  );
  const hierarchyStats = endpointStats(
    ancestors,
    conceptIds,
    (row) => row.ancestorConceptId,
    (row) => row.descendantConceptId,
  );
  const nonReflexiveAncestorRows = ancestors.filter(
    (row) => row.ancestorConceptId !== row.descendantConceptId || row.maxLevelsOfSeparation > 0,
  ).length;
  const usableAncestorRows = ancestors.filter(
    (row) =>
      (row.ancestorConceptId !== row.descendantConceptId || row.maxLevelsOfSeparation > 0) &&
      (conceptIds.has(row.ancestorConceptId) || conceptIds.has(row.descendantConceptId)),
  ).length;
  const duplicateCodeGroups = countDuplicateCodeGroups(concepts);
  const widthFindings = countOmopWidthFindings(concepts);

  return {
    concepts: conceptsArtifact,
    search: searchArtifact,
    synonyms: synonymArtifact,
    relationships: relationshipArtifact,
    hierarchy: hierarchyArtifact,
    metadata: metadataResult.artifact,
    counts: {
      concepts: concepts.length,
      synonyms: synonyms.length,
      sourceSynonyms: synonymResult.sourceRowCount,
      fallbackSynonyms: synonyms.length - coreSynonymCount,
      orphanSynonyms: synonymResult.orphans.length,
      relationships: relationships.length,
      relationshipsLocalBoth: relationshipStats.both,
      relationshipsOneLocal: relationshipStats.one,
      relationshipsExternal: relationshipStats.neither,
      ancestorRows: ancestors.length,
      nonReflexiveAncestorRows,
      usableAncestorRows,
      locallyRelevantAncestorRows: hierarchyStats.both + hierarchyStats.one,
      duplicateCodeGroups,
    },
    vocabularyIds: conceptsArtifact.facets.vocabularyId.filter((value) => value !== null),
    warnings: [
      hierarchyWarning,
      synonymResult.orphans.length > 0
        ? `${sources.synonym.path}: ${synonymResult.orphans.length} synonym row(s) reference concepts outside the local package and were excluded from search.`
        : null,
      widthFindings > 0
        ? `${widthFindings} concept row(s) exceed the OMOP CDM v5.4 20-character domain_id or concept_class_id width; source values were preserved without truncation.`
        : null,
      duplicateCodeGroups > 0
        ? `${duplicateCodeGroups} duplicate (vocabulary_id, concept_code) group(s) were retained as distinct concepts.`
        : null,
      ancestors.length > 0 && usableAncestorRows === 0
        ? `${sources.ancestor?.path}: hierarchy contains no non-reflexive row connected to a local package concept; hierarchy navigation was disabled.`
        : null,
      ...metadataResult.warnings,
      ...mappingResult.warnings,
      ...provenanceWarnings,
    ].filter(Boolean),
  };
}

function endpointStats(rows, conceptIds, first, second) {
  const result = { both: 0, one: 0, neither: 0 };
  for (const row of rows) {
    const resolved = Number(conceptIds.has(first(row))) + Number(conceptIds.has(second(row)));
    if (resolved === 2) result.both += 1;
    else if (resolved === 1) result.one += 1;
    else result.neither += 1;
  }
  return result;
}

function countDuplicateCodeGroups(concepts) {
  const counts = new Map();
  for (const concept of concepts) {
    const key = conceptCodeKey(concept.vocabularyId, concept.conceptCode);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

function countOmopWidthFindings(concepts) {
  return concepts.filter(
    (concept) => concept.domainId.length > 20 || concept.conceptClassId.length > 20,
  ).length;
}

const REFERENCE_SCHEMAS = Object.freeze({
  vocabulary: [
    "vocabulary_id",
    "vocabulary_name",
    "vocabulary_reference",
    "vocabulary_version",
    "vocabulary_concept_id",
  ],
  domain: ["domain_id", "domain_name", "domain_concept_id"],
  conceptClass: ["concept_class_id", "concept_class_name", "concept_class_concept_id"],
  relationshipDefinition: [
    "relationship_id",
    "relationship_name",
    "is_hierarchical",
    "defines_ancestry",
    "reverse_relationship_id",
    "relationship_concept_id",
  ],
});

function buildMetadataArtifact(packageId, sources) {
  const tables = {};
  const warnings = [];
  for (const [key, requiredHeaders] of Object.entries(REFERENCE_SCHEMAS)) {
    if (!hasSource(sources[key])) continue;
    try {
      const parsed = parseSource(sources[key]);
      const missing = requiredHeaders.filter((header) => !parsed.headers.includes(header));
      if (missing.length > 0) {
        throw new Error(`missing required columns: ${missing.join(", ")}`);
      }
      tables[key] = parsed.rows.map((row) => ({ ...row.values, sourceRow: row.rowNumber }));
    } catch (error) {
      warnings.push(`${sources[key].path} metadata disabled: ${error.message}`);
    }
  }
  return {
    artifact:
      Object.keys(tables).length > 0
        ? { schemaVersion: ARTIFACT_SCHEMA_VERSION, packageId, tables }
        : null,
    warnings,
  };
}

function buildSearchArtifact(concepts, synonymsByConcept) {
  const lookups = {
    conceptId: Object.create(null),
    conceptCode: Object.create(null),
    conceptName: Object.create(null),
    synonym: Object.create(null),
  };
  const documents = concepts.map((concept, conceptOrdinal) => {
    const synonymRows = synonymsByConcept.get(concept.conceptId) ?? [];
    const normalizedSynonyms = synonymRows.map((synonym) => normalizeSearchText(synonym.conceptSynonymName));
    const document = {
      conceptOrdinal,
      conceptId: concept.conceptId,
      normalizedCode: normalizeSearchText(concept.conceptCode),
      normalizedName: normalizeSearchText(concept.conceptName),
      normalizedSynonyms,
      nameTokens: tokenizeSearchText(concept.conceptName),
      synonymTokens: synonymRows.map((synonym) => tokenizeSearchText(synonym.conceptSynonymName)),
    };
    lookups.conceptId[concept.conceptId] = conceptOrdinal;
    addLookup(lookups.conceptCode, document.normalizedCode, conceptOrdinal);
    addLookup(lookups.conceptName, document.normalizedName, conceptOrdinal);
    for (const normalizedSynonym of normalizedSynonyms) {
      addLookup(lookups.synonym, normalizedSynonym, conceptOrdinal);
    }
    return document;
  });

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    documents,
    lookups,
  };
}

function addLookup(lookup, key, ordinal) {
  if (!Object.hasOwn(lookup, key)) lookup[key] = [];
  if (lookup[key][lookup[key].length - 1] !== ordinal) lookup[key].push(ordinal);
}

function groupSynonyms(synonyms) {
  const byConcept = new Map();
  for (const synonym of synonyms) {
    if (!byConcept.has(synonym.conceptId)) byConcept.set(synonym.conceptId, []);
    byConcept.get(synonym.conceptId).push(synonym);
  }
  return new Map([...byConcept.entries()].sort(([left], [right]) => compareIntegerText(left, right)));
}

function buildRelationshipArtifact(packageId, rows) {
  const outgoing = Object.create(null);
  const incoming = Object.create(null);
  rows.forEach((relationship, index) => {
    addIndex(outgoing, relationship.conceptId1, index);
    addIndex(incoming, relationship.conceptId2, index);
  });
  return { schemaVersion: ARTIFACT_SCHEMA_VERSION, packageId, rows, outgoing, incoming };
}

function buildHierarchyArtifact(packageId, rows) {
  const ancestors = Object.create(null);
  const descendants = Object.create(null);
  rows.forEach((relationship, index) => {
    addIndex(ancestors, relationship.descendantConceptId, index);
    addIndex(descendants, relationship.ancestorConceptId, index);
  });
  return { schemaVersion: ARTIFACT_SCHEMA_VERSION, packageId, rows, ancestors, descendants };
}

function addIndex(index, key, value) {
  if (!Object.hasOwn(index, key)) index[key] = [];
  index[key].push(value);
}

function buildFacets(concepts) {
  return {
    vocabularyId: uniqueSorted(concepts.map((concept) => concept.vocabularyId)),
    domainId: uniqueSorted(concepts.map((concept) => concept.domainId)),
    conceptClassId: uniqueSorted(concepts.map((concept) => concept.conceptClassId)),
    standardConcept: uniqueSorted(concepts.map((concept) => concept.standardConcept)),
    invalidReason: uniqueSorted(concepts.map((concept) => concept.invalidReason)),
  };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function compareIntegerText(left, right) {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

/** Preserve mapping provenance without treating source-system codes as OMOP IDs. */
export function parseMappingMetadata(source, concepts, relationships, mappingEvidence = new Map()) {
  if (!hasSource(source)) return { rows: [], warnings: [] };
  const byId = new Map(concepts.map((concept) => [concept.conceptId, concept]));
  const byCode = new Map();
  for (const concept of concepts) {
    const key = conceptCodeKey(concept.vocabularyId, concept.conceptCode);
    const matches = byCode.get(key) ?? [];
    matches.push(concept.conceptId);
    byCode.set(key, matches);
  }
  const uniqueCode = (vocabulary, code, description) => {
    if (!code || !description) return null;
    const matches = (vocabulary ? (byCode.get(conceptCodeKey(vocabulary, code)) ?? [])
      : concepts.filter((concept) => sameConceptCode(concept.conceptCode, code)).map((concept) => concept.conceptId))
      .filter((id) => byId.get(id)?.conceptName === description);
    return matches.length === 1 ? matches[0] : null;
  };
  const resolveEndpoint = (value, description) => {
    if (!value) return { id: null, vocabulary: "", code: "" };
    if (/^[1-9]\d*$/u.test(value)) return { id: value, vocabulary: "OMOP", code: value };
    const match = value.match(/^([^:]+):(.+)$/u);
    if (!match) return { id: null, vocabulary: "", code: value };
    const [, vocabulary, code] = match;
    return { id: vocabulary.toUpperCase() === "OMOP" && /^[1-9]\d*$/u.test(code)
      ? code : uniqueCode(vocabulary, code, description), vocabulary, code };
  };
  const relationshipsByPair = new Map();
  for (const relationship of relationships) {
    const key = JSON.stringify([relationship.conceptId1, relationship.conceptId2]);
    const matches = relationshipsByPair.get(key) ?? [];
    matches.push(relationship);
    relationshipsByPair.set(key, matches);
  }
  let parsed;
  try {
    parsed = parseSource(source);
    if (!(parsed.headers.includes("mapping_concept_code")
      || (parsed.headers.includes("subject_id") && parsed.headers.includes("object_id"))
      || (parsed.headers.includes("concept_id_1") && parsed.headers.includes("concept_id_2"))
      || (parsed.headers.includes("source_code") && parsed.headers.includes("source_description")))) {
      throw new Error("expected mapping_concept_code, subject_id/object_id, or concept_id_1/concept_id_2 columns");
    }
  } catch (error) {
    return { rows: [], warnings: [`${source.path} mapping metadata disabled: ${error.message}`] };
  }
  const warnings = [];
  let unmatched = 0;
  let malformed = 0;
  const rows = parsed.rows.map(({ values, rowNumber }) => {
    const suppliedSourceId = String(values.source_concept_id ?? "").trim();
    const sourceId1 = String(values.concept_id_1 ?? "").trim();
    const invalidSourceId = [suppliedSourceId, sourceId1].some((id) => id && id !== "0" && !/^[1-9]\d*$/u.test(id));
    const sourceId = /^[1-9]\d*$/u.test(suppliedSourceId) ? suppliedSourceId : "";
    let subject = resolveEndpoint(values.concept_id_1 || sourceId || values.subject_id, values.source_description || values.subject_label);
    let object = resolveEndpoint(values.concept_id_2 || values.target_concept_id || values.object_id, values.target_description || values.object_label);
    let identityEvidence = null;
    let targetIdentityEvidence = null;
    const hasComposite = Object.hasOwn(values, "mapping_concept_code");
    const parts = hasComposite ? values.mapping_concept_code.split("|| - ||") : null;
    const malformedComposite = Boolean(parts && (parts.length !== 4 || parts.some((part) => !part.trim())));
    if (!values.concept_id_1 && !sourceId && !values.subject_id && parts && !malformedComposite) {
        const evidence = mappingEvidence.get(conceptCodeKey(parts[1], parts[0]));
        const supportedSubjects = evidence ? [...evidence.subjects.keys()] : [];
        const suppliedName = values.source_description || values.subject_label;
        const rawSubject = uniqueCode(parts[1], parts[0], suppliedName);
        const subjectId = suppliedName ? rawSubject : (supportedSubjects.length === 1 ? supportedSubjects[0] : null);
        if (subjectId && evidence?.subjects.has(subjectId)) identityEvidence = evidence.subjects.get(subjectId);
        subject = { code: parts[0], vocabulary: parts[1], id: subjectId };
        const localTargets = byCode.get(conceptCodeKey(parts[3], parts[2])) ?? [];
        const externalTargets = subjectId ? evidence?.targets.get(JSON.stringify([subjectId, conceptCodeKey(parts[3], parts[2])])) : null;
        const targetIds = new Set([...localTargets, ...(externalTargets?.keys() ?? [])]);
        const targetId = targetIds.size === 1 ? [...targetIds][0] : null;
        targetIdentityEvidence = targetId ? externalTargets?.get(targetId) ?? null : null;
        object = { code: parts[2], vocabulary: parts[3], id: targetId };
    }
    if ((values.concept_id_1 || sourceId || values.subject_id) && parts && !malformedComposite) {
      const evidence = mappingEvidence.get(conceptCodeKey(parts[1], parts[0]));
      if (subject.id && evidence?.subjects.has(subject.id)) identityEvidence = evidence.subjects.get(subject.id);
      const localTargets = byCode.get(conceptCodeKey(parts[3], parts[2])) ?? [];
      const externalTargets = subject.id ? evidence?.targets.get(JSON.stringify([subject.id, conceptCodeKey(parts[3], parts[2])])) : null;
      const targetIds = new Set([...localTargets, ...(externalTargets?.keys() ?? [])]);
      const provenId = targetIds.size === 1 ? [...targetIds][0] : null;
      const explicitTargetId = object.id;
      object = { code: parts[2], vocabulary: parts[3], id: provenId && (!explicitTargetId || explicitTargetId === provenId) ? provenId : null };
      targetIdentityEvidence = object.id ? externalTargets?.get(object.id) ?? null : null;
    }
    if (!subject.id && !values.concept_id_1 && !sourceId && !values.subject_id && values.source_code && values.source_description) {
      subject = { code: values.source_code, vocabulary: values.source_vocabulary_id || "", id: uniqueCode(values.source_vocabulary_id || "", values.source_code, values.source_description) };
    }
    const matchedConcept = byId.get(subject.id);
    const alternateSubject = values.subject_id ? resolveEndpoint(values.subject_id, values.source_description || values.subject_label) : null;
    const identityConflict = invalidSourceId || Boolean(matchedConcept && (
      (sourceId && sourceId !== matchedConcept.conceptId)
      || (/^[1-9]\d*$/u.test(sourceId1) && sourceId1 !== matchedConcept.conceptId)
      || (alternateSubject?.id && alternateSubject.id !== matchedConcept.conceptId)
      || (alternateSubject?.vocabulary?.toUpperCase() === "OMOP" && !alternateSubject.id)
      || (alternateSubject?.vocabulary && alternateSubject.vocabulary.toUpperCase() !== "OMOP"
        && (alternateSubject.vocabulary !== matchedConcept.vocabularyId || !sameConceptCode(alternateSubject.code, matchedConcept.conceptCode)))
      || (values.subject_id && !alternateSubject?.id && !alternateSubject?.vocabulary && !sameConceptCode(alternateSubject?.code, matchedConcept.conceptCode))
      || (values.source_code && !sameConceptCode(values.source_code, matchedConcept.conceptCode))
      || (values.source_vocabulary_id && values.source_vocabulary_id !== matchedConcept.vocabularyId)
      || (values.source_description && values.source_description !== matchedConcept.conceptName)
      || (values.subject_label && values.subject_label !== matchedConcept.conceptName)
      || (parts && !malformedComposite && (!sameConceptCode(parts[0], matchedConcept.conceptCode) || parts[1] !== matchedConcept.vocabularyId))
    ));
    const suppliedTargetId = String(values.target_concept_id ?? "").trim();
    const targetId2 = String(values.concept_id_2 ?? "").trim();
    const invalidTargetId = [suppliedTargetId, targetId2].some((id) => id && id !== "0" && !/^[1-9]\d*$/u.test(id));
    const targetFromId = /^[1-9]\d*$/u.test(suppliedTargetId) ? suppliedTargetId : null;
    const alternateTarget = values.object_id ? resolveEndpoint(values.object_id, values.target_description || values.object_label) : null;
    const targetConflict = invalidTargetId || Boolean(object.id && (
      (targetFromId && targetFromId !== object.id)
      || (/^[1-9]\d*$/u.test(targetId2) && targetId2 !== object.id)
      || (alternateTarget?.id && alternateTarget.id !== object.id)
      || (alternateTarget?.vocabulary?.toUpperCase() === "OMOP" && !alternateTarget.id)
      || (parts && !malformedComposite && alternateTarget?.vocabulary && alternateTarget.vocabulary.toUpperCase() !== "OMOP"
        && (alternateTarget.vocabulary !== parts[3] || !sameConceptCode(alternateTarget.code, parts[2])))
      || (parts && !malformedComposite && values.object_id && !alternateTarget?.id && !alternateTarget?.vocabulary
        && !sameConceptCode(alternateTarget?.code, parts[2]))
      || (parts && !malformedComposite && ((values.target_vocabulary_id && values.target_vocabulary_id !== parts[3])
        || (values.target_concept_code && !sameConceptCode(values.target_concept_code, parts[2]))
        || (values.target_code && !sameConceptCode(values.target_code, parts[2]))))
    ));
    if (targetConflict) { object.id = null; targetIdentityEvidence = null; }
    if (identityConflict || malformedComposite) {
      subject.id = null;
      object.id = null;
      identityEvidence = null;
      targetIdentityEvidence = null;
    }
    if (malformedComposite) malformed += 1;
    const mapping = { ...values, ...(identityEvidence ? { ...(!values.source_description && !values.subject_label ? { source_description: identityEvidence.description } : {}),
      sourceIdentityEvidence: { file: identityEvidence.file, row: identityEvidence.row } } : {}),
      ...(targetIdentityEvidence ? { targetIdentityEvidence } : {}), sourceRow: rowNumber, sourceFile: source.path,
      subjectConceptId: subject.id, objectConceptId: object.id,
      subjectCode: subject.code, subjectVocabulary: subject.vocabulary,
      objectCode: object.code, objectVocabulary: object.vocabulary,
      associationStatus: malformedComposite ? "malformed-composite" : identityConflict ? "identity-conflict" : "unresolved" };
    const candidates = subject.id && object.id
      ? (relationshipsByPair.get(JSON.stringify([subject.id, object.id])) ?? [])
        .filter((relationship) => !values.relationship_id || relationship.relationshipId === values.relationship_id)
      : [];
    if (malformedComposite || identityConflict) {
      // Keep malformed source rows visible to quality control without guessing endpoints.
    } else if (candidates.length === 1) {
      mapping.associationStatus = "relationship";
      (candidates[0].mappingMetadata ??= []).push(mapping);
    } else if (candidates.length > 1) {
      mapping.associationStatus = "ambiguous-relationship";
    } else if (subject.id && byId.has(subject.id)) {
      mapping.associationStatus = "subject-only";
    }
    const subjectConcept = byId.get(subject.id);
    if (subjectConcept) {
      if (values.source_code_set) {
        subjectConcept.sourceSystems ??= [];
        if (!subjectConcept.sourceSystems.includes(values.source_code_set)) subjectConcept.sourceSystems.push(values.source_code_set);
      }
    }
    if (mapping.associationStatus !== "relationship") unmatched += 1;
    return mapping;
  });
  if (malformed) warnings.push(`${source.path}: ${malformed} malformed composite mapping code(s) were not matched.`);
  if (unmatched) warnings.push(`${source.path}: ${unmatched} mapping row(s) could not be uniquely attached to a relationship; original endpoints and provenance were retained.`);
  return { rows, warnings };
}


/** Resolve supplementary rows within this package using an explicit ID or case-insensitive code and exact name. */
export function attachMappingProvenance(sources, concepts, relationships = [], { synonyms = [], ancestors = [], mappingEvidence = new Map() } = {}) {
  const byCode = new Map();
  for (const concept of concepts) {
    const key = conceptCodeKey(concept.vocabularyId, concept.conceptCode);
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(concept);
  }
  const warnings = [];
  const conceptIds = new Set(concepts.map((concept) => concept.conceptId));
  const conceptsById = new Map(concepts.map((concept) => [concept.conceptId, concept]));
  const coreSynonymIds = new Set(synonyms.map((synonym) => synonym.conceptId));
  const coreHierarchyIds = new Set();
  for (const row of relationships) if (["Is a", "Subsumes"].includes(row.relationshipId) && !row.invalidReason) {
    coreHierarchyIds.add(row.conceptId1); coreHierarchyIds.add(row.conceptId2);
  }
  for (const row of ancestors) if (row.ancestorConceptId !== row.descendantConceptId && row.minLevelsOfSeparation > 0) {
    coreHierarchyIds.add(row.ancestorConceptId); coreHierarchyIds.add(row.descendantConceptId);
  }
  const seenSynonyms = new Set(synonyms.map((row) => JSON.stringify([row.conceptId, row.conceptSynonymName])));
  const byRelationship = new Map();
  for (const relationship of relationships) {
    const key = JSON.stringify([relationship.conceptId1, relationship.conceptId2, relationship.relationshipId]);
    if (!byRelationship.has(key)) byRelationship.set(key, []);
    byRelationship.get(key).push(relationship);
  }
  for (const [key, source] of Object.entries(sources)) {
    if (!key.startsWith("mappingSource") || !hasSource(source)) continue;
    try {
      const parsed = parseMappingCsv(source);
      const provenanceColumns = ["source_code_set", "source_category"].filter((name) => parsed.headers.includes(name));
      const relationshipColumns = ["relationship_id", "target_concept_id", "target_vocabulary_id"]
        .every((name) => parsed.headers.includes(name));
      if (!provenanceColumns.length && !relationshipColumns && !parsed.headers.includes("source_description_synonym")
        && !["source_code", "source_description"].every((name) => parsed.headers.includes(name))) continue;
      if (!parsed.headers.includes("source_concept_id") && !["source_code", "source_description"].every((name) => parsed.headers.includes(name))) {
        warnings.push(`${source.path}: provenance requires source_concept_id or source_code and source_description; no concepts were enriched.`);
        continue;
      }
      let unresolved = 0;
      for (const row of parsed.rows) {
        const record = row.values;
        const sourceSystem = record.source_code_set?.trim() || null;
        const sourceCategory = record.source_category?.trim() || null;
        const suppliedId = String(record.source_concept_id ?? "").trim();
        const hasId = /^[1-9]\d*$/u.test(suppliedId);
        let candidates;
        if (hasId) {
          const candidate = conceptsById.get(suppliedId);
          candidates = candidate && (!record.source_code || sameConceptCode(candidate.conceptCode, record.source_code))
            && (!record.source_vocabulary_id || candidate.vocabularyId === record.source_vocabulary_id)
            && (!record.source_description || candidate.conceptName === record.source_description) ? [candidate] : [];
        } else if (suppliedId && suppliedId !== "0") {
          candidates = [];
        } else if (record.source_code && record.source_description) {
          const matches = record.source_vocabulary_id
            ? byCode.get(conceptCodeKey(record.source_vocabulary_id, record.source_code)) ?? [] : concepts;
          candidates = matches.filter((candidate) => sameConceptCode(candidate.conceptCode, record.source_code) && candidate.conceptName === record.source_description);
        } else candidates = [];
        if (candidates.length !== 1) { if (sourceSystem || sourceCategory) unresolved += 1; continue; }
        const concept = candidates[0];
        if (record.source_code && record.source_vocabulary_id) {
          const evidenceKey = conceptCodeKey(record.source_vocabulary_id, record.source_code);
          if (!mappingEvidence.has(evidenceKey)) mappingEvidence.set(evidenceKey, { subjects: new Map(), targets: new Map() });
          const evidence = mappingEvidence.get(evidenceKey);
          if (!evidence.subjects.has(concept.conceptId)) evidence.subjects.set(concept.conceptId,
            { description: concept.conceptName, file: source.path, row: row.rowNumber });
          const targetCode = record.target_concept_code || record.target_code;
          const targetId = String(record.target_concept_id ?? "").trim();
          if (targetCode && record.target_vocabulary_id && /^[1-9]\d*$/u.test(targetId)) {
            const targetKey = JSON.stringify([concept.conceptId, conceptCodeKey(record.target_vocabulary_id, targetCode)]);
            if (!evidence.targets.has(targetKey)) evidence.targets.set(targetKey, new Map());
            if (!evidence.targets.get(targetKey).has(targetId)) evidence.targets.get(targetKey).set(targetId, {
              file: source.path, row: row.rowNumber, conceptId: targetId,
              conceptCode: targetCode, vocabularyId: record.target_vocabulary_id,
            });
          }
        }
        const synonymName = record.source_description_synonym?.trim();
        const synonymKey = JSON.stringify([concept.conceptId, synonymName]);
        if (synonymName && !coreSynonymIds.has(concept.conceptId) && !seenSynonyms.has(synonymKey)) {
          synonyms.push({ conceptId: concept.conceptId, conceptSynonymName: synonymName, languageConceptId: null, sourceRow: row.rowNumber, sourceFile: source.path, sourceDerived: true });
          seenSynonyms.add(synonymKey);
        }
        const targetId = String(record.target_concept_id ?? "").trim();
        if (!coreHierarchyIds.has(concept.conceptId) && ["Is a", "Subsumes"].includes(record.relationship_id)
          && /^[1-9]\d*$/u.test(targetId) && targetId !== concept.conceptId) {
          const relationshipKey = JSON.stringify([concept.conceptId, targetId, record.relationship_id]);
          if (!byRelationship.has(relationshipKey)) {
            const derived = { conceptId1: concept.conceptId, conceptId2: targetId, relationshipId: record.relationship_id,
              validStartDate: null, validEndDate: null, invalidReason: null, sourceFile: source.path, sourceRow: row.rowNumber, sourceDerived: true };
            relationships.push(derived); byRelationship.set(relationshipKey, [derived]);
          }
        }
        if (relationshipColumns) {
          attachBuilderRelationship(record, concept, source.path, row.rowNumber, byRelationship, conceptIds);
        }
        if (!sourceSystem && !sourceCategory) continue;
        if (sourceSystem) concept.sourceSystems = [...new Set([...(concept.sourceSystems ?? []), sourceSystem])];
        if (sourceCategory) concept.sourceCategories = [...new Set([...(concept.sourceCategories ?? []), sourceCategory])];
        concept.sourceProvenance ??= [];
        // Repeated mapping targets need not duplicate the same source-system provenance.
        if (!concept.sourceProvenance.some((entry) => entry.sourceCodeSet === sourceSystem
          && entry.sourceCategory === sourceCategory && entry.file === source.path)) {
          concept.sourceProvenance.push({ sourceCodeSet: sourceSystem, sourceCategory,
            file: source.path, row: row.rowNumber });
        }
      }
      if (unresolved) warnings.push(`${source.path}: ${unresolved} source provenance row(s) could not be matched unambiguously by ID or code and name within the package.`);
    } catch (error) {
      warnings.push(`${source.path}: supplementary mapping provenance disabled: ${error.message}`);
    }
  }
  return warnings;
}

// Mapping exports can contain padded column names. Normalize names only, never
// field values, and refuse collisions that would make the source ambiguous.
function parseMappingCsv(source) {
  const parsed = parseSource(source);
  const headers = parsed.headers.map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error("blank or duplicate column names after removing header whitespace");
  }
  return { headers, rows: parsed.rows.map((row) => ({ ...row, values: Object.fromEntries(
    parsed.headers.map((original, index) => [headers[index], row.values[original]]),
  ) })) };
}


/** Builder target_concept_id is an explicit OMOP identifier, never a vocabulary code. */
function attachBuilderRelationship(record, concept, file, rowNumber, byRelationship, conceptIds) {
  const targetId = String(record.target_concept_id ?? "").trim();
  const targetVocabulary = String(record.target_vocabulary_id ?? "").trim();
  if (!/^[1-9]\d*$/u.test(targetId) || !targetVocabulary) return;
  const key = JSON.stringify([concept.conceptId, targetId, record.relationship_id]);
  const matches = byRelationship.get(key) ?? [];
  if (matches.length !== 1) return;
  const relationship = matches[0];
  const metadata = {
    ...record,
    author_label: record.author_label || record.author_name || "",
    reviewer_label: record.reviewer_label || record.reviewer_name || "",
    sourceFile: file,
    sourceRow: rowNumber,
    subjectConceptId: concept.conceptId,
    objectConceptId: targetId,
    associationStatus: "relationship",
  };
  relationship.mappingMetadata ??= [];
  relationship.mappingMetadata.push(metadata);
  if (conceptIds.has(targetId)) return;
  // Conflicting source declarations do not establish one target vocabulary.
  if (relationship.otherConceptOmop && relationship.otherConceptOmop.vocabularyId !== targetVocabulary) {
    delete relationship.otherConceptOmop;
    relationship.omopTargetConflict = true;
    return;
  }
  if (relationship.omopTargetConflict) return;
  relationship.otherConceptOmop = {
    conceptId: targetId,
    vocabularyId: targetVocabulary,
    conceptName: record.target_concept_name || null,
    provenance: { file, row: rowNumber },
    sourceDeclared: true,
  };
}
