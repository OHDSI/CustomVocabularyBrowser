import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function forbiddenPackagePaths(names) {
  return names.filter(name => /^(?:browser\/data|dist|\.source|local-data)(?:\/|$)/i.test(name)
    || /\.(?:csv|tsv)$/i.test(name));
}

export function checkTrackedPackageData(root = process.cwd()) {
  const names = execFileSync("git", ["ls-files", "-z"], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).split("\0").filter(Boolean);
  const forbidden = forbiddenPackagePaths(names);
  if (forbidden.length) throw new Error(`Package data must not be tracked in the browser repository:\n${forbidden.join("\n")}`);
  return names.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Checked ${checkTrackedPackageData()} tracked paths: no package data.`); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
