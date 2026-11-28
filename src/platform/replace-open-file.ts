import { execFile, execFileSync } from "node:child_process";
import { join, toNamespacedPath } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Win32's extended rename lets a reader finish with its original handle while
// new opens see the replacement. Both names stay intact on a failed request.
const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class FileRename {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, byte[] data, uint length);
    public static void Replace(string source, string destination) {
        using (var file = CreateFileW(source, 0x10000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (file.IsInvalid) throw new Win32Exception();
            var name = Encoding.Unicode.GetBytes(destination);
            // FILE_RENAME_INFO: Flags, aligned HANDLE, byte length, then UTF-16 name.
            int lengthOffset = 2 * IntPtr.Size;
            var data = new byte[lengthOffset + 4 + name.Length];
            BitConverter.GetBytes(3).CopyTo(data, 0); // REPLACE_IF_EXISTS | POSIX_SEMANTICS
            BitConverter.GetBytes(name.Length).CopyTo(data, lengthOffset);
            name.CopyTo(data, lengthOffset + 4);
            if (!SetFileInformationByHandle(file, 22, data, (uint)data.Length)) throw new Win32Exception();
        }
    }
}
'@
[FileRename]::Replace($env:FORMICAND_RENAME_SOURCE, $env:FORMICAND_RENAME_DESTINATION)
`;

export function isWindowsSharingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

function command(source: string, destination: string) {
  const root = process.env.SystemRoot;
  if (!root) throw new Error("SystemRoot is required to replace an open file");
  const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const options = {
    windowsHide: true,
    env: {
      ...process.env,
      FORMICAND_RENAME_SOURCE: toNamespacedPath(source),
      FORMICAND_RENAME_DESTINATION: toNamespacedPath(destination)
    }
  };
  return [executable, ["-NoProfile", "-NonInteractive", "-Command", script], options] as const;
}

export async function replaceOpenFile(source: string, destination: string, original: unknown): Promise<void> {
  // Preserve fs.rename's syscall, paths and errno when the filesystem still refuses the replacement.
  const [file, args, options] = command(source, destination);
  await run(file, args, options).catch(() => {
    throw original;
  });
}

export function replaceOpenFileSync(source: string, destination: string, original: unknown): void {
  const [file, args, options] = command(source, destination);
  try {
    execFileSync(file, args, { ...options, stdio: "pipe" });
  } catch (cause) {
    if (original instanceof Error) original.cause = cause instanceof Error ? cause.name : cause;
    throw original;
  }
}
