import { clearNode, makeElement } from "./dom.js";

export function createSourceSelector({ onSubmit, onDefault, onLocalFiles, onPackageChange }) {
  const form = document.getElementById("source-form");
  const input = document.getElementById("source-input");
  const defaultButton = document.getElementById("default-source");
  const localButton = document.getElementById("local-source");
  const localInput = document.getElementById("local-folder-input");
  const packageSelect = document.getElementById("package-select");
  const activeSource = document.getElementById("active-source");
  const packageMount = document.getElementById("package-picker");
  const packagePicker = createPackagePicker(onPackageChange);
  packageMount.append(packagePicker.root);
  packageSelect.hidden = true;
  let renderedManifest = null;
  form.addEventListener("submit", (event) => { event.preventDefault(); onSubmit(input.value, input); });
  defaultButton.addEventListener("click", onDefault);
  localButton.addEventListener("click", () => localInput.click());
  localInput.addEventListener("change", () => {
    const files = Array.from(localInput.files ?? []);
    localInput.value = "";
    if (files.length > 0) void onLocalFiles(files);
  });
  packageSelect.addEventListener("change", () => { if (packageSelect.value) onPackageChange(packageSelect.value); });

  function render(state) {
    if (document.activeElement !== input) input.value = state.source?.provider === "github" ? state.source.canonical : "";
    activeSource.textContent = state.source?.canonical ?? "No source selected";
    const entries = availablePackages(state.manifest);
    if (renderedManifest !== state.manifest) {
      renderedManifest = state.manifest;
      clearNode(packageSelect);
      if (!entries.length) packageSelect.append(makeElement("option", { text: "No packages available", attributes: { value: "" } }));
      else {
        packageSelect.append(makeElement("option", { text: "All available packages", attributes: { value: "__all__" } }));
        for (const entry of entries) packageSelect.append(makeElement("option", {
          text: entry.displayName || entry.packageId, attributes: { value: entry.packageId },
        }));
      }
    }
    const disabled = !entries.length || ["loading-source", "loading-package", "saving-local"].includes(state.status.phase);
    packageSelect.disabled = disabled;
    localButton.disabled = state.status.phase === "loading-source";
    if (state.selectedPackageId) packageSelect.value = state.selectedPackageId;
    packagePicker.render(entries, state.selectedPackageId, disabled, state.manifest);
  }
  return { render, focusInput: () => input.focus() };
}

function createPackagePicker(onApply) {
  const root = makeElement("details", { className: "package-picker" });
  const summary = makeElement("summary", { attributes: { "aria-label": "Choose vocabulary packages" } });
  const panel = makeElement("div", { className: "package-popup" });
  const allLabel = makeElement("label", { className: "package-choice" });
  const allCheckbox = makeElement("input", { attributes: { type: "checkbox" } });
  allLabel.append(allCheckbox, makeElement("span", { text: "All available packages" }));
  const choices = makeElement("div", { className: "package-checkboxes", attributes: { role: "group", "aria-label": "Available packages" } });
  const apply = makeElement("button", { className: "button button-primary", text: "Apply selected packages", attributes: { type: "button" } });
  const hint = makeElement("p", { className: "package-hint", attributes: { "aria-live": "polite" } });
  panel.append(allLabel, choices, apply, hint);
  root.append(summary, panel);
  let entries = [];
  let draft = [];
  let currentSelection = null;
  let currentManifest = null;
  let disabled = true;
  function drawChoices() {
    clearNode(choices);
    for (const entry of entries) {
      const label = makeElement("label", { className: "package-choice" });
      const checkbox = makeElement("input", { attributes: { type: "checkbox", value: entry.packageId } });
      checkbox.checked = draft.includes(entry.packageId);
      checkbox.disabled = disabled;
      const count = Number.isFinite(entry.counts?.concepts) ? ` (${entry.counts.concepts.toLocaleString()})` : "";
      label.append(checkbox, makeElement("span", { text: `${entry.displayName || entry.packageId}${count}` }));
      checkbox.addEventListener("change", () => {
        draft = checkbox.checked ? [...new Set([...draft, entry.packageId])] : draft.filter((id) => id !== entry.packageId);
        updateControls();
      });
      choices.append(label);
    }
    updateControls();
  }
  function updateControls() {
    allCheckbox.checked = entries.length > 0 && draft.length === entries.length;
    allCheckbox.indeterminate = draft.length > 0 && draft.length < entries.length;
    allCheckbox.disabled = disabled;
    apply.disabled = disabled || draft.length === 0;
    hint.textContent = entries.length ? draft.length ? `${draft.length} of ${entries.length} packages selected. Apply to update results.` : "Select at least one package." : "No searchable packages. Check Vocabulary quality control for source problems.";
  }
  allCheckbox.addEventListener("change", () => {
    draft = allCheckbox.checked ? entries.map((entry) => entry.packageId) : [];
    drawChoices();
  });
  apply.addEventListener("click", () => {
    if (disabled || !draft.length) return;
    const encoded = encodePackageSelection(draft, entries);
    root.open = false;
    onApply(encoded);
    summary.focus();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { root.open = false; summary.focus(); event.preventDefault(); }
  });
  summary.addEventListener("click", (event) => { if (disabled) event.preventDefault(); });
  document.addEventListener("click", (event) => { if (!root.contains(event.target)) root.open = false; });
  return {
    root,
    render(nextEntries, selected, isDisabled, manifest) {
      disabled = isDisabled;
      entries = nextEntries;
      if (manifest !== currentManifest || selected !== currentSelection) {
        currentManifest = manifest;
        currentSelection = selected;
        draft = decodePackageSelection(selected, entries);
        drawChoices();
      }
      const selectedIds = decodePackageSelection(selected, entries);
      summary.textContent = selectedIds.length === entries.length && entries.length ? `All available packages (${entries.length})`
        : selectedIds.length ? selectedIds.map((id) => entries.find((entry) => entry.packageId === id)?.displayName || id).join(", ") : "Choose packages";
      summary.setAttribute("aria-disabled", String(disabled));
      summary.tabIndex = disabled ? -1 : 0;
      if (disabled) root.open = false;
      for (const checkbox of choices.querySelectorAll("input")) checkbox.disabled = disabled;
      updateControls();
    },
  };
}

export function availablePackages(manifest) { return (manifest?.vocabularies ?? []).filter((entry) => entry.browseable); }
export function decodePackageSelection(selection, entries) {
  const available = entries.map((entry) => entry.packageId);
  if (!selection || selection === "__all__") return available;
  let selected = [selection];
  if (String(selection).startsWith("[")) {
    try { selected = JSON.parse(selection); } catch { return []; }
  }
  if (!Array.isArray(selected)) return [];
  return available.filter((id) => selected.includes(id));
}
export function encodePackageSelection(selected, entries) {
  const available = entries.map((entry) => entry.packageId);
  const valid = [...new Set(selected)].filter((id) => available.includes(id)).sort();
  if (valid.length && valid.length === available.length) return "__all__";
  return valid.length === 1 ? valid[0] : JSON.stringify(valid);
}
