import { test, expect } from "@playwright/test";
import { startConfiguredDashboard, startDashboard } from "../test/dashboard-fixture.mjs";
import { pageRequest, saveTestConnection } from "../test/model-provider-fixture.mjs";
import { addProviderThroughUi, chooseRoleModel, openBuiltinAgent } from "./model-provider-ui.js";
import {
  expectContained,
  expectNoHorizontalOverflow,
  openAddProvider,
  openSettings,
  openWebSearchSettings
} from "./settings-helper.js";

const section = (page, name) => page.locator(`[data-settings-panel="${name}"]`);
const navItem = (page, name) => page.locator(`[data-settings-section="${name}"]`);

test("the ten sections switch from one navigation, return to the entry and no settings dialog remains", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);

    await expect(page.locator("#app-layout")).toBeHidden();
    await expect(page.locator("#settings-entry .settings-nav-item")).toHaveCount(9);
    await expect(navItem(page, "general")).toHaveAttribute("aria-current", "page");
    await expect(section(page, "general")).toBeVisible();
    await expect(section(page, "general").getByRole("heading", { level: 1 })).toHaveText("通用");

    for (const [name, title] of [
      ["nodes", "节点连接"],
      ["models", "模型"],
      ["agents", "Agent"],
      ["skills", "技能"],
      ["mcp", "MCP"],
      ["memory", "记忆"],
      ["members", "成员与通道"],
      ["tools", "工具"]
    ]) {
      await navItem(page, name).click();
      await expect(navItem(page, name)).toHaveAttribute("aria-current", "page");
      await expect(section(page, name)).toBeVisible();
      await expect(section(page, name).getByRole("heading", { level: 1 })).toHaveText(title);
      for (const other of ["general", "nodes", "models", "agents", "skills", "mcp", "members", "tools"])
        if (other !== name) await expect(section(page, other)).toBeHidden();
    }

    // Arrow keys move the same selection the click does.
    await navItem(page, "tools").focus();
    await page.keyboard.press("ArrowUp");
    await expect(navItem(page, "members")).toHaveAttribute("aria-current", "page");
    await expect(section(page, "members")).toBeVisible();

    // Back leaves settings and returns focus to the entry that opened it.
    await page.locator("#settings-back").click();
    await expect(page.locator("#settings-entry")).toBeHidden();
    await expect(page.locator("#app-layout")).toBeVisible();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();

    // Escape is the same exit.
    await openSettings(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-entry")).toBeHidden();
    await expect(page.locator("#app-layout")).toBeVisible();

    await expect(page.locator("#profile-modal")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("general preferences take effect, survive a reload and stay in their sections", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    const response = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "settings-time", goal: "时间格式验收" }
    });
    expect(response.ok()).toBe(true);
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);

    // Theme.
    await page.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator('[data-appearance-value="light"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // A browser has no native window material, so the row is not offered.
    await expect(page.locator("#window-material-row")).toBeHidden();

    // Reduced motion: on stops rendered animation, off restores it, both persist.
    await page.locator('[data-reduced-motion-value="on"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    const reduced = await page.evaluate(() => {
      const panel = document.createElement("div");
      panel.className = "ui-panel";
      document.body.append(panel);
      const animation = getComputedStyle(panel).animationName;
      panel.remove();
      return animation;
    });
    expect(reduced).toBe("none");
    await page.locator('[data-reduced-motion-value="off"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "off");
    expect(
      await page.evaluate(() => {
        const panel = document.createElement("div");
        panel.className = "ui-panel";
        document.body.append(panel);
        const animation = getComputedStyle(panel).animationName;
        panel.remove();
        return animation;
      })
    ).toBe("formicand-panel-in");

    // Time format changes how the same record is written.
    await page.locator('[data-time-format-value="absolute"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-time-format", "absolute");
    await page.locator("#settings-back").click();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const result = page.locator(".search-result").first();
    await expect(result).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await page.keyboard.press("Escape");

    await openSettings(page);
    await page.locator('[data-time-format-value="relative"]').click();
    await page.locator("#settings-back").click();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-result").first()).not.toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await page.keyboard.press("Escape");

    // Every choice survives a reload.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "off");
    await expect(page.locator("html")).toHaveAttribute("data-time-format", "relative");
    await openSettings(page);
    await expect(page.locator('[data-appearance-value="dark"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-reduced-motion-value="off"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-time-format-value="relative"]')).toHaveAttribute("aria-checked", "true");

    // Language keeps its control and the about group keeps its update action.
    await expect(page.locator("#language-select")).toHaveValue("zh-CN");
    await expect(page.locator("#profile-settings-about")).toContainText("Formicand");
    await expect(page.locator("[data-update-action]")).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("providers are edited on the model page and the built-in Agents pick from them", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);
    await navItem(page, "models").click();
    await expect(section(page, "models")).toBeVisible();

    // An empty host shows where a provider is added, never a fake one.
    await expect(section(page, "models").locator(".provider-empty-list")).toHaveText("还没有供应商");

    await addProviderThroughUi(page, {
      name: "验收供应商",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "acceptance-model",
      apiKey: "test-key-not-echoed"
    });
    await expect(page.locator(".provider-item", { hasText: "验收供应商" })).toContainText("1 个模型");
    // The key never comes back to the page.
    await expect(page.locator('[data-field="apiKey"]')).toHaveValue("");
    expect(await page.locator("#settings-entry").innerText()).not.toContain("test-key-not-echoed");

    // The model page has no role section; Main, Executor and Reviewer pick on the Agent page.
    await expect(section(page, "models").locator("[data-model-tab]")).toHaveCount(0);
    await chooseRoleModel(page, "executor", "acceptance-model");
    for (const role of ["main", "executor", "reviewer"])
      await expect(page.locator(`[data-agent-select="builtin:${role}"]`)).toBeVisible();
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    const model = status.providers[0].models[0];
    const bound = status.modelRoles.roles.find((entry) => entry.role === "executor");
    expect(bound.host.profileId).toBe(model.profileId);

    // Reopening the page reads the saved choice back.
    await page.locator("#settings-back").click();
    const agents = await openBuiltinAgent(page, "executor");
    await expect(agents.locator("[data-agent-model]")).toContainText("acceptance-model");

    // Effort is the Agent's own and offers only what the model accepts: this one takes no effort.
    const effort = agents.locator("[data-agent-effort] option");
    await expect(effort).toHaveText(["默认", "关闭"]);
    await agents.locator("[data-agent-effort]").selectOption("off");
    await agents.locator("[data-agent-save]").click();
    await expect(page.locator("#toast")).toContainText("已保存");
    const saved = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(saved.modelRoles.roles.find((entry) => entry.role === "executor").host).toEqual({
      profileId: model.profileId,
      thinkingLevel: "off"
    });
  } finally {
    await dashboard.stop();
  }
});

test("node connections, tools and members show only the information each section owns", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);

    await navItem(page, "nodes").click();
    const local = page.locator("#settings-node-cards [data-local-node]");
    await expect(local).toContainText("本机");
    await expect(local).toContainText("对内");
    await expect(local).toContainText("在线");
    // The card reads this machine's CPU, memory and disk.
    await expect(local.locator(".node-resource-value").first()).toHaveText(/^\d+%$/);
    await expect(page.locator("#settings-node-data")).toHaveCount(0);
    // The host appends its backend-switcher row under the cards.
    await expect(page.locator("#settings-node-local [data-backend-open]")).toHaveCount(1);
    await page.locator("#settings-node-local [data-backend-open]").click();
    await expect(page.getByRole("dialog", { name: "后端" })).toBeVisible();
    await page.locator("[data-backend-close]").click();
    await expect(page.getByRole("dialog", { name: "后端" })).toBeHidden();
    // No remote node is stored yet: only this machine's card and the add action.
    await expect(page.locator("#settings-node-add")).toBeVisible();
    await expect(page.locator("#settings-node-cards [data-node]")).toHaveCount(1);

    await navItem(page, "tools").click();
    const tools = page.locator("#profile-settings-tools");
    await expect(tools).toContainText("联网搜索");
    await expect(tools).toContainText("窗口访问");
    await tools.getByRole("button", { name: "管理联网搜索" }).click();
    await expect(page.getByRole("dialog", { name: "联网搜索" })).toBeVisible();
    await page.getByRole("button", { name: "返回设置", exact: true }).click();
    await expect(page.locator("#settings-entry")).toBeVisible();

    await navItem(page, "members").click();
    const members = page.locator("#settings-member-rows");
    await expect(members).toContainText("我");
    await expect(members.locator(".settings-chip.is-accent")).toHaveText("负责人");
  } finally {
    await dashboard.stop();
  }
});

test("a refused role change reports the reason and keeps the saved model", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await saveTestConnection(pageRequest(page, dashboard.base), {
      profileName: "角色供应商",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "role-fixture",
      apiKey: "local-role-key"
    });
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    const model = status.providers[0].models[0];
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    // Save one choice so the refused change has a persisted value to return to.
    await chooseRoleModel(page, "executor", model.id);
    const agents = page.locator('[data-settings-panel="agents"]');
    const picker = agents.locator("[data-agent-model]");

    await page.route("**/api/agents/builtin", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "保存被拒绝：连接不可用" })
      })
    );
    await picker.click();
    await page.locator(".role-menu:not([hidden]) .role-menu-item").first().click();
    await agents.locator("[data-agent-save]").click();
    await expect(page.locator("#toast")).toContainText("保存被拒绝");
    // The unsaved choice stays in the form so it can be retried.
    await expect(agents.locator("[data-agent-save]")).toBeEnabled();
    const after = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(after.modelRoles.roles.find((entry) => entry.role === "executor").host.profileId).toBe(
      model.profileId
    );
  } finally {
    await dashboard.stop();
  }
});

for (const desktop of [false, true]) {
  test(`settings keep their rows legible at desktop and narrow widths and show the host update state in ${desktop ? "desktop" : "web"}`, async ({
    page
  }, info) => {
    const dashboard = await startConfiguredDashboard();
    try {
      await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
      if (desktop) {
        await page.addInitScript(() => {
          const update = {
            mode: "source",
            phase: "failed",
            currentVersion: "fixture",
            error: "更新暂不可用，请稍后重试"
          };
          window.bookmanDesktop = {
            onPrepareClose() {},
            updateStatus: async () => update,
            checkUpdates: async () => update,
            applyUpdate: async () => update
          };
        });
      }
      await page.goto(dashboard.base);
      for (const width of [1440, 640]) {
        await page.setViewportSize({ width, height: 760 });
        const settings = await openSettings(page);
        await expect(settings.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
        if (desktop) await expect(settings.locator("[data-update-error]")).toContainText("更新暂不可用");
        await expectNoHorizontalOverflow(page, settings);
        for (const row of await settings.locator(".settings-row-copy").all()) {
          const bounds = await row.boundingBox();
          if (bounds) expect(bounds.width).toBeGreaterThanOrEqual(100);
        }
        await page.screenshot({ path: info.outputPath(`overview-${width}.png`) });
        await page.locator('[data-settings-section="tools"]').click();
        await expect(settings.locator("#profile-settings-tools")).toContainText("联网搜索");
        await expect(settings.locator("#profile-settings-tools")).toContainText("窗口访问");
        await page.locator("#settings-back").click();
        await expect(settings).toBeHidden();
      }
    } finally {
      await dashboard.stop();
    }
  });
}

for (const theme of ["dark", "light"]) {
  test(`settings and their sub-pages stay contained and reachable in ${theme}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(90_000);
    const dashboard = await startConfiguredDashboard();
    try {
      await page.goto(dashboard.base);
      for (const width of [1440, 640]) {
        await page.setViewportSize({ width, height: 900 });
        const entry = await openSettings(page);
        await page.locator(`[data-appearance-value="${theme}"]`).click();
        await expect(page.locator("#settings-back")).toBeInViewport();
        await expectNoHorizontalOverflow(page, entry);
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-settings.png`) });

        const model = await openAddProvider(page);
        await expectContained(page, model);
        await model.locator("[data-dialog-close]").click();
        await expect(model).toBeHidden();

        const search = await openWebSearchSettings(page);
        await expectContained(page, search);
        await page.keyboard.press("Escape");
        await expect(search).toBeHidden();
        await expect(entry).toBeVisible();
        await page.locator("#settings-back").click();
        await expect(entry).toBeHidden();
      }
    } finally {
      await dashboard.stop();
    }
  });
}

test("settings drop glass under reduced transparency", async ({ page }) => {
  const dashboard = await startConfiguredDashboard();
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-transparency", value: "reduce" },
        { name: "prefers-color-scheme", value: "dark" }
      ]
    });
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    const entry = page.locator("#settings-entry");
    await expect(entry).toBeVisible();
    await expect(entry.locator(".settings-content")).toHaveCSS("background-image", "none");
    await expect(entry.locator(".settings-content")).toHaveCSS("backdrop-filter", "none");
    const model = await openAddProvider(page);
    await expect(model).toHaveCSS("backdrop-filter", "none");
    await page.keyboard.press("Escape");
    await expect(model).toBeHidden();
    await expect(entry).toBeVisible();
  } finally {
    await client.detach();
    await dashboard.stop();
  }
});
