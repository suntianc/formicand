import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import { dismissModelSetup } from "./model-provider-ui.js";

test("桌面版用本机应用打开产物，并且只接受后端解析到的本地文件和列出的应用", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "atria-p46-artifact-desktop-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|EXA_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    PI_OFFLINE: "1"
  });
  let native;
  try {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 90_000
    });
    const page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toBeAttached();
    await dismissModelSetup(page, { wait: 5_000 });

    // The host authorizes the renderer's requests once the selected backend is up.
    const created = await page.evaluate(async () => {
      const headers = { "content-type": "application/json" };
      const nonce = window.bookmanDesktop?.transportNonce;
      if (nonce) headers["x-cowork-desktop-nonce"] = nonce;
      let response;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        response = await fetch("/api/tasks", {
          method: "POST",
          headers,
          body: JSON.stringify({ taskId: "desktop-artifact", goal: "桌面产物验收" })
        });
        if (response.status !== 401) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      const text = await response.text();
      const detail = await fetch("/api/tasks/desktop-artifact", {
        headers: nonce ? { "x-cowork-desktop-nonce": nonce } : {}
      });
      return {
        status: response.status,
        body: text,
        detailStatus: detail.status,
        detail: await detail.text()
      };
    });
    expect(created.status, created.body).toBeLessThan(300);
    expect(created.detailStatus, created.detail).toBe(200);
    const storageRoot = JSON.parse(created.detail).storageRoot;
    const artifacts = join(storageRoot, "desktop-artifact", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "报告.md"), "# 桌面产物\n");

    // Record what the host hands to the system instead of launching an application.
    await native.evaluate(({ shell }) => {
      globalThis.openedPaths = [];
      globalThis.revealedPaths = [];
      shell.openPath = async (target) => {
        globalThis.openedPaths.push(target);
        return "";
      };
      shell.showItemInFolder = (target) => {
        globalThis.revealedPaths.push(target);
      };
    });

    // The sidebar picks the new conversation up on its next catalog poll.
    await page.locator('button[data-task="desktop-artifact"]').click({ timeout: 20_000 });
    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");
    await expect(panel.locator('[data-artifact="报告.md"]')).toBeVisible();
    await panel.locator('[data-artifact="报告.md"]').click();
    const drawer = page.locator("#artifact-drawer");
    await expect(drawer).toBeVisible();
    const openMain = drawer.locator("[data-open-main]");
    await expect(openMain).toBeVisible();
    // A long name on a narrow drawer shortens the title; the actions stay on one row.
    const rows = await drawer.evaluate((node) => {
      node.style.width = "520px";
      node.querySelector(".artifact-drawer-title strong").textContent = "名".repeat(80);
      const top = (selector) => Math.round(node.querySelector(selector).getBoundingClientRect().top);
      return { open: top("[data-open-main]"), close: top("[data-close-drawer]") };
    });
    expect(Math.abs(rows.open - rows.close)).toBeLessThan(12);
    await drawer.evaluate((node) => node.style.removeProperty("width"));
    await openMain.click();
    // The main button stays fixed to Finder; the backend resolves the real path.
    const expectedFile = await realpath(join(artifacts, "报告.md"));
    await expect
      .poll(async () => (await native.evaluate(() => globalThis.revealedPaths)).map((path) => path))
      .toEqual([expectedFile]);

    // The arrow lists this Mac's applications for the file; the default one
    // goes through the system as well.
    const more = drawer.locator("[data-open-more]");
    await expect(more).toBeEnabled({ timeout: 15_000 });
    await more.click();
    const menu = page.locator(".open-with-menu");
    await expect(menu).toBeVisible({ timeout: 15_000 });
    await expect(menu.getByRole("menuitem", { name: "默认应用" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "默认应用" }).click();
    await expect.poll(async () => (await native.evaluate(() => globalThis.openedPaths)).length).toBe(1);

    // A path the backend cannot resolve, or an application the host did not
    // list for the file, is refused, not opened.
    const refused = await page.evaluate(async () => {
      const attempt = async (target, appId) => {
        try {
          await window.bookmanDesktop.files.open("desktop-artifact", target, appId);
          return "opened";
        } catch (error) {
          return error.message;
        }
      };
      return [
        await attempt({ source: "artifact", path: "../../config.json" }),
        await attempt({ source: "artifact", path: "报告.md" }, "/System/Applications/Calculator.app"),
        await attempt({ source: "elsewhere", path: "报告.md" })
      ];
    });
    for (const outcome of refused) expect(outcome).not.toBe("opened");
    expect(await native.evaluate(() => globalThis.openedPaths)).toHaveLength(1);
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
