/**
 * A user project's document registry: a table under a `## 文档` (or
 * `## Documents`) heading in its root AGENTS.md, one row per path with the
 * document's type and domain. The program checks it before a full route's final review;
 * whether a document's text is still right is Main's periodic maintenance.
 */
import { ProjectDataInvalidError } from "./project-ledger.js";

export const REGISTRY_FILE = "AGENTS.md";

export const DOCUMENT_TYPES = [
  "instructions",
  "standards",
  "glossary",
  "adr",
  "history",
  "pitfalls",
  "product",
  "generated",
  "unsorted"
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** One document of these types per domain; another one is merged into it. */
const SINGLE: readonly DocumentType[] = ["instructions", "standards", "glossary", "product"];

/** Always registered, with or without a row: the root instructions, and the retro's pitfalls. */
const ROOT_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const implicit = (file: string) => ROOT_INSTRUCTIONS.includes(file) || file.startsWith("docs/pitfalls/");

export interface DocumentRow {
  path: string;
  type: DocumentType;
  domain: string;
}

const HEADING = /^##\s+(文档|Documents)\s*$/;
const NEXT_HEADING = /^#{1,2}\s/;
const SEPARATOR = /^:?-+:?$/;

/** A Markdown document, as the registry counts them. */
export const isDocument = (path: string) => /\.(md|mdx)$/i.test(path);

/** The registry section's line range in the file, or undefined when it has none. */
function sectionRange(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return undefined;
  const after = lines.slice(start + 1).findIndex((line) => NEXT_HEADING.test(line));
  return { start, end: after < 0 ? lines.length : start + 1 + after };
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^`(.*)`$/, "$1"));

/**
 * The registry's rows, or undefined when the file has no registry heading.
 * A malformed row is named in `problems` rather than thrown: the program
 * reports every problem at once.
 */
export function parseRegistry(
  text: string | undefined
): { rows: DocumentRow[]; problems: string[] } | undefined {
  const lines = (text ?? "").split("\n");
  const range = sectionRange(lines);
  if (!range) return undefined;
  const table = lines.slice(range.start + 1, range.end).filter((line) => line.trim().startsWith("|"));
  const rows: DocumentRow[] = [];
  const problems: string[] = [];
  // The first table line is the header.
  for (const line of table.slice(1)) {
    const row = cells(line);
    if (row.every((cell) => SEPARATOR.test(cell))) continue;
    const [path = "", type = "", domain = ""] = row;
    if (row.length !== 3 || !path || !domain) {
      problems.push(`表格行须为“路径 | 类型 | 领域”三栏：${line.trim()}`);
      continue;
    }
    if (!DOCUMENT_TYPES.includes(type as DocumentType)) {
      problems.push(`${path} 的类型 ${type} 不在 ${DOCUMENT_TYPES.join(" / ")} 里`);
      continue;
    }
    rows.push({ path: path.replace(/^\.\//, "").replace(/\/+$/, ""), type: type as DocumentType, domain });
  }
  if (!table.length) problems.push("“文档”标题下没有表格");
  return { rows, problems };
}

/** A row covers a file when it names the file or a directory above it. */
const covers = (row: DocumentRow, file: string) =>
  row.path === "." || file === row.path || file.startsWith(`${row.path}/`);

/** The row a file belongs to: the first that covers it. */
export const rowOf = (rows: DocumentRow[], file: string) => rows.find((row) => covers(row, file));

export interface RegistryProblems {
  /** The file has no registry heading at all. */
  missing: boolean;
  malformed: string[];
  unregistered: string[];
  /** Rows that cover no document. */
  stale: string[];
  /** Rows of a single-document type sharing a domain. */
  duplicates: string[];
}

/**
 * What is wrong with the registry at a requirement's candidate. `documents` is
 * every Markdown file there; `checked` the ones this requirement must have
 * registered: those it added or renamed, or every one when it built the table.
 */
export function registryProblems(
  registry: string | undefined,
  documents: string[],
  checked: string[]
): RegistryProblems {
  const parsed = parseRegistry(registry);
  if (!parsed) return { missing: true, malformed: [], unregistered: [], stale: [], duplicates: [] };
  const { rows, problems } = parsed;
  const unregistered = checked.filter((file) => isDocument(file) && !implicit(file) && !rowOf(rows, file));
  const stale = rows
    .filter(
      (row) =>
        !implicit(row.path) && row.path !== "docs/pitfalls" && !documents.some((file) => covers(row, file))
    )
    .map((row) => row.path);
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const row of rows.filter((entry) => SINGLE.includes(entry.type))) {
    const key = `${row.type}/${row.domain}`;
    const first = seen.get(key);
    if (first !== undefined) duplicates.push(`${first} 与 ${row.path}（${key}）`);
    else seen.set(key, row.path);
  }
  return { missing: false, malformed: problems, unregistered, stale, duplicates };
}

export const hasRegistryProblems = (problems: RegistryProblems) =>
  problems.missing ||
  [problems.malformed, problems.unregistered, problems.stale, problems.duplicates].some(
    (list) => list.length > 0
  );

/** One document a periodic maintenance found out of step with the code. */
export interface DocumentUpdate {
  path: string;
  reason: string;
}

/** Main's verdict on the documents at a ledger tidy: what to update, or why nothing. */
export type TidyDocuments = { update: DocumentUpdate[] } | { unchanged: string };

const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ProjectDataInvalidError(`${label}须为 1–${max} 个字符`);
  return value.trim();
};

export function tidyDocumentsInput(value: unknown): TidyDocuments | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError("documents 须为对象");
  const input = value as Record<string, unknown>;
  if ((input.update === undefined) === (input.unchanged === undefined))
    throw new ProjectDataInvalidError(
      "documents 须二选一：update 列出要更新的文档，或 unchanged 写明为什么都不用改"
    );
  if (input.unchanged !== undefined) return { unchanged: text(input.unchanged, "documents.unchanged", 1000) };
  if (!Array.isArray(input.update) || !input.update.length || input.update.length > 30)
    throw new ProjectDataInvalidError("documents.update 须为 1–30 项");
  return {
    update: input.update.map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return {
        path: text(entry.path, "documents.update.path", 500),
        reason: text(entry.reason, "documents.update.reason", 1000)
      };
    })
  };
}

/** The development a tidy's document updates become: on the misc requirement, without asking. */
export function documentsNext(update: DocumentUpdate[], miscRequirementId: string | undefined): string {
  const list = update.map((item) => `${item.path} (${item.reason})`).join("; ");
  return `Now bring these documents up to date as one development${miscRequirementId ? ` on the misc requirement ${miscRequirementId}` : ""}, route by its size: ${list}. Follow the tidy-docs skill; do not ask the user or report it.`;
}
