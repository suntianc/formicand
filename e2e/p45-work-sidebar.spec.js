import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createProject, createTask, markTaskRunning } from "./p45-work-helpers.js";

test("projects hold their Main sessions and Subagents, a running session is marked and folds persist", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const second = await createProject(page, dashboard, "第二个项目", `${dashboard.root}/second-project`);
    const projectId = dashboard.projectId;
    await createTask(page, dashboard, {
      taskId: "tree-rating",
      goal: "评分汇总验收",
      projectId
    });
    await createTask(page, dashboard, { taskId: "tree-timeout", goal: "修复登录超时", projectId });
    await createTask(page, dashboard, {
      taskId: "tree-docs",
      goal: "文档整理",
      projectId: second.projectId
    });
    await markTaskRunning(dashboard, {
      taskId: "tree-rating",
      runId: "run-tree",
      subagents: [
        { agentId: "subagent_1", role: "executor", state: "leased" },
        { agentId: "subagent_2", role: "reviewer", state: "queued" },
        // A finished Subagent leaves the tree; the conversation still shows its work.
        { agentId: "subagent_3", role: "executor" }
      ]
    });
    await page.goto(dashboard.base);

    const first = page.locator(`.project-group[data-project="${projectId}"]`);
    const secondProject = page.locator(`.project-group[data-project="${second.projectId}"]`);
    await expect(first.locator(".project-name")).toHaveText("测试项目");
    await expect(secondProject.locator(".project-name")).toHaveText("第二个项目");

    const rating = first.locator('.conversation-item[data-task="tree-rating"]');
    await expect(rating).toHaveText("评分汇总验收");
    await expect(rating).not.toHaveAttribute("aria-description");
    await expect(rating).toHaveAttribute("data-status", "running");
    await expect(rating.locator('.conversation-activity[data-state="running"]')).toHaveCount(1);

    // Each running Subagent wears its ant and counts its own time; a queued one waits.
    const subagents = first.locator(".subagent-row");
    await expect(subagents).toHaveCount(2);
    await expect(subagents.nth(0).locator(".subagent-name")).toHaveText("Atta");
    await expect(subagents.nth(0).locator(".agent-avatar")).toBeVisible();
    await expect(subagents.nth(0).locator(".subagent-time")).toHaveText(/^\d+:\d\d(:\d\d)?$/);
    await expect(subagents.nth(1).locator(".subagent-name")).toHaveText("Lasius");
    await expect(subagents.nth(1).locator(".subagent-time")).toHaveText("排队中");
    await expect(secondProject.locator(".subagent-row")).toHaveCount(0);

    await first.locator('[data-session-toggle="tree-rating"]').click();
    await expect(first.locator(".subagent-row")).toHaveCount(0);
    await expect(first.locator('[data-session-toggle="tree-rating"]')).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await first.locator('[data-session-toggle="tree-rating"]').click();
    await expect(first.locator(".subagent-row")).toHaveCount(2);

    await first.locator("[data-project-id]").click();
    await expect(first).toHaveClass(/collapsed/);
    await expect(first.locator(".project-count")).toHaveText("2");
    await expect(first.locator(".subagent-row").first()).toBeHidden();

    await page.reload();
    const reloaded = page.locator(`.project-group[data-project="${projectId}"]`);
    await expect(reloaded).toHaveClass(/collapsed/);
    await expect(reloaded.locator(".project-count")).toHaveText("2");
    await expect(reloaded.locator('.conversation-item[data-task="tree-rating"]')).toBeHidden();
    await reloaded.locator("[data-project-id]").click();
    await expect(reloaded.locator('.conversation-item[data-task="tree-rating"]')).toBeVisible();
    await expect(reloaded.locator(".subagent-row")).toHaveCount(2);
  } finally {
    await dashboard.stop();
  }
});

test("running indicator sits in the left indent without shifting session titles", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    const projectId = dashboard.projectId;
    await createTask(page, dashboard, { taskId: "solo-running", goal: "独立运行中的会话", projectId });
    await createTask(page, dashboard, { taskId: "solo-idle", goal: "空闲会话标题对齐", projectId });
    await createTask(page, dashboard, { taskId: "with-sub", goal: "带子代理运行会话", projectId });
    await createTask(page, dashboard, { taskId: "pinned-running", goal: "置顶运行会话", projectId });
    await markTaskRunning(dashboard, { taskId: "solo-running", runId: "run-solo" });
    await markTaskRunning(dashboard, {
      taskId: "with-sub",
      runId: "run-sub",
      subagents: [{ agentId: "subagent_1", role: "executor", state: "leased" }]
    });
    await markTaskRunning(dashboard, { taskId: "pinned-running", runId: "run-pinned" });
    await page.request.patch(`${dashboard.base}/api/tasks/pinned-running`, {
      data: { pinned: true }
    });
    await page.goto(dashboard.base);

    const group = page.locator(`.project-group[data-project="${projectId}"]`);
    await expect(group.locator('[data-task="solo-running"] .conversation-activity')).toBeVisible();
    await expect(
      page.locator('#pinned-section [data-task="pinned-running"] .conversation-activity')
    ).toBeVisible();

    const boxes = await page.evaluate((pid) => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const project = document.querySelector(`.project-group[data-project="${pid}"]`);
      const pinned = document.querySelector("#pinned-section");
      return {
        folder: box(project.querySelector(".project-folder")),
        projectName: box(project.querySelector(".project-name")),
        idleTitle: box(project.querySelector('[data-task="solo-idle"] .conversation-title-text')),
        soloTitle: box(project.querySelector('[data-task="solo-running"] .conversation-title-text')),
        soloSpinner: box(project.querySelector('[data-task="solo-running"] .conversation-activity')),
        soloRow: box(project.querySelector('[data-task="solo-running"]').closest(".conversation-row")),
        subToggle: box(project.querySelector('[data-session-toggle="with-sub"]')),
        subSpinner: box(project.querySelector('[data-task="with-sub"] .conversation-activity')),
        subTitle: box(project.querySelector('[data-task="with-sub"] .conversation-title-text')),
        pinnedRow: box(pinned.querySelector('[data-task="pinned-running"]').closest(".conversation-row")),
        pinnedSpinner: box(pinned.querySelector('[data-task="pinned-running"] .conversation-activity')),
        pinnedTitle: box(pinned.querySelector('[data-task="pinned-running"] .conversation-title-text'))
      };
    }, projectId);

    // Running session without subagents aligns with idle sessions and the project title.
    expect(Math.abs(boxes.soloTitle.x - boxes.idleTitle.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes.soloTitle.x - boxes.projectName.x)).toBeLessThanOrEqual(1);
    // Its spinner sits centered in the left indent beneath the project folder icon.
    expect(boxes.soloSpinner.x).toBeGreaterThanOrEqual(boxes.folder.x);
    expect(boxes.soloSpinner.right).toBeLessThanOrEqual(boxes.folder.right);
    expect(boxes.soloSpinner.y).toBeGreaterThanOrEqual(boxes.soloRow.y);
    expect(boxes.soloSpinner.bottom).toBeLessThanOrEqual(boxes.soloRow.bottom);
    // A session with a subagent disclosure shows its spinner in the chevron's place,
    // so its title starts where the button's own padding puts it.
    expect(boxes.subSpinner.x).toBeGreaterThanOrEqual(boxes.subToggle.x);
    expect(boxes.subSpinner.right).toBeLessThanOrEqual(boxes.subToggle.right);
    expect(Math.abs(boxes.subTitle.x - boxes.idleTitle.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes.subSpinner.x - boxes.soloSpinner.x)).toBeLessThanOrEqual(1);
    // Pinned rows have no left indent; their spinner stays inside the row before the title.
    expect(boxes.pinnedSpinner.x).toBeGreaterThanOrEqual(boxes.pinnedRow.x);
    expect(boxes.pinnedSpinner.right).toBeLessThanOrEqual(boxes.pinnedTitle.x);
  } finally {
    await dashboard.stop();
  }
});
