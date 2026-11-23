/**
 * Handcrafted 16×16 micro-icons for inline `/` and `@` reference chips and
 * their picker rows. Every glyph uses `currentColor` and unique SVG `<mask>`
 * cutouts so badges stay razor-sharp on dark, light, hover and bubble surfaces.
 */

let maskSeq = 0;
function nextMaskId() {
  maskSeq += 1;
  return `ref-icon-m${maskSeq}`;
}

function wrapSvg(body, kind) {
  return `<svg class="ref-icon ref-icon-${kind}" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * Solid rounded-square typographic badge with truly transparent knocked-out
 * letters (e.g. `JS`, `TS`, `PY`, `SQL`), matching Codex's inline file tokens.
 */
function badgeIcon(text, { align = "center", size, weight = 700, tracking = "0" } = {}) {
  const id = nextMaskId();
  const len = text.length;
  const fontSize = size ?? (len === 1 ? 9.6 : len === 2 ? 7.6 : 5.7);
  const x = align === "corner" ? 13.4 : 8;
  const y = align === "corner" ? 13.1 : len === 3 ? 10.3 : 10.7;
  const anchor = align === "corner" ? "end" : "middle";
  return wrapSvg(
    `<defs><mask id="${id}"><rect width="16" height="16" fill="#fff"/><text x="${x}" y="${y}" text-anchor="${anchor}" fill="#000" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif" font-size="${fontSize}" font-weight="${weight}" letter-spacing="${tracking}">${text}</text></mask></defs><rect x="1.25" y="1.25" width="13.5" height="13.5" rx="3.25" fill="currentColor" mask="url(#${id})"/>`,
    "badge"
  );
}

/** Solid rounded-square badge with a custom geometric vector cutout. */
function cutoutBadge(cutoutMarkup, kind = "badge") {
  const id = nextMaskId();
  return wrapSvg(
    `<defs><mask id="${id}"><rect width="16" height="16" fill="#fff"/>${cutoutMarkup}</mask></defs><rect x="1.25" y="1.25" width="13.5" height="13.5" rx="3.25" fill="currentColor" mask="url(#${id})"/>`,
    kind
  );
}

/** Isometric layered skill cube (Codex-style hexagonal cube with diagonal seam). */
export function skillIcon() {
  return wrapSvg(
    '<path d="M8 1.6 13.6 4.75v6.5L8 14.4 2.4 11.25v-6.5L8 1.6Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M2.6 4.9 8 8l5.4-3.1" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>' +
      '<path d="M8 8v6.25" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
      '<path d="M2.6 8.15 8 11.25l5.4-3.1" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" opacity="0.72"/>',
    "skill"
  );
}

/** Sleek geometric agent emblem (faceted core diamond with subtle orbit frame). */
export function agentIcon() {
  return wrapSvg(
    '<rect x="2.1" y="3.1" width="11.8" height="9.8" rx="3.1" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M8 1.4v1.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '<circle cx="5.9" cy="8" r="1.05" fill="currentColor"/>' +
      '<circle cx="10.1" cy="8" r="1.05" fill="currentColor"/>' +
      '<path d="M6.4 10.6c.45.35 1 .52 1.6.52s1.15-.17 1.6-.52" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/>',
    "agent"
  );
}

/** Layered data-prism glyph for MCP resources. */
export function resourceIcon() {
  return wrapSvg(
    '<ellipse cx="8" cy="4.2" rx="5.2" ry="2.1" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M2.8 4.2v3.8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V4.2" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M2.8 8v3.8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V8" stroke="currentColor" stroke-width="1.3"/>',
    "resource"
  );
}

/** Editorial prompt-template card glyph for `/` prompt snippets. */
export function promptIcon() {
  return wrapSvg(
    '<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M5.1 5.8h5.8M5.1 8.3h4.2M5.1 10.8h2.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
      '<path d="M11 9.1l.45 1.05 1.05.45-1.05.45-.45 1.05-.45-1.05-1.05-.45 1.05-.45.45-1.05Z" fill="currentColor"/>',
    "prompt"
  );
}

/** Crisp slash-command keycap glyph for `/` actions. */
export function commandIcon() {
  return wrapSvg(
    '<rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M9.6 4.8 6.4 11.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    "command"
  );
}

function jsonIcon() {
  return cutoutBadge(
    '<path d="M6.3 4.6c-.95 0-1.35.48-1.35 1.35v.95c0 .55-.3.9-.85 1.1.55.2.85.55.85 1.1v.95c0 .87.4 1.35 1.35 1.35" stroke="#000" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M9.7 4.6c.95 0 1.35.48 1.35 1.35v.95c0 .55.3.9.85 1.1-.55.2-.85.55-.85 1.1v.95c0 .87-.4 1.35-1.35 1.35" stroke="#000" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>',
    "json"
  );
}

function markdownIcon() {
  return cutoutBadge(
    '<path d="M3.6 10.8V5.5l2.15 2.75L7.9 5.5v5.3" stroke="#000" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M11.15 5.4v5.1m0 0-1.55-1.65m1.55 1.65 1.55-1.65" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    "markdown"
  );
}

function htmlIcon() {
  return cutoutBadge(
    '<path d="M6.2 5.4 3.6 8l2.6 2.6M9.8 5.4 12.4 8l-2.6 2.6" stroke="#000" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>',
    "html"
  );
}

function shellIcon() {
  return cutoutBadge(
    '<path d="M4.2 5.5 6.9 8l-2.7 2.5M8.2 10.6h3.6" stroke="#000" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>',
    "shell"
  );
}

function envIcon() {
  return cutoutBadge(
    '<path d="M4.4 6h7.2M4.4 10h7.2" stroke="#000" stroke-width="1.35" stroke-linecap="round"/>' +
      '<circle cx="6.4" cy="6" r="1.45" fill="#000"/>' +
      '<circle cx="10.1" cy="10" r="1.45" fill="#000"/>',
    "env"
  );
}

function gitIcon() {
  return wrapSvg(
    '<circle cx="5.2" cy="4.1" r="1.55" stroke="currentColor" stroke-width="1.3"/>' +
      '<circle cx="10.9" cy="5.7" r="1.55" stroke="currentColor" stroke-width="1.3"/>' +
      '<circle cx="5.2" cy="11.9" r="1.55" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M5.2 5.65v4.7M10.9 7.25c0 1.85-1.45 2.75-5.7 2.85" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    "git"
  );
}

function containerIcon() {
  return wrapSvg(
    '<rect x="2.2" y="7.8" width="11.6" height="5.4" rx="1.6" stroke="currentColor" stroke-width="1.3"/>' +
      '<rect x="3.4" y="3.4" width="3.7" height="3.1" rx="0.8" stroke="currentColor" stroke-width="1.2"/>' +
      '<rect x="8.6" y="3.4" width="3.7" height="3.1" rx="0.8" stroke="currentColor" stroke-width="1.2"/>',
    "container"
  );
}

function imageFileIcon() {
  return wrapSvg(
    '<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="2.4" stroke="currentColor" stroke-width="1.3"/>' +
      '<circle cx="5.45" cy="5.8" r="1.1" fill="currentColor"/>' +
      '<path d="M2.6 11.4 6.2 8.1l2.4 2.2 1.8-1.65 3 2.75" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>',
    "image"
  );
}

function lockFileIcon() {
  return wrapSvg(
    '<rect x="3.1" y="7.1" width="9.8" height="6.8" rx="2" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M5.4 7.1V5.2a2.6 2.6 0 0 1 5.2 0v1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '<circle cx="8" cy="10.4" r="0.95" fill="currentColor"/>',
    "lock"
  );
}

function folderIcon() {
  return wrapSvg(
    '<path d="M2.1 4.8a1.6 1.6 0 0 1 1.6-1.6h2.7l1.35 1.45h4.55a1.6 1.6 0 0 1 1.6 1.6v5.15a1.6 1.6 0 0 1-1.6 1.6H3.7a1.6 1.6 0 0 1-1.6-1.6V4.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    "folder"
  );
}

function genericFileIcon() {
  return wrapSvg(
    '<path d="M3.5 2.4a1.2 1.2 0 0 1 1.2-1.2h4.6l3.2 3.2v9.2a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V2.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M9.1 1.4v2.6a.8.8 0 0 0 .8.8h2.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M5.7 8.1h4.6M5.7 10.7h3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    "file"
  );
}

const BADGE_EXTENSIONS = {
  js: ["JS", { align: "corner", size: 7.9 }],
  mjs: ["JS", { align: "corner", size: 7.9 }],
  cjs: ["JS", { align: "corner", size: 7.9 }],
  ts: ["TS", { align: "corner", size: 7.9 }],
  mts: ["TS", { align: "corner", size: 7.9 }],
  cts: ["TS", { align: "corner", size: 7.9 }],
  jsx: ["JSX", { size: 5.7, tracking: "-0.02em" }],
  tsx: ["TSX", { size: 5.7, tracking: "-0.02em" }],
  py: ["PY", { size: 7.5 }],
  pyi: ["PY", { size: 7.5 }],
  pyw: ["PY", { size: 7.5 }],
  go: ["GO", { size: 7.3 }],
  rs: ["RS", { size: 7.5 }],
  sql: ["SQL", { size: 5.5, tracking: "-0.02em" }],
  css: ["CSS", { size: 5.5, tracking: "-0.02em" }],
  scss: ["CSS", { size: 5.5, tracking: "-0.02em" }],
  sass: ["CSS", { size: 5.5, tracking: "-0.02em" }],
  less: ["CSS", { size: 5.5, tracking: "-0.02em" }],
  yml: ["YML", { size: 5.4, tracking: "-0.02em" }],
  yaml: ["YML", { size: 5.4, tracking: "-0.02em" }],
  toml: ["TML", { size: 5.4, tracking: "-0.02em" }],
  xml: ["XML", { size: 5.4, tracking: "-0.02em" }],
  csv: ["CSV", { size: 5.5, tracking: "-0.02em" }],
  tsv: ["TSV", { size: 5.5, tracking: "-0.02em" }],
  pdf: ["PDF", { size: 5.5, tracking: "-0.02em" }],
  svg: ["SVG", { size: 5.5, tracking: "-0.02em" }],
  vue: ["VUE", { size: 5.4, tracking: "-0.02em" }],
  svelte: ["SV", { size: 7.4 }],
  rb: ["RB", { size: 7.4 }],
  kt: ["KT", { size: 7.4 }],
  kts: ["KT", { size: 7.4 }],
  swift: ["SW", { size: 7.0 }],
  java: ["JV", { size: 7.4 }],
  php: ["PHP", { size: 5.4, tracking: "-0.02em" }],
  c: ["C", { size: 9.4 }],
  h: ["H", { size: 9.2 }],
  cc: ["C+", { size: 7.4 }],
  cpp: ["C+", { size: 7.4 }],
  cxx: ["C+", { size: 7.4 }],
  hpp: ["H+", { size: 7.4 }],
  hh: ["H+", { size: 7.4 }],
  cs: ["C#", { size: 7.3 }],
  dart: ["DT", { size: 7.4 }],
  zig: ["ZG", { size: 7.3 }],
  lua: ["LUA", { size: 5.4, tracking: "-0.02em" }],
  nix: ["NIX", { size: 5.6 }],
  gql: ["GQL", { size: 5.3, tracking: "-0.02em" }],
  graphql: ["GQL", { size: 5.3, tracking: "-0.02em" }],
  proto: ["PB", { size: 7.4 }],
  txt: ["TXT", { size: 5.5, tracking: "-0.02em" }],
  log: ["LOG", { size: 5.3, tracking: "-0.02em" }]
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "heic"]);
const SHELL_EXTENSIONS = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]);
const JSON_EXTENSIONS = new Set(["json", "jsonc", "jsonl", "ndjson"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
const DB_EXTENSIONS = new Set(["db", "sqlite", "sqlite3"]);

/** Handcrafted file-type icon derived from the file's basename or extension. */
export function fileTypeIcon(path) {
  const raw = String(path || "");
  if (raw.endsWith("/")) return folderIcon();
  const base = raw.split("/").pop() || "";
  const lower = base.toLowerCase();

  if (lower === "dockerfile" || lower.endsWith(".dockerfile") || lower.startsWith("docker-compose"))
    return containerIcon();
  if (lower === "makefile" || lower === "justfile") return shellIcon();
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") return gitIcon();
  if (lower === ".env" || lower.startsWith(".env.")) return envIcon();
  if (
    lower.endsWith(".lock") ||
    lower === "package-lock.json" ||
    lower === "pnpm-lock.yaml" ||
    lower === "yarn.lock"
  )
    return lockFileIcon();

  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (JSON_EXTENSIONS.has(ext)) return jsonIcon();
  if (MARKDOWN_EXTENSIONS.has(ext) || lower === "readme") return markdownIcon();
  if (HTML_EXTENSIONS.has(ext)) return htmlIcon();
  if (SHELL_EXTENSIONS.has(ext)) return shellIcon();
  if (IMAGE_EXTENSIONS.has(ext)) return imageFileIcon();
  if (DB_EXTENSIONS.has(ext)) return resourceIcon();

  const badge = BADGE_EXTENSIONS[ext];
  if (badge) return badgeIcon(badge[0], badge[1]);
  return genericFileIcon();
}

/** Handcrafted icon for any `/` or `@` reference object. */
export function referenceIcon(reference) {
  if (!reference) return genericFileIcon();
  if (reference.kind === "skill") return skillIcon();
  if (reference.kind === "agent") return agentIcon();
  if (reference.kind === "mcp_resource") return resourceIcon();
  return fileTypeIcon(reference.path);
}
