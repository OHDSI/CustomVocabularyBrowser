import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateBrowserData } from "./validate-browser-data.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const BROWSER_ROOT = path.join(PROJECT_ROOT, "browser");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");

export async function buildSite() {
  await validateBrowserData(path.join(BROWSER_ROOT, "data"));
  if (path.dirname(DIST_ROOT) !== PROJECT_ROOT || path.basename(DIST_ROOT) !== "dist") {
    throw new Error("Resolved static-site output escaped the project directory.");
  }
  await rm(DIST_ROOT, { recursive: true, force: true });
  await mkdir(DIST_ROOT, { recursive: true });
  await cp(BROWSER_ROOT, DIST_ROOT, { recursive: true });
  await stat(path.join(DIST_ROOT, "index.html"));
  await stat(path.join(DIST_ROOT, "data", "manifest.json"));
  return DIST_ROOT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Static site built at ${await buildSite()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

