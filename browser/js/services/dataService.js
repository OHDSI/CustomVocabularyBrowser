import { conceptCodeKey, normalizeConceptCode, sameConceptCode } from "../model/codeMatching.js";
import { MANIFEST_SCHEMA_VERSION } from "../config.js";
import { fetchGitHubText, SourceLoadError } from "./manifestService.js";
import { buildVocabularyArtifacts } from "./vocabularyParser.js";
import { buildLocalPackageInWorker } from "./localPackageWorkerClient.js";

export class VocabularyRepository {
  constructor({ manifest, source, fetchImpl = globalThis.fetch, signal, onProgress }) {
    this.manifest = manifest;
    this.source = source;
    this.fetchImpl = fetchImpl;
    this.packageCache = new Map();
    this.detailCache = new Map();
    this.builtCache = new Map();
    this.signal = signal;
    this.onProgress = onProgress;
  }

  async loadPackage(packageId) {
    this.signal?.throwIfAborted();
    if (this.packageCache.has(packageId)) return this.packageCache.get(packageId);
    const entry = this.#entry(packageId);
    if (!entry.browseable) {
      throw new SourceLoadError(`${entry.displayName} is unavailable: ${entry.errors?.join(" ") || entry.status}.`, "PACKAGE_UNAVAILABLE");
    }

    let loaded;
    if (entry.artifacts?.concepts && entry.artifacts?.search && this.manifest.__origin?.mode !== "saved-local") {
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
      this.signal?.throwIfAborted();
      this.builtCache.set(packageId, built);
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

  async loadAllPackages(packageIds = null) {
    const scope = packageIds ? new Set(packageIds) : null;
    const entries = this.manifest.vocabularies.filter((entry) => entry.browseable && (!scope || scope.has(entry.packageId)));
    const results = await Promise.allSettled(entries.map((entry) => this.loadPackage(entry.packageId)));
    this.signal?.throwIfAborted();
    const datasets = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    if (!datasets.length) {
      const failures = results.flatMap((result, index) => result.status === "rejected"
        ? [`${entries[index].packageId}: ${result.reason?.message || "Package could not be read."}`] : []);
      if (!entries.length) for (const entry of this.manifest.vocabularies) failures.push(`${entry.packageId}: ${entry.errors?.join(" ") || entry.status}`);
      throw new SourceLoadError(`No package could be loaded. ${failures.join(" ")}`, "PACKAGE_UNAVAILABLE");
    }
    const combined = combinePackages(datasets, packageIds ? JSON.stringify([...packageIds].sort()) : "__all__");
    combined.entry.warnings.push(...results.flatMap((result, index) => result.status === "rejected"
      ? [`${entries[index].packageId} was excluded: ${result.reason.message}`] : []));
    return combined;
  }

  async loadConceptDetails(packageId, conceptId) {
    const dataset = await this.loadPackage(packageId);
    const concept = dataset.conceptById.get(String(conceptId));
    if (!concept) throw new SourceLoadError(`Concept ${conceptId} is not present in this package.`, "CONCEPT_NOT_FOUND");
    return resolveDetails(concept, dataset.conceptById, await this.#packageDetails(packageId));
  }

  async #packageDetails(packageId, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.detailCache.has(packageId)) return this.detailCache.get(packageId);
    const entry = this.#entry(packageId);
    if (entry.artifacts.metadata && !isSafeMetadataPath(entry.artifacts.metadata)) {
      throw new SourceLoadError("Unsafe metadata artifact path.", "INVALID_ARTIFACT");
    }
    const [synonyms, relationships, hierarchy, metadata] = await Promise.all([
      this.#loadArtifact(entry.artifacts.synonyms, { signal }),
      this.#loadArtifact(entry.artifacts.relationships, { signal }),
      entry.artifacts.hierarchy ? this.#loadArtifact(entry.artifacts.hierarchy, { signal }) : null,
      entry.artifacts.metadata ? this.#loadArtifact(entry.artifacts.metadata, { signal }) : null,
    ]);
    // Large prebuilt mapping tables live in ordered, package-local chunks.
    // Do not cache or expose a partially reconstructed table on any failure.
    const completeMetadata = await this.#loadChunkedMetadata(entry.artifacts.metadata, metadata, packageId, { signal });
    const details = { synonyms, relationships, hierarchy, metadata: completeMetadata };
    this.detailCache.set(packageId, details);
    return details;
  }

  // Materialize complete detail artifacts too: restoring must never fetch a
  // remote repository, even when the original source used prebuilt JSON chunks.
  async createSnapshotPackages({ signal } = {}) {
    const packages = new Map();
    for (const [packageId, dataset] of this.packageCache) {
      signal?.throwIfAborted();
      let built = this.builtCache.get(packageId);
      if (!built) {
        const details = await this.#packageDetails(packageId, { signal });
        built = {
          concepts: { schemaVersion: MANIFEST_SCHEMA_VERSION, packageId, concepts: dataset.concepts, facets: dataset.facets },
          search: dataset.search, ...details,
          vocabularyIds: dataset.entry.vocabularyIds ?? [], counts: dataset.entry.counts ?? {}, warnings: dataset.entry.warnings ?? [],
        };
      }
      signal?.throwIfAborted();
      packages.set(packageId, built);
    }
    return packages;
  }

  #entry(packageId) {
    const entry = this.manifest.vocabularies.find((candidate) => candidate.packageId === packageId);
    if (!entry) throw new SourceLoadError(`Unknown vocabulary package: ${packageId}.`, "PACKAGE_NOT_FOUND");
    return entry;
  }

  async #buildSourcePackage(entry) {
    const sources = {};
    const origin = this.manifest.__origin;
    if (origin?.mode === "saved-local") {
      const built = origin.packages.get(entry.packageId);
      if (!built) throw new SourceLoadError("Saved package is missing.", "INVALID_SAVED_DATA");
      return built;
    }
    if (origin?.mode === "local-directory") {
      const files = Object.entries(entry.files).map(([key, path]) => {
        const file = origin.files.get(path);
        if (!file) throw new SourceLoadError(`Local file not found: ${path}.`, "LOCAL_FILE_NOT_FOUND");
        return { key, path, file };
      });
      try {
        const result = await buildLocalPackageInWorker(entry.packageId, files, {
          signal: this.signal, onProgress: this.onProgress,
        });
        if (result !== null) return result;
      } catch (error) {
        if (this.signal?.aborted || error.name === "AbortError") throw error;
        throw new SourceLoadError(error.message || "Unable to process local vocabulary.", error.code || "LOCAL_WORKER_FAILURE");
      }
      // Fallback for browsers without module workers or non-File test fixtures.
    }
    await Promise.all(
      Object.entries(entry.files).map(async ([key, repositoryPath]) => {
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
          text = await fetchGitHubText(origin?.contentSource ?? this.source, repositoryPath, { fetchImpl: this.fetchImpl, signal: this.signal });
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

  async #loadChunkedMetadata(metadataPath, metadata, packageId, { signal } = {}) {
    signal?.throwIfAborted();
    if (metadata == null) return metadata;
    const invalid = (reason) => new SourceLoadError(`Invalid mapping metadata chunks for ${packageId}: ${reason}.`, "INVALID_ARTIFACT");
    if (!Object.hasOwn(metadata, "mappingMetadataChunks")) {
      if (Object.hasOwn(metadata, "mappingMetadataTotal")) throw invalid("total count without chunk manifest");
      return metadata;
    }
    const chunks = metadata.mappingMetadataChunks;
    if (metadata.schemaVersion !== MANIFEST_SCHEMA_VERSION || metadata.packageId !== packageId ||
        !metadata.tables || !Array.isArray(metadata.tables.mappingMetadata) || metadata.tables.mappingMetadata.length !== 0 ||
        !Array.isArray(chunks) || chunks.length === 0 ||
        !Number.isSafeInteger(metadata.mappingMetadataTotal) || metadata.mappingMetadataTotal <= 0) {
      throw invalid("invalid package, schema, inline table or chunk manifest");
    }
    if (!isSafeMetadataPath(metadataPath)) throw invalid("invalid metadata path");
    const basePath = metadataPath.slice(0, metadataPath.lastIndexOf("/") + 1);
    let total = 0;
    for (const [index, chunk] of chunks.entries()) {
      const expectedName = `mapping-metadata-${String(index + 1).padStart(5, "0")}.json`;
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk) || chunk.file !== expectedName ||
          !Number.isSafeInteger(chunk.count) || chunk.count <= 0 || index >= 99999) throw invalid("invalid chunk descriptor");
      total += chunk.count;
      if (!Number.isSafeInteger(total)) throw invalid("invalid total count");
    }
    if (total !== metadata.mappingMetadataTotal) throw invalid("chunk counts do not match total");
    const rows = [];
    for (const chunk of chunks) {
      const part = await this.#loadArtifact(`${basePath}${chunk.file}`, { signal });
      if (!Array.isArray(part) || part.length !== chunk.count ||
          part.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
        throw invalid(`invalid chunk ${chunk.file}`);
      }
      for (const row of part) rows.push(row);
    }
    if (rows.length !== metadata.mappingMetadataTotal) throw invalid("reconstructed count does not match total");
    return { ...metadata, tables: { ...metadata.tables, mappingMetadata: rows } };
  }

  async #loadArtifact(relative, { signal } = {}) {
    signal?.throwIfAborted();
    if (!relative) throw new SourceLoadError("A required package artifact is missing.", "MISSING_ARTIFACT");
    const origin = this.manifest.__origin;
    let text;
    if (origin?.mode === "local") {
      let response;
      try {
        const fetchImpl = this.fetchImpl;
        response = await fetchImpl(new URL(relative, origin.baseUrl).href, {
          headers: { Accept: "application/json" }, signal,
        });
      } catch {
        signal?.throwIfAborted();
        throw new SourceLoadError(`Unable to load browser artifact ${relative}.`, "NETWORK_FAILURE");
      }
      if (!response.ok) throw new SourceLoadError(`Unable to load browser artifact ${relative}.`, "MISSING_ARTIFACT");
      text = await response.text();
    } else if (origin?.mode === "github-prebuilt") {
      text = await fetchGitHubText(origin.contentSource ?? this.source, `browser/data/${relative}`, { fetchImpl: this.fetchImpl, signal });
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

// Reject encoded separators, traversal, controls and double encoding before
// URL resolution; chunk paths must remain beside the declared metadata file.
function isSafeMetadataPath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    !/%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c|25)/iu.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f?#]/u.test(part));
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
  const targetIdsByCode = new Map();
  const sourceIdentityCounts = new Map();
  for (const item of conceptById.values()) {
    const key = conceptCodeKey(item.vocabularyId, item.conceptCode);
    if (!targetIdsByCode.has(key)) targetIdsByCode.set(key, []);
    targetIdsByCode.get(key).push(item.conceptId);
    const identity = JSON.stringify([conceptCodeKey(item.vocabularyId, item.conceptCode), item.conceptName]);
    sourceIdentityCounts.set(identity, (sourceIdentityCounts.get(identity) ?? 0) + 1);
  }
  const safeRelationship = (relationship) => {
    const mappingMetadata = (relationship.mappingMetadata ?? []).filter((row) => {
      const subject = conceptById.get(relationship.conceptId1);
      return subject && mappingMatchesConcept(row, subject, sourceIdentityCounts)
        && String(row.objectConceptId ?? "") === String(relationship.conceptId2)
        && mappingTargetMatches(row, conceptById, targetIdsByCode);
    });
    const safe = { ...relationship, mappingMetadata };
    if (safe.otherConceptOmop?.sourceDeclared && !mappingMetadata.some((row) =>
      String(row.target_concept_id ?? "") === String(safe.otherConceptOmop.conceptId)
      && String(row.target_vocabulary_id ?? "") === String(safe.otherConceptOmop.vocabularyId))) {
      delete safe.otherConceptOmop;
    }
    return safe;
  };
  const outgoing = (details.relationships?.outgoing?.[concept.conceptId] ?? []).map((index) => {
    const relationship = safeRelationship(relationshipRows[index]);
    return { ...relationship, otherConcept: conceptById.get(relationship.conceptId2) ?? null };
  });
  const incoming = (details.relationships?.incoming?.[concept.conceptId] ?? []).map((index) => {
    const relationship = safeRelationship(relationshipRows[index]);
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
  const ownMappingMetadata = [];
  const incomingMappingMetadata = [];
  for (const row of details.metadata?.tables?.mappingMetadata ?? []) {
    if (row.subjectConceptId === concept.conceptId && mappingMatchesConcept(row, concept, sourceIdentityCounts)) {
      const targetIdentityVerified = mappingTargetMatches(row, conceptById, targetIdsByCode);
      ownMappingMetadata.push({ ...row, targetIdentityVerified,
        otherConcept: targetIdentityVerified ? conceptById.get(String(row.objectConceptId)) ?? null : null });
    } else if (row.objectConceptId === concept.conceptId) {
      const subject = conceptById.get(String(row.subjectConceptId));
      if (subject && mappingMatchesConcept(row, subject, sourceIdentityCounts) && mappingTargetMatches(row, conceptById, targetIdsByCode)) {
        incomingMappingMetadata.push({ ...row, targetIdentityVerified: true, otherConcept: subject });
      }
    }
  }
  return {
    concept: {
      ...concept,
      mappingMetadata: ownMappingMetadata,
    },
    incomingMappingMetadata,
    synonyms: details.synonyms?.byConceptId?.[concept.conceptId] ?? [],
    outgoing,
    incoming,
    ancestors,
    descendants,
    metadata: details.metadata?.tables ?? {},
  };
}

// Never trust a stored derived target ID without checking the original target
// fields against this package or explicit evidence retained by the builder.
function mappingTargetMatches(row, conceptById, targetIdsByCode) {
  const id = String(row.objectConceptId ?? "").trim();
  if (!/^[1-9]\d*$/u.test(id)) return false;
  const target = conceptById.get(id);
  let explicitId = false;
  for (const value of [row.target_concept_id, row.concept_id_2]) {
    const candidate = String(value ?? "").trim();
    if (!candidate || candidate === "0") continue;
    if (!/^[1-9]\d*$/u.test(candidate) || candidate !== id) return false;
    explicitId = true;
  }
  const rawObject = String(row.object_id ?? "");
  let objectCode = "";
  let objectVocabulary = "";
  if (rawObject.trim()) {
    const numeric = /^(?:OMOP:)?([1-9]\d*)$/iu.exec(rawObject)?.[1];
    if (numeric) { if (numeric !== id) return false; explicitId = true; }
    else {
      const parts = /^([^:]+):(.+)$/u.exec(rawObject);
      if (parts) {
        if (parts[1].toUpperCase() === "OMOP") return false;
        [, objectVocabulary, objectCode] = parts;
      } else objectCode = rawObject;
    }
  }
  const composite = Object.hasOwn(row, "mapping_concept_code") ? String(row.mapping_concept_code).split("|| - ||") : null;
  if (composite && (composite.length !== 4 || composite.some((part) => !part.trim()))) return false;
  const codes = [row.target_concept_code, row.target_code, row.objectCode, objectCode, composite?.[2]].filter(Boolean);
  const vocabularies = [row.target_vocabulary_id, row.objectVocabulary, objectVocabulary, composite?.[3]].filter(Boolean);
  const omopLiteral = explicitId && row.objectVocabulary?.toUpperCase() === "OMOP" && row.objectCode === id;
  if (omopLiteral) codes.splice(codes.indexOf(row.objectCode), 1);
  const actualVocabularies = vocabularies.filter((v) => !(explicitId && v.toUpperCase() === "OMOP"));
  if (new Set(codes.map(normalizeConceptCode)).size > 1 || new Set(actualVocabularies).size > 1) return false;
  const code = codes[0] || "";
  const vocabulary = actualVocabularies[0] || "";
  if (target) {
    if ((code && !sameConceptCode(code, target.conceptCode)) || (vocabulary && vocabulary !== target.vocabularyId)) return false;
    if ([row.target_description, row.object_label, row.target_concept_name].some((name) => name && name !== target.conceptName)) return false;
    if (explicitId) return true;
    return Boolean(code && vocabulary && (targetIdsByCode.get(conceptCodeKey(vocabulary, code)) ?? []).length === 1);
  }
  const evidence = row.targetIdentityEvidence;
  const provenByBuilder = evidence && typeof evidence.file === "string" && Number.isInteger(evidence.row) && evidence.row >= 2
    && String(evidence.conceptId) === id && sameConceptCode(evidence.conceptCode, code) && evidence.vocabularyId === vocabulary && code && vocabulary;
  return Boolean(explicitId || provenByBuilder);
}

// Old prebuilt artifacts may contain code-only associations. Recheck the original
// source fields rather than trusting an ID inferred by the earlier parser.
function mappingMatchesConcept(row, concept, sourceIdentityCounts) {
  let explicitId = false;
  for (const value of [row.source_concept_id, row.concept_id_1]) {
    const id = String(value ?? "").trim();
    if (!id || id === "0") continue;
    if (!/^[1-9]\d*$/u.test(id) || id !== String(concept.conceptId)) return false;
    explicitId = true;
  }
  const subject = String(row.subject_id ?? "");
  if (subject.trim()) {
    const id = /^(?:OMOP:)?([1-9]\d*)$/i.exec(subject)?.[1];
    if (id) { if (id !== String(concept.conceptId)) return false; explicitId = true; }
    else {
      const parsed = /^([^:]+):(.+)$/u.exec(subject);
      if (parsed) {
        if (parsed[1].toUpperCase() === "OMOP" || parsed[1] !== concept.vocabularyId || !sameConceptCode(parsed[2], concept.conceptCode)) return false;
      } else if (!sameConceptCode(subject, concept.conceptCode)) return false;
    }
  }
  if (row.source_code && !sameConceptCode(row.source_code, concept.conceptCode)) return false;
  if (row.subjectCode && !sameConceptCode(row.subjectCode, concept.conceptCode)
    && !(explicitId && String(row.subjectVocabulary).toUpperCase() === "OMOP" && row.subjectCode === String(concept.conceptId))) return false;
  for (const name of [row.source_description, row.subject_label]) if (name && name !== concept.conceptName) return false;
  for (const vocabulary of [row.source_vocabulary_id, row.subjectVocabulary]) {
    if (vocabulary && vocabulary !== concept.vocabularyId && !(explicitId && vocabulary.toUpperCase() === "OMOP")) return false;
  }
  if (Object.hasOwn(row, "mapping_concept_code")) {
    const parts = String(row.mapping_concept_code).split("|| - ||");
    if (parts.length !== 4 || parts.some((part) => !part.trim())
      || !sameConceptCode(parts[0], concept.conceptCode) || parts[1] !== concept.vocabularyId) return false;
  }
  const code = row.source_code || row.subjectCode || "";
  const name = row.source_description || row.subject_label || "";
  return explicitId || Boolean(code && name && sourceIdentityCounts.get(JSON.stringify([
    conceptCodeKey(concept.vocabularyId, concept.conceptCode), concept.conceptName,
  ])) === 1);
}

/** Keep identifiers package-scoped; the same numeric ID can exist in separate packages. */
export function conceptKey(packageId, conceptId) {
  return JSON.stringify([String(packageId), String(conceptId)]);
}

export function combinePackages(datasets, scopeId = "__all__") {
  const concepts = [];
  const documents = [];
  for (const dataset of datasets) {
    const offset = concepts.length;
    concepts.push(...dataset.concepts.map((concept) => ({
      ...concept,
      key: conceptKey(dataset.entry.packageId, concept.conceptId),
      packageId: dataset.entry.packageId,
    })));
    documents.push(...dataset.search.documents.map((document) => ({
      ...document, conceptOrdinal: document.conceptOrdinal + offset,
    })));
  }
  const fields = ["vocabularyId", "domainId", "conceptClassId", "standardConcept", "invalidReason"];
  return {
    entry: {
      packageId: scopeId, displayName: scopeId === "__all__" ? "All packages" : "Selected packages", browseable: true,
      warnings: datasets.flatMap((dataset) => (dataset.entry.warnings ?? []).map((warning) => `${dataset.entry.packageId}: ${warning}`)),
      capabilities: { hierarchy: datasets.some((dataset) => dataset.entry.capabilities?.hierarchy) },
    },
    concepts,
    facets: Object.fromEntries(fields.map((field) => [field, [...new Set(concepts.map((concept) => concept[field]))]])),
    search: { schemaVersion: MANIFEST_SCHEMA_VERSION, documents },
    conceptById: new Map(concepts.map((concept) => [concept.key, concept])),
    packages: datasets,
  };
}
