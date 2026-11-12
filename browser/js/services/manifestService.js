import { MANIFEST_SCHEMA_VERSION } from "../config.js";
import { resolveSource } from "./sourceResolver.js";

export const REQUIRED_FILES = Object.freeze([
  "concept_delta.csv",
  "concept_synonym_delta.csv",
  "concept_relationship_delta.csv",
]);

export const RECOGNIZED_FILES = Object.freeze({
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

// Both naming conventions describe the same logical table. Supplying both is
// ambiguous, even when their bytes happen to match, so discovery rejects it.
export const FILE_ALIASES = Object.freeze(Object.fromEntries(
  Object.entries(RECOGNIZED_FILES).map(([key, filename]) => [key, Object.freeze(
    filename.endsWith("_delta.csv") ? [filename, filename.replace("_delta.csv", ".csv")] : [filename],
  )]),
));

export function discoverTableFiles(sourcePath, paths) {
  const files = {};
  const errors = [];
  for (const [key, aliases] of Object.entries(FILE_ALIASES)) {
    const matches = aliases.map((filename) => sourcePath ? `${sourcePath}/${filename}` : filename)
      .filter((candidate) => paths.has(candidate));
    if (matches.length > 1) errors.push(`Conflicting files for ${key}: ${matches.join(", ")}. Keep exactly one naming variant.`);
    else if (matches.length === 1) files[key] = matches[0];
  }
  for (const [index, repositoryPath] of discoverMappingFiles(sourcePath, paths).entries()) {
    files[`mappingSource${index}`] = repositoryPath;
  }
  return { files, errors };
}

/** Supplemental provenance stays scoped to the selected package's mapping folder. */
export function discoverMappingFiles(sourcePath, paths) {
  const segments = sourcePath === "." ? [] : sourcePath.split("/").filter(Boolean);
  if (segments.at(-1)?.toLowerCase() === "ontology") segments.pop();
  const prefix = segments.length ? `${segments.join("/")}/` : "";
  return [...paths].filter((repositoryPath) => {
    if (!repositoryPath.startsWith(prefix)) return false;
    const relative = repositoryPath.slice(prefix.length).split("/");
    return relative.length >= 2 && /^(mapping|mappings)$/iu.test(relative[0])
      && /\.csv$/iu.test(relative.at(-1));
  }).sort(compareText);
}

export class SourceLoadError extends Error {
  constructor(message, code = "SOURCE_LOAD_FAILED", details = {}) {
    super(message);
    this.name = "SourceLoadError";
    this.code = code;
    this.details = details;
  }
}

export async function loadSourceManifest(
  source,
  { fetchImpl = globalThis.fetch, localManifestUrl = null } = {},
) {
  requireFetch(fetchImpl);
  // Prebuilt local manifests are explicit adapters for tests/private tooling,
  // never an implicit dependency of the deployed application.
  if (localManifestUrl) {
    const manifest = await fetchJson(localManifestUrl, fetchImpl, "explicit browser manifest");
    validateManifest(manifest);
    attachOrigin(manifest, { mode: "local", baseUrl: new URL("./", localManifestUrl).href });
    return manifest;
  }

  if (!source || source.provider !== "github") {
    throw new SourceLoadError("Select a local folder or public GitHub repository.", "SOURCE_REQUIRED");
  }

  // Resolve once before reading any content, so a moving branch cannot mix versions.
  const contentSource = await resolveGitHubCommit(source, { fetchImpl });
  try {
    const text = await fetchGitHubText(contentSource, "browser/data/manifest.json", { fetchImpl });
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new SourceLoadError("The remote browser manifest is not valid JSON.", "INVALID_MANIFEST");
    }
    validateManifest(manifest);
    const expectedRepository = `${source.owner}/${source.repository}`.toLowerCase();
    if (String(manifest.source?.repository ?? "").toLowerCase() !== expectedRepository) {
      throw new SourceLoadError(
        "The remote browser manifest identifies a different source repository.",
        "MANIFEST_SOURCE_MISMATCH",
      );
    }
    attachOrigin(manifest, { mode: "github-prebuilt", source, contentSource });
    return manifest;
  } catch (error) {
    if (!(error instanceof SourceLoadError && ["FILE_NOT_FOUND", "PREBUILT_UNAVAILABLE"].includes(error.code))) {
      throw error;
    }
  }

  return discoverAtCommit(source, contentSource, { fetchImpl });
}

export async function discoverGitHubManifest(source, { fetchImpl = globalThis.fetch } = {}) {
  requireFetch(fetchImpl);
  const contentSource = await resolveGitHubCommit(source, { fetchImpl });
  return discoverAtCommit(source, contentSource, { fetchImpl });
}

async function resolveGitHubCommit(source, { fetchImpl }) {
  source = validatedGitHubSource(source);
  const commit = await fetchGitHubApi(
    source,
    `/commits/${encodeURIComponent(source.ref)}`,
    { fetchImpl, notFoundCode: "REF_NOT_FOUND" },
  );
  const commitSha = commit?.sha;
  if (!/^[0-9a-f]{40}$/iu.test(commitSha ?? "")) {
    throw new SourceLoadError("GitHub returned no usable commit SHA for the selected ref.", "INVALID_GITHUB_RESPONSE");
  }
  return Object.freeze({ ...source, ref: commitSha });
}

async function discoverAtCommit(source, contentSource, { fetchImpl }) {
  const commitSha = contentSource.ref;
  const tree = await fetchGitHubApi(source, `/git/trees/${commitSha}?recursive=1`, { fetchImpl });
  if (tree?.truncated) {
    throw new SourceLoadError(
      "The GitHub repository tree is too large for unauthenticated recursive discovery. Add a compatible prebuilt browser manifest.",
      "TREE_TRUNCATED",
    );
  }
  if (!Array.isArray(tree?.tree)) {
    throw new SourceLoadError("GitHub returned an invalid repository tree.", "INVALID_GITHUB_RESPONSE");
  }

  const paths = new Set(tree.tree.map((entry) => entry.path));
  const packages = tree.tree
    .filter((entry) => entry.type === "tree" && !entry.path.includes("/") && !entry.path.startsWith("."))
    .map((entry) => entry.path)
    .sort(compareText)
    .map((packageId) => discoveredPackage(packageId, paths));

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: null,
    source: {
      provider: "github",
      repository: `${source.owner}/${source.repository}`,
      ref: source.ref,
      commit: commitSha,
    },
    requiredFiles: REQUIRED_FILES,
    vocabularies: packages,
  };
  attachOrigin(manifest, { mode: "github-discovered", source, contentSource });
  return manifest;
}

function discoveredPackage(packageId, paths) {
  const ontologyRoot = `${packageId}/Ontology`;
  const hasOntologyData = Object.values(FILE_ALIASES).flat().some((filename) => paths.has(`${ontologyRoot}/${filename}`));
  const sourcePath = hasOntologyData ? ontologyRoot : packageId;
  const { files, errors } = discoverTableFiles(sourcePath, paths);
  const missing = ["concept", "synonym", "relationship"].filter((key) => !files[key]);
  if (missing.length) errors.push(`Missing jointly required files: ${missing.map((key) => FILE_ALIASES[key].join(" or ")).join(", ")}.`);
  const browseable = missing.length === 0 && errors.length === 0;
  return {
    packageId,
    displayName: packageId,
    sourcePath,
    browseable,
    status: browseable ? "available-unvalidated" : errors.some((error) => error.startsWith("Conflicting")) ? "conflicting-data" : "missing-required-data",
    vocabularyIds: [],
    files,
    capabilities: {
      conceptSearch: browseable,
      synonymSearch: browseable,
      relationships: browseable,
      hierarchy: Boolean(files.ancestor),
      vocabularyMetadata: Boolean(files.vocabulary),
    },
    counts: {},
    artifacts: {},
    warnings: [],
    errors,
  };
}

export async function fetchGitHubText(source, repositoryPath, { fetchImpl = globalThis.fetch, signal } = {}) {
  signal?.throwIfAborted();
  requireFetch(fetchImpl);
  assertRepositoryPath(repositoryPath);
  source = validatedGitHubSource(source);
  const encodedPath = repositoryPath.split("/").map(encodeURIComponent).join("/");
  // Public file content does not need a separate rate-limited Contents API call.
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/${encodeURIComponent(source.ref)}/${encodedPath}`;
  let response;
  try {
    response = await fetchImpl(url, {
      signal, credentials: "omit", redirect: "error",
      headers: { Accept: "text/plain, application/json" },
    });
  } catch {
    signal?.throwIfAborted();
    throw new SourceLoadError("Unable to reach GitHub. Check the network connection.", "NETWORK_FAILURE");
  }
  if (!response.ok) {
    const code = response.status === 404 ? "FILE_NOT_FOUND" : response.status === 429 ? "GITHUB_RATE_LIMIT" : "GITHUB_REQUEST_FAILED";
    throw new SourceLoadError(response.status === 403
      ? "GitHub refused the public file request. Check that the repository and selected ref are publicly accessible."
      : githubFailureMessage(response.status, repositoryPath), code, {
      status: response.status,
      path: repositoryPath,
    });
  }
  // Raw JSON is already the artifact, not a base64 Contents API envelope.
  try { return await response.text(); }
  catch {
    signal?.throwIfAborted();
    throw new SourceLoadError(`Unable to finish reading GitHub file: ${repositoryPath}.`, "NETWORK_FAILURE");
  }
}

async function fetchGitHubApi(source, endpoint, { fetchImpl, notFoundCode = "REPOSITORY_NOT_FOUND" }) {
  let response;
  try {
    response = await fetchImpl(`${apiBase(source)}${endpoint}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch {
    throw new SourceLoadError("Unable to reach GitHub. Check the network connection.", "NETWORK_FAILURE");
  }
  if (!response.ok) {
    const code = response.status === 404 ? notFoundCode : [403, 429].includes(response.status) ? "GITHUB_RATE_LIMIT" : "GITHUB_REQUEST_FAILED";
    throw new SourceLoadError(githubFailureMessage(response.status), code, { status: response.status });
  }
  return response.json();
}

function validatedGitHubSource(source) {
  if (!source || (source.provider && source.provider !== "github") ||
      [source.owner, source.repository, source.ref].some(value => typeof value !== "string")) {
    throw new SourceLoadError("Select a public GitHub repository.", "SOURCE_REQUIRED");
  }
  return resolveSource(`${source.owner}/${source.repository}@${source.ref}`);
}

function apiBase(source) {
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new SourceLoadError("The browser manifest is not an object.", "INVALID_MANIFEST");
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new SourceLoadError(
      `Manifest schema ${manifest.schemaVersion ?? "missing"} is unsupported; expected ${MANIFEST_SCHEMA_VERSION}.`,
      "UNSUPPORTED_MANIFEST_SCHEMA",
    );
  }
  if (!Array.isArray(manifest.vocabularies)) {
    throw new SourceLoadError("The browser manifest has no vocabulary array.", "INVALID_MANIFEST");
  }
  if (
    !Array.isArray(manifest.requiredFiles) ||
    REQUIRED_FILES.some((filename) => !manifest.requiredFiles.includes(filename))
  ) {
    throw new SourceLoadError(
      "The browser manifest does not declare all jointly required core files.",
      "INVALID_MANIFEST",
    );
  }
  for (const entry of manifest.vocabularies) {
    if (!entry?.packageId || typeof entry.packageId !== "string") {
      throw new SourceLoadError("A manifest vocabulary lacks packageId.", "INVALID_MANIFEST");
    }
    for (const relative of Object.values(entry.artifacts ?? {})) assertRepositoryPath(relative);
    for (const relative of Object.values(entry.files ?? {})) assertRepositoryPath(relative);
  }
}

function assertRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath === "" ||
    repositoryPath.startsWith("/") ||
    repositoryPath.includes("\\") ||
    repositoryPath.split("/").some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/u.test(part))
  ) {
    throw new SourceLoadError("The source contains an unsafe repository path.", "UNSAFE_REPOSITORY_PATH");
  }
}

async function fetchJson(url, fetchImpl, label) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new SourceLoadError(`Unable to load ${label}. Check the network connection.`, "NETWORK_FAILURE");
  }
  if (!response.ok) throw new SourceLoadError(`Unable to load ${label} (HTTP ${response.status}).`, "MANIFEST_UNAVAILABLE");
  try {
    return await response.json();
  } catch {
    throw new SourceLoadError(`The ${label} is not valid JSON.`, "INVALID_MANIFEST");
  }
}

function attachOrigin(manifest, origin) {
  Object.defineProperty(manifest, "__origin", { value: Object.freeze(origin), enumerable: false });
}


function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
}

function githubFailureMessage(status, repositoryPath = null) {
  if (status === 404) return repositoryPath ? `GitHub file not found: ${repositoryPath}.` : "The repository or ref was not found.";
  if (status === 403) return "GitHub refused the unauthenticated API request, usually because its public rate limit was reached. Try again after the limit resets, or choose a local folder.";
  if (status === 429) return "GitHub rate-limited this request. Wait before loading again, or choose a local folder.";
  return `GitHub request failed with HTTP ${status}.`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
