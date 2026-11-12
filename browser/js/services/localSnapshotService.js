import { resolveSource } from "./sourceResolver.js";

// Optional device-local cache. No network, repository files, credentials or raw
// source handles are stored. Original CSV files remain the source of truth.
const DATABASE = "cvb-local-snapshots-v1";
const LOCK = `${DATABASE}:access`;
const SCHEMA = 1;
const request = (value) => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});
const completed = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = () => reject(tx.error || new DOMException("Storage transaction aborted.", "AbortError"));
  tx.onerror = () => {};
});
export function supportsLocalSnapshots() {
  return Boolean(globalThis.indexedDB && globalThis.navigator?.locks);
}
function supported() {
  if (!supportsLocalSnapshots()) {
    throw new Error("Local saving needs IndexedDB and Web Locks. Use a current browser on localhost; importing still works without saving.");
  }
}
async function open() {
  const r = indexedDB.open(DATABASE, SCHEMA);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("parts");
    r.result.createObjectStore("meta");
  };
  // An old tab must not leave the UI waiting indefinitely during an upgrade.
  return new Promise((resolve, reject) => {
    let abandoned = false;
    r.onblocked = () => { abandoned = true; reject(new Error("Close other Browser tabs and try local storage again.")); };
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      if (abandoned) { r.result.close(); return; }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
async function withDatabase(mode, action, signal) {
  supported();
  return navigator.locks.request(LOCK, { mode, ...(signal ? { signal } : {}) }, async () => {
    const db = await open();
    try { return await action(db); } finally { db.close(); }
  });
}
const get = (db, store, key) => request(db.transaction(store).objectStore(store).get(key));
async function put(db, store, key, value, signal) {
  signal?.throwIfAborted();
  const tx = db.transaction(store, "readwrite"), done = completed(tx);
  const abort = () => { try { tx.abort(); } catch { /* Already committed. */ } };
  signal?.addEventListener("abort", abort, { once: true });
  try { tx.objectStore(store).put(value, key); }
  catch (error) { tx.abort(); await done.catch(() => {}); signal?.removeEventListener("abort", abort); throw error; }
  try { await done; } finally { signal?.removeEventListener("abort", abort); }
}
const check = (signal) => signal?.throwIfAborted();
async function prune(db, retained) {
  const tx = db.transaction("parts", "readwrite"), done = completed(tx);
  const cursor = tx.objectStore("parts").openKeyCursor();
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (!item) return;
    if (item.key[0] !== retained) tx.objectStore("parts").delete(item.primaryKey);
    item.continue();
  };
  await done;
}

export async function saveLocalSnapshot({ source, manifest, packages }, { signal, onProgress, requireRemembered = false } = {}) {
  if (!["local-directory", "github"].includes(source?.provider) || !(packages instanceof Map) || !packages.size) {
    throw new Error("Load vocabulary packages before remembering them.");
  }
  return withDatabase("exclusive", async (db) => {
    check(signal);
    if (requireRemembered && await get(db, "meta", "remember") !== true) throw new Error("Remembering was turned off in another tab. This vocabulary was not saved.");
    const previous = await get(db, "meta", "active");
    await prune(db, previous?.generation);
    const generation = crypto.randomUUID();
    const descriptors = [];
    let published = false;
    try {
      for (const [packageId, built] of packages) {
        const descriptor = { packageId, keys: [], mappingChunks: 0, mappingCount: 0 };
        for (const [key, value] of Object.entries(built)) {
          check(signal);
          let stored = value;
          if (key === "metadata" && Array.isArray(value?.tables?.mappingMetadata)) {
            const rows = value.tables.mappingMetadata;
            descriptor.mappingCount = rows.length;
            for (let start = 0; start < rows.length; start += 256) {
              check(signal);
              await put(db, "parts", [generation, packageId, "mapping", descriptor.mappingChunks++], rows.slice(start, start + 256));
              if (start % 8192 === 0) onProgress?.({ phase: "saving", packageId, rows: Math.min(start + 256, rows.length), total: rows.length });
            }
            stored = { ...value, tables: { ...value.tables, mappingMetadata: [] } };
          }
          if (stored !== undefined) {
            await put(db, "parts", [generation, packageId, key], stored);
            descriptor.keys.push(key);
          }
        }
        descriptors.push(descriptor);
      }
      check(signal);
      const snapshot = {
        schema: SCHEMA, generation, complete: true, savedAt: new Date().toISOString(),
        source: source.provider === "github" ? resolveSource(source.canonical)
          : { provider: "local-directory", folderName: source.folderName, canonical: source.canonical },
        manifest: { ...manifest, vocabularies: manifest.vocabularies.filter((entry) => packages.has(entry.packageId)) },
        packages: descriptors,
      };
      // Only this small atomic transaction changes the active copy. A failed,
      // cancelled or interrupted import never replaces the previous snapshot.
      await put(db, "meta", "active", snapshot, signal);
      published = true;
      // Exclusive Web Lock also protects other tabs' readers from pruning.
      await prune(db, generation).catch(() => {});
      return { savedAt: snapshot.savedAt, packageCount: descriptors.length };
    } catch (error) {
      if (!published) await prune(db, previous?.generation).catch(() => {});
      throw error;
    }
  }, signal);
}

export async function readLocalSnapshot({ signal, onlyRemembered = false } = {}) {
  return withDatabase("shared", async (db) => {
    if (onlyRemembered && await get(db, "meta", "remember") !== true) return null;
    const saved = await get(db, "meta", "active");
    if (!saved) return null;
    if (saved.schema !== SCHEMA || !saved.complete || !Array.isArray(saved.packages)) throw new Error("The saved local copy is incompatible. Import your original folder again.");
    const packages = new Map();
    for (const descriptor of saved.packages) {
      const built = {};
      for (const key of descriptor.keys) {
        check(signal);
        built[key] = await get(db, "parts", [saved.generation, descriptor.packageId, key]);
        if (built[key] === undefined) throw new Error("The saved local copy is incomplete. Import your original folder again.");
      }
      const rows = [];
      for (let index = 0; index < descriptor.mappingChunks; index++) {
        check(signal);
        const part = await get(db, "parts", [saved.generation, descriptor.packageId, "mapping", index]);
        if (!Array.isArray(part)) throw new Error("The saved local copy has a missing mapping block.");
        for (const row of part) rows.push(row);
      }
      if (rows.length !== descriptor.mappingCount) throw new Error("The saved local mapping count does not match.");
      if (built.metadata?.tables && (descriptor.mappingChunks || Object.hasOwn(built.metadata.tables, "mappingMetadata"))) built.metadata.tables.mappingMetadata = rows;
      if (!Array.isArray(built.concepts?.concepts) || !Array.isArray(built.search?.documents)) throw new Error("The saved local package cannot be browsed.");
      packages.set(descriptor.packageId, built);
    }
    check(signal);
    const manifest = saved.manifest;
    Object.defineProperty(manifest, "__origin", { value: { mode: "saved-local", packages } });
    const source = saved.source?.provider === "github" ? resolveSource(saved.source.canonical) : saved.source;
    return { source, manifest, savedAt: saved.savedAt };
  }, signal);
}

export async function forgetLocalSnapshot({ signal } = {}) {
  return withDatabase("exclusive", async (db) => {
    check(signal);
    const tx = db.transaction(["meta", "parts"], "readwrite"), done = completed(tx);
    const abort = () => { try { tx.abort(); } catch {} };
    signal?.addEventListener("abort", abort, { once: true });
    tx.objectStore("meta").clear(); tx.objectStore("parts").clear();
    try { await done; } finally { signal?.removeEventListener("abort", abort); }
  }, signal);
}

// Consent is separate from the snapshot so failed writes never masquerade as
// successful saves. The same lock prevents another tab from saving after opt-out.
export async function readRememberPreference({ signal } = {}) {
  return withDatabase("shared", async db => {
    const enabled = await get(db, "meta", "remember") === true;
    const saved = await get(db, "meta", "active");
    return { enabled, savedAt: saved?.savedAt, source: saved?.source };
  }, signal);
}
export async function enableRememberPreference({ signal } = {}) {
  return withDatabase("exclusive", db => put(db, "meta", "remember", true, signal), signal);
}
