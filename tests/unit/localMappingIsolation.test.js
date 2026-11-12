import test from "node:test";
import assert from "node:assert/strict";
import { createLocalDirectorySource } from "../../browser/js/services/localDirectoryService.js";
import { VocabularyRepository } from "../../browser/js/services/dataService.js";
import { directHierarchy } from "../../browser/js/ui/conceptDetails.js";
import { CORE_FILE_NAMES, validSourceContent } from "../helpers/cvbFixtureRepository.js";

function file(path, content) {
  return { name: path.split("/").at(-1), webkitRelativePath: path, text: async () => content };
}
function core(packageName) {
  return CORE_FILE_NAMES.map(name => file(`ROOT/${packageName}/Ontology/${name}`, validSourceContent(`ALPHA/Ontology/${name}`)));
}
function repo(source, manifest) {
  return new VocabularyRepository({ source, manifest, fetchImpl: async () => { throw new Error("local import must not use network"); } });
}

test("local packages isolate optional SKOS mapping metadata and preserve both hierarchy directions", async () => {
  const mapping = [
    "concept_id_1,concept_id_2,predicate_id,confidence,author_label",
    "1000000001,1000000002,skos:broadMatch,0.9,Source author",
    "1000000002,1000000001,skos:narrowMatch,0.8,Another author",
  ].join("\n") + "\n";
  const { source, manifest } = await createLocalDirectorySource([...core("ALPHA"), ...core("BETA"), file("ROOT/ALPHA/Ontology/mapping_metadata.csv", mapping)]);
  const repository = repo(source, manifest);
  const first = await repository.loadConceptDetails("ALPHA", "1000000001");
  const second = await repository.loadConceptDetails("ALPHA", "1000000002");
  assert.equal(first.concept.mappingMetadata[0].predicate_id, "skos:broadMatch");
  assert.equal(first.concept.mappingMetadata[0].confidence, "0.9");
  assert.equal(second.concept.mappingMetadata[0].predicate_id, "skos:narrowMatch");
  assert.equal(second.concept.mappingMetadata[0].author_label, "Another author");
  assert.ok(directHierarchy(first).parents.some(x => x.id === "1000000002"));
  assert.ok(directHierarchy(second).children.some(x => x.id === "1000000001"));
  assert.deepEqual((await repository.loadConceptDetails("BETA", "1000000001")).concept.mappingMetadata, []);
  assert.ok((await repository.loadConceptDetails("BETA", "1000000001")).outgoing.length > 0);
});

test("an invalid optional mapping file does not disable core local vocabulary", async () => {
  const { source, manifest } = await createLocalDirectorySource([...core("ALPHA"), file("ROOT/ALPHA/Ontology/mapping_metadata.csv", "id,label\n1,Unsupported\n")]);
  const repository = repo(source, manifest);
  const loaded = await repository.loadPackage("ALPHA");
  assert.equal(loaded.concepts.length, 2);
  assert.match(loaded.entry.warnings.join(" "), /mapping metadata disabled/);
  assert.deepEqual((await repository.loadConceptDetails("ALPHA", "1000000001")).concept.mappingMetadata, []);
});
