import { DEFAULT_SOURCE, PAGE_SIZE_OPTIONS } from "./config.js";
import { VocabularyRepository } from "./services/dataService.js";
import { loadSourceManifest } from "./services/manifestService.js";
import { createLocalDirectorySource } from "./services/localDirectoryService.js";
import { resolveSource } from "./services/sourceResolver.js";
import { BrowserStore } from "./store.js";
import { readUrlState, replaceUrlState } from "./urlState.js";
import { createConceptDetails } from "./ui/conceptDetails.js";
import { createFilters } from "./ui/filters.js";
import { createPagination } from "./ui/pagination.js";
import { createSearchControls } from "./ui/search.js";
import { createSourceSelector } from "./ui/sourceSelector.js";
import { createStatusView } from "./ui/status.js";
import { createResultsTable } from "./ui/table.js";

const SUPPORTED_SORT_FIELDS = new Set([
  "conceptId",
  "conceptName",
  "domainId",
  "vocabularyId",
  "conceptClassId",
  "standardConcept",
  "conceptCode",
  "invalidReason",
]);

let initialNotice = "";
let initialState;
try {
  initialState = readUrlState();
} catch (error) {
  initialState = { source: DEFAULT_SOURCE };
  initialNotice = `The URL state was ignored: ${error.message}`;
}

if (initialState.sort?.field && !SUPPORTED_SORT_FIELDS.has(initialState.sort.field)) {
  initialState.sort = null;
  initialNotice = "An unsupported URL sort was ignored.";
}
if (!PAGE_SIZE_OPTIONS.includes(initialState.pageSize)) {
  initialState.pageSize = PAGE_SIZE_OPTIONS[1];
  initialNotice = "An unsupported page size in the URL was ignored.";
}

const store = new BrowserStore(initialState);
let repository = null;
let sourceGeneration = 0;
let packageGeneration = 0;
let detailGeneration = 0;
let queryTimer = null;
let pendingLocalState = initialState.localSourceRequested ? initialState : null;

const sourceSelector = createSourceSelector({
  onSubmit: handleSourceSubmit,
  onDefault: () => {
    pendingLocalState = null;
    void loadSource(DEFAULT_SOURCE, { resetSearch: true });
  },
  onLocalFiles: (files) => loadLocalFiles(files),
  onPackageChange: (packageId) => loadPackage(packageId),
});
const searchControls = createSearchControls({
  onQuery: debounceQuery,
  onClearQuery: clearQuery,
  onClearAll: () => store.clearAllFilters(),
});
const filters = createFilters({ onFilter: (field, values) => store.setFilter(field, values) });
const resultsTable = createResultsTable({
  onSort: (field) => store.setSort(field),
  onSelect: (conceptId) => openConcept(conceptId),
});
const pagination = createPagination({
  onPage: (page) => store.setPage(page),
  onPageSize: (pageSize) => store.setPageSize(pageSize),
});
const statusView = createStatusView();
const conceptDetails = createConceptDetails({
  onClose: () => store.selectConcept(null),
  onSelectRelated: (conceptId) => openConcept(conceptId),
});

const views = [sourceSelector, searchControls, filters, resultsTable, pagination, statusView];
store.subscribe((state) => {
  for (const view of views) view.render(state);
  replaceUrlState(state);
});
for (const view of views) view.render(store.getState());

if (initialState.localSourceRequested) {
  store.setStatus(
    "awaiting-local",
    "Choose the local folder again to restore this view. Browser security prevents automatic access to local files.",
  );
} else {
  void loadSource(initialState.source ?? DEFAULT_SOURCE, {
    isInitial: true,
    requestedPackageId: initialState.selectedPackageId,
    restorePage: initialState.page,
    restoreConceptId: initialState.selectedConceptId,
    notice: initialNotice,
  });
}

function handleSourceSubmit(value, input) {
  try {
    const source = resolveSource(value);
    pendingLocalState = null;
    void loadSource(source, { resetSearch: true });
  } catch (error) {
    store.setStatus("error", error.message, error);
    input.focus();
  }
}

async function loadLocalFiles(files) {
  const token = ++sourceGeneration;
  packageGeneration += 1;
  detailGeneration += 1;
  repository = null;
  conceptDetails.closeWithoutCallback();
  store.setStatus("loading-source", "Reading vocabulary tables from the selected local folder...");

  try {
    const { source, manifest } = await createLocalDirectorySource(files);
    if (token !== sourceGeneration) return;
    const restore = pendingLocalState;
    store.setSource(source);
    if (!restore) store.clearSearchAndFilters();
    repository = new VocabularyRepository({ manifest, source });
    store.setManifest(manifest, repository);

    const requested = findPackage(manifest, restore?.selectedPackageId);
    const firstBrowseable = manifest.vocabularies.find((entry) => entry.browseable);
    const selected = requested?.browseable ? requested : firstBrowseable;
    if (!selected) {
      const unavailable = requested ?? manifest.vocabularies[0];
      if (unavailable) store.setSelectedPackage(unavailable.packageId);
      store.setStatus(
        "unavailable",
        unavailable?.errors?.join(" ") || "The selected folder contains no browseable vocabulary package.",
      );
      return;
    }

    pendingLocalState = null;
    await loadPackage(selected.packageId, {
      sourceToken: token,
      restorePage: restore?.page,
      restoreConceptId: restore?.selectedConceptId,
      notice: "Local files are processed in this browser only.",
    });
  } catch (error) {
    if (token !== sourceGeneration) return;
    store.setStatus("error", error.message || "The local vocabulary folder could not be loaded.", error);
  }
}

async function loadSource(source, options = {}) {
  const token = ++sourceGeneration;
  packageGeneration += 1;
  detailGeneration += 1;
  repository = null;
  conceptDetails.closeWithoutCallback();

  if (!options.isInitial) {
    store.setSource(source);
    if (options.resetSearch) store.clearSearchAndFilters();
  }

  store.setStatus("loading-source", `Loading packages from ${source.canonical}...`);
  try {
    const manifest = await loadSourceManifest(source);
    if (token !== sourceGeneration) return;

    repository = new VocabularyRepository({ manifest, source });
    store.setManifest(manifest, repository);

    const requested = findPackage(manifest, options.requestedPackageId);
    const firstBrowseable = manifest.vocabularies.find((entry) => entry.browseable);
    const selected = requested?.browseable ? requested : firstBrowseable;

    if (!selected) {
      const unavailable = requested ?? manifest.vocabularies[0];
      if (unavailable) store.setSelectedPackage(unavailable.packageId);
      const reason = unavailable?.errors?.join(" ") || "This source contains no browseable vocabulary packages.";
      store.setStatus("unavailable", reason);
      return;
    }

    const fallbackNotice = requested && !requested.browseable
      ? `${requested.displayName || requested.packageId} is unavailable; ${selected.displayName || selected.packageId} was loaded instead.`
      : options.notice;
    await loadPackage(selected.packageId, {
      sourceToken: token,
      restorePage: options.restorePage,
      restoreConceptId: options.restoreConceptId,
      notice: fallbackNotice,
    });
  } catch (error) {
    if (token !== sourceGeneration) return;
    store.setStatus("error", error.message || "The source could not be loaded.", error);
  }
}

async function loadPackage(packageId, options = {}) {
  const token = ++packageGeneration;
  detailGeneration += 1;
  conceptDetails.closeWithoutCallback();
  store.setSelectedPackage(packageId);

  const state = store.getState();
  const entry = state.manifest?.vocabularies?.find((candidate) => candidate.packageId === packageId);
  if (!entry || !repository) {
    store.setStatus("error", "The selected package is not available in this source.");
    return;
  }
  if (!entry.browseable) {
    store.setStatus("unavailable", entry.errors?.join(" ") || `${entry.displayName || entry.packageId} is unavailable.`);
    return;
  }

  store.setStatus("loading-package", `Loading ${entry.displayName || entry.packageId} concepts...`);
  try {
    const dataset = await repository.loadPackage(packageId);
    if (token !== packageGeneration || (options.sourceToken && options.sourceToken !== sourceGeneration)) return;

    store.setDataset(dataset);
    if (Number(options.restorePage) > 1) store.setPage(options.restorePage);

    const warnings = dataset.entry.warnings?.length
      ? ` ${dataset.entry.warnings.length.toLocaleString()} data warning${dataset.entry.warnings.length === 1 ? "" : "s"} recorded.`
      : "";
    const message = options.notice
      ? `${options.notice} ${dataset.concepts.length.toLocaleString()} concepts are ready.${warnings}`
      : `${dataset.concepts.length.toLocaleString()} concepts are ready.${warnings}`;
    store.setStatus("ready", message);

    if (options.restoreConceptId && dataset.conceptById.has(String(options.restoreConceptId))) {
      void openConcept(String(options.restoreConceptId));
    }
  } catch (error) {
    if (token !== packageGeneration) return;
    store.setStatus("error", error.message || "The vocabulary package could not be loaded.", error);
  }
}

async function openConcept(conceptId) {
  const state = store.getState();
  const concept = state.dataset?.conceptById?.get(String(conceptId));
  if (!concept || !repository || !state.selectedPackageId) return;

  const token = ++detailGeneration;
  store.selectConcept(concept.conceptId);
  conceptDetails.showLoading(concept);
  try {
    const details = await repository.loadConceptDetails(state.selectedPackageId, concept.conceptId);
    const current = store.getState();
    if (token !== detailGeneration || current.selectedPackageId !== state.selectedPackageId) return;
    conceptDetails.showDetails(details, {
      hierarchyAvailable: Boolean(current.dataset?.entry?.capabilities?.hierarchy),
    });
  } catch (error) {
    if (token !== detailGeneration) return;
    conceptDetails.showError(concept, error);
  }
}

function debounceQuery(value) {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => store.setQuery(value), 250);
}

function clearQuery() {
  clearTimeout(queryTimer);
  store.setQuery("");
}

function findPackage(manifest, packageId) {
  if (!packageId) return null;
  return manifest.vocabularies.find((entry) => entry.packageId === packageId)
    ?? manifest.vocabularies.find((entry) => entry.packageId.toLowerCase() === String(packageId).toLowerCase())
    ?? null;
}
