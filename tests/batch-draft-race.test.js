import test from "node:test";
import assert from "node:assert/strict";
import { createBatchDraftRunner } from "../browser/js/ui/batchDraftRunner.js";

const json = JSON.stringify([{ kind: "concept", concept_name: "Test", concept_code: "T", vocabulary_id: "V" }]);
const validateConcept = (values) => ({ valid: true, errors: [], draft: { kind: "concept", record: values } });
function fixture() {
  let finish;
  let state = { open: true, kind: "batch", context: { packageId: "A" }, destination: "owner/repo" };
  let selected = { text: () => new Promise((resolve) => { finish = resolve; }) };
  const output = [];
  const runner = createBatchDraftRunner({
    readSelection: () => selected,
    captureGuard: () => ({ ...state }),
    isCurrent: (guard) => state.open && state.kind === "batch" && guard.context === state.context && guard.destination === state.destination,
    validateConcept,
    onDraft: (result) => output.push(result),
  });
  return { runner, output, resolve: () => finish(json), update: (changes) => { state = { ...state, ...changes }; }, select: (file) => { selected = file; } };
}

test("batch reader emits only for the current file and session", async () => {
  const f = fixture();
  const task = f.runner.run();
  f.resolve();
  assert.equal(await task, true);
  assert.equal(f.output.length, 1);
  assert.equal(f.output[0].draft.kind, "batch");
});

for (const [name, change] of [
  ["file", (f) => f.select({ text: async () => json })],
  ["draft type", (f) => f.update({ kind: "concept" })],
  ["dialog", (f) => f.update({ open: false })],
  ["source or package", (f) => f.update({ context: { packageId: "B" } })],
  ["destination", (f) => f.update({ destination: "other/repo" })],
  ["invalidated session", (f) => f.runner.invalidate()],
]) {
  test(`batch reader discards results after ${name} changes`, async () => {
    const f = fixture();
    const task = f.runner.run();
    change(f);
    f.resolve();
    assert.equal(await task, false);
    assert.equal(f.output.length, 0);
  });
}

test("batch reader does not resurrect an invalidated session after values revert", async () => {
  const f = fixture();
  const task = f.runner.run();
  f.runner.invalidate();
  f.resolve();
  assert.equal(await task, false);
  assert.equal(f.output.length, 0);
});
