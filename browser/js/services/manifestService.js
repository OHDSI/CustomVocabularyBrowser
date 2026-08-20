import { DEFAULT_SOURCE, LOCAL_MANIFEST_URL, MANIFEST_SCHEMA_VERSION } from "../config.js";

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
  { fetchImpl = globalThis.fetch, localManifestUrl = LOCAL_MANIFEST_URL } = {},
) {
  requireFetch(fetchImpl);
  if (sameSource(source, DEFAULT_SOURCE)) {
    const manifest = await fetchJson(localManifestUrl, fetchImpl, "default browser manifest");
    validateManifest(manifest);
    attachOrigin(manifest, { mode: "local", baseUrl: new URL("./", localManifestUrl).href });
    return manifest;
  }

  try {
    const text = await fetchGitHubText(source, "browser/data/manifest.json", { fetchImpl });
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
    attachOrigin(manifest, { mode: "github-prebuilt", source });
    return manifest;
  } catch (error) {
    if (error instanceof SourceLoadError && !["FILE_NOT_FOUND", "PREBUILT_UNAVAILABLE"].includes(error.code)) {
      throw error;
    }
  }

  return discoverGitHubManifest(source, { fetchImpl });
}

export async function discoverGitHubManifest(source, { fetchImpl = globalThis.fetch } = {}) {
  requireFetch(fetchImpl);
  const commit = await fetchGitHubApi(
    source,
    `/commits/${encodeURIComponent(source.ref)}`,
    { fetchImpl, notFoundCode: "REF_NOT_FOUND" },
  );
  const commitSha = commit?.sha;
  if (!/^[0-9a-f]{40}$/iu.test(commitSha ?? "")) {
    throw new SourceLoadError("GitHub returned no usable commit SHA for the selected ref.", "INVALID_GITHUB_RESPONSE");
  }
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
  attachOrigin(manifest, { mode: "github-discovered", source });
  return manifest;
}

function discoveredPackage(packageId, paths) {
  const ontologyRoot = `${packageId}/Ontology`;
  const hasOntologyData = Object.values(RECOGNIZED_FILES).some((filename) => paths.has(`${ontologyRoot}/${filename}`));
  const sourcePath = hasOntologyData ? ontologyRoot : packageId;
  const files = {};
  for (const [key, filename] of Object.entries(RECOGNIZED_FILES)) {
    const candidate = `${sourcePath}/${filename}`;
    if (paths.has(candidate)) files[key] = candidate;
  }
  const missing = ["concept", "synonym", "relationship"].filter((key) => !files[key]);
  const browseable = missing.length === 0;
  return {
    packageId,
    displayName: packageId,
    sourcePath,
    browseable,
    status: browseable ? "available-unvalidated" : "missing-required-data",
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
    errors: browseable
      ? []
      : [`Missing jointly required files: ${missing.map((key) => RECOGNIZED_FILES[key]).join(", ")}.`],
  };
}

export async function fetchGitHubText(source, repositoryPath, { fetchImpl = globalThis.fetch } = {}) {
  requireFetch(fetchImpl);
  assertRepositoryPath(repositoryPath);
  const encodedPath = repositoryPath.split("/").map(encodeURIComponent).join("/");
  const url = `${apiBase(source)}/contents/${encodedPath}?ref=${encodeURIComponent(source.ref)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new SourceLoadError("Unable to reach GitHub. Check the network connection.", "NETWORK_FAILURE");
  }
  if (!response.ok) {
    const code = response.status === 404 ? "FILE_NOT_FOUND" : response.status === 403 ? "GITHUB_RATE_LIMIT" : "GITHUB_REQUEST_FAILED";
    throw new SourceLoadError(githubFailureMessage(response.status, repositoryPath), code, {
      status: response.status,
      path: repositoryPath,
    });
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await response.json();
    if (typeof payload?.content !== "string") {
      throw new SourceLoadError(`GitHub returned no content for ${repositoryPath}.`, "INVALID_GITHUB_RESPONSE");
    }
    return decodeBase64Utf8(payload.content.replace(/\s+/gu, ""));
  }
  return response.text();
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
    const code = response.status === 404 ? notFoundCode : response.status === 403 ? "GITHUB_RATE_LIMIT" : "GITHUB_REQUEST_FAILED";
    throw new SourceLoadError(githubFailureMessage(response.status), code, { status: response.status });
  }
  return response.json();
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

function decodeBase64Utf8(content) {
  const binary = globalThis.atob(content);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function attachOrigin(manifest, origin) {
  Object.defineProperty(manifest, "__origin", { value: Object.freeze(origin), enumerable: false });
}

function sameSource(left, right) {
  return (
    left?.owner?.toLowerCase() === right.owner.toLowerCase() &&
    left?.repository?.toLowerCase() === right.repository.toLowerCase() &&
    left?.ref === right.ref
  );
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
}

function githubFailureMessage(status, repositoryPath = null) {
  if (status === 404) return repositoryPath ? `GitHub file not found: ${repositoryPath}.` : "The repository or ref was not found.";
  if (status === 403) return "GitHub refused the unauthenticated request, usually because the public API rate limit was reached.";
  return `GitHub request failed with HTTP ${status}.`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
