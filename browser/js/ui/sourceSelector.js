import { clearNode, makeElement } from "./dom.js";

export function createSourceSelector({ onSubmit, onDefault, onLocalFiles, onPackageChange }) {
  const form = document.getElementById("source-form");
  const input = document.getElementById("source-input");
  const defaultButton = document.getElementById("default-source");
  const localButton = document.getElementById("local-source");
  const localInput = document.getElementById("local-folder-input");
  const packageSelect = document.getElementById("package-select");
  const activeSource = document.getElementById("active-source");
  let renderedManifest = null;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit(input.value, input);
  });
  defaultButton.addEventListener("click", onDefault);
  localButton.addEventListener("click", () => localInput.click());
  localInput.addEventListener("change", () => {
    const files = Array.from(localInput.files ?? []);
    localInput.value = "";
    if (files.length > 0) void onLocalFiles(files);
  });
  packageSelect.addEventListener("change", () => {
    if (packageSelect.value) onPackageChange(packageSelect.value);
  });

  function render(state) {
    if (document.activeElement !== input) {
      input.value = state.source?.provider === "github" ? state.source.canonical : "";
    }
    activeSource.textContent = state.source?.canonical ?? "No source selected";

    if (renderedManifest !== state.manifest) {
      renderedManifest = state.manifest;
      clearNode(packageSelect);
      if (!state.manifest?.vocabularies?.length) {
        packageSelect.append(makeElement("option", { text: "No packages available", attributes: { value: "" } }));
      } else {
        for (const entry of state.manifest.vocabularies) {
          const readiness = entry.browseable ? "Ready" : "Unavailable";
          const count = Number.isFinite(entry.counts?.concepts)
            ? ` - ${entry.counts.concepts.toLocaleString()} concepts`
            : "";
          packageSelect.append(makeElement("option", {
            text: `${entry.displayName || entry.packageId} - ${readiness}${count}`,
            attributes: { value: entry.packageId },
          }));
        }
      }
    }

    packageSelect.disabled = !state.manifest?.vocabularies?.length || state.status.phase === "loading-source";
    localButton.disabled = state.status.phase === "loading-source";
    if (state.selectedPackageId) packageSelect.value = state.selectedPackageId;
  }

  return { render, focusInput: () => input.focus() };
}
