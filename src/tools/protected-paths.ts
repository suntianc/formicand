import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { containsFilePath, resolveFileTarget, resolveProtectedTarget } from "./file-path.js";

/**
 * Where this harness is installed.
 *
 * Derived from the module's own location so it holds however Formicand was
 * started, and used as an absolute protected root: an Agent must not edit the
 * runtime it runs in. `dist/src/tools/` is three levels below the install root.
 */
export function formicandInstallRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

/**
 * Paths an Agent must not write, even where it is otherwise allowed to.
 *
 * The guard is enforced in the file tools, not requested in a prompt, and it
 * applies to Main as much as to a Subagent. It is NOT a sandbox: `bash` spawns
 * real processes that can write wherever the OS lets them.
 */

/** Version-control metadata, so history and hooks stay outside an Agent's edits. */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [".git/"];

export interface ProtectedPathOptions {
  /** Root the patterns are relative to. Usually the user's project directory. */
  root: string;
  /** Overrides the defaults entirely when provided. */
  patterns?: readonly string[];
  /**
   * Absolute directories protected wherever they sit. The harness install goes
   * here, and it is usually not inside the project at all.
   */
  protectedRoots?: readonly string[];
}

export class ProtectedPaths {
  private readonly root: string;
  private readonly patterns: string[];
  private readonly roots: string[];

  constructor(options: ProtectedPathOptions) {
    this.root = resolve(options.root);
    this.patterns = [...(options.patterns ?? DEFAULT_PROTECTED_PATHS)]
      .map((pattern) => pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, ""))
      .filter(Boolean);
    this.roots = [...(options.protectedRoots ?? [])].filter(Boolean).map((entry) => resolve(entry));
  }

  /** The pattern that protects this path, or undefined when it is writable. */
  match(candidate: string): string | undefined {
    const absolute = resolve(candidate);
    // An absolute protected root applies wherever the path lives, including
    // outside the project — the harness install usually is.
    for (const root of this.roots) {
      if (containsFilePath(root, absolute)) return root;
    }
    const rel = relative(this.root, absolute).replaceAll(sep, "/");
    // Outside the guarded root entirely; a different check owns that path.
    if (!containsFilePath(this.root, absolute)) return undefined;
    if (!rel) return undefined;
    for (const pattern of this.patterns) {
      if (pattern.endsWith("/")) {
        const directory = pattern.slice(0, -1);
        if (rel === directory || rel.startsWith(`${directory}/`)) return pattern;
      } else if (rel === pattern || rel.startsWith(`${pattern}/`)) {
        return pattern;
      }
    }
    return undefined;
  }

  /**
   * The first pattern whose path currently exists under the guarded root.
   *
   * A relative write after a directory change we cannot follow could land on
   * any of them. Only patterns inside the project count: an absolute protected
   * root such as the harness install is not a plausible target of a relative
   * shell path, and blocking every relative write for it would stop ordinary
   * work in a project that is not the harness.
   */
  firstExistingPattern(): string | undefined {
    return this.patterns.find((pattern) => existsSync(resolve(this.root, pattern)));
  }

  /** Throw when a write would land on a protected path. */
  assertWritable(candidate: string): void {
    const pattern = this.match(candidate);
    if (!pattern) return;
    const absolute = resolve(candidate);
    const rel = relative(this.root, absolute).replaceAll(sep, "/");
    const shown = containsFilePath(this.root, absolute) ? rel : absolute;
    throw new Error(
      `${shown} is read-only for agents (protected by "${pattern}"). ` +
        `The Formicand runtime and version-control metadata are not edited by agents; ask the user if this file must change.`
    );
  }

  /** Apply the guard to targets reached through aliases and linked parents. */
  async assertWritableTarget(candidate: string): Promise<void> {
    this.assertWritable(candidate);
    const target = await resolveFileTarget(candidate);
    const root = await resolveProtectedTarget(this.root);
    const roots = await Promise.all(this.roots.map(resolveProtectedTarget));
    const resolved = new ProtectedPaths({ root, patterns: this.patterns, protectedRoots: roots });
    resolved.assertWritable(target);
    // A protected directory may itself be a symlink. Its target stays
    // protected even when accessed through a different project path.
    for (const pattern of this.patterns) {
      const protectedTarget = await resolveProtectedTarget(resolve(this.root, pattern));
      if (containsFilePath(protectedTarget, target)) {
        throw new Error(`${candidate} is read-only for agents (protected by "${pattern}").`);
      }
    }
  }

  get describe(): string {
    return [...this.patterns, ...this.roots].join(", ");
  }
}

/**
 * Read the guard from the environment.
 *
 * `FORMICAND_PROTECTED_PATHS` replaces the default patterns wholesale, and an
 * empty value drops them; it cannot unprotect `protectedRoots`.
 */
export function configuredProtectedPaths(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  protectedRoots: readonly string[] = []
): ProtectedPaths {
  const raw = env.FORMICAND_PROTECTED_PATHS;
  const patterns = raw === undefined ? [...DEFAULT_PROTECTED_PATHS] : splitPatterns(raw);
  return new ProtectedPaths({ root, patterns, protectedRoots });
}

function splitPatterns(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The operator preset for project writes.
 *
 * Capabilities are normally granted on the Task, after the work is understood.
 * This is the escape hatch for a run configured ahead of time — a benchmark
 * harness, an unattended job — and it grants nothing unless set, because an
 * ordinary task has no reason to hold permission over the user's code.
 */
export function projectWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FORMICAND_PROJECT_WRITE?.trim();
  if (value === undefined || value === "") return false;
  return value !== "0" && value !== "false";
}
