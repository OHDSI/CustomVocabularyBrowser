import test from "node:test";
import assert from "node:assert/strict";
import { createReviewWorkspace } from "../../browser/js/ui/reviewWorkspace.js";

// Browser-like DOM for exercising the real review workspace without navigation.
class Node {
  constructor(tag, navigation) { this.tagName=tag; this.navigation=navigation; this.children=[]; this.listeners={}; this.attributes={}; this.dataset={}; this.value=""; this.hidden=false; this.disabled=false; this.open=false; this._text=""; }
  set textContent(value) { this._text=String(value); this.children=[]; }
  get textContent() { return this._text+this.children.map((child)=>child.textContent).join(""); }
  setAttribute(name,value) { this.attributes[name]=String(value); if (["id","name","value","type","href"].includes(name)) this[name]=String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name==="href") this.href=""; }
  append(...nodes) { for(const node of nodes) { node.parent=this; this.children.push(node); if(this.tagName==="select" && this.children.length===1) this.value=node.value; } }
  replaceChildren(...nodes) { this.children=[]; this.append(...nodes); }
  addEventListener(type,fn) { (this.listeners[type]??=[]).push(fn); }
  emit(type) { const e={type,target:this,preventDefault(){}}; for(const fn of this.listeners[type]??[]) fn(e); }
  click() { if(this.tagName==="a" && this.href) this.navigation.push(this.href); else this.emit("click"); }
  showModal() { this.open=true; }
  close() { this.open=false; this.emit("close"); }
  remove() { if(this.parent) this.parent.children=this.parent.children.filter((n)=>n!==this); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  querySelectorAll(selector) {
    const m=/^\[name="([^"]+)"\]$/.exec(selector);
    const matches=(n)=>m?n.name===m[1]:n.tagName===selector.toLowerCase();
    const result=[]; const visit=(n)=>{for(const c of n.children){if(matches(c))result.push(c);visit(c);}}; visit(this); return result;
  }
}
class FakeFormData {
  constructor(form) { this.entries=[]; for(const input of [...form.querySelectorAll("input"),...form.querySelectorAll("select"),...form.querySelectorAll("textarea")]) if(input.name && !input.disabled && input.type!=="file") this.entries.push([input.name,input.value]); }
  [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  get(name) { return this.entries.find(([key])=>key===name)?.[1]??null; }
}
function find(node, pred) { if(pred(node))return node; for(const child of node.children){const result=find(child,pred);if(result)return result;} return null; }

test("local UI previews exact GitHub disclosure, supports cancel and explicit one-time confirmation", () => {
  const original={document:globalThis.document,FormData:globalThis.FormData}; const navigation=[];
  const root=new Node("div",navigation), body=new Node("body",navigation); body.append(root);
  globalThis.document={body,getElementById:(id)=>id==="review-workspace"?root:null,createElement:(tag)=>new Node(tag,navigation)};
  globalThis.FormData=FakeFormData;
  try {
    const source={provider:"local-directory"},dataset={concepts:[]},state={source,dataset,selectedPackageId:"PRIVATE",manifest:{vocabularies:[]}};
    createReviewWorkspace({getState:()=>state});
    const button=(label)=>find(root,n=>n.tagName==="button"&&n.textContent===label);
    const named=(name)=>find(root,n=>n.name===name);
    button("Submit custom concept").click();
    for(const [name,value] of Object.entries({vocabulary_id:"TEST",source_code_set:"SRC",concept_name:"Example private value",concept_code:"TEST-1",domain_id:"Observation",concept_class_id:"Test",standard_concept:"S",author:"Author",author_affiliation:"Institution"})) named(name).value=value;
    const form=find(root,n=>n.tagName==="form"); form.emit("submit");
    const review=button("Review GitHub sharing"),confirm=button("Confirm and open GitHub"),cancel=button("Cancel sharing");
    assert.equal(review.hidden,false); assert.equal(navigation.length,0);
    review.click(); assert.equal(navigation.length,0);
    const section=find(root,n=>n.attributes["aria-label"]==="Confirm sharing with GitHub");
    assert.equal(section.hidden,false); assert.match(section.textContent,/github\.com\/OHDSI\/CustomVocabularyBrowser/); assert.match(section.textContent,/Example private value/);
    const shownTitle=find(section,n=>n.attributes["aria-label"]==="Title sent to GitHub").textContent;
    const shownBody=find(section,n=>n.attributes["aria-label"]==="Body sent to GitHub").textContent;
    cancel.click(); assert.equal(section.hidden,true); assert.equal(navigation.length,0);
    review.click(); confirm.click(); assert.equal(navigation.length,1); assert.equal(section.hidden,true);
    const url=new URL(navigation[0]); assert.equal(url.origin,"https://github.com"); assert.equal(url.searchParams.get("title"),shownTitle); assert.equal(url.searchParams.get("body"),shownBody);
    confirm.click(); assert.equal(navigation.length,1);
    review.click(); form.emit("input"); assert.equal(section.hidden,true); assert.equal(review.hidden,true); confirm.click(); assert.equal(navigation.length,1);
  } finally { globalThis.document=original.document; globalThis.FormData=original.FormData; }
});
