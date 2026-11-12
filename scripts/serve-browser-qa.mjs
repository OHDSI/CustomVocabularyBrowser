import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { CORE_FILE_NAMES, validSourceContent } from "../tests/helpers/cvbFixtureRepository.js";

// Test-only loopback server. Never used by build:site or the user-facing server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oracle = process.env.CVB_QA_ORACLE ? JSON.parse(await readFile(process.env.CVB_QA_ORACLE, "utf8")) : null;
const synthetic = CORE_FILE_NAMES.map((name) => ({ path: `Synthetic/ALPHA/Ontology/${name}`, text: validSourceContent(`ALPHA/Ontology/${name}`) }));
const reportPath = process.env.CVB_QA_REPORT;
const json = (res, value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/qa/fixtures") return json(res, synthetic);
    if (url.pathname === "/qa/oracle") return json(res, oracle);
    if (url.pathname.startsWith("/qa/csv/")) {
      const index = Number(url.pathname.slice(8)), descriptor = oracle?.sourceDescriptors[index];
      if (!descriptor || !Number.isSafeInteger(index)) { res.writeHead(404); res.end(); return; }
      const bytes = await readFile(path.join(oracle.sourceRoot, descriptor.path));
      if (sha(bytes) !== descriptor.SHA256) throw new Error("Source CSV changed since the oracle.");
      res.setHeader("Content-Type", "application/octet-stream"); res.end(bytes); return;
    }
    if (url.pathname === "/qa/report" && req.method === "POST") {
      let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error("Report too large"); }
      const report = JSON.parse(body);
      if (oracle) {
        report.sourceUnchanged = true;
        for (const file of oracle.sourceDescriptors) if (sha(await readFile(path.join(oracle.sourceRoot, file.path))) !== file.SHA256) report.sourceUnchanged = false;
      }
      if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2));
      json(res, { saved: Boolean(reportPath) }); return;
    }
    const name = decodeURIComponent(url.pathname === "/" ? "/tests/browser/snapshotHarness.html" : url.pathname);
    const file = path.resolve(root, `.${name}`);
    if (!file.startsWith(root + path.sep) || name.includes("\\") || name.split("/").some(part => part.startsWith("."))) { res.writeHead(400); res.end(); return; }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf" }[path.extname(file)];
    if (!type) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", type); res.setHeader("Cache-Control", "no-store");
    const stream = createReadStream(file); stream.on("error", () => { if (!res.headersSent) res.writeHead(404); res.end(); }); stream.pipe(res);
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error.message); }
});
server.listen(Number(process.env.CVB_QA_PORT || 4175), "127.0.0.1", () => console.log("Browser QA: http://127.0.0.1:" + server.address().port));
