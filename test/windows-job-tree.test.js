import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";

test(
  "Windows tree stop requires a readable identity until the process exits",
  {
    skip: process.platform !== "win32"
  },
  async (t) => {
    // Keep the real PowerShell process object and handle. A scripted property lets
    // the child exit at the exact identity read, without racing a wall-clock timer.
    let readStartTime = "$null";
    const execFile = childProcess.execFile;
    childProcess.execFile = (file, args, ...rest) => {
      const prelude = `Update-TypeData -TypeName System.Diagnostics.Process -MemberType ScriptProperty -MemberName StartTime -Value { ${readStartTime} } -Force`;
      return execFile(file, [...args.slice(0, -1), prelude + "\n" + args.at(-1)], ...rest);
    };
    syncBuiltinESMExports();
    const tree = await import("../dist/src/platform/windows-job-tree.js?missing-start-time").finally(() => {
      childProcess.execFile = execFile;
      syncBuiltinESMExports();
    });
    const start = "2000-01-01T00:00:00.0000000Z";
    for (const stop of [
      (pid) => tree.stopRecordedWindowsTree(pid, start),
      (pid) => tree.stopWindowsJobTree(pid, 0, Date.now())
    ]) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        windowsHide: true
      });
      const exited = once(child, "exit");
      t.after(async () => {
        child.kill();
        await exited;
      });
      await once(child, "spawn");
      await assert.rejects(
        tree.stopRecordedWindowsTree(child.pid, "unknown"),
        /Invalid Windows job identity/
      );
      readStartTime = "$null";
      await assert.rejects(stop(child.pid), /FullyQualifiedErrorId\s*:\s*Unable to verify the start time/);
      assert.doesNotThrow(() => process.kill(child.pid, 0));
      readStartTime = "$this.Kill(); $this.WaitForExit(); $null";
      await stop(child.pid);
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      await exited;
      await stop(child.pid);
    }
  }
);
