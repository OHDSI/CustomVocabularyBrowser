import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { startStaticServer } from "../../scripts/serve-site.mjs";

test("local server safely serves and compresses the static browser", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cvb-static-server-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "data"));
  await mkdir(path.join(root, "fonts"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>CVB test</title>", "utf8");
  const largeJson = JSON.stringify({ values: Array.from({ length: 10_000 }, (_, index) => `concept-${index}`) });
  await writeFile(path.join(root, "data", "concepts.json"), largeJson, "utf8");
  await writeFile(path.join(root, "fonts", "browser-font.ttf"), new Uint8Array([0, 1, 0, 0]));

  const server = await startStaticServer({ root, port: 0 });
  t.after(async () => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const index = await fetch(`${baseUrl}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /CVB test/u);
  assert.equal(index.headers.get("cache-control"), "no-store");

  const artifact = await fetch(`${baseUrl}/data/concepts.json`, {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("content-encoding"), "gzip");
  assert.deepEqual(await artifact.json(), JSON.parse(largeJson));

  const font = await fetch(`${baseUrl}/fonts/browser-font.ttf`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/ttf");

  const head = await fetch(`${baseUrl}/data/concepts.json`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  assert.equal((await fetch(`${baseUrl}/missing.json`)).status, 404);
  assert.equal(await rawStatus(address.port, "/%2e%2e%5cpackage.json"), 400);
});

function rawStatus(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}
