import { appendTextRow, clearNode, displayValue, makeElement, showModal } from "./dom.js";

export function createConceptDetails({ onClose, onSelectRelated }) {
  const dialog = document.getElementById("concept-dialog");
  const title = document.getElementById("concept-dialog-title");
  const content = document.getElementById("concept-dialog-content");
  let ignoreNextClose = false;

  dialog.addEventListener("close", () => {
    if (ignoreNextClose) {
      ignoreNextClose = false;
      return;
    }
    onClose();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) dialog.close();
  });

  function showLoading(concept) {
    title.textContent = concept?.conceptName || "Concept details";
    clearNode(content).append(makeElement("p", { className: "detail-loading", text: "Loading synonyms and relationships…" }));
    showModal(dialog);
  }

  function showError(concept, error) {
    title.textContent = concept?.conceptName || "Concept details";
    clearNode(content).append(
      makeElement("div", {
        className: "detail-error",
        text: error?.message || "Concept details could not be loaded.",
        attributes: { role: "alert" },
      }),
    );
    showModal(dialog);
  }

  function showDetails(details, { hierarchyAvailable = false } = {}) {
    const concept = details.concept;
    title.textContent = concept.conceptName;
    clearNode(content);

    const identity = makeElement("section", { className: "detail-section", attributes: { "aria-labelledby": "identity-heading" } });
    identity.append(makeElement("h3", { text: "OMOP concept", attributes: { id: "identity-heading" } }));
    const fields = makeElement("dl", { className: "detail-grid" });
    appendTextRow(fields, "Concept ID", concept.conceptId);
    appendTextRow(fields, "Concept code", concept.conceptCode);
    appendTextRow(fields, "Vocabulary", concept.vocabularyId);
    appendTextRow(fields, "Domain", concept.domainId);
    appendTextRow(fields, "Concept class", concept.conceptClassId);
    appendTextRow(fields, "Standard concept", standardLabel(concept.standardConcept));
    appendTextRow(fields, "Valid from", concept.validStartDate);
    appendTextRow(fields, "Valid through", concept.validEndDate);
    appendTextRow(fields, "Invalid reason", invalidLabel(concept.invalidReason));
    identity.append(fields);
    content.append(identity);

    content.append(renderProvenance(concept.source));
    content.append(renderSynonyms(details.synonyms));
    content.append(renderRelationships("Outgoing relationships", details.outgoing, "outgoing", onSelectRelated));
    content.append(renderRelationships("Incoming relationships", details.incoming, "incoming", onSelectRelated));

    const usefulHierarchy = hierarchyAvailable
      && ((details.ancestors?.length ?? 0) > 0 || (details.descendants?.length ?? 0) > 0);
    if (usefulHierarchy) content.append(renderHierarchy(details, onSelectRelated));
    showModal(dialog);
  }

  function closeWithoutCallback() {
    if (!dialog.open) return;
    ignoreNextClose = true;
    dialog.close();
  }

  return { showLoading, showError, showDetails, closeWithoutCallback };
}

function renderProvenance(source) {
  const section = detailSection("Source provenance");
  const fields = makeElement("dl", { className: "detail-grid detail-grid-compact" });
  appendTextRow(fields, "Package", source?.packageId);
  appendTextRow(fields, "Source file", source?.file);
  appendTextRow(fields, "Source row", source?.row);
  section.append(fields);
  return section;
}

function renderSynonyms(synonyms = []) {
  const section = detailSection(`Synonyms (${synonyms.length.toLocaleString()})`);
  if (synonyms.length === 0) {
    section.append(emptyDetail("No local synonyms are available for this concept."));
    return section;
  }
  const list = makeElement("ul", { className: "detail-list" });
  for (const synonym of synonyms) {
    const item = makeElement("li");
    item.append(makeElement("span", { text: synonym.conceptSynonymName }));
    if (synonym.languageConceptId) {
      item.append(makeElement("small", { text: `Language concept ${synonym.languageConceptId}` }));
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderRelationships(heading, relationships = [], direction, onSelectRelated) {
  const section = detailSection(`${heading} (${relationships.length.toLocaleString()})`);
  if (relationships.length === 0) {
    section.append(emptyDetail(`No ${direction} relationships are available.`));
    return section;
  }

  const list = makeElement("ul", { className: "relationship-list" });
  for (const relationship of relationships) {
    const item = makeElement("li", { className: "relationship-item" });
    const otherId = direction === "outgoing" ? relationship.conceptId2 : relationship.conceptId1;
    item.append(makeElement("span", { className: "relationship-type", text: relationship.relationshipId }));
    if (relationship.otherConcept) {
      const button = makeElement("button", {
        className: "related-concept",
        text: `${relationship.otherConcept.conceptName} (${otherId})`,
        attributes: { type: "button" },
      });
      button.addEventListener("click", () => onSelectRelated(otherId));
      item.append(button);
    } else {
      item.append(
        makeElement("span", { className: "external-concept", text: otherId }),
        makeElement("span", { className: "badge badge-warning", text: "External / unresolved" }),
      );
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderHierarchy(details, onSelectRelated) {
  const section = detailSection("Hierarchy");
  const columns = makeElement("div", { className: "hierarchy-grid" });
  columns.append(
    hierarchyColumn("Ancestors", details.ancestors, "ancestorConceptId", onSelectRelated),
    hierarchyColumn("Descendants", details.descendants, "descendantConceptId", onSelectRelated),
  );
  section.append(columns);
  return section;
}

function hierarchyColumn(heading, rows = [], idField, onSelectRelated) {
  const column = makeElement("div", { className: "hierarchy-column" });
  column.append(makeElement("h4", { text: `${heading} (${rows.length.toLocaleString()})` }));
  if (rows.length === 0) {
    column.append(emptyDetail(`No ${heading.toLowerCase()} available.`));
    return column;
  }
  const list = makeElement("ul", { className: "detail-list" });
  for (const row of rows) {
    const id = row[idField];
    const item = makeElement("li");
    if (row.otherConcept) {
      const button = makeElement("button", {
        className: "related-concept",
        text: `${row.otherConcept.conceptName} (${id})`,
        attributes: { type: "button" },
      });
      button.addEventListener("click", () => onSelectRelated(id));
      item.append(button);
    } else {
      item.append(makeElement("span", { text: id }));
    }
    item.append(makeElement("small", {
      text: `${row.minLevelsOfSeparation}-${row.maxLevelsOfSeparation} levels`,
    }));
    list.append(item);
  }
  column.append(list);
  return column;
}

function detailSection(heading) {
  const section = makeElement("section", { className: "detail-section" });
  section.append(makeElement("h3", { text: heading }));
  return section;
}

function emptyDetail(message) {
  return makeElement("p", { className: "empty-detail", text: message });
}

function standardLabel(value) {
  if (value === "S") return "Standard (S)";
  if (value === "C") return "Classification (C)";
  return displayValue(value, "Non-standard (blank)");
}

function invalidLabel(value) {
  if (value === "D") return "Deleted (D)";
  if (value === "U") return "Updated (U)";
  return displayValue(value, "Current / valid (blank)");
}
