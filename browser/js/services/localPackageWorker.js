import { buildVocabularyArtifacts } from "./vocabularyParser.js";
import { parseCsvStream } from "./csvStream.js";

// Runs only locally in the browser. No file data is sent to a remote service.
self.onmessage = async ({ data }) => {
  try {
    const { packageId, files } = data;
    const sources = {};
    let completedBytes = 0;
    const totalBytes = files.reduce((sum, { file }) => sum + (file.size || 0), 0);
    for (const { key, path, file } of files) {
      try {
        if (typeof file.stream === "function") {
          const source = sources[key] = { path, hasContent: file.size !== 0 };
          try {
            const result = await parseCsvStream(file.stream(), {
              source: path, stripTransportBOM: true,
              onProgress: ({ bytesRead }) => self.postMessage({ progress: {
                phase: "reading", packageId, path, bytesRead: completedBytes + bytesRead, totalBytes,
              } }),
            });
            source.parsed = result.table;
          } catch (error) {
            if (error.name !== "CsvParseError") throw error;
            source.parseError = error;
            if (error.message === `${path} is empty.`) source.hasContent = false;
          }
        } else sources[key] = { path, text: await file.text() };
        completedBytes += file.size || 0;
      }
      catch { throw Object.assign(new Error(`Unable to read local file: ${path}.`), { code: "LOCAL_FILE_UNREADABLE" }); }
    }
    self.postMessage({ progress: { phase: "building", packageId, bytesRead: totalBytes, totalBytes } });
    let built;
    try { built = buildVocabularyArtifacts({ packageId, sources }); }
    catch (error) { throw Object.assign(new Error(`Vocabulary validation failed: ${error.message}`), { code: "INVALID_REQUIRED_DATA" }); }
    self.postMessage({ ok: true, built });
  } catch (error) {
    self.postMessage({ ok: false, error: { message: error?.message || "Local vocabulary processing failed.", code: error?.code || "LOCAL_WORKER_FAILURE" } });
  }
};
