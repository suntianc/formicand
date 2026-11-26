import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

// The Node-API module uses stable C symbols supplied by Electron at load time.
if (process.platform === "darwin") {
  const output = "dist/desktop";
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(output, ".motion-"));
  try {
    const binary = join(staging, "motion.node");
    execFileSync(
      "/usr/bin/xcrun",
      [
        "clang++",
        "-std=c++17",
        "-O2",
        "-fobjc-arc",
        "-mmacosx-version-min=14.0",
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        "-framework",
        "AppKit",
        "-framework",
        "QuartzCore",
        "-I",
        resolve(process.execPath, "../../include/node"),
        "desktop/motion.mm",
        "-o",
        binary
      ],
      { stdio: "inherit" }
    );
    renameSync(binary, join(output, "motion.node"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
