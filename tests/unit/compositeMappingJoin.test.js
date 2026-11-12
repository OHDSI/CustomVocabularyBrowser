import test from "node:test";
import assert from "node:assert/strict";
import { attachMappingProvenance, parseMappingMetadata } from "../../browser/js/services/vocabularyParser.js";

const concept = (conceptId, vocabularyId, conceptCode, conceptName) => ({conceptId, vocabularyId, conceptCode, conceptName});

test("composite mappings preserve hyphens and spaces, validate source, and keep separate targets", () => {
  const concepts = [concept("100", "MY-VOC", " LAB-01 ", "Source name"), concept("200", "SNOMED", "11-22", "Target")];
  const relationships = [
    {conceptId1:"100", conceptId2:"200", relationshipId:"Maps to"},
    {conceptId1:"100", conceptId2:"300", relationshipId:"Maps to"},
  ];
  const source = {mappingSource0: {path:"P/Mapping/file.csv", text:
    'source_code,source_vocabulary_id,source_description,source_concept_id,relationship_id,target_concept_id, target_concept_code,target_vocabulary_id\n'
    + ' LAB-01 ,MY-VOC,Source name,0,Maps to,200,11-22,SNOMED\n'
    + ' LAB-01 ,MY-VOC,Source name,0,Maps to,300,T-2,UCUM\n'}};
  const evidence = new Map();
  attachMappingProvenance(source, concepts, relationships, {mappingEvidence:evidence});
  const result = parseMappingMetadata({path:"P/Ontology/mapping_metadata.csv",text:
    'mapping_concept_id,mapping_concept_code,confidence\n'
    + '999, LAB-01 || - ||MY-VOC|| - ||11-22|| - ||SNOMED,1\n'
    + '200, LAB-01 || - ||MY-VOC|| - ||T-2|| - ||UCUM,0.9\n'
    + '100, LAB-01 || - ||MY-VOC|| - ||T-3|| - ||UCUM,0.8\n'}, concepts, relationships, evidence);
  assert.deepEqual(result.rows.map((r) => [r.subjectConceptId,r.objectConceptId,r.associationStatus]), [
    ["100","200","relationship"], ["100","300","relationship"], ["100",null,"subject-only"],
  ]);
  assert.equal(result.rows[0].subjectCode, " LAB-01 ");
  assert.equal(result.rows[0].sourceIdentityEvidence.file,"P/Mapping/file.csv");
  assert.deepEqual(result.rows[1].targetIdentityEvidence,{file:"P/Mapping/file.csv",row:3,
    conceptId:"300",conceptCode:"T-2",vocabularyId:"UCUM"});
  assert.equal(result.rows[1].mapping_concept_id,"200");
  assert.equal(relationships[1].mappingMetadata.at(-1).mapping_concept_id,"200");
});

test("colliding padded mapping headers are rejected without inferring a target", () => {
  const concepts = [concept("100","V","A","Name")];
  const evidence = new Map();
  const warnings = attachMappingProvenance({mappingSource0:{path:"P/Mapping/ambiguous.csv",text:
    'source_code,source_vocabulary_id,source_description,source_concept_id,relationship_id,target_concept_id,target_concept_code, target_concept_code,target_vocabulary_id\n'
    + 'A,V,Name,100,Maps to,300,T,U,UCUM\n'}}, concepts, [], {mappingEvidence:evidence});
  assert.match(warnings.join(" "), /duplicate column names/);
  assert.equal(evidence.size,0);
});

test("composites require exactly four nonempty fields and never guess ambiguous sources or target IDs", () => {
  const concepts = [concept("100","V","A","Name"),concept("101","V","A","Name")];
  const evidence = new Map();
  attachMappingProvenance({mappingSource0:{path:"P/Mapping/file.csv",text:
    'source_code,source_vocabulary_id,source_description,source_concept_id,relationship_id,target_concept_id,target_concept_code,target_vocabulary_id\n'
    + 'A,V,Name,0,Maps to,300,T,UCUM\n'}}, concepts, [], {mappingEvidence:evidence});
  const result = parseMappingMetadata({path:"P/Ontology/mapping_metadata.csv", text:
    'mapping_concept_id,mapping_concept_code\n1,A|| - ||V|| - ||T|| - ||UCUM\n2,A|| - ||V|| - ||T\n3,A|| - ||V|| - || || - ||UCUM\n4,\n'}, concepts, [], evidence);
  assert.equal(result.rows[0].subjectConceptId, null);
  assert.equal(result.rows[0].objectConceptId, null);
  assert.deepEqual(result.rows.slice(1).map((row) => row.associationStatus), ["malformed-composite","malformed-composite","malformed-composite"]);
  assert.match(result.warnings.join(" "), /3 malformed composite/);
});

test("contradictory target IDs stay unresolved even when a source is uniquely identified", () => {
  const concepts = [concept("100","V","A","Name")];
  const evidence = new Map();
  attachMappingProvenance({mappingSource0:{path:"P/Mapping/file.csv",text:
    'source_code,source_vocabulary_id,source_description,source_concept_id,relationship_id,target_concept_id,target_concept_code,target_vocabulary_id\n'
    + 'A,V,Name,100,Maps to,300,T,UCUM\nA,V,Name,100,Maps to,301,T,UCUM\n'}}, concepts, [], {mappingEvidence:evidence});
  const result = parseMappingMetadata({path:"P/Ontology/mapping_metadata.csv",text:
    'mapping_concept_id,mapping_concept_code\n1,A|| - ||V|| - ||T|| - ||UCUM\n'}, concepts, [], evidence);
  assert.equal(result.rows[0].subjectConceptId,"100");
  assert.equal(result.rows[0].objectConceptId,null);
  assert.equal(result.rows[0].associationStatus,"subject-only");
});

test("conflicting source names, codes, and invalid IDs never attach metadata or enrich provenance", () => {
  const concepts = [concept("100","V","A","Correct"), concept("200","T","B","Target")];
  const evidence = new Map();
  attachMappingProvenance({mappingSource0:{path:"P/Mapping/e.csv", text:
    'source_code,source_vocabulary_id,source_description,source_concept_id\nA,V,Correct,100\n'}}, concepts, [], {mappingEvidence:evidence});
  const relationships = [{conceptId1:"100",conceptId2:"200",relationshipId:"Maps to"}];
  const result = parseMappingMetadata({path:"P/Ontology/m.csv", text:
    'mapping_concept_id,mapping_concept_code,source_concept_id,source_description,source_code,source_code_set\n'
    + '1,A|| - ||V|| - ||B|| - ||T,,Wrong,,ShouldNotAttach\n'
    + '2,A|| - ||V|| - ||B|| - ||T,not-an-id,,,ShouldNotAttach\n'
    + '3,A|| - ||V|| - ||B|| - ||T,100,Correct,Wrong,ShouldNotAttach\n'
    + '4,broken,100,Correct,A,ShouldNotAttach\n'}, concepts, relationships, evidence);
  assert.deepEqual(result.rows.map((row)=>row.subjectConceptId),[null,null,null,null]);
  assert.equal(result.rows[0].source_description,"Wrong");
  assert.equal(result.rows[1].source_concept_id,"not-an-id");
  assert.equal(result.rows[3].associationStatus,"malformed-composite");
  assert.equal(concepts[0].sourceSystems,undefined);
  assert.equal(relationships[0].mappingMetadata,undefined);
});

test("an explicit target ID cannot override a conflicting composite target code", () => {
  const concepts = [concept("100","V","A","Name"),concept("200","T","B","B"),concept("201","T","C","C")];
  const relations = [{conceptId1:"100",conceptId2:"200",relationshipId:"Maps to"}];
  const result = parseMappingMetadata({path:"P/m.csv",text:
    'mapping_concept_id,mapping_concept_code,source_concept_id,target_concept_id\n1,A|| - ||V|| - ||C|| - ||T,100,200\n'}, concepts, relations);
  assert.equal(result.rows[0].objectConceptId,null);
  assert.equal(relations[0].mappingMetadata,undefined);
});

test("all supplied source and target identifiers must agree in both composite paths", () => {
  const concepts = [concept("100","V","A","Name"),concept("200","T","B","Target")];
  const evidence = new Map();
  attachMappingProvenance({mappingSource0:{path:"P/Mapping/e.csv",text:
    'source_code,source_vocabulary_id,source_description,source_concept_id,relationship_id,target_concept_id,target_concept_code,target_vocabulary_id\nA,V,Name,100,Maps to,200,B,T\n'}}, concepts, [], {mappingEvidence:evidence});
  const rows = [
    '1,A|| - ||V|| - ||B|| - ||T,,999,,',
    '2,A|| - ||V|| - ||B|| - ||T,,not-an-id,,',
    '3,A|| - ||V|| - ||B|| - ||T,100,999,,',
    '4,A|| - ||V|| - ||B|| - ||T,100,not-an-id,,',
    '5,A|| - ||V|| - ||B|| - ||T,100,200,OMOP:999,',
    '6,A|| - ||V|| - ||B|| - ||T,100,200,V:WRONG,',
    '7,A|| - ||V|| - ||B|| - ||T,100,200,,garbage',
  ];
  for (const row of rows) {
    const relationships = [{conceptId1:"100",conceptId2:"200",relationshipId:"Maps to"}];
    const result = parseMappingMetadata({path:"P/m.csv",text:
      'mapping_concept_id,mapping_concept_code,source_concept_id,target_concept_id,subject_id,object_id\n'+row+'\n'}, concepts, relationships, evidence);
    assert.notEqual(result.rows[0].associationStatus,"relationship",row);
    assert.equal(relationships[0].mappingMetadata,undefined,row);
  }
});
