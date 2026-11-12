import { createBatchSubmissionDraft } from "../services/mappingBatchService.js";

/** Run an asynchronous local file read only while its originating UI session remains current. */
export function createBatchDraftRunner({ readSelection, captureGuard, isCurrent, validateConcept, onDraft }) {
  let generation = 0;
  function invalidate() { generation += 1; }
  async function run() {
    const ticket = ++generation;
    const selected = readSelection();
    const guard = captureGuard();
    const current = () => ticket === generation && readSelection() === selected && isCurrent(guard);
    if (!current()) return false;
    if (!selected) {
      onDraft({ valid: false, errors: ["Choose a JSON batch file."], draft: null });
      return true;
    }
    let result;
    try {
      const input = JSON.parse(await selected.text());
      if (!current()) return false;
      result = createBatchSubmissionDraft(input, guard.context, validateConcept);
    } catch (error) {
      if (!current()) return false;
      result = { valid: false, errors: [`Could not read the JSON batch: ${error.message}`], draft: null };
    }
    if (!current()) return false;
    onDraft(result);
    return true;
  }
  return { run, invalidate };
}
