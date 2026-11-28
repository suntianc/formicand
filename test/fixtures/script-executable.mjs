import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectCheckShell } from "../../dist/src/platform/project-shell.js";

const run = promisify(execFile);
let runner;

async function buildRunner() {
  const root = await mkdtemp(join(tmpdir(), "formicand-test-shim-"));
  const output = join(root, "fixture.exe");
  const compiler = join(process.env.SystemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
  try {
    await run(
      compiler,
      [
        "/nologo",
        "/target:exe",
        `/out:${output}`,
        fileURLToPath(new URL("./shell-command.cs", import.meta.url))
      ],
      { windowsHide: true }
    );
    return await readFile(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Create a command that child_process can launch directly on the current OS. */
export async function shellExecutable(path, script) {
  if (process.platform !== "win32") {
    await writeFile(path, script);
    await chmod(path, 0o755);
    return path;
  }
  runner ??= buildRunner();
  const executable = path + ".exe";
  await writeFile(executable, await runner);
  await writeFile(path + ".sh", script);
  await writeFile(path + ".shell", projectCheckShell());
  return executable;
}
