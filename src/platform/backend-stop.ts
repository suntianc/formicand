import { unwatchFile, watchFile } from "node:fs";
import { rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Instance = { pid: number; startedAt: string };

function runningFile(directory: string, instance: Instance): string {
  return join(directory, `backend-${instance.pid}-${Date.parse(instance.startedAt)}.running`);
}

// SIGTERM kills immediately on Windows. Removing this instance's marker asks the daemon
// to run its normal teardown before the controller's existing shutdown deadline.
export async function observeBackendStop(directory: string, instance: Instance, stop: () => void) {
  if (process.platform !== "win32") return;
  const file = runningFile(directory, instance);
  await writeFile(file, "", { mode: 0o600 });
  watchFile(file, { interval: 250, persistent: false }, (current) => {
    if (current.nlink === 0) stop();
  });
  return async () => {
    unwatchFile(file);
    await rm(file, { force: true });
  };
}

export async function clearBackendStop(directory: string, instance: Instance): Promise<void> {
  if (process.platform === "win32") await rm(runningFile(directory, instance), { force: true });
}

export async function requestBackendStop(directory: string, instance: Instance): Promise<void> {
  if (process.platform === "win32") {
    try {
      await unlink(runningFile(directory, instance));
      return;
    } catch (error) {
      // Older backends only support the existing signal-based stop.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    process.kill(instance.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
