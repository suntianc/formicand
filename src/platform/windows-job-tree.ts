import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Running job records are written immediately after spawn and only replaced on exit. */
export async function stopWindowsJobTree(pid: number, launchMs: number, recordedMs: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(launchMs) || !Number.isFinite(recordedMs)) {
    throw new Error("Invalid Windows job identity");
  }
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
      $null = $job.Handle
      $birth = ([DateTimeOffset]$job.StartTime).ToUnixTimeMilliseconds()
      if ($birth -lt ${launchMs} -or $birth -gt ${Math.ceil(recordedMs)}) {
        throw 'The PID does not belong to the recorded job'
      }
      if ($job.HasExited) { exit 0 }
      & "$env:SystemRoot\\System32\\taskkill.exe" /PID ${pid} /T /F
      if ($LASTEXITCODE -eq 128 -and $job.HasExited) { exit 0 }
      exit $LASTEXITCODE
    } finally { $job.Dispose() }
  `;
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}
