import { parseCsv } from "./csv.js";
import {
  parseAncestorRows,
  parseConceptRows,
  parseRelationshipRows,
  parseSynonymRows,
} from "../model/concept.js";

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
    if (!sources[required]?.text) {
      throw new Error(`Package ${packageId} is missing required ${required} data.`);
    }
  }

  const parsedConcepts = parseCsv(sources.concept.text, { source: sources.concept.path });
  const { concepts, byId } = parseConceptRows(parsedConcepts, {
    source: sources.concept.path,
    packageId,
  });
  const synonymResult = parseSynonymRows(parseCsv(sources.synonym.text, { source: sources.synonym.path }), {
    source: sources.synonym.path,
    conceptById: byId,
  });
  const synonyms = synonymResult.synonyms;
  const relationships = parseRelationshipRows(
    parseCsv(sources.relationship.text, { source: sources.relationship.path }),
    { source: sources.relationship.path },
  );

  let ancestors = [];
  let hierarchyWarning = null;
  if (sources.ancestor?.text) {
    try {
      ancestors = parseAncestorRows(parseCsv(sources.ancestor.text, { source: sources.ancestor.path }), {
        source: sources.ancestor.path,
      });
    } catch (error) {
      hierarchyWarning = `Hierarchy disabled: ${error.message}`;
    }
  }

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
    const key = JSON.stringify([concept.vocabularyId, concept.conceptCode]);
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
    if (!sources[key]?.text) continue;
    try {
      const parsed = parseCsv(sources[key].text, { source: sources[key].path });
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
