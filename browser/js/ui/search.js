export function createSearchControls({ onQuery, onClearQuery, onClearAll }) {
  const input = document.getElementById("query-input");
  const clearQuery = document.getElementById("clear-query");
  const clearAll = document.getElementById("clear-all");

  input.addEventListener("input", () => onQuery(input.value));
  clearQuery.addEventListener("click", () => {
    input.value = "";
    onClearQuery();
    input.focus();
  });
  clearAll.addEventListener("click", onClearAll);
  initializeDailyWisdom();

  return {
    render(state) {
      if (document.activeElement !== input && input.value !== state.query) input.value = state.query;
      clearQuery.disabled = !state.query && !input.value;
      clearAll.disabled = Object.values(state.filters).every((values) => values.length === 0);
      input.disabled = !state.dataset;
    },
  };
}

export const DAILY_WISDOM = Object.freeze([
  "A good definition saves several meetings.",
  "Two concepts walk into a table. The relationship is complicated.",
  "Measure twice. Map once. Review anyway.",
  "Every blank field has a story. Some need a ticket.",
  "A synonym is a second chance to be found.",
  "Certainty is useful. Provenance is better.",
  "The shortest path to clarity sometimes has a parent concept.",
]);

export function wisdomForDate(date = new Date()) {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return DAILY_WISDOM[((day % DAILY_WISDOM.length) + DAILY_WISDOM.length) % DAILY_WISDOM.length];
}

function initializeDailyWisdom() {
  const banner = document.getElementById("daily-wisdom");
  const message = document.getElementById("wisdom-text");
  const dismiss = document.getElementById("dismiss-wisdom");
  if (!banner || !message || !dismiss) return;
  const today = new Date();
  const day = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
  message.textContent = wisdomForDate(today);
  try { banner.hidden = localStorage.getItem("cvb-wisdom-dismissed") === day; } catch { /* Storage may be disabled. */ }
  dismiss.addEventListener("click", () => {
    banner.hidden = true;
    try { localStorage.setItem("cvb-wisdom-dismissed", day); } catch { /* Dismissal still works for this visit. */ }
  });
}
