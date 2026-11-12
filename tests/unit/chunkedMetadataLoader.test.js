import test from "node:test";
import assert from "node:assert/strict";
import { VocabularyRepository } from "../../browser/js/services/dataService.js";
import { directHierarchy } from "../../browser/js/ui/conceptDetails.js";

const concept = (id, name, code) => ({ conceptId:id, conceptName:name, conceptCode:code, vocabularyId:"SYNTH", domainId:"Observation", conceptClassId:"Term" });
const concepts = [concept("1","Source","A"),concept("2","Parent","B"),concept("3","Child","C")];
const row = (target,code,predicate,tag) => ({ subjectConceptId:"1", objectConceptId:target, subjectCode:"A", subjectVocabulary:"SYNTH", source_concept_id:"1", source_code:"A", source_vocabulary_id:"SYNTH", target_concept_id:target, target_vocabulary_id:"SYNTH", objectCode:code, objectVocabulary:"SYNTH", predicate_id:predicate, confidence:"1", author_label:tag });
const broad = row("2","B","skos:broadMatch","Перший \"автор\"");
const narrow = row("3","C","skos:narrowMatch","Другий");
const descriptor = (file,count) => ({file,count});
const metadata = (packageId,rows) => ({ schemaVersion:"2.0", packageId, tables:{mappingMetadata:rows} });
function fixture(packageId, meta, chunks={}) {
  const base=`vocabularies/${packageId}/`;
  const entry={packageId,displayName:packageId,browseable:true,artifacts:Object.fromEntries(["concepts","search","synonyms","relationships","metadata"].map(key=>[key,`${base}${key}.json`]))};
  const rel={conceptId1:"1",conceptId2:"3",relationshipId:"Maps to",mappingMetadata:[narrow]};
  return {entry, files:{[`${base}concepts.json`]:{schemaVersion:"2.0",packageId,concepts,facets:{}},
    [`${base}search.json`]:{schemaVersion:"2.0",documents:[]},[`${base}synonyms.json`]:{byConceptId:{}},
    [`${base}relationships.json`]:{rows:[rel],outgoing:{"1":[0]},incoming:{"3":[0]}},
    ...(meta === undefined ? {} : {[`${base}metadata.json`]:meta}),
    ...Object.fromEntries(Object.entries(chunks).map(([k,v])=>[base+k,v]))}};
}
function makeRepository(fixtures, mode="local") {
  const files=Object.assign({},...fixtures.map(x=>x.files)); const requests=[];
  const manifest={vocabularies:fixtures.map(x=>x.entry)};
  manifest.__origin=mode==="local" ? {mode,baseUrl:"https://example.test/project-name/browser/data/"} : {mode:"github-prebuilt"};
  const fetchImpl=async url=>{
    requests.push(String(url)); const parsed=new URL(url);
    const marker=mode==="local"?"/project-name/browser/data/":"/example/repo/main/browser/data/";
    const key=decodeURIComponent(parsed.pathname.split(marker)[1]??"");
    if (!(key in files)) return {ok:false,status:404,headers:{get:()=>"text/plain"},text:async()=>""};
    const value=files[key]; return {ok:true,status:200,headers:{get:()=>"text/plain"},text:async()=>typeof value==="string"?value:JSON.stringify(value)};
  };
  return {repository:new VocabularyRepository({manifest,source:{owner:"example",repository:"repo",ref:"main"},fetchImpl}),files,requests};
}
function split(packageId, rows) { return {...metadata(packageId,[]),mappingMetadataChunks:[descriptor("mapping-metadata-00001.json",rows.length)],mappingMetadataTotal:rows.length}; }

test("ordered chunks reconstruct fully, stay package-local and retain relationship metadata and hierarchy direction", async () => {
  const m1={...metadata("A",[]),mappingMetadataChunks:[descriptor("mapping-metadata-00001.json",1),descriptor("mapping-metadata-00002.json",1)],mappingMetadataTotal:2};
  const m2=split("B",[broad]);
  const f1=fixture("A",m1,{"mapping-metadata-00001.json":[broad],"mapping-metadata-00002.json":[narrow]});
  const f2=fixture("B",m2,{"mapping-metadata-00001.json":[{...broad,author_label:"Distinct package"}]});
  const {repository,requests}=makeRepository([f1,f2]);
  const detail=await repository.loadConceptDetails("A","1");
  assert.deepEqual(detail.metadata.mappingMetadata,[broad,narrow]);
  assert.deepEqual(detail.outgoing[0].mappingMetadata,[narrow]);
  const hierarchy=directHierarchy(detail);
  assert.deepEqual(hierarchy.parents.map(x=>x.id),["2"]); assert.deepEqual(hierarchy.children.map(x=>x.id),["3"]);
  assert.equal(hierarchy.parents[0].hierarchyMetadata.length,1);
  assert.deepEqual((await repository.loadConceptDetails("B","1")).metadata.mappingMetadata,[{...broad,author_label:"Distinct package"}]);
  assert(requests.some(url=>url==="https://example.test/project-name/browser/data/vocabularies/A/mapping-metadata-00001.json"));
  assert(requests.some(url=>url==="https://example.test/project-name/browser/data/vocabularies/B/mapping-metadata-00001.json"));
});

test("legacy inline, no mapping table and no metadata artifact remain supported", async () => {
  const a=fixture("A",metadata("A",[broad])), b=fixture("B",{schemaVersion:"2.0",packageId:"B",tables:{}}), c=fixture("C",undefined);
  delete c.entry.artifacts.metadata;
  const {repository,requests}=makeRepository([a,b,c]);
  assert.deepEqual((await repository.loadConceptDetails("A","1")).metadata.mappingMetadata,[broad]);
  assert.deepEqual((await repository.loadConceptDetails("B","1")).metadata,{});
  assert.deepEqual((await repository.loadConceptDetails("C","1")).metadata,{});
  assert.equal(requests.some(url=>url.includes("mapping-metadata-")),false);
});

test("prebuilt GitHub source fetches chunks next to metadata using pinned source path", async () => {
  const f=fixture("A",split("A",[broad]),{"mapping-metadata-00001.json":[broad]});
  const {repository,requests}=makeRepository([f],"github");
  assert.deepEqual((await repository.loadConceptDetails("A","1")).metadata.mappingMetadata,[broad]);
  assert(requests.some(url=>url.includes("/example/repo/main/browser/data/vocabularies/A/mapping-metadata-00001.json")));
});

test("invalid chunk declarations are rejected before fetching unexpected paths", async () => {
  const good=split("A",[broad]);
  const invalid=[
    {...good,packageId:"B"}, {...good,schemaVersion:"3.0"}, {...good,tables:{mappingMetadata:[broad]}},
    {...metadata("A",[]),mappingMetadataTotal:1},
    {...good,mappingMetadataChunks:[]}, {...good,mappingMetadataTotal:2},
    {...good,mappingMetadataChunks:[descriptor("../secret.json",1)]},
    {...good,mappingMetadataChunks:[descriptor("mapping-metadata-00002.json",1)]},
    {...good,mappingMetadataChunks:[descriptor("mapping-metadata-00001.json",0)]},
    {...good,mappingMetadataChunks:[descriptor("mapping-metadata-00001.json",1),descriptor("mapping-metadata-00001.json",1)],mappingMetadataTotal:2},
  ];
  for(const bad of invalid){
    const {repository,requests}=makeRepository([fixture("A",bad,{"mapping-metadata-00001.json":[broad]})]);
    await assert.rejects(repository.loadConceptDetails("A","1"),{code:"INVALID_ARTIFACT"});
    assert(!requests.some(url=>url.includes("mapping-metadata-")));
  }
});

test("missing, malformed and count-mismatched chunks fail and do not cache partial details", async () => {
  const name="mapping-metadata-00001.json", key=`vocabularies/A/${name}`;
  const {repository,files}=makeRepository([fixture("A",split("A",[broad]))]);
  await assert.rejects(repository.loadConceptDetails("A","1"),{code:"MISSING_ARTIFACT"});
  files[key]="invalid json"; await assert.rejects(repository.loadConceptDetails("A","1"),{code:"INVALID_ARTIFACT"});
  files[key]=[]; await assert.rejects(repository.loadConceptDetails("A","1"),{code:"INVALID_ARTIFACT"});
  files[key]=["not a row"]; await assert.rejects(repository.loadConceptDetails("A","1"),{code:"INVALID_ARTIFACT"});
  files[key]=[broad]; assert.deepEqual((await repository.loadConceptDetails("A","1")).metadata.mappingMetadata,[broad]);
});

test("encoded traversal and control in the metadata path fail before any metadata fetch", async () => {
  for (const path of ["vocabularies/A/%2e%2e/metadata.json", "vocabularies/A/%2Fmetadata.json", "vocabularies/A/%5cmetadata.json", "vocabularies/A/%252e%252e/metadata.json", "vocabularies/A/%00metadata.json", "vocabularies/A/metadata.json?x=1"]) {
    const f=fixture("A",split("A",[broad]),{"mapping-metadata-00001.json":[broad]});
    f.entry.artifacts.metadata=path;
    const {repository,requests}=makeRepository([f]);
    await assert.rejects(repository.loadConceptDetails("A","1"),{code:"INVALID_ARTIFACT"});
    assert(!requests.some(url=>url.includes("metadata.json")||url.includes("mapping-metadata-")));
  }
});

test("remembering prebuilt packages materializes details and mapping chunks before offline restore", async () => {
  const f = fixture("A", split("A", [broad]), {"mapping-metadata-00001.json": [broad]});
  const { repository, requests } = makeRepository([f], "github");
  await repository.loadAllPackages();
  assert.equal(requests.length, 2);
  const packages = await repository.createSnapshotPackages();
  assert.deepEqual(packages.get("A").metadata.tables.mappingMetadata, [broad]);
  assert(requests.some(url => url.includes("mapping-metadata-00001.json")));
  const manifest = { vocabularies: [f.entry] };
  Object.defineProperty(manifest, "__origin", {value: {mode: "saved-local", packages}});
  let fetched = false;
  const restored = new VocabularyRepository({manifest, source: {provider:"github"}, fetchImpl: async () => { fetched = true; throw new Error("Must remain offline"); }});
  assert.equal((await restored.loadAllPackages()).concepts.length, 3);
  assert.deepEqual((await restored.loadConceptDetails("A", "1")).metadata.mappingMetadata, [broad]);
  assert.equal(fetched, false);
});

test("remembering prebuilt data fails instead of storing incomplete detail chunks", async () => {
  const { repository } = makeRepository([fixture("A", split("A", [broad]))]);
  await repository.loadAllPackages();
  await assert.rejects(repository.createSnapshotPackages(), {code: "MISSING_ARTIFACT"});
});

test("cancelled remembering stops prebuilt requests without caching incomplete details", async () => {
  const { repository } = makeRepository([fixture("A", split("A", [broad]))]);
  await repository.loadAllPackages();
  repository.fetchImpl = (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {once:true});
  });
  const controller = new AbortController();
  const pending = repository.createSnapshotPackages({signal:controller.signal});
  controller.abort();
  await assert.rejects(pending, {name: "AbortError"});
  assert.equal(repository.detailCache.size, 0);
});
