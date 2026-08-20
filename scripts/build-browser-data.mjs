import { readFile, readdir, mkdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_SCHEMA_VERSION,
  buildVocabularyArtifacts,
} from "../browser/js/services/vocabularyParser.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

const FILES = Object.freeze({
  concept: "concept_delta.csv",
  synonym: "concept_synonym_delta.csv",
  relationship: "concept_relationship_delta.csv",
  ancestor: "concept_ancestor_delta.csv",
  conceptClass: "concept_class_delta.csv",
  domain: "domain_delta.csv",
  relationshipDefinition: "relationship_delta.csv",
  vocabulary: "vocabulary_delta.csv",
  mappingMetadata: "mapping_metadata.csv",
});

const REQUIRED_KEYS = Object.freeze(["concept", "synonym", "relationship"]);

export async function buildBrowserData(options) {
  const sourceRoot = path.resolve(options.source);
  const outputRoot = path.resolve(options.output ?? path.join(PROJECT_ROOT, "browser", "data"));
  await assertDirectory(sourceRoot, "source directory");
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

    for (const [key, filename] of Object.entries(FILES)) {
      const absolute = path.join(dataRoot, filename);
      if (!(await isFile(absolute))) continue;
      const repositoryPath = path.relative(sourceRoot, absolute).split(path.sep).join("/");
      manifestFiles[key] = repositoryPath;
      sourceFiles[key] = { path: repositoryPath, text: await readFile(absolute, "utf8") };
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
        await writeJson(path.join(outputRoot, ...relative.split("/")), value);
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
  const vocabularyRoot = path.resolve(outputRoot, "vocabularies");
  if (path.dirname(vocabularyRoot) !== outputRoot || path.basename(vocabularyRoot) !== "vocabularies") {
    throw new Error("Resolved vocabulary output escaped the requested output directory.");
  }
  await rm(vocabularyRoot, { recursive: true, force: true });
  await rm(path.join(outputRoot, "manifest.json"), { force: true });
}

async function writeJson(filename, value, pretty = false) {
  const serialized = `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
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
