import { MANIFEST_SCHEMA_VERSION } from "../config.js";
import { RECOGNIZED_FILES, REQUIRED_FILES, SourceLoadError } from "./manifestService.js";

const REQUIRED_KEYS = Object.freeze(["concept", "synonym", "relationship"]);

export const LOCAL_SOURCE_PLACEHOLDER = Object.freeze({
  provider: "local-directory",
  folderName: null,
  canonical: "Local folder - selection required",
});

export async function createLocalDirectorySource(files) {
  const normalized = normalizeSelectedFiles(files);
  const packages = discoverLocalPackages(normalized.folderName, normalized.files);
  if (packages.length === 0) {
    throw new SourceLoadError(
      "The selected folder contains no recognized CVB vocabulary tables.",
      "LOCAL_VOCABULARY_NOT_FOUND",
    );
  }

  const source = Object.freeze({
    provider: "local-directory",
    folderName: normalized.folderName,
    canonical: `Local folder - ${normalized.folderName}`,
  });
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: null,
    source: {
      provider: "local-directory",
      folderName: normalized.folderName,
    },
    requiredFiles: REQUIRED_FILES,
    vocabularies: packages,
  };
  Object.defineProperty(manifest, "__origin", {
    value: Object.freeze({ mode: "local-directory", files: normalized.files }),
    enumerable: false,
  });
  return { source, manifest };
}

export function discoverLocalPackages(folderName, files) {
  const grouped = new Map();
  const keyByFilename = new Map(
    Object.entries(RECOGNIZED_FILES).map(([key, filename]) => [filename, key]),
  );

  for (const repositoryPath of files.keys()) {
    const segments = repositoryPath.split("/");
    const filename = segments.at(-1);
    const key = keyByFilename.get(filename);
    if (!key) continue;
    const sourcePath = segments.slice(0, -1).join("/");
    if (!grouped.has(sourcePath)) grouped.set(sourcePath, {});
    grouped.get(sourcePath)[key] = repositoryPath;
  }

  const seenPackageIds = new Set();
  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([sourcePath, packageFiles]) => {
      const packageId = packageIdFromPath(folderName, sourcePath);
      if (seenPackageIds.has(packageId)) {
        throw new SourceLoadError(
          `The selected folder contains more than one package named ${packageId}.`,
          "LOCAL_PACKAGE_COLLISION",
        );
      }
      seenPackageIds.add(packageId);
      const missing = REQUIRED_KEYS.filter((key) => !packageFiles[key]);
      const browseable = missing.length === 0;
      return {
        packageId,
        displayName: packageId,
        sourcePath: sourcePath || ".",
        browseable,
        status: browseable ? "available-unvalidated" : "missing-required-data",
        vocabularyIds: [],
        files: packageFiles,
        capabilities: {
          conceptSearch: browseable,
          synonymSearch: browseable,
          relationships: browseable,
          hierarchy: Boolean(packageFiles.ancestor),
          vocabularyMetadata: Boolean(packageFiles.vocabulary),
        },
        counts: {},
        artifacts: {},
        warnings: [],
        errors: browseable
          ? []
          : [`Missing jointly required files: ${missing.map((key) => RECOGNIZED_FILES[key]).join(", ")}.`],
      };
    });
}

function normalizeSelectedFiles(input) {
  const selected = Array.from(input ?? []);
  if (selected.length === 0) {
    throw new SourceLoadError("No local folder was selected.", "LOCAL_SELECTION_EMPTY");
  }

  const described = selected.map((file) => {
    const rawPath = file?.webkitRelativePath || file?.relativePath || file?.name;
    if (!file || typeof file.text !== "function" || typeof rawPath !== "string") {
      throw new SourceLoadError("The local folder selection contains an unreadable file.", "LOCAL_FILE_UNREADABLE");
    }
    return { file, path: normalizeRelativePath(rawPath) };
  });
  const firstSegments = described.map((item) => item.path.split("/")[0]);
  const hasSharedRoot = described.every((item) => item.path.includes("/") && item.path.split("/")[0] === firstSegments[0]);
  const folderName = hasSharedRoot ? firstSegments[0] : "Local vocabulary";
  const files = new Map();
  for (const item of described) {
    const repositoryPath = hasSharedRoot ? item.path.split("/").slice(1).join("/") : item.path;
    if (!repositoryPath || files.has(repositoryPath)) {
      throw new SourceLoadError("The local folder contains duplicate or invalid relative paths.", "LOCAL_PATH_COLLISION");
    }
    files.set(repositoryPath, item.file);
  }
  return { folderName, files };
}

function normalizeRelativePath(value) {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment))
  ) {
    throw new SourceLoadError("The local folder contains an unsafe relative path.", "LOCAL_PATH_UNSAFE");
  }
  return normalized;
}

function packageIdFromPath(folderName, sourcePath) {
  if (!sourcePath || sourcePath === "Ontology") return folderName;
  const segments = sourcePath.split("/");
  if (segments.at(-1).toLowerCase() === "ontology" && segments.length > 1) return segments.at(-2);
  return segments.at(-1);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
