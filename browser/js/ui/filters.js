import { clearNode, makeElement } from "./dom.js";
import { conceptFilterValues } from "../model/sourceSystems.js";

const FILTERS = Object.freeze({
  sourceSystem: { all: "All source systems", blank: "Not supplied" },
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
  const pickers = new Map();
  let renderedConcepts = null;
  let renderedFilters = null;
  let counts = {};
  for (const [field, select] of selects) {
    pickers.set(field, createSearchablePicker(field, select, (values) => onFilter(field, values)));
  }
  document.addEventListener("click", (event) => {
    for (const picker of pickers.values()) if (!picker.root.contains(event.target)) picker.close();
  });
  return {
    render(state) {
      const concepts = state.facetConcepts ?? state.dataset?.concepts ?? [];
      const filterKey = JSON.stringify(state.filters);
      if (renderedConcepts !== concepts || renderedFilters !== filterKey) {
        renderedConcepts = concepts;
        renderedFilters = filterKey;
        counts = contextualFilterCounts(concepts, state.filters);
      }
      for (const [field, picker] of pickers) {
        picker.render(counts[field] ?? new Map(), state.filters[field] ?? [], !state.dataset, Boolean(state.facetConcepts));
      }
    },
  };
}

function createSearchablePicker(field, select, onSelect) {
  const label = select.parentElement.querySelector("label");
  const root = makeElement("details", { className: "facet-picker" });
  const summary = makeElement("summary", { attributes: { id: `${select.id}-trigger` } });
  const labelId = `${select.id}-label`;
  label.id = labelId;
  label.removeAttribute("for");
  summary.setAttribute("aria-labelledby", `${labelId} ${select.id}-value`);
  const valueLabel = makeElement("span", { attributes: { id: `${select.id}-value` } });
  summary.append(valueLabel);
  const panel = makeElement("div", { className: "facet-popup" });
  const input = makeElement("input", { attributes: {
    type: "search", placeholder: "Find an option…", "aria-label": `Search ${label.textContent.toLowerCase()} options`, autocomplete: "off",
  } });
  const reset = makeElement("button", { className: "facet-reset", text: "Clear selection", attributes: { type: "button" } });
  const choices = makeElement("div", { className: "facet-choices", attributes: { role: "group", "aria-label": `${label.textContent} options` } });
  const hint = makeElement("p", { className: "facet-hint", attributes: { "aria-live": "polite" } });
  panel.append(input, reset, choices, hint);
  root.append(summary, panel);
  select.hidden = true;
  select.after(root);
  let counts = new Map();
  let selected = [];
  let disabled = true;
  let queryAware = false;
  function close() { root.open = false; }
  reset.addEventListener("click", () => { onSelect([]); input.focus(); });
  function renderChoices() {
    const focusedValue = choices.contains(document.activeElement) ? document.activeElement.dataset.value : null;
    const query = input.value.trim().toLocaleLowerCase();
    clearNode(choices);
    const values = FIXED_ENUM_VALUES[field] ?? [...counts.keys()];
    const options = [...new Set([...values, ...selected])];
    let shown = 0;
    for (const value of options) {
      const text = filterLabel(field, value);
      if (query && !text.toLocaleLowerCase().includes(query)) continue;
      shown += 1;
      const count = counts.get(value) ?? 0;
      const item = makeElement("label", { className: "facet-choice" });
      const checkbox = makeElement("input", { attributes: { type: "checkbox" } });
      checkbox.dataset.value = JSON.stringify(value);
      checkbox.checked = selected.includes(value);
      checkbox.disabled = disabled;
      const caption = makeElement("span", { text: `${text} (${count.toLocaleString()})` });
      if (!count && selected.includes(value)) {
        item.classList.add("facet-incompatible");
        caption.append(makeElement("small", { text: " · no matches with other filters" }));
      }
      checkbox.addEventListener("change", () => {
        const next = checkbox.checked ? [...new Set([...selected, value])] : selected.filter((candidate) => candidate !== value);
        onSelect(next);
      });
      item.append(checkbox, caption);
      choices.append(item);
      if (focusedValue === checkbox.dataset.value) checkbox.focus();
    }
    reset.disabled = disabled || selected.length === 0;
    hint.textContent = shown ? `Select one or more. Counts reflect ${queryAware ? "the search and " : ""}other active filters.` : "No options match. Try another search.";
  }
  root.addEventListener("toggle", () => {
    if (root.open) {
      if (disabled) { close(); return; }
      document.querySelectorAll(".facet-picker[open]").forEach((other) => { if (other !== root) other.open = false; });
      input.focus();
    }
  });
  summary.addEventListener("click", (event) => { if (disabled) event.preventDefault(); });
  input.addEventListener("input", renderChoices);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { close(); summary.focus(); event.preventDefault(); return; }
    if (!root.open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (["Home", "End"].includes(event.key) && event.target === input) return;
    const checkboxes = [...choices.querySelectorAll("input[type=checkbox]")];
    const current = checkboxes.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? checkboxes.length - 1 : current + (event.key === "ArrowDown" ? 1 : -1);
    checkboxes[Math.max(0, Math.min(checkboxes.length - 1, next))]?.focus();
    event.preventDefault();
  });
  return {
    root, close,
    render(nextCounts, nextSelected, isDisabled, isQueryAware) {
      disabled = isDisabled;
      counts = nextCounts;
      selected = nextSelected;
      queryAware = isQueryAware;
      valueLabel.textContent = selected.length ? selected.map((value) => filterLabel(field, value)).join(", ") : FILTERS[field].all;
      summary.setAttribute("aria-disabled", String(disabled));
      summary.tabIndex = disabled ? -1 : 0;
      root.classList.toggle("is-disabled", disabled);
      root.classList.toggle("has-selection", selected.length > 0);
      if (disabled) close();
      renderChoices();
    },
  };
}

// OR within a facet, AND across facets. Own selections never suppress alternatives.
// Only actual concept membership contributes values; optional reference tables cannot add them.
export function contextualFilterCounts(concepts, filters = {}) {
  const result = {};
  for (const field of Object.keys(FILTERS)) {
    const counts = new Map();
    for (const concept of concepts) {
      const matches = Object.entries(filters).every(([other, selected]) => other === field || !selected?.length || conceptFilterValues(concept, other).some(value => selected.includes(value)));
      if (matches) {
        for (const value of conceptFilterValues(concept, field)) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
    }
    result[field] = new Map([...counts].sort(([a], [b]) => String(a ?? "").localeCompare(String(b ?? ""))));
  }
  return result;
}

export function contextualFilterValues(concepts, filters = {}) {
  const counts = contextualFilterCounts(concepts, filters);
  return Object.fromEntries(Object.keys(FILTERS).map((field) => [field, FIXED_ENUM_VALUES[field] ?? [...counts[field].keys()]]));
}
export function filterValues(field, facets = {}) { return FIXED_ENUM_VALUES[field] ?? facets?.[field] ?? []; }
export function filterLabel(field, value) {
  if (value == null || value === "") return FILTERS[field].blank;
  if (field === "standardConcept") return value === "S" ? "S - Standard" : value === "C" ? "C - Classification" : String(value);
  if (field === "invalidReason") return value === "D" ? "D - Deprecated" : value === "U" ? "U - Updated" : String(value);
  return String(value);
}
