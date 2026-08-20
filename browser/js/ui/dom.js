export function clearNode(node) {
  node.replaceChildren();
  return node;
}

export function makeElement(tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    if (value != null) node.setAttribute(name, String(value));
  }
  return node;
}

export function appendTextRow(container, term, value) {
  const wrapper = makeElement("div", { className: "detail-field" });
  wrapper.append(
    makeElement("dt", { text: term }),
    makeElement("dd", { text: displayValue(value) }),
  );
  container.append(wrapper);
  return wrapper;
}

export function displayValue(value, blankLabel = "Blank") {
  return value == null || value === "" ? blankLabel : String(value);
}

export function showModal(dialog) {
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}
