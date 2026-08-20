export function createStatusView() {
  const panel = document.getElementById("status-panel");
  const title = document.getElementById("status-title");
  const message = document.getElementById("status-message");

  return {
    render(state) {
      const status = state.status;
      const visible = status.phase !== "idle" && Boolean(status.message);
      panel.hidden = !visible;
      if (!visible) return;
      panel.dataset.phase = status.phase;
      title.textContent = statusTitle(status.phase);
      message.textContent = status.message;
    },
  };
}

function statusTitle(phase) {
  if (phase === "error") return "Unable to continue";
  if (phase === "unavailable") return "Package unavailable";
  if (phase === "awaiting-local") return "Choose local folder";
  if (phase.startsWith("loading")) return "Loading";
  return "Ready";
}
