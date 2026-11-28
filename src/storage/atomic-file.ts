import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isWindowsSharingError,
  replaceOpenFile,
  replaceOpenFileSync
} from "../platform/replace-open-file.js";

async function replaceFile(temporary: string, path: string): Promise<void> {
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!isWindowsSharingError(error)) throw error;
    await replaceOpenFile(temporary, path, error);
  }
}

/**
 * Durable small-file writes for runtime state.
 *
 * One implementation on purpose: the temporary name carries a process id,
 * timestamp and random suffix, and the bytes are synced before the rename, so
 * two writes in the same millisecond cannot collide and a crash cannot leave a
 * valid rename pointing at an empty file.
 */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  options?: { mode?: number; exclusive?: boolean }
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = await open(temporary, "wx", options?.mode);
  try {
    try {
      if (options?.mode !== undefined) await handle.chmod(options.mode);
      await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options?.exclusive) await link(temporary, path);
    else await replaceFile(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The same guarantee for a caller that cannot await.
 *
 * A synchronous constructor (for example the local access policy, which must
 * publish a credential before it serves its first request) still gets the
 * temp-file-then-rename write: a crash mid-write leaves the previous file, and
 * a tear can never publish a half-written credential.
 */
export function atomicWriteSync(path: string, content: string, options?: { mode?: number }): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const descriptor = openSync(temporary, "wx", options?.mode);
  try {
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, path);
    } catch (error) {
      if (!isWindowsSharingError(error)) throw error;
      replaceOpenFileSync(temporary, path, error);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Flush directory metadata (rename / unlink entries) to stable storage.
 * On POSIX every failure propagates so callers never remove a sidecar or
 * archive a recovery journal before the replacement file's directory entry is durable.
 */
export async function syncDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomically replace a file and sync both its data and parent directory metadata.
 */
export async function atomicWriteDurable(
  path: string,
  content: string,
  options?: { mode?: number; dirMode?: number }
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, ...(options?.dirMode !== undefined ? { mode: options.dirMode } : {}) });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", options?.mode);
    try {
      if (options?.mode !== undefined) await handle.chmod(options.mode);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temporary, path);
    await syncDirectory(dir);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Remove a file if present and sync its parent directory metadata.
 */
export async function durableRemove(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return;
    throw error;
  });
}
