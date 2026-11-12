import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SOURCE } from "../../browser/js/config.js";
import { VocabularyRepository } from "../../browser/js/services/dataService.js";
import { directHierarchy } from "../../browser/js/ui/conceptDetails.js";
import {
  discoverGitHubManifest,
  loadSourceManifest,
  SourceLoadError,
} from "../../browser/js/services/manifestService.js";
import { resolveSource } from "../../browser/js/services/sourceResolver.js";

const manifestFixture = {
  schemaVersion: "2.0",
  generatedAt: "2026-08-19T00:00:00Z",
  source: {
    provider: "github",
    repository: "TuftsCTSI/CVB",
    ref: "main",
    commit: "a".repeat(40),
  },
  requiredFiles: [
    "concept_delta.csv",
    "concept_synonym_delta.csv",
    "concept_relationship_delta.csv",
  ],
  vocabularies: [
    {
      packageId: "ALPHA",
      displayName: "Alpha",
      browseable: true,
      status: "ready",
      files: {},
      counts: { concepts: 1, synonyms: 1, relationships: 1 },
      capabilities: { hierarchy: false },
      artifacts: {
        concepts: "vocabularies/ALPHA/concepts.json",
        search: "vocabularies/ALPHA/search.json",
        synonyms: "vocabularies/ALPHA/synonyms.json",
        relationships: "vocabularies/ALPHA/relationships.json",
      },
      warnings: [],
      errors: [],
    },
  ],
};

const concept = {
  conceptId: "2000000001",
  conceptName: "Alpha",
  domainId: "Observation",
  vocabularyId: "A",
  conceptClassId: "Term",
  standardConcept: null,
  conceptCode: "001",
  validStartDate: "2026-01-01",
  validEndDate: "2099-12-31",
  invalidReason: null,
  source: { packageId: "ALPHA", file: "ALPHA/Ontology/concept_delta.csv", row: 2 },
};

const artifacts = {
  "concepts.json": {
    schemaVersion: "2.0",
    packageId: "ALPHA",
    concepts: [concept],
    facets: {
      vocabularyId: ["A"],
      domainId: ["Observation"],
      conceptClassId: ["Term"],
      standardConcept: [null],
      invalidReason: [null],
    },
  },
  "search.json": {
    schemaVersion: "2.0",
    documents: [
      {
        conceptOrdinal: 0,
        conceptId: concept.conceptId,
        normalizedCode: "001",
        normalizedName: "alpha",
        normalizedSynonyms: ["first"],
        nameTokens: ["alpha"],
        synonymTokens: [["first"]],
      },
    ],
    lookups: {
      conceptId: { [concept.conceptId]: 0 },
      conceptCode: { "001": [0] },
      conceptName: { alpha: [0] },
      synonym: { first: [0] },
    },
  },
  "synonyms.json": {
    schemaVersion: "2.0",
    packageId: "ALPHA",
    byConceptId: {
      [concept.conceptId]: [
        { conceptId: concept.conceptId, conceptSynonymName: "First", languageConceptId: "4180186" },
      ],
    },
  },
  "relationships.json": {
    schemaVersion: "2.0",
    packageId: "ALPHA",
    rows: [
      {
        conceptId1: concept.conceptId,
        conceptId2: "123",
        relationshipId: "Maps to",
        validStartDate: "2026-01-01",
        validEndDate: "2099-12-31",
        invalidReason: null,
      },
    ],
    outgoing: { [concept.conceptId]: [0] },
    incoming: { "123": [0] },
  },
};

test("loads and validates the local schema 2.0 manifest", async () => {
  const manifest = await loadSourceManifest(DEFAULT_SOURCE, {
    localManifestUrl: "https://example.test/data/manifest.json",
    fetchImpl: async () => responseJson(manifestFixture),
  });
  assert.equal(manifest.schemaVersion, "2.0");
  assert.equal(manifest.__origin.mode, "local");
});

test("rejects manifests without all jointly required files and unsafe artifact paths", async () => {
  for (const invalid of [
    { ...manifestFixture, requiredFiles: ["concept_delta.csv"] },
    {
      ...manifestFixture,
      vocabularies: [
        { ...manifestFixture.vocabularies[0], artifacts: { concepts: "../outside.json" } },
      ],
    },
  ]) {
    await assert.rejects(
      loadSourceManifest(DEFAULT_SOURCE, {
        localManifestUrl: "https://example.test/data/manifest.json",
        fetchImpl: async () => responseJson(invalid),
      }),
      SourceLoadError,
    );
  }
});

test("GitHub discovery uses the resolved commit and exposes incomplete packages safely", async () => {
  const source = resolveSource("owner/repository@release");
  const fetchImpl = async (url) => {
    if (url.includes("/commits/")) return responseJson({ sha: "b".repeat(40) });
    return responseJson({
      truncated: false,
      tree: [
        { path: "ALPHA", type: "tree" },
        { path: "ALPHA/Ontology", type: "tree" },
        { path: "ALPHA/Ontology/concept_delta.csv", type: "blob" },
        { path: "ALPHA/Ontology/concept_synonym_delta.csv", type: "blob" },
        { path: "ALPHA/Ontology/concept_relationship_delta.csv", type: "blob" },
        { path: "HPO", type: "tree" },
        { path: "HPO/Mappings", type: "tree" },
      ],
    });
  };
  const manifest = await discoverGitHubManifest(source, { fetchImpl });
  assert.equal(manifest.source.commit, "b".repeat(40));
  assert.equal(manifest.vocabularies.find((entry) => entry.packageId === "ALPHA").browseable, true);
  assert.equal(manifest.vocabularies.find((entry) => entry.packageId === "HPO").status, "missing-required-data");
});

test("VocabularyRepository loads essential artifacts and resolves detail direction without inventing endpoints", async () => {
  const manifest = await loadSourceManifest(DEFAULT_SOURCE, {
    localManifestUrl: "https://example.test/data/manifest.json",
    fetchImpl: async () => responseJson(manifestFixture),
  });
  const fetchImpl = async (url) => {
    const filename = new URL(url).pathname.split("/").at(-1);
    return responseText(JSON.stringify(artifacts[filename]));
  };
  const repository = new VocabularyRepository({ manifest, source: DEFAULT_SOURCE, fetchImpl });
  const dataset = await repository.loadPackage("ALPHA");
  assert.equal(dataset.concepts[0].conceptCode, "001");
  const details = await repository.loadConceptDetails("ALPHA", concept.conceptId);
  assert.equal(details.synonyms[0].conceptSynonymName, "First");
  assert.equal(details.outgoing[0].relationshipId, "Maps to");
  assert.equal(details.outgoing[0].otherConcept, null);
  assert.equal(details.incoming.length, 0);
});

test("source-declared OMOP target requires matching evidence for this exact ID and vocabulary", async () => {
  for (const [targetId, vocabulary, expected] of [["456","SNOMED",false],["123","LOINC",false],["123","SNOMED",true]]) {
    const manifest = await loadSourceManifest(DEFAULT_SOURCE, {
      localManifestUrl:"https://example.test/data/manifest.json",fetchImpl:async()=>responseJson(manifestFixture),
    });
    const modified = structuredClone(artifacts);
    const row = modified["relationships.json"].rows[0];
    row.otherConceptOmop = {conceptId:"123",vocabularyId:"SNOMED",sourceDeclared:true};
    row.mappingMetadata = [{source_concept_id:concept.conceptId,source_code:"001",source_vocabulary_id:"A",
      objectConceptId:targetId,target_concept_id:targetId,target_vocabulary_id:vocabulary}];
    const fetchImpl = async (url) => responseText(JSON.stringify(modified[new URL(url).pathname.split("/").at(-1)]));
    const repository = new VocabularyRepository({manifest,source:DEFAULT_SOURCE,fetchImpl});
    const details = await repository.loadConceptDetails("ALPHA",concept.conceptId);
    assert.equal(Boolean(details.outgoing[0].otherConceptOmop),expected);
  }
});

test("stale artifacts cannot hide invalid or conflicting source identity fields", async () => {
  for (const sourceFields of [
    {source_concept_id:"bad",source_code:"001",source_description:"Alpha"},
    {source_concept_id:concept.conceptId,subject_id:"OMOP:999",source_code:"001"},
    {source_concept_id:concept.conceptId,subject_id:"A:WRONG",source_code:"001"},
    {source_concept_id:concept.conceptId,source_description:"Wrong",source_code:"001"},
  ]) {
    const manifest = await loadSourceManifest(DEFAULT_SOURCE, {
      localManifestUrl:"https://example.test/data/manifest.json",fetchImpl:async()=>responseJson(manifestFixture),
    });
    const modified = structuredClone(artifacts);
    const row = modified["relationships.json"].rows[0];
    row.otherConceptOmop = {conceptId:"123",vocabularyId:"SNOMED",sourceDeclared:true};
    row.mappingMetadata = [{...sourceFields,objectConceptId:"123",target_concept_id:"123",target_vocabulary_id:"SNOMED"}];
    const fetchImpl = async (url) => responseText(JSON.stringify(modified[new URL(url).pathname.split("/").at(-1)]));
    const repository = new VocabularyRepository({manifest,source:DEFAULT_SOURCE,fetchImpl});
    const details = await repository.loadConceptDetails("ALPHA",concept.conceptId);
    assert.equal(details.outgoing[0].mappingMetadata.length,0);
    assert.equal(details.outgoing[0].otherConceptOmop,undefined);
  }
});

test("stale metadata target IDs are revalidated in both outgoing and incoming hierarchy", async () => {
  const target = {...concept,conceptId:"2000000002",conceptName:"Beta",conceptCode:"TGT",vocabularyId:"B"};
  const cases = [
    {label:"correct",code:"TGT",expected:true},
    {label:"wrong code",code:"WRONG",expected:false},
    {label:"conflicting explicit ID",code:"TGT",targetId:"999",expected:false},
    {label:"duplicate code",code:"TGT",duplicate:true,expected:false},
    {label:"duplicate source identity",code:"TGT",duplicateSource:true,expected:false},
    {label:"explicit source ID disambiguates",code:"TGT",duplicateSource:true,sourceId:concept.conceptId,expected:true},
  ];
  for (const item of cases) {
    const fixture = structuredClone(manifestFixture);
    fixture.vocabularies[0].artifacts.metadata = "vocabularies/ALPHA/metadata.json";
    const manifest = await loadSourceManifest(DEFAULT_SOURCE, {localManifestUrl:"https://example.test/data/manifest.json",fetchImpl:async()=>responseJson(fixture)});
    const modified = structuredClone(artifacts);
    modified["concepts.json"].concepts.push(target);
    if (item.duplicate) modified["concepts.json"].concepts.push({...target,conceptId:"2000000003"});
    if (item.duplicateSource) modified["concepts.json"].concepts.push({...concept,conceptId:"2000000003"});
    const mapping = {subjectConceptId:concept.conceptId,objectConceptId:target.conceptId,subjectCode:"001",subjectVocabulary:"A",
      source_description:"Alpha",objectCode:item.code,objectVocabulary:"B",predicate_id:"skos:broadMatch",
      mapping_concept_code:`001|| - ||A|| - ||${item.code}|| - ||B`,associationStatus:"subject-only",
      ...(item.sourceId ? {source_concept_id:item.sourceId} : {}),
      ...(item.targetId ? {target_concept_id:item.targetId} : {})};
    modified["metadata.json"] = {schemaVersion:"2.0",packageId:"ALPHA",tables:{mappingMetadata:[mapping]}};
    const fetchImpl = async url => responseText(JSON.stringify(modified[new URL(url).pathname.split("/").at(-1)]));
    const repository = new VocabularyRepository({manifest,source:DEFAULT_SOURCE,fetchImpl});
    const sourceDetails = await repository.loadConceptDetails("ALPHA",concept.conceptId);
    const targetDetails = await repository.loadConceptDetails("ALPHA",target.conceptId);
    assert.equal(Boolean(sourceDetails.concept.mappingMetadata[0]?.targetIdentityVerified),item.expected,item.label);
    assert.equal(directHierarchy(sourceDetails).parents.some(x=>x.id===target.conceptId),item.expected,item.label);
    assert.equal(directHierarchy(targetDetails).children.some(x=>x.id===concept.conceptId),item.expected,item.label);
  }
});

test("metadata for another target is not displayed on an unrelated relationship", async () => {
  const manifest = await loadSourceManifest(DEFAULT_SOURCE, {
    localManifestUrl:"https://example.test/data/manifest.json",fetchImpl:async()=>responseJson(manifestFixture),
  });
  const modified = structuredClone(artifacts);
  const row = modified["relationships.json"].rows[0];
  row.otherConceptOmop = {conceptId:"123",vocabularyId:"SNOMED",sourceDeclared:true};
  row.mappingMetadata = [{source_concept_id:concept.conceptId,source_code:"001",source_vocabulary_id:"A",
    objectConceptId:"999",target_concept_id:"999",target_vocabulary_id:"SNOMED",predicate_id:"skos:broadMatch",author_label:"Wrong author"}];
  const fetchImpl = async url => responseText(JSON.stringify(modified[new URL(url).pathname.split("/").at(-1)]));
  const repository = new VocabularyRepository({manifest,source:DEFAULT_SOURCE,fetchImpl});
  const details = await repository.loadConceptDetails("ALPHA",concept.conceptId);
  assert.equal(details.outgoing[0].mappingMetadata.length,0);
  assert.equal(details.outgoing[0].otherConceptOmop,undefined);
});

test("external metadata targets need consistent explicit code, vocabulary and ID evidence", async () => {
  const fixture = structuredClone(manifestFixture);
  fixture.vocabularies[0].artifacts.metadata = "vocabularies/ALPHA/metadata.json";
  const cases = [
    {label:"missing evidence",evidence:null,expected:false},
    {label:"wrong code",evidence:{file:"ALPHA/Mapping/a.csv",row:2,conceptId:"123",conceptCode:"WRONG",vocabularyId:"SNOMED"},expected:false},
    {label:"matching evidence",evidence:{file:"ALPHA/Mapping/a.csv",row:2,conceptId:"123",conceptCode:"Z",vocabularyId:"SNOMED"},expected:true},
  ];
  for (const item of cases) {
    const manifest = await loadSourceManifest(DEFAULT_SOURCE, {localManifestUrl:"https://example.test/data/manifest.json",fetchImpl:async()=>responseJson(fixture)});
    const modified = structuredClone(artifacts);
    const mapping = {subjectConceptId:concept.conceptId,objectConceptId:"123",subjectCode:"001",subjectVocabulary:"A",
      source_description:"Alpha",objectCode:"Z",objectVocabulary:"SNOMED",predicate_id:"skos:broadMatch",
      mapping_concept_code:"001|| - ||A|| - ||Z|| - ||SNOMED",associationStatus:"subject-only",
      ...(item.evidence ? {targetIdentityEvidence:item.evidence} : {})};
    modified["metadata.json"] = {schemaVersion:"2.0",packageId:"ALPHA",tables:{mappingMetadata:[mapping]}};
    const fetchImpl = async url => responseText(JSON.stringify(modified[new URL(url).pathname.split("/").at(-1)]));
    const repository = new VocabularyRepository({manifest,source:DEFAULT_SOURCE,fetchImpl});
    const details = await repository.loadConceptDetails("ALPHA",concept.conceptId);
    assert.equal(details.concept.mappingMetadata[0].targetIdentityVerified,item.expected,item.label);
    assert.equal(directHierarchy(details).parents.some(x=>x.id==="123"),item.expected,item.label);
  }
});

test("VocabularyRepository calls browser fetch without an invalid method receiver", async () => {
  const manifest = await loadSourceManifest(DEFAULT_SOURCE, {
    localManifestUrl: "https://example.test/data/manifest.json",
    fetchImpl: async () => responseJson(manifestFixture),
  });
  const fetchImpl = async function fetchArtifact(url) {
    assert.equal(this, undefined);
    const filename = new URL(url).pathname.split("/").at(-1);
    return responseText(JSON.stringify(artifacts[filename]));
  };

  const repository = new VocabularyRepository({ manifest, source: DEFAULT_SOURCE, fetchImpl });
  const dataset = await repository.loadPackage("ALPHA");

  assert.equal(dataset.concepts.length, 1);
  assert.equal(dataset.concepts[0].conceptId, concept.conceptId);
});

function responseJson(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => structuredClone(value),
    text: async () => JSON.stringify(value),
  };
}

function responseText(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => value,
    json: async () => JSON.parse(value),
  };
}
