import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createResultsTable } from "../../browser/js/ui/table.js";

const html = await readFile(new URL("../../browser/index.html", import.meta.url), "utf8");
const headers = [...html.matchAll(/<th\s+scope="col"[^>]*>([^<]+)<\/th>/g)].map(match => match[1]);
const columns = [...html.matchAll(/<col class="([^"]+)">/g)].map(match => match[1]);

test("results column headers and widths place SOURCE SYSTEM immediately before Match reason", () => {
  assert.deepEqual(headers, ["Concept ID", "Name", "Domain", "Vocabulary", "Class", "Standard", "Code", "Validity", "SOURCE SYSTEM", "Match reason"]);
  assert.deepEqual(columns, ["col-id", "col-name", "col-domain", "col-vocabulary", "col-class", "col-standard", "col-code", "col-validity", "col-source", "col-match"]);
});

test("review tools have a single mount beside package scope inside the source panel", () => {
  assert.equal([...html.matchAll(/id="review-workspace"/g)].length, 1);
  const sourcePanel = html.indexOf('class="panel source-panel"');
  const packageRow = html.indexOf('class="source-tools-row"', sourcePanel);
  const packagePicker = html.indexOf('id="package-picker"', packageRow);
  const reviewMount = html.indexOf('id="review-workspace"', packagePicker);
  const statusPanel = html.indexOf('id="status-panel"');
  assert.ok(sourcePanel >= 0 && packageRow > sourcePanel && packagePicker > packageRow);
  assert.ok(reviewMount > packagePicker && statusPanel > reviewMount);
  assert.match(html, /id="package-picker" aria-labelledby="package-label"/);
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.classList = { add() {} }; this.value = ""; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.value = ""; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  querySelectorAll() { return []; }
}

function fixture(t) {
  const previous = globalThis.document;
  const elements = new Map(["results-table", "results-body", "results-summary"].map(id => [id, new Element("div")]));
  globalThis.document = { createElement: tag => new Element(tag), getElementById: id => elements.get(id) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return { ui: createResultsTable({ onSort() {}, onSelect() {} }), body: elements.get("results-body") };
}

test("rendered source-system values follow Validity and precede Match reason", t => {
  const { ui, body } = fixture(t);
  const concept = { conceptId: "42", conceptName: "Example", packageId: "PKG", domainId: "Observation", vocabularyId: "VOCAB", conceptClassId: "Class", standardConcept: "S", conceptCode: "Code", invalidReason: null, validStartDate: "2020-01-01", validEndDate: "2099-12-31", sourceSystems: ["Local system"] };
  ui.render({ dataset: {}, status: { phase: "ready" }, results: { total: 1, page: 1, pageSize: 20, items: [{ concept, match: { type: "exact-concept-code" } }] } });
  const cells = body.children[0].children;
  assert.equal(cells.length, headers.length);
  assert.equal(cells[2].textContent, "Observation");
  assert.equal(cells[7].textContent, "Current2020-01-01 - 2099-12-31");
  assert.equal(cells[8].textContent, "Local system");
  assert.equal(cells[9].textContent, "Exact concept code");
});

test("empty-state row still spans all result columns", t => {
  const { ui, body } = fixture(t);
  ui.render({ dataset: null, status: { phase: "idle" }, results: { total: 0, items: [] } });
  assert.equal(Number(body.children[0].children[0].attributes.colspan), headers.length);
});


const css = await readFile(new URL("../../browser/css/vocabulary-browser.css", import.meta.url), "utf8");
test("remember controls share row alignment and typography while allowing narrow-screen wrapping", () => {
  assert.match(css, /\.remember-settings\s*\{[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*center;/);
  assert.match(css, /\.remember-details\s*\{[^}]*font-size:\s*\.875rem;/);
  assert.match(css, /\.source-panel \.remember-choice, \.remember-details summary\s*\{\s*line-height:\s*1\.4;/);
  assert.match(css, /\.remember-choice input\s*\{[^}]*flex-shrink:\s*0;/);
  assert.match(css, /\.remember-details\[open\]\s*\{[^}]*flex-basis:\s*100%;/);
});