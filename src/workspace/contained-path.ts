import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** A requested path that is malformed, a link, or leaves its root. */
export class UnsafePath extends Error {}

/** The `/`-separated parts of a relative path; never absolute, empty, `.` or `..`. */
export function pathParts(value: string): string[] {
  if (!value || isAbsolute(value) || /^[a-zA-Z]:/.test(value) || /[\\\x00-\x1f\x7f]/.test(value))
    throw new UnsafePath(`unsafe path: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new UnsafePath(`unsafe path: ${value}`);
  return parts;
}

export function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

/** Resolve each component, rejecting links even when they point back into the root. */
export async function containedDirectory(root: string, parts: string[], create = false): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new UnsafePath(`unsafe directory: ${current}`);
  }
  if (!inside(root, await realpath(current))) throw new UnsafePath("directory escapes its root");
  return current;
}

/** A regular file under `root`, reached without following any link. */
export async function containedFile(
  root: string,
  relativePath: string
): Promise<{ absolutePath: string; stat: Stats }> {
  const parts = pathParts(relativePath);
  const parent = await containedDirectory(root, parts.slice(0, -1));
  const absolutePath = join(parent, parts.at(-1)!);
  const details = await lstat(absolutePath);
  if (details.isSymbolicLink() || !details.isFile())
    throw new UnsafePath(`not a regular file: ${relativePath}`);
  if (!inside(root, await realpath(absolutePath))) throw new UnsafePath("path escapes its root");
  return { absolutePath, stat: details };
}
