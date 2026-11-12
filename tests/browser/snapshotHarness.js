import { buildLocalPackageInWorker } from "../../browser/js/services/localPackageWorkerClient.js";
import { saveLocalSnapshot, readLocalSnapshot, forgetLocalSnapshot, readRememberPreference, enableRememberPreference } from "../../browser/js/services/localSnapshotService.js";
import { createLocalDirectorySource } from "../../browser/js/services/localDirectoryService.js";
import { VocabularyRepository } from "../../browser/js/services/dataService.js";
import { SearchService } from "../../browser/js/services/searchService.js";

const output = document.getElementById("output"), frame = document.getElementById("app");
const report = { startedAt: new Date().toISOString(), checks: [], timings: {}, userAgent: navigator.userAgent };
const log = (name) => { report.checks.push(name); output.textContent = report.checks.map(name => "PASS " + name).join("\n"); };
const assert = (value, name) => { if (!value) throw new Error(name); log(name); };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, message, timeout = 120000) {
  const until = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > until) throw new Error("Timed out: " + message); await delay(50); }
}
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))).map(n => n.toString(16).padStart(2, "0")).join("");
async function assertRejected(action, name) { let rejected = false; try { await action(); } catch { rejected = true; } assert(rejected, name); }
const localFile = (path, body, owner = window) => {
  const file = new owner.File([body], path.split("/").at(-1));
  Object.defineProperty(file, "webkitRelativePath", { value: path }); return file;
};
async function loadFrame(remembered = false, query = "") {
  await new Promise(resolve => { frame.onload = resolve; frame.src = "/browser/index.html?qa=" + Date.now() + (remembered || query ? "" : "&local-source=1") + query; });
  await waitFor(() => remembered ? frame.contentDocument.getElementById("local-operation-status")?.textContent.startsWith("Remembered copy from") : frame.contentDocument.getElementById("status-panel")?.dataset.phase === "awaiting-local", "app startup");
}
async function importIntoFrame(files) {
  const transfer = new frame.contentWindow.DataTransfer();
  files.forEach(file => transfer.items.add(file));
  const input = frame.contentDocument.getElementById("local-folder-input");
  input.files = transfer.files; input.dispatchEvent(new frame.contentWindow.Event("change"));
  await waitFor(() => frame.contentDocument.getElementById("cancel-local").hidden, "local import");
}
try {
  // This QA origin is separate from the user-facing localhost:4173 origin.
  await forgetLocalSnapshot();
  const fixture = await (await fetch("/qa/fixtures")).json();
  const files = fixture.map(({path,text}) => localFile(path,text));
  const local = await createLocalDirectorySource(files);
  const repository = new VocabularyRepository(local);
  const dataset = await repository.loadAllPackages();
  assert(dataset.concepts.length === 2, "native File streaming worker imports a synthetic package");
  const snapshot = { ...local, packages: repository.builtCache };
  await saveLocalSnapshot(snapshot);
  let restored = await readLocalSnapshot();
  assert(restored.manifest.__origin.packages.get("ALPHA").concepts.concepts.length === 2, "IndexedDB snapshot reopens all concepts");
  let release, acquired;
  const held = new Promise(resolve => acquired = resolve);
  const lock = navigator.locks.request("cvb-local-snapshots-v1:access", async () => { acquired(); await new Promise(resolve => release = resolve); });
  await held;
  const blockedAbort = new AbortController();
  const blockedRead = readLocalSnapshot({ signal: blockedAbort.signal }); blockedAbort.abort();
  try { await blockedRead; throw new Error("Blocked read resolved"); } catch (error) { assert(error.name === "AbortError", "reopen waiting on another tab lock cancels promptly"); }
  release(); await lock;
  const originalPut = IDBObjectStore.prototype.put;
  let injected = false;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === "parts" && !injected) { injected = true; throw new DOMException("Injected quota failure", "QuotaExceededError"); }
    return originalPut.apply(this, args);
  };
  try { await saveLocalSnapshot(snapshot); throw new Error("Quota injection missed"); }
  catch (error) { assert(error.name === "QuotaExceededError", "storage failure is reported"); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  restored = await readLocalSnapshot();
  assert(restored.savedAt, "storage failure retains previous complete snapshot");
  const oldSavedAt = restored.savedAt, commitAbort = new AbortController();
  IDBObjectStore.prototype.put = function (...args) {
    const request = originalPut.apply(this, args);
    if (this.name === "meta" && args[1] === "active") commitAbort.abort();
    return request;
  };
  try { await saveLocalSnapshot(snapshot, { signal: commitAbort.signal }); throw new Error("Commit abort missed"); }
  catch (error) { assert(error.name === "AbortError", "cancellation aborts active-pointer transaction"); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert((await readLocalSnapshot()).savedAt === oldSavedAt, "cancelled publication preserves previous saved generation");
  await Promise.all([readLocalSnapshot(), saveLocalSnapshot(snapshot)]);
  assert((await readLocalSnapshot()).manifest.vocabularies.length === 1, "shared readers and serialized writers return complete generations");

  await loadFrame();
  assert(frame.contentDocument.getElementById("status-panel").dataset.phase === "awaiting-local", "explicit local-source starts without bundled vocabulary data");
  await importIntoFrame(fixture.map(({path,text}) => localFile(path,text,frame.contentWindow)));
  assert(frame.contentDocument.getElementById("results-body").textContent.includes("Alpha"), "real UI imports and renders local concepts");
  let doc = frame.contentDocument;
  doc.getElementById("query-input").value = "CODE-B";
  doc.getElementById("query-input").dispatchEvent(new frame.contentWindow.Event("input")); await delay(350);
  assert(doc.getElementById("results-body").textContent.includes("Second concept"), "real UI preserves existing exact-code search");
  frame.contentWindow.confirm = () => false;
  doc.getElementById("remember-vocabulary").click();
  assert(!doc.getElementById("remember-vocabulary").checked && !(await readRememberPreference()).enabled, "declined opt-in writes no consent");
  frame.contentWindow.confirm = () => true;
  doc.getElementById("remember-vocabulary").click();
  await waitFor(() => doc.getElementById("cancel-local").hidden, "UI save");
  assert(doc.getElementById("local-operation-status").textContent.startsWith("Remembered "), "one checkbox remembers the loaded packages after consent");
  await importIntoFrame(fixture.map(({path,text},i) => localFile(path,i===0?"bad_header\nbad_value":text,frame.contentWindow)));
  assert(doc.getElementById("local-operation-status").textContent.includes("required"), "invalid replacement shows the concrete validation cause");
  assert(doc.getElementById("results-body").textContent.includes("Second concept"), "invalid replacement retains current dataset and query");
  doc.getElementById("default-source").click();
  assert(doc.getElementById("status-panel").dataset.phase === "awaiting-source", "Clear source returns to empty state");
  await loadFrame(true); doc = frame.contentDocument;
  assert(doc.getElementById("results-body").textContent.includes("Alpha"), "reload automatically restores local concepts without folder access");
  assert(!frame.contentWindow.location.href.includes("Alpha"), "local source URL contains no private query or folder name");
  assert(doc.getElementById("remember-vocabulary").checked, "remember checkbox reflects persisted consent");
  assert(!doc.querySelector("#save-local, #reopen-local, #forget-local"), "the three storage buttons are removed");
  frame.contentWindow.confirm = () => false;
  doc.getElementById("remember-vocabulary").click();
  assert(doc.getElementById("remember-vocabulary").checked, "cancelled removal keeps the remembered copy");
  frame.contentWindow.confirm = () => true;
  doc.getElementById("remember-vocabulary").click();
  await waitFor(() => doc.getElementById("cancel-local").hidden, "opt out");
  assert(!(await readRememberPreference()).enabled && !(await readLocalSnapshot()), "unchecking removes both consent and vocabulary data");
  assert(doc.getElementById("results-body").textContent.includes("Alpha"), "unchecking preserves the open dataset");
  await assertRejected(() => saveLocalSnapshot(snapshot, { requireRemembered: true }), "another tab cannot save after consent is removed");
  await loadFrame();
  assert(!frame.contentDocument.getElementById("results-body").textContent.includes("Alpha"), "explicit local-source after opt-out remains empty");

  // Exercise the real Load source UI with deterministic prebuilt GitHub replies.
  // No external network is used by this fixture.
  const publicSource = { provider: "github", owner: "example", repository: "vocabulary", ref: "main", canonical: "example/vocabulary@main" };
  doc = frame.contentDocument;
  frame.contentWindow.confirm = () => true;
  doc.getElementById("remember-vocabulary").click();
  await waitFor(() => doc.getElementById("cancel-local").hidden, "remember before source selection");
  const built = repository.builtCache.get("ALPHA");
  const artifactNames = ["concepts", "search", "synonyms", "relationships", "metadata"];
  const publicManifest = { ...local.manifest, source: {repository:"example/vocabulary",ref:"main"},
    vocabularies: local.manifest.vocabularies.map(entry => ({...entry, artifacts:Object.fromEntries(artifactNames.map(key => [key, `vocabularies/ALPHA/${key}.json`]))})) };
  const remoteRequests = [];
  frame.contentWindow.fetch = async url => {
    remoteRequests.push(String(url));
    const name = new URL(url).pathname.split("/").at(-1);
    const body = String(url).includes("/commits/") ? { sha: "b".repeat(40) }
      : name === "manifest.json" ? publicManifest : built[name.replace(".json", "")];
    if (body === undefined) throw new Error("Unexpected synthetic request " + url);
    return new frame.contentWindow.Response(JSON.stringify(body), {status:200,headers:{"Content-Type":"text/plain"}});
  };
  doc.getElementById("source-input").value = publicSource.canonical;
  doc.getElementById("source-form").dispatchEvent(new frame.contentWindow.Event("submit", {cancelable:true}));
  await waitFor(() => doc.getElementById("local-operation-status").textContent.startsWith("Remembered "), "linked source automatic save");
  assert(remoteRequests.filter(url => url.startsWith("https://api.github.com/")).length === 1, "prebuilt Load source uses one API request");
  assert(remoteRequests.filter(url => url.includes(".json")).every(url => url.startsWith("https://raw.githubusercontent.com/example/vocabulary/" + "b".repeat(40) + "/")), "prebuilt content is pinned to the verified commit");
  assert(remoteRequests.some(url => url.includes("synonyms.json")) && remoteRequests.some(url => url.includes("metadata.json")), "Load source remembers complete prebuilt details automatically");
  await loadFrame(true, "&repository=example/vocabulary&ref=main"); doc = frame.contentDocument;
  assert(doc.getElementById("source-input").value === publicSource.canonical, "remembered URL source retains its public identity");
  assert(doc.getElementById("results-body").textContent.includes("Alpha"), "URL source restores its full vocabulary offline");
  assert(!frame.contentWindow.performance.getEntriesByType("resource").some(entry => /api.github.com|raw.githubusercontent.com/.test(entry.name)), "restoring a remembered URL makes no GitHub network request");
  assert(doc.getElementById("local-operation-status").textContent.includes("Reload the source to get updates"), "restored copies clearly disclose freshness");

  // Simulate a browser quota failure during an automatic replacement.
  const oldPublicSavedAt = (await readLocalSnapshot()).savedAt;
  const originalFramePut = frame.contentWindow.IDBObjectStore.prototype.put;
  frame.contentWindow.IDBObjectStore.prototype.put = function (...args) {
    if (this.name === "parts") throw new frame.contentWindow.DOMException("Injected quota", "QuotaExceededError");
    return originalFramePut.apply(this, args);
  };
  await importIntoFrame(fixture.map(({path,text}) => localFile(path,text,frame.contentWindow)));
  assert(doc.getElementById("local-operation-status").textContent.includes("storage is full"), "automatic save quota failure is visible");
  assert((await readLocalSnapshot()).savedAt === oldPublicSavedAt, "failed automatic replacement preserves previous complete copy");
  frame.contentWindow.IDBObjectStore.prototype.put = originalFramePut;
  await importIntoFrame(fixture.map(({path,text}) => localFile(path,text.replaceAll("Second concept", "Replacement concept"),frame.contentWindow)));
  assert(doc.getElementById("local-operation-status").textContent.startsWith("Remembered "), "a later successful import replaces the remembered copy automatically");
  await loadFrame(true); doc = frame.contentDocument;
  assert(doc.getElementById("results-body").textContent.includes("Replacement concept"), "automatic replacement survives reload");
  assert(!frame.contentWindow.location.href.includes("vocabulary"), "switching remembered remote to local removes repository and private data from URL");


  const oracle = await (await fetch("/qa/oracle")).json();
  if (oracle) {
    const realFiles = [];
    for (let i=0; i<oracle.sourceDescriptors.length; i++) {
      const descriptor = oracle.sourceDescriptors[i];
      const blob = await (await fetch("/qa/csv/" + i)).blob();
      realFiles.push({ key:descriptor.key, path:descriptor.path, file:localFile("Source/"+descriptor.path,blob) });
    }
    let started = performance.now();
    const built = await buildLocalPackageInWorker("GIS", realFiles);
    report.timings.realImportMs = performance.now() - started;
    assert(built.metadata.tables.mappingMetadata.length === oracle.count, "12 real CSV files produce all 121253 mapping records");
    const rows = built.metadata.tables.mappingMetadata;
    for (let i=0; i<oracle.blockDigests.length; i++) {
      if (await hash(rows.slice(i*256,i*256+256)) !== oracle.blockDigests[i]) throw new Error("Mapping block mismatch: " + i);
    }
    log("all 474 mapping blocks match the independent SHA-256 oracle");
    for (const [key,expected] of Object.entries(oracle.components)) {
      let actual = built[key];
      if (key === "metadata") { const {mappingMetadata,...other}=actual.tables; actual={...actual,tables:other}; }
      assert(await hash(actual) === expected.SHA256, "real " + key + " matches the independent SHA-256 oracle");
    }
    const localReal = await createLocalDirectorySource(realFiles.map(item=>item.file));
    started=performance.now();
    await saveLocalSnapshot({...localReal,packages:new Map([["GIS",built]])});
    report.timings.realSaveMs=performance.now()-started;
    started=performance.now();
    const reopened=await readLocalSnapshot();
    report.timings.realReopenMs=performance.now()-started;
    const restoredBuilt=reopened.manifest.__origin.packages.get("GIS");
    assert(restoredBuilt.metadata.tables.mappingMetadata.length===oracle.count,"real snapshot reopens all mapping records");
    for(let i=0;i<oracle.blockDigests.length;i++)if(await hash(restoredBuilt.metadata.tables.mappingMetadata.slice(i*256,i*256+256))!==oracle.blockDigests[i])throw new Error("Reopened mapping mismatch: "+i);
    log("all reopened mapping blocks retain exact SHA-256 parity");
    const beforeSearch = new SearchService({concepts:built.concepts.concepts,search:built.search});
    const afterSearch = new SearchService({concepts:restoredBuilt.concepts.concepts,search:restoredBuilt.search});
    for(const query of ["fenca","0007","", "GIS"]){
      const params={query,filters:{},page:1,pageSize:25};
      if(JSON.stringify(beforeSearch.search(params))!==JSON.stringify(afterSearch.search(params)))throw new Error("Reopen search mismatch");
    }
    log("existing ranked search stays identical after real snapshot reopen");
    const abort = new AbortController(); let requested=false;
    try {
      await buildLocalPackageInWorker("GIS",realFiles,{signal:abort.signal,onProgress(){if(!requested){requested=true;abort.abort();}}});
      throw new Error("Worker did not cancel");
    } catch(error){assert(error.name==="AbortError","real streaming import cancels by terminating its worker");}
  }
  report.passed=true;
} catch(error) {
  report.passed=false; report.error={message:error.message,stack:error.stack};
  output.textContent += "\nFAIL " + error.message;
} finally {
  report.finishedAt=new Date().toISOString();
  await fetch("/qa/report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(report)});
  output.textContent += "\n"+(report.passed?"ALL PASSED":"FAILED")+"\n"+JSON.stringify(report.timings,null,2);
  document.title=report.passed?"PASS: CVB integration tests":"FAIL: CVB integration tests";
}
