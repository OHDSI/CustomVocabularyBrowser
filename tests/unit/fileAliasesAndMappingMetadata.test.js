import test from "node:test";
import assert from "node:assert/strict";
import { discoverTableFiles, discoverGitHubManifest } from "../../browser/js/services/manifestService.js";
import { createLocalDirectorySource } from "../../browser/js/services/localDirectoryService.js";
import { buildVocabularyArtifacts, parseMappingMetadata } from "../../browser/js/services/vocabularyParser.js";
import { validSourceContent } from "../helpers/cvbFixtureRepository.js";

const concepts = () => [
  { conceptId: "100", vocabularyId: "SOURCE", conceptCode: "001", conceptName: "Source name" },
  { conceptId: "200", vocabularyId: "SNOMED", conceptCode: "555", conceptName: "Target name" },
];
const relationships = () => [{ conceptId1: "100", conceptId2: "200", relationshipId: "Maps to" }];
const source = (text) => ({ path: "P/mapping_metadata.csv", text });

test("standard and delta table names can be mixed but duplicate aliases are rejected", () => {
  const result = discoverTableFiles("P", new Set([
    "P/concept.csv", "P/concept_synonym_delta.csv", "P/concept_relationship.csv",
    "P/vocabulary.csv", "P/mapping_metadata.csv",
  ]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.files.concept, "P/concept.csv");
  assert.equal(result.files.relationship, "P/concept_relationship.csv");
  const conflict = discoverTableFiles("P", new Set(["P/concept.csv", "P/concept_delta.csv"]));
  assert.equal(conflict.files.concept, undefined);
  assert.match(conflict.errors[0], /Conflicting files/);
});

test("local standard-named tables load with the same schema and alias conflicts fail explicitly", async () => {
  const files = ["concept", "concept_synonym", "concept_relationship"].map((name) => ({
    webkitRelativePath: `P/${name}.csv`,
    text: async () => validSourceContent(`ALPHA/Ontology/${name}_delta.csv`),
  }));
  const { manifest } = await createLocalDirectorySource(files);
  assert.equal(manifest.vocabularies[0].browseable, true);
  assert.equal(manifest.vocabularies[0].files.concept, "concept.csv");
  await assert.rejects(createLocalDirectorySource([...files, {
    webkitRelativePath: "P/concept_delta.csv", text: files[0].text,
  }]), /Conflicting files/);
});

test("mapping metadata attaches to the exact directed relationship and source system", () => {
  const localConcepts = concepts();
  const localRelationships = relationships();
  const result = parseMappingMetadata(source(
    "subject_id,object_id,source_description,target_description,predicate_id,confidence,source_code_set,publication_date\nSOURCE:001,SNOMED:555,Source name,Target name,skos:exactMatch,0.9,EHR A,2026-01-01\n",
  ), localConcepts, localRelationships);
  assert.equal(result.rows[0].subjectConceptId, "100");
  assert.equal(result.rows[0].objectConceptId, "200");
  assert.equal(result.rows[0].associationStatus, "relationship");
  assert.equal(localRelationships[0].mappingMetadata[0].predicate_id, "skos:exactMatch");
  assert.deepEqual(localConcepts[0].sourceSystems, ["EHR A"]);
  assert.equal(localConcepts[1].mappingMetadata, undefined);
});

test("CVB composite codes require name as well, and never use mapping row ID", () => {
  const localConcepts = concepts();
  const result = parseMappingMetadata(source(
    "mapping_concept_id,mapping_concept_code,source_description,predicate_id\n200,001|| - ||SOURCE|| - ||missing|| - ||SNOMED,Source name,skos:relatedMatch\n",
  ), localConcepts, relationships());
  assert.equal(result.rows[0].subjectConceptId, "100");
  assert.equal(result.rows[0].objectConceptId, null);
  assert.equal(result.rows[0].objectCode, "missing");
  assert.equal(result.rows[0].associationStatus, "subject-only");
  assert.equal(localConcepts[0].mappingMetadata, undefined);
  assert.equal(localConcepts[0].sourceSystems, undefined);
  assert.equal(result.rows[0].publication_date, undefined);
});

test("ambiguous mapping endpoints and relationship types do not get guessed", () => {
  const duplicateCodes = [...concepts(), { conceptId: "300", vocabularyId: "SOURCE", conceptCode: "001" }];
  const ambiguous = parseMappingMetadata(source("subject_id,object_id\nSOURCE:001,SNOMED:555\n"), duplicateCodes, relationships());
  assert.equal(ambiguous.rows[0].subjectConceptId, null);
  assert.equal(duplicateCodes[0].mappingMetadata, undefined);
  const multiple = [...relationships(), { conceptId1: "100", conceptId2: "200", relationshipId: "Is a" }];
  const result = parseMappingMetadata(source("subject_id,object_id\nOMOP:100,OMOP:200\n"), concepts(), multiple);
  assert.equal(result.rows[0].associationStatus, "ambiguous-relationship");
  assert.equal(multiple[0].mappingMetadata, undefined);
});

test("invalid optional mapping headers warn without disabling core concepts", () => {
  const sources = Object.fromEntries([
    ["concept", "concept_delta.csv"], ["synonym", "concept_synonym_delta.csv"], ["relationship", "concept_relationship_delta.csv"],
  ].map(([key, file]) => [key, { path: file, text: validSourceContent(`ALPHA/Ontology/${file}`) }]));
  sources.mappingMetadata = source("id,label\n1,Unsupported\n");
  const built = buildVocabularyArtifacts({ packageId: "ALPHA", sources });
  assert.equal(built.concepts.concepts.length, 2);
  assert.match(built.warnings.join(" "), /mapping metadata disabled/);
});

test("GitHub discovery recognizes standard filenames and marks conflicting packages unavailable", async () => {
  const source = { owner: "test", repository: "repo", ref: "main" };
  const manifest = await discoverGitHubManifest(source, {
    fetchImpl: async (url) => ({ ok: true, json: async () => url.includes("/commits/")
      ? { sha: "a".repeat(40) }
      : { tree: [
        { type: "tree", path: "P" },
        ...["concept.csv", "concept_synonym.csv", "concept_relationship.csv"].map((name) => ({ type: "blob", path: `P/Ontology/${name}` })),
        { type: "tree", path: "CONFLICT" },
        ...["concept.csv", "concept_delta.csv", "concept_synonym.csv", "concept_relationship.csv"].map((name) => ({ type: "blob", path: `CONFLICT/${name}` })),
      ] } }),
  });
  assert.equal(manifest.vocabularies.find((entry) => entry.packageId === "P").browseable, true);
  const conflict = manifest.vocabularies.find((entry) => entry.packageId === "CONFLICT");
  assert.equal(conflict.browseable, false);
  assert.equal(conflict.status, "conflicting-data");
  assert.match(conflict.errors.join(" "), /Conflicting files/);
});

test("build serializes standard-named tables and mapping metadata; duplicate aliases fail", async (t) => {
  const { materializeCvbFixture } = await import("../helpers/cvbFixtureRepository.js");
  const { rename, writeFile, mkdtemp, rm, readFile, copyFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { buildBrowserData } = await import("../../scripts/build-browser-data.mjs");
  const { validateBrowserData } = await import("../../scripts/validate-browser-data.mjs");
  const root = await materializeCvbFixture(t, "valid-source");
  const output = await mkdtemp(path.join(tmpdir(), "cvb-alias-build-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  for (const name of ["concept", "concept_synonym", "concept_relationship"]) {
    await rename(path.join(root, "ALPHA/Ontology", `${name}_delta.csv`), path.join(root, "ALPHA/Ontology", `${name}.csv`));
  }
  await writeFile(path.join(root, "ALPHA/Ontology/mapping_metadata.csv"),
    "subject_id,object_id,predicate_id,source_code_set\nOMOP:1000000001,OMOP:1000000002,skos:exactMatch,EHR\n");
  const options = { source: root, output, repository: "test/repo", ref: "main", commit: "a".repeat(40) };
  const manifest = await buildBrowserData(options);
  const entry = manifest.vocabularies.find((item) => item.packageId === "ALPHA");
  const artifact = JSON.parse(await readFile(path.join(output, entry.artifacts.concepts), "utf8"));
  assert.deepEqual(artifact.concepts[0].sourceSystems, ["EHR"]);
  assert.equal(artifact.concepts[0].mappingMetadata, undefined);
  const metadata = JSON.parse(await readFile(path.join(output, entry.artifacts.metadata), "utf8"));
  assert.equal(metadata.tables.mappingMetadata[0].associationStatus, "relationship");
  assert.equal(metadata.tables.mappingMetadata[0].subjectConceptId, "1000000001");
  await validateBrowserData(output);
  await copyFile(path.join(root, "ALPHA/Ontology/concept.csv"), path.join(root, "ALPHA/Ontology/concept_delta.csv"));
  await assert.rejects(buildBrowserData({ ...options, output: path.join(output, "conflict-check") }), /Conflicting files/);
});
