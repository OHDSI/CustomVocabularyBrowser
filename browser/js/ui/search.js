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

  return {
    render(state) {
      if (document.activeElement !== input && input.value !== state.query) input.value = state.query;
      clearQuery.disabled = !state.query && !input.value;
      clearAll.disabled = Object.values(state.filters).every((values) => values.length === 0);
      input.disabled = !state.dataset;
    },
  };
}
