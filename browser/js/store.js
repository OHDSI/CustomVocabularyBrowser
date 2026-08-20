import { DEFAULT_PAGE_SIZE, DEFAULT_SOURCE } from "./config.js";
import { SearchService } from "./services/searchService.js";

const FILTER_FIELDS = Object.freeze([
  "vocabularyId",
  "domainId",
  "conceptClassId",
  "standardConcept",
  "invalidReason",
]);

export class BrowserStore {
  constructor(initial = {}) {
    this.listeners = new Set();
    this.searchService = null;
    this.state = {
      source: initial.source ?? DEFAULT_SOURCE,
      manifest: null,
      repository: null,
      selectedPackageId: initial.selectedPackageId ?? null,
      dataset: null,
      query: initial.query ?? "",
      filters: Object.fromEntries(
        FILTER_FIELDS.map((field) => [field, normalizeFilter(initial.filters?.[field])]),
      ),
      page: positiveInteger(initial.page, 1),
      pageSize: positiveInteger(initial.pageSize, DEFAULT_PAGE_SIZE),
      sort: initial.sort ?? null,
      selectedConceptId: initial.selectedConceptId ?? null,
      results: emptyResults(initial.pageSize ?? DEFAULT_PAGE_SIZE),
      status: { phase: "idle", message: "", error: null },
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return this.state;
  }

  setStatus(phase, message = "", error = null) {
    this.state.status = { phase, message, error };
    this.#emit();
  }

  setSource(source) {
    this.state.source = source;
    this.state.manifest = null;
    this.state.repository = null;
    this.state.selectedPackageId = null;
    this.state.dataset = null;
    this.state.selectedConceptId = null;
    this.searchService = null;
    this.state.results = emptyResults(this.state.pageSize);
    this.#emit();
  }

  setManifest(manifest, repository) {
    this.state.manifest = manifest;
    this.state.repository = repository;
    this.#emit();
  }

  setSelectedPackage(packageId) {
    this.state.selectedPackageId = packageId;
    this.state.dataset = null;
    this.state.selectedConceptId = null;
    this.state.page = 1;
    this.searchService = null;
    this.state.results = emptyResults(this.state.pageSize);
    this.#emit();
  }

  setDataset(dataset) {
    this.state.dataset = dataset;
    this.state.selectedPackageId = dataset.entry.packageId;
    this.searchService = new SearchService({ concepts: dataset.concepts, search: dataset.search });
    if (this.state.selectedConceptId && !dataset.conceptById.has(this.state.selectedConceptId)) {
      this.state.selectedConceptId = null;
    }
    this.#recompute();
  }

  setQuery(query) {
    this.state.query = String(query ?? "");
    this.state.page = 1;
    this.#recompute();
  }

  setFilter(field, values) {
    assertFilterField(field);
    this.state.filters = { ...this.state.filters, [field]: normalizeFilter(values) };
    this.state.page = 1;
    this.#recompute();
  }

  clearFilter(field) {
    this.setFilter(field, []);
  }

  clearAllFilters() {
    this.state.filters = Object.fromEntries(FILTER_FIELDS.map((field) => [field, []]));
    this.state.page = 1;
    this.#recompute();
  }

  clearSearchAndFilters() {
    this.state.query = "";
    this.state.filters = Object.fromEntries(FILTER_FIELDS.map((field) => [field, []]));
    this.state.page = 1;
    this.#recompute();
  }

  setPage(page) {
    this.state.page = positiveInteger(page, 1);
    this.#recompute();
  }

  setPageSize(pageSize) {
    this.state.pageSize = positiveInteger(pageSize, DEFAULT_PAGE_SIZE);
    this.state.page = 1;
    this.#recompute();
  }

  setSort(field) {
    if (!field) {
      this.state.sort = null;
    } else if (this.state.sort?.field === field) {
      this.state.sort = {
        field,
        direction: this.state.sort.direction === "asc" ? "desc" : "asc",
      };
    } else {
      this.state.sort = { field, direction: "asc" };
    }
    this.state.page = 1;
    this.#recompute();
  }

  selectConcept(conceptId) {
    this.state.selectedConceptId = conceptId == null ? null : String(conceptId);
    this.#emit();
  }

  #recompute() {
    if (!this.searchService) {
      this.state.results = emptyResults(this.state.pageSize);
      this.#emit();
      return;
    }
    this.state.results = this.searchService.search({
      query: this.state.query,
      filters: this.state.filters,
      page: this.state.page,
      pageSize: this.state.pageSize,
      sort: this.state.sort,
    });
    this.state.page = this.state.results.page;
    this.#emit();
  }

  #emit() {
    for (const listener of this.listeners) listener(this.state);
  }
}

function normalizeFilter(values) {
  if (values == null) return [];
  const list = values instanceof Set ? [...values] : Array.isArray(values) ? values : [values];
  return [...new Set(list)];
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertFilterField(field) {
  if (!FILTER_FIELDS.includes(field)) throw new Error(`Unknown filter field: ${field}.`);
}

function emptyResults(pageSize) {
  return { total: 0, totalPages: 0, page: 1, pageSize, items: [] };
}

