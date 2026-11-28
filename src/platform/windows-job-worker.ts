import { spawn } from "node:child_process";

// A detached Node process survives the launching Agent. It starts the actual
// command with piped stdio so Windows gives neither the shell nor its children
// a console. The worker's own stdout and stderr are the durable job log.
process.once("message", (input: { command: string; shell: boolean }) => {
  function report(error?: NodeJS.ErrnoException) {
    if (error) process.exitCode = 1;
    if (process.connected)
      process.send?.(error ? { message: error.message, code: error.code } : { started: true }, () => {
        if (process.connected) process.disconnect();
      });
  }
  try {
    const command = spawn(input.command, {
      shell: input.shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    command.once("error", report);
    command.once("spawn", () => report());
    command.stdout.pipe(process.stdout, { end: false });
    command.stderr.pipe(process.stderr, { end: false });
    command.once("close", (code) => {
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    report(error instanceof Error ? error : new Error(String(error)));
  }
});
