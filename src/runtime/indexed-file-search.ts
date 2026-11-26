import type { FileFinder, GrepMode, GrepCursor, GrepResult, Result } from "@ff-labs/fff-node";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function openIndex(directory: string): Promise<FileFinder> {
  const { FileFinder } = await import("@ff-labs/fff-node");
  const finder = unwrap(FileFinder.create({ basePath: directory, aiMode: true, followSymlinks: false }));
  try {
    if (!unwrap(await finder.waitForScan(30_000)))
      throw new Error(`File index is still scanning ${directory}`);
    return finder;
  } catch (error) {
    finder.destroy();
    throw error;
  }
}

function searchLines(index: FileFinder, pattern: string, mode: GrepMode, limit: number, file?: string) {
  const lines: string[] = [];
  let cursor: GrepCursor | null = null;
  do {
    const page: GrepResult = unwrap(
      index.grep(pattern, { mode, smartCase: true, pageSize: limit + 1, cursor })
    );
    for (const hit of page.items) {
      if (file && hit.relativePath !== file) continue;
      if (lines.length === limit) return { lines, truncated: true };
      lines.push(`${hit.relativePath}:${hit.lineNumber}: ${hit.lineContent.trimEnd()}`);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { lines, truncated: false };
}

/** One lazily opened index per Pi session. A scoped query uses that directory's own ignore rules. */
export class IndexedFileSearch {
  private index?: Promise<FileFinder>;
  constructor(private readonly directory: string) {}

  async close(): Promise<void> {
    const index = this.index;
    this.index = undefined;
    if (index) (await index).destroy();
  }

  private async search<T>(
    path: string | undefined,
    signal: AbortSignal | undefined,
    query: (index: FileFinder) => T
  ): Promise<T> {
    signal?.throwIfAborted();
    const directory = resolve(this.directory, path ?? ".");
    const scoped = directory !== this.directory;
    const index = await (scoped
      ? openIndex(directory)
      : (this.index ??= openIndex(directory).catch((error: unknown) => {
          this.index = undefined;
          throw error;
        })));
    try {
      signal?.throwIfAborted();
      return query(index);
    } finally {
      if (scoped) index.destroy();
    }
  }

  async names(pattern: string, limit: number, path?: string, signal?: AbortSignal) {
    return this.search(path, signal, (index) => {
      const { items, totalMatched } = unwrap(index.fileSearch(pattern, { pageSize: limit }));
      return { paths: items.map((item) => item.relativePath), truncated: totalMatched > items.length };
    });
  }

  async content(pattern: string, limit: number, path?: string, signal?: AbortSignal) {
    const target = resolve(this.directory, path ?? ".");
    const file = path && (await stat(target)).isFile() ? basename(target) : undefined;
    return this.search(file ? dirname(target) : target, signal, (index) => {
      const exact = searchLines(index, pattern, "plain", limit, file);
      if (exact.lines.length) return { text: exact.lines.join("\n"), truncated: exact.truncated };
      const similar = searchLines(index, pattern, "fuzzy", limit, file);
      return {
        text: similar.lines.length
          ? `0 exact matches. Similar results:\n${similar.lines.join("\n")}`
          : "No matches found",
        truncated: similar.truncated
      };
    });
  }
}
