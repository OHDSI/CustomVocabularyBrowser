import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER_ROOT = path.join(PROJECT_ROOT, "browser");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const ASSET_RULES = Object.freeze({ css: /\.css$/i, js: /\.js$/i, fonts: /\.(?:ttf|woff2?|txt|md)$/i });

// Copy application assets only. Raw tables and generated JSON cannot enter the
// public artifact even when a local browser/data directory exists.
async function copyAssets(source, destination, allowed) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Application assets must not contain symlinks.");
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyAssets(from, to, allowed);
    else if (entry.isFile() && allowed.test(entry.name)) await cp(from, to);
    else throw new Error(`Unexpected application asset: ${from}`);
  }
}

export async function buildSite() {
  if (path.dirname(DIST_ROOT) !== PROJECT_ROOT || path.basename(DIST_ROOT) !== "dist") {
    throw new Error("Resolved static-site output escaped the project directory.");
  }
  await rm(DIST_ROOT, { recursive: true, force: true });
  await mkdir(DIST_ROOT, { recursive: true });
  await cp(path.join(BROWSER_ROOT, "index.html"), path.join(DIST_ROOT, "index.html"));
  for (const [name, allowed] of Object.entries(ASSET_RULES)) {
    await copyAssets(path.join(BROWSER_ROOT, name), path.join(DIST_ROOT, name), allowed);
  }
  await stat(path.join(DIST_ROOT, "index.html"));
  return DIST_ROOT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Data-free static site built at ${await buildSite()}`); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
