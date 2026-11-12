import { PAGE_SIZE_OPTIONS } from "../config.js";
import { clearNode, makeElement } from "./dom.js";

export function createPagination({ onPage, onPageSize }) {
  const container = document.getElementById("pagination");
  const pageSize = document.getElementById("page-size");

  for (const size of PAGE_SIZE_OPTIONS) {
    pageSize.append(makeElement("option", { text: String(size), attributes: { value: size } }));
  }
  const movePage = (page) => {
    onPage(page);
    document.querySelector(".table-frame")?.scrollTo({ top: 0, left: 0 });
  };
  pageSize.addEventListener("change", () => {
    onPageSize(Number(pageSize.value));
    document.querySelector(".table-frame")?.scrollTo({ top: 0, left: 0 });
  });

  function render(state) {
    pageSize.value = String(state.pageSize);
    pageSize.disabled = !state.dataset;
    clearNode(container);
    if (!state.dataset || state.results.total === 0) return;
    container.append(makeElement("span", { className: "page-position", text: `Page ${state.results.page.toLocaleString()} of ${state.results.totalPages.toLocaleString()}` }));
    if (state.results.totalPages <= 1) return;

    const { page, totalPages } = state.results;
    container.append(navButton("Previous", page - 1, page <= 1, movePage));

    const windowStart = Math.max(1, Math.min(page - 2, totalPages - 4));
    const windowEnd = Math.min(totalPages, windowStart + 4);
    if (windowStart > 1) {
      container.append(navButton("1", 1, false, movePage));
      if (windowStart > 2) container.append(makeElement("span", { className: "pagination-gap", text: "…" }));
    }
    for (let number = windowStart; number <= windowEnd; number += 1) {
      const button = navButton(String(number), number, false, movePage);
      if (number === page) {
        button.classList.add("is-current");
        button.setAttribute("aria-current", "page");
      }
      container.append(button);
    }
    if (windowEnd < totalPages) {
      if (windowEnd < totalPages - 1) container.append(makeElement("span", { className: "pagination-gap", text: "…" }));
      container.append(navButton(String(totalPages), totalPages, false, movePage));
    }

    container.append(navButton("Next", page + 1, page >= totalPages, movePage));
  }

  return { render };
}

function navButton(label, page, disabled, onPage) {
  const button = makeElement("button", {
    className: "pagination-button",
    text: label,
    attributes: { type: "button", "aria-label": /^\d+$/u.test(label) ? `Page ${label}` : `${label} page` },
  });
  button.disabled = disabled;
  button.addEventListener("click", () => onPage(page));
  return button;
}
