import test from "node:test";
import assert from "node:assert/strict";
import { semanticRelationships, directHierarchy, hierarchyInverseRecords, omopTarget, mappingMetadataFields, additionalMappingRecords } from "../../browser/js/ui/conceptDetails.js";

const relationship = (relationshipId, conceptId1 = "1", conceptId2 = "2", extra = {}) => ({ relationshipId, conceptId1, conceptId2, ...extra });

test("relationships use semantic reverse labels while preserving supplied direction", () => {
  const details = {
    outgoing: [relationship("Maps to")],
    incoming: [relationship("Maps to", "3", "1"), relationship("Has attribute", "4", "1")],
  };
  const rows = semanticRelationships(details);
  assert.deepEqual(rows.map((row) => row.label), ["Maps to", "Mapped from", "Has attribute (incoming)"]);
  assert.equal(rows[1].otherId, "3");
  assert.equal(rows[1].conceptId1, "3");
  assert.equal(rows[1].conceptId2, "1");
});

test("mirrored duplicates keep richest metadata but preserve distinct semantic relationship types", () => {
  const details = {
    outgoing: [relationship("Maps to", "1", "2", { mappingMetadata: [{ confidence: "1", author_label: "Author" }] }),
      relationship("Is a", "1", "2")],
    incoming: [relationship("Mapped from", "2", "1")],
  };
  const rows = semanticRelationships(details);
  assert.deepEqual(rows.map((row) => row.label), ["Maps to", "Is a"]);
  assert.equal(rows[0].mappingMetadata[0].author_label, "Author");
});

test("additional mapping records suppress proven duplicate targets, retain unverified codes", () => {
  const details = { concept: { mappingMetadata: [
    { associationStatus: "subject-only", objectConceptId: "2", targetIdentityVerified:true },
    { associationStatus: "subject-only", objectCode: "OTHER", objectVocabulary: "UCUM", targetIdentityVerified:true },
  ] }, outgoing: [relationship("Maps to", "1", "2")] };
  assert.deepEqual(additionalMappingRecords(details), [details.concept.mappingMetadata[1]]);
});

test("unverified stale relationship metadata remains visible as an additional record", () => {
  const record = {associationStatus:"relationship",sourceFile:"P/mapping_metadata.csv",sourceRow:2,
    objectConceptId:"2",targetIdentityVerified:false,predicate_id:"skos:broadMatch"};
  const details = {concept:{conceptId:"1",mappingMetadata:[record]},outgoing:[relationship("Maps to","1","2")]};
  assert.equal(semanticRelationships(details).length,1);
  assert.equal(directHierarchy(details).parents.length,0);
  assert.equal(additionalMappingRecords(details).length,1);
  assert.equal(additionalMappingRecords(details)[0].associationStatus,"target-unverified");
});

test("provided relationship definitions resolve otherwise unknown reverse labels", () => {
  const rows = semanticRelationships({ incoming: [relationship("Has attribute")], metadata: {
    relationship: [{ relationship_id: "Has attribute", reverse_relationship_id: "Attribute of" }],
  } });
  assert.equal(rows[0].label, "Attribute of");
});

test("direct hierarchy includes multiple parents and relationship fallback, excludes transitive and inactive edges", () => {
  const details = {
    concept: { conceptId: "1" },
    ancestors: [
      { ancestorConceptId: "1", minLevelsOfSeparation: 0 },
      { ancestorConceptId: "2", minLevelsOfSeparation: 1 },
      { ancestorConceptId: "3", minLevelsOfSeparation: 2 },
    ],
    outgoing: [relationship("Is a", "1", "2"), relationship("Is a", "1", "4"), relationship("Is a", "1", "5", { invalidReason: "D" })],
    incoming: [relationship("Is a", "6", "1"), relationship("Subsumes", "7", "1")],
  };
  const hierarchy = directHierarchy(details);
  assert.deepEqual(hierarchy.parents.map((row) => row.id), ["2", "4", "7"]);
  assert.deepEqual(hierarchy.children.map((row) => row.id), ["6"]);
});

test("GIS broadMatch and narrowMatch metadata give parent and child with source evidence, without duplicate additional records", () => {
  const broad = {mapping_concept_id:"19814",sourceFile:"GIS/Ontology/mapping_metadata.csv",sourceRow:4,
    subjectConceptId:"2052496110",objectConceptId:"2052492165",predicate_id:"skos:broadMatch",
    associationStatus:"subject-only",targetIdentityVerified:true,otherConcept:{conceptId:"2052492165",conceptName:"Target"}};
  const narrow = {mapping_concept_id:"19788",sourceFile:"GIS/Ontology/mapping_metadata.csv",sourceRow:1377,
    subjectConceptId:"2052499499",objectConceptId:"2052497951",predicate_id:"skos:narrowMatch",
    associationStatus:"subject-only",targetIdentityVerified:true,otherConcept:{conceptId:"2052497951",conceptName:"Target"}};
  const broadDetails = {concept:{conceptId:broad.subjectConceptId,mappingMetadata:[broad]}};
  const narrowDetails = {concept:{conceptId:narrow.subjectConceptId,mappingMetadata:[narrow]}};
  const broadResult = directHierarchy(broadDetails);
  const narrowResult = directHierarchy(narrowDetails);
  assert.deepEqual(broadResult.parents.map((x)=>x.id),["2052492165"]);
  assert.deepEqual(narrowResult.children.map((x)=>x.id),["2052497951"]);
  assert.equal(broadResult.parents[0].hierarchyMetadata[0],broad);
  assert.equal(narrowResult.children[0].hierarchyMetadata[0],narrow);
  assert.deepEqual(additionalMappingRecords(broadDetails),[]);
  assert.deepEqual(additionalMappingRecords(narrowDetails),[]);
  assert.deepEqual(directHierarchy({concept:{conceptId:broad.objectConceptId},incomingMappingMetadata:[broad]}).children.map(x=>x.id),[broad.subjectConceptId]);
  assert.deepEqual(directHierarchy({concept:{conceptId:narrow.objectConceptId},incomingMappingMetadata:[narrow]}).parents.map(x=>x.id),[narrow.subjectConceptId]);
});

test("hierarchy metadata keeps distinct predicates, refuses unresolved or unrelated records, and merges existing nodes", () => {
  const broad = {subjectConceptId:"1",objectConceptId:"2",predicate_id:"skos:broadMatch",sourceRow:2,targetIdentityVerified:true};
  const narrow = {subjectConceptId:"1",objectConceptId:"2",predicate_id:"skos:narrowMatch",sourceRow:3,targetIdentityVerified:true};
  const details = {concept:{conceptId:"1",mappingMetadata:[broad,narrow,
    {subjectConceptId:"1",objectConceptId:null,predicate_id:"skos:broadMatch"},
    {subjectConceptId:"1",objectConceptId:"3",predicate_id:"skos:exactMatch"},
    {subjectConceptId:"9",objectConceptId:"3",predicate_id:"skos:broadMatch"}]},
    ancestors:[{ancestorConceptId:"2",minLevelsOfSeparation:1}]};
  const hierarchy = directHierarchy(details);
  assert.deepEqual(hierarchy.parents.map(x=>x.id),["2"]);
  assert.deepEqual(hierarchy.children.map(x=>x.id),["2"]);
  assert.deepEqual(hierarchy.parents[0].hierarchyMetadata,[broad]);
  assert.deepEqual(hierarchy.children[0].hierarchyMetadata,[narrow]);
});

test("numeric identifiers and local standard concepts never imply Athena membership", () => {
  assert.equal(omopTarget({ otherId: "123", otherConcept: { conceptId: "123", standardConcept: "S", vocabularyId: "Custom" } }), null);
  assert.equal(omopTarget({ direction: "outgoing", otherId: "123", mappingMetadata: [{ object_id: "SNOMED:123" }] }), null);
  assert.equal(omopTarget({ direction: "outgoing", otherId: "123", mappingMetadata: [{ object_id: "OMOP:456" }] }), null);
});

test("only explicit matching OMOP identifiers link to Athena, respecting direction", () => {
  assert.deepEqual(omopTarget({ direction: "outgoing", otherId: "123", mappingMetadata: [{ object_id: "OMOP:123", object_source: "SNOMED" }] }), {
    conceptId: "123", vocabularyId: "SNOMED",
  });
  assert.deepEqual(omopTarget({ direction: "incoming", otherId: "456", mappingMetadata: [{ subject_id: "OMOP:456", subject_source: "LOINC", object_id: "OMOP:123" }] }), {
    conceptId: "456", vocabularyId: "LOINC",
  });
});

test("metadata preserves zero confidence and distinguishes derived publication from mapping dates", () => {
  assert.deepEqual(mappingMetadataFields({ predicate_id: "skos:exactMatch", confidence: 0, author_id: "A", reviewer_id: "R", publication_date: "2026-01-01", publication_date_derived: true, mapping_date: "2025-12-01" }), [
    ["Predicate ID", "skos:exactMatch"], ["Confidence", 0], ["Author", "A"], ["Reviewer", "R"],
    ["Publication date (derived)", "2026-01-01"], ["Mapping date", "2025-12-01"],
  ]);
  assert.deepEqual(mappingMetadataFields({ mapping_date: "2026-01-01" }), [["Mapping date", "2026-01-01"]]);
});

test("source review status and decision are shown without interpretation", () => {
  assert.deepEqual(mappingMetadataFields({status:"Under validation",decision:"0"}), [
    ["Source review status","Under validation"],["Source decision","0"],
  ]);
});

test("malicious or ambiguous namespaces cannot produce an Athena link", () => {
  for (const object_id of ["javascript:alert(1)", "OMOP:123/../../evil", "OMOP:123?redirect=https://evil.test", "OMOP:123#fragment", "https://evil.test/OMOP:123", "OMOP:<img src=x onerror=alert(1)>", " OMOP:123", "OMOP:0", "OMOP:-1"]) {
    assert.equal(omopTarget({ direction: "outgoing", otherId: "123", mappingMetadata: [{ object_id }] }), null, object_id);
  }
  assert.equal(omopTarget({ direction: "outgoing", otherId: "123", otherConceptOmop: { conceptId: "123?x=1" } }), null);
  assert.equal(omopTarget({ direction: "outgoing", otherId: "123", mappingMetadata: [{ mapping_concept_id: "123" }] }), null);
});

test("raw metadata remains inert text and false derived flags do not change the date label", () => {
  const script = '<img src=x onerror="alert(1)">';
  assert.deepEqual(mappingMetadataFields({ author_id: script, publication_date: "2026-01-01", publication_date_derived: "false" }), [
    ["Author", script], ["Publication date", "2026-01-01"],
  ]);
  assert.equal(semanticRelationships({ incoming: [relationship(script)] })[0].label, `${script} (incoming)`);
});


test("GIS Element Relevant To Health Care keeps reciprocal source predicates out of the wrong hierarchy column", () => {
  const current = "2052499516";
  const parent = "2052499518";
  const child = "2052499945";
  const metadata = (id, row, source, target, predicate) => ({
    mapping_concept_id: id, sourceFile: "GIS/Ontology/mapping_metadata.csv", sourceRow: row,
    subjectConceptId: source, objectConceptId: target, predicate_id: predicate,
    targetIdentityVerified: true, associationStatus: "subject-only",
  });
  // Actual reciprocal rows from the GIS source: 610 <-> GIS1001136, 610 <-> 220.
  const directParent = metadata("89431", 69402, current, parent, "skos:broadMatch");
  const inverseParent = metadata("123790", 103595, parent, current, "skos:narrowMatch");
  const directChild = metadata("89402", 69309, current, child, "skos:narrowMatch");
  const inverseChild = metadata("55520", 35606, child, current, "skos:broadMatch");
  const details = {
    concept: { conceptId: current, mappingMetadata: [directParent, directChild] },
    incomingMappingMetadata: [inverseParent, inverseChild],
    outgoing: [relationship("Is a", current, parent), relationship("Subsumes", current, child)],
  };
  const hierarchy = directHierarchy(details);
  assert.deepEqual(hierarchy.parents.map(row => row.id), [parent]);
  assert.deepEqual(hierarchy.children.map(row => row.id), [child]);
  assert.deepEqual(hierarchy.parents[0].hierarchyMetadata, [directParent]);
  assert.deepEqual(hierarchy.children[0].hierarchyMetadata, [directChild]);
  assert.deepEqual(hierarchy.parents[0].hierarchyInverseMetadata, [inverseParent]);
  assert.deepEqual(hierarchy.children[0].hierarchyInverseMetadata, [inverseChild]);
  assert.deepEqual(hierarchyInverseRecords(hierarchy), [inverseParent, inverseChild]);
  assert.deepEqual(additionalMappingRecords(details), []);
});

test("inverse-only hierarchy evidence remains available in its original direction without a misleading displayed predicate", () => {
  const inverseNarrow = {subjectConceptId:"2", objectConceptId:"1", predicate_id:"skos:narrowMatch",
    sourceFile:"P/mapping_metadata.csv", sourceRow:12, targetIdentityVerified:true};
  const inverseBroad = {subjectConceptId:"3", objectConceptId:"1", predicate_id:"skos:broadMatch",
    sourceFile:"P/mapping_metadata.csv", sourceRow:13, targetIdentityVerified:true};
  const hierarchy = directHierarchy({concept:{conceptId:"1"},incomingMappingMetadata:[inverseNarrow, inverseBroad]});
  assert.equal(hierarchy.parents[0].id, "2");
  assert.equal(hierarchy.children[0].id, "3");
  assert.equal(hierarchy.parents[0].hierarchyMetadata, undefined);
  assert.equal(hierarchy.children[0].hierarchyMetadata, undefined);
  assert.deepEqual(hierarchyInverseRecords(hierarchy), [inverseNarrow, inverseBroad]);
  assert.equal(hierarchyInverseRecords(hierarchy)[0].predicate_id, "skos:narrowMatch");
  assert.equal(hierarchyInverseRecords(hierarchy)[1].predicate_id, "skos:broadMatch");
});
