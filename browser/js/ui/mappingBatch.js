import { makeElement } from "./dom.js";
import { createBatchDraftRunner } from "./batchDraftRunner.js";

function control(label, name, type = "text") {
  const wrapper = makeElement("div", { className: "field" });
  const id = `mapping-${name}`;
  const input = makeElement("input", { attributes: { id, name, type } });
  if (["mapping_author", "mapping_author_affiliation"].includes(name)) input.required = true;
  wrapper.append(makeElement("label", { text: label, attributes: { for: id } }), input);
  return wrapper;
}
function select(label, name, options, suffix) {
  const wrapper = makeElement("div", { className: "field" });
  const id = `mapping-${name}-${suffix}`;
  const input = makeElement("select", { attributes: { id, name } });
  for (const [value, caption] of options) input.append(makeElement("option", { text: caption, attributes: { value } }));
  wrapper.append(makeElement("label", { text: label, attributes: { for: id } }), input);
  return wrapper;
}

/** Append mapping fields, including multiple target/predicate/relationship rows. */
export function renderMappingFields(container) {
  const source = control("Source concept ID (numeric)", "subject_id");
  const sourceVocabulary = control("Source vocabulary ID", "source_vocabulary_id");
  source.querySelector("input").inputMode = "numeric";
  sourceVocabulary.querySelector("input").maxLength = 20;
  container.append(source, sourceVocabulary);
  const rows = makeElement("div", { className: "mapping-relationships" });
  container.append(rows);
  let nextRow = 0;
  function addRow() {
    const number = ++nextRow;
    const row = makeElement("fieldset", { className: "mapping-relationship", attributes: { "data-mapping-row": "" } });
    row.append(makeElement("legend", { text: `Relationship ${number}` }));
    const target = control(`Target concept ID (numeric), relationship ${number}`, `object_id_${number}`);
    target.querySelector("input").dataset.mappingTarget = "";
    target.querySelector("input").inputMode = "numeric";
    const vocabulary = control(`Target vocabulary ID, relationship ${number}`, `target_vocabulary_id_${number}`);
    vocabulary.querySelector("input").dataset.mappingTargetVocabulary = "";
    vocabulary.querySelector("input").maxLength = 20;
    const predicate = select(`Predicate, relationship ${number}`, `predicate_id_${number}`, [
      ["", "Choose a predicate"], ["exactMatch", "exactMatch"], ["broadMatch", "broadMatch"],
      ["narrowMatch", "narrowMatch"], ["relatedMatch", "relatedMatch"],
    ], number);
    predicate.querySelector("select").dataset.mappingPredicate = "";
    const relationship = select(`Relationship, relationship ${number}`, `relationship_id_${number}`, [
      ["", "Choose a relationship"], ["Maps to", "Maps to"], ["Maps to value", "Maps to value"],
      ["Is a", "Is a"], ["Subsumes", "Subsumes"], ["__custom__", "Enter your relationship"],
    ], number);
    const relationshipInput = relationship.querySelector("select");
    relationshipInput.dataset.mappingRelationship = "";
    const custom = control(`Custom relationship, relationship ${number}`, `custom_relationship_${number}`);
    custom.querySelector("input").dataset.mappingCustomRelationship = "";
    custom.hidden = true;
    relationshipInput.addEventListener("change", () => { custom.hidden = relationshipInput.value !== "__custom__"; });
    row.append(target, vocabulary, predicate, relationship, custom);
    if (number > 1) {
      const remove = makeElement("button", { text: "Remove relationship", className: "button button-secondary", attributes: { type: "button" } });
      remove.addEventListener("click", () => { row.remove(); container.dispatchEvent(new Event("change", { bubbles: true })); });
      row.append(remove);
    }
    rows.append(row);
  }
  addRow();
  const add = makeElement("button", { text: "Add relationship", className: "button button-secondary", attributes: { type: "button" } });
  add.addEventListener("click", () => { addRow(); container.dispatchEvent(new Event("change", { bubbles: true })); });
  container.append(add);
  container.append(control("Author (required)", "mapping_author"), control("Author affiliation (required)", "mapping_author_affiliation"),
    control("Reviewer (optional)", "mapping_reviewer"), control("Reviewer affiliation (optional)", "mapping_reviewer_affiliation"));
  container.append(makeElement("p", { className: "field-help", text: "Targets not found in loaded vocabularies are marked unverified in the draft and must be checked against Athena or the relevant custom vocabulary before publication." }));
}

/** Collect all mapping rows without losing duplicate field names to FormData conversion. */
export function getMappingValues(form) {
  const data = new FormData(form);
  const rows = [...form.querySelectorAll("[data-mapping-row]")].map((row) => {
    const choice = row.querySelector("[data-mapping-relationship]").value;
    return {
      object_id: row.querySelector("[data-mapping-target]").value,
      target_vocabulary_id: row.querySelector("[data-mapping-target-vocabulary]").value,
      predicate_id: row.querySelector("[data-mapping-predicate]").value,
      relationship_id: choice === "__custom__" ? row.querySelector("[data-mapping-custom-relationship]").value : choice,
    };
  });
  return { kind: "mapping", subject_id: data.get("subject_id"), source_vocabulary_id: data.get("source_vocabulary_id"),
    mapping_author: data.get("mapping_author"), mapping_author_affiliation: data.get("mapping_author_affiliation"),
    mapping_reviewer: data.get("mapping_reviewer"), mapping_reviewer_affiliation: data.get("mapping_reviewer_affiliation"), relationships: rows };
}

/** Local JSON reading only; reports a draft for the caller to preview and prepare an issue link. */
export function createBatchDraftUI({ captureGuard, isCurrent, validateConcept, onDraft }) {
  const root = makeElement("div", { className: "batch-review" });
  const label = makeElement("label", { text: "Batch JSON file", attributes: { for: "batch-json-file" } });
  const file = makeElement("input", { attributes: { id: "batch-json-file", type: "file", accept: ".json,application/json" } });
  const help = makeElement("p", { className: "field-help", text: 'Use a downloaded batch draft, a JSON array with a kind ("concept" or "mapping") per record, or an object with "concepts" and "mappings" arrays. Each record requires an author and author affiliation and is validated before preview.' });
  const button = makeElement("button", { className: "button button-secondary", text: "Validate batch and preview", attributes: { type: "button" } });
  const runner = createBatchDraftRunner({ readSelection: () => file.files?.[0] ?? null, captureGuard, isCurrent, validateConcept, onDraft });
  button.addEventListener("click", () => { void runner.run(); });
  file.addEventListener("change", () => {
    runner.invalidate();
    onDraft({ valid: false, errors: ["Validate the selected batch before opening GitHub."], draft: null });
  });
  root.append(label, file, help, button);
  return { root, invalidate: runner.invalidate };
}
