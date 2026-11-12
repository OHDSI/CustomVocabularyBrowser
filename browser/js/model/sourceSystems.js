// Source systems are independent of vocabulary and package membership.
// Each concept contributes at most once to each facet option.
export function sourceSystemValues(concept) {
  const raw = Array.isArray(concept.sourceSystems) ? concept.sourceSystems : [];
  const values = [...new Set(raw.filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean))];
  return values.length ? values : [null];
}

export function conceptFilterValues(concept, field) {
  return field === "sourceSystem" ? sourceSystemValues(concept) : [concept[field] ?? null];
}
