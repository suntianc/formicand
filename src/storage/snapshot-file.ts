import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, atomicWriteDurable, syncDirectory } from "./atomic-file.js";

const run = promisify(execFile);
const minCloneBytes = 1024 * 1024;
const blockBytes = 64 * 1024;
const volumes = new Map<number, boolean>();

// A nonzero exit indicates the volume or file cannot use cloning. Other process errors propagate.
async function runCloneCommand(program: string, args: string[]) {
  try {
    await run(program, args);
    return true;
  } catch (error) {
    const { code } = error as { code?: number | string };
    if (typeof code === "number" || code === "ENOENT") return false;
    throw error;
  }
}

async function isApfs(path: string, device: number): Promise<boolean> {
  const cached = volumes.get(device);
  if (cached !== undefined) return cached;
  const apfs = await runCloneCommand("/bin/df", ["-P", "-T", "apfs", dirname(path)]);
  volumes.set(device, apfs);
  return apfs;
}

/** The clone is private to this writer. Compare byte ranges, including changes before an appended tail. */
async function patchClone(file: FileHandle, next: Buffer) {
  const previous = Buffer.allocUnsafe(1024 * 1024);
  for (let start = 0; start < next.length; start += previous.length) {
    const slab = next.subarray(start, start + previous.length);
    const { bytesRead } = await file.read(previous, 0, slab.length, start);
    if (bytesRead === slab.length && slab.equals(previous.subarray(0, bytesRead))) continue;

    // Compare smaller blocks inside a changed slab and coalesce consecutive writes.
    let dirty = 0;
    for (let at = 0; at < slab.length; at += blockBytes) {
      const end = Math.min(at + blockBytes, slab.length);
      if (end > bytesRead || !slab.subarray(at, end).equals(previous.subarray(at, end))) continue;
      await writeRange(file, slab, start, dirty, at);
      dirty = end;
    }
    await writeRange(file, slab, start, dirty, slab.length);
  }
  await file.truncate(next.length);
}

async function writeRange(file: FileHandle, bytes: Buffer, base: number, start: number, end: number) {
  while (start < end) {
    const { bytesWritten } = await file.write(bytes, start, end - start, base + start);
    if (bytesWritten === 0) throw new Error("Snapshot file write made no progress");
    start += bytesWritten;
  }
}

/** Replace a complete snapshot. The live path always contains the original plain JSON format. */
export async function writeJsonSnapshot(
  path: string,
  content: string,
  options?: { mode: number; dirMode: number }
) {
  // All JSON bytes are UTF-8. A small string may still exceed the byte threshold.
  if (process.platform === "darwin" && Buffer.byteLength(content) >= minCloneBytes) {
    const absolute = resolve(path);
    const previous = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      previous?.isFile() &&
      previous.size >= minCloneBytes &&
      previous.uid === process.getuid!() &&
      (previous.mode & 0o600) === 0o600 &&
      (await isApfs(absolute, previous.dev))
    ) {
      const dir = dirname(absolute);
      const staging = await mkdtemp(join(dir, ".snapshot-"));
      const clone = join(staging, "data");
      try {
        // Node 22's copyFile uses a full copy on macOS; cp -c uses clonefile on APFS.
        const cloned = await runCloneCommand("/bin/cp", ["-c", absolute, clone]);
        // The original writer needs only directory write access, even if copying the old file is denied.
        if (!cloned) return await replace();

        const file = await open(clone, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          await file.chmod(options?.mode ?? 0o666 & ~process.umask());
          await patchClone(file, Buffer.from(content));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(clone, absolute);
        if (options) await syncDirectory(dir);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return;
    }
  }
  await replace();

  function replace() {
    return options ? atomicWriteDurable(path, content, options) : atomicWrite(path, content);
  }
}
