const SCORE = Object.freeze({
  exactConceptId: 1000,
  exactConceptCode: 900,
  exactConceptName: 800,
  exactSynonym: 700,
  conceptNamePrefix: 600,
  synonymPrefix: 500,
  conceptNameToken: 300,
  synonymToken: 200,
  fuzzyConceptName: 100,
  fuzzySynonym: 50,
});

const FILTER_FIELDS = Object.freeze({
  vocabularyId: ["vocabularyId", "vocabulary_id"],
  domainId: ["domainId", "domain_id"],
  conceptClassId: ["conceptClassId", "concept_class_id"],
  standardConcept: ["standardConcept", "standard_concept"],
  invalidReason: ["invalidReason", "invalid_reason"],
});

const SORT_FIELDS = Object.freeze({
  conceptId: ["conceptId", "concept_id"],
  conceptName: ["conceptName", "concept_name"],
  domainId: FILTER_FIELDS.domainId,
  vocabularyId: FILTER_FIELDS.vocabularyId,
  conceptClassId: FILTER_FIELDS.conceptClassId,
  standardConcept: FILTER_FIELDS.standardConcept,
  conceptCode: ["conceptCode", "concept_code"],
  validStartDate: ["validStartDate", "valid_start_date"],
  validEndDate: ["validEndDate", "valid_end_date"],
  invalidReason: FILTER_FIELDS.invalidReason,
});

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, " ");
}

export function tokenizeSearchText(value) {
  return normalizeSearchText(value).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function parseIntegerString(value) {
  const text = String(value ?? "").trim();
  const match = /^([+-]?)(\d+)$/u.exec(text);
  if (!match) return null;

  const digits = match[2].replace(/^0+(?=\d)/u, "");
  const negative = match[1] === "-" && digits !== "0";
  return { negative, digits, canonical: `${negative ? "-" : ""}${digits}` };
}

/** Compare integer strings without converting identifiers to floating point. */
export function compareIntegerStrings(left, right) {
  const a = parseIntegerString(left);
  const b = parseIntegerString(right);
  if (!a || !b) return compareStrings(String(left ?? ""), String(right ?? ""));
  if (a.negative !== b.negative) return a.negative ? -1 : 1;

  const lengthOrder = a.digits.length - b.digits.length;
  const magnitudeOrder = lengthOrder || compareStrings(a.digits, b.digits);
  return a.negative ? -magnitudeOrder : magnitudeOrder;
}

/**
 * Bounded optimal-string-alignment Damerau-Levenshtein distance.
 * Returns maxDistance + 1 when the true distance is outside the bound.
 */
export function boundedDamerauLevenshtein(left, right, maxDistance) {
  const a = Array.from(String(left));
  const b = Array.from(String(right));
  const bound = Math.max(0, Math.floor(Number(maxDistance) || 0));
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  if (a.length === 0) return b.length <= bound ? b.length : bound + 1;
  if (b.length === 0) return a.length <= bound ? a.length : bound + 1;

  let previousPrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(bound + 1);
    current[0] = i;
    const start = Math.max(1, i - bound);
    const end = Math.min(b.length, i + bound);

    for (let j = start; j <= end; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );

      if (
        previousPrevious
        && i > 1
        && j > 1
        && a[i - 1] === b[j - 2]
        && a[i - 2] === b[j - 1]
      ) {
        current[j] = Math.min(current[j], previousPrevious[j - 2] + 1);
      }
    }

    previousPrevious = previous;
    previous = current;
  }

  return previous[b.length] <= bound ? previous[b.length] : bound + 1;
}

export class SearchService {
  constructor({ concepts, search } = {}) {
    if (!Array.isArray(concepts)) throw new TypeError("concepts must be an array");
    if (!Array.isArray(search?.documents)) {
      throw new TypeError("search.documents must be an array");
    }

    this.concepts = concepts;
    this.lookups = search.lookups ?? {};
    this.documents = [...search.documents]
      .map(normalizeDocument)
      .sort((a, b) => a.conceptOrdinal - b.conceptOrdinal);
    this.documentByOrdinal = new Map(
      this.documents.map((document) => [document.conceptOrdinal, document]),
    );

    this.idFallback = new Map();
    this.codeFallback = new Map();
    const nameEntries = [];
    const synonymEntries = [];

    for (const document of this.documents) {
      addPosting(this.idFallback, document.conceptId, document.conceptOrdinal);
      addPosting(this.codeFallback, document.normalizedCode, document.conceptOrdinal);
      nameEntries.push({
        ordinal: document.conceptOrdinal,
        value: document.normalizedName,
        tokens: document.nameTokens,
      });
      document.normalizedSynonyms.forEach((value, index) => {
        synonymEntries.push({
          ordinal: document.conceptOrdinal,
          value,
          tokens: document.synonymTokens[index] ?? tokenizeSearchText(value),
        });
      });
    }

    this.nameIndex = buildLexicalIndex(nameEntries);
    this.synonymIndex = buildLexicalIndex(synonymEntries);
  }

  search({ query = "", filters = {}, page = 1, pageSize = 25, sort = null } = {}) {
    const normalizedQuery = normalizeSearchText(query);
    const queryTokens = tokenizeSearchText(normalizedQuery);
    const activeFilters = normalizeFilters(filters);
    const scored = normalizedQuery
      ? this.#scoreQuery(normalizedQuery, queryTokens)
      : new Map(this.concepts.map((_, ordinal) => [ordinal, { score: 0, match: null }]));

    let results = [];
    for (const [ordinal, scoredMatch] of scored) {
      const concept = this.concepts[ordinal];
      if (!concept || !matchesFilters(concept, activeFilters)) continue;
      results.push({ concept, score: scoredMatch.score, match: scoredMatch.match, ordinal });
    }

    const defaultComparator = (left, right) => this.#compareDefault(left, right);
    const columnComparator = makeColumnComparator(sort, defaultComparator);
    results.sort(columnComparator ?? defaultComparator);

    const normalizedPageSize = normalizePositiveInteger(pageSize, 25, 500);
    const total = results.length;
    const totalPages = Math.ceil(total / normalizedPageSize);
    const requestedPage = normalizePositiveInteger(page, 1, Number.MAX_SAFE_INTEGER);
    const normalizedPage = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
    const start = (normalizedPage - 1) * normalizedPageSize;
    const items = results
      .slice(start, start + normalizedPageSize)
      .map(({ concept, score, match }) => ({ concept, score, match }));

    return {
      total,
      totalPages,
      page: normalizedPage,
      pageSize: normalizedPageSize,
      items,
    };
  }

  #scoreQuery(query, queryTokens) {
    const scored = new Map();
    const integerQuery = parseIntegerString(query);

    if (integerQuery) {
      for (const ordinal of this.#lookupOrdinals("conceptId", [query, integerQuery.canonical])) {
        consider(scored, ordinal, SCORE.exactConceptId, {
          type: "exact-concept-id",
          field: "conceptId",
          value: integerQuery.canonical,
        });
      }
    }

    for (const ordinal of this.#lookupOrdinals("conceptCode", [query], this.codeFallback)) {
      consider(scored, ordinal, SCORE.exactConceptCode, {
        type: "exact-concept-code",
        field: "conceptCode",
        value: query,
      });
    }

    for (const ordinal of this.#lookupOrdinals("conceptName", [query], this.nameIndex.exact)) {
      consider(scored, ordinal, SCORE.exactConceptName, {
        type: "exact-concept-name",
        field: "conceptName",
        value: query,
      });
    }

    for (const ordinal of this.#lookupOrdinals("synonym", [query], this.synonymIndex.exact)) {
      consider(scored, ordinal, SCORE.exactSynonym, {
        type: "exact-synonym",
        field: "conceptSynonymName",
        value: query,
      });
    }

    for (const entry of prefixEntries(this.nameIndex.entries, query)) {
      consider(scored, entry.ordinal, SCORE.conceptNamePrefix, {
        type: "concept-name-prefix",
        field: "conceptName",
        value: entry.value,
      });
    }
    for (const entry of prefixEntries(this.synonymIndex.entries, query)) {
      consider(scored, entry.ordinal, SCORE.synonymPrefix, {
        type: "synonym-prefix",
        field: "conceptSynonymName",
        value: entry.value,
      });
    }

    if (queryTokens.length > 0) {
      for (const entry of exactTokenEntries(this.nameIndex, queryTokens)) {
        consider(scored, entry.ordinal, SCORE.conceptNameToken, {
          type: "concept-name-token",
          field: "conceptName",
          value: entry.value,
        });
      }
      for (const entry of exactTokenEntries(this.synonymIndex, queryTokens)) {
        consider(scored, entry.ordinal, SCORE.synonymToken, {
          type: "synonym-token",
          field: "conceptSynonymName",
          value: entry.value,
        });
      }

      // A wholly numeric query is never sent through an approximate path.
      if (!integerQuery) {
        for (const entry of fuzzyTokenEntries(this.nameIndex, queryTokens)) {
          consider(scored, entry.ordinal, SCORE.fuzzyConceptName, {
            type: "fuzzy-concept-name",
            field: "conceptName",
            value: entry.value,
          });
        }
        for (const entry of fuzzyTokenEntries(this.synonymIndex, queryTokens)) {
          consider(scored, entry.ordinal, SCORE.fuzzySynonym, {
            type: "fuzzy-synonym",
            field: "conceptSynonymName",
            value: entry.value,
          });
        }
      }
    }

    return scored;
  }

  #lookupOrdinals(name, keys, fallback = this.idFallback) {
    const ordinals = new Set();
    const lookup = this.lookups[name];
    for (const key of new Set(keys)) {
      for (const ordinal of readLookupOrdinals(lookup, key)) ordinals.add(ordinal);
      for (const ordinal of readLookupOrdinals(fallback, key)) ordinals.add(ordinal);
    }
    return [...ordinals].sort((a, b) => a - b);
  }

  #compareDefault(left, right) {
    if (left.score !== right.score) return right.score - left.score;

    const leftInvalid = getField(left.concept, FILTER_FIELDS.invalidReason);
    const rightInvalid = getField(right.concept, FILTER_FIELDS.invalidReason);
    const leftValid = leftInvalid == null || leftInvalid === "";
    const rightValid = rightInvalid == null || rightInvalid === "";
    if (leftValid !== rightValid) return leftValid ? -1 : 1;

    const leftName = normalizeSearchText(getField(left.concept, SORT_FIELDS.conceptName));
    const rightName = normalizeSearchText(getField(right.concept, SORT_FIELDS.conceptName));
    const nameOrder = compareStrings(leftName, rightName);
    if (nameOrder) return nameOrder;

    const originalNameOrder = compareStrings(
      String(getField(left.concept, SORT_FIELDS.conceptName) ?? ""),
      String(getField(right.concept, SORT_FIELDS.conceptName) ?? ""),
    );
    if (originalNameOrder) return originalNameOrder;

    return compareIntegerStrings(
      getField(left.concept, SORT_FIELDS.conceptId),
      getField(right.concept, SORT_FIELDS.conceptId),
    );
  }
}

function normalizeDocument(document) {
  const normalizedSynonyms = Array.isArray(document.normalizedSynonyms)
    ? document.normalizedSynonyms.map(normalizeSearchText)
    : [];
  const synonymTokens = Array.isArray(document.synonymTokens)
    ? document.synonymTokens.map((tokens, index) => (
      Array.isArray(tokens)
        ? tokens.map(normalizeSearchText).filter(Boolean)
        : tokenizeSearchText(normalizedSynonyms[index])
    ))
    : normalizedSynonyms.map(tokenizeSearchText);

  return {
    conceptOrdinal: Number(document.conceptOrdinal),
    conceptId: String(document.conceptId),
    normalizedCode: normalizeSearchText(document.normalizedCode),
    normalizedName: normalizeSearchText(document.normalizedName),
    normalizedSynonyms,
    nameTokens: Array.isArray(document.nameTokens)
      ? document.nameTokens.map(normalizeSearchText).filter(Boolean)
      : tokenizeSearchText(document.normalizedName),
    synonymTokens,
  };
}

function buildLexicalIndex(entries) {
  const sorted = entries
    .filter((entry) => entry.value)
    .map((entry) => ({ ...entry, tokens: [...new Set(entry.tokens)].sort(compareStrings) }))
    .sort((a, b) => (
      compareStrings(a.value, b.value)
      || a.ordinal - b.ordinal
      || compareStringArrays(a.tokens, b.tokens)
    ));
  const exact = new Map();
  const tokenPostings = new Map();

  sorted.forEach((entry, entryIndex) => {
    entry.entryIndex = entryIndex;
    entry.tokenSet = new Set(entry.tokens);
    addPosting(exact, entry.value, entry.ordinal);
    for (const token of entry.tokens) addPosting(tokenPostings, token, entryIndex);
  });

  return {
    entries: sorted,
    exact,
    tokenPostings,
    terms: [...tokenPostings.keys()].sort(compareStrings),
    fuzzyTermCache: new Map(),
  };
}

function prefixEntries(entries, prefix) {
  if (!prefix) return [];
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].value < prefix) low = middle + 1;
    else high = middle;
  }

  const matches = [];
  for (let index = low; index < entries.length; index += 1) {
    if (!entries[index].value.startsWith(prefix)) break;
    matches.push(entries[index]);
  }
  return matches;
}

function exactTokenEntries(index, queryTokens) {
  const postings = queryTokens.map((token) => index.tokenPostings.get(token) ?? []);
  if (postings.some((posting) => posting.length === 0)) return [];
  const smallest = postings.reduce((left, right) => (left.length <= right.length ? left : right));
  return smallest
    .map((entryIndex) => index.entries[entryIndex])
    .filter((entry) => queryTokens.every((token) => entry.tokenSet.has(token)));
}

function fuzzyTokenEntries(index, queryTokens) {
  const matchingTerms = queryTokens.map((token) => fuzzyTerms(index, token));
  if (matchingTerms.some((terms) => terms.size === 0)) return [];

  const candidatePostings = matchingTerms.map((terms) => {
    const entries = new Set();
    for (const term of terms) {
      for (const entryIndex of index.tokenPostings.get(term) ?? []) entries.add(entryIndex);
    }
    return entries;
  });
  const smallest = candidatePostings.reduce((left, right) => (
    left.size <= right.size ? left : right
  ));

  const matches = [];
  for (const entryIndex of smallest) {
    const entry = index.entries[entryIndex];
    let usedApproximation = false;
    let allMatched = true;
    for (let queryIndex = 0; queryIndex < queryTokens.length; queryIndex += 1) {
      const token = queryTokens[queryIndex];
      if (entry.tokenSet.has(token)) continue;
      const approximate = entry.tokens.some((entryToken) => matchingTerms[queryIndex].has(entryToken));
      if (!approximate) {
        allMatched = false;
        break;
      }
      usedApproximation = true;
    }
    if (allMatched && usedApproximation) matches.push(entry);
  }
  return matches;
}

function fuzzyTerms(index, queryToken) {
  if (index.fuzzyTermCache.has(queryToken)) return index.fuzzyTermCache.get(queryToken);
  const matches = new Set();
  const allowed = allowedFuzzyDistance(queryToken);

  for (const term of index.terms) {
    if (term === queryToken) {
      matches.add(term);
      continue;
    }
    if (allowed === 0) continue;
    const maxLength = Math.max(Array.from(queryToken).length, Array.from(term).length);
    if (Math.abs(Array.from(queryToken).length - Array.from(term).length) > allowed) continue;
    const distance = boundedDamerauLevenshtein(queryToken, term, allowed);
    if (distance <= allowed && distance / maxLength <= 0.25) matches.add(term);
  }

  index.fuzzyTermCache.set(queryToken, matches);
  return matches;
}

function allowedFuzzyDistance(token) {
  const length = Array.from(token).length;
  if (length < 4) return 0;
  if (length <= 5) return 1;
  if (length <= 10) return 2;
  return 3;
}

function normalizeFilters(filters) {
  const active = new Map();
  for (const key of Object.keys(FILTER_FIELDS)) {
    const value = filters?.[key];
    const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
    if (values.length > 0) active.set(key, new Set(values));
  }
  return active;
}

function matchesFilters(concept, filters) {
  for (const [key, allowed] of filters) {
    if (!allowed.has(getField(concept, FILTER_FIELDS[key]))) return false;
  }
  return true;
}

function makeColumnComparator(sort, defaultComparator) {
  if (sort == null) return null;
  let field;
  let direction;
  if (typeof sort === "string") {
    direction = sort.startsWith("-") ? "desc" : "asc";
    field = sort.replace(/^-/, "");
  } else {
    field = sort.field;
    direction = sort.direction ?? "asc";
  }
  if (field !== "score" && !SORT_FIELDS[field]) {
    throw new RangeError(`Unsupported sort field: ${field}`);
  }
  if (direction !== "asc" && direction !== "desc") {
    throw new RangeError(`Unsupported sort direction: ${direction}`);
  }
  const multiplier = direction === "desc" ? -1 : 1;

  return (left, right) => {
    const leftValue = field === "score" ? left.score : getField(left.concept, SORT_FIELDS[field]);
    const rightValue = field === "score" ? right.score : getField(right.concept, SORT_FIELDS[field]);
    const leftMissing = leftValue == null;
    const rightMissing = rightValue == null;
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;

    let order = 0;
    if (!leftMissing) {
      order = field === "conceptId"
        ? compareIntegerStrings(leftValue, rightValue)
        : field === "score"
          ? leftValue - rightValue
          : compareStrings(normalizeSearchText(leftValue), normalizeSearchText(rightValue));
    }
    return order ? order * multiplier : defaultComparator(left, right);
  };
}

function readLookupOrdinals(lookup, key) {
  if (lookup == null) return [];
  let value;
  if (lookup instanceof Map) value = lookup.get(key);
  else if (Array.isArray(lookup)) value = lookup.find((entry) => entry?.[0] === key)?.[1];
  else if (Object.prototype.hasOwnProperty.call(lookup, key)) value = lookup[key];
  if (value == null) return [];

  const values = Array.isArray(value) || value instanceof Set ? [...value] : [value];
  return values
    .map((candidate) => Number(candidate?.conceptOrdinal ?? candidate?.ordinal ?? candidate))
    .filter((ordinal) => Number.isSafeInteger(ordinal) && ordinal >= 0);
}

function consider(scored, ordinal, score, match) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return;
  const current = scored.get(ordinal);
  if (
    !current
    || score > current.score
    || (score === current.score && compareMatch(match, current.match) < 0)
  ) {
    scored.set(ordinal, { score, match });
  }
}

function compareMatch(left, right) {
  if (right == null) return -1;
  return compareStrings(
    `${left.type}\u0000${left.field}\u0000${left.value ?? ""}`,
    `${right.type}\u0000${right.field}\u0000${right.value ?? ""}`,
  );
}

function addPosting(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  const posting = map.get(key);
  if (!posting.includes(value)) posting.push(value);
}

function getField(object, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(object, alias)) return object[alias];
  }
  return undefined;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(maximum, Math.floor(number));
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareStringArrays(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const order = compareStrings(left[index], right[index]);
    if (order) return order;
  }
  return left.length - right.length;
}

export default SearchService;
