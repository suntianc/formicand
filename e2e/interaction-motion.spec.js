import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

/**
 * Scripted motion runs through the Web Animations API, so every call is
 * recorded with a description of its target; CSS motion is read back from
 * the computed style while it runs.
 */
const recordAnimations = () => {
  window.__animated = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const node = this;
    window.__animated.push({
      id: node.id,
      classes: String(node.className?.baseVal ?? node.className ?? ""),
      key: node.dataset.viewKey,
      href: node.querySelector?.("use")?.getAttribute("href") ?? ""
    });
    return animate.apply(this, args);
  };
};
const animated = (page) => page.evaluate(() => window.__animated);
const reset = (page) => page.evaluate(() => (window.__animated = []));

test("interactions move: arrivals, copy, disclosures, dialogs and sidebar rows", async ({
  page,
  context
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(recordAnimations);
  const provider = await modelProtocolFixture("openai-completions", async () => ({
    text: "好的，已经处理完。"
  }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("第一条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.main").last()).toContainText("已经处理完", { timeout: 30000 });
    await expect(page.locator("#send-button")).toHaveAccessibleName("发送", { timeout: 30000 });

    // A new conversation joins the sidebar by growing into place.
    expect((await animated(page)).some((entry) => entry.classes.includes("conversation-row"))).toBe(true);

    // A message sent into the open conversation slides in; earlier ones stay still.
    await reset(page);
    await page.locator("#composer-input").fill("第二条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.user")).toHaveCount(2);
    await expect(page.locator(".chat-message.main")).toHaveCount(2, { timeout: 30000 });
    const arrivals = (await animated(page)).filter((entry) => entry.classes.includes("chat-message"));
    expect(arrivals.some((entry) => entry.classes.includes("user"))).toBe(true);
    expect(arrivals.length, JSON.stringify(arrivals)).toBeLessThanOrEqual(3);

    await expect(page.locator(".chat-message.main").last()).toContainText("已经处理完", { timeout: 30000 });
    await expect(page.locator("#send-button")).toHaveAccessibleName("发送", { timeout: 30000 });
    // Copying a message turns its icon into a check that pops, then back.
    await reset(page);
    const message = page.locator(".chat-message.user").last();
    await message.hover();
    const copy = message.locator("[data-user-copy]");
    await copy.click();
    await expect(copy.locator("use")).toHaveAttribute("href", "#i-check");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("第二条消息");
    expect((await animated(page)).some((entry) => entry.href === "#i-check")).toBe(true);
    await expect(copy.locator("use")).toHaveAttribute("href", "#i-copy", { timeout: 3000 });

    // A disclosure eases its content open through intermediate heights.
    await page.evaluate(() => {
      const details = document.createElement("details");
      details.id = "motion-details";
      details.innerHTML = '<summary>展开</summary><div style="height:200px">内容</div>';
      // This generic disclosure is independent of the live transcript, whose
      // next backend refresh owns and reconciles all of its children.
      details.style.cssText = "position:fixed;inset:0 auto auto 0;z-index:10000";
      document.body.append(details);
    });
    const details = page.locator("#motion-details");
    const closed = (await details.boundingBox()).height;
    await details.locator("summary").click();
    const heights = [];
    for (let frame = 0; frame < 12; frame += 1) {
      heights.push((await details.boundingBox()).height);
      await page.waitForTimeout(16);
    }
    await expect.poll(async () => (await details.boundingBox()).height).toBeGreaterThan(closed + 190);
    expect(heights.some((height) => height > closed + 1 && height < closed + 199)).toBe(true);

    await details.evaluate((node) => node.remove());

    // A project group folds and unfolds smoothly in the sidebar.
    await reset(page);
    const projectButton = page.locator("[data-project-id]").first();
    const projectList = projectButton.locator("../..").locator(".conversation-list");
    await projectButton.click();
    await expect(projectButton).toHaveAttribute("aria-expanded", "false");
    await expect(projectList).toBeHidden();
    expect((await animated(page)).some((entry) => entry.classes.includes("conversation-list"))).toBe(true);
    await reset(page);
    await projectButton.click();
    await expect(projectButton).toHaveAttribute("aria-expanded", "true");
    await expect(projectList).toBeVisible();
    expect((await animated(page)).some((entry) => entry.classes.includes("conversation-list"))).toBe(true);

    // A dialog's card rises in over a fading backdrop.
    await reset(page);
    const settings = page.locator("[data-project-settings]").first();
    await settings.locator("..").hover();
    await settings.click();
    await page.getByRole("menuitem", { name: "重命名项目", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "重命名项目", exact: true })).toBeVisible();
    expect((await animated(page)).some((entry) => /modal-card|app-dialog/.test(entry.classes))).toBe(true);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("reduced motion keeps every interaction still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(recordAnimations);
  const provider = await modelProtocolFixture("openai-completions", async () => ({ text: "好的。" }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("第一条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.main").last()).toContainText("好的", { timeout: 30000 });
    await expect(page.locator("#send-button")).toHaveAccessibleName("发送", { timeout: 30000 });
    await page.locator("#composer-input").fill("第二条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.main")).toHaveCount(2, { timeout: 30000 });
    const projectButton = page.locator("[data-project-id]").first();
    const projectList = projectButton.locator("../..").locator(".conversation-list");
    await projectButton.click();
    await expect(projectList).toBeHidden();
    await projectButton.click();
    await expect(projectList).toBeVisible();
    const moved = (await animated(page)).filter((entry) =>
      /chat-message|conversation-row|conversation-list|modal-card/.test(entry.classes)
    );
    expect(moved).toEqual([]);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("looping CSS effects sleep offscreen and the app motion setting overrides the OS", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(dashboard.base);
    await page.evaluate(() => {
      window.formicandPreferences.setMotion("off");
      const host = document.createElement("div");
      host.id = "motion-probe";
      host.style.cssText = "position:fixed;top:0;left:0;width:100px;height:50px;overflow:auto";
      host.innerHTML =
        '<div class="ant-mark thinking-spinner"><span class="ant-frames"></span></div><div class="app-dialog"><div class="dialog-actions"><button aria-busy="true">保存</button></div></div><div style="height:300px"></div>';
      document.body.append(host);
    });
    const host = page.locator("#motion-probe");
    const states = () =>
      host.evaluate((node) =>
        node
          .getAnimations({ subtree: true })
          .filter((a) => ["ant-frames", "ui-spin"].includes(a.animationName))
          .map((a) => a.playState)
          .sort()
      );
    await expect.poll(states).toEqual(["running", "running"]);
    await host.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect.poll(states).toEqual(["paused", "paused"]);
    const detached = await host.evaluate(async (node) => {
      const effects = node.getAnimations({ subtree: true });
      node.remove();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const states = effects.map((effect) => effect.playState);
      document.body.append(node);
      return states;
    });
    expect(detached).toEqual(["idle", "idle"]);
    await host.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect.poll(states).toEqual(["running", "running"]);
    await page.evaluate(() => window.formicandPreferences.setMotion("on"));
    await expect.poll(states).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});
