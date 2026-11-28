import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Check private fixture files using the host's permission model. */
export async function assertPrivateFile(path) {
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    return;
  }
  // Windows inherits the profile directory's ACL. Its POSIX mode bits cannot
  // distinguish a private file from one that any local user can read.
  const script = `
    $ErrorActionPreference = 'Stop'
    $acl = Get-Acl -LiteralPath $env:TEST_PRIVATE_FILE
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    $rules | Where-Object {
      $_.AccessControlType -eq 'Allow' -and
      $_.IdentityReference.Value -in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') -and
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)
    } | ForEach-Object { $_.IdentityReference.Value }
  `;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, TEST_PRIVATE_FILE: path }
  });
  assert.equal(stdout.trim(), "", "the private file grants another group read access");
}
