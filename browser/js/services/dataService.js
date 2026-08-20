import { MANIFEST_SCHEMA_VERSION } from "../config.js";
import { fetchGitHubText, SourceLoadError } from "./manifestService.js";
import { buildVocabularyArtifacts } from "./vocabularyParser.js";

export class VocabularyRepository {
  constructor({ manifest, source, fetchImpl = globalThis.fetch }) {
    this.manifest = manifest;
    this.source = source;
    this.fetchImpl = fetchImpl;
    this.packageCache = new Map();
    this.detailCache = new Map();
  }

  async loadPackage(packageId) {
    if (this.packageCache.has(packageId)) return this.packageCache.get(packageId);
    const entry = this.#entry(packageId);
    if (!entry.browseable) {
      throw new SourceLoadError(`${entry.displayName} is unavailable: ${entry.errors?.join(" ") || entry.status}.`, "PACKAGE_UNAVAILABLE");
    }

    let loaded;
    if (entry.artifacts?.concepts && entry.artifacts?.search) {
      const [concepts, search] = await Promise.all([
        this.#loadArtifact(entry.artifacts.concepts),
        this.#loadArtifact(entry.artifacts.search),
      ]);
      loaded = {
        entry,
        concepts: concepts.concepts,
        facets: concepts.facets,
        search,
        conceptById: new Map(concepts.concepts.map((concept) => [concept.conceptId, concept])),
      };
    } else {
      const built = await this.#buildSourcePackage(entry);
      loaded = {
        entry: mergeRuntimeEntry(entry, built),
        concepts: built.concepts.concepts,
        facets: built.concepts.facets,
        search: built.search,
        conceptById: new Map(built.concepts.concepts.map((concept) => [concept.conceptId, concept])),
      };
      this.detailCache.set(packageId, detailsFromBuilt(built));
    }

    if (loaded.search.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
      throw new SourceLoadError("The package search artifact has an unsupported schema.", "UNSUPPORTED_ARTIFACT_SCHEMA");
    }
    this.packageCache.set(packageId, loaded);
    return loaded;
  }

  async loadConceptDetails(packageId, conceptId) {
    const dataset = await this.loadPackage(packageId);
    const concept = dataset.conceptById.get(String(conceptId));
    if (!concept) throw new SourceLoadError(`Concept ${conceptId} is not present in this package.`, "CONCEPT_NOT_FOUND");
    let details = this.detailCache.get(packageId);
    if (!details) {
      const entry = this.#entry(packageId);
      const [synonyms, relationships, hierarchy, metadata] = await Promise.all([
        this.#loadArtifact(entry.artifacts.synonyms),
        this.#loadArtifact(entry.artifacts.relationships),
        entry.artifacts.hierarchy ? this.#loadArtifact(entry.artifacts.hierarchy) : null,
        entry.artifacts.metadata ? this.#loadArtifact(entry.artifacts.metadata) : null,
      ]);
      details = { synonyms, relationships, hierarchy, metadata };
      this.detailCache.set(packageId, details);
    }
    return resolveDetails(concept, dataset.conceptById, details);
  }

  #entry(packageId) {
    const entry = this.manifest.vocabularies.find((candidate) => candidate.packageId === packageId);
    if (!entry) throw new SourceLoadError(`Unknown vocabulary package: ${packageId}.`, "PACKAGE_NOT_FOUND");
    return entry;
  }

  async #buildSourcePackage(entry) {
    const sources = {};
    const origin = this.manifest.__origin;
    await Promise.all(
      Object.entries(entry.files).map(async ([key, repositoryPath]) => {
        if (key === "mappingMetadata") return;
        let text;
        if (origin?.mode === "local-directory") {
          const file = origin.files.get(repositoryPath);
          if (!file) {
            throw new SourceLoadError(`Local file not found: ${repositoryPath}.`, "LOCAL_FILE_NOT_FOUND");
          }
          try {
            text = await file.text();
          } catch {
            throw new SourceLoadError(`Unable to read local file: ${repositoryPath}.`, "LOCAL_FILE_UNREADABLE");
          }
        } else {
          text = await fetchGitHubText(this.source, repositoryPath, { fetchImpl: this.fetchImpl });
        }
        sources[key] = {
          path: repositoryPath,
          text,
        };
      }),
    );
    try {
      return buildVocabularyArtifacts({ packageId: entry.packageId, sources });
    } catch (error) {
      throw new SourceLoadError(`Vocabulary validation failed: ${error.message}`, "INVALID_REQUIRED_DATA");
    }
  }

  async #loadArtifact(relative) {
    if (!relative) throw new SourceLoadError("A required package artifact is missing.", "MISSING_ARTIFACT");
    const origin = this.manifest.__origin;
    let text;
    if (origin?.mode === "local") {
      let response;
      try {
        const fetchImpl = this.fetchImpl;
        response = await fetchImpl(new URL(relative, origin.baseUrl).href, {
          headers: { Accept: "application/json" },
        });
      } catch {
        throw new SourceLoadError(`Unable to load browser artifact ${relative}.`, "NETWORK_FAILURE");
      }
      if (!response.ok) throw new SourceLoadError(`Unable to load browser artifact ${relative}.`, "MISSING_ARTIFACT");
      text = await response.text();
    } else if (origin?.mode === "github-prebuilt") {
      text = await fetchGitHubText(this.source, `browser/data/${relative}`, { fetchImpl: this.fetchImpl });
    } else {
      throw new SourceLoadError("This source has no prebuilt artifacts.", "MISSING_ARTIFACT");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SourceLoadError(`Browser artifact ${relative} is not valid JSON.`, "INVALID_ARTIFACT");
    }
  }
}

function detailsFromBuilt(built) {
  return {
    synonyms: built.synonyms,
    relationships: built.relationships,
    hierarchy: built.hierarchy,
    metadata: built.metadata,
  };
}

function mergeRuntimeEntry(entry, built) {
  return {
    ...entry,
    status: "ready",
    vocabularyIds: built.vocabularyIds,
    counts: built.counts,
    warnings: [...(entry.warnings ?? []), ...built.warnings],
    capabilities: {
      conceptSearch: true,
      synonymSearch: true,
      relationships: true,
      hierarchy:
        Boolean(built.hierarchy) &&
        built.counts.usableAncestorRows > 0,
      vocabularyMetadata: Boolean(built.metadata?.tables?.vocabulary?.length),
    },
  };
}

function resolveDetails(concept, conceptById, details) {
  const relationshipRows = details.relationships?.rows ?? [];
  const outgoing = (details.relationships?.outgoing?.[concept.conceptId] ?? []).map((index) => {
    const relationship = relationshipRows[index];
    return { ...relationship, otherConcept: conceptById.get(relationship.conceptId2) ?? null };
  });
  const incoming = (details.relationships?.incoming?.[concept.conceptId] ?? []).map((index) => {
    const relationship = relationshipRows[index];
    return { ...relationship, otherConcept: conceptById.get(relationship.conceptId1) ?? null };
  });
  const hierarchyRows = details.hierarchy?.rows ?? [];
  const ancestors = (details.hierarchy?.ancestors?.[concept.conceptId] ?? []).map((index) => {
    const row = hierarchyRows[index];
    return { ...row, otherConcept: conceptById.get(row.ancestorConceptId) ?? null };
  });
  const descendants = (details.hierarchy?.descendants?.[concept.conceptId] ?? []).map((index) => {
    const row = hierarchyRows[index];
    return { ...row, otherConcept: conceptById.get(row.descendantConceptId) ?? null };
  });
  return {
    concept,
    synonyms: details.synonyms?.byConceptId?.[concept.conceptId] ?? [],
    outgoing,
    incoming,
    ancestors,
    descendants,
    metadata: details.metadata?.tables ?? {},
  };
}
