import { expect } from "@playwright/test";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { developmentExecutable as brandExecutable } from "../scripts/desktop-dev.mjs";

/**
 * The branded Electron runtime is sealed with the generated app icon, so a desktop
 * test that starts from a clean checkout needs `build/formicand.icns` before it can launch.
 * `npm run test:browser` builds it first; a bare `npx playwright test` does not.
 * Resolving the runtime through this helper keeps both entries at one precondition
 * instead of failing on a missing generated file.
 */
export function ensureDesktopIcon() {
  if (process.platform !== "darwin" || existsSync("build/formicand.icns")) return;
  execFileSync(process.execPath, ["scripts/build-desktop-icon.mjs"], { stdio: "inherit" });
}

export async function developmentExecutable(options) {
  ensureDesktopIcon();
  return brandExecutable(options);
}

/** A slow boot also creates a transient diagnostics WebContentsView. Wait for the real backend page. */
export async function dashboardWindow(native) {
  const dashboard = () => native.windows().find((page) => page.url().startsWith("http://127.0.0.1:"));
  await expect.poll(() => Boolean(dashboard()), { timeout: 90000 }).toBe(true);
  return dashboard();
}

/** The resident backend outlives Electron. Wait for the client process itself, not driver pipe closure. */
export function desktopExit(native) {
  const client = native.process();
  return client.exitCode !== null || client.signalCode !== null
    ? Promise.resolve()
    : once(client, "exit", { signal: AbortSignal.timeout(30000) });
}

export async function quitDesktop(native) {
  if (!native || native.process().exitCode !== null || native.process().signalCode !== null) return;
  await Promise.all([
    desktopExit(native),
    native.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    })
  ]);
}
