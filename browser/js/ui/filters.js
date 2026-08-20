import { clearNode, makeElement } from "./dom.js";

const NULL_SENTINEL = "__cvb_null__";
const FILTERS = Object.freeze({
  vocabularyId: { all: "All vocabularies", blank: "Blank vocabulary" },
  domainId: { all: "All domains", blank: "Blank domain" },
  conceptClassId: { all: "All concept classes", blank: "Blank concept class" },
  standardConcept: { all: "All standard concept values", blank: "Non-standard" },
  invalidReason: { all: "All validity values", blank: "null - Valid" },
});
const FIXED_ENUM_VALUES = Object.freeze({
  standardConcept: Object.freeze(["S", "C", null]),
  invalidReason: Object.freeze(["D", "U", null]),
});

export function createFilters({ onFilter }) {
  const selects = new Map(
    [...document.querySelectorAll("[data-filter]")].map((select) => [select.dataset.filter, select]),
  );
  let renderedDataset = null;

  for (const [field, select] of selects) {
    select.addEventListener("change", () => {
      if (select.value === "") onFilter(field, []);
      else onFilter(field, [select.value === NULL_SENTINEL ? null : select.value]);
    });
  }

  function render(state) {
    if (renderedDataset !== state.dataset) {
      renderedDataset = state.dataset;
      for (const [field, select] of selects) {
        clearNode(select);
        select.append(makeElement("option", { text: FILTERS[field].all, attributes: { value: "" } }));
        for (const value of filterValues(field, state.dataset?.facets)) {
          select.append(makeElement("option", {
            text: filterLabel(field, value),
            attributes: { value: value == null ? NULL_SENTINEL : value },
          }));
        }
      }
    }

    for (const [field, select] of selects) {
      const selected = state.filters[field]?.[0];
      select.value = selected == null && state.filters[field]?.length ? NULL_SENTINEL : selected ?? "";
      select.disabled = !state.dataset;
    }
  }

  return { render };
}

export function filterValues(field, facets = {}) {
  return FIXED_ENUM_VALUES[field] ?? facets?.[field] ?? [];
}

export function filterLabel(field, value) {
  if (value == null || value === "") return FILTERS[field].blank;
  if (field === "standardConcept") {
    return value === "S" ? "S - Standard" : value === "C" ? "C - Classification" : String(value);
  }
  if (field === "invalidReason") {
    return value === "D" ? "D - Deprecated" : value === "U" ? "U - Updated" : String(value);
  }
  return String(value);
}
