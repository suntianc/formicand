import { ui } from "./language.js";
import { icon } from "./icons.js";
import { escapeHtml as esc } from "./html.js";

/**
 * One transient notice card.
 *
 * Every caller gets the same stack: a title, an optional second line and a
 * tone. The stack keeps at most three cards so notices about another session,
 * a question or a connection never cover the whole conversation.
 */
export function showToast(message, options = {}) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  const tone = ["success", "warn", "info", "danger"].includes(options.tone) ? options.tone : "info";
  const iconName = {
    success: "circle-check",
    warn: "message-circle-question",
    danger: "wifi-off",
    info: "info"
  }[tone];
  const card = document.createElement("div");
  card.className = `toast-card is-${tone}`;
  card.innerHTML = ui`${icon(iconName)}<span class="toast-copy"><span class="toast-title">${esc(message)}</span>${options.detail ? ui`<span class="toast-detail">${esc(options.detail)}</span>` : ""}</span>`;
  toast.append(card);
  while (toast.children.length > 3) toast.firstElementChild.remove();
  requestAnimationFrame(() => card.classList.add("visible"));
  setTimeout(() => {
    card.classList.remove("visible");
    setTimeout(() => card.remove(), 200);
  }, options.duration ?? 3200);
}
