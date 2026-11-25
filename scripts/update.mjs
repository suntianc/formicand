import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSourceCheckout, updateSource } from "./update-source.mjs";

export function updateHelp() {
  return `Usage: coworkos update [--check]

  --check     Check for a new commit without installing

Source checkouts follow the current branch's Git upstream and rebuild the CLI.
Installed packages are upgraded by installing a newer package by hand.
Configuration, task history and project files are preserved.`;
}

export function parseUpdateOptions(args) {
  const options = { check: false, help: false };
  for (const argument of args) {
    if (["--help", "-h"].includes(argument)) options.help = true;
    else if (argument === "--check") options.check = true;
    else throw new Error(`Unknown update option: ${argument}`);
  }
  return options;
}

export async function runUpdate({
  root,
  args = [],
  onProgress = (message) => console.log(message),
  print = (message) => console.log(message)
}) {
  const options = parseUpdateOptions(args);
  if (options.help) {
    print(updateHelp());
    return;
  }
  if (!(await isSourceCheckout(root)))
    throw new Error("安装包版本没有自动更新；请手动安装新版本，配置和任务记录会保留。");
  const result = await updateSource({ root, target: "cli", check: options.check, onProgress });
  const label = `${result.version}（${result.remoteCommit.slice(0, 7)}）`;
  if (options.check)
    print(result.available ? `发现更新：${label}。运行 coworkos update 安装。` : "当前已是最新版本。");
  else print(result.updated ? `更新完成：${label}。下次启动 coworkos 即使用新版本。` : "当前已是最新版本。");
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runUpdate({ root: fileURLToPath(new URL("..", import.meta.url)), args: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
