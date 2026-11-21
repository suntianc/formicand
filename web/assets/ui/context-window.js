import { ui } from "./language.js";

/**
 * Anchor a divider to the last preceding saved message, even within one
 * exchange. It only marks where the conversation moved to a new window; what
 * the model was handed there is not the user's to read.
 */
export function contextWindowDividers(windows, exchanges) {
  const dividers = new Map();
  if (!windows.length) return dividers;
  const messages = exchanges
    .flatMap((exchange) => exchange.messages)
    .filter((message) => Number.isFinite(message.timestamp));
  for (const window of windows) {
    const anchor = messages.findLast((message) => message.timestamp <= window.timestamp);
    const markup = ui`<div class="context-window-divider" role="separator"><span>新的上下文窗口</span></div>`;
    dividers.set(anchor, (dividers.get(anchor) ?? "") + markup);
  }
  return dividers;
}
