import { sameConceptCode, normalizeConceptCode } from "../model/codeMatching.js";
import { appendTextRow, clearNode, displayValue, makeElement, showModal } from "./dom.js";

// Temporarily disabled while duplicate-looking mapping records are reviewed.
// Re-enable only after the display distinguishes target vocabularies reliably.
const SHOW_ADDITIONAL_MAPPING_RECORDS = false;

export function createConceptDetails({ onClose, onSelectRelated, getState = () => ({}) }) {
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
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });

  function showLoading(concept) {
    title.textContent = concept?.conceptName || "Concept details";
    clearNode(content).append(makeElement("p", { className: "detail-loading", text: "Loading synonyms and relationships…" }));
    showModal(dialog);
  }

  function showError(concept, error) {
    title.textContent = concept?.conceptName || "Concept details";
    clearNode(content).append(makeElement("div", {
      className: "detail-error", text: error?.message || "Concept details could not be loaded.", attributes: { role: "alert" },
    }));
    showModal(dialog);
  }

  function showDetails(details) {
    const concept = details.concept;
    title.textContent = concept.conceptName;
    clearNode(content);
    const identity = detailSection("Concept identity");
    const actions = makeElement("div", { className: "detail-actions" });
    const feedback = makeElement("span", { attributes: { role: "status", "aria-live": "polite" } });
    actions.append(copyButton("Copy concept ID", () => concept.conceptId, feedback));
    if (getState()?.source?.provider !== "local-directory") {
      actions.append(copyButton("Copy concept link", () => globalThis.location.href, feedback));
    }
    actions.append(feedback);
    identity.append(actions);
    if (getState()?.source?.provider === "local-directory") {
      identity.append(emptyDetail("Local concepts are not included in shareable links."));
    }
    const fields = makeElement("dl", { className: "detail-grid" });
    for (const [label, value] of [
      ["Concept name", concept.conceptName], ["Concept ID", concept.conceptId], ["Concept code", concept.conceptCode], ["Vocabulary", concept.vocabularyId],
      ["Domain", concept.domainId], ["Concept class", concept.conceptClassId],
      ["Standard concept", standardLabel(concept.standardConcept)], ["Valid from", concept.validStartDate],
      ["Valid through", concept.validEndDate], ["Invalid reason", invalidLabel(concept.invalidReason)],
    ]) appendTextRow(fields, label, value);
    identity.append(fields);
    content.append(identity, renderProvenance(concept), renderSynonyms(details.synonyms),
      renderHierarchy(details, onSelectRelated), renderRelationships(details, onSelectRelated));
    if (SHOW_ADDITIONAL_MAPPING_RECORDS) {
      const mappingRecords = additionalMappingRecords(details);
      if (mappingRecords.length) content.append(renderMappingRecords(mappingRecords));
    }
    showModal(dialog);
  }

  function closeWithoutCallback() {
    if (!dialog.open) return;
    ignoreNextClose = true;
    dialog.close();
  }
  return { showLoading, showError, showDetails, closeWithoutCallback };
}

function copyButton(label, value, feedback) {
  const button = makeElement("button", { className: "button button-secondary", text: label, attributes: { type: "button" } });
  button.addEventListener("click", async () => {
    try {
      await globalThis.navigator.clipboard.writeText(String(value()));
      feedback.textContent = label === "Copy concept ID" ? "Concept ID copied." : "Concept link copied.";
    } catch {
      feedback.textContent = "Copy was unavailable. Select and copy the concept ID or browser address manually.";
    }
  });
  return button;
}

function renderProvenance(concept) {
  const section = detailSection("Source provenance");
  const fields = makeElement("dl", { className: "detail-grid detail-grid-compact" });
  appendTextRow(fields, "Source code set", (concept.sourceSystems ?? []).join(", ") || "Not supplied");
  appendTextRow(fields, "Source category", (concept.sourceCategories ?? []).join(", ") || "Not supplied");
  section.append(fields);
  const audit = makeElement("details", { className: "provenance-audit" });
  audit.append(makeElement("summary", { text: "File provenance" }));
  const auditFields = makeElement("dl", { className: "detail-grid detail-grid-compact" });
  appendTextRow(auditFields, "Package", concept.source?.packageId);
  appendTextRow(auditFields, "Source file", concept.source?.file);
  appendTextRow(auditFields, "Source row", concept.source?.row);
  audit.append(auditFields);
  section.append(audit);
  return section;
}

function renderSynonyms(synonyms = []) {
  const section = detailSection(`Synonyms (${synonyms.length.toLocaleString()})`);
  if (!synonyms.length) {
    section.append(emptyDetail("No local synonyms are available for this concept."));
    return section;
  }
  const list = makeElement("ul", { className: "detail-list" });
  for (const synonym of synonyms) {
    const item = makeElement("li");
    item.append(makeElement("span", { text: synonym.conceptSynonymName }));
    if (synonym.languageConceptId) item.append(makeElement("small", { text: `Language concept ${synonym.languageConceptId}` }));
    list.append(item);
  }
  section.append(list);
  return section;
}

const REVERSE_LABELS = { "Maps to": "Mapped from", "Mapped from": "Maps to", "Is a": "Subsumes", "Subsumes": "Is a" };

export function semanticRelationships(details) {
  const definitions = new Map((details.metadata?.relationshipDefinition ?? details.metadata?.relationship ?? []).map((row) => [row.relationship_id, row.reverse_relationship_id]));
  const rows = ["outgoing", "incoming"].flatMap((direction) => (details[direction] ?? []).map((row) => ({
    ...row,
    direction,
    otherId: direction === "outgoing" ? row.conceptId2 : row.conceptId1,
    label: direction === "outgoing" ? row.relationshipId
      : REVERSE_LABELS[row.relationshipId] || definitions.get(row.relationshipId) || `${row.relationshipId} (incoming)`,
  })));
  const unique = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.label, String(row.otherId)]);
    const previous = unique.get(key);
    if (!previous || metadataRichness(row) > metadataRichness(previous)) unique.set(key, row);
  }
  return [...unique.values()];
}

function metadataRichness(row) {
  const ignored = new Set(["sourceFile", "sourceRow", "subjectConceptId", "objectConceptId", "associationStatus"]);
  let count = row.otherConceptOmop ? 1 : 0;
  for (const metadata of row.mappingMetadata ?? []) {
    count += Object.entries(metadata).filter(([key, value]) => !ignored.has(key) && value != null && value !== "").length;
  }
  return count;
}

/** Hide only additional records whose target is demonstrably already represented. */
export function additionalMappingRecords(details) {
  const relationships = semanticRelationships(details);
  const hierarchy = directHierarchy(details);
  const hierarchyEvidence = new Set([...hierarchy.parents, ...hierarchy.children].flatMap((row) => row.hierarchyMetadata ?? []));
  const unique = new Map();
  for (const record of details.concept?.mappingMetadata ?? []) {
    if (hierarchyEvidence.has(record)) continue;
    const attached = relationships.some((row) => (row.mappingMetadata ?? []).some((metadata) => metadata === record
      || (record.sourceFile && Number.isInteger(record.sourceRow)
        && metadata.sourceFile === record.sourceFile && metadata.sourceRow === record.sourceRow)));
    if (attached) continue;
    if (record.targetIdentityVerified !== true) {
      // Do not hide evidence solely because an unverified ID resembles a relationship target.
      unique.set(Symbol(), { ...record, associationStatus: "target-unverified" });
      continue;
    }
    if (record.associationStatus === "relationship") {
      // A stale artifact may claim an association no longer present in the safe view.
      unique.set(Symbol(), { ...record, associationStatus: "not-attached" });
      continue;
    }
    const id = String(record.objectConceptId ?? record.target_concept_id ?? "").trim();
    const code = String(record.objectCode ?? record.target_code ?? "").trim();
    const vocabulary = String(record.objectVocabulary ?? record.target_vocabulary_id ?? "").trim();
    const duplicate = relationships.some((row) => {
      if (record.relationship_id && record.relationship_id !== row.label) return false;
      if (id && id === String(row.otherId)) return true;
      if (!code || !vocabulary) return false;
      const targets = [row.otherConcept, ...(row.mappingMetadata ?? [])];
      return targets.some((target) => sameConceptCode(target?.conceptCode ?? target?.target_code ?? target?.objectCode ?? "", code)
        && String(target?.vocabularyId ?? target?.target_vocabulary_id ?? target?.objectVocabulary ?? "") === vocabulary);
    });
    if (duplicate) continue;
    const key = JSON.stringify([record.relationship_id || "", id || null, code ? normalizeConceptCode(code) : null, vocabulary || null]);
    // An unidentified target cannot safely be collapsed with another unidentified row.
    if (!id && (!code || !vocabulary)) { unique.set(Symbol(), record); continue; }
    const prior = unique.get(key);
    if (!prior || metadataRichness({ mappingMetadata: [record] }) > metadataRichness({ mappingMetadata: [prior] })) unique.set(key, record);
  }
  return [...unique.values()];
}

function renderRelationships(details, onSelectRelated) {
  const rows = semanticRelationships(details);
  const section = detailSection(`Relationships (${rows.length.toLocaleString()})`);
  if (!rows.length) {
    section.append(emptyDetail("No relationships are available for this concept."));
    return section;
  }
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.label)) groups.set(row.label, []);
    groups.get(row.label).push(row);
  }
  for (const [label, relationships] of groups) {
    section.append(makeElement("h4", { text: `${label} (${relationships.length})` }));
    const list = makeElement("ul", { className: "relationship-list" });
    for (const row of relationships) {
      const item = makeElement("li", { className: "relationship-item" });
      const target = omopTarget(row);
      item.append(makeElement("span", { className: "relationship-type", text: target
        ? `${label} · OMOP · ${target.vocabularyId || "Vocabulary not supplied"} · ${target.conceptId}` : label }));
      item.append(relatedConcept(row.otherId, row.otherConcept, onSelectRelated, target));
      if (target) item.append(makeElement("a", {
        text: "View in Athena", attributes: { href: `https://athena.ohdsi.org/search-terms/terms/${target.conceptId}`, target: "_blank", rel: "noopener noreferrer" },
      }));
      if (row.invalidReason) item.append(makeElement("span", { className: "badge badge-warning", text: invalidLabel(row.invalidReason) }));
      for (const metadata of row.mappingMetadata ?? []) item.append(renderMappingMetadata(metadata));
      list.append(item);
    }
    section.append(list);
  }
  return section;
}

// Only explicit OMOP provenance permits an Athena link; local standardness and numeric ranges do not.
export function omopTarget(row) {
  const explicit = row.otherConceptOmop;
  if (explicit && String(explicit.conceptId) === String(row.otherId) && /^[1-9]\d*$/.test(String(explicit.conceptId))) return explicit;
  for (const metadata of row.mappingMetadata ?? []) {
    const id = metadata.targetConceptId ?? metadata.target_concept_id;
    if (row.direction === "outgoing" && String(metadata.targetSystem ?? metadata.target_system).toUpperCase() === "OMOP"
      && String(id) === String(row.otherId) && /^[1-9]\d*$/.test(String(id))) {
      return { conceptId: String(id), vocabularyId: metadata.targetVocabulary ?? metadata.target_vocabulary_id ?? metadata.object_source };
    }
    const field = row.direction === "incoming" ? "subject_id" : "object_id";
    const match = /^OMOP:([1-9]\d*)$/i.exec(metadata[field] ?? "");
    if (match && match[1] === String(row.otherId)) return {
      conceptId: match[1], vocabularyId: metadata[row.direction === "incoming" ? "subject_source" : "object_source"],
    };
  }
  return null;
}

export function mappingMetadataFields(metadata) {
  const pick = (...keys) => keys.map((key) => metadata[key]).find((value) => value !== undefined && value !== null && value !== "");
  return [
    ["Predicate ID", pick("predicate_id", "predicateId")],
    ["Confidence", pick("confidence", "mapping_confidence", "mappingConfidence")],
    ["Author", pick("author_label", "author", "author_id", "creator_id", "creatorId")],
    ["Reviewer", pick("reviewer_label", "reviewer", "reviewer_id", "reviewerId")],
    [[true, "true", "1", 1].includes(metadata.publicationDateDerived ?? metadata.publication_date_derived) ? "Publication date (derived)" : "Publication date",
      pick("publication_date", "publicationDate")],
    ["Mapping date", pick("mapping_date", "mappingDate")],
    ["Source system", pick("source_code_set", "sourceCodeSet")],
    ["Source review status", pick("status")],
    ["Source decision", pick("decision")],
  ].filter(([, value]) => value !== undefined);
}

function renderMappingMetadata(metadata) {
  const fields = makeElement("dl", { className: "detail-grid detail-grid-compact mapping-metadata" });
  for (const [label, value] of mappingMetadataFields(metadata)) appendTextRow(fields, label, Array.isArray(value) ? value.join(", ") : value);
  if (!fields.childNodes.length) appendTextRow(fields, "Mapping metadata", "No requested fields supplied");
  return fields;
}

// Keep the source wording and never infer a name for an unverified target.
export function mappingRecordFields(record) {
  const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== "") ?? "Not supplied";
  const name = pick(record.source_description, record.subject_label);
  const code = pick(record.subjectCode, record.source_code, record.subject_id);
  const source = name !== "Not supplied" && code !== "Not supplied" && name !== code ? `${name} (${code})` : pick(name === "Not supplied" ? null : name, code);
  return [
    ["Source", source],
    ["Predicate", pick(record.predicate_id, record.predicateId)],
    ["Confidence", pick(record.confidence, record.mapping_confidence, record.mappingConfidence)],
    ["Target code", pick(record.objectCode, record.target_code, record.target_concept_code, record.object_id)],
    ["Target name", pick(record.target_description, record.object_label, record.target_concept_name)],
  ];
}

function renderMappingRecords(records) {
  const section = detailSection(`Additional mapping records (${records.length.toLocaleString()})`);
  section.append(emptyDetail("These records identify this source concept but could not be attached to one unambiguous relationship. Target codes are not OMOP concept IDs."));
  for (const record of records) {
    const card = makeElement("article", { className: "mapping-record" });
    const fields = makeElement("dl", { className: "mapping-record-sequence" });
    for (const [label, value] of mappingRecordFields(record)) appendTextRow(fields, label, value);
    card.append(fields);
    const details = makeElement("details", { className: "mapping-record-details" });
    details.append(makeElement("summary", { text: "More mapping details" }));
    const extra = makeElement("dl", { className: "detail-grid detail-grid-compact" });
    for (const [label, value] of [
      ["Source vocabulary", record.subjectVocabulary],
      ["Target vocabulary", record.objectVocabulary],
      ["Mapping record ID", record.mapping_concept_id],
      ["Source file", record.sourceFile],
      ...mappingMetadataFields(record).filter(([label]) => label !== "Predicate ID" && label !== "Confidence"),
    ]) if (value != null && value !== "") appendTextRow(extra, label, Array.isArray(value) ? value.join(", ") : value);
    if (extra.childNodes.length) { details.append(extra); card.append(details); }
    section.append(card);
  }
  return section;
}

export function directHierarchy(details) {
  const parents = new Map();
  const children = new Map();
  const add = (map, id, row, evidence = null, inverse = false) => {
    const targetId = String(id ?? "");
    if (!/^[1-9]\d*$/u.test(targetId) || targetId === String(details.concept?.conceptId)) return;
    if (!map.has(targetId)) map.set(targetId, { ...row, id: targetId });
    if (evidence) {
      const entry = map.get(targetId);
      // Incoming evidence describes the original other-to-current direction, so it
      // must not be presented as a predicate originating at the current concept.
      const evidenceKey = inverse ? "hierarchyInverseMetadata" : "hierarchyMetadata";
      entry[evidenceKey] ??= [];
      if (!entry[evidenceKey].includes(evidence)) entry[evidenceKey].push(evidence);
      if (!entry.otherConcept && row.otherConcept) entry.otherConcept = row.otherConcept;
      if (!entry.otherConceptOmop && row.otherConceptOmop) entry.otherConceptOmop = row.otherConceptOmop;
    }
  };
  for (const row of details.ancestors ?? []) if (row.minLevelsOfSeparation === 1) add(parents, row.ancestorConceptId, row);
  for (const row of details.descendants ?? []) if (row.minLevelsOfSeparation === 1) add(children, row.descendantConceptId, row);
  for (const row of semanticRelationships(details)) {
    if (row.invalidReason) continue;
    if (row.label === "Is a") add(parents, row.otherId, row);
    if (row.label === "Subsumes") add(children, row.otherId, row);
  }
  const addMapping = (record, incoming) => {
    if (record.targetIdentityVerified !== true || record.invalid_reason || record.invalidReason) return;
    const predicate = String(record.predicate_id ?? record.predicateId ?? "").trim().toLowerCase();
    if (!["skos:broadmatch", "skos:narrowmatch"].includes(predicate)) return;
    const subjectId = String(record.subjectConceptId ?? "");
    const objectId = String(record.objectConceptId ?? "");
    if (!/^[1-9]\d*$/u.test(subjectId) || !/^[1-9]\d*$/u.test(objectId)
      || (incoming ? objectId : subjectId) !== String(details.concept?.conceptId)) return;
    const otherId = incoming ? subjectId : objectId;
    const isParent = (predicate === "skos:broadmatch") !== incoming;
    const sourceDeclared = !incoming && !record.otherConcept && record.targetIdentityEvidence && record.objectVocabulary
      ? { conceptId: otherId, vocabularyId: record.objectVocabulary, sourceDeclared: true, provenance: record.targetIdentityEvidence }
      : null;
    add(isParent ? parents : children, otherId, { ...record, otherConceptOmop: sourceDeclared }, record, incoming);
  };
  for (const record of details.concept?.mappingMetadata ?? []) addMapping(record, false);
  for (const record of details.incomingMappingMetadata ?? []) addMapping(record, true);
  return { parents: [...parents.values()], children: [...children.values()] };
}

/** Keep inverse predicates in their original source-to-target direction. */
export function hierarchyInverseRecords(hierarchy) {
  const seen = new Set();
  return [...(hierarchy.parents ?? []), ...(hierarchy.children ?? [])]
    .flatMap((row) => row.hierarchyInverseMetadata ?? [])
    .filter((record) => {
      const key = record.sourceFile && record.sourceRow != null
        ? JSON.stringify([record.sourceFile, record.sourceRow]) : record;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renderHierarchy(details, onSelectRelated) {
  const { parents, children } = directHierarchy(details);
  const section = detailSection("Hierarchy");
  const columns = makeElement("div", { className: "hierarchy-grid" });
  columns.append(hierarchyColumn("Is a · direct parents", parents, onSelectRelated),
    hierarchyColumn("Subsumes · direct children", children, onSelectRelated));
  section.append(columns);
  const inverseRecords = hierarchyInverseRecords({ parents, children });
  if (inverseRecords.length) {
    const sourceEvidence = makeElement("details", { className: "hierarchy-inverse-evidence" });
    sourceEvidence.append(makeElement("summary", { text: `Original inverse mapping records (${inverseRecords.length.toLocaleString()})` }));
    sourceEvidence.append(emptyDetail("These source-to-target records support the reverse direction shown in the hierarchy."));
    for (const record of inverseRecords) {
      const item = makeElement("article");
      const endpoints = makeElement("dl", { className: "detail-grid detail-grid-compact" });
      appendTextRow(endpoints, "Original source concept ID", record.subjectConceptId);
      appendTextRow(endpoints, "Original target concept ID", record.objectConceptId);
      if (record.sourceFile) appendTextRow(endpoints, "Source file", record.sourceFile);
      if (record.sourceRow != null) appendTextRow(endpoints, "Source row", record.sourceRow);
      item.append(endpoints, renderMappingMetadata(record));
      sourceEvidence.append(item);
    }
    section.append(sourceEvidence);
  }
  const ancestors = (details.ancestors ?? []).filter((row) => row.minLevelsOfSeparation > 1).map((row) => ({ ...row, id: row.ancestorConceptId }));
  const descendants = (details.descendants ?? []).filter((row) => row.minLevelsOfSeparation > 1).map((row) => ({ ...row, id: row.descendantConceptId }));
  if (ancestors.length || descendants.length) {
    const expanded = makeElement("details");
    expanded.append(makeElement("summary", { text: "More distant ancestors and descendants" }));
    expanded.append(hierarchyColumn("Ancestors · more than one level", ancestors, onSelectRelated),
      hierarchyColumn("Descendants · more than one level", descendants, onSelectRelated));
    section.append(expanded);
  }
  return section;
}

function hierarchyColumn(heading, rows, onSelectRelated) {
  const column = makeElement("div", { className: "hierarchy-column" });
  column.append(makeElement("h4", { text: `${heading} (${rows.length.toLocaleString()})` }));
  if (!rows.length) {
    column.append(emptyDetail("No links supplied."));
    return column;
  }
  const list = makeElement("ul", { className: "detail-list" });
  for (const row of rows) {
    const item = makeElement("li");
    item.append(relatedConcept(row.id, row.otherConcept, onSelectRelated, row.otherConceptOmop));
    if (row.minLevelsOfSeparation != null) item.append(makeElement("small", { text: `${row.minLevelsOfSeparation}–${row.maxLevelsOfSeparation} levels` }));
    for (const metadata of row.hierarchyMetadata ?? []) {
      item.append(makeElement("small", { text: "Hierarchy from mapping metadata" }), renderMappingMetadata(metadata));
    }
    list.append(item);
  }
  column.append(list);
  return column;
}

function relatedConcept(id, concept, onSelectRelated, verifiedOmop = null) {
  if (!concept) return makeElement("span", { className: "external-concept", text: verifiedOmop
    ? `OMOP ID: ${id}` : `Concept ID: ${id} · target not verified`,
    attributes: verifiedOmop?.sourceDeclared ? { title: "OMOP identifier declared by the source mapping; not independently checked against a live Athena release." } : {},
  });
  const button = makeElement("button", { className: "related-concept", text: `${concept.conceptName} (${id})`, attributes: { type: "button" } });
  button.addEventListener("click", () => onSelectRelated(concept.key ?? concept.conceptId ?? id));
  return button;
}

function detailSection(heading) {
  const section = makeElement("section", { className: "detail-section" });
  section.append(makeElement("h3", { text: heading }));
  return section;
}
function emptyDetail(message) { return makeElement("p", { className: "empty-detail", text: message }); }
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
