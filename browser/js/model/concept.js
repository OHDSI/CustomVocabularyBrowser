const MAX_SAFE_ID = BigInt(Number.MAX_SAFE_INTEGER);

export const REQUIRED_CONCEPT_COLUMNS = Object.freeze([
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
]);

export const REQUIRED_SYNONYM_COLUMNS = Object.freeze([
  "concept_id",
  "concept_synonym_name",
  "language_concept_id",
]);

export const REQUIRED_RELATIONSHIP_COLUMNS = Object.freeze([
  "concept_id_1",
  "concept_id_2",
  "relationship_id",
  "valid_start_date",
  "valid_end_date",
  "invalid_reason",
]);

export const REQUIRED_ANCESTOR_COLUMNS = Object.freeze([
  "ancestor_concept_id",
  "descendant_concept_id",
  "min_levels_of_separation",
  "max_levels_of_separation",
]);

export class VocabularyValidationError extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = "VocabularyValidationError";
    this.findings = findings;
  }
}

export function assertRequiredColumns(headers, required, source) {
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length > 0) {
    throw new VocabularyValidationError(
      `${source} is missing required columns: ${missing.join(", ")}.`,
      missing.map((column) => ({ severity: "BLOCKER", source, column, code: "missing-column" })),
    );
  }
}

export function parseIdentifier(value, { source, rowNumber, field }) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw validationFailure(source, rowNumber, field, `must be a positive integer; received ${JSON.stringify(value)}`);
  }
  const numeric = BigInt(value);
  if (numeric > MAX_SAFE_ID) {
    throw validationFailure(
      source,
      rowNumber,
      field,
      `exceeds the supported integer-safe range (${Number.MAX_SAFE_INTEGER})`,
    );
  }
  return value;
}

export function parseNullableFlag(value, allowed, context) {
  if (value === "") return null;
  if (!allowed.includes(value)) {
    throw validationFailure(
      context.source,
      context.rowNumber,
      context.field,
      `must be blank or one of ${allowed.join(", ")}; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function validateDate(value, context) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/u.exec(value);
  if (!match) {
    throw validationFailure(context.source, context.rowNumber, context.field, `is not YYYY-MM-DD or YYYYMMDD`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw validationFailure(context.source, context.rowNumber, context.field, `is not a calendar date`);
  }
  return value;
}

export function parseConceptRows(parsed, { source, packageId }) {
  assertRequiredColumns(parsed.headers, REQUIRED_CONCEPT_COLUMNS, source);
  const concepts = [];
  const byId = new Map();

  for (const row of parsed.rows) {
    const values = row.values;
    const requiredText = [
      "concept_name",
      "domain_id",
      "vocabulary_id",
      "concept_class_id",
      "concept_code",
    ];
    for (const field of requiredText) {
      if (values[field].trim() === "") {
        throw validationFailure(source, row.rowNumber, field, "must not be blank");
      }
    }

    const concept = {
      conceptId: parseIdentifier(values.concept_id, {
        source,
        rowNumber: row.rowNumber,
        field: "concept_id",
      }),
      conceptName: values.concept_name,
      domainId: values.domain_id,
      vocabularyId: values.vocabulary_id,
      conceptClassId: values.concept_class_id,
      standardConcept: parseNullableFlag(values.standard_concept, ["S", "C"], {
        source,
        rowNumber: row.rowNumber,
        field: "standard_concept",
      }),
      conceptCode: values.concept_code,
      validStartDate: validateDate(values.valid_start_date, {
        source,
        rowNumber: row.rowNumber,
        field: "valid_start_date",
      }),
      validEndDate: validateDate(values.valid_end_date, {
        source,
        rowNumber: row.rowNumber,
        field: "valid_end_date",
      }),
      invalidReason: parseNullableFlag(values.invalid_reason, ["D", "U"], {
        source,
        rowNumber: row.rowNumber,
        field: "invalid_reason",
      }),
      source: { packageId, file: source, row: row.rowNumber },
    };

    if (byId.has(concept.conceptId)) {
      const previous = byId.get(concept.conceptId);
      throw new VocabularyValidationError(
        `${source} has duplicate concept_id ${concept.conceptId} on rows ${previous.source.row} and ${row.rowNumber}.`,
        [{ severity: "BLOCKER", source, rowNumber: row.rowNumber, code: "duplicate-concept-id" }],
      );
    }
    byId.set(concept.conceptId, concept);
    concepts.push(concept);
  }

  if (concepts.length === 0) {
    throw new VocabularyValidationError(`${source} contains no concepts.`, [
      { severity: "BLOCKER", source, code: "empty-concept-data" },
    ]);
  }

  return { concepts, byId };
}

export function parseSynonymRows(parsed, { source, conceptById }) {
  assertRequiredColumns(parsed.headers, REQUIRED_SYNONYM_COLUMNS, source);
  const synonyms = [];
  const orphans = [];
  const seen = new Set();

  for (const row of parsed.rows) {
    const conceptId = parseIdentifier(row.values.concept_id, {
      source,
      rowNumber: row.rowNumber,
      field: "concept_id",
    });
    if (row.values.concept_synonym_name.trim() === "") {
      throw validationFailure(source, row.rowNumber, "concept_synonym_name", "must not be blank");
    }
    const languageConceptId = parseIdentifier(row.values.language_concept_id, {
      source,
      rowNumber: row.rowNumber,
      field: "language_concept_id",
    });
    if (!conceptById.has(conceptId)) {
      orphans.push({ conceptId, sourceRow: row.rowNumber });
      continue;
    }
    const key = JSON.stringify([conceptId, row.values.concept_synonym_name, languageConceptId]);
    if (seen.has(key)) continue;
    seen.add(key);
    synonyms.push({
      conceptId,
      conceptSynonymName: row.values.concept_synonym_name,
      languageConceptId,
      sourceRow: row.rowNumber,
    });
  }
  return { synonyms, orphans, sourceRowCount: parsed.rows.length };
}

export function parseRelationshipRows(parsed, { source }) {
  assertRequiredColumns(parsed.headers, REQUIRED_RELATIONSHIP_COLUMNS, source);
  const relationships = [];
  for (const row of parsed.rows) {
    if (row.values.relationship_id.trim() === "") {
      throw validationFailure(source, row.rowNumber, "relationship_id", "must not be blank");
    }
    relationships.push({
      conceptId1: parseIdentifier(row.values.concept_id_1, {
        source,
        rowNumber: row.rowNumber,
        field: "concept_id_1",
      }),
      conceptId2: parseIdentifier(row.values.concept_id_2, {
        source,
        rowNumber: row.rowNumber,
        field: "concept_id_2",
      }),
      relationshipId: row.values.relationship_id,
      validStartDate: validateDate(row.values.valid_start_date, {
        source,
        rowNumber: row.rowNumber,
        field: "valid_start_date",
      }),
      validEndDate: validateDate(row.values.valid_end_date, {
        source,
        rowNumber: row.rowNumber,
        field: "valid_end_date",
      }),
      invalidReason: parseNullableFlag(row.values.invalid_reason, ["D", "U"], {
        source,
        rowNumber: row.rowNumber,
        field: "invalid_reason",
      }),
      sourceRow: row.rowNumber,
    });
  }
  return relationships;
}

export function parseAncestorRows(parsed, { source }) {
  assertRequiredColumns(parsed.headers, REQUIRED_ANCESTOR_COLUMNS, source);
  return parsed.rows.map((row) => {
    const min = parseSeparation(row.values.min_levels_of_separation, source, row.rowNumber, "min_levels_of_separation");
    const max = parseSeparation(row.values.max_levels_of_separation, source, row.rowNumber, "max_levels_of_separation");
    if (max < min) {
      throw validationFailure(source, row.rowNumber, "max_levels_of_separation", "must be greater than or equal to min_levels_of_separation");
    }
    return {
      ancestorConceptId: parseIdentifier(row.values.ancestor_concept_id, {
        source,
        rowNumber: row.rowNumber,
        field: "ancestor_concept_id",
      }),
      descendantConceptId: parseIdentifier(row.values.descendant_concept_id, {
        source,
        rowNumber: row.rowNumber,
        field: "descendant_concept_id",
      }),
      minLevelsOfSeparation: min,
      maxLevelsOfSeparation: max,
      sourceRow: row.rowNumber,
    };
  });
}

function parseSeparation(value, source, rowNumber, field) {
  if (!/^\d+$/u.test(value)) {
    throw validationFailure(source, rowNumber, field, "must be a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw validationFailure(source, rowNumber, field, "exceeds the supported integer-safe range");
  }
  return parsed;
}

function validationFailure(source, rowNumber, field, reason) {
  return new VocabularyValidationError(`${source} row ${rowNumber}: ${field} ${reason}.`, [
    { severity: "BLOCKER", source, rowNumber, field, code: "invalid-value", reason },
  ]);
}
