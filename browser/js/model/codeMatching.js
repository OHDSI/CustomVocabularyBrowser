/** Case-insensitive comparison only; original source and display values are unchanged. */
export function normalizeConceptCode(code) { return String(code ?? "").toLowerCase(); }
export function sameConceptCode(left, right) { return normalizeConceptCode(left) === normalizeConceptCode(right); }
/** Callers keep packages separate; vocabulary identifiers remain exact. */
export function conceptCodeKey(vocabularyId, code) { return JSON.stringify([vocabularyId, normalizeConceptCode(code)]); }
