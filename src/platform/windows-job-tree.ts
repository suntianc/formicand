import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Running job records are written immediately after spawn and only replaced on exit. */
export async function stopWindowsJobTree(pid: number, launchMs: number, recordedMs: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(launchMs) || !Number.isFinite(recordedMs)) {
    throw new Error("Invalid Windows job identity");
  }
  await stopTree(
    pid,
    `$birth = ([DateTimeOffset]$startTime).ToUnixTimeMilliseconds()
      if ($birth -lt ${launchMs} -or $birth -gt ${Math.ceil(recordedMs)}) {
        throw 'The PID does not belong to the recorded job'
      }`
  );
}

/** An adopted Agent has a precise OS start time. A mismatch means it already ended. */
export async function stopRecordedWindowsTree(pid: number, startedAt: string): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(startedAt))
    throw new Error("Invalid Windows job identity");
  await stopTree(pid, `if ($startTime.ToUniversalTime().ToString('o') -cne '${startedAt}') { exit 0 }`);
}

async function stopTree(pid: number, checkIdentity: string): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SystemRoot is required to stop a Windows job");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Pin the process handle through taskkill so the PID cannot be recycled between
  // checking the launch window and asking Windows to terminate its descendants.
  const script = `
    $ErrorActionPreference = 'Stop'
    try { $job = [Diagnostics.Process]::GetProcessById(${pid}) }
    catch [ArgumentException] { exit 0 }
    try {
      try {
        $handle = $job.Handle
        if ($null -eq $handle -or $handle -eq [IntPtr]::Zero) { throw 'Unable to open a Windows process handle' }
        $startTime = $job.StartTime
        if ($null -eq $startTime) { throw 'Unable to verify the start time of the Windows process' }
      } catch {
        # Formicand's own processes run as this user. Access denied means the PID was reused.
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5) { exit 0 }
        if ($job.HasExited) { exit 0 }
        throw
      }
      if ($job.HasExited) { exit 0 }
      ${checkIdentity}
      & "$env:SystemRoot\\System32\\taskkill.exe" /PID ${pid} /T /F
      if ($LASTEXITCODE -eq 128 -and $job.HasExited) { exit 0 }
      exit $LASTEXITCODE
    } finally { $job.Dispose() }
  `;
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}
