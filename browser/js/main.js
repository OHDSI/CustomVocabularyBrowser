import { PAGE_SIZE_OPTIONS } from "./config.js";
import { VocabularyRepository, conceptKey } from "./services/dataService.js";
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
import { createReviewWorkspace } from "./ui/reviewWorkspace.js";
import { createResultsTable } from "./ui/table.js";
import { createResultsScroller } from "./ui/resultsScroller.js";
import { shouldRestoreRememberedSource } from "./services/startupSource.js";

import { saveLocalSnapshot, readLocalSnapshot, forgetLocalSnapshot, supportsLocalSnapshots, readRememberPreference, enableRememberPreference } from "./services/localSnapshotService.js";
import { createLocalOperations } from "./ui/localOperations.js";

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
  initialState = { ...readUrlState(""), source: null, explicitSourceRequested: true };
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
let pendingController = null;
let sourceController = null;
let pendingLocalState = initialState.localSourceRequested ? initialState : null;
let rememberEnabled = false;

const sourceSelector = createSourceSelector({
  onSubmit: handleSourceSubmit,
  onDefault: () => {
    pendingLocalState = null;
    void loadSource(null, { resetSearch: true });
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
const resultsScroller = createResultsScroller();
const pagination = createPagination({
  onPage: (page) => store.setPage(page),
  onPageSize: (pageSize) => store.setPageSize(pageSize),
});
const statusView = createStatusView();
const conceptDetails = createConceptDetails({
  getState: () => store.getState(),
  onClose: () => store.selectConcept(null),
  onSelectRelated: (conceptId) => openConcept(conceptId),
});

const reviewWorkspace = createReviewWorkspace({ getState: () => store.getState() });
const localOperations = createLocalOperations({
  onCancel: () => pendingController?.abort(),
  onRemember: (enabled) => void changeRememberPreference(enabled),
});
const views = [sourceSelector, searchControls, filters, resultsTable, resultsScroller, pagination, statusView, reviewWorkspace, localOperations];
store.subscribe((state) => {
  for (const view of views) view.render(state);
  replaceUrlState(state);
});
for (const view of views) view.render(store.getState());

void initializeSource();
globalThis.addEventListener?.("focus", async () => {
  if (pendingController || !supportsLocalSnapshots()) return;
  try {
    const { enabled } = await readRememberPreference();
    if (pendingController) return;
    if (rememberEnabled && !enabled) localOperations.setMessage("Remembering was turned off in another tab. The open vocabulary is unchanged.");
    rememberEnabled = enabled;
    localOperations.setRemember(enabled);
  } catch { /* An explicit storage operation reports unavailable storage. */ }
});


async function initializeSource() {
  if (supportsLocalSnapshots()) {
    const token = sourceGeneration;
    localOperations.setRemember(false, true);
    try {
      const preference = await readRememberPreference();
      if (token !== sourceGeneration) return;
      rememberEnabled = preference.enabled;
      localOperations.setRemember(rememberEnabled);
      if (shouldRestoreRememberedSource(initialState, preference)) {
        await activateLocalSource(async signal => {
          const saved = await readLocalSnapshot({ signal, onlyRemembered: true });
          if (!saved) throw new Error("The remembered copy was removed in another tab. Load a source again.");
          return saved;
        }, "", { restoring: true });
        return;
      }
    } catch (error) {
      if (token !== sourceGeneration) return;
      localOperations.setMessage("Browser storage is unavailable: " + error.message + " Load a source to continue.");
    } finally { localOperations.setRemember(rememberEnabled); }
    if (token !== sourceGeneration) return;
  }
  if (initialState.localSourceRequested) {
    store.setStatus("awaiting-local", "Choose the local folder again. No remembered copy is available in this browser.");
  } else {
    await loadSource(initialState.source, {
      isInitial: true, requestedPackageId: initialState.selectedPackageId,
      restorePage: initialState.page, restoreConceptId: initialState.selectedConceptId, notice: initialNotice,
    });
  }
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

async function activateLocalSource(makeSource, notice, { restoring = false } = {}) {
  let activated = false;
  clearTimeout(queryTimer);
  queryTimer = null;
  pendingController?.abort();
  const controller = pendingController = new AbortController();
  const token = ++sourceGeneration;
  packageGeneration += 1;
  detailGeneration += 1;
  conceptDetails.closeWithoutCallback();
  localOperations.setBusy(true, "Preparing local vocabulary...");
  store.setStatus("loading-source", "Preparing local vocabulary. Your current source remains available if this is cancelled.");
  try {
    const { source, manifest, savedAt } = await makeSource(controller.signal);
    controller.signal.throwIfAborted();
    const candidate = new VocabularyRepository({ manifest, source, signal: controller.signal,
      onProgress: (progress) => {
        if (token !== sourceGeneration) return;
        const percent = progress.totalBytes ? Math.min(100, Math.floor(progress.bytesRead / progress.totalBytes * 100)) : 0;
        localOperations.setMessage(progress.phase === "building"
          ? "Validating " + progress.packageId + " and building search indexes. Cancel remains available."
          : "Reading " + progress.packageId + ": " + percent + "%");
      },
    });
    const dataset = await candidate.loadAllPackages();
    controller.signal.throwIfAborted();
    if (token !== sourceGeneration) return;
    sourceController?.abort();
    sourceController = controller;
    repository = candidate;
    pendingLocalState = null;
    store.setSource(source);
    store.clearSearchAndFilters();
    store.setManifest(manifest, candidate);
    store.setDataset(dataset);
    store.setStatus("ready", dataset.concepts.length.toLocaleString() + " concepts are ready.");
    activated = true;
    localOperations.setMessage(restoring
      ? "Remembered copy from " + new Date(savedAt).toLocaleString() + ". Reload the source to get updates."
      : notice);
  } catch (error) {
    if (token !== sourceGeneration) return;
    const cancelled = controller.signal.aborted;
    const message = cancelled ? "Local operation cancelled. The previous source and saved copy were not replaced."
      : error.message || "The local vocabulary could not be loaded.";
    localOperations.setMessage(message);
    store.setStatus(store.getState().dataset ? "ready" : cancelled ? "awaiting-source" : "error", message, cancelled ? null : error);
  } finally {
    if (pendingController === controller) {
      pendingController = null;
      localOperations.setBusy(false, document.getElementById("local-operation-status").textContent);
    }
  }
  if (activated && !restoring) await rememberCurrentSource();
}

async function loadLocalFiles(files) {
  await activateLocalSource(() => createLocalDirectorySource(files), "");
}

async function changeRememberPreference(enabled) {
  if (pendingController) { localOperations.setRemember(rememberEnabled); return; }
  const prompt = enabled
    ? "Remember loaded vocabulary in this browser? It will reopen automatically without checking the original source. Future successful loads replace the copy. Anyone using this browser profile can read it; it is not encrypted. Nothing is uploaded. Uncheck to remove the copy."
    : "Remove the remembered copy from this browser and stop remembering vocabulary? Original files and the current source stay unchanged.";
  if (!globalThis.confirm(prompt)) { localOperations.setRemember(rememberEnabled); return; }
  const controller = pendingController = new AbortController();
  localOperations.setBusy(true, enabled ? "Enabling device storage..." : "Removing the remembered copy...");
  try {
    if (enabled) await enableRememberPreference({ signal: controller.signal });
    else await forgetLocalSnapshot({ signal: controller.signal });
    rememberEnabled = enabled;
    localOperations.setRemember(enabled);
    localOperations.setMessage(enabled ? "Vocabulary will be remembered after loading." : "Remembered copy removed. Current source and original files are unchanged.");
  } catch (error) {
    localOperations.setRemember(rememberEnabled);
    localOperations.setMessage("Could not change device storage: " + error.message);
  } finally {
    if (pendingController === controller) {
      pendingController = null;
      localOperations.setBusy(false, document.getElementById("local-operation-status").textContent);
    }
  }
  if (enabled && rememberEnabled) await rememberCurrentSource();
}

async function rememberCurrentSource() {
  if (!rememberEnabled || pendingController || !repository || !store.getState().dataset) return;
  const current = repository;
  const controller = pendingController = new AbortController();
  const token = sourceGeneration;
  localOperations.setBusy(true, "Remembering vocabulary in this browser...");
  store.setStatus("saving-local", "Remembering vocabulary...");
  try {
    const packages = await current.createSnapshotPackages({ signal: controller.signal });
    controller.signal.throwIfAborted();
    if (token !== sourceGeneration) return;
    const result = await saveLocalSnapshot({ source: current.source, manifest: current.manifest, packages }, {
      signal: controller.signal, requireRemembered: true,
      onProgress: ({ packageId, rows, total }) => {
        if (token === sourceGeneration && pendingController === controller) localOperations.setMessage("Remembering " + packageId + ": " + rows.toLocaleString() + " / " + total.toLocaleString() + " mapping rows");
      },
    });
    if (token !== sourceGeneration) return;
    localOperations.setMessage("Remembered " + result.packageCount + " package(s) on this device. Reload the source to get updates.");
    store.setStatus("ready", "Vocabulary remembered.");
  } catch (error) {
    if (token !== sourceGeneration) return;
    const message = controller.signal.aborted ? "Remembering cancelled. The previous copy is unchanged."
      : error.name === "QuotaExceededError" ? "Browser storage is full. This vocabulary was not remembered; the previous copy is unchanged. Uncheck to remove it."
      : "This vocabulary was not remembered: " + error.message + " The previous copy is unchanged.";
    localOperations.setMessage(message); store.setStatus("ready", message);
  } finally {
    if (pendingController === controller) {
      pendingController = null;
      localOperations.setBusy(false, document.getElementById("local-operation-status").textContent);
    }
  }
}

async function loadSource(source, options = {}) {
  pendingController?.abort();
  pendingController = null;
  sourceController?.abort();
  sourceController = null;
  localOperations.setBusy(false);
  clearTimeout(queryTimer);
  queryTimer = null;
  const token = ++sourceGeneration;
  packageGeneration += 1;
  detailGeneration += 1;
  repository = null;
  conceptDetails.closeWithoutCallback();

  if (!options.isInitial) {
    store.setSource(source);
    if (options.resetSearch) store.clearSearchAndFilters();
  }

  if (!source) {
    store.setStatus("awaiting-source", options.notice || "Choose a local folder or enter a public GitHub repository.");
    if (rememberEnabled) localOperations.setMessage("Remembered vocabulary will reopen next time. Uncheck Remember vocabulary on this device to remove it.");
    return;
  }

  store.setStatus("loading-source", `Loading packages from ${source.canonical}...`);
  try {
    const manifest = await loadSourceManifest(source);
    if (token !== sourceGeneration) return;

    repository = new VocabularyRepository({ manifest, source });
    store.setManifest(manifest, repository);

    const requested = findPackage(manifest, options.requestedPackageId ?? "__all__");
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
    if (token === sourceGeneration && store.getState().dataset) await rememberCurrentSource();
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
  const entry = findPackage(state.manifest, packageId);
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
    const dataset = packageId === "__all__" || packageId.startsWith("[")
      ? await repository.loadAllPackages(packageId === "__all__" ? null : JSON.parse(packageId))
      : await repository.loadPackage(packageId);
    if (token !== packageGeneration || (options.sourceToken && options.sourceToken !== sourceGeneration)) return;

    store.setDataset(dataset);
    if (Number(options.restorePage) > 1) store.setPage(options.restorePage);

    const warnings = "";
    const message = options.notice
      ? `${options.notice} ${dataset.concepts.length.toLocaleString()} concepts are ready.${warnings}`
      : `${dataset.concepts.length.toLocaleString()} concepts are ready.${warnings}`;
    store.setStatus("ready", message);

    if (options.restoreConceptId && dataset.conceptById.has(String(options.restoreConceptId))) {
      void openConcept(String(options.restoreConceptId));
    }
    if (!options.sourceToken) await rememberCurrentSource();
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
  store.selectConcept(concept.key ?? concept.conceptId);
  conceptDetails.showLoading(concept);
  try {
    const details = await repository.loadConceptDetails(concept.packageId ?? state.selectedPackageId, concept.conceptId);
    if (state.dataset?.packages) {
      for (const section of ["outgoing", "incoming", "ancestors", "descendants"]) {
        for (const row of details[section] ?? []) {
          if (row.otherConcept) row.otherConcept = {
            ...row.otherConcept, key: conceptKey(concept.packageId, row.otherConcept.conceptId),
          };
        }
      }
    }
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
  if (!manifest || !packageId) return null;
  if (packageId.startsWith("[")) {
    try {
      const ids = JSON.parse(packageId);
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !manifest.vocabularies.some((entry) => entry.packageId === id && entry.browseable))) return null;
      return { packageId, displayName: "Selected packages", browseable: true };
    } catch { return null; }
  }
  if (packageId === "__all__") return {
    packageId, displayName: "All packages", browseable: manifest.vocabularies.some((entry) => entry.browseable),
  };
  return manifest.vocabularies.find((entry) => entry.packageId === packageId)
    ?? manifest.vocabularies.find((entry) => entry.packageId.toLowerCase() === String(packageId).toLowerCase())
    ?? null;
}
