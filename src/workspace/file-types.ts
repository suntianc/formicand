import { basename, extname } from "node:path";

const TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

/** Source and config files that have no registered type of their own. */
const PLAIN_TEXT = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".jsx",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".sql",
  ".diff",
  ".patch",
  ".r",
  ".rs",
  ".go",
  ".c",
  ".h",
  ".cpp",
  ".java",
  ".ipynb",
  ".env"
]);
const PLAIN_TEXT_NAMES = new Set(["Dockerfile", "Makefile", "LICENSE", ".gitignore", ".env"]);
const TEXTUAL = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/javascript"
]);
const OFFICE = new Set([TYPES[".docx"], TYPES[".pptx"], TYPES[".xlsx"]]);

/** The media type a file's name implies; an unknown name is `application/octet-stream`. */
export function mimeTypeOf(path: string): string {
  const extension = extname(path).toLowerCase();
  if (PLAIN_TEXT.has(extension) || PLAIN_TEXT_NAMES.has(basename(path))) return "text/plain";
  return TYPES[extension] ?? "application/octet-stream";
}

/**
 * How a preview shows a file of this type. `unknown` means the name says
 * nothing, so the bytes decide between text and a download.
 */
export type PreviewKind = "text" | "office" | "pdf" | "image" | "download";
export function previewKindOf(mimeType: string): PreviewKind | "unknown" {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/") || TEXTUAL.has(mimeType)) return "text";
  if (OFFICE.has(mimeType)) return "office";
  if (mimeType === "application/octet-stream") return "unknown";
  return "download";
}
