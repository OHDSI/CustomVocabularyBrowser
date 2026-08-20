import { clearNode, displayValue, makeElement } from "./dom.js";

const MATCH_LABELS = Object.freeze({
  "exact-concept-id": "Exact concept ID",
  "exact-concept-code": "Exact concept code",
  "exact-concept-name": "Exact name",
  "exact-synonym": "Exact synonym",
  "concept-name-prefix": "Name prefix",
  "synonym-prefix": "Synonym prefix",
  "concept-name-token": "Name token",
  "synonym-token": "Synonym token",
  "fuzzy-concept-name": "Similar name",
  "fuzzy-synonym": "Similar synonym",
});

export function createResultsTable({ onSort, onSelect }) {
  const table = document.getElementById("results-table");
  const body = document.getElementById("results-body");
  const summary = document.getElementById("results-summary");

  for (const header of table.querySelectorAll("th[data-sort]")) {
    const label = header.textContent;
    const button = makeElement("button", {
      className: "sort-button",
      text: label,
      attributes: { type: "button" },
    });
    button.addEventListener("click", () => onSort(header.dataset.sort));
    header.replaceChildren(button);
  }

  function render(state) {
    clearNode(body);
    const { results } = state;

    if (!state.dataset) {
      addMessageRow(body, state.status.phase === "error" ? "Unable to load concepts." : "Choose an available package to browse concepts.");
      summary.textContent = "No package loaded.";
    } else if (results.total === 0) {
      addMessageRow(body, "No concepts match the current search and filters.");
      summary.textContent = "0 concepts found.";
    } else {
      summary.textContent = resultSummary(results);
      for (const item of results.items) body.append(renderRow(item, state.selectedConceptId, onSelect));
    }

    for (const header of table.querySelectorAll("th[data-sort]")) {
      const active = state.sort?.field === header.dataset.sort;
      header.setAttribute("aria-sort", active ? (state.sort.direction === "desc" ? "descending" : "ascending") : "none");
      const button = header.querySelector("button");
      button.dataset.direction = active ? state.sort.direction : "";
    }
  }

  return { render };
}

function renderRow(item, selectedConceptId, onSelect) {
  const concept = item.concept;
  const row = makeElement("tr");
  if (concept.conceptId === selectedConceptId) {
    row.classList.add("is-selected");
    row.setAttribute("aria-current", "true");
  }

  const idCell = makeElement("td");
  const openButton = makeElement("button", {
    className: "concept-link",
    text: concept.conceptId,
    attributes: { type: "button", "aria-label": `Open details for ${concept.conceptName}` },
  });
  openButton.addEventListener("click", () => onSelect(concept.conceptId));
  idCell.append(openButton);

  const nameCell = makeElement("td", { className: "concept-name", text: concept.conceptName });
  const domainCell = makeElement("td", { text: concept.domainId });
  const vocabularyCell = makeElement("td", { text: concept.vocabularyId });
  const classCell = makeElement("td", { text: concept.conceptClassId });
  const standardCell = makeElement("td");
  standardCell.append(statusBadge(standardLabel(concept.standardConcept), concept.standardConcept ? "neutral" : "muted"));
  const codeCell = makeElement("td", { className: "code-cell", text: concept.conceptCode });
  const validityCell = makeElement("td");
  validityCell.append(
    statusBadge(validityLabel(concept.invalidReason), concept.invalidReason ? "warning" : "success"),
    makeElement("span", { className: "date-range", text: `${concept.validStartDate} - ${concept.validEndDate}` }),
  );
  const matchCell = makeElement("td", { className: "match-reason", text: matchLabel(item.match) });

  row.append(
    idCell,
    nameCell,
    domainCell,
    vocabularyCell,
    classCell,
    standardCell,
    codeCell,
    validityCell,
    matchCell,
  );
  return row;
}

function resultSummary(results) {
  const start = (results.page - 1) * results.pageSize + 1;
  const end = Math.min(results.page * results.pageSize, results.total);
  return `Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${results.total.toLocaleString()} concepts.`;
}

function addMessageRow(body, message) {
  const row = makeElement("tr");
  row.append(makeElement("td", {
    className: "table-message",
    text: message,
    attributes: { colspan: "9" },
  }));
  body.append(row);
}

function statusBadge(text, tone) {
  return makeElement("span", { className: `badge badge-${tone}`, text });
}

function standardLabel(value) {
  if (value === "S") return "Standard";
  if (value === "C") return "Classification";
  return displayValue(value, "Non-standard");
}

function validityLabel(value) {
  if (value === "D") return "Deleted";
  if (value === "U") return "Updated";
  return value ? String(value) : "Current";
}

function matchLabel(match) {
  if (!match) return "All concepts";
  return MATCH_LABELS[match.type] ?? "Lexical match";
}
