import { PAGE_SIZE_OPTIONS } from "../config.js";
import { clearNode, makeElement } from "./dom.js";

export function createPagination({ onPage, onPageSize }) {
  const container = document.getElementById("pagination");
  const pageSize = document.getElementById("page-size");

  for (const size of PAGE_SIZE_OPTIONS) {
    pageSize.append(makeElement("option", { text: String(size), attributes: { value: size } }));
  }
  pageSize.addEventListener("change", () => onPageSize(Number(pageSize.value)));

  function render(state) {
    pageSize.value = String(state.pageSize);
    pageSize.disabled = !state.dataset;
    clearNode(container);
    if (!state.dataset || state.results.totalPages <= 1) return;

    const { page, totalPages } = state.results;
    container.append(navButton("Previous", page - 1, page <= 1, onPage));

    const windowStart = Math.max(1, Math.min(page - 2, totalPages - 4));
    const windowEnd = Math.min(totalPages, windowStart + 4);
    if (windowStart > 1) {
      container.append(navButton("1", 1, false, onPage));
      if (windowStart > 2) container.append(makeElement("span", { className: "pagination-gap", text: "…" }));
    }
    for (let number = windowStart; number <= windowEnd; number += 1) {
      const button = navButton(String(number), number, false, onPage);
      if (number === page) {
        button.classList.add("is-current");
        button.setAttribute("aria-current", "page");
      }
      container.append(button);
    }
    if (windowEnd < totalPages) {
      if (windowEnd < totalPages - 1) container.append(makeElement("span", { className: "pagination-gap", text: "…" }));
      container.append(navButton(String(totalPages), totalPages, false, onPage));
    }

    container.append(navButton("Next", page + 1, page >= totalPages, onPage));
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
