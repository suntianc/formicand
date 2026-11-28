import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";

// Linux development checkouts may provide their own Node runtime.
if (process.platform === "linux" && process.arch === "x64") {
  const bundled = resolve(".tools/node-v22.19.0-linux-x64/bin/node");
  const available = await access(bundled, constants.X_OK).then(
    () => true,
    (error) => {
      if (["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) return false;
      throw error;
    }
  );
  if (available) process.execve(bundled, [bundled, resolve("dist/src/cli/dashboard.js")], process.env);
}
await import("../dist/src/cli/dashboard.js");
