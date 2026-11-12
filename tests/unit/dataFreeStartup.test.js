import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Node } from "../helpers/syntheticDom.js";
import { CORE_FILE_NAMES, validSourceContent } from "../helpers/cvbFixtureRepository.js";
import { readUrlState, createShareableUrl } from "../../browser/js/urlState.js";
import { BrowserStore } from "../../browser/js/store.js";
import { forbiddenPackagePaths } from "../../scripts/check-no-package-data.mjs";
import { loadSourceManifest } from "../../browser/js/services/manifestService.js";
import { resolveSource } from "../../browser/js/services/sourceResolver.js";

test("a fresh browser chooses the runtime default and explicit null stays empty", () => {
  assert.equal(readUrlState("").source.canonical, "TuftsCTSI/CVB@main");
  assert.equal(readUrlState("").explicitSourceRequested, false);
  assert.equal(new BrowserStore().getState().source.canonical, "TuftsCTSI/CVB@main");
  assert.equal(new BrowserStore({ source: null }).getState().source, null);
  assert.equal(createShareableUrl({ source: null }, "https://example.test/cvb/?old=1#private"), "https://example.test/cvb/");
});

test("the default repository is fetched from GitHub at runtime, never bundled data", async () => {
  const requests=[];
  await assert.rejects(loadSourceManifest(resolveSource("TuftsCTSI/CVB@main"), {
    fetchImpl:async url=>{ requests.push(url); return {ok:false,status:403}; },
  }), {code:"GITHUB_RATE_LIMIT"});
  assert.equal(requests.length,1);
  assert.match(requests[0],/^https:\/\/api.github.com\/repos\/TuftsCTSI\/CVB\//);
});

test("repository guard rejects all package artifacts and raw tables, not test code", () => {
  assert.deepEqual(forbiddenPackagePaths(["browser/data/manifest.json", "browser/data/vocabularies/X/metadata.json", "dist/index.html", ".source/X/concept.csv", "private/CONCEPT.CSV", "local-data/x.json", "tests/helpers/cvbFixtureRepository.js", "browser/js/main.js"]), ["browser/data/manifest.json", "browser/data/vocabularies/X/metadata.json", "dist/index.html", ".source/X/concept.csv", "private/CONCEPT.CSV", "local-data/x.json"]);
});

test("real entrypoint requests default, allows local import after failure, and clears without another fetch", async () => {
  const saved=Object.fromEntries(["document","location","history","fetch"].map(key=>[key,globalThis[key]]));
  const html=await readFile(new URL("../../browser/index.html",import.meta.url),"utf8");
  const nodes=new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map(([,tag,id])=>[id,new Node(tag,[])]));
  const body=new Node("body",[]); body.append(...nodes.values());
  globalThis.document={body,activeElement:null,getElementById:id=>nodes.get(id),createElement:tag=>new Node(tag,[]),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){}};
  globalThis.location={href:"https://example.test/cvb/",search:""};
  globalThis.history={replaceState(_state,_title,url){globalThis.location.href=url;}};
  let requests=0; globalThis.fetch=async()=>{requests++;return {ok:false,status:403};};
  try {
    await import("../../browser/js/main.js");
    for(let i=0;i<100&&nodes.get("status-panel").dataset.phase!=="error";i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(nodes.get("status-panel").dataset.phase,"error");
    assert.equal(nodes.get("local-source").disabled,false);
    assert.equal(requests,1);
    const input=nodes.get("local-folder-input");
    input.files=CORE_FILE_NAMES.map(name=>({name,webkitRelativePath:`Synthetic/ALPHA/Ontology/${name}`,text:async()=>validSourceContent(`ALPHA/Ontology/${name}`)}));
    input.emit("change");
    for(let i=0;i<100&&nodes.get("status-panel").dataset.phase!=="error"&&!nodes.get("status-panel").hidden;i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(nodes.get("status-panel").hidden,true,nodes.get("status-message").textContent);
    assert.match(nodes.get("results-body").textContent,/Alpha/);
    assert.equal(requests,1);
    assert.equal(globalThis.location.href,"https://example.test/cvb/?local-source=1");
    input.files=CORE_FILE_NAMES.map((name,index)=>({name,webkitRelativePath:`Broken/ALPHA/Ontology/${name}`,text:async()=>index===0?"bad_header\nbad_value":validSourceContent(`ALPHA/Ontology/${name}`)}));
    input.emit("change");
    for(let i=0;i<100&&nodes.get("local-operation-status").textContent==="Preparing local vocabulary...";i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.match(nodes.get("local-operation-status").textContent,/required|column|concept_id/i);
    assert.match(nodes.get("results-body").textContent,/Alpha/);
    nodes.get("default-source").click();
    assert.equal(nodes.get("status-panel").dataset.phase,"awaiting-source");
    assert.equal(globalThis.location.href,"https://example.test/cvb/");
    assert.equal(requests,1);
  } finally { for(const [key,value] of Object.entries(saved)) {if(value===undefined)delete globalThis[key];else globalThis[key]=value;} }
});
