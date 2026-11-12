import { conceptCodeKey } from "../model/codeMatching.js";
import { parseConceptRows, REQUIRED_CONCEPT_COLUMNS, validateDate } from "../model/concept.js";
import { validateConceptDraft } from "./conceptDraftValidation.js";
import { createMappingSubmissionDraft } from "./mappingBatchService.js";

/** Run bounded, read-only checks on the loaded concepts; source parser findings remain visible. */
export function runQualityChecks(state, now = new Date()) {
  const dataset = state.dataset;
  const findings = [];
  const add = (severity, code, message, concept = null) => findings.push({
    severity, code, message,
    packageId: concept?.packageId ?? concept?.source?.packageId ?? concept?.provenance?.packageId ?? dataset?.entry?.packageId ?? null,
    conceptId: concept?.conceptId ?? null,
    sourceFile: concept?.source?.file ?? concept?.provenance?.sourceFile ?? concept?.sourceFile ?? null,
    sourceRow: concept?.source?.row ?? concept?.provenance?.sourceRow ?? concept?.sourceRow ?? null,
  });
  const allPackages = state.selectedPackageId === "__all__";
  const aggregate = allPackages || Array.isArray(dataset?.packages);
  const selectedIds = new Set((dataset?.packages ?? []).map((item) => item.entry.packageId));
  const entriesById = new Map();
  const candidates = aggregate
    ? [...(state.manifest?.vocabularies ?? []).filter((entry) => allPackages || selectedIds.has(entry.packageId)), ...(dataset?.packages ?? []).map((item) => item.entry)]
    : [dataset?.entry ?? state.manifest?.vocabularies?.find((entry) => entry.packageId === state.selectedPackageId)];
  for (const entry of candidates.filter(Boolean)) {
    const previous = entriesById.get(entry.packageId);
    entriesById.set(entry.packageId, {
      ...previous, ...entry,
      errors: [...new Set([...(previous?.errors ?? []), ...(entry.errors ?? [])])],
      warnings: [...new Set([...(previous?.warnings ?? []), ...(entry.warnings ?? [])])],
    });
  }
  const entries = [...entriesById.values()];
  const representedWarnings = new Set();
  for (const entry of entries) {
    for (const message of entry.errors ?? []) findings.push({ severity: "error", code: "source-error", message: String(message), packageId: entry.packageId });
    for (const message of entry.warnings ?? []) {
      findings.push({ severity: "warning", code: "source-warning", message: String(message), packageId: entry.packageId });
      representedWarnings.add(`${entry.packageId}: ${message}`);
    }
  }
  if (aggregate) {
    for (const message of new Set(dataset?.entry?.warnings ?? [])) {
      if (!representedWarnings.has(String(message))) findings.push({ severity: "warning", code: "source-warning", message: String(message), packageId: state.selectedPackageId });
    }
  }
  if (!dataset) add("error", "no-dataset", "No searchable dataset is loaded. Source validation findings are shown where available.");
  const concepts = dataset?.concepts ?? [];
  const ids = new Set();
  const codes = new Map();
  for (const concept of concepts) {
    const packageId = concept.packageId ?? concept.source?.packageId ?? concept.provenance?.packageId ?? dataset.entry.packageId;
    const key = JSON.stringify([packageId, concept.conceptId]);
    if (ids.has(key)) add("error", "duplicate-id", "Concept ID occurs more than once in this package.", concept);
    ids.add(key);
    try {
      parseConceptRows({ headers: REQUIRED_CONCEPT_COLUMNS, rows: [{ rowNumber: 1, values: toConceptRow(concept) }] }, { source: "loaded concept", packageId });
    } catch (error) {
      add("error", "invalid-concept", error.message, concept);
    }
    if (compactDate(concept.validStartDate) > compactDate(concept.validEndDate)) add("error", "date-order", "Valid start date is after valid end date.", concept);
    const codeKey = JSON.stringify([packageId, conceptCodeKey(concept.vocabularyId, concept.conceptCode)]);
    if (codes.has(codeKey)) add("warning", "duplicate-code", `Code is also used by concept ${codes.get(codeKey)} in this vocabulary and package.`, concept);
    else codes.set(codeKey, concept.conceptId);
  }
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    status: errors ? "errors" : warnings ? "warnings" : "passed",
    checkedAt: now.toISOString(),
    scope: "Loaded concept fields, package-scoped identifiers, codes and date order, plus source-loader findings. This is not clinical or governance approval; relationship and synonym integrity rely on source-load validation.",
    statistics: { concepts: concepts.length, packages: entries.length, errors, warnings },
    findings,
  };
}

export function createSubmissionDraft(values, context = {}, now = new Date()) {
  const kind = values.kind === "mapping" ? "mapping" : "concept";
  if (kind === "mapping") return createMappingSubmissionDraft(values, context, now);
  const errors = [];
  const clean = (name) => String(values[name] ?? "").trim();
  const validated = validateConceptDraft(values, context);
  const record = validated.record;
  errors.push(...validated.errors);
  const author = clean("author");
  if (!author) errors.push("Author is required.");
  const authorAffiliation = clean("author_affiliation");
  if (!authorAffiliation) errors.push("Author affiliation is required.");
  const reviewerAffiliation = clean("reviewer_affiliation");
  const rationale = clean("rationale");
  const publicationDate = clean("publication_date");
  if (publicationDate) {
    try { validateDate(publicationDate, { source: "draft", rowNumber: 1, field: "publication_date" }); } catch (error) { errors.push(error.message); }
  }
  if (errors.length) return { valid: false, errors, draft: null };
  return {
    valid: true, errors: [], draft: {
      schema: "cvb-review-draft/1", status: "draft-not-submitted", kind,
      createdAt: now.toISOString(),
      context: { source: context.source ?? null, packageId: context.packageId ?? null },
      record,
      metadata: { author, authorAffiliation: authorAffiliation || null, reviewer: clean("reviewer") || null, reviewerAffiliation: reviewerAffiliation || null, publicationDate: publicationDate || null, rationale },
      verification_warnings: validated.warnings,
      notice: "Local review draft only. No ID allocation, approval, publication or external submission has occurred. You may open a GitHub issue composer for your chosen repository and review it there before publishing; that repository controls its review policy.",
    },
  };
}

function compactDate(value) { return String(value ?? "").replaceAll("-", ""); }
function toConceptRow(concept) {
  return {
    concept_id: String(concept.conceptId ?? ""), concept_name: concept.conceptName ?? "",
    domain_id: concept.domainId ?? "", vocabulary_id: concept.vocabularyId ?? "",
    concept_class_id: concept.conceptClassId ?? "", standard_concept: concept.standardConcept ?? "",
    concept_code: concept.conceptCode ?? "", valid_start_date: concept.validStartDate ?? "",
    valid_end_date: concept.validEndDate ?? "", invalid_reason: concept.invalidReason ?? "",
  };
}


export const DEFAULT_ISSUE_REPOSITORY = "OHDSI/CustomVocabularyBrowser";
export const MAX_ISSUE_URL_LENGTH = 7500;

/** Build an explicit user-opened GitHub composer URL. This never creates an issue. */
export function createGitHubIssueDraft(draft, repository = DEFAULT_ISSUE_REPOSITORY) {
  const destination = String(repository ?? "").trim();
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/u.exec(destination);
  if (!match || [".", ".."].includes(match[2])) {
    throw new Error("Enter a GitHub destination as owner/repository, without a URL, query, or fragment.");
  }
  if (!draft || draft.status !== "draft-not-submitted" || !["concept", "mapping", "batch"].includes(draft.kind)) {
    throw new Error("Validate and preview a concept, mapping, or batch draft first.");
  }
  const name = String(draft.record?.concept_name ?? draft.record?.subject_id ?? "Review request");
  const title = `Custom ${draft.kind} proposal: ${name}`.replace(/[\r\n]+/gu, " ").slice(0, 180);
  const json = JSON.stringify(draft, null, 2);
  const intro = "Please review this proposed custom vocabulary record. This is not approved or published vocabulary content.";
  const url = new URL(`https://github.com/${destination}/issues/new`);
  url.searchParams.set("title", title);
  url.searchParams.set("body", `${intro}\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  const includesJson = url.href.length <= MAX_ISSUE_URL_LENGTH;
  if (!includesJson) {
    url.searchParams.set("body", `${intro}\n\nThe JSON draft was too large for a reliable prefilled link. Please paste the complete downloaded JSON here, or attach it if GitHub permits, before submitting this issue.\n\n[Add JSON draft here]`);
  }
  return {
    url: url.href, repository: destination, includesJson,
    notice: includesJson
      ? `Opening this link sends the previewed JSON to GitHub's issue composer for ${destination}. Review it and click Submit new issue on GitHub to publish. Sign in there if asked. This application does not publish the issue.`
      : `The JSON is too large for the link. Download it first, then open the issue composer for ${destination} and paste or attach it there. No JSON is included in this link. Review before publishing on GitHub.`,
  };
}
