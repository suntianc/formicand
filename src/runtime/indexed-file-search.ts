import type { FileFinder, GrepMode, GrepCursor, GrepResult, Result } from "@ff-labs/fff-node";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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

/** The path disappeared while resolving it; the caller still reports its own spelling. */
function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Return the path the file system actually stored. realpath resolves links but
 * on macOS keeps the caller's spelling, so restore each existing component
 * from its directory listing. Only a path that realpath accepted is rewritten,
 * so a case-sensitive volume keeps reporting a misspelled path as missing.
 */
function physicalPath(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return path;
  }
  const { root } = parse(resolved);
  let current = root;
  for (const segment of resolved.slice(root.length).split(sep)) {
    if (!segment) continue;
    let name = segment;
    try {
      const entries = readdirSync(current);
      if (!entries.includes(segment)) {
        const folded = segment.toLowerCase();
        name = entries.find((entry) => entry.toLowerCase() === folded) ?? segment;
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    current = join(current, name);
  }
  return current;
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
    // The index stores the directory names it read from disk. A caller may name
    // the same directory through a link or a different letter case, so compare
    // physical paths instead of the strings the request happened to use.
    const folder = physicalPath(file ? dirname(target) : target);
    const root = physicalPath(this.root);
    const local = relative(root, folder);
    const external = local === ".." || local.startsWith(".." + sep) || isAbsolute(local);
    const base = external ? physicalPath(indexRoot(folder)) : root;
    const prefix = relative(base, folder).split(sep).join("/");
    const name = file ? basename(physicalPath(target)) : undefined;
    const scopedPath: ScopedPath = (indexedPath) => {
      const indexed = indexedPath.split(sep).join("/");
      if (prefix && !indexed.startsWith(prefix + "/")) return undefined;
      const scoped = prefix ? indexed.slice(prefix.length + 1) : indexed;
      return name !== undefined && scoped !== name ? undefined : scoped;
    };
    const index = await (external
      ? openIndex(base)
      : (this.index ??= openIndex(base).catch((error: unknown) => {
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
