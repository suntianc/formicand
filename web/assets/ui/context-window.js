import { escapeHtml as esc } from "./html.js";
import { icon } from "./icons.js";
import { ui } from "./language.js";

/**
 * Anchor a divider to the last preceding saved message, even within one
 * exchange. It folds open onto the handoff the new window started from.
 */
export function contextWindowDividers(windows, exchanges, taskId, markdown) {
  const dividers = new Map();
  if (!windows.length) return dividers;
  const messages = exchanges
    .flatMap((exchange) => exchange.messages)
    .filter((message) => Number.isFinite(message.timestamp));
  for (const window of windows) {
    const anchor = messages.findLast((message) => message.timestamp <= window.timestamp);
    const key = `${taskId}:context-window:${window.id}`;
    const markup = ui`<details class="context-window-divider" data-activity-key="${esc(key)}"><summary><span>新的上下文窗口</span><span class="context-window-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="reasoning-copy markdown-body">${markdown(window.summary)}</div></details>`;
    dividers.set(anchor, (dividers.get(anchor) ?? "") + markup);
  }
  return dividers;
}
