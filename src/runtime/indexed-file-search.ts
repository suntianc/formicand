import type { FileFinder, GrepMode, GrepCursor, GrepResult, Result } from "@ff-labs/fff-node";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function indexRoot(directory: string): string {
  for (let path = directory; ; path = dirname(path)) {
    if (existsSync(join(path, ".git"))) return path;
    if (dirname(path) === path) return directory;
  }
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

type ScopedPath = (indexedPath: string) => string | undefined;

function searchLines(
  index: FileFinder,
  pattern: string,
  mode: GrepMode,
  limit: number,
  scopedPath: ScopedPath
) {
  const lines: string[] = [];
  let linesTruncated = false;
  let cursor: GrepCursor | null = null;
  do {
    const page: GrepResult = unwrap(
      index.grep(pattern, { mode, smartCase: true, pageSize: limit + 1, cursor })
    );
    for (const hit of page.items) {
      const path = scopedPath(hit.relativePath);
      if (path === undefined) continue;
      if (lines.length === limit) return { lines, truncated: true, linesTruncated };
      // Keep our displayed preview below FFF 0.11's 512-byte window so the tool can report truncation.
      const preview = Buffer.from(hit.lineContent);
      const clipped = preview.length > 480;
      const content = clipped
        ? new TextDecoder().decode(preview.subarray(0, 480), { stream: true })
        : hit.lineContent;
      linesTruncated ||= clipped;
      lines.push(`${path}:${hit.lineNumber}: ${content.trimEnd()}`);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { lines, truncated: false, linesTruncated };
}

/** Scope results within one repository index so a narrower path inherits the same ignore rules. */
export class IndexedFileSearch {
  private index?: Promise<FileFinder>;
  private readonly root: string;
  constructor(private readonly directory: string) {
    this.root = indexRoot(directory);
  }

  async close(): Promise<void> {
    const index = this.index;
    this.index = undefined;
    if (index) (await index).destroy();
  }

  private async search<T>(
    path: string | undefined,
    signal: AbortSignal | undefined,
    query: (index: FileFinder, scopedPath: ScopedPath) => T
  ): Promise<T> {
    signal?.throwIfAborted();
    const target = resolve(this.directory, path ?? ".");
    const file = path && (await stat(target)).isFile();
    const folder = file ? dirname(target) : target;
    const local = relative(this.root, folder);
    const external = local === ".." || local.startsWith(".." + sep) || isAbsolute(local);
    const root = external ? indexRoot(folder) : this.root;
    const prefix = relative(root, folder).split(sep).join("/");
    const scopedPath: ScopedPath = (indexedPath) => {
      const name = indexedPath.split(sep).join("/");
      if (prefix && !name.startsWith(prefix + "/")) return undefined;
      const scoped = prefix ? name.slice(prefix.length + 1) : name;
      return file && scoped !== basename(target) ? undefined : scoped;
    };
    const index = await (external
      ? openIndex(root)
      : (this.index ??= openIndex(root).catch((error: unknown) => {
          this.index = undefined;
          throw error;
        })));
    try {
      signal?.throwIfAborted();
      return query(index, scopedPath);
    } finally {
      if (external) index.destroy();
    }
  }

  async names(pattern: string, limit: number, path?: string, signal?: AbortSignal) {
    return this.search(path, signal, (index, scopedPath) => {
      const paths: string[] = [];
      const pageSize = limit + 1;
      for (let pageIndex = 0; ; pageIndex++) {
        const { items, totalMatched } = unwrap(index.fileSearch(pattern, { pageSize, pageIndex }));
        for (const hit of items) {
          const name = scopedPath(hit.relativePath);
          if (name === undefined) continue;
          if (paths.length === limit) return { paths, truncated: true };
          paths.push(name);
        }
        if (!items.length || (pageIndex + 1) * pageSize >= totalMatched) return { paths, truncated: false };
      }
    });
  }

  async content(pattern: string, limit: number, path?: string, signal?: AbortSignal) {
    return this.search(path, signal, (index, scopedPath) => {
      const exact = searchLines(index, pattern, "plain", limit, scopedPath);
      if (exact.lines.length) return { ...exact, text: exact.lines.join("\n") };
      const similar = searchLines(index, pattern, "fuzzy", limit, scopedPath);
      return {
        ...similar,
        text: similar.lines.length
          ? `0 exact matches. Similar results:\n${similar.lines.join("\n")}`
          : "No matches found"
      };
    });
  }
}
