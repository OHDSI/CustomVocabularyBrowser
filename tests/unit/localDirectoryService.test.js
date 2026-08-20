import test from "node:test";
import assert from "node:assert/strict";

import { VocabularyRepository } from "../../browser/js/services/dataService.js";
import { createLocalDirectorySource } from "../../browser/js/services/localDirectoryService.js";
import { CORE_FILE_NAMES, validSourceContent } from "../helpers/cvbFixtureRepository.js";

test("local folder builds a browseable package and loads all jointly required tables", async () => {
  const files = await fixtureFiles("Selected repository/ALPHA/Ontology");
  const { source, manifest } = await createLocalDirectorySource(files);

  assert.equal(source.provider, "local-directory");
  assert.equal(source.folderName, "Selected repository");
  assert.equal(manifest.vocabularies[0].packageId, "ALPHA");
  assert.equal(manifest.vocabularies[0].browseable, true);
  assert.equal(Object.hasOwn(manifest, "__origin"), true);
  assert.equal(JSON.stringify(manifest).includes("__origin"), false);

  const repository = new VocabularyRepository({
    manifest,
    source,
    fetchImpl: async () => {
      throw new Error("Local mode must not fetch from the network.");
    },
  });
  const dataset = await repository.loadPackage("ALPHA");
  assert.equal(dataset.concepts.length, 2);
  const details = await repository.loadConceptDetails("ALPHA", "1000000001");
  assert.equal(details.synonyms[0].conceptSynonymName, "Alpha alias, primary");
  assert.equal(details.outgoing.length, 2);
});

test("local repository discovery keeps incomplete packages visible but unavailable", async () => {
  const complete = await fixtureFiles("CVB root/ALPHA/Ontology");
  const incomplete = [fakeFile("CVB root/INCOMPLETE/Ontology/concept_delta.csv", "concept_id\n1000000001\n")];
  const { manifest } = await createLocalDirectorySource([...complete, ...incomplete]);

  assert.deepEqual(manifest.vocabularies.map((entry) => entry.packageId), ["ALPHA", "INCOMPLETE"]);
  const unavailable = manifest.vocabularies.find((entry) => entry.packageId === "INCOMPLETE");
  assert.equal(unavailable.browseable, false);
  assert.match(unavailable.errors[0], /concept_synonym_delta\.csv/u);
  assert.match(unavailable.errors[0], /concept_relationship_delta\.csv/u);
});

test("a selected package folder or its Ontology folder is accepted", async () => {
  const packageSelection = await createLocalDirectorySource(await fixtureFiles("ALPHA/Ontology"));
  assert.equal(packageSelection.manifest.vocabularies[0].packageId, "ALPHA");

  const ontologySelection = await createLocalDirectorySource(await fixtureFiles("Ontology"));
  assert.equal(ontologySelection.manifest.vocabularies[0].packageId, "Ontology");
  assert.equal(ontologySelection.manifest.vocabularies[0].browseable, true);
});

test("empty, unsafe, and duplicate local selections are rejected", async () => {
  await assert.rejects(() => createLocalDirectorySource([]), { code: "LOCAL_SELECTION_EMPTY" });
  await assert.rejects(
    () => createLocalDirectorySource([fakeFile("../concept_delta.csv", "")]),
    { code: "LOCAL_PATH_UNSAFE" },
  );
  await assert.rejects(
    () => createLocalDirectorySource([
      fakeFile("ROOT/concept_delta.csv", ""),
      fakeFile("ROOT/concept_delta.csv", ""),
    ]),
    { code: "LOCAL_PATH_COLLISION" },
  );
});

async function fixtureFiles(relativeRoot) {
  return CORE_FILE_NAMES.map((filename) => (
    fakeFile(relativeRoot + "/" + filename, validSourceContent("ALPHA/Ontology/" + filename))
  ));
}

function fakeFile(relativePath, content) {
  return {
    name: relativePath.split("/").at(-1),
    webkitRelativePath: relativePath,
    text: async () => content,
  };
}
