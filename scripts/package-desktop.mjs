import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function desktopPackagingArgs(mode, platform, arch) {
  if (!["pack", "dist"].includes(mode)) throw new Error("Choose pack or dist");
  const targets = { darwin: ["mac", "arm64"], win32: ["win", "x64"], linux: ["linux", "x64"] };
  const target = targets[platform];
  if (!target || arch !== target[1]) throw new Error(`Unsupported desktop build host: ${platform}/${arch}`);
  const [os] = target;
  if (mode === "dist" && os === "mac") return ["scripts/package-mac.mjs"];
  return [
    "node_modules/electron-builder/cli.js",
    "--config",
    `electron-builder.${os}.cjs`,
    `--${os}`,
    `--${arch}`,
    ...(mode === "pack" ? ["--dir"] : []),
    "--publish",
    "never"
  ];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  execFileSync(process.execPath, desktopPackagingArgs(process.argv[2], process.platform, process.arch), {
    stdio: "inherit"
  });
}
