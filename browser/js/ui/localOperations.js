export function createLocalOperations({ onCancel, onRemember }) {
  const cancel = document.getElementById("cancel-local");
  const remember = document.getElementById("remember-vocabulary");
  const message = document.getElementById("local-operation-status");
  let busy = false, checked = false, initializing = false, state;
  cancel.addEventListener("click", onCancel);
  remember.addEventListener("change", () => onRemember(remember.checked));
  const render = (next) => {
    state = next;
    const loading = busy || ["loading-source", "loading-package"].includes(state?.status?.phase);
    cancel.hidden = !busy;
    remember.checked = checked;
    remember.disabled = loading || initializing;
    document.getElementById("local-source").disabled = loading;
  };
  return {
    render,
    setRemember(value, pending = false) { checked = value; initializing = pending; render(state); },
    setBusy(value, text = "") { busy = value; message.textContent = text; render(state); },
    setMessage(text) { message.textContent = text; },
  };
}
