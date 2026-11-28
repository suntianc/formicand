import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function directoryPickerCommand(platform: NodeJS.Platform): [string, string[]] {
  switch (platform) {
    case "darwin":
      return [
        "/usr/bin/osascript",
        [
          "-e",
          'try\nreturn POSIX path of (choose folder with prompt "选择 Formicand 工作空间")\non error number -128\nreturn ""\nend try'
        ]
      ];
    case "win32":
      return [
        "powershell.exe",
        [
          "-NoProfile",
          "-STA",
          "-Command",
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择 Formicand 工作空间"; if ($picker.ShowDialog() -eq "OK") { Write-Output $picker.SelectedPath }; $picker.Dispose()'
        ]
      ];
    default:
      return ["zenity", ["--file-selection", "--directory", "--title=选择 Formicand 工作空间"]];
  }
}

/** Empty selection means the user dismissed the system picker. */
export async function pickDirectory(platform = process.platform, run = execute): Promise<string | undefined> {
  const [command, args] = directoryPickerCommand(platform);
  try {
    const { stdout } = await run(command, args, { encoding: "utf8", windowsHide: true });
    return stdout.trim() || undefined;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (command === "zenity" && code === 1) return undefined;
    if (command === "zenity" && code === "ENOENT")
      throw new Error("未找到 zenity，请安装系统文件夹选择器或使用桌面版");
    throw new Error("无法打开系统文件夹选择器，请重试或使用桌面版", { cause: error });
  }
}
