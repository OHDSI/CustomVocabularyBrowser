import { CsvParseError } from './csv.js';

/** Incremental syntax parser. Retains final rows, not a second field matrix.
 * Structural errors are deferred until EOF to preserve the oracle's precedence:
 * lexical errors, then header errors, then the first row-width error.
 */
export function createCsvParser({ source = 'CSV input' } = {}) {
  let headers, structuralError, row = [], segments = [], started = false;
  let mode = 'plain', skipLF = false, rowNumber = 1, offset = 0, finished = false;
  const rows = [];
  const error = (message, details = {}) => new CsvParseError(`${source} ${message}`, details);
  function pushField() {
    row.push(segments.length === 1 ? segments[0] : segments.join(''));
    segments = [];
    started = false;
    mode = 'plain';
  }
  function pushRow() {
    pushField();
    if (!headers) {
      headers = row;
      headers[0] = headers[0]?.replace(/^\uFEFF/u, '');
      if (headers.some(header => header === '')) structuralError = error('contains a blank header.');
      else if (new Set(headers).size !== headers.length) structuralError = error('contains duplicate headers.');
    } else if (!structuralError) {
      if (row.length !== headers.length) {
        structuralError = error(`row ${rowNumber} has ${row.length} fields; expected ${headers.length}.`,
          { rowNumber, actual: row.length, expected: headers.length });
      } else {
        // Object.fromEntries also handles __proto__ and numeric header keys exactly.
        rows.push({ rowNumber, values: Object.fromEntries(headers.map((header, i) => [header, row[i]])) });
      }
    }
    row = [];
    rowNumber++;
  }
  return {
    get rowCount() { return rows.length; },
    feed(text) {
      if (finished) throw new Error('CSV parser is already finished.');
      if (typeof text !== 'string') throw error('must be text.');
      let i = 0;
      while (i < text.length) {
        const c = text[i];
        if (skipLF) {
          skipLF = false;
          if (c === '\n') { i++; continue; }
        }
        if (mode === 'quoted') {
          const end = text.indexOf('"', i);
          if (end === -1) { segments.push(text.slice(i)); i = text.length; }
          else {
            if (end > i) segments.push(text.slice(i, end));
            mode = 'quote';
            i = end + 1;
          }
          continue;
        }
        if (mode === 'quote') {
          if (c === '"') { segments.push('"'); mode = 'quoted'; i++; continue; }
          if (c !== ',' && c !== '\r' && c !== '\n') {
            throw error(`has an unexpected character after a closing quote on row ${rowNumber}.`, { rowNumber, index: offset + i });
          }
        }
        if (c === '"') {
          if (started) throw error(`has an unexpected quote on row ${rowNumber}.`, { rowNumber, index: offset + i });
          mode = 'quoted'; started = true; i++;
        } else if (c === ',') {
          pushField(); i++;
        } else if (c === '\r' || c === '\n') {
          pushRow(); skipLF = c === '\r'; i++;
        } else {
          const start = i++;
          while (i < text.length && text[i] !== ',' && text[i] !== '"' && text[i] !== '\r' && text[i] !== '\n') i++;
          segments.push(text.slice(start, i)); started = true;
        }
      }
      offset += text.length;
    },
    finish() {
      if (finished) throw new Error('CSV parser is already finished.');
      finished = true;
      if (mode === 'quoted') throw error('ends inside a quoted field.', { rowNumber });
      if (started || segments.length || row.length) pushRow();
      if (!headers) throw error('is empty.');
      if (structuralError) throw structuralError;
      return { headers, rows };
    },
  };
}

/** Bounded decode pieces, not bounded whole-import memory: final rows, the
 * current field, upstream queued buffers and backing buffers remain retained.
 * Yields every 8 pieces/reads or 12 ms; this is cooperative, not a hard SLA.
 */
export async function parseCsvStream(readableStream, {
  source = 'CSV input', signal, onProgress, chunkBytes = 65536, stripTransportBOM = false,
} = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 65536) {
    throw new RangeError('chunkBytes must be an integer from 1 to 65536.');
  }
  const parser = createCsvParser({ source });
  // Preserve BOM in decoded text: only the first parsed header removes it.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: !stripTransportBOM });
  const reader = readableStream.getReader();
  const stats = { bytesRead: 0, decodedChunks: 0, inputChunks: 0, maxDecoderPieceBytes: 0,
    maxInputChunkBytes: 0, maxInputBackingBufferBytes: 0, maxDecodedChars: 0, yields: 0, rows: 0 };
  let operations = 0, lastYield = performance.now(), cancelPromise;
  const abortReason = () => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  const checkAbort = () => { if (signal?.aborted) throw abortReason(); };
  const cancel = reason => {
    // Do not await an uncooperative source's cancel promise. Calling cancel
    // closes the reader and settles pending reads; releaseLock runs in finally.
    if (!cancelPromise) cancelPromise = Promise.resolve(reader.cancel(reason)).catch(() => {});
  };
  const onAbort = () => cancel(abortReason());
  const progress = () => { stats.rows = parser.rowCount; onProgress?.({ ...stats }); };
  async function checkpoint() {
    operations++;
    if (operations >= 8 || performance.now() - lastYield >= 12) {
      progress();
      checkAbort();
      await new Promise(resolve => setTimeout(resolve, 0));
      stats.yields++;
      lastYield = performance.now(); operations = 0;
      checkAbort();
    }
  }
  function decode(piece) {
    const text = decoder.decode(piece, { stream: true });
    stats.decodedChunks++;
    stats.maxDecoderPieceBytes = Math.max(stats.maxDecoderPieceBytes, piece.byteLength);
    stats.maxDecodedChars = Math.max(stats.maxDecodedChars, text.length);
    parser.feed(text);
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    checkAbort();
    for (;;) {
      const { value, done } = await reader.read();
      checkAbort();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('CSV stream must yield Uint8Array chunks.');
      stats.inputChunks++;
      stats.maxInputChunkBytes = Math.max(stats.maxInputChunkBytes, value.byteLength);
      stats.maxInputBackingBufferBytes = Math.max(stats.maxInputBackingBufferBytes, value.buffer.byteLength);
      stats.bytesRead += value.byteLength;
      for (let i = 0; i < value.byteLength; i += chunkBytes) {
        checkAbort();
        decode(value.subarray(i, Math.min(i + chunkBytes, value.byteLength)));
        await checkpoint();
      }
      // Empty synchronously buffered chunks must not starve cancellation either.
      if (!value.byteLength) await checkpoint();
    }
    parser.feed(decoder.decode());
    const table = parser.finish();
    progress(); checkAbort();
    return { table, stats };
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
