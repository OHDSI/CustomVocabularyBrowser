import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMappingProvenance } from '../../browser/js/services/vocabularyParser.js';
import { discoverTableFiles, discoverMappingFiles } from '../../browser/js/services/manifestService.js';
import { discoverLocalPackages } from '../../browser/js/services/localDirectoryService.js';

const concept = (id = '100', vocabulary = 'CUSTOM', code = 'A') => ({conceptId: id, vocabularyId: vocabulary, conceptCode: code, conceptName: 'Alpha'});
const source = (rows) => ({mappingSource0: {path: 'CUSTOM/Mappings/custom.csv', text:
  'source_code_set,source_category,source_code,source_vocabulary_id,source_concept_id,source_description\n'+rows}});

test('mapping provenance uses exact code and vocabulary with optional agreeing ID', () => {
  const concepts = [concept(), concept('101', 'OTHER')];
  const warnings = attachMappingProvenance(source('System,Category,A,CUSTOM,100,Alpha\nSystem,Category,A,CUSTOM,100,Alpha\nOther system,Other category,A,OTHER,0,Alpha'), concepts);
  assert.deepEqual(warnings, []);
  assert.deepEqual(concepts[0].sourceSystems, ['System']);
  assert.deepEqual(concepts[0].sourceCategories, ['Category']);
  assert.equal(concepts[0].sourceProvenance.length, 1);
  assert.equal(concepts[0].sourceProvenance[0].row, 2);
  assert.deepEqual(concepts[1].sourceSystems, ['Other system']);
});

test('provenance never guesses across conflicting IDs or duplicated source codes', () => {
  const concepts = [concept(), concept('101')];
  const warnings = attachMappingProvenance(source('System,Category,A,CUSTOM,999,Alpha\nSystem,Category,A,CUSTOM,0,Alpha'), concepts);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 source provenance row/);
  assert.equal(concepts[0].sourceSystems, undefined);
  assert.equal(concepts[1].sourceSystems, undefined);
});

test('provenance is optional and malformed supplemental data does not disable core concepts', () => {
  const concepts = [concept()];
  assert.deepEqual(attachMappingProvenance({mappingSource0:{path:'no-fields.csv',text:'source_code,source_vocabulary_id\nA,CUSTOM'}}, concepts), []);
  const warnings = attachMappingProvenance({mappingSource0:{path:'bad.csv',text:'source_code_set\nSystem'}}, concepts);
  assert.match(warnings[0], /requires source_concept_id or source_code/);
  assert.equal(concepts[0].sourceSystems, undefined);
});

test('mapping discovery remains package-scoped and supports singular and plural folder names', () => {
  const paths = new Set(['A/Ontology/concept.csv','A/Mapping/a.csv','A/Mappings/b.csv','B/Mappings/b.csv','A/Other/c.csv']);
  assert.deepEqual(discoverMappingFiles('A/Ontology', paths), ['A/Mapping/a.csv','A/Mappings/b.csv']);
  const discovered = discoverTableFiles('A/Ontology',paths);
  assert.equal(discovered.files.mappingSource0, 'A/Mapping/a.csv');
  assert.equal(discovered.files.mappingSource1, 'A/Mappings/b.csv');
  assert.equal(discovered.files.concept, 'A/Ontology/concept.csv');
});

test('local folder discovery associates sibling mappings with their ontology package', () => {
  const files = new Map(['A/Ontology/concept.csv','A/Ontology/concept_synonym.csv','A/Ontology/concept_relationship.csv','A/Mappings/source.csv','B/Mappings/source.csv'].map((p)=>[p,{}]));
  const packages = discoverLocalPackages('root', files);
  assert.equal(packages.length,1);
  assert.equal(packages[0].files.mappingSource0,'A/Mappings/source.csv');
  assert.equal(packages[0].browseable,true);
});

const mappingSource = (rows) => ({mappingSource0: {path: 'CUSTOM/Mappings/custom.csv', text:
  'source_code,source_vocabulary_id,source_concept_id,relationship_id,target_concept_id,target_vocabulary_id,target_concept_name,predicate_id,confidence,author_name,reviewer_name,review_date\n'+rows}});
const relationship = (target = '999') => ({conceptId1:'100', conceptId2:target, relationshipId:'Maps to'});

test('builder target fields establish source-declared external OMOP provenance on exact relationship match', () => {
  const rows = [relationship()];
  attachMappingProvenance(mappingSource('A,CUSTOM,100,Maps to,999,SNOMED,Target,skos:exactMatch,1,Author,Reviewer,2026-01-02'),[concept()],rows);
  assert.deepEqual(rows[0].otherConceptOmop, {conceptId:'999',vocabularyId:'SNOMED',conceptName:'Target',provenance:{file:'CUSTOM/Mappings/custom.csv',row:2},sourceDeclared:true});
  assert.equal(rows[0].mappingMetadata[0].author_label,'Author');
  assert.equal(rows[0].mappingMetadata[0].reviewer_label,'Reviewer');
  assert.equal(rows[0].mappingMetadata[0].review_date,'2026-01-02');
  assert.equal(rows[0].mappingMetadata[0].publication_date,undefined);
});

test('builder provenance does not guess through mismatches, invalid targets or duplicate relationships', () => {
  for (const row of [
    'A,CUSTOM,777,Maps to,999,SNOMED,Target,,,,,',
    'A,OTHER,100,Maps to,999,SNOMED,Target,,,,,',
    'A,CUSTOM,100,Is a,999,SNOMED,Target,,,,,',
    'A,CUSTOM,100,Maps to,0,SNOMED,Target,,,,,',
    'A,CUSTOM,100,Maps to,999,,Target,,,,,',
  ]) {
    const rows=[relationship()];attachMappingProvenance(mappingSource(row),[concept()],rows);
    assert.equal(rows[0].otherConceptOmop,undefined);
  }
  const duplicated=[relationship(),relationship()];
  attachMappingProvenance(mappingSource('A,CUSTOM,100,Maps to,999,SNOMED,Target,,,,,'),[concept()],duplicated);
  assert.equal(duplicated[0].otherConceptOmop,undefined);
});

test('builder target provenance preserves local concepts and does not relabel them external', () => {
  const rows=[relationship()];
  attachMappingProvenance(mappingSource('A,CUSTOM,100,Maps to,999,LOCAL,Target,,,,,'),[concept(),concept('999','LOCAL','T')],rows);
  assert.equal(rows[0].otherConceptOmop,undefined);
  assert.equal(rows[0].mappingMetadata[0].objectConceptId,'999');
});

test('conflicting explicit target vocabulary declarations do not choose one silently', () => {
  const rows=[relationship()];
  attachMappingProvenance(mappingSource('A,CUSTOM,100,Maps to,999,SNOMED,Target,,,,,\nA,CUSTOM,100,Maps to,999,LOINC,Target,,,,,'),[concept()],rows);
  assert.equal(rows[0].otherConceptOmop,undefined);
  assert.equal(rows[0].omopTargetConflict,true);
  assert.equal(rows[0].mappingMetadata.length,2);
});

test('fallback uses both source code and name, refuses ambiguous or mismatching source identity', () => {
  const rows = [concept(), {...concept('101', 'CUSTOM', 'A'), conceptName: 'Beta'}];
  const csv = {mappingSource0: {path: 'P/Mapping/m.csv', text:
    'source_code,source_description,source_code_set,source_concept_id\nA,Alpha,yes,0\nA,Wrong,no,0\nA,Beta,no,100\n'}};
  attachMappingProvenance(csv, rows);
  assert.deepEqual(rows[0].sourceSystems, ['yes']);
  assert.equal(rows[1].sourceSystems, undefined);
  const ambiguous = [concept(), concept('102')];
  attachMappingProvenance(csv, ambiguous);
  assert.equal(ambiguous[0].sourceSystems, undefined);
});

test('package mapping adds explicit synonym and hierarchy only when core data is absent', () => {
  const rows = [concept(), concept('101', 'CUSTOM', 'B')];
  const mapping = {mappingSource0: {path:'P/Mapping/m.csv', text:
    'source_code,source_description,source_description_synonym,relationship_id,target_concept_id,target_vocabulary_id\nA,Alpha,Alternate,Is a,101,CUSTOM\n'}};
  const relationships = [];
  const synonyms = [];
  attachMappingProvenance(mapping, rows, relationships, {synonyms});
  assert.equal(synonyms[0].conceptSynonymName, 'Alternate');
  assert.equal(synonyms[0].languageConceptId, null);
  assert.deepEqual(relationships.map((r) => [r.conceptId1, r.relationshipId, r.conceptId2]), [['100', 'Is a', '101']]);
  const coreSynonyms = [{conceptId:'100', conceptSynonymName:'Core', languageConceptId:'1'}];
  const coreRelationships = [{conceptId1:'100', conceptId2:'200', relationshipId:'Is a'}];
  attachMappingProvenance(mapping, rows, coreRelationships, {synonyms:coreSynonyms});
  assert.equal(coreSynonyms.length, 1);
  assert.equal(coreRelationships.length, 1);
});
