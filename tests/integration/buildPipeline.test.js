import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildBrowserData } from "../../scripts/build-browser-data.mjs";
import { validateBrowserData } from "../../scripts/validate-browser-data.mjs";
import { materializeCvbFixture } from "../helpers/cvbFixtureRepository.js";

const PROVENANCE = Object.freeze({
  repository: "ExampleOrg/FixtureCVB",
  ref: "fixture-ref",
  commit: "0123456789abcdef0123456789abcdef01234567",
  generatedAt: "2026-08-19T12:00:00.000Z",
});

async function isolatedOutput(t) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cvb-browser-test-"));
  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  return path.join(temporaryRoot, "data");
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function entry(manifest, packageId) {
  return manifest.vocabularies.find((item) => item.packageId === packageId);
}

test("build discovers dynamic packages, applies joint core requirements, and emits valid schema 2.0 artifacts", async (t) => {
  const source = await materializeCvbFixture(t, "valid-source");
  const output = await isolatedOutput(t);
  const sourceConceptPath = path.join(source, "ALPHA", "Ontology", "concept_delta.csv");
  const sourceBefore = await readFile(sourceConceptPath, "utf8");

  const manifest = await buildBrowserData({ source, output, ...PROVENANCE });

  assert.equal(await readFile(sourceConceptPath, "utf8"), sourceBefore, "the build must not rewrite source CSVs");
  assert.equal(manifest.schemaVersion, "2.0");
  assert.equal(manifest.generatedAt, PROVENANCE.generatedAt);
  assert.deepEqual(manifest.source, {
    provider: "github",
    repository: PROVENANCE.repository,
    ref: PROVENANCE.ref,
    commit: PROVENANCE.commit,
  });
  assert.deepEqual(manifest.requiredFiles, [
    "concept_delta.csv",
    "concept_synonym_delta.csv",
    "concept_relationship_delta.csv",
  ]);
  assert.deepEqual(
    manifest.vocabularies.map((item) => item.packageId),
    ["ALPHA", "BETA", "CONCEPT_ONLY", "HPO"],
    "package discovery must derive from sorted repository contents, not a vocabulary allow-list",
  );

  const alpha = entry(manifest, "ALPHA");
  assert.equal(alpha.sourcePath, "ALPHA/Ontology");
  assert.equal(alpha.browseable, true);
  assert.equal(alpha.status, "ready");
  assert.deepEqual(alpha.vocabularyIds, ["ALPHA_VOC", "SECOND_VOC"]);
  assert.equal(alpha.packageId === alpha.vocabularyIds[0], false, "package identity is not vocabulary_id");
  assert.deepEqual(
    {
      concepts: alpha.counts.concepts,
      synonyms: alpha.counts.synonyms,
      sourceSynonyms: alpha.counts.sourceSynonyms,
      orphanSynonyms: alpha.counts.orphanSynonyms,
      relationships: alpha.counts.relationships,
      both: alpha.counts.relationshipsLocalBoth,
      one: alpha.counts.relationshipsOneLocal,
      neither: alpha.counts.relationshipsExternal,
    },
    {
      concepts: 2,
      synonyms: 2,
      sourceSynonyms: 3,
      orphanSynonyms: 1,
      relationships: 4,
      both: 1,
      one: 2,
      neither: 1,
    },
  );
  assert.equal(alpha.capabilities.conceptSearch, true);
  assert.equal(alpha.capabilities.synonymSearch, true);
  assert.equal(alpha.capabilities.relationships, true);
  assert.equal(alpha.capabilities.hierarchy, false);
  assert.equal(alpha.capabilities.vocabularyMetadata, true);
  assert.equal(Object.hasOwn(alpha.artifacts, "hierarchy"), false);
  assert.match(alpha.warnings.join("\n"), /Hierarchy disabled/u);
  assert.match(alpha.warnings.join("\n"), /1 synonym row\(s\).*excluded from search/u);

  const beta = entry(manifest, "BETA");
  assert.equal(beta.sourcePath, "BETA", "root-layout core files are supported by discovery");
  assert.equal(beta.browseable, true);
  assert.deepEqual(beta.vocabularyIds, ["INTERNAL_BETA"]);

  const conceptOnly = entry(manifest, "CONCEPT_ONLY");
  assert.equal(conceptOnly.browseable, false);
  assert.equal(conceptOnly.status, "missing-required-data");
  assert.match(
    conceptOnly.errors.join("\n"),
    /concept_synonym_delta\.csv, concept_relationship_delta\.csv/u,
  );

  const hpo = entry(manifest, "HPO");
  assert.equal(hpo.browseable, false);
  assert.equal(hpo.status, "missing-required-data");
  assert.match(hpo.errors.join("\n"), /concept_delta\.csv/u);
  assert.deepEqual(hpo.artifacts, {});

  const concepts = await readJson(path.join(output, ...alpha.artifacts.concepts.split("/")));
  assert.equal(concepts.schemaVersion, "2.0");
  assert.equal(concepts.packageId, "ALPHA");
  assert.equal(concepts.concepts[0].conceptName, '  Alpha, "quoted" concept  ');
  assert.equal(concepts.concepts[0].conceptCode, "0007");
  assert.equal(concepts.concepts[0].standardConcept, null);
  assert.equal(concepts.concepts[0].invalidReason, null);
  assert.equal(concepts.concepts[0].source.packageId, "ALPHA");

  const synonyms = await readJson(path.join(output, ...alpha.artifacts.synonyms.split("/")));
  assert.deepEqual(Object.keys(synonyms.byConceptId), ["1000000001", "1000000002"]);
  assert.equal(Object.hasOwn(synonyms.byConceptId, "9999999999"), false);

  const relationships = await readJson(path.join(output, ...alpha.artifacts.relationships.split("/")));
  assert.deepEqual(
    relationships.rows.map((row) => [row.conceptId1, row.relationshipId, row.conceptId2]),
    [
      ["1000000001", "Maps to", "1000000002"],
      ["9999999999", "Mapped from", "1000000001"],
      ["1000000001", "Maps to", "8888888888"],
      ["7777777777", "Is a", "8888888888"],
    ],
  );

  const validated = await validateBrowserData(output);
  assert.equal(validated.schemaVersion, "2.0");
  assert.deepEqual(
    validated.vocabularies.filter((item) => item.browseable).map((item) => item.packageId),
    ["ALPHA", "BETA"],
  );
});

test("a malformed jointly required core package fails the build and is recorded as invalid", async (t) => {
  const source = await materializeCvbFixture(t, "invalid-core-source");
  const output = await isolatedOutput(t);

  await assert.rejects(
    buildBrowserData({ source, output, ...PROVENANCE }),
    /Required vocabulary validation failed:\nBROKEN:.*standard_concept must be blank or one of S, C/u,
  );

  const manifest = await readJson(path.join(output, "manifest.json"));
  assert.equal(manifest.schemaVersion, "2.0");
  assert.equal(entry(manifest, "BROKEN").browseable, false);
  assert.equal(entry(manifest, "BROKEN").status, "invalid-required-data");
  assert.match(entry(manifest, "BROKEN").errors.join("\n"), /standard_concept/u);
  assert.equal(entry(manifest, "VALID").browseable, true);
  await validateBrowserData(output);
});

test("artifact validation rejects a generated search artifact that no longer resolves to its concept", async (t) => {
  const source = await materializeCvbFixture(t, "valid-source");
  const output = await isolatedOutput(t);
  const manifest = await buildBrowserData({ source, output, ...PROVENANCE });
  const alpha = entry(manifest, "ALPHA");
  const searchPath = path.join(output, ...alpha.artifacts.search.split("/"));
  const search = await readJson(searchPath);
  search.documents[0].conceptId = "9999999999";
  await writeFile(searchPath, `${JSON.stringify(search)}\n`, "utf8");

  await assert.rejects(
    validateBrowserData(output),
    /ALPHA search ordinal 0 resolves to the wrong concept/u,
  );
});

test("artifact validation rejects semantic and directional corruption before publication", async (t) => {
  const source = await materializeCvbFixture(t, "valid-source");
  const output = await isolatedOutput(t);
  const manifest = await buildBrowserData({ source, output, ...PROVENANCE });
  const alpha = entry(manifest, "ALPHA");

  const conceptsPath = path.join(output, ...alpha.artifacts.concepts.split("/"));
  const concepts = await readJson(conceptsPath);
  concepts.concepts[0].standardConcept = "X";
  concepts.concepts[0].validStartDate = "not-a-date";
  await writeFile(conceptsPath, `${JSON.stringify(concepts)}\n`, "utf8");

  const relationshipsPath = path.join(output, ...alpha.artifacts.relationships.split("/"));
  const relationships = await readJson(relationshipsPath);
  [relationships.rows[0].conceptId1, relationships.rows[0].conceptId2] = [
    relationships.rows[0].conceptId2,
    relationships.rows[0].conceptId1,
  ];
  await writeFile(relationshipsPath, `${JSON.stringify(relationships)}\n`, "utf8");

  const manifestPath = path.join(output, "manifest.json");
  const corruptedManifest = await readJson(manifestPath);
  corruptedManifest.source.commit = "not-a-sha";
  corruptedManifest.vocabularies.find((item) => item.packageId === "ALPHA").counts.orphanSynonyms = 0;
  await writeFile(manifestPath, `${JSON.stringify(corruptedManifest)}\n`, "utf8");

  await assert.rejects(validateBrowserData(output), (error) => {
    assert.match(error.message, /source\.commit must be a 40-character hexadecimal Git commit SHA/u);
    assert.match(error.message, /standardConcept is invalid/u);
    assert.match(error.message, /validStartDate is invalid/u);
    assert.match(error.message, /outgoing index .* does not match artifact rows/u);
    assert.match(error.message, /source\/orphan synonym counts are inconsistent/u);
    return true;
  });
});

test("build requires complete immutable source provenance", async (t) => {
  const source = await materializeCvbFixture(t, "valid-source");
  const output = await isolatedOutput(t);

  await assert.rejects(
    buildBrowserData({ source, output, repository: PROVENANCE.repository, ref: PROVENANCE.ref }),
    /--commit is required for source provenance/u,
  );
});
