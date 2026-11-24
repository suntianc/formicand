import { icon } from "./icons.js";

/**
 * The mark a file reads as, from its name alone: a code file shows its
 * language, other files their kind (picture, table, archive, text), each in
 * the kind's colour. Language marks come from one cached sprite file
 * (`file-icons.svg`), so a message full of files costs one request and no
 * inline path data per chip.
 */

const LANGUAGES = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  html: "html5",
  htm: "html5",
  css: "css3",
  scss: "css3",
  less: "css3",
  kt: "kotlin",
  kts: "kotlin",
  vue: "vuedotjs",
  c: "c",
  h: "c",
  cc: "cplusplus",
  cpp: "cplusplus",
  cxx: "cplusplus",
  hpp: "cplusplus",
  yml: "yaml",
  yaml: "yaml",
  rs: "rust",
  java: "openjdk",
  swift: "swift",
  rb: "ruby",
  php: "php",
  dart: "dart",
  lua: "lua",
  svelte: "svelte"
};

const KINDS = [
  ["shell", "terminal", /^(sh|bash|zsh|fish|ps1|bats)$/],
  ["image", "image", /^(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic)$/],
  ["table", "table", /^(csv|tsv|xlsx?|numbers)$/],
  ["archive", "file-archive", /^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/],
  ["text", "file-text", /^(md|mdx|markdown|txt|rst|log|pdf|docx?|rtf|pages)$/],
  [
    "code",
    "file-code",
    /^(json5?|toml|ini|xml|sql|env|lock|ipynb|r|scala|cs|m|mm|pl|ex|exs|erl|hs|clj|zig|nim|graphql|proto)$/
  ]
];

const extensionOf = (name) => /\.([^./]+)$/.exec(String(name))?.[1]?.toLowerCase() ?? "";

/** The kind of a file, for colouring: a language key, or shell, image, table, archive, text, code, file. */
export function fileKind(name) {
  const extension = extensionOf(name);
  if (extension === "json" || extension === "jsonc") return "json";
  if (LANGUAGES[extension]) return "language";
  for (const [kind, , pattern] of KINDS) if (pattern.test(extension)) return kind;
  return /^(makefile|dockerfile|rakefile|gemfile|procfile)$/i.test(String(name).split("/").pop())
    ? "code"
    : "file";
}

/** The file's mark as inline SVG markup, decorative and sized by the caller's styles. */
export function fileIcon(name) {
  const extension = extensionOf(name);
  const language = LANGUAGES[extension];
  if (language)
    return `<svg class="ui-icon file-icon is-language" data-language="${language}" aria-hidden="true" focusable="false"><use href="/assets/file-icons.svg#lang-${language}"/></svg>`;
  if (extension === "json" || extension === "jsonc")
    return '<span class="file-icon is-json" aria-hidden="true">{ }</span>';
  for (const [kind, glyph, pattern] of KINDS)
    if (pattern.test(extension)) return icon(glyph, `file-icon is-${kind}`);
  return icon(fileKind(name) === "code" ? "file-code" : "file", "file-icon");
}
