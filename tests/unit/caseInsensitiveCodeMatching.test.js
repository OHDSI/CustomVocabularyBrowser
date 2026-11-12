import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMappingProvenance, parseMappingMetadata } from '../../browser/js/services/vocabularyParser.js';
import { createLocalDirectorySource } from '../../browser/js/services/localDirectoryService.js';
import { VocabularyRepository } from '../../browser/js/services/dataService.js';
import { createConceptDetails, semanticRelationships, omopTarget } from '../../browser/js/ui/conceptDetails.js';
import { runQualityChecks } from '../../browser/js/services/reviewService.js';
import { conceptCodeKey, sameConceptCode } from '../../browser/js/model/codeMatching.js';

const concept = (id='2071500002', code='PSYWG10002', name='Abnormal Involuntary Movements Scale (AIMS)', vocabulary='PSYCHIATRY') => ({
  conceptId:id, conceptCode:code, conceptName:name, vocabularyId:vocabulary,
  domainId:'Measurement',conceptClassId:'Staging / Scales',standardConcept:null,invalidReason:null,
  validStartDate:'2025-04-01',validEndDate:'2099-12-31',
});
const header = 'source_code,source_vocabulary_id,source_concept_id,source_description,relationship_id,target_concept_id,target_vocabulary_id,target_concept_code';
const source = rows => ({mappingSource0:{path:'P/Mappings/m.csv',text:header+'\n'+rows+'\n'}});
const rel = (id='2071500002', target='4167594') => ({conceptId1:id,conceptId2:target,relationshipId:'Maps to'});
const file = (path,text) => ({name:path.split('/').at(-1),webkitRelativePath:path,text:async()=>text});
async function repositoryWith(concepts, relationships, mappings, metadata='') {
  const core = [
    file('ROOT/P/Ontology/concept.csv','concept_id,concept_name,domain_id,vocabulary_id,concept_class_id,standard_concept,concept_code,valid_start_date,valid_end_date,invalid_reason\n'+concepts.map(c=>[c.conceptId,c.conceptName,c.domainId,c.vocabularyId,c.conceptClassId,'',c.conceptCode,c.validStartDate,c.validEndDate,''].join(',')).join('\n')+'\n'),
    file('ROOT/P/Ontology/concept_synonym.csv','concept_id,concept_synonym_name,language_concept_id\n'),
    file('ROOT/P/Ontology/concept_relationship.csv','concept_id_1,concept_id_2,relationship_id,valid_start_date,valid_end_date,invalid_reason\n'+relationships.map(r=>[r.conceptId1,r.conceptId2,r.relationshipId,'2025-04-01','2099-12-31',''].join(',')).join('\n')+'\n'),
    file('ROOT/P/Mappings/m.csv',header+'\n'+mappings+'\n'),
  ];
  if(metadata) core.push(file('ROOT/P/Ontology/mapping_metadata.csv',metadata));
  const {source,manifest}=await createLocalDirectorySource(core);
  return new VocabularyRepository({source,manifest,fetchImpl:async()=>{throw new Error('Local regression must not access network');}});
}
class FakeNode {
  constructor(tag){this.tagName=tag;this.childNodes=[];this.textContent='';this.open=false;}
  append(...nodes){this.childNodes.push(...nodes);}
  replaceChildren(...nodes){this.childNodes=nodes;}
  setAttribute(name,value){this[name]=value;}
  addEventListener(){}
  showModal(){this.open=true;}
}
const descendants=n=>[n,...n.childNodes.flatMap(descendants)];

test('reported AIMS case survives parsing, runtime safeguards and Athena link rendering', async()=>{
  const repo=await repositoryWith([concept()],[rel()],'PsyWG10002,PSYCHIATRY,0,Abnormal Involuntary Movements Scale (AIMS),Maps to,4167594,SNOMED,');
  const details=await repo.loadConceptDetails('P','2071500002');
  assert.equal(details.concept.conceptCode,'PSYWG10002');
  assert.equal(details.outgoing[0].mappingMetadata[0].source_code,'PsyWG10002');
  const target=omopTarget(semanticRelationships(details)[0]);
  assert.equal(target?.conceptId,'4167594');assert.equal(target.sourceDeclared,true);
  const oldDocument=globalThis.document,oldLocation=globalThis.location;
  const nodes={'concept-dialog':new FakeNode('dialog'),'concept-dialog-title':new FakeNode('h2'),'concept-dialog-content':new FakeNode('div')};
  try {
    globalThis.document={getElementById:id=>nodes[id],createElement:tag=>new FakeNode(tag)};
    globalThis.location={href:'http://127.0.0.1/'};
    createConceptDetails({onClose(){},onSelectRelated(){}}).showDetails(details);
    const links=descendants(nodes['concept-dialog-content']).filter(n=>n.tagName==='a');
    assert.ok(links.some(n=>n.href==='https://athena.ohdsi.org/search-terms/terms/4167594'));
  } finally {globalThis.document=oldDocument;globalThis.location=oldLocation;}
});

test('case-only source collisions stay ambiguous even for exact spelling, unless explicit ID agrees',()=>{
  for(const code of ['PSYWG10002','psywg10002','PsyWG10002']) {
    const concepts=[concept(),concept('2071500003','psywg10002')], rows=[rel()];
    attachMappingProvenance(source(`${code},PSYCHIATRY,0,Abnormal Involuntary Movements Scale (AIMS),Maps to,4167594,SNOMED,`),concepts,rows);
    assert.equal(rows[0].otherConceptOmop,undefined);
  }
  const rows=[rel()];
  attachMappingProvenance(source('psywg10002,PSYCHIATRY,2071500002,Abnormal Involuntary Movements Scale (AIMS),Maps to,4167594,SNOMED,'),[concept(),concept('2071500003','psywg10002')],rows);
  assert.equal(rows[0].otherConceptOmop?.conceptId,'4167594');
});

test('case-insensitive joins retain source-name, vocabulary, ID and sentinel safeguards',()=>{
  for(const row of [
    'psywg10002,OTHER,0,Abnormal Involuntary Movements Scale (AIMS),Maps to,4167594,SNOMED,',
    'psywg10002,PSYCHIATRY,0,Wrong name,Maps to,4167594,SNOMED,',
    'psywg10002,PSYCHIATRY,999,Abnormal Involuntary Movements Scale (AIMS),Maps to,4167594,SNOMED,',
    'psywg10002,PSYCHIATRY,0,Abnormal Involuntary Movements Scale (AIMS),Maps to,0,SNOMED,',
  ]) {const rows=[rel()];attachMappingProvenance(source(row),[concept()],rows);assert.equal(rows[0].otherConceptOmop,undefined,row);}
});

test('composite evidence and runtime target checks share case-insensitive codes without making local targets Athena concepts',async()=>{
  const repo=await repositoryWith([concept(),concept('300','TARGET-Ab','Local target','TARGET')],[rel('2071500002','300')],
    'PsyWG10002,PSYCHIATRY,0,Abnormal Involuntary Movements Scale (AIMS),Maps to,300,TARGET,target-aB',
    'mapping_concept_id,mapping_concept_code,source_code,target_code\n1,pSyWg10002|| - ||PSYCHIATRY|| - ||Target-AB|| - ||TARGET,PSYWG10002,TARGET-ab\n');
  const details=await repo.loadConceptDetails('P','2071500002');
  assert.ok(details.outgoing[0].mappingMetadata.some(m=>m.mapping_concept_id==='1'));
  assert.equal(details.outgoing[0].otherConcept.conceptCode,'TARGET-Ab');
  assert.equal(omopTarget(semanticRelationships(details)[0]),null);
});

test('SSSOM source and target codes match case-insensitively with source labels preserved',()=>{
  const concepts=[concept('100','SOURCE-Ab','Source','SRC'),concept('200','TARGET-Ab','Target','TGT')], rows=[rel('100','200')];
  const result=parseMappingMetadata({path:'P/m.csv',text:'subject_id,subject_label,object_id,object_label,source_code,target_code\nSRC:source-aB,Source,TGT:target-aB,Target,SOURCE-AB,TARGET-AB\n'},concepts,rows);
  assert.equal(result.rows[0].associationStatus,'relationship');
  assert.equal(result.rows[0].subjectCode,'source-aB');
  assert.equal(result.rows[0].objectCode,'target-aB');
  assert.equal(concepts[0].conceptCode,'SOURCE-Ab');
});

test('case-insensitive duplicate-code checks remain scoped to vocabulary and package',()=>{
  const first={...concept('100','AbC','Name','V'),packageId:'P'},second={...concept('101','abc','Name','V'),packageId:'P'};
  const report=rows=>runQualityChecks({selectedPackageId:'P',dataset:{entry:{packageId:'P'},concepts:rows}});
  assert.ok(report([first,second]).findings.some(f=>f.code==='duplicate-code'));
  assert.equal(report([first,{...second,packageId:'Q'}]).findings.some(f=>f.code==='duplicate-code'),false);
  assert.equal(report([first,{...second,vocabularyId:'OTHER'}]).findings.some(f=>f.code==='duplicate-code'),false);
});

test('code matching preserves whitespace, punctuation, leading zeroes and exact vocabulary identifiers',()=>{
  assert.equal(sameConceptCode('Ab-C','aB-c'),true);
  for(const other of ['ABC',' Ab-C','Ab-C ','00Ab-C']) assert.equal(sameConceptCode('Ab-C',other),false);
  assert.notEqual(conceptCodeKey('V','AbC'),conceptCodeKey('v','abc'));
});


test('case-only codes are also rejected as duplicate concept drafts', async()=>{
  const {validateConceptDraft}=await import('../../browser/js/services/conceptDraftValidation.js');
  const draft={vocabulary_id:'CUSTOM',source_code_set:'Source',concept_name:'New name',concept_code:'AbC',domain_id:'Observation',concept_class_id:'Clinical Finding',standard_concept:'S',valid_start_date:'2026-11-05',valid_end_date:'2099-12-31'};
  const result=validateConceptDraft(draft,{customConcepts:[{vocabularyId:'CUSTOM',conceptCode:'aBc',conceptName:'Existing name'}]});
  assert.ok(result.errors.some(e=>/code already exists/i.test(e)));
  assert.equal(result.record.concept_code,'AbC');
});

test('additional verified mapping records deduplicate code-case variants',async()=>{
  const {additionalMappingRecords}=await import('../../browser/js/ui/conceptDetails.js');
  const base={targetIdentityVerified:true,associationStatus:'subject-only',objectConceptId:'300',objectVocabulary:'TARGET',relationship_id:'Maps to'};
  const records=[{...base,objectCode:'Target-Ab'},{...base,objectCode:'target-aB'}];
  assert.equal(additionalMappingRecords({concept:{conceptId:'100',mappingMetadata:records}}).length,1);
  assert.equal(additionalMappingRecords({concept:{conceptId:'100',mappingMetadata:[{...base,objectConceptId:null,objectCode:'target-ab'}]},outgoing:[{conceptId1:'100',conceptId2:'300',relationshipId:'Maps to',otherConcept:{conceptId:'300',conceptCode:'TARGET-Ab',vocabularyId:'TARGET'}}]}).length,0);
});
