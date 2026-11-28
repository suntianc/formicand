import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import { dismissModelSetup } from "./model-provider-ui.js";

const taskId = "titlebar-task";
const taskGoal = "标题栏验收会话";

async function bootDesktop({ dismissSetup = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "formicand-p45-titlebar-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:FORMICAND_|FORMICAND_|PI_|EXA_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(key)
    )
  );
  Object.assign(env, {
    FORMICAND_DESKTOP_DATA: root,
    FORMICAND_DESKTOP_DEV: "1",
    FORMICAND_DESKTOP_BACKGROUND: process.env.FORMICAND_DESKTOP_BACKGROUND ?? "1",
    FORMICAND_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
    FORMICAND_DISABLE_SESSION_TITLES: "1",
    PI_OFFLINE: "1"
  });
  const executablePath = await developmentExecutable();
  const native = await electron.launch({
    executablePath,
    args: ["--use-mock-keychain", resolve(".")],
    env,
    timeout: 90_000
  });
  if (env.FORMICAND_DESKTOP_BACKGROUND === "1" && process.platform === "darwin") {
    await native.evaluate(({ app, BrowserWindow }) => {
      app.hide();
      BrowserWindow.getAllWindows().forEach((window) => window.hide());
    });
  }
  const page = await native.firstWindow();
  await expect(page.locator("#composer-input")).toBeAttached();
  if (dismissSetup) await dismissModelSetup(page, { wait: 5_000 });
  return { native, page, root };
}

test("after first-use setup, leaving settings restores focus to its current opener", async () => {
  const { native, page, root } = await bootDesktop({ dismissSetup: false });
  try {
    await dismissModelSetup(page);
    const trigger = page.locator("#user-menu-button");
    await trigger.focus();
    await trigger.press("Enter");
    await expect(page.locator('[data-settings-section][aria-current="page"]')).toBeFocused();
    await page.locator("#settings-back").click();
    await expect(page.locator("#settings-entry")).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await native.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Windows integrates native caption buttons, theme and the material setting", async () => {
  test.skip(process.platform !== "win32", "Requires the Windows window manager");
  test.setTimeout(120_000);
  const { native, page, root } = await bootDesktop();
  try {
    await expect(page.locator("html")).toHaveAttribute("data-title-bar", "overlay");
    const executable = await native.evaluate(() => process.execPath);
    expect(executable).toMatch(/[/\\]Formicand\.exe$/i);
    const usesVendorIcon = await native.evaluate(async ({ app }, vendor) => {
      const icon = await app.getFileIcon(process.execPath);
      const electronIcon = await app.getFileIcon(vendor);
      return icon.toBitmap().equals(electronIcon.toBitmap());
    }, resolve("node_modules/electron/dist/electron.exe"));
    expect(usesVendorIcon).toBe(false);
    await page.keyboard.press("Alt");
    expect(
      await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())
    ).toBe(false);
    const geometry = await page.evaluate(() => ({
      visible: navigator.windowControlsOverlay.visible,
      available: navigator.windowControlsOverlay.getTitlebarAreaRect().right,
      toolbar: document.querySelector(".app-titlebar").getBoundingClientRect().right
    }));
    expect(geometry.visible).toBe(true);
    expect(geometry.toolbar).toBeGreaterThan(0);
    expect(geometry.toolbar).toBeLessThanOrEqual(geometry.available + 1);
    const panelToggle = page.locator("#output-pane-toggle");
    const initialBox = await panelToggle.boundingBox();
    await expect(panelToggle).toHaveAttribute("aria-expanded", "false");
    for (const expanded of ["true", "false"]) {
      await panelToggle.click();
      await expect(panelToggle).toHaveAttribute("aria-expanded", expanded);
      await page.waitForFunction(() => !document.body.hasAttribute("data-layout-animating"));
      expect(await panelToggle.boundingBox()).toEqual(initialBox);
    }
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="general"]').click();
    expect(
      await page
        .locator(".settings-content")
        .evaluate(
          (panel) =>
            panel.getBoundingClientRect().top >= navigator.windowControlsOverlay.getTitlebarAreaRect().bottom
        )
    ).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-titlebar-layout", "leading-nav");
    const originalSize = await native.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const size = window.getSize();
      window.setSize(752, 700);
      return size;
    });
    const back = page.locator("#settings-entry > #settings-back");
    await expect(back).toBeInViewport();
    const geometryAtMinimum = await back.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
      return (
        rect.left >= area.left &&
        rect.right <= area.right &&
        rect.top >= area.top &&
        rect.bottom <= area.bottom
      );
    });
    expect(geometryAtMinimum).toBe(true);
    await expect(back).toHaveCSS("-webkit-app-region", "no-drag");
    await page.locator('[data-settings-section="general"]').focus();
    await page.keyboard.press("Shift+Tab");
    await expect(back).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#settings-entry")).toBeHidden();
    await native.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      originalSize
    );
    await page.locator("#user-menu-button").click();
    await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await expect(page.locator("html")).toHaveAttribute("data-desktop-fullscreen", "true");
    await expect(page.locator("#settings-entry")).toHaveCSS("-webkit-app-region", "none");
    await back.click();
    await expect(page.locator("#settings-entry")).toBeHidden();
    await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    await expect(page.locator("html")).toHaveAttribute("data-desktop-fullscreen", "false");
    await page.locator("#user-menu-button").click();
    const acrylic = Number(release().split(".")[2]) >= 22621;
    const tint = { light: "rgba(247, 247, 248, 0.75)", dark: "rgba(16, 16, 18, 0.68)" };
    for (const theme of ["light", "dark"]) {
      await page.locator(`[data-appearance-value="${theme}"]`).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (acrylic) {
        await expect(page.locator("html")).toHaveCSS("background-color", tint[theme]);
        // Composite a pixel from the empty title band over the same neutral grey in both themes.
        const brightness = await native.evaluate(async ({ BrowserWindow }) => {
          const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage({
            x: 120,
            y: 8,
            width: 1,
            height: 1
          });
          const [blue, green, red, alpha] = image.toBitmap();
          return (red + green + blue) / 3 + 128 * (1 - alpha / 255);
        });
        if (theme === "light") expect(brightness).toBeGreaterThan(175);
        else expect(brightness).toBeLessThan(80);
      }
    }
    if (acrylic) {
      const toggle = page.locator("#window-material-toggle");
      await expect(page.locator("html")).toHaveAttribute("data-window-material", "acrylic");
      await toggle.click();
      await expect(page.locator("html")).toHaveAttribute("data-window-material", "none");
      await expect(page.locator("html")).toHaveCSS("background-color", "rgb(11, 11, 12)");
      await toggle.click();
      await expect(page.locator("html")).toHaveCSS("background-color", tint.dark);
    } else {
      await expect(page.locator("#window-material-row")).toBeHidden();
    }
  } finally {
    await native.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Windows closes to its tray, restores the same window and quits from the tray menu", async () => {
  test.skip(process.platform !== "win32", "Requires the Windows notification area");
  const { native, page, root } = await bootDesktop();
  try {
    expect(await page.evaluate(() => window.formicandDesktop.capabilities.tray)).toBe(true);
    // Capture the real tray and its menu when the language host refreshes the labels.
    const binding = await native.evaluateHandle(({ Tray }) => {
      const binding = {};
      const setMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) {
        Tray.prototype.setContextMenu = setMenu;
        Object.assign(binding, { tray: this, menu });
        return setMenu.call(this, menu);
      };
      return binding;
    });
    await page.evaluate(() => window.formicandDesktop.language.set("en"));
    const win = await native.browserWindow(page);
    await win.evaluate((window) => window.close());
    await expect.poll(() => win.evaluate((window) => window.isVisible())).toBe(false);
    await binding.evaluate(({ tray }) => tray.emit("click"));
    await expect.poll(() => win.evaluate((window) => window.isVisible())).toBe(true);
    await win.evaluate((window) => window.close());
    await expect.poll(() => win.evaluate((window) => window.isVisible())).toBe(false);
    const closed = native.waitForEvent("close");
    await binding.evaluate(({ menu }) => menu.items.find((item) => item.label === "Quit Formicand").click());
    await closed;
  } finally {
    await native.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function createTaskThroughHost(page) {
  // The host attaches its session through the window capability once the
  // selected backend is up, so retry until authorization reports success.
  const result = await page.evaluate(
    async ({ taskId, goal }) => {
      const headers = { "content-type": "application/json" };
      const nonce = window.formicandDesktop?.transportNonce;
      if (nonce) headers["x-formicand-desktop-nonce"] = nonce;
      let response;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        response = await fetch("/api/tasks", {
          method: "POST",
          headers,
          body: JSON.stringify({ taskId, goal })
        });
        if (response.status !== 401) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { status: response.status, body: await response.text() };
    },
    { taskId, goal: taskGoal }
  );
  expect(result.status, result.body).toBeLessThan(300);
}

test("the desktop window has no title bar, panels reach the top and traffic lights clear the brand", async () => {
  test.skip(process.platform !== "darwin", "macOS traffic lights are the acceptance target");
  test.setTimeout(180_000);
  const { native, page, root } = await bootDesktop();
  try {
    const applicationVersion = await native.evaluate(({ app }) => app.getVersion());
    const capabilities = await page.evaluate(() => window.formicandDesktop.capabilities);
    expect(capabilities).toMatchObject({
      platform: "darwin",
      version: applicationVersion,
      titleBar: "inset",
      controlsSide: "left",
      titlebarLayout: "standard",
      material: "under-window",
      updates: "source",
      fileOpenWith: "full"
    });
    await expect(page.locator("html")).toHaveAttribute("data-controls-side", "left");
    await createTaskThroughHost(page);
    await page.reload();
    await dismissModelSetup(page);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await expect(page.locator("#topbar-task")).toHaveText(taskGoal);

    await expect(page.locator(".app-topbar")).toHaveCount(0);
    await expect(page.locator(".window-nav")).toHaveCount(0);
    await expect(page.locator("#project-context")).toHaveCount(0);

    const boxes = await page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };
      return {
        sidebar: box("#conversation-sidebar"),
        titlebar: box("#app-titlebar"),
        toggle: box("#sidebar-toggle"),
        main: box("#work-entry"),
        title: box("#topbar-task"),
        panel: box("#agent-pane")
      };
    });
    // One 44 px title row holds the traffic lights and the navigation; the
    // sidebar and the panels start right below it.
    expect(boxes.titlebar).toMatchObject({ x: 0, y: 0, height: 44 });
    expect(boxes.sidebar).toMatchObject({ x: 0, y: 44 });
    expect(boxes.main).toMatchObject({ x: 258, y: 44 });
    // macOS draws the traffic lights at x≈18..70; the first control starts after them.
    expect(boxes.toggle.x).toBe(84);
    expect(boxes.toggle.y + boxes.toggle.height / 2).toBe(22);
    expect(boxes.title.x).toBeGreaterThan(boxes.main.x);
    expect(boxes.title.y + boxes.title.height).toBeLessThanOrEqual(boxes.main.y);

    await page.locator("#output-pane-toggle").click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("#agent-pane")).transform === "none"
    );
    const panel = await page.locator("#agent-pane").boundingBox();
    expect(Math.round(panel.y)).toBe(44);
    expect(Math.round(panel.height)).toBe(boxes.sidebar.height);

    const regions = await page.evaluate(() =>
      Object.fromEntries(
        [
          ".app-shell",
          ".app-layout",
          "#conversation-sidebar",
          "#app-titlebar",
          "#sidebar-toggle",
          "#output-pane-toggle",
          "#work-entry",
          ".chat-body",
          "#agent-pane"
        ].map((selector) => [
          selector,
          getComputedStyle(document.querySelector(selector)).getPropertyValue("-webkit-app-region")
        ])
      )
    );
    expect(regions[".app-shell"]).toBe("drag");
    expect(regions[".app-layout"]).toBe("drag");
    expect(regions["#conversation-sidebar"]).toBe("no-drag");
    // The title row drags the window; its controls and the pane content do not.
    expect(regions["#app-titlebar"]).toBe("drag");
    expect(regions["#sidebar-toggle"]).toBe("no-drag");
    expect(regions["#output-pane-toggle"]).toBe("no-drag");
    expect(regions["#work-entry"]).toBe("no-drag");
    // Content adds no region of its own; the pane box keeps it out of the drag.
    expect(regions[".chat-body"]).toBe("none");
    expect(regions["#agent-pane"]).toBe("no-drag");

    await page.locator(`.conversation-item[data-task="${taskId}"]`).click({ button: "right" });
    await expect(page.locator("#session-menu")).toBeVisible();
    await expect(page.locator('#session-menu [data-session-action="rename"]')).toBeEnabled();
    await expect(page.locator('#session-menu [data-session-action="archive"]')).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.locator("#session-menu")).toBeHidden();

    const materials = await page.evaluate(() => ({
      material: document.documentElement.dataset.windowMaterial,
      platform: document.documentElement.dataset.desktopPlatform
    }));
    expect(materials).toEqual({ material: "under-window", platform: "darwin" });
  } finally {
    await native.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Chromium takes one rectangle from every element with a region, in document
// order and without clipping, each later one winning. This replays that rule
// along a horizontal line and names the element that ends up on top.
const dragLine = (page, y) =>
  page.evaluate((y) => {
    const region = (el, pseudo) => getComputedStyle(el, pseudo).getPropertyValue("-webkit-app-region");
    const rects = [];
    for (const el of document.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const value = region(el);
      if (value === "drag" || value === "no-drag") rects.push({ el, value, box: el.getBoundingClientRect() });
      const before = getComputedStyle(el, "::before");
      if (before.content !== "none" && region(el, "::before") === "drag") {
        const box = el.getBoundingClientRect();
        rects.push({
          el,
          value: "drag",
          box: { left: box.left, right: box.right, top: box.top, bottom: box.top + parseFloat(before.height) }
        });
      }
    }
    const holes = [];
    for (let x = 2; x < innerWidth; x += 8) {
      let top;
      for (const rect of rects) {
        const { left, right, top: t, bottom } = rect.box;
        if (x >= left && x < right && y >= t && y < bottom) top = rect;
      }
      // A panel's 1px border is not a place anyone grabs.
      const onBorder =
        top && (x < top.box.left + top.el.clientLeft || x >= top.box.right - top.el.clientLeft);
      if (
        top?.value === "no-drag" &&
        !onBorder &&
        !top.el.closest("button, a, [role='button'], [role='tab']")
      )
        holes.push(`${x}:${top.el.tagName.toLowerCase()}.${String(top.el.className).split(" ")[0]}`);
    }
    return holes;
  }, y);

test("content scrolled behind the title row or the settings margin never takes the window drag away", async () => {
  test.skip(process.platform !== "darwin", "Window dragging is a desktop concern");
  test.setTimeout(180_000);
  const { native, page, root } = await bootDesktop();
  try {
    await createTaskThroughHost(page);
    await page.reload();
    await dismissModelSetup(page);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await expect(page.locator("#topbar-task")).toHaveText(taskGoal);
    // A long transcript scrolled to its end leaves most of it above the pane.
    await page.evaluate(() => {
      const body = document.querySelector(".chat-body");
      for (let index = 0; index < 80; index += 1) {
        const row = document.createElement("p");
        row.innerHTML = `<a href="#">链接 ${index}</a> <button type="button">复制</button>`;
        body.append(row);
      }
      body
        .closest(".chat-pane")
        .querySelectorAll("*")
        .forEach((node) => {
          if (node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight;
        });
    });
    expect(await dragLine(page, 22)).toEqual([]);

    await page.locator("#user-menu-button").click();
    await expect(page.locator(".settings-entry")).toBeVisible();
    await page.evaluate(() => {
      const content = document.querySelector(".settings-content");
      for (const node of [content, ...content.querySelectorAll("*")])
        if (node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight;
    });
    // The margin, the band beside the traffic lights and the page header all drag.
    expect(await dragLine(page, 5)).toEqual([]);
    expect(await dragLine(page, 40)).toEqual([]);
  } finally {
    await native.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the browser keeps its design margin and reserves nothing for native window controls", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#entry-work")).toBeVisible();
    const metrics = await page.evaluate(() => {
      const toggle = document.querySelector("#sidebar-toggle").getBoundingClientRect();
      const main = document.querySelector("#work-entry").getBoundingClientRect();
      return {
        platform: document.documentElement.dataset.desktopPlatform ?? null,
        toggleX: Math.round(toggle.x),
        mainX: Math.round(main.x),
        mainY: Math.round(main.y)
      };
    });
    expect(metrics.platform).toBeNull();
    expect(metrics.toggleX).toBe(12);
    expect(metrics.mainX).toBe(258);
    expect(metrics.mainY).toBe(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  } finally {
    await dashboard.stop();
  }
});

test("settings keeps a usable return control in overlay, fullscreen and native chrome", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#entry-work")).toBeVisible();
    await page.setViewportSize({ width: 752, height: 740 });
    await page.locator("#user-menu-button").click();
    const root = page.locator("html");
    for (const [titleBar, layout, fullscreen] of [
      ["overlay", "leading-nav", false],
      ["overlay", "leading-nav", true],
      ["native", "standard", false]
    ]) {
      await root.evaluate((html, state) => Object.assign(html.dataset, state), {
        desktopPlatform: "fixture",
        titleBar,
        titlebarLayout: layout,
        desktopFullscreen: String(fullscreen)
      });
      const content = page.locator(".settings-content");
      const back = page.locator("#settings-entry > #settings-back");
      await expect(back).toBeInViewport();
      const activeOverlay = titleBar === "overlay" && !fullscreen;
      await expect(page.locator("#settings-entry")).toHaveCSS(
        "-webkit-app-region",
        activeOverlay ? "drag" : "none"
      );
      const [buttonBox, panelBox] = await Promise.all([back.boundingBox(), content.boundingBox()]);
      if (activeOverlay) expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(panelBox.y);
      else expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(panelBox.x);
    }
    await page.locator("#settings-back").click();
    await expect(page.locator("#settings-entry")).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});
