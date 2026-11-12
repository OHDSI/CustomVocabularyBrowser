import { makeElement, showModal, clearNode } from "./dom.js";
import { createSubmissionDraft, runQualityChecks, createGitHubIssueDraft, DEFAULT_ISSUE_REPOSITORY } from "../services/reviewService.js";
import { renderConceptFields } from "./conceptDraftForm.js";
import { renderMappingFields, getMappingValues, createBatchDraftUI } from "./mappingBatch.js";
import { createMappingSubmissionDraft } from "../services/mappingBatchService.js";

// Local issue URLs are kept in memory until the user explicitly confirms disclosure.
export function issueDraftForSource(draft, source, destination) {
  if (source?.provider === "local-directory") return null;
  return createGitHubIssueDraft(draft, destination);
}

export function createLocalIssueConfirmationGate() {
  let pending = null;
  return {
    prepare(draft, destination) {
      const issue = createGitHubIssueDraft(draft, destination);
      const url = new URL(issue.url);
      pending = { issue, draft, destination: String(destination).trim() };
      return { recipient: `${url.origin}${url.pathname}`, title: url.searchParams.get("title") ?? "",
        body: url.searchParams.get("body") ?? "", includesJson: issue.includesJson };
    },
    cancel() { pending = null; },
    confirm(draft, destination, open) {
      const value = pending;
      pending = null;
      if (!value || value.draft !== draft || value.destination !== String(destination).trim()) return false;
      open(value.issue.url);
      return true;
    },
  };
}

export function createReviewWorkspace({ getState }) {
  const root = document.getElementById("review-workspace");
  if (!root) throw new Error("The review workspace mount is missing.");
  const qualityButton = button("Vocabulary quality control");
  const submissionButton = button("Submit custom concept");
  const faqButton = button("FAQ");
  const badge = makeElement("span", { className: "review-status", attributes: { "aria-live": "polite" } });
  root.append(qualityButton, submissionButton, faqButton, badge);
  const quality = createDialog("quality-dialog", "Vocabulary quality control");
  const submission = createDialog("submission-dialog", "Submit a custom concept or mapping");
  const faq = createDialog("faq-dialog", "Frequently asked questions");
  renderFaq(faq.content);
  faqButton.addEventListener("click", () => showModal(faq.dialog));
  root.append(quality.dialog, submission.dialog, faq.dialog);
  let checkedDataset = null;
  let checkedManifest = null;
  let report = null;
  let currentDraft = null;
  let draftContext = null;
  let draftDataset = null;
  let draftSource = null;
  let conceptFields = null;
  let batchControl = null;
  const runButton = button("Run quality checks");
  const qualityBody = makeElement("div");
  quality.content.append(runButton, qualityBody);

  qualityButton.addEventListener("click", () => {
    renderQuality();
    showModal(quality.dialog);
  });
  runButton.addEventListener("click", () => {
    const state = getState();
    report = runQualityChecks(state);
    checkedDataset = state.dataset;
    checkedManifest = state.manifest;
    renderQuality();
    badge.textContent = reportLabel(report);
  });

  const notice = makeElement("p", { className: "field-help", text: "Validating a proposal prepares a JSON preview and opens a prefilled GitHub issue for the destination below. Opening the issue shares its contents with GitHub; only your final submission there publishes it. Do not include credentials, patient data or confidential information." });
  const form = makeElement("form", { className: "review-form", attributes: { novalidate: "" } });
  const kindField = field("kind", "Draft type", "select", [["concept", "Custom concept"], ["mapping", "Mapping"], ["batch", "Batch JSON"]]);
  const fieldsContainer = makeElement("div", { className: "review-form-fields" });
  const metadata = makeElement("div", { className: "review-form-fields" });
  for (const [name, label, type] of [
    ["author", "Author (required)", "text"], ["author_affiliation", "Author affiliation (required)", "text"],
    ["reviewer", "Reviewer (optional)", "text"], ["reviewer_affiliation", "Reviewer affiliation (optional)", "text"],
    ["publication_date", "Publication date (optional, as supplied)", "date"],
    ["rationale", "Rationale / evidence (optional)", "textarea"],
  ]) metadata.append(field(name, label, type));
  const previewButton = button("Validate and preview");
  previewButton.type = "submit";
  const downloadButton = button("Download draft JSON");
  downloadButton.disabled = true;
  const feedback = makeElement("div", { className: "review-error", attributes: { role: "status", "aria-live": "polite" } });
  const preview = makeElement("pre", { className: "review-preview", attributes: { tabindex: "0", "aria-label": "Submission draft preview" } });
  preview.hidden = true;
  const batchContainer = makeElement("div", { className: "review-batch" });
  form.append(kindField, fieldsContainer, metadata, batchContainer, previewButton, downloadButton);
  const destinationField = field("issue_repository", "GitHub issue destination (owner/repository)", "text");
  const destinationInput = destinationField.querySelector("input");
  destinationInput.value = DEFAULT_ISSUE_REPOSITORY;
  destinationInput.autocomplete = "off";
  const issueNotice = makeElement("p", { className: "field-help", attributes: { role: "status", "aria-live": "polite" } });
  const localGate = createLocalIssueConfirmationGate();
  const localReviewButton = button("Review GitHub sharing");
  localReviewButton.hidden = true;
  const disclosure = makeElement("section", { className: "detail-section", attributes: { "aria-label": "Confirm sharing with GitHub" } });
  disclosure.hidden = true;
  const disclosureText = makeElement("p");
  const disclosureTitle = makeElement("pre", { className: "review-preview", attributes: { tabindex: "0", "aria-label": "Title sent to GitHub" } });
  const disclosureBody = makeElement("pre", { className: "review-preview", attributes: { tabindex: "0", "aria-label": "Body sent to GitHub" } });
  const confirmShare = button("Confirm and open GitHub");
  const cancelShare = button("Cancel sharing");
  disclosure.append(makeElement("h3", { text: "Confirm sharing with GitHub" }), disclosureText,
    makeElement("h4", { text: "Title sent" }), disclosureTitle, makeElement("h4", { text: "Body sent" }), disclosureBody,
    confirmShare, cancelShare);
  let disclosureGuard = null;
  function cancelLocalSharing() {
    localGate.cancel(); disclosureGuard = null; disclosure.hidden = true;
    disclosureText.textContent = ""; disclosureTitle.textContent = ""; disclosureBody.textContent = "";
  }
  localReviewButton.addEventListener("click", () => {
    cancelLocalSharing();
    if (!currentDraft || draftSource?.provider !== "local-directory") return;
    try {
      const shown = localGate.prepare(currentDraft, destinationInput.value);
      disclosureGuard = { draft: currentDraft, source: draftSource, dataset: draftDataset,
        packageId: draftContext?.packageId, destination: destinationInput.value };
      disclosureText.textContent = `Recipient: ${shown.recipient}. Opening GitHub sends the exact title and body below before an issue is submitted. ${shown.includesJson ? "The body includes the JSON draft." : "The JSON is not included in the link; download and paste or attach it manually if you choose."}`;
      disclosureTitle.textContent = shown.title;
      disclosureBody.textContent = shown.body;
      disclosure.hidden = false;
    } catch (error) { issueNotice.textContent = error.message; }
  });
  cancelShare.addEventListener("click", cancelLocalSharing);
  confirmShare.addEventListener("click", () => {
    const state = getState();
    const guard = disclosureGuard;
    if (!guard || !submission.dialog.open || guard.draft !== currentDraft || guard.source !== state.source ||
      guard.dataset !== state.dataset || guard.packageId !== state.selectedPackageId || guard.destination !== destinationInput.value) {
      cancelLocalSharing(); return;
    }
    localGate.confirm(currentDraft, destinationInput.value, (url) => {
      const link = makeElement("a", { attributes: { href: url, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer" } });
      document.body.append(link); link.click(); link.remove();
    });
    cancelLocalSharing();
    issueNotice.textContent = "GitHub opening requested. Review and submit the issue there if you choose.";
  });
  const issueLink = makeElement("a", { className: "button button-primary", text: "Open GitHub issue draft", attributes: { target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer" } });
  issueLink.hidden = true;
  destinationInput.addEventListener("input", () => { batchControl?.invalidate(); cancelLocalSharing(); updateIssueLink(); });
  submission.content.append(notice, form, feedback, preview, destinationField, issueNotice, issueLink, localReviewButton, disclosure);
  batchControl = createBatchDraftUI({
    captureGuard: () => ({ context: draftContext, dataset: draftDataset, source: draftSource, destination: destinationInput.value }),
    isCurrent: (guard) => {
      const state = getState();
      return submission.dialog.open && kindField.querySelector("select").value === "batch" &&
        guard.context === draftContext && guard.dataset === state.dataset && guard.source === state.source &&
        guard.context?.packageId === state.selectedPackageId && guard.destination === destinationInput.value;
    },
    validateConcept: createSubmissionDraft,
    onDraft: showDraft,
  });
  batchContainer.append(batchControl.root);
  submission.dialog.addEventListener("close", invalidatePreview);

  function renderDraftFields() {
    clearNode(fieldsContainer);
    const kind = kindField.querySelector("select").value;
    metadata.hidden = kind !== "concept";
    batchContainer.hidden = kind !== "batch";
    previewButton.hidden = kind === "batch";
    if (kind === "concept") conceptFields = renderConceptFields(fieldsContainer, draftContext ?? {});
    else {
      conceptFields = null;
      if (kind === "mapping") renderMappingFields(fieldsContainer);
    }
    invalidatePreview();
  }
  kindField.querySelector("select").addEventListener("change", renderDraftFields);
  form.addEventListener("input", invalidatePreview);
  form.addEventListener("change", invalidatePreview);
  renderDraftFields();

  submissionButton.addEventListener("click", () => {
    const state = getState();
    draftDataset = state.dataset;
    draftSource = state.source;
    notice.textContent = draftSource?.provider === "local-directory"
      ? "Local drafts stay in this browser until you explicitly confirm sharing. You can validate and download the JSON, or review exactly what would be sent to GitHub."
      : "Validating a proposal prepares a JSON preview and opens a prefilled GitHub issue for the destination below. Opening the issue shares its contents with GitHub; only your final submission there publishes it. Do not include credentials, patient data or confidential information.";
    draftContext = {
      source: state.source?.provider === "local-directory" ? "local-folder" : state.source?.canonical ?? null,
      packageId: state.selectedPackageId,
      existingConceptIds: new Set(state.dataset?.concepts?.map((concept) => String(concept.conceptId)) ?? []),
      customConcepts: state.dataset?.concepts ?? [],
      concepts: state.dataset?.concepts ?? [],
    };
    renderDraftFields();
    invalidatePreview();
    const contextLabel = state.selectedPackageId === "__all__" ? "all packages; choose the intended vocabulary explicitly"
      : state.dataset?.packages ? state.dataset.packages.map((item) => item.entry.displayName ?? item.entry.packageId).join(", ")
        : state.selectedPackageId ?? "no package selected";
    feedback.textContent = `Review context: ${contextLabel}.`;
    showModal(submission.dialog);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const kind = kindField.querySelector("select").value;
    if (kind === "batch") return;
    const values = kind === "mapping" ? getMappingValues(form) : { ...Object.fromEntries(new FormData(form)), ...(conceptFields?.values() ?? {}) };
    const result = kind === "mapping" ? createMappingSubmissionDraft(values, draftContext ?? {}) : createSubmissionDraft(values, draftContext ?? {});
    showDraft(result);
  });
  function showDraft(result) {
    currentDraft = result.valid ? result.draft : null;
    cancelLocalSharing();
    updateIssueLink();
    clearNode(feedback);
    if (!result.valid) {
      const list = makeElement("ul");
      for (const error of result.errors) list.append(makeElement("li", { text: error }));
      feedback.append(list);
      preview.hidden = true;
      downloadButton.disabled = true;
      return;
    }
    feedback.textContent = "Draft validated for preview. Not submitted, approved or published.";
    if (currentDraft.verification_warnings?.length) {
      const list = makeElement("ul");
      for (const warning of currentDraft.verification_warnings) list.append(makeElement("li", { text: `Unverified: ${warning}` }));
      feedback.append(list);
    }
    preview.textContent = JSON.stringify(currentDraft, null, 2);
    preview.hidden = false;
    downloadButton.disabled = false;
    updateIssueLink();
    if (!issueLink.hidden && issueLink.href && !issueLink.textContent.includes("paste JSON")) issueLink.click();
  }
  downloadButton.addEventListener("click", () => {
    if (!currentDraft) return;
    const blob = new Blob([JSON.stringify(currentDraft, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = makeElement("a", { attributes: { href: url, download: `cvb-${currentDraft.kind}-draft.json` } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback.textContent = "Draft download requested. Nothing has been sent to a reviewer or repository.";
  });

  function invalidatePreview() {
    batchControl?.invalidate();
    cancelLocalSharing();
    currentDraft = null;
    preview.hidden = true;
    preview.textContent = "";
    downloadButton.disabled = true;
    feedback.textContent = "";
    issueLink.hidden = true;
    issueLink.removeAttribute("href");
    localReviewButton.hidden = true;
    issueNotice.textContent = "Validate and preview the JSON before opening GitHub.";
  }
  function updateIssueLink() {
    issueLink.hidden = true;
    issueLink.removeAttribute("href");
    localReviewButton.hidden = true;
    if (draftSource?.provider === "local-directory") {
      issueNotice.textContent = currentDraft ? "Review the exact recipient and contents before choosing whether to open GitHub." : "Validate and preview the JSON before reviewing GitHub sharing.";
      localReviewButton.hidden = !currentDraft;
      return;
    }
    if (!currentDraft) {
      issueNotice.textContent = "Validate and preview the JSON before opening GitHub.";
      return;
    }
    try {
      const issue = issueDraftForSource(currentDraft, draftSource, destinationInput.value);
      issueLink.href = issue.url;
      issueLink.hidden = false;
      issueNotice.textContent = issue.notice;
      issueLink.textContent = issue.includesJson ? "Open GitHub issue draft" : "Open GitHub issue form (paste JSON)";
    } catch (error) {
      issueNotice.textContent = error.message;
    }
  }
  function renderQuality() {
    clearNode(qualityBody);
    if (!report) {
      qualityBody.append(makeElement("p", { text: "Not checked in this workspace. Click Run quality checks to inspect the current dataset and source-loader findings." }));
      return;
    }
    qualityBody.append(makeElement("h3", { text: reportLabel(report) }), makeElement("p", { text: report.scope }));
    const stats = report.statistics;
    qualityBody.append(makeElement("p", { text: `${stats.concepts.toLocaleString()} concepts · ${stats.packages} packages · ${stats.errors} errors · ${stats.warnings} warnings. Checked ${report.checkedAt}.` }));
    if (!report.findings.length) qualityBody.append(makeElement("p", { text: "No findings in these checks. This does not establish clinical correctness or readiness for publication." }));
    const list = makeElement("ol", { className: "review-findings" });
    for (const finding of report.findings.slice(0, 500)) {
      list.append(makeElement("li", { text: `${finding.severity.toUpperCase()} · ${finding.packageId ?? "source"}${finding.conceptId ? ` · concept ${finding.conceptId}` : ""}${finding.sourceFile ? ` · ${finding.sourceFile}` : ""}${finding.sourceRow ? `:${finding.sourceRow}` : ""}: ${finding.message}` }));
    }
    qualityBody.append(list);
    if (report.findings.length > 500) qualityBody.append(makeElement("p", { text: `Showing the first 500 of ${report.findings.length.toLocaleString()} findings. Download the complete report below.` }));
    const exportButton = button("Download full quality report");
    exportButton.addEventListener("click", () => downloadReport(report));
    qualityBody.append(exportButton);
  }

  return {
    render(state) {
      if (checkedDataset !== state.dataset || checkedManifest !== state.manifest) {
        report = null;
        checkedDataset = state.dataset;
        checkedManifest = state.manifest;
        badge.textContent = "";
        if (quality.dialog.open) renderQuality();
      }
      if (submission.dialog.open && (draftDataset !== state.dataset || draftSource !== state.source)) {
        invalidatePreview();
        submission.dialog.close();
      }
      runButton.disabled = !state.manifest && !state.dataset;
    },
  };
}

function button(text) { return makeElement("button", { className: "button button-secondary", text, attributes: { type: "button" } }); }
function reportLabel(report) {
  return report.status === "passed" ? "Quality checks: passed within stated scope" : report.status === "errors" ? "Quality checks: errors found" : "Quality checks: warnings found";
}
function createDialog(id, title) {
  const dialog = makeElement("dialog", { className: "review-dialog", attributes: { id, "aria-labelledby": `${id}-title` } });
  const heading = makeElement("div", { className: "dialog-heading" });
  const close = button("Close");
  close.addEventListener("click", () => dialog.close());
  heading.append(makeElement("h2", { text: title, attributes: { id: `${id}-title` } }), close);
  const content = makeElement("div", { className: "review-content" });
  dialog.append(heading, content);
  return { dialog, content };
}
function field(name, label, type, options = []) {
  const wrapper = makeElement("div", { className: "field" });
  const id = `draft-${name}`;
  const input = makeElement(type === "select" ? "select" : type === "textarea" ? "textarea" : "input", { attributes: { id, name } });
  if (["author", "author_affiliation"].includes(name)) input.required = true;
  if (type !== "select" && type !== "textarea") input.type = type;
  if (type === "number") { input.min = "0"; input.max = "1"; input.step = "any"; }
  if (type === "textarea") input.rows = 3;
  for (const [value, text] of options) input.append(makeElement("option", { text, attributes: { value } }));
  wrapper.append(makeElement("label", { text: label, attributes: { for: id } }), input);
  return wrapper;
}
function downloadReport(report) {
  const blob = new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = makeElement("a", { attributes: { href: url, download: "cvb-quality-report.json" } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function renderFaq(container) {
  const sections = [
    ["Which vocabulary formats can I browse?", "A browseable package needs concept, concept_synonym and concept_relationship CSV tables, with valid OMOP headers. Both _delta names (for example concept_delta.csv) and basic names (concept.csv) are accepted. Synonym and relationship tables may contain only a valid header when there are no records. Do not supply both filename aliases for one table."],
    ["How should folders be organized?", "Choose the repository root, one package folder, or its Ontology folder. Tables can be inside package/Ontology or directly in the package folder. Public GitHub repositories and local folders are supported. Local files stay in your browser. Local drafts can be downloaded or shared with GitHub only after a separate review and confirmation."],
    ["Can I browse the mapping table used by Custom Vocabulary Builder?", "CSV files in a package Mapping or Mappings folder (case-insensitive) can supply source_code_set and source_category provenance alongside the vocabulary tables. A source concept can be identified by a positive source_concept_id, or by a case-insensitive source_code and an exact source_description that uniquely match within the package. Original code spelling is preserved. A supplied source_vocabulary_id narrows the match; any supplied identifiers and description must agree. Select the repository or package root to include these sibling files, not Ontology alone. A mapping table alone is not a complete browseable package: build or provide the three core OMOP tables first. Mapping provenance is matched only when the source concept can be identified reliably; ambiguous rows are not guessed."],
    ["How can I retain mapping and SSSOM metadata?", "Provide mapping_metadata.csv alongside the core vocabulary tables, in the package's Ontology folder or directly in the package folder. It is supplemental and does not replace concept, concept_synonym or concept_relationship. It can contain mapping details such as predicate_id, confidence, author and reviewer, together with supported source and target identifiers or the CVB composite mapping_concept_code. The browser keeps supplied records and associates them only when the endpoints can be matched reliably within that package; uncertain records remain separate. A mapping_concept_id is a mapping record ID, not an OMOP concept ID. Missing details are not invented."],
    ["What do the SKOS mapping predicates mean?", "For a mapping from source to target, exactMatch indicates a high-confidence match; broadMatch means the target is broader than the source; narrowMatch means the target is narrower than the source; and relatedMatch indicates an association without asserting a hierarchical relationship. The predicate describes the supplied mapping and does not by itself establish an OMOP concept ID or approve the mapping."],
    ["What about hierarchy?", "An optional concept_ancestor table can add hierarchy. Missing hierarchy or mapping metadata is not invented."],
    ["Why is a package absent from Package scope?", "Only browseable packages are offered for selection. Vocabulary quality control retains source validation findings, including missing or invalid required tables. A successful data check is not clinical or governance approval."],
    ["What happens when I submit a custom concept?", "For public sources, validating a proposal shows its JSON preview and attempts to open a prefilled GitHub issue composer, sending the proposal to GitHub. For local sources, preview and download stay on this computer; opening GitHub requires a separate confirmation showing the recipient and exact title and body to be sent. If a browser blocks the popup, use the displayed link. Large drafts must be downloaded and pasted or attached manually. Review the issue and submit it yourself; the browser never publishes automatically. An issue is a review request, not vocabulary approval or ID allocation."],
  ];
  for (const [question, answer] of sections) {
    const section = makeElement("section", { className: "detail-section" });
    section.append(makeElement("h3", { text: question }), makeElement("p", { text: answer }));
    container.append(section);
  }
}
