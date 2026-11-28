import { channel } from "node:diagnostics_channel";
import { type ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { signalProcessGroup } from "../platform/process-group.js";

const run = promisify(execFile);
/**
 * A start time, a conclusive "this PID is not the process" (gone, or owned by
 * an account or integrity level whose start time this user cannot read), or
 * undefined when the query itself failed.
 */
type StartTimeLookup = { startedAt: string } | "gone" | "foreign" | undefined;
const pending = new Map<number, Promise<StartTimeLookup>>();
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

// Formicand launches every Agent as this user, so it can always read their
// start times. Access denied therefore proves that a reused PID now names a
// process this system did not launch, such as a service or an elevated program.
const windowsStartTime = (pid: number) => `
$ErrorActionPreference = 'Stop'
try { $process = [Diagnostics.Process]::GetProcessById(${pid}) } catch [ArgumentException] { 'gone'; exit 0 }
try {
  'started ' + $process.get_StartTime().ToUniversalTime().ToString('o')
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5) { 'foreign' }
  elseif ($process.HasExited) { 'gone' }
  else { throw }
}`;

async function readStartedAt(pid: number): Promise<StartTimeLookup> {
  const started = queryTiming.hasSubscribers ? performance.now() : undefined;
  try {
    if (process.platform === "win32") {
      const { stdout } = await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", windowsStartTime(pid)],
        {
          timeout: 5_000,
          windowsHide: true
        }
      );
      const answer = stdout.trim();
      if (answer === "gone" || answer === "foreign") return answer;
      return answer.startsWith("started ") ? { startedAt: answer.slice("started ".length) } : undefined;
    }
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 5_000,
      // The identity is compared across a backend restart; a changed
      // locale or time zone must not make the same process look like a
      // different one. A backend started from a terminal inherits its
      // TZ, one started from the Dock the system's, and `lstart` prints
      // local time, so it is always read in UTC.
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" }
    });
    const startedAt = stdout.trim();
    return startedAt ? { startedAt } : undefined;
    // eslint-disable-next-line no-restricted-syntax -- 进程可能刚退出或本机没有 ps/powershell；查询失败就是身份暂不可读，由调用方区分进程已结束与暂不可读
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

async function lookupStartedAt(pid: number): Promise<StartTimeLookup> {
  if (!processIsAlive(pid)) return "gone";
  const launched = owned.get(pid);
  if (launched && launched.child.exitCode === null && launched.child.signalCode === null)
    return { startedAt: launched.startedAt };
  let lookup = pending.get(pid);
  if (!lookup) {
    lookup = readStartedAt(pid).finally(() => pending.delete(pid));
    pending.set(pid, lookup);
  }
  return lookup;
}

/** Read the identity of a live process, or nothing when it is gone or unreadable. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  const lookup = await lookupStartedAt(pid);
  return typeof lookup === "object" ? { pid, startedAt: lookup.startedAt } : undefined;
}

const SPAWN_IDENTITY_ATTEMPTS = 3;

/**
 * The parent owns a process handle until exit. Its verified creation time cannot change.
 * Undefined means the child already exited, or its start time stayed unreadable.
 */
export async function identifySpawnedProcess(child: ChildProcess): Promise<ProcessIdentity | undefined> {
  if (child.pid === undefined) return undefined;
  let identity: ProcessIdentity | undefined;
  // The held handle keeps this PID from being reused, so a failed query is only transient.
  for (let attempt = 1; !identity && attempt <= SPAWN_IDENTITY_ATTEMPTS; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) return undefined;
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    identity = await readProcessIdentity(child.pid);
  }
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
  const current = await lookupStartedAt(identity.pid);
  if (current === "gone" || current === "foreign") return false;
  if (current && identity.startedAt) return current.startedAt === identity.startedAt;
  return processIsAlive(identity.pid) ? undefined : false;
}

/** A decision to replace or settle a process requires a conclusive identity check. */
export async function requireProcessIdentityCheck(identity: ProcessIdentity): Promise<boolean> {
  const matches = await matchProcessIdentity(identity);
  if (matches === undefined)
    throw new Error(`Unable to verify the start time of agent process ${identity.pid}`);
  return matches;
}

/** Only a verified match authorizes a signal or an adoption. */
export async function verifyProcessIdentity(identity: ProcessIdentity): Promise<boolean> {
  return (await matchProcessIdentity(identity)) === true;
}
