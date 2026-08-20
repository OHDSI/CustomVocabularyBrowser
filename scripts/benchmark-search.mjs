import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SearchService } from "../browser/js/services/searchService.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

export async function benchmarkSearch({ dataRoot, rounds = 20, output = null } = {}) {
  const root = path.resolve(dataRoot ?? path.join(PROJECT_ROOT, "browser", "data"));
  const manifest = await readJson(path.join(root, "manifest.json"));
  const entry = [...manifest.vocabularies]
    .filter((candidate) => candidate.browseable)
    .sort((left, right) => right.counts.concepts - left.counts.concepts)[0];
  if (!entry) throw new Error("No browseable package is available for benchmarking.");
  const conceptsArtifact = await readJson(path.join(root, ...entry.artifacts.concepts.split("/")));
  const searchArtifact = await readJson(path.join(root, ...entry.artifacts.search.split("/")));

  const constructionStart = performance.now();
  const service = new SearchService({ concepts: conceptsArtifact.concepts, search: searchArtifact });
  const constructionMs = performance.now() - constructionStart;
  const example = conceptsArtifact.concepts[Math.floor(conceptsArtifact.concepts.length / 2)];
  const fuzzyQuery = transposeFirstPair(example.conceptName);
  const cases = {
    exactId: example.conceptId,
    exactCode: example.conceptCode,
    exactName: example.conceptName,
    namePrefix: example.conceptName.slice(0, Math.max(3, Math.min(8, example.conceptName.length))),
    fuzzyName: fuzzyQuery,
  };
  const timings = {};
  for (const [name, query] of Object.entries(cases)) {
    service.search({ query, pageSize: 25 });
    const samples = [];
    for (let index = 0; index < rounds; index += 1) {
      const started = performance.now();
      service.search({ query, pageSize: 25 });
      samples.push(performance.now() - started);
    }
    timings[name] = summarize(samples);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    sourceCommit: manifest.source.commit,
    packageId: entry.packageId,
    conceptCount: entry.counts.concepts,
    searchArtifactBytes: Buffer.byteLength(JSON.stringify(searchArtifact)),
    constructionMs: round(constructionMs),
    rounds,
    timings,
  };
  if (output) await writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    minMs: round(sorted[0]),
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1)),
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function transposeFirstPair(value) {
  const characters = Array.from(value);
  if (characters.length < 2) return `${value}x`;
  [characters[0], characters[1]] = [characters[1], characters[0]];
  return characters.join("");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/u, "");
    const value = argv[index + 1];
    if (!key || value == null) throw new Error("Benchmark arguments use --name value pairs.");
    options[key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (options.rounds) options.rounds = Number(options.rounds);
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await benchmarkSearch(parseArguments(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

