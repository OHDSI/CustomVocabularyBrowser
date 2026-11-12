import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { issueDraftForSource } from "../../browser/js/ui/reviewWorkspace.js";
import { createConceptDetails } from "../../browser/js/ui/conceptDetails.js";
import { assertPublicBuildDestination, parseArguments } from "../../scripts/build-browser-data.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("private local drafts do not construct GitHub URLs; public drafts still do", () => {
  const draft = { kind: "concept", status: "draft-not-submitted", record: { concept_name: "PRIVATE-TEST-NAME" }, metadata: {} };
  assert.equal(issueDraftForSource(draft, { provider: "local-directory" }, "OHDSI/CustomVocabularyBrowser"), null);
  assert.match(issueDraftForSource(draft, { provider: "github" }, "OHDSI/CustomVocabularyBrowser").url, /^https:\/\/github\.com\//);
});

class Node {
  constructor(tag) { this.tagName = tag; this.childNodes = []; this.textContent = ""; this.open = false; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener() {}
  showModal() { this.open = true; }
}
const nodesOf = (node) => [node, ...node.childNodes.flatMap(nodesOf)];

test("explicit OMOP references can link to Athena in local and public views without exposing local share links", () => {
  const oldDocument = globalThis.document, oldLocation = globalThis.location;
  const elements = { "concept-dialog": new Node("dialog"), "concept-dialog-title": new Node("h2"), "concept-dialog-content": new Node("div") };
  globalThis.document = { getElementById: (id) => elements[id], createElement: (tag) => new Node(tag) };
  globalThis.location = { href: "http://localhost/" };
  const details = { concept: { conceptId: "1", conceptName: "Private" }, outgoing: [
    { conceptId1: "1", conceptId2: "123", relationshipId: "Maps to", otherConceptOmop: { conceptId: "123", vocabularyId: "LOINC" } },
    { conceptId1: "1", conceptId2: "456", relationshipId: "Maps to", otherConcept: { conceptId: "456", vocabularyId: "CUSTOM", standardConcept: "S" } },
  ] };
  try {
    for (const [provider, expectCopyLink] of [["local-directory", false], ["github", true]]) {
      createConceptDetails({ onClose() {}, onSelectRelated() {}, getState: () => ({ source: { provider } }) }).showDetails(details);
      const nodes = nodesOf(elements["concept-dialog-content"]);
      const links = nodes.filter((node) => node.tagName === "a" && String(node.href).startsWith("https://athena.ohdsi.org/"));
      assert.equal(links.length, 1);
      assert.equal(links[0].href, "https://athena.ohdsi.org/search-terms/terms/123");
      assert.equal(nodes.some((node) => node.textContent === "Copy concept link"), expectCopyLink);
    }
  } finally { globalThis.document = oldDocument; globalThis.location = oldLocation; }
});

test("in-project generated data is rejected even with the legacy public-source flag", async () => {
  await assert.rejects(assertPublicBuildDestination(path.join(projectRoot, "browser", "data"), undefined), /--public-source/);
  await assert.rejects(assertPublicBuildDestination(path.join(projectRoot, "browser", "data"), true), /outside the browser project/);
  await assert.doesNotReject(assertPublicBuildDestination(path.resolve(projectRoot, "..", "outside"), undefined));
  assert.equal(parseArguments(["--source", "source", "--public-source"]).publicSource, true);
});

test("junction or symlink aliases cannot disguise an in-project output", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cvb-private-path-test-"));
  try {
    const alias = path.join(temporary, "alias");
    try { await symlink(projectRoot, alias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip("Symlink creation is unavailable here");
      throw error;
    }
    await assert.rejects(assertPublicBuildDestination(path.join(alias, "new-folder", "data"), undefined), /--public-source/);
    await assert.rejects(assertPublicBuildDestination(path.join(alias, "new-folder", "data"), true), /outside the browser project/);
    await assert.doesNotReject(assertPublicBuildDestination(path.join(temporary, "ordinary-outside"), undefined));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
