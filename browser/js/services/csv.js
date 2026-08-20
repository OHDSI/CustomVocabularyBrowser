export class CsvParseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CsvParseError";
    this.details = details;
  }
}

/**
 * Parse RFC 4180-style CSV without mutating field values.
 *
 * The parser supports quoted commas, escaped quotes, embedded newlines, CRLF,
 * Unicode, and a UTF-8 BOM on the first header. It deliberately does not trim
 * source values because OMOP display fields remain authoritative.
 */
export function parseCsv(text, { source = "CSV input" } = {}) {
  if (typeof text !== "string") {
    throw new CsvParseError(`${source} must be text.`);
  }

  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let rowNumber = 1;
  let fieldStarted = false;

  const pushField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };

  const pushRow = () => {
    pushField();
    matrix.push({ values: row, rowNumber });
    row = [];
    rowNumber += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new CsvParseError(
        `${source} has an unexpected character after a closing quote on row ${rowNumber}.`,
        { rowNumber, index },
      );
    }

    if (character === '"') {
      if (fieldStarted || field.length > 0) {
        throw new CsvParseError(`${source} has an unexpected quote on row ${rowNumber}.`, {
          rowNumber,
          index,
        });
      }
      quoted = true;
      fieldStarted = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      pushRow();
    } else {
      field += character;
      fieldStarted = true;
    }
  }

  if (quoted) {
    throw new CsvParseError(`${source} ends inside a quoted field.`, { rowNumber });
  }

  if (field.length > 0 || fieldStarted || row.length > 0) {
    pushRow();
  }

  if (matrix.length === 0) {
    throw new CsvParseError(`${source} is empty.`);
  }

  const headers = [...matrix[0].values];
  headers[0] = headers[0]?.replace(/^\uFEFF/u, "");

  if (headers.some((header) => header === "")) {
    throw new CsvParseError(`${source} contains a blank header.`);
  }
  if (new Set(headers).size !== headers.length) {
    throw new CsvParseError(`${source} contains duplicate headers.`);
  }

  const rows = matrix.slice(1).map(({ values, rowNumber: sourceRow }) => {
    if (values.length !== headers.length) {
      throw new CsvParseError(
        `${source} row ${sourceRow} has ${values.length} fields; expected ${headers.length}.`,
        { rowNumber: sourceRow, actual: values.length, expected: headers.length },
      );
    }
    return {
      rowNumber: sourceRow,
      values: Object.fromEntries(headers.map((header, index) => [header, values[index]])),
    };
  });

  return { headers, rows };
}

