import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { addProviderThroughUi, leaveSettings, setupDialog } from "./model-provider-ui.js";

test("running conversation plays the ring and working ant in the desktop window and releases them when covered", async () => {
  test.skip(process.platform !== "darwin", "Core Animation requires macOS");
  test.setTimeout(120000);
  const bundle = process.env.FORMICAND_DESKTOP_APP;
  if (!bundle) execFileSync(process.execPath, ["scripts/build-desktop-motion.mjs"]);
  const root = await mkdtemp(join(tmpdir(), "formicand-native-motion-"));
  const probe = join(root, "motion-probe.node");
  execFileSync("/usr/bin/xcrun", [
    "clang++",
    "-std=c++17",
    "-fobjc-arc",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-I",
    resolve(process.execPath, "../../include/node"),
    "-framework",
    "AppKit",
    "-framework",
    "QuartzCore",
    "test/fixtures/motion-probe.mm",
    "-o",
    probe
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:FORMICAND_|PI_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(key)
    )
  );
  Object.assign(env, {
    FORMICAND_HOME: join(root, "home"),
    FORMICAND_DESKTOP_DATA: root,
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1",
    FORMICAND_DISABLE_SESSION_TITLES: "1",
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1"
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const provider = await modelProtocolFixture("openai-completions", async () => {
    await held;
    return { text: "完成。" };
  });
  let app;
  try {
    app = await electron.launch({
      executablePath: bundle ? join(bundle, "Contents/MacOS/Formicand") : await developmentExecutable(),
      args: ["--use-mock-keychain", ...(bundle ? [] : [resolve(".")])],
      env
    });
    const page = await app.firstWindow();
    await expect(setupDialog(page)).toBeVisible();
    await addProviderThroughUi(page, {
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      model: "protocol-fixture"
    });
    await leaveSettings(page);
    await page.locator("#new-project").click();
    await page.locator("#add-project-name").fill("动效验收");
    await page.locator("#add-project-directory").fill(root);
    await page.locator("#add-project-submit").click();
    await expect(page.locator("#add-project-modal")).toBeHidden();
    await page.locator("#composer-input").fill("运行测试");
    await page.locator("#send-button").click();
    const ring = page.locator("formicand-spinner.conversation-activity").first();
    const ant = page.locator(".thinking-spinner.ant-mark").last();
    await expect(ring).toHaveAttribute("data-native-motion", "ring");
    await expect(ant).toHaveAttribute("data-native-motion", "ant");
    expect(await ant.locator(".ant-frames").evaluate((e) => e.getAnimations()[0].playState)).toBe("paused");
    const presentation = () =>
      app.evaluate(({ BrowserWindow }, path) => {
        const inspect = process.getBuiltinModule("module").createRequire(path)(path);
        return JSON.parse(inspect(BrowserWindow.getAllWindows()[0].getNativeWindowHandle()));
      }, probe);
    const shimmer = page.locator(".shimmer-text").last();
    await expect(shimmer).toHaveCSS("background-size", "250% 100%");
    await expect(shimmer).not.toHaveAttribute("data-native-motion", /.+/);
    const before = await presentation();
    const ringLayer = before.find((layer) => layer.spin);
    const antLayer = before.find((layer) => layer.sprite);

    const box = await ring.boundingBox();
    expect(Math.abs(ringLayer.x - box.x)).toBeLessThan(1);
    expect(Math.abs(ringLayer.y - box.y)).toBeLessThan(1);
    expect(antLayer.hasImage).toBe(true);
    await expect
      .poll(async () =>
        (await presentation()).some((layer) => layer.spin && Math.abs(layer.angle - ringLayer.angle) > 0.3)
      )
      .toBe(true);
    await expect
      .poll(async () =>
        (await presentation()).some((layer) => layer.sprite && layer.frame !== antLayer.frame)
      )
      .toBe(true);
    await ring.evaluate((host) => {
      const rect = host.getBoundingClientRect();
      const strip = document.createElement("div");
      strip.id = "motion-cover-strip";
      strip.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;background:white;left:${rect.x + rect.width / 2}px;top:${rect.y}px;width:2px;height:${rect.height}px`;
      document.body.append(strip);
    });
    await expect(ring).not.toHaveAttribute("data-native-motion", "ring");
    await page.locator("#motion-cover-strip").evaluate((node) => node.remove());
    await expect(ring).toHaveAttribute("data-native-motion", "ring");
    await page.evaluate(() => {
      const cover = document.createElement("dialog");
      cover.id = "motion-test-cover";
      cover.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;margin:0;max-width:none;max-height:none";
      document.body.append(cover);
      cover.showModal();
    });
    await expect(ring).not.toHaveAttribute("data-native-motion", "ring");
    await expect(ant).not.toHaveAttribute("data-native-motion", "ant");
    await page.locator("#motion-test-cover").evaluate((e) => e.remove());
    await expect(ring).toHaveAttribute("data-native-motion", "ring");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(ring).not.toHaveAttribute("data-native-motion", "ring");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(ring).toHaveAttribute("data-native-motion", "ring");
    // A wheel hands the ring to the page at once; the hidden layer comes back after.
    await page.mouse.move(box.x + 100, box.y);
    await page.mouse.wheel(0, 40);
    await expect(ring).not.toHaveAttribute("data-native-motion", "ring");
    await expect(ring).toHaveAttribute("data-native-motion", "ring");
    // The layers follow the top edge when the window changes height.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width, height - 120);
    });
    await expect
      .poll(async () => {
        const now = await ring.boundingBox();
        const layer = (await presentation()).find((entry) => entry.spin);
        return Boolean(layer) && Math.abs(layer.x - now.x) < 1 && Math.abs(layer.y - now.y) < 1;
      })
      .toBe(true);
    release();
    await expect(ring).toHaveCount(0);
    await expect(page.locator("#conversation")).toContainText("完成。");
    await expect.poll(presentation).toEqual([]);
    // Isolated component states let us test the same production selectors without
    // starting a second task or relying on a provider request being slow.
    const originalLabels = await page.evaluate(() => {
      const states = document.createElement("section");
      states.id = "motion-states";
      states.style.cssText =
        "position:fixed;top:100px;left:400px;background:white;padding:20px;z-index:10000;display:grid;gap:10px";
      states.innerHTML =
        '<div style="position:relative;width:30px;height:20px"><span class="runs-head is-dev"></span></div>' +
        '<p class="add-project-state is-progress"><i class="project-progress-icon"><svg class="ui-icon"><use href="#i-loader-circle"/></svg></i></p>' +
        '<span class="ui-status" data-state="saving"><span data-label>保存中</span></span>' +
        '<div class="app-dialog" style="position:static;display:block;min-width:0"><div class="dialog-actions"><button class="app-button" aria-busy="true"><span data-label>确认</span></button></div></div>' +
        '<div class="provider-dialog"><button class="app-button" aria-busy="true"><span data-label>连接</span></button></div>';
      document.body.append(states);
      return [...states.querySelectorAll("[data-label]")].map((label) => {
        const box = label.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      });
    });
    for (const kind of ["head", "loader", "ring"]) {
      await expect(page.locator(`#motion-states [data-native-motion="${kind}"]`)).toHaveCount(
        kind === "ring" ? 3 : 1
      );
    }
    const nativeLabels = await page.locator("#motion-states [data-label]").evaluateAll((labels) =>
      labels.map((label) => {
        const box = label.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      })
    );
    expect(nativeLabels).toEqual(originalLabels);
    await page.locator("#motion-states").evaluate((node) => node.remove());
    await expect.poll(presentation).toEqual([]);
    const message = page.locator(".chat-message.user").last();
    await message.hover();
    const copy = message.locator("[data-user-copy]");
    // Give the test time to sample the OS presentation tree before the glyph resets.
    await page.evaluate(() => document.documentElement.style.setProperty("--motion-copy", "600ms"));
    await copy.click();
    await expect(copy.locator("svg")).toHaveAttribute("data-native-motion", "copied");
    await expect.poll(presentation).toEqual([]);
  } finally {
    release();
    await app?.close();
    await provider.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true });
  }
});
