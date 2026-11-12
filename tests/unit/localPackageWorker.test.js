import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalPackageInWorker } from "../../browser/js/services/localPackageWorkerClient.js";
import { CORE_FILE_NAMES, validSourceContent } from "../helpers/cvbFixtureRepository.js";

class FakeFile { constructor(text) { this.value = text; } async text() { return this.value; } }
const files = [{ key: "concept", path: "private/Ontology/concept.csv", file: new FakeFile("contents") }];

test("local builds without worker support or native File return the synchronous fallback signal", async () => {
  assert.equal(await buildLocalPackageInWorker("A", [{file:{}}], { WorkerClass: class {}, FileClass: FakeFile }), null);
});

test("worker receives files locally and returns its result; concurrent builds are serialized", async () => {
  let active = 0, maxActive = 0, closed = 0;
  class WorkerMock {
    constructor(url, options) {
      assert.match(String(url), /localPackageWorker\.js$/);
      assert.equal(options.type, "module");
      maxActive = Math.max(maxActive, ++active);
    }
    postMessage(message) {
      assert.equal(message.files[0].file, files[0].file);
      queueMicrotask(() => this.onmessage({data:{ok:true,built:{name:message.packageId}}}));
    }
    terminate() { active--; closed++; }
  }
  const opts = { WorkerClass: WorkerMock, FileClass: FakeFile };
  assert.deepEqual(await Promise.all([buildLocalPackageInWorker("A",files,opts), buildLocalPackageInWorker("B",files,opts)]), [{name:"A"},{name:"B"}]);
  assert.equal(maxActive,1);
  assert.equal(closed,2);
});

test("worker failures and clone errors are surfaced instead of retrying on the main thread", async () => {
  let terminated = 0;
  class WorkerFails { postMessage() { queueMicrotask(() => this.onmessage({data:{ok:false,error:{message:"bad CSV",code:"INVALID_REQUIRED_DATA"}}})); } terminate() { terminated++; } }
  await assert.rejects(buildLocalPackageInWorker("A",files,{WorkerClass:WorkerFails,FileClass:FakeFile}), {message:"bad CSV",code:"INVALID_REQUIRED_DATA"});
  class CloneFails { postMessage() { throw new Error("cannot clone"); } terminate() { terminated++; } }
  await assert.rejects(buildLocalPackageInWorker("A",files,{WorkerClass:CloneFails,FileClass:FakeFile}), /cannot clone/);
  assert.equal(terminated,2);
});

test("worker builds a synthetic package from local files and result can be structured cloned", async () => {
  const previousSelf = globalThis.self;
  let result;
  globalThis.self = { postMessage: (value) => { result = structuredClone(value); } };
  try {
    await import("../../browser/js/services/localPackageWorker.js");
    const keys = ["concept", "synonym", "relationship"];
    const fixture = CORE_FILE_NAMES.map((name,i) => ({ key:keys[i], path:`ALPHA/Ontology/${name}`, file:new FakeFile(validSourceContent(`ALPHA/Ontology/${name}`)) }));
    await globalThis.self.onmessage({ data:{ packageId:"ALPHA", files:fixture } });
    assert.equal(result.ok,true);
    assert.equal(result.built.concepts.concepts.length,2);
    assert.equal(result.built.relationships.rows.length,4);
  } finally { globalThis.self = previousSelf; }
});

test("abort terminates an active worker, ignores late results and releases the queue", async () => {
  let terminated = 0, instance;
  class WorkerPending { constructor() { instance = this; } postMessage() {} terminate() { terminated++; } }
  const controller = new AbortController();
  const result = buildLocalPackageInWorker("A", files, { WorkerClass: WorkerPending, FileClass: FakeFile, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  instance.onmessage({ data: { ok: true, built: {} } });
  assert.equal(terminated, 1);
  await assert.rejects(buildLocalPackageInWorker("B", files, { WorkerClass: WorkerPending, FileClass: FakeFile, signal: controller.signal }), { name: "AbortError" });
});

test("streaming worker matches the existing parser for native File inputs", async () => {
  const previous = globalThis.self;
  let result; const progress = [];
  globalThis.self = { postMessage: value => value.progress ? progress.push(value.progress) : result = structuredClone(value) };
  try {
    await import("../../browser/js/services/localPackageWorker.js?streaming-test");
    const keys = ["concept", "synonym", "relationship"];
    const fixture = CORE_FILE_NAMES.map((name, i) => ({ key: keys[i], path: `ALPHA/Ontology/${name}`, file: new File([validSourceContent(`ALPHA/Ontology/${name}`)], name) }));
    await self.onmessage({ data: { packageId: "ALPHA", files: fixture } });
    assert.equal(result.ok, true);
    assert.equal(result.built.concepts.concepts.length, 2);
    assert.ok(progress.some(item => item.phase === "reading"));
    assert.equal(progress.at(-1).phase, "building");
  } finally { globalThis.self = previous; }
});
