import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:net";
import { withFileLock } from "../dist/src/storage/file-lock.js";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import { developmentExecutable } from "./desktop-runtime-helper.js";

test("a blocked cold start shows diagnostics, retries after a port conflict and replaces feedback with the dashboard", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "formicand-startup-window-"));
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  let native;
  try {
    await withFileLock(join(root, "runtime", "backend-lifecycle"), async () => {
      native = await electron.launch({
        executablePath: await developmentExecutable(),
        args: ["--use-mock-keychain", resolve(".")],
        env: {
          ...desktopSmokeEnvironment({ data: root }),
          FORMICAND_DESKTOP_DEV: "1",
          FORMICAND_UI_PORT: String(occupied.address().port)
        }
      });
      await native.evaluate(({ dialog, shell }) => {
        shell.showItemInFolder = (file) => {
          globalThis.openedStartupFile = file;
        };
        const messageBox = dialog.showMessageBox.bind(dialog);
        dialog.showMessageBox = (window, options) => {
          if (options.buttons?.includes("重试")) {
            if (globalThis.startupFixtureClosing) return Promise.resolve({ response: 2 });
            return new Promise((resolve) => {
              globalThis.retryStartup = (response) => resolve({ response });
            });
          }
          if (globalThis.startupFixtureClosing && options.buttons?.includes("仍然退出"))
            return Promise.resolve({ response: options.buttons.indexOf("仍然退出") });
          return messageBox(window, options);
        };
      });
      await expect
        .poll(() =>
          native.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .some((c) => c.getURL().startsWith("data:text/html") && !c.isLoading())
          )
        )
        .toBe(true);
      await native.evaluate(async ({ webContents }) => {
        const status = webContents.getAllWebContents().find((c) => c.getURL().startsWith("data:text/html"));
        const debug = status.debugger;
        debug.attach();
        try {
          const { root } = await debug.sendCommand("DOM.getDocument");
          const { nodeId } = await debug.sendCommand("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: "a"
          });
          const { outerHTML } = await debug.sendCommand("DOM.getOuterHTML", { nodeId: root.nodeId });
          if (!outerHTML.includes("正在连接本地服务")) throw new Error("Missing startup status");
          const { model } = await debug.sendCommand("DOM.getBoxModel", { nodeId });
          const x = (model.content[0] + model.content[4]) / 2;
          const y = (model.content[1] + model.content[5]) / 2;
          for (const type of ["mousePressed", "mouseReleased"])
            await debug.sendCommand("Input.dispatchMouseEvent", {
              type,
              x,
              y,
              button: "left",
              clickCount: 1
            });
        } finally {
          debug.detach();
        }
      });
      await expect
        .poll(() => native.evaluate(() => globalThis.openedStartupFile))
        .toBe(join(root, "logs", "desktop-startup.jsonl"));
    });
    await expect
      .poll(() => native.evaluate(() => Boolean(globalThis.retryStartup)), { timeout: 30_000 })
      .toBe(true);
    await new Promise((resolveClose) => occupied.close(resolveClose));
    await native.evaluate(() => globalThis.retryStartup(0));
    const timingFile = join(root, "logs", "desktop-startup.jsonl");
    await expect.poll(() => readFile(timingFile, "utf8"), { timeout: 30_000 }).toContain('"renderer_loaded"');
    await expect
      .poll(
        () =>
          native.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
              '!!document.querySelector("#composer-input")'
            )
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    await expect
      .poll(() =>
        native.evaluate(
          ({ webContents }) =>
            webContents.getAllWebContents().filter((c) => c.getURL().startsWith("data:text/html")).length
        )
      )
      .toBe(0);
    const rows = (await readFile(timingFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failed = rows.find((r) => r.stage === "startup_failed");
    const loaded = rows.find((r) => r.stage === "renderer_loaded");
    expect(failed.reason).toBe("backend_exited");
    expect(loaded.attempt).not.toBe(failed.attempt);
    expect(rows.filter((r) => r.attempt === loaded.attempt).map((r) => r.stage)).toEqual(
      expect.arrayContaining(["lock_acquired", "backend_spawned", "port_ready", "renderer_connect"])
    );
    const log = await readFile(join(root, "logs", "backend.log"), "utf8");
    expect(
      log
        .split("\n")
        .filter((line) => line.includes(loaded.attempt))
        .map((line) => JSON.parse(line).stage)
    ).toContain("port_listening");
  } finally {
    if (occupied.listening) await new Promise((resolveClose) => occupied.close(resolveClose));
    await native?.evaluate(() => {
      globalThis.startupFixtureClosing = true;
      globalThis.retryStartup?.(2);
    });
    await native?.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
