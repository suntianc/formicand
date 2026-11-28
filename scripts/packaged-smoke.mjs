import assert from "node:assert/strict";
import { dashboardWindow, quitDesktop } from "../e2e/desktop-runtime-helper.js";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect } from "@playwright/test";
import { desktopSmokeEnvironment } from "./desktop-smoke-env.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

const layouts = {
  darwin: ["mac-arm64/Formicand.app", "Contents/MacOS/Formicand", "Contents/Resources/app"],
  win32: ["win-unpacked", "Formicand.exe", "resources/app"],
  linux: ["linux-unpacked", "formicand", "resources/app"]
};

export async function runPackagedSmoke() {
  const layout = layouts[process.platform];
  if (!layout) throw new Error(`Unsupported desktop smoke platform: ${process.platform}`);
  const [directory, executable, application] = layout;
  const candidate = resolve(process.env.FORMICAND_DESKTOP_APP || join(".tmp/release", directory));
  const executablePath = join(candidate, executable);
  const appRoot = await realpath(join(candidate, application));
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const root = await mkdtemp(join(tmpdir(), "formicand-dir-smoke-"));
  const data = join(root, "data");
  const project = join(root, "project");
  const env = desktopSmokeEnvironment({ data });
  let native;
  try {
    await mkdir(project);
    await writeFile(join(project, "package-probe.txt"), "formicand native search marker");
    // Use the packaged Electron ABI and resolve FFF relative to the packaged application.
    await promisify(execFile)(
      executablePath,
      [join(import.meta.dirname, "smoke-packaged-search.mjs"), appRoot, project],
      {
        cwd: project,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 45000
      }
    );
    let firstBackend;
    for (const attempt of [1, 2]) {
      const start = performance.now();
      native = await electron.launch({
        executablePath,
        env,
        args: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
        timeout: 90000
      });
      const identity = await native.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        version: app.getVersion(),
        path: app.getAppPath()
      }));
      assert.equal(identity.packaged, true);
      assert.equal(identity.version, version);
      assert.equal(await realpath(identity.path), appRoot);
      const page = await dashboardWindow(native);
      await expect(page.locator("#composer-input")).toBeAttached({ timeout: 90000 });
      let backend;
      await expect
        .poll(
          async () => {
            const result = await page.evaluate(async () => {
              const response = await fetch("/api/backend", {
                headers: { "x-formicand-desktop-nonce": window.formicandDesktop.transportNonce }
              });
              if (!response.ok) return { status: response.status };
              const { backendId, pid } = await response.json();
              return {
                status: response.status,
                backend: { backendId, pid, displayedVersion: window.formicandDesktop.version }
              };
            });
            backend = result.backend;
            return result.status;
          },
          { timeout: 90000 }
        )
        .toBe(200);
      assert.ok(backend.backendId && Number.isInteger(backend.pid));
      assert.equal(backend.displayedVersion, version);
      if (attempt === 1) firstBackend = backend;
      else assert.deepEqual(backend, firstBackend);
      console.log(
        JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          attempt,
          version,
          backendReadyMs: Math.round(performance.now() - start)
        })
      );
      await quitDesktop(native);
      native = undefined;
    }
    assert.equal(firstBackend.displayedVersion, version, "Version exposed by the installed app");
    console.log(
      "Packaged desktop smoke passed: FFF filename/content search, version, backend connection and reconnect."
    );
  } finally {
    try {
      await quitDesktop(native);
    } finally {
      await stopNativeBackend(data);
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}
