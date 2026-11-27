import type { ChildProcess } from "node:child_process";

export const usesProcessGroups = process.platform !== "win32";

/** Signal the group created at launch, or the individual child on Windows. */
export function signalProcessGroup(target: number | ChildProcess, signal: NodeJS.Signals | 0): void {
  const pid = typeof target === "number" ? target : target.pid;
  if (typeof target !== "number" && (!usesProcessGroups || pid === undefined)) {
    target.kill(signal);
    return;
  }
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("Invalid process id");
  process.kill(usesProcessGroups ? -pid : pid, signal);
}
