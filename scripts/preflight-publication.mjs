import { execFileSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { forbiddenPackagePaths } from "./check-no-package-data.mjs";

// Conservative decimal threshold: smaller than GitHub's 100 MiB hard limit.
export const SAFE_FILE_LIMIT_BYTES = 100_000_000;

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8", maxBuffer: SAFE_FILE_LIMIT_BYTES + 1_048_576, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
}
function paths(repo, args) {
  return git(repo, args).split("\0").filter(Boolean).sort();
}
function category(name) {
  if (name.startsWith("browser/data/")) return "generated browser data";
  if (name.startsWith("browser/")) return "browser asset (included in site build)";
  return "other project file";
}
async function worktreeSize(root, name) {
  try {
    const stat = await lstat(path.join(root, ...name.split("/")));
    return stat.isFile() ? stat.size : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function chunkPath(metadataPath, file) {
  if (typeof file !== "string" || !/^mapping-metadata-\d{5,}\.json$/u.test(file)) return null;
  return `${metadataPath.slice(0, metadataPath.lastIndexOf("/") + 1)}${file}`;
}
function indexHasBlob(root, name) {
  try { return git(root, ["cat-file", "-t", `:${name}`]).trim() === "blob"; }
  catch { return false; }
}

/** Inspect candidate names, sizes and staged metadata references without printing contents or changing Git. */
export async function inspectPublicationCandidates(repo = process.cwd()) {
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const stagedNames = paths(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--"]);
  // ls-files --modified includes all index/worktree differences, including stat-dirty entries.
  const modifiedNames = paths(root, ["ls-files", "--modified", "-z"]);
  const untrackedNames = paths(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const staged = stagedNames.map((name) => ({ path: name, bytes: Number(git(root, ["cat-file", "-s", `:${name}`]).trim()), category: category(name) }));
  const worktree = await Promise.all([...modifiedNames.map((name) => ({ name, state: "modified tracked" })),
    ...untrackedNames.map((name) => ({ name, state: "untracked" }))].map(async ({ name, state }) => {
    let indexedBytes = null;
    if (state === "modified tracked" && category(name) === "generated browser data") {
      try { indexedBytes = Number(git(root, ["cat-file", "-s", `:${name}`]).trim()); } catch { /* Deleted or conflicted index entry. */ }
    }
    return { path: name, state, bytes: await worktreeSize(root, name), indexedBytes, category: category(name) };
  }));
  const ignoredChunks = paths(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "browser/data/vocabularies"])
    .filter((name) => /^browser\/data\/vocabularies\/.+\/mapping-metadata-\d{5,}\.json$/u.test(name));
  const referenceProblems = [];
  for (const row of staged) {
    if (!/^browser\/data\/vocabularies\/.+\/metadata\.json$/u.test(row.path)) continue;
    if (!Number.isSafeInteger(row.bytes) || row.bytes >= SAFE_FILE_LIMIT_BYTES) {
      referenceProblems.push({ path: row.path, reason: "Metadata too large to inspect safely" });
      continue;
    }
    let data;
    try { data = JSON.parse(git(root, ["show", `:${row.path}`])); }
    catch { referenceProblems.push({ path: row.path, reason: "Staged metadata is not valid JSON" }); continue; }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      referenceProblems.push({ path: row.path, reason: "Staged metadata is not a JSON object" }); continue;
    }
    if (data.mappingMetadataChunks === undefined) continue;
    if (!Array.isArray(data.mappingMetadataChunks)) {
      referenceProblems.push({ path: row.path, reason: "Invalid mapping chunk list" }); continue;
    }
    for (const part of data.mappingMetadataChunks) {
      const chunk = chunkPath(row.path, part?.file);
      if (!chunk) { referenceProblems.push({ path: row.path, reason: "Invalid mapping chunk filename" }); continue; }
      if (!indexHasBlob(root, chunk)) referenceProblems.push({ path: chunk, reason: "Referenced mapping chunk is missing from the index" });
    }
  }
  return { staged, worktree, ignoredChunks, referenceProblems };
}

export function formatPublicationReport(result) {
  const lines = ["Publication preflight (read-only; candidate names and byte counts only)",
    "These checks cannot determine whether content is public. Review provenance and staged diffs before publication.",
    "Other ignored files are not listed; already tracked files stay tracked and git add -f can override ignore rules.",
    "The site build copies application assets only. Vocabulary package data must never be staged or published.",
    "Stage only individually reviewed paths. Do not use git add -A while local data is unreviewed.",
    `Conservative size warning threshold: ${SAFE_FILE_LIMIT_BYTES} bytes.`,
    `Staged files: ${result.staged.length}`];
  for (const row of result.staged) lines.push(`STAGED ${JSON.stringify(row.path)} ${row.bytes} bytes [${row.category}]${row.bytes >= SAFE_FILE_LIMIT_BYTES ? " LARGE" : ""}`);
  lines.push(`Modified tracked or untracked, non-ignored worktree files: ${result.worktree.length}`);
  for (const row of result.worktree) {
    const indexed = row.indexedBytes != null ? `; index ${row.indexedBytes} bytes` : "";
    lines.push(`${row.state.toUpperCase()} ${JSON.stringify(row.path)} ${row.bytes == null ? "not a regular file" : `${row.bytes} bytes`}${indexed} [${row.category}]${row.bytes >= SAFE_FILE_LIMIT_BYTES ? " LARGE WORKTREE WARNING - do not stage" : ""}`);
  }
  lines.push(`Ignored generated mapping chunks not in index: ${(result.ignoredChunks ?? []).length}`);
  for (const name of result.ignoredChunks ?? []) lines.push(`IGNORED CHUNK ${JSON.stringify(name)}: keep outside this application repository; do not stage`);
  for (const name of forbiddenPackagePaths(result.staged.map((item) => item.path))) lines.push(`BLOCKED ${JSON.stringify(name)}: package data is forbidden in this repository`);
  for (const item of result.referenceProblems ?? []) lines.push(`BLOCKED ${JSON.stringify(item.path)}: ${item.reason}`);
  return lines.join("\n");
}

export function publicationHasBlockingIssues(result) {
  // Unstaged large data and ignored chunks warn; only staged content can block a code-only commit.
  return result.staged.some((item) => item.bytes >= SAFE_FILE_LIMIT_BYTES)
    || forbiddenPackagePaths(result.staged.map((item) => item.path)).length > 0
    || (result.referenceProblems ?? []).length > 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await inspectPublicationCandidates();
    console.log(formatPublicationReport(result));
    if (publicationHasBlockingIssues(result)) process.exitCode = 1;
  } catch (error) {
    console.error(`Publication preflight could not complete: ${error.message}`);
    process.exitCode = 1;
  }
}
