/**
 * The words `/` and `@` leave in a message, and the manifest the backend puts
 * in front of it. A skill is `/name`, a project file `@path`, an MCP resource
 * `@server:uri`. The words stay as typed; only what they name is sent as data.
 */

const OPEN = "<atria_references>\n";
const CLOSE = "\n</atria_references>\n\n";
const TOKEN = /(^|[\s(（])([/@])([^\s，。、；！？（）()]+)/g;
const SERVER_URI = /^([A-Za-z0-9_-]{1,64}):(.+)$/;

/** A sent message's references and the words the person typed. */
export function splitReferences(source) {
  const text = String(source || "");
  if (!text.startsWith(OPEN)) return { text, references: [] };
  const end = text.indexOf(CLOSE, OPEN.length);
  if (end < 0) return { text, references: [] };
  try {
    const manifest = JSON.parse(text.slice(OPEN.length, end));
    if (manifest?.version !== 1 || !Array.isArray(manifest.references)) return { text, references: [] };
    return { text: text.slice(end + CLOSE.length), references: manifest.references };
    // eslint-disable-next-line no-restricted-syntax -- 开头清单不保证是合法 JSON，解析失败时整段按正文处理
  } catch {
    return { text, references: [] };
  }
}

export function referenceToken(reference) {
  if (reference.kind === "skill") return `/${reference.name}`;
  if (reference.kind === "file") return `@${reference.path}`;
  if (reference.kind === "agent") return `@${reference.name}`;
  return `@${reference.server}:${reference.uri}`;
}

/** Trailing sentence punctuation belongs to the sentence, not the path. */
function trimmed(word) {
  return word.replace(/[.,:;!?'"]+$/, "");
}

/**
 * The references a draft makes. `known` holds the skill names and MCP servers
 * the menus offered, and the file paths picked from them; an `@` word with a
 * `/` or `.` also counts as a path, so a typed one works too.
 */
export function findReferences(text, known) {
  const found = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(TOKEN)) {
    const word = trimmed(match[3]);
    if (!word) continue;
    let reference;
    if (match[2] === "/") {
      if (known.skills.has(word)) reference = { kind: "skill", name: word };
    } else {
      const resource = SERVER_URI.exec(word);
      if (resource && known.servers.has(resource[1]))
        reference = { kind: "mcp_resource", server: resource[1], uri: resource[2] };
      else if (known.agents?.has(word)) reference = { kind: "agent", name: word };
      else if (known.files.has(word) || /[/.]/.test(word)) reference = { kind: "file", path: word };
    }
    if (!reference) continue;
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(reference);
  }
  return found;
}

/** The typed words as HTML, each referenced word marked as a chip. */
export function markReferences(text, references, esc) {
  const tokens = new Map(references.map((reference) => [referenceToken(reference), reference]));
  if (!tokens.size) return esc(text);
  let html = "";
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    const word = trimmed(match[3]);
    const token = match[2] + word;
    const reference = tokens.get(token);
    if (!reference) continue;
    const start = match.index + match[1].length;
    html += esc(text.slice(at, start));
    const title = reference.kind === "skill" ? reference.path || reference.name : token.slice(1);
    html += `<span class="reference-chip is-${reference.kind === "mcp_resource" ? "resource" : reference.kind}" title="${esc(title)}">${esc(token)}</span>`;
    at = start + token.length;
  }
  return html + esc(text.slice(at));
}
