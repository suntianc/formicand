import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readProcessIdentity } from "../../dist/src/runtime/process-identity.js";
import { stopRecordedWindowsTree } from "../../dist/src/platform/windows-job-tree.js";

const run = promisify(execFile);

/** Observe real processes whose command line identifies this disposable workspace. */
export async function fixtureMainProcesses(root, marker = "", groupsOnly = false) {
  if (process.platform === "win32") {
    const query = `
      $ErrorActionPreference = 'Stop'
      $rows = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($env:TEST_MAIN_ROOT) -and
          (!$env:TEST_MAIN_MARKER -or $_.CommandLine.Contains($env:TEST_MAIN_MARKER))
      })
      $matched = @($rows | ForEach-Object { $_.ProcessId })
      foreach ($row in $rows) {
        if ($env:TEST_MAIN_GROUPS -eq '1' -and $matched -contains $row.ParentProcessId) { continue }
        $process = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.StartTime) {
          "$($row.ProcessId) $($process.StartTime.ToUniversalTime().ToString('o'))"
        }
      }`;
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
      windowsHide: true,
      env: {
        ...process.env,
        TEST_MAIN_ROOT: root,
        TEST_MAIN_MARKER: marker,
        TEST_MAIN_GROUPS: groupsOnly ? "1" : "0"
      }
    });
    return stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [pid, startedAt] = line.split(" ");
        return { pid: Number(pid), startedAt };
      });
  }
  const { stdout } = await run("ps", ["-ax", "-o", "pid=,pgid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout
    .split("\n")
    .filter((line) => line.includes(root) && line.includes(marker))
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, pgid]) => /^\d+$/.test(pid) && Number(pid) > 0 && (!groupsOnly || pid === pgid))
    .map(([pid]) => ({ pid: Number(pid) }));
}

export async function killFixtureMain({ pid, startedAt }) {
  if (process.platform === "win32") await stopRecordedWindowsTree(pid, startedAt);
  else process.kill(-pid, "SIGKILL");
}

/** A child spawned by this test holds its PID until Node observes its exit. */
export async function killFixtureChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const identity = await readProcessIdentity(child.pid);
    if (identity && child.exitCode === null && child.signalCode === null) await killFixtureMain(identity);
  } else await killFixtureMain({ pid: child.pid });
}
