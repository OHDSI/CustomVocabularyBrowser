import { DEFAULT_PAGE_SIZE, DEFAULT_SOURCE } from "./config.js";
import { LOCAL_SOURCE_PLACEHOLDER } from "./services/localDirectoryService.js";
import { resolveSource } from "./services/sourceResolver.js";

const BLANK_SENTINEL = "~blank~";
const FILTER_PARAMETERS = Object.freeze({
  vocabularyId: "vocabulary-id",
  domainId: "domain",
  conceptClassId: "class",
  standardConcept: "standard",
  invalidReason: "validity",
});

export function readUrlState(search = globalThis.location?.search ?? "") {
  const parameters = new URLSearchParams(search);
  const repository = parameters.get("repository");
  const ref = parameters.get("ref");
  const localSourceRequested = parameters.get("local-source") === "1";
  let source = localSourceRequested ? LOCAL_SOURCE_PLACEHOLDER : DEFAULT_SOURCE;
  if (!localSourceRequested && repository) source = resolveSource(`${repository}@${ref || "main"}`);

  const filters = {};
  for (const [field, parameter] of Object.entries(FILTER_PARAMETERS)) {
    filters[field] = parameters.getAll(parameter).map(decodeFilterValue);
  }

  const page = positiveInteger(parameters.get("page"), 1);
  const pageSize = positiveInteger(parameters.get("page-size"), DEFAULT_PAGE_SIZE);
  const sortField = parameters.get("sort");
  const sortDirection = parameters.get("direction") === "desc" ? "desc" : "asc";

  return {
    source,
    localSourceRequested,
    selectedPackageId: parameters.get("vocabulary") || null,
    query: parameters.get("q") ?? "",
    filters,
    page,
    pageSize,
    sort: sortField ? { field: sortField, direction: sortDirection } : null,
    selectedConceptId: parameters.get("concept") || null,
  };
}

export function createShareableUrl(state, currentUrl = globalThis.location?.href ?? "https://example.invalid/") {
  const url = new URL(currentUrl);
  const parameters = new URLSearchParams();
  const source = state.source ?? DEFAULT_SOURCE;
  if (source.provider === "local-directory") {
    parameters.set("local-source", "1");
  } else {
    parameters.set("repository", `${source.owner}/${source.repository}`);
    parameters.set("ref", source.ref);
  }
  if (state.selectedPackageId) parameters.set("vocabulary", state.selectedPackageId);
  if (state.query) parameters.set("q", state.query);
  for (const [field, parameter] of Object.entries(FILTER_PARAMETERS)) {
    for (const value of state.filters?.[field] ?? []) {
      parameters.append(parameter, encodeFilterValue(value));
    }
  }
  if ((state.page ?? 1) !== 1) parameters.set("page", String(state.page));
  if ((state.pageSize ?? DEFAULT_PAGE_SIZE) !== DEFAULT_PAGE_SIZE) {
    parameters.set("page-size", String(state.pageSize));
  }
  if (state.sort?.field) {
    parameters.set("sort", state.sort.field);
    parameters.set("direction", state.sort.direction === "desc" ? "desc" : "asc");
  }
  if (state.selectedConceptId) parameters.set("concept", String(state.selectedConceptId));
  url.search = parameters.toString();
  return url.href;
}

export function replaceUrlState(state) {
  if (!globalThis.history?.replaceState || !globalThis.location?.href) return;
  globalThis.history.replaceState(null, "", createShareableUrl(state));
}

function encodeFilterValue(value) {
  return value === null ? BLANK_SENTINEL : String(value);
}

function decodeFilterValue(value) {
  return value === BLANK_SENTINEL ? null : value;
}

function positiveInteger(value, fallback) {
  if (!/^\d+$/u.test(value ?? "")) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
