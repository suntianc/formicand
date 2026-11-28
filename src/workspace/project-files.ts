import { fileURLToPath } from "node:url";
import type { Stats } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { containedFile, inside, pathParts, UnsafePath } from "./contained-path.js";

/** The reference names no file in the project. */
export class ProjectFileMissing extends Error {}

/**
 * A regular file of the session's project folder, for a read-only preview.
 * The path is relative to the folder, reached without links, and never inside
 * `.git`.
 */
export async function resolveProjectFile(
  projectDirectory: string,
  relativePath: string
): Promise<{ absolutePath: string; stat: Stats }> {
  if (pathParts(relativePath).includes(".git")) throw new UnsafePath(`unsafe path: ${relativePath}`);
  const root = await realpath(projectDirectory);
  try {
    return await containedFile(root, relativePath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new ProjectFileMissing(`项目里没有这个文件：${relativePath}`);
    throw error;
  }
}

/** Changes whenever the file is replaced or rewritten. */
export function projectFileVersion(stat: Stats): string {
  return `${stat.ino}-${stat.size}-${Math.floor(stat.mtimeMs)}`;
}

function normalizeReference(reference: string): string | undefined {
  const trimmed = reference.trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  const match = /^file:\/\/(?:localhost)?(\/(?![/\\]).*)$/i.exec(trimmed);
  if (!match) return undefined;
  const [raw] = trimmed.split("#");
  let local = raw;
  try {
    decodeURIComponent(raw);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    // Older replies can contain literal percent signs in filenames.
    local = raw.replaceAll("%", "%25");
  }
  try {
    const path = fileURLToPath(local.replaceAll("?", "%3F"));
    return /[\x00-\x1f\x7f]/.test(path) ? undefined : path;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * The project-relative form of a path a reply wrote: `./a`, `a`, or an
 * absolute path inside the folder. Anything else names no project file.
 */
export async function projectReference(
  projectDirectory: string,
  reference: string
): Promise<string | undefined> {
  const text = normalizeReference(reference);
  if (!text) return undefined;
  if (!isAbsolute(text)) {
    const clean = text.replace(/^(\.\/)+/, "");
    return clean || undefined;
  }
  const roots = [projectDirectory, await realpath(projectDirectory)];
  const root = roots.find((candidate) => inside(candidate, text));
  if (!root) return undefined;
  const local = relative(root, text).split(sep).join("/");
  return local || undefined;
}
