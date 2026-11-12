import { makeElement } from "./dom.js";

const make = (tag, options) => makeElement(tag, options);
const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** Render proposal fields. Draft IDs are assigned by the eventual publisher, not this form. */
export function renderConceptFields(container, context = {}) {
  const concepts = context.customConcepts ?? [];
  const distinct = (field) => [...new Set(concepts.map((item) => item[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const addField = (name, label, opts = {}) => {
    const wrap = make("div", { className: "field" });
    const id = `draft-${name}`;
    const input = make(opts.type === "select" ? "select" : "input", { attributes: { id, name } });
    if (opts.type && opts.type !== "select") input.type = opts.type;
    if (opts.max) input.maxLength = opts.max;
    if (opts.choices) {
      const list = make("datalist", { attributes: { id: `${id}-choices` } });
      for (const choice of opts.choices) list.append(make("option", { attributes: { value: choice } }));
      input.setAttribute("list", `${id}-choices`);
      wrap.append(list);
    }
    wrap.append(make("label", { text: label, attributes: { for: id } }), input);
    container.append(wrap);
    return input;
  };
  addField("vocabulary_id", "Custom vocabulary name (choose or create)", { max: 20, choices: distinct("vocabularyId") });
  addField("source_code_set", "Source system (source_code_set)");
  addField("concept_name", "Concept name", { max: 255 });
  addField("concept_code", "Concept code", { max: 50 });
  addField("domain_id", "Domain (choose, create, or enter Do not know)", { max: 20, choices: [...new Set(["Procedure", "Measurement", "Observation", "Drug", "Device", "Visit", ...distinct("domainId"), "Do not know"])] });
  addField("concept_class_id", "Concept class (choose, create, or enter Do not know)", { max: 20, choices: [...distinct("conceptClassId"), "Do not know"] });
  const standard = addField("standard_concept", "Standard concept", { type: "select" });
  for (const [value, text] of [["", "Non-standard (NULL)"], ["S", "S - Standard"], ["C", "C - Classification"]]) standard.append(make("option", { text, attributes: { value } }));
  const start = addField("valid_start_date", "Valid start date", { type: "date" });
  const end = addField("valid_end_date", "Valid end date", { type: "date" });
  start.value = localDate(); end.value = "2099-12-31"; end.readOnly = true;
  container.append(make("p", { className: "field-help", text: "Note: The Concept ID will be automatically assigned upon publishing, using the reserved range starting from 2,000,000,000 (2B+) designated for custom concepts. This draft does not assign an ID; allocation depends on the publishing process." }));
  container.append(make("p", { className: "field-help", text: "Vocabulary names and uniqueness are checked against loaded data and known standard names only; the full Athena catalog and unloaded vocabularies are not checked. 'Do not know' is a draft placeholder and must be resolved during review." }));

  const mappingSection = make("div", { className: "field" });
  mappingSection.append(make("label", { text: "Maps to target concept IDs", attributes: { for: "draft-maps-to-0" } }));
  const mappingList = make("div");
  const maps = [];
  const addButton = make("button", { className: "button button-secondary", text: "Add mapping", attributes: { type: "button" } });
  function addMapping() {
    const input = make("input", { attributes: { id: `draft-maps-to-${maps.length}`, "aria-label": `Maps to target concept ID ${maps.length + 1}`, inputmode: "numeric" } });
    maps.push(input); mappingList.append(input);
    input.addEventListener("input", sync);
  }
  addMapping();
  addButton.addEventListener("click", () => { addMapping(); sync(); });
  mappingSection.append(mappingList, addButton); container.append(mappingSection);
  const mappingValue = addField("maps_to_value", "Maps to value target concept ID");
  const parents = addField("parent_concept_ids", "Parent concept IDs (comma-separated)");
  const children = addField("child_concept_ids", "Child concept IDs (comma-separated)");
  const changed = (event) => {
    const isHierarchy = event.target === parents || event.target === children;
    if (isHierarchy && (parents.value.trim() || children.value.trim()) && !["S", "C"].includes(standard.value)) standard.value = "S";
    if (event.target === mappingValue && mappingValue.value.trim()) standard.value = "";
    sync();
  };
  for (const input of [parents, children, mappingValue, standard]) input.addEventListener("input", changed);
  standard.addEventListener("change", changed);
  function sync() {
    const hasMapping = maps.some((input) => input.value.trim()) || Boolean(mappingValue.value.trim());
    const hasHierarchy = Boolean(parents.value.trim() || children.value.trim());
    if (hasMapping) standard.value = "";
    const hierarchyMode = hasHierarchy || standard.value === "S" || standard.value === "C";
    for (const input of maps) input.disabled = hierarchyMode;
    mappingValue.disabled = hierarchyMode || maps.filter((input) => input.value.trim()).length > 1;
    addButton.disabled = hierarchyMode || Boolean(mappingValue.value.trim());
    parents.disabled = hasMapping; children.disabled = hasMapping; standard.disabled = hasMapping;
  }
  function values() {
    const get = (name) => container.querySelector(`[name="${name}"]`)?.value ?? "";
    return {
      vocabulary_id: get("vocabulary_id"), source_code_set: get("source_code_set"), concept_name: get("concept_name"), concept_code: get("concept_code"),
      domain_id: get("domain_id"), concept_class_id: get("concept_class_id"), standard_concept: standard.value,
      valid_start_date: start.value, valid_end_date: end.value, invalid_reason: "",
      maps_to: maps.map((input) => input.value.trim()).filter(Boolean), maps_to_value: mappingValue.value.trim(),
      parent_concept_ids: parents.value, child_concept_ids: children.value,
    };
  }
  sync();
  return { values };
}
