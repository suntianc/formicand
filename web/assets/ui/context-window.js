import { escapeHtml as esc } from "./html.js";
import { ui } from "./language.js";

/** Anchor a divider to the last preceding saved message, even within one exchange. */
export function contextWindowDividers(windows, exchanges, taskId) {
  const dividers = new Map();
  if (!windows.length) return dividers;
  const messages = exchanges
    .flatMap((exchange) => exchange.messages)
    .filter((message) => Number.isFinite(message.timestamp));
  for (const window of windows) {
    const anchor = messages.findLast((message) => message.timestamp <= window.timestamp);
    const key = `${taskId}:context-window:${window.id}`;
    const markup = ui`<details class="context-window-divider" data-activity-key="${esc(key)}"><summary>已换新窗口</summary><pre class="tool-copy">${esc(window.summary)}</pre></details>`;
    dividers.set(anchor, (dividers.get(anchor) ?? "") + markup);
  }
  return dividers;
}
