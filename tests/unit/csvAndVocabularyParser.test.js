import test from "node:test";
import assert from "node:assert/strict";

import { CsvParseError, parseCsv } from "../../browser/js/services/csv.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  REQUIRED_DATASET_KEYS,
  buildVocabularyArtifacts,
} from "../../browser/js/services/vocabularyParser.js";
import { VocabularyValidationError } from "../../browser/js/model/concept.js";

const CONCEPT_HEADER = [
  "concept_id",
  "concept_name",
  "domain_id",
  "vocabulary_id",
  "concept_class_id",
  "standard_concept",
  "concept_code",
  "valid_start_date",
  "valid_end_date",
  "invalid_reason",
].join(",");

const SYNONYM_HEADER = "concept_id,concept_synonym_name,language_concept_id";
const RELATIONSHIP_HEADER = [
  "concept_id_1",
  "concept_id_2",
  "relationship_id",
  "valid_start_date",
  "valid_end_date",
  "invalid_reason",
].join(",");

const BASE_CONCEPT_ROWS = [
  '100,"  Alpha, ""quoted"" concept  ",Observation,INTERNAL_VOC,Class A,,0007,2020-01-01,2099-12-31,',
  "200,Second concept,Measurement,OTHER_VOC,Class B,S,CODE-B,20200102,20991231,",
];

function source(path, text) {
  return { path, text: `${text.trimEnd()}\n` };
}

function makeSources(overrides = {}) {
  return {
    concept: source("TEST/Ontology/concept_delta.csv", [CONCEPT_HEADER, ...BASE_CONCEPT_ROWS].join("\n")),
    synonym: source(
      "TEST/Ontology/concept_synonym_delta.csv",
      [
        SYNONYM_HEADER,
        '100,"Alpha alias, primary",4180186',
        "200,Second alias,4180186",
        "999,External alias,4180186",
      ].join("\n"),
    ),
    relationship: source(
      "TEST/Ontology/concept_relationship_delta.csv",
      [
        RELATIONSHIP_HEADER,
        "100,200,Maps to,2020-01-01,2099-12-31,",
        "999,100,Mapped from,2020-01-01,2099-12-31,",
        "100,888,Maps to,2020-01-01,2099-12-31,",
        "777,888,Is a,2020-01-01,2099-12-31,",
      ].join("\n"),
    ),
    ...overrides,
  };
}

test("CSV parsing strips only the header BOM and preserves quoted source text and embedded newlines", () => {
  const csv = '\uFEFFid,label,notes\r\n1,"Alpha, ""quoted""","first line\r\nsecond line"\r\n';
  const original = csv.slice();
  const parsed = parseCsv(csv, { source: "quoted.csv" });

  assert.deepEqual(parsed.headers, ["id", "label", "notes"]);
  assert.deepEqual(parsed.rows, [
    {
      rowNumber: 2,
      values: {
        id: "1",
        label: 'Alpha, "quoted"',
        notes: "first line\r\nsecond line",
      },
    },
  ]);
  assert.equal(csv, original, "parsing must not mutate the source text");
});

test("CSV parsing rejects malformed quoting and inconsistent row widths with source context", () => {
  assert.throws(
    () => parseCsv('id,label\n1,"unterminated', { source: "bad.csv" }),
    (error) => error instanceof CsvParseError && /bad\.csv ends inside a quoted field/u.test(error.message),
  );
  assert.throws(
    () => parseCsv("id,label\n1,alpha,extra\n", { source: "wide.csv" }),
    /wide\.csv row 2 has 3 fields; expected 2/u,
  );
});

test("concept parsing preserves source display/code/date values and maps blank OMOP flags to null", () => {
  const built = buildVocabularyArtifacts({ packageId: "TEST", sources: makeSources() });
  const [first, second] = built.concepts.concepts;

  assert.equal(ARTIFACT_SCHEMA_VERSION, "2.0");
  assert.equal(first.conceptName, '  Alpha, "quoted" concept  ');
  assert.equal(first.conceptCode, "0007");
  assert.equal(first.standardConcept, null);
  assert.equal(first.invalidReason, null);
  assert.equal(first.source.file, "TEST/Ontology/concept_delta.csv");
  assert.equal(first.source.row, 2);
  assert.equal(second.validStartDate, "20200102");
  assert.equal(second.validEndDate, "20991231");
  assert.equal(second.standardConcept, "S");
});

test("concept validation enforces required schema, enums, dates, identifiers, and duplicate IDs", async (t) => {
  const cases = [
    {
      name: "missing required concept column",
      rows: [CONCEPT_HEADER.replace(",invalid_reason", ""), BASE_CONCEPT_ROWS[0].replace(/,$/u, "")],
      pattern: /missing required columns: invalid_reason/u,
    },
    {
      name: "invalid Standard Concept enum",
      rows: [CONCEPT_HEADER, BASE_CONCEPT_ROWS[0].replace(",,0007,", ",X,0007,")],
      pattern: /standard_concept must be blank or one of S, C/u,
    },
    {
      name: "invalid invalid_reason enum",
      rows: [CONCEPT_HEADER, `${BASE_CONCEPT_ROWS[0]}X`],
      pattern: /invalid_reason must be blank or one of D, U/u,
    },
    {
      name: "invalid calendar date",
      rows: [CONCEPT_HEADER, BASE_CONCEPT_ROWS[0].replace("2020-01-01", "2020-02-30")],
      pattern: /valid_start_date is not a calendar date/u,
    },
    {
      name: "non-integer concept ID",
      rows: [CONCEPT_HEADER, BASE_CONCEPT_ROWS[0].replace(/^100,/u, "100.5,")],
      pattern: /concept_id must be a positive integer/u,
    },
    {
      name: "duplicate concept ID",
      rows: [CONCEPT_HEADER, BASE_CONCEPT_ROWS[0], BASE_CONCEPT_ROWS[0]],
      pattern: /duplicate concept_id 100/u,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const sources = makeSources({
        concept: source("TEST/Ontology/concept_delta.csv", item.rows.join("\n")),
      });
      assert.throws(
        () => buildVocabularyArtifacts({ packageId: "TEST", sources }),
        (error) => error instanceof VocabularyValidationError && item.pattern.test(error.message),
      );
    });
  }
});

test("all three core datasets are jointly required and their schemas are independently validated", async (t) => {
  assert.deepEqual([...REQUIRED_DATASET_KEYS], ["concept", "synonym", "relationship"]);

  for (const key of REQUIRED_DATASET_KEYS) {
    await t.test(`missing ${key}`, () => {
      const sources = makeSources();
      delete sources[key];
      assert.throws(
        () => buildVocabularyArtifacts({ packageId: "TEST", sources }),
        new RegExp(`missing required ${key} data`, "u"),
      );
    });
  }

  const malformedSynonyms = makeSources({
    synonym: source(
      "TEST/Ontology/concept_synonym_delta.csv",
      "concept_id,concept_synonym_name\n100,Alias",
    ),
  });
  assert.throws(
    () => buildVocabularyArtifacts({ packageId: "TEST", sources: malformedSynonyms }),
    /missing required columns: language_concept_id/u,
  );

  const malformedRelationships = makeSources({
    relationship: source(
      "TEST/Ontology/concept_relationship_delta.csv",
      "concept_id_1,concept_id_2,relationship_id,valid_start_date,valid_end_date\n100,200,Maps to,2020-01-01,2099-12-31",
    ),
  });
  assert.throws(
    () => buildVocabularyArtifacts({ packageId: "TEST", sources: malformedRelationships }),
    /missing required columns: invalid_reason/u,
  );
});

test("synonyms associate only by concept_id while orphans are excluded and reported", () => {
  const built = buildVocabularyArtifacts({ packageId: "TEST", sources: makeSources() });

  assert.deepEqual(Object.keys(built.synonyms.byConceptId), ["100", "200"]);
  assert.equal(built.synonyms.byConceptId["100"][0].conceptSynonymName, "Alpha alias, primary");
  assert.equal(built.counts.sourceSynonyms, 3);
  assert.equal(built.counts.synonyms, 2);
  assert.equal(built.counts.orphanSynonyms, 1);
  assert.equal(Object.hasOwn(built.search.lookups.synonym, "external alias"), false);
  assert.match(built.warnings.join("\n"), /1 synonym row\(s\).*excluded from search/u);
});

test("relationships preserve source direction and retain unresolved endpoint IDs", () => {
  const built = buildVocabularyArtifacts({ packageId: "TEST", sources: makeSources() });
  const artifact = built.relationships;

  assert.deepEqual(
    artifact.rows.map(({ conceptId1, relationshipId, conceptId2 }) => [conceptId1, relationshipId, conceptId2]),
    [
      ["100", "Maps to", "200"],
      ["999", "Mapped from", "100"],
      ["100", "Maps to", "888"],
      ["777", "Is a", "888"],
    ],
  );
  assert.deepEqual(artifact.outgoing["100"], [0, 2]);
  assert.deepEqual(artifact.incoming["100"], [1]);
  assert.deepEqual(artifact.incoming["888"], [2, 3]);
  assert.equal(built.counts.relationshipsLocalBoth, 1);
  assert.equal(built.counts.relationshipsOneLocal, 2);
  assert.equal(built.counts.relationshipsExternal, 1);
});

test("malformed optional hierarchy disables only hierarchy and records a warning", () => {
  const sources = makeSources({
    ancestor: source(
      "TEST/Ontology/concept_ancestor_delta.csv",
      "ancestor_concept_id,descendant_concept_id,min_levels_of_separation\n100,200,1",
    ),
  });
  const built = buildVocabularyArtifacts({ packageId: "TEST", sources });

  assert.equal(built.hierarchy, null);
  assert.equal(built.counts.concepts, 2);
  assert.equal(built.counts.relationships, 4);
  assert.match(built.warnings.join("\n"), /Hierarchy disabled:.*max_levels_of_separation/u);
});
