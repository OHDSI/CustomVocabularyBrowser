const DEFAULT_REF = "main";
const GITHUB_HOST = "github.com";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const URL_LIKE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * An expected failure while parsing or validating a vocabulary source.
 */
export class SourceResolutionError extends Error {
  constructor(message, code = "INVALID_SOURCE") {
    super(message);
    this.name = "SourceResolutionError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new SourceResolutionError(message, code);
}

function rejectUnsafeRawInput(input) {
  if (CONTROL_CHARACTERS.test(input)) {
    fail("Source identifiers must not contain control characters.", "UNSAFE_INPUT");
  }
  if (input !== input.trim()) {
    fail("Source identifiers must not contain surrounding whitespace.", "INVALID_FORMAT");
  }
  if (ENCODED_PATH_SEPARATOR.test(input)) {
    fail("Encoded path separators are not allowed.", "UNSAFE_INPUT");
  }
  if (input.includes("\\")) {
    fail("Backslashes are not allowed in source identifiers.", "UNSAFE_INPUT");
  }
  if (input.includes("?") || input.includes("#")) {
    fail("Queries and fragments are not allowed in source identifiers.", "URL_DECORATION_NOT_ALLOWED");
  }
}

function validateOwner(owner) {
  if (
    owner.length > 39 ||
    !OWNER_PATTERN.test(owner) ||
    owner.includes("--") ||
    owner === "." ||
    owner === ".."
  ) {
    fail("The GitHub owner is malformed.", "INVALID_OWNER");
  }
}

function normalizeRepository(repository) {
  const normalized = repository.endsWith(".git")
    ? repository.slice(0, -4)
    : repository;

  if (
    normalized.length === 0 ||
    normalized.length > 100 ||
    !REPOSITORY_PATTERN.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    fail("The GitHub repository is malformed.", "INVALID_REPOSITORY");
  }

  return normalized;
}

function validateRef(ref) {
  const parts = ref.split("/");
  if (
    ref.length === 0 ||
    ref.length > 1024 ||
    !REF_PATTERN.test(ref) ||
    ref === "@" ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    parts.some(part =>
      part === "." ||
      part === ".." ||
      part.startsWith(".") ||
      part.endsWith(".lock")
    )
  ) {
    fail("The GitHub ref is malformed.", "INVALID_REF");
  }
}

function decodePathSegment(segment) {
  try {
    const decoded = decodeURIComponent(segment);
    if (CONTROL_CHARACTERS.test(decoded)) {
      fail("Source paths must not contain control characters.", "UNSAFE_INPUT");
    }
    return decoded;
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
    fail("The GitHub URL contains malformed percent encoding.", "INVALID_FORMAT");
  }
}

function rawUrlPath(input) {
  const authorityStart = input.indexOf("//") + 2;
  const pathStart = input.indexOf("/", authorityStart);
  return pathStart === -1 ? "/" : input.slice(pathStart);
}

function parseGitHubUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    fail("The source URL is malformed.", "INVALID_FORMAT");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    fail("Only HTTP or HTTPS GitHub URLs are supported.", "UNSUPPORTED_PROTOCOL");
  }
  if (url.username || url.password) {
    fail("Embedded URL credentials are not allowed.", "CREDENTIALS_NOT_ALLOWED");
  }
  if (url.hostname.toLowerCase() !== GITHUB_HOST || url.port) {
    fail("Only github.com repository URLs are supported.", "UNSUPPORTED_HOST");
  }

  const rawSegments = rawUrlPath(input).split("/");
  if (rawSegments[0] !== "") {
    fail("The GitHub URL path is malformed.", "INVALID_FORMAT");
  }
  rawSegments.shift();
  if (rawSegments.at(-1) === "") rawSegments.pop();
  if (rawSegments.some(segment => segment === "")) {
    fail("The GitHub URL path is malformed.", "INVALID_FORMAT");
  }

  const segments = rawSegments.map(decodePathSegment);
  if (segments.length < 2) {
    fail("The GitHub URL must identify an owner and repository.", "INVALID_FORMAT");
  }

  const [owner, repositorySegment] = segments;
  let ref = DEFAULT_REF;

  if (segments.length === 4 && segments[2] === "tree") {
    ref = segments[3];
  } else if (segments.length > 2) {
    const code = segments[2] === "tree" ? "AMBIGUOUS_PATH" : "INVALID_FORMAT";
    fail("Repository paths after the ref are ambiguous and are not supported.", code);
  }

  return { owner, repository: normalizeRepository(repositorySegment), ref };
}

function parseShortIdentifier(input) {
  const atIndex = input.indexOf("@");
  if (atIndex !== input.lastIndexOf("@")) {
    fail("A source identifier may contain at most one ref separator.", "INVALID_FORMAT");
  }

  const repositoryPart = atIndex === -1 ? input : input.slice(0, atIndex);
  const ref = atIndex === -1 ? DEFAULT_REF : input.slice(atIndex + 1);
  const repositorySegments = repositoryPart.split("/");

  if (repositorySegments.length !== 2) {
    fail("Use the owner/repository source format.", "INVALID_FORMAT");
  }

  return {
    owner: repositorySegments[0],
    repository: normalizeRepository(repositorySegments[1]),
    ref
  };
}

/**
 * Resolve a supported public GitHub identifier into its canonical descriptor.
 *
 * @param {string} source User-supplied repository identifier or GitHub URL.
 * @returns {Readonly<{provider: "github", owner: string, repository: string, ref: string, canonical: string}>}
 * @throws {SourceResolutionError} If the identifier is unsupported or unsafe.
 */
export function resolveSource(source) {
  if (typeof source !== "string") {
    fail("The source identifier must be a string.", "INVALID_TYPE");
  }
  if (source.length === 0) {
    fail("The source identifier must not be empty.", "INVALID_FORMAT");
  }

  rejectUnsafeRawInput(source);

  const parsed = URL_LIKE_PATTERN.test(source)
    ? parseGitHubUrl(source)
    : parseShortIdentifier(source);

  validateOwner(parsed.owner);
  validateRef(parsed.ref);

  return Object.freeze({
    provider: "github",
    owner: parsed.owner,
    repository: parsed.repository,
    ref: parsed.ref,
    canonical: `${parsed.owner}/${parsed.repository}@${parsed.ref}`
  });
}

export default resolveSource;
