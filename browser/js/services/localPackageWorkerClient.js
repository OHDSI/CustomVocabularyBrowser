let localBuildQueue = Promise.resolve();

// File contents stay on this device. Limit local builds to one worker at a time
// to avoid multiplying peak memory when multiple packages are selected.
export function buildLocalPackageInWorker(packageId, files, options = {}) {
  const abortError = () => options.signal?.reason ?? new DOMException("Local import cancelled.", "AbortError");
  if (options.signal?.aborted) return Promise.reject(abortError());
  const WorkerClass = options.WorkerClass ?? globalThis.Worker;
  const FileClass = options.FileClass ?? globalThis.File;
  if (typeof WorkerClass !== "function" || typeof FileClass !== "function"
    || !files.every(({ file }) => file instanceof FileClass)) return Promise.resolve(null);

  const build = () => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    let worker;
    try {
      worker = new WorkerClass(new URL("./localPackageWorker.js", import.meta.url), { type: "module" });
    } catch (error) {
      reject(new Error(`Unable to start local processing worker: ${error.message}`));
      return;
    }
    let finished = false;
    const finish = (action, value) => {
      if (finished) return;
      finished = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      action(value);
    };
    const onAbort = () => finish(reject, abortError());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event) => {
      const message = event.data;
      if (message?.progress) { options.onProgress?.(message.progress); return; }
      if (message?.ok === true && message.built) finish(resolve, message.built);
      else {
        const error = new Error(message?.error?.message || "Local processing worker returned an invalid response.");
        if (message?.error?.code) error.code = message.error.code;
        finish(reject, error);
      }
    };
    worker.onerror = () => finish(reject, new Error("Local processing worker failed."));
    worker.onmessageerror = () => finish(reject, new Error("Local processing worker returned unreadable data."));
    try {
      worker.postMessage({ packageId, files });
    } catch (error) {
      finish(reject, new Error(`Unable to send files to local processing worker: ${error.message}`));
    }
  });
  const result = localBuildQueue.then(build);
  localBuildQueue = result.catch(() => {});
  return result;
}
