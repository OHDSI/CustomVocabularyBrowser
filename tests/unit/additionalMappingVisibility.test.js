import test from "node:test";
import assert from "node:assert/strict";
import { createConceptDetails, additionalMappingRecords } from "../../browser/js/ui/conceptDetails.js";

class FakeNode {
  constructor(tag) { this.tagName = tag; this.childNodes = []; this.textContent = ""; this.open = false; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener() {}
  showModal() { this.open = true; }
}
const textIn = (node) => [node.textContent, ...node.childNodes.map(textIn)].join(" ");

test("additional mapping section is hidden while original records and other relationships remain", () => {
  const oldDocument = globalThis.document, oldLocation = globalThis.location;
  const nodes = { "concept-dialog": new FakeNode("dialog"), "concept-dialog-title": new FakeNode("h2"), "concept-dialog-content": new FakeNode("div") };
  globalThis.document = { getElementById: (id) => nodes[id], createElement: (tag) => new FakeNode(tag) };
  globalThis.location = { href: "http://127.0.0.1/" };
  const record = { subjectConceptId: "1", objectCode: "218", predicate_id: "skos:broadMatch", targetIdentityVerified: false };
  const fixture = { concept: { conceptId: "1", conceptName: "Example", mappingMetadata: [record] },
    outgoing: [{ conceptId1: "1", conceptId2: "2", relationshipId: "Maps to", otherConcept: { conceptId: "2", conceptName: "Related concept" } }] };
  try {
    assert.equal(additionalMappingRecords(fixture).length, 1);
    createConceptDetails({ onClose() {}, onSelectRelated() {} }).showDetails(fixture);
    const text = textIn(nodes["concept-dialog-content"]);
    assert.doesNotMatch(text, /Additional mapping records/);
    assert.match(text, /Hierarchy/);
    assert.match(text, /Relationships \(1\)/);
    assert.match(text, /Related concept/);
    assert.deepEqual(fixture.concept.mappingMetadata, [record]);
  } finally { globalThis.document = oldDocument; globalThis.location = oldLocation; }
});
