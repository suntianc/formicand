import { test, expect } from "@playwright/test";
import { startConfiguredDashboard } from "../test/dashboard-fixture.mjs";
import { createProject, createTask } from "./p45-work-helpers.js";

test("new sessions start from the sidebar, the project plus and ⌘K, and land in the chosen project", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const second = await createProject(page, dashboard, "第二个项目", `${dashboard.root}/second-project`);
    await createTask(page, dashboard, {
      taskId: "session-existing",
      goal: "已有会话",
      projectId: dashboard.projectId
    });
    await page.goto(dashboard.base);

    await page.locator("#new-conversation").click();
    await expect(page.locator("#topbar-task")).toHaveText("新会话");
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator("#composer-project")).toContainText("测试项目");
    // The start page is one question over the composer, with nothing under it.
    await expect(page.locator(".new-session-start")).toHaveText("想在哪个项目里做什么？");
    await expect(page.locator(".composer-hint")).toBeHidden();
    // The composer glides up into place; measure once it has settled.
    await page
      .locator(".composer-wrap")
      .evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    const start = await page.locator(".new-session-start").boundingBox();
    const composer = await page.locator(".composer").boundingBox();
    const pane = await page.locator("#conversation-pane").boundingBox();
    expect(composer.y).toBeGreaterThan(start.y);
    // Question and composer sit around the pane's middle, not at its foot.
    expect(composer.y + composer.height).toBeLessThan(pane.y + pane.height * 0.75);
    await page.locator(".conversation-item", { hasText: "已有会话" }).click();
    await expect(page.locator("#topbar-task")).toHaveText("已有会话");
    await expect(page.locator("#composer-project")).toBeHidden();

    await page.keyboard.press("Meta+k");
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator("#composer-project")).toContainText("测试项目");

    const secondProject = page.locator(`.project-group[data-project="${second.projectId}"]`);
    await secondProject.locator(".project-heading").hover();
    await secondProject.locator(`[data-project-create="${second.projectId}"]`).click();
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator("#composer-project")).toContainText("第二个项目");

    await page.locator("#composer-project").click();
    const menu = page.locator("#composer-project-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator("[data-add-project]")).toHaveText("添加项目…");
    await menu.locator(`[data-project-choice="${dashboard.projectId}"]`).click();
    await expect(page.locator("#composer-project")).toContainText("测试项目");
    await page.locator("#composer-project").click();
    await menu.locator(`[data-project-choice="${second.projectId}"]`).click();
    await expect(page.locator("#composer-project")).toContainText("第二个项目");

    await page.locator("#composer-input").fill("为第二个项目写一份说明");
    await page.locator("#send-button").click();
    await expect(page.locator("#topbar-task")).toHaveText("为第二个项目写一份说明");
    await expect(
      secondProject.locator(".conversation-item", { hasText: "为第二个项目写一份说明" })
    ).toBeVisible();
    await expect(
      page
        .locator(`.project-group[data-project="${dashboard.projectId}"]`)
        .locator(".conversation-item", { hasText: "为第二个项目写一份说明" })
    ).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("the project picker opens and switches projects before any session exists", async ({ page }) => {
  const dashboard = await startConfiguredDashboard({ defaultProject: false });
  try {
    const first = await createProject(page, dashboard, "首个项目", `${dashboard.root}/first-project`);
    const second = await createProject(page, dashboard, "另一个项目", `${dashboard.root}/other-project`);
    await page.goto(dashboard.base);
    await expect(page.locator(".new-session-start")).toBeVisible();
    const chip = page.locator("#composer-project");
    await expect(chip).toBeVisible();
    await chip.click();
    const menu = page.locator("#composer-project-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(`[data-project-choice="${first.projectId}"]`)).toBeVisible();
    await menu.locator(`[data-project-choice="${second.projectId}"]`).click();
    await expect(chip).toContainText("另一个项目");
  } finally {
    await dashboard.stop();
  }
});

test("the composer keeps one size from a new session into a conversation, and 新会话 is selected like a row", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const project = await createProject(page, dashboard, "尺寸项目", `${dashboard.root}/size-project`);
    await createTask(page, dashboard, { taskId: "size-a", goal: "已有会话", projectId: project.projectId });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.base}/?task=size-a`);
    await expect(page.locator("#topbar-task")).toHaveText("已有会话");
    const composer = page.locator(".composer");
    const inConversation = await composer.boundingBox();

    await page.locator("#new-conversation").click();
    await expect(page.locator(".new-session-start")).toBeVisible();
    // Centred on the start page, the composer keeps its size and column; it
    // glides there, so it is measured once the glide is over.
    await composer.evaluate((node) =>
      Promise.all(
        node
          .closest(".composer-wrap")
          .getAnimations()
          .map((animation) => animation.finished)
      )
    );
    const centred = await composer.boundingBox();
    expect({ ...centred, y: 0 }).toEqual({ ...inConversation, y: 0 });
    expect(centred.y).toBeLessThan(inConversation.y);
    const title = await page.locator(".new-session-title").boundingBox();
    // The question is centred over the composer.
    expect(Math.abs(title.x + title.width / 2 - (centred.x + centred.width / 2))).toBeLessThan(2);

    // The selected 新会话 uses the selected-row fill, edge and shadow in both themes.
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => window.atriaAppearance.set(value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const [button, row] = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const read = (node) => getComputedStyle(node).backgroundColor;
        const probe = document.createElement("div");
        probe.style.background = style.getPropertyValue("--selected-fill");
        document.body.append(probe);
        const expected = read(probe);
        probe.remove();
        return [read(document.querySelector("#new-conversation")), expected];
      });
      expect(button, theme).toBe(row);
    }
  } finally {
    await dashboard.stop();
  }
});

test("switching conversations never flashes a welcome page while the next one loads", async ({ page }) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const project = await createProject(page, dashboard, "切换项目", `${dashboard.root}/switch-project`);
    for (const [taskId, goal] of [
      ["switch-a", "会话甲"],
      ["switch-b", "会话乙"]
    ])
      await createTask(page, dashboard, { taskId, goal, projectId: project.projectId });
    // A slow detail read stretches the moment between the two conversations,
    // and each has a message, so any welcome page on the way is a flash. It is
    // installed before the first navigation: a conversation read without the
    // message would legitimately show the empty-conversation welcome.
    await page.route(/\/api\/tasks\/switch-[ab]$/, async (route) => {
      await new Promise((done) => setTimeout(done, 300));
      const response = await route.fetch();
      const detail = await response.json();
      detail.messages = [{ role: "user", content: detail.task.goal, timestamp: Date.now() }];
      await route.fulfill({ response, json: detail });
    });
    await page.goto(`${dashboard.base}/?task=switch-a`);
    await expect(page.locator("#topbar-task")).toHaveText("会话甲");
    await page.evaluate(() => {
      window.welcomeFrames = 0;
      const tick = () => {
        if (document.querySelector(".new-session-start, .welcome-empty")) window.welcomeFrames += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (const [taskId, goal] of [
      ["switch-b", "会话乙"],
      ["switch-a", "会话甲"],
      ["switch-b", "会话乙"]
    ]) {
      await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
      // The routed detail read is slow on purpose: wait for the switched
      // conversation's own message, so every frame of the transition is sampled.
      await expect(page.locator("#conversation .chat-message.user").first()).toContainText(goal);
      await expect(page.locator("#topbar-task")).toHaveText(goal);
    }
    expect(await page.evaluate(() => window.welcomeFrames)).toBe(0);
  } finally {
    await dashboard.stop();
  }
});

test("leaving a long conversation for a new session lifts the composer from the foot, never drops it from above", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const taskId = "long-session";
    await createTask(page, dashboard, { taskId, goal: "长会话", projectId: dashboard.projectId });
    const messages = Array.from({ length: 20 }, (_, index) => [
      { role: "user", content: `问题 ${index}`, timestamp: index * 10 + 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: `回答 ${index}\n\n${"很长的一段内容。".repeat(40)}` }],
        timestamp: index * 10 + 2,
        stopReason: "stop"
      }
    ]).flat();
    await page.route(`**/api/tasks/${taskId}`, async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({ response, json: { ...detail, messages } });
    });
    await page.goto(`${dashboard.base}/?task=${taskId}`);
    await expect(page.locator("#conversation .chat-message.user")).toHaveCount(20);

    const tops = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const composer = document.querySelector(".composer-wrap");
          const seen = [composer.getBoundingClientRect().top];
          const started = performance.now();
          const tick = () => {
            seen.push(composer.getBoundingClientRect().top);
            if (performance.now() - started < 600) requestAnimationFrame(tick);
            else resolve(seen);
          };
          document.querySelector("#new-conversation").click();
          requestAnimationFrame(tick);
        })
    );
    await expect(page.locator(".new-session-start")).toBeVisible();
    const [foot, ...frames] = tops;
    const settled = frames.at(-1);
    expect(settled).toBeLessThan(foot);
    // Every painted frame sits between the foot it left and the middle it reaches.
    for (const top of frames) {
      expect(top).toBeGreaterThanOrEqual(settled - 1);
      expect(top).toBeLessThanOrEqual(foot + 1);
    }
  } finally {
    await dashboard.stop();
  }
});
