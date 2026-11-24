import { escapeHtml as esc } from "./html.js";

/**
 * A mark for something that has no icon of its own (an MCP server, a custom
 * Agent): the first letter of its name on a tint fixed by that name, so the
 * same name always reads the same colour.
 */
export function letterMark(name, className = "") {
  const text = String(name);
  const letter = (/[\p{L}\p{N}]/u.exec(text)?.[0] ?? "?").toUpperCase();
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return `<span class="letter-mark${className ? ` ${className}` : ""}" data-tint="${hash % 6}" aria-hidden="true">${esc(letter)}</span>`;
}
