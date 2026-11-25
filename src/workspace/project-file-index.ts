import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const FILE_LIMIT = 50_000;
const FILE_CACHE_MS = 15_000;
const SKIPPED_FOLDERS = new Set([
  ".git",
  "node_modules",
  ".formicand",
  "dist",
  "build",
  ".next",
  "target",
  ".venv"
]);

/** Subsequence match: lower is better, undefined when the letters are not all there in order. */
export function fuzzyScore(path: string, query: string): number | undefined {
  if (!query) return path.split("/").length * 10 + path.length / 100;
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  const name = basename(haystack);
  if (name.startsWith(needle)) return name.length / 100;
  const inName = name.indexOf(needle);
  if (inName >= 0) return 1 + inName / 100;
  const inPath = haystack.indexOf(needle);
  if (inPath >= 0) return 2 + inPath / 1000;
  let at = 0;
  let gaps = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, at);
    if (next < 0) return undefined;
    gaps += next - at;
    at = next + 1;
  }
  return 3 + gaps / 100;
}

/**
 * The files of a project folder, as Git sees them (tracked plus untracked,
 * ignored ones left out), or a bounded walk when the folder is not a
 * repository. One short-lived listing per folder serves the composer's `@`
 * menu and file-reference lookup alike.
 */
export function createProjectFileIndex() {
  const cache = new Map<string, { at: number; files: Promise<string[]> }>();

  async function walk(root: string): Promise<string[]> {
    const files: string[] = [];
    const queue = [root];
    while (queue.length && files.length < FILE_LIMIT) {
      const folder = queue.shift()!;
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        // A folder the user cannot read is left out of the list, as git would.
        if (["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) queue.push(join(folder, entry.name));
        else if (entry.isFile()) files.push(relative(root, join(folder, entry.name)).split(sep).join("/"));
      }
    }
    return files;
  }

  async function listFiles(root: string): Promise<string[]> {
    try {
      const { stdout } = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024
      });
      return stdout.split("\0").filter(Boolean).slice(0, FILE_LIMIT);
      // eslint-disable-next-line no-restricted-syntax -- 不是 Git 仓库或没装 git 时改为直接遍历目录
    } catch {
      return walk(root);
    }
  }

  function files(root: string): Promise<string[]> {
    const cached = cache.get(root);
    if (cached && Date.now() - cached.at < FILE_CACHE_MS) return cached.files;
    const listed = listFiles(root);
    cache.set(root, { at: Date.now(), files: listed });
    // A failed listing is not kept, so the next call tries again; the caller sees the error.
    // eslint-disable-next-line no-restricted-syntax -- 错误由等待 listed 的调用方收到，这里只清掉缓存
    listed.catch(() => cache.delete(root));
    return listed;
  }

  return {
    files,

    /** Files whose path matches the query, best first. */
    async search(root: string, query: string, limit: number): Promise<string[]> {
      const scored = (await files(root)).flatMap((path) => {
        const score = fuzzyScore(path, query);
        return score === undefined ? [] : [{ path, score }];
      });
      scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
      return scored.slice(0, limit).map((entry) => entry.path);
    },

    /**
     * The listed files a partial reference can mean: those ending in the whole
     * reference, else those with its file name. A reply often names a file by
     * a shortened path or by its name alone.
     */
    async candidates(root: string, reference: string, limit: number): Promise<string[]> {
      const listed = await files(root);
      const tail = listed.filter((path) => path === reference || path.endsWith(`/${reference}`));
      const name = basename(reference);
      const found = tail.length ? tail : listed.filter((path) => basename(path) === name);
      return found.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
    }
  };
}

export type ProjectFileIndex = ReturnType<typeof createProjectFileIndex>;
