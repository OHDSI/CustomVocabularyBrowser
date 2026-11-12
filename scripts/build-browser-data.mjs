import { readFile, readdir, mkdir, writeFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_SCHEMA_VERSION,
  buildVocabularyArtifacts,
} from "../browser/js/services/vocabularyParser.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

import { RECOGNIZED_FILES as FILES, discoverTableFiles } from "../browser/js/services/manifestService.js";

const REQUIRED_KEYS = Object.freeze(["concept", "synonym", "relationship"]);
export const MAPPING_CHUNK_LIMIT_BYTES = 20 * 1024 * 1024;
export const MAX_PUBLISHED_FILE_BYTES = 100_000_000;

export async function buildBrowserData(options) {
  const sourceRoot = path.resolve(options.source);
  if (!options.output) throw new Error("--output is required. Generated package data must remain outside the browser project.");
  const outputRoot = path.resolve(options.output);
  const canonicalOutput = await assertPublicBuildDestination(outputRoot, options.publicSource);
  await assertDirectory(sourceRoot, "source directory");
  const canonicalSource = await realpath(sourceRoot);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (contains(canonicalSource, canonicalOutput) || contains(canonicalOutput, canonicalSource)) {
    throw new Error("Source and output directories must not overlap.");
  }
  assertProvenance(options);

  const packageDirectories = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(compareText);

  await prepareOutput(outputRoot);
  const vocabularyRoot = path.join(outputRoot, "vocabularies");
  await mkdir(vocabularyRoot, { recursive: true });

  const manifestEntries = [];
  const fatalErrors = [];
  const artifactNames = new Set();

  for (const packageId of packageDirectories) {
    const packageRoot = path.join(sourceRoot, packageId);
    const ontologyPath = path.join(packageRoot, "Ontology");
    const dataRoot = (await isDirectory(ontologyPath)) ? ontologyPath : packageRoot;
    const sourcePath = path.relative(sourceRoot, dataRoot).split(path.sep).join("/");
    const sourceFiles = {};
    const manifestFiles = {};

    const availablePaths = new Set((await readdir(dataRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile()).map((entry) => `${sourcePath}/${entry.name}`));
    for (const directory of await readdir(packageRoot, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^(mapping|mappings)$/iu.test(directory.name)) continue;
      const mappingRoot = path.join(packageRoot, directory.name);
      for (const mappingFile of await readdir(mappingRoot, { withFileTypes: true })) {
        if (mappingFile.isFile() && /\.csv$/iu.test(mappingFile.name)) {
          availablePaths.add(`${packageId}/${directory.name}/${mappingFile.name}`);
        }
      }
    }
    const discovered = discoverTableFiles(sourcePath, availablePaths);
    for (const [key, repositoryPath] of Object.entries(discovered.files)) {
      const absolute = path.join(sourceRoot, ...repositoryPath.split("/"));
      manifestFiles[key] = repositoryPath;
      sourceFiles[key] = { path: repositoryPath, text: await readFile(absolute, "utf8") };
    }
    if (discovered.errors.length) {
      fatalErrors.push(`${packageId}: ${discovered.errors.join(" ")}`);
      manifestEntries.push({
        packageId, displayName: packageId, sourcePath, browseable: false,
        status: "conflicting-data", vocabularyIds: [], files: manifestFiles,
        capabilities: emptyCapabilities(), counts: emptyCounts(), artifacts: {},
        warnings: [], errors: discovered.errors,
      });
      continue;
    }

    const missing = REQUIRED_KEYS.filter((key) => !sourceFiles[key]);
    if (missing.length > 0) {
      manifestEntries.push({
        packageId,
        displayName: packageId,
        sourcePath,
        browseable: false,
        status: "missing-required-data",
        vocabularyIds: [],
        files: manifestFiles,
        capabilities: emptyCapabilities(),
        counts: emptyCounts(),
        artifacts: {},
        warnings: [],
        errors: [`Missing jointly required files: ${missing.map((key) => FILES[key]).join(", ")}.`],
      });
      continue;
    }

    try {
      const built = buildVocabularyArtifacts({ packageId, sources: sourceFiles });
      const artifactDirectory = safeArtifactName(packageId);
      if (artifactNames.has(artifactDirectory)) {
        throw new Error(`Package artifact-name collision for ${packageId}.`);
      }
      artifactNames.add(artifactDirectory);
      const packageOutput = path.join(vocabularyRoot, artifactDirectory);
      await mkdir(packageOutput, { recursive: true });

      const artifacts = {};
      for (const [key, value] of Object.entries({
        concepts: built.concepts,
        search: built.search,
        synonyms: built.synonyms,
        relationships: built.relationships,
        hierarchy: built.hierarchy,
        metadata: built.metadata,
      })) {
        if (!value) continue;
        const relative = `vocabularies/${artifactDirectory}/${key}.json`;
        const filename = path.join(outputRoot, ...relative.split("/"));
        if (key === "metadata") await writeMetadataArtifact(filename, value, { chunkLimitBytes: options.metadataChunkLimitBytes });
        else await writeJson(filename, value);
        artifacts[key] = relative;
      }

      manifestEntries.push({
        packageId,
        displayName: packageId,
        sourcePath,
        browseable: true,
        status: "ready",
        vocabularyIds: built.vocabularyIds,
        files: manifestFiles,
        capabilities: {
          conceptSearch: true,
          synonymSearch: true,
          relationships: true,
          hierarchy:
            Boolean(built.hierarchy) &&
            built.counts.usableAncestorRows > 0,
          vocabularyMetadata: Boolean(built.metadata?.tables?.vocabulary),
        },
        counts: built.counts,
        artifacts,
        warnings: built.warnings,
        errors: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fatalErrors.push(`${packageId}: ${message}`);
      manifestEntries.push({
        packageId,
        displayName: packageId,
        sourcePath,
        browseable: false,
        status: "invalid-required-data",
        vocabularyIds: [],
        files: manifestFiles,
        capabilities: emptyCapabilities(),
        counts: emptyCounts(),
        artifacts: {},
        warnings: [],
        errors: [message],
      });
    }
  }

  const manifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      provider: "github",
      repository: options.repository,
      ref: options.ref,
      commit: options.commit,
    },
    requiredFiles: REQUIRED_KEYS.map((key) => FILES[key]),
    vocabularies: manifestEntries,
  };
  await writeJson(path.join(outputRoot, "manifest.json"), manifest, true);

  if (fatalErrors.length > 0) {
    throw new Error(`Required vocabulary validation failed:\n${fatalErrors.join("\n")}`);
  }
  if (!manifestEntries.some((entry) => entry.browseable)) {
    throw new Error("No browseable vocabulary packages were discovered.");
  }

  return manifest;
}

// Package artifacts may be generated only outside the application repository.
export async function assertPublicBuildDestination(outputRoot, _legacyPublicSource) {
  // Resolve the nearest existing ancestor so an output directory reached through
  // a symlink or junction cannot appear outside the repository while writing inside it.
  const canonicalProject = await realpath(PROJECT_ROOT);
  let ancestor = path.resolve(outputRoot);
  const suffix = [];
  let canonicalOutput;
  while (true) {
    try {
      canonicalOutput = path.join(await realpath(ancestor), ...suffix.reverse());
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
  const relative = path.relative(canonicalProject, canonicalOutput);
  const insideProject = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  if (insideProject) {
    throw new Error("Generated package data must remain outside the browser project. --public-source cannot override this boundary.");
  }
  return canonicalOutput;
}

function assertProvenance(options) {
  for (const key of ["repository", "ref", "commit"]) {
    if (!options[key] || typeof options[key] !== "string") {
      throw new Error(`--${key} is required for source provenance.`);
    }
  }
}

async function prepareOutput(outputRoot) {
  if (path.parse(outputRoot).root === outputRoot) {
    throw new Error("Refusing to use a filesystem root as browser-data output.");
  }
  await mkdir(outputRoot, { recursive: true });
  if ((await readdir(outputRoot)).length) throw new Error("Output directory must be empty. Choose a new directory; existing files are never deleted.");
}

// Split only the optional mapping table; small and legacy packages keep their
// existing inline shape. Limits are applied to UTF-8 serialized bytes, not JS
// string length, and include brackets, commas and the trailing newline.
export async function writeMetadataArtifact(filename, metadata, options = {}) {
  const limit = options.chunkLimitBytes ?? MAPPING_CHUNK_LIMIT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 4 || limit >= MAX_PUBLISHED_FILE_BYTES) throw new Error("Invalid mapping chunk limit.");
  const rows = metadata?.tables?.mappingMetadata;
  if (!Array.isArray(rows) || rows.length === 0) return writeJson(filename, metadata);
  if (metadata.mappingMetadataChunks !== undefined || metadata.mappingMetadataTotal !== undefined) throw new Error("Metadata already contains chunk descriptors.");
  const empty = { ...metadata, tables: { ...metadata.tables, mappingMetadata: [] } };
  const baseBytes = Buffer.byteLength(`${JSON.stringify(empty)}\n`, "utf8");
  let inlineBytes = baseBytes;
  for (const [index, row] of rows.entries()) {
    inlineBytes += Buffer.byteLength(JSON.stringify(row) ?? "null", "utf8") + (index ? 1 : 0);
    if (inlineBytes > limit) break;
  }
  if (inlineBytes <= limit) return writeJson(filename, metadata);
  const chunks = [];
  let serializedRows = [], size = 3;
  const flush = async () => {
    if (!serializedRows.length) return;
    if (chunks.length >= 99999) throw new Error("Mapping metadata requires too many chunks.");
    const file = `mapping-metadata-${String(chunks.length + 1).padStart(5, "0")}.json`;
    await writeFile(path.join(path.dirname(filename), file), `[${serializedRows.join(",")}]\n`, "utf8");
    chunks.push({ file, count: serializedRows.length });
    serializedRows = []; size = 3;
  };
  for (const row of rows) {
    const serialized = JSON.stringify(row) ?? "null";
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes + 3 > limit) throw new Error("A mapping metadata row exceeds the maximum chunk size.");
    if (size + bytes + (serializedRows.length ? 1 : 0) > limit) await flush();
    size += bytes + (serializedRows.length ? 1 : 0);
    serializedRows.push(serialized);
  }
  await flush();
  await writeJson(filename, { ...empty, mappingMetadataChunks: chunks, mappingMetadataTotal: rows.length });
}

async function writeJson(filename, value, pretty = false) {
  const serialized = `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
  if (Buffer.byteLength(serialized, "utf8") >= MAX_PUBLISHED_FILE_BYTES) {
    throw new Error(`Generated artifact ${path.basename(filename)} reaches the internal 100,000,000-byte safety limit.`);
  }
  await writeFile(filename, serialized, "utf8");
}

async function assertDirectory(directory, label) {
  if (!(await isDirectory(directory))) throw new Error(`${label} does not exist: ${directory}`);
}

async function isDirectory(filename) {
  try {
    return (await stat(filename)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}

function emptyCapabilities() {
  return {
    conceptSearch: false,
    synonymSearch: false,
    relationships: false,
    hierarchy: false,
    vocabularyMetadata: false,
  };
}

function emptyCounts() {
  return {
    concepts: 0,
    synonyms: 0,
    sourceSynonyms: 0,
    orphanSynonyms: 0,
    relationships: 0,
    relationshipsLocalBoth: 0,
    relationshipsOneLocal: 0,
    relationshipsExternal: 0,
    ancestorRows: 0,
    nonReflexiveAncestorRows: 0,
    usableAncestorRows: 0,
    locallyRelevantAncestorRows: 0,
    duplicateCodeGroups: 0,
  };
}

function safeArtifactName(packageId) {
  const safe = packageId.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (!safe || safe === "." || safe === "..") throw new Error(`Unsafe package identifier: ${packageId}`);
  return safe;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (key === "publicSource") { options.publicSource = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    options[key] = value;
    index += 1;
  }
  if (!options.source) throw new Error("--source is required.");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await buildBrowserData(parseArguments(process.argv.slice(2)));
    const ready = manifest.vocabularies.filter((entry) => entry.browseable);
    console.log(`Built ${ready.length} browseable package(s) at schema ${manifest.schemaVersion}.`);
    for (const entry of manifest.vocabularies) {
      console.log(`${entry.packageId}: ${entry.status} (${entry.counts.concepts} concepts)`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
