import { channel } from "node:diagnostics_channel";
import { type ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { signalProcessGroup } from "../platform/process-group.js";

const run = promisify(execFile);
const pending = new Map<number, Promise<string | undefined>>();
const owned = new Map<number, { child: ChildProcess; startedAt: string }>();
const queryTiming = channel("formicand.process-identity.query");

/**
 * Who a pid is, not just that something answers to it.
 *
 * A backend that re-adopts a child after a restart only has the pid it wrote
 * before the restart. A pid alone is not an identity: this host recycles pids,
 * so a live `kill(pid, 0)` can belong to an unrelated program. The OS start
 * time is stable for the lifetime of a process and differs for a later process
 * that reuses the same number, so it is what turns the pid into an identity.
 */
export interface ProcessIdentity {
  pid: number;
  /** The OS-reported process start time, as returned by this host. */
  startedAt: string;
}

/** Whether a process group still has members. Only meaningful for this host. */
export function processGroupIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    signalProcessGroup(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a process number currently exists. Only meaningful for this host. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves the process exists; it belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readStartedAt(pid: number): Promise<string | undefined> {
  const started = queryTiming.hasSubscribers ? performance.now() : undefined;
  try {
    const { stdout } =
      process.platform === "win32"
        ? await run(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
            ],
            { timeout: 5_000, windowsHide: true }
          )
        : await run("ps", ["-p", String(pid), "-o", "lstart="], {
            timeout: 5_000,
            // The identity is compared across a backend restart; a changed
            // locale or time zone must not make the same process look like a
            // different one. A backend started from a terminal inherits its
            // TZ, one started from the Dock the system's, and `lstart` prints
            // local time, so it is always read in UTC.
            env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" }
          });
    const startedAt = stdout.trim();
    return startedAt || undefined;
    // eslint-disable-next-line no-restricted-syntax -- 进程可能刚退出或本机没有 ps/powershell；拿不到启动时间就是无法核对身份，由调用方区分进程已结束与身份暂不可读
  } catch {
    return undefined;
  } finally {
    if (started !== undefined)
      queryTiming.publish({
        started,
        durationMs: performance.now() - started,
        tool: process.platform === "win32" ? "powershell" : "ps"
      });
  }
}

/** Read the identity of a live process, or nothing when it is gone or unreadable. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!processIsAlive(pid)) return undefined;
  const launched = owned.get(pid);
  if (launched && launched.child.exitCode === null && launched.child.signalCode === null)
    return { pid, startedAt: launched.startedAt };
  let lookup = pending.get(pid);
  if (!lookup) {
    lookup = readStartedAt(pid).finally(() => pending.delete(pid));
    pending.set(pid, lookup);
  }
  const startedAt = await lookup;
  return startedAt ? { pid, startedAt } : undefined;
}

/** The parent owns a process handle until exit. Its verified creation time cannot change. */
export async function identifySpawnedProcess(child: ChildProcess): Promise<ProcessIdentity | undefined> {
  if (child.pid === undefined) return undefined;
  const identity = await readProcessIdentity(child.pid);
  if (identity && child.exitCode === null && child.signalCode === null) {
    const entry = { child, startedAt: identity.startedAt };
    owned.set(identity.pid, entry);
    child.once("exit", () => {
      if (owned.get(identity.pid) === entry) owned.delete(identity.pid);
    });
  }
  return identity;
}

/** Undefined means the PID still exists but its start time could not be read. */
export async function matchProcessIdentity(identity: ProcessIdentity): Promise<boolean | undefined> {
  const current = await readProcessIdentity(identity.pid);
  if (current && identity.startedAt) return current.startedAt === identity.startedAt;
  return processIsAlive(identity.pid) ? undefined : false;
}

/** Only a verified match authorizes a signal or an adoption. */
export async function verifyProcessIdentity(identity: ProcessIdentity): Promise<boolean> {
  return (await matchProcessIdentity(identity)) === true;
}
