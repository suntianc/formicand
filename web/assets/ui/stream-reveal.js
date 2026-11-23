/** Whether `text` currently ends inside an unclosed fenced code block. */
export function hasOpenFence(text) {
  let open = "";
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!open) open = match[1];
    else if (match[1][0] === open[0] && match[1].length >= open.length && !match[2].trim()) open = "";
  }
  return Boolean(open);
}

/**
 * Close what a half-arrived reply leaves open and hold back what cannot render
 * yet, so streaming never shows raw markdown: an open code fence or inline
 * code, an unpaired `**`, a list or heading marker with nothing after it, and
 * a table before its separator row or with a half-written last row.
 */
export function completeMarkdown(text) {
  let lines = String(text).split("\n");
  if (hasOpenFence(text)) return `${text}\n\`\`\``;
  let last = lines.at(-1);
  if (/^\s*(#{1,6}|[-*+]|\d+[.)]?|>|`{1,2}|\*{1,2})\s*$/.test(last) && lines.length > 1) {
    lines.pop();
    last = lines.at(-1);
  }
  if (/^\s*\|/.test(last)) {
    let start = lines.length - 1;
    while (start > 0 && /^\s*\|/.test(lines[start - 1])) start -= 1;
    const rows = lines.slice(start);
    if (rows.length < 2 || !/^\s*\|[\s|:-]+\|?\s*$/.test(rows[1])) lines = lines.slice(0, start);
    else if (!/\|\s*$/.test(last)) lines.pop();
  }
  let out = lines.join("\n");
  const tail = lines.at(-1) || "";
  if ((tail.match(/`/g) || []).length % 2) out += "`";
  if ((tail.match(/\*\*/g) || []).length % 2) out += "**";
  return out;
}

/**
 * Streaming answers render plain Markdown directly without per-word reveal
 * wrappers or trailing cursor icons.
 */
export function createStreamReveal() {
  return {
    apply() {}
  };
}
