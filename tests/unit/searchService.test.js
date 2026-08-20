import test from "node:test";
import assert from "node:assert/strict";

import SearchService, {
  boundedDamerauLevenshtein,
  compareIntegerStrings,
  normalizeSearchText,
  tokenizeSearchText,
} from "../../browser/js/services/searchService.js";

function concept(overrides) {
  return {
    conceptId: "1",
    conceptName: "Concept",
    domainId: "Observation",
    vocabularyId: "TEST",
    conceptClassId: "Test class",
    standardConcept: null,
    conceptCode: "CODE",
    validStartDate: "2020-01-01",
    validEndDate: "2099-12-31",
    invalidReason: null,
    ...overrides,
  };
}

function makeArtifacts(concepts, synonymsByOrdinal = new Map(), documentOrder = null) {
  const documents = concepts.map((item, conceptOrdinal) => {
    const synonyms = synonymsByOrdinal.get(conceptOrdinal) ?? [];
    return {
      conceptOrdinal,
      conceptId: String(item.conceptId),
      normalizedCode: normalizeSearchText(item.conceptCode),
      normalizedName: normalizeSearchText(item.conceptName),
      normalizedSynonyms: synonyms.map(normalizeSearchText),
      nameTokens: tokenizeSearchText(item.conceptName),
      synonymTokens: synonyms.map(tokenizeSearchText),
    };
  });

  const lookups = {
    conceptId: Object.create(null),
    conceptCode: Object.create(null),
    conceptName: Object.create(null),
    synonym: Object.create(null),
  };
  for (const document of documents) {
    addLookup(lookups.conceptId, document.conceptId, document.conceptOrdinal);
    addLookup(lookups.conceptCode, document.normalizedCode, document.conceptOrdinal);
    addLookup(lookups.conceptName, document.normalizedName, document.conceptOrdinal);
    for (const synonym of document.normalizedSynonyms) {
      addLookup(lookups.synonym, synonym, document.conceptOrdinal);
    }
  }

  return {
    documents: documentOrder ? documentOrder.map((ordinal) => documents[ordinal]) : documents,
    lookups,
  };
}

function addLookup(lookup, key, ordinal) {
  if (!Object.hasOwn(lookup, key)) lookup[key] = [];
  lookup[key].push(ordinal);
}

function ids(result) {
  return result.items.map((item) => String(item.concept.conceptId));
}

test("normalization is Unicode-safe and does not mutate source values", () => {
  const displayName = "  Ångström\t  Finding  ";
  assert.equal(normalizeSearchText(displayName), "ångström finding");
  assert.deepEqual(tokenizeSearchText("Type-2  diabetes"), ["type", "2", "diabetes"]);

  const concepts = [concept({ conceptName: displayName })];
  const service = new SearchService({ concepts, search: makeArtifacts(concepts) });
  const result = service.search({ query: "A\u030Angström finding" });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].concept.conceptName, displayName);
  assert.equal(result.items[0].score, 800);
});

test("integer comparison avoids floating point and handles signs and leading zeros", () => {
  assert.equal(compareIntegerStrings("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareIntegerStrings("0002", "10"), -1);
  assert.equal(compareIntegerStrings("-10", "-2"), -1);
  assert.equal(compareIntegerStrings("+0", "-0"), 0);
});

test("bounded Damerau-Levenshtein supports insertion and adjacent transposition", () => {
  assert.equal(boundedDamerauLevenshtein("alpha", "alhpa", 1), 1);
  assert.equal(boundedDamerauLevenshtein("diabetes", "diabetse", 2), 1);
  assert.equal(boundedDamerauLevenshtein("alpha", "omega", 1), 2);
});

test("fixed ranking tiers use the maximum match and deterministic precedence", () => {
  const concepts = [
    concept({ conceptId: "100", conceptName: "Alpha disease", conceptCode: "A-001" }),
    concept({ conceptId: "200", conceptName: "Unrelated", conceptCode: "OTHER" }),
    concept({ conceptId: "300", conceptName: "Alpha disease extra", conceptCode: "C300" }),
    concept({ conceptId: "400", conceptName: "Severe alpha disease", conceptCode: "C400" }),
    concept({ conceptId: "500", conceptName: "Beta finding", conceptCode: "C500" }),
    concept({ conceptId: "600", conceptName: "Gamma finding", conceptCode: "C600" }),
    concept({ conceptId: "700", conceptName: "Delta finding", conceptCode: "C700" }),
    concept({ conceptId: "800", conceptName: "Alhpa disease", conceptCode: "C800" }),
  ];
  const synonyms = new Map([
    [1, ["Alpha disease"]],
    [4, ["Alpha disease marker"]],
    [5, ["Marker alpha disease"]],
  ]);
  const service = new SearchService({ concepts, search: makeArtifacts(concepts, synonyms) });

  const result = service.search({ query: " alpha   disease ", pageSize: 20 });
  assert.deepEqual(ids(result), ["100", "200", "300", "500", "400", "600", "800"]);
  assert.deepEqual(result.items.map((item) => item.score), [800, 700, 600, 500, 300, 200, 100]);
  assert.deepEqual(result.items.map((item) => item.match.type), [
    "exact-concept-name",
    "exact-synonym",
    "concept-name-prefix",
    "synonym-prefix",
    "concept-name-token",
    "synonym-token",
    "fuzzy-concept-name",
  ]);
});

test("exact identifier, code, and name precedence remain distinct", () => {
  const concepts = [
    concept({ conceptId: "123", conceptName: "Identifier owner", conceptCode: "ID-OWNER" }),
    concept({ conceptId: "200", conceptName: "Code owner", conceptCode: "123" }),
    concept({ conceptId: "300", conceptName: "123", conceptCode: "NAME-OWNER" }),
  ];
  const service = new SearchService({ concepts, search: makeArtifacts(concepts) });
  const result = service.search({ query: "00123", pageSize: 10 });

  assert.deepEqual(ids(result), ["123"]);
  assert.equal(result.items[0].score, 1000);

  const canonical = service.search({ query: "123", pageSize: 10 });
  assert.deepEqual(ids(canonical), ["123", "200", "300"]);
  assert.deepEqual(canonical.items.map((item) => item.score), [1000, 900, 800]);
});

test("exact code preserves leading zeros and returns every duplicate owner", () => {
  const concepts = [
    concept({ conceptId: "10", conceptName: "Zulu", vocabularyId: "A", conceptCode: "0007" }),
    concept({ conceptId: "11", conceptName: "Alpha", vocabularyId: "B", conceptCode: "0007" }),
    concept({ conceptId: "12", conceptName: "Numeric seven", conceptCode: "7" }),
  ];
  const service = new SearchService({ concepts, search: makeArtifacts(concepts) });
  const result = service.search({ query: "0007", pageSize: 10 });

  assert.deepEqual(ids(result), ["11", "10"]);
  assert.ok(result.items.every((item) => item.score === 900));
});

test("fuzzy matching is limited to names and synonyms, with no fuzzy numeric or code path", () => {
  const concepts = [
    concept({ conceptId: "1000", conceptName: "Diabetes mellitus", conceptCode: "ALPHA-CODE" }),
    concept({ conceptId: "2000", conceptName: "Other", conceptCode: "OMEGA-CODE" }),
    concept({ conceptId: "3000", conceptName: "Numeric text 1001", conceptCode: "THIRD" }),
  ];
  const synonyms = new Map([[1, ["Diabetes condition"]]]);
  const service = new SearchService({ concepts, search: makeArtifacts(concepts, synonyms) });

  const nameFuzzy = service.search({ query: "diabetse mellitus" });
  assert.deepEqual(ids(nameFuzzy), ["1000"]);
  assert.equal(nameFuzzy.items[0].score, 100);

  const synonymFuzzy = service.search({ query: "diabetse condition" });
  assert.deepEqual(ids(synonymFuzzy), ["2000"]);
  assert.equal(synonymFuzzy.items[0].score, 50);

  assert.equal(service.search({ query: "1001" }).total, 1);
  assert.deepEqual(ids(service.search({ query: "1001" })), ["3000"]);
  assert.equal(service.search({ query: "ALHPA-CODE" }).total, 0);
});

test("filters use OR within a facet, AND across facets, and preserve actual null", () => {
  const concepts = [
    concept({ conceptId: "1", vocabularyId: "A", domainId: "Observation", standardConcept: null }),
    concept({ conceptId: "2", vocabularyId: "B", domainId: "Observation", standardConcept: "S" }),
    concept({ conceptId: "3", vocabularyId: "C", domainId: "Measurement", standardConcept: null }),
    concept({ conceptId: "4", vocabularyId: "A", domainId: "Observation", standardConcept: null, invalidReason: "D" }),
  ];
  const service = new SearchService({ concepts, search: makeArtifacts(concepts) });
  const result = service.search({
    filters: {
      vocabularyId: new Set(["A", "B"]),
      domainId: ["Observation"],
      standardConcept: [null],
      invalidReason: [null],
    },
    pageSize: 10,
  });

  assert.deepEqual(ids(result), ["1"]);
});

test("equal scores put valid concepts first, then name, then integer concept ID", () => {
  const concepts = [
    concept({ conceptId: "9007199254740993", conceptName: "Same", conceptCode: "DUP", invalidReason: null }),
    concept({ conceptId: "9007199254740992", conceptName: "Same", conceptCode: "DUP", invalidReason: null }),
    concept({ conceptId: "1", conceptName: "Aardvark", conceptCode: "DUP", invalidReason: "D" }),
  ];
  const service = new SearchService({ concepts, search: makeArtifacts(concepts) });
  assert.deepEqual(ids(service.search({ query: "dup", pageSize: 10 })), [
    "9007199254740992",
    "9007199254740993",
    "1",
  ]);
});

test("results remain deterministic when search documents and lookup postings are shuffled", () => {
  const concepts = [
    concept({ conceptId: "3", conceptName: "Charlie", conceptCode: "DUP" }),
    concept({ conceptId: "1", conceptName: "Alpha", conceptCode: "DUP" }),
    concept({ conceptId: "2", conceptName: "Bravo", conceptCode: "DUP" }),
  ];
  const normal = makeArtifacts(concepts);
  const shuffled = makeArtifacts(concepts, new Map(), [2, 0, 1]);
  for (const lookup of Object.values(shuffled.lookups)) {
    for (const value of Object.values(lookup)) value.reverse();
  }
  const first = new SearchService({ concepts, search: normal });
  const second = new SearchService({ concepts, search: shuffled });

  assert.deepEqual(ids(first.search({ query: "dup", pageSize: 10 })), ["1", "2", "3"]);
  assert.deepEqual(
    ids(first.search({ query: "dup", pageSize: 10 })),
    ids(second.search({ query: "dup", pageSize: 10 })),
  );
});

test("pagination is bounded and clamps invalid and oversized pages", () => {
  const concepts = Array.from({ length: 6 }, (_, index) => concept({
    conceptId: String(index + 1),
    conceptName: `Concept ${index + 1}`,
    conceptCode: `C${index + 1}`,
  }));
  const service = new SearchService({ concepts, search: makeArtifacts(concepts) });

  const last = service.search({ page: 99, pageSize: 2 });
  assert.deepEqual(
    { total: last.total, totalPages: last.totalPages, page: last.page, pageSize: last.pageSize },
    { total: 6, totalPages: 3, page: 3, pageSize: 2 },
  );
  assert.deepEqual(ids(last), ["5", "6"]);

  const invalid = service.search({ page: -1, pageSize: 0 });
  assert.equal(invalid.page, 1);
  assert.equal(invalid.pageSize, 25);

  const empty = service.search({ query: "does-not-exist", page: 20, pageSize: 2 });
  assert.deepEqual(empty, { total: 0, totalPages: 0, page: 1, pageSize: 2, items: [] });
});

test("optional deterministic column sort uses default tie-breaks", () => {
  const concepts = [
    concept({ conceptId: "10", conceptName: "Zulu", conceptCode: "B" }),
    concept({ conceptId: "2", conceptName: "Alpha", conceptCode: "A" }),
    concept({ conceptId: "1", conceptName: "Bravo", conceptCode: "A" }),
  ];
  const service = new SearchService({ concepts, search: makeArtifacts(concepts) });

  assert.deepEqual(ids(service.search({ sort: { field: "conceptId", direction: "desc" } })), ["10", "2", "1"]);
  assert.deepEqual(ids(service.search({ sort: "conceptCode" })), ["2", "1", "10"]);
  assert.throws(() => service.search({ sort: { field: "unknown" } }), /Unsupported sort field/u);
});
