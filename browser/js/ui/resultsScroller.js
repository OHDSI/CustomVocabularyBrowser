/** Synchronize a sticky, accessible slider with the native table scrollport. */
export function createResultsScroller() {
  const frame = document.getElementById("results-frame");
  const table = document.getElementById("results-table");
  const controls = document.getElementById("results-scroll-controls");
  const position = document.getElementById("results-scroll-position");
  const left = document.getElementById("results-scroll-left");
  const right = document.getElementById("results-scroll-right");
  if (!frame || !controls || !position || !left || !right) return { render() {} };
  let hasRows = false;
  let scheduled = false;
  function sync() {
    const maximum = Math.max(0, frame.scrollWidth - frame.clientWidth) || 0;
    const current = Math.max(0, Math.min(maximum, frame.scrollLeft || 0));
    controls.hidden = !hasRows || maximum <= 1;
    position.max = String(maximum);
    position.value = String(current);
    position.setAttribute("aria-valuetext", `${maximum ? Math.round(current / maximum * 100) : 0}% across result columns`);
    left.disabled = current <= 1;
    right.disabled = current >= maximum - 1;
  }
  function scheduleSync() {
    if (scheduled) return;
    if (!globalThis.requestAnimationFrame) { sync(); return; }
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  }
  function moveTo(value) {
    frame.scrollLeft = Math.max(0, Math.min(Number(position.max), value));
    sync();
  }
  position.addEventListener("input", () => moveTo(Number(position.value)));
  left.addEventListener("click", () => moveTo(frame.scrollLeft - frame.clientWidth * .75));
  right.addEventListener("click", () => moveTo(frame.scrollLeft + frame.clientWidth * .75));
  frame.addEventListener("scroll", sync, { passive: true });
  globalThis.addEventListener?.("resize", scheduleSync);
  if (globalThis.ResizeObserver) {
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(frame);
    if (table) observer.observe(table);
  }
  return {
    render(state) { hasRows = Boolean(state.dataset && state.results.total); scheduleSync(); },
  };
}
