// Minimal DOM for deterministic startup/import tests, not visual browser QA.
export class Node {
  constructor(tag, navigation) { this.tagName=tag; this.navigation=navigation; this.children=[]; this.listeners={}; this.attributes={}; this.dataset={}; this.value=""; this.hidden=false; this.disabled=false; this.open=false; this._text=""; this.classList={add(){},remove(){},toggle(){}}; }
  set textContent(value) { this._text=String(value); this.children=[]; }
  get textContent() { return this._text+this.children.map((child)=>child.textContent).join(""); }
  setAttribute(name,value) { this.attributes[name]=String(value); if (["id","name","value","type","href"].includes(name)) this[name]=String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name==="href") this.href=""; }
  append(...nodes) { for(const node of nodes) { node.parent=this; this.children.push(node); if(this.tagName==="select" && this.children.length===1) this.value=node.value; } }
  replaceChildren(...nodes) { this.children=[]; this.append(...nodes); }
  addEventListener(type,fn) { (this.listeners[type]??=[]).push(fn); }
  emit(type) { const e={type,target:this,preventDefault(){}}; for(const fn of this.listeners[type]??[]) fn(e); }
  click() { if(this.tagName==="a" && this.href) this.navigation.push(this.href); else this.emit("click"); }
  focus() {}
  contains(target) { return this === target || this.children.some(child=>child.contains(target)); }
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
