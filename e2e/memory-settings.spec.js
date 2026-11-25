import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { expectNoHorizontalOverflow, openSettings } from "./settings-helper.js";

/**
 * Settings → Memory: the user reads, adds, edits, renames and deletes what
 * Main remembers, and switches one project's memory off.
 */
test("memories are added, edited, renamed and deleted, and a project's memory switches off", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const home = dashboard.env.FORMICAND_HOME;
    const seeded = await page.request.post(`${dashboard.base}/api/memory/save`, {
      data: {
        target: { scope: "user" },
        memory: {
          name: "reply-in-chinese",
          type: "user",
          description: "回复用中文大白话",
          body: "用户英文不好，回复少夹英文术语。"
        }
      }
    });
    expect(seeded.status()).toBe(200);

    await page.goto(dashboard.base);
    const settings = await openSettings(page, "memory");
    const list = settings.locator("[data-memory-list]");
    await expect(list.locator("[data-memory-select]")).toHaveCount(1);
    await expect(list.getByRole("button", { name: /reply-in-chinese/ })).toContainText("用户");
    await expectNoHorizontalOverflow(page, settings.locator(".settings-content"));

    // Edit the body and rename it in one save.
    await list.getByRole("button", { name: /reply-in-chinese/ }).click();
    const detail = settings.locator("[data-memory-detail]");
    await expect(detail.locator('[data-memory-field="body"]')).toHaveValue(
      "用户英文不好，回复少夹英文术语。"
    );
    await detail.locator('[data-memory-field="name"]').fill("plain-chinese");
    await detail.locator('[data-memory-field="body"]').fill("回复用中文大白话，少夹英文。");
    await detail.getByRole("button", { name: "保存" }).click();
    await expect(list.getByRole("button", { name: /plain-chinese/ })).toBeVisible();
    await expect(list.locator("[data-memory-select]")).toHaveCount(1);
    expect(existsSync(join(home, "memory", "user", "reply-in-chinese.md"))).toBe(false);
    expect(await readFile(join(home, "memory", "user", "plain-chinese.md"), "utf8")).toContain(
      "回复用中文大白话，少夹英文。"
    );

    // A bad name is refused and the draft stays.
    await settings.locator("[data-memory-add]").click();
    await detail.locator('[data-memory-field="name"]').fill("Bad Name");
    await detail.locator('[data-memory-field="description"]').fill("一句话");
    await detail.locator('[data-memory-field="body"]').fill("正文");
    await detail.getByRole("button", { name: "保存" }).click();
    await expect(page.locator("#toast")).toContainText("小写字母");
    await expect(detail.locator('[data-memory-field="name"]')).toHaveValue("Bad Name");

    // Project scope: add one, then switch the project's memory off.
    await settings.locator('[data-memory-scope-value="project"]').click();
    await expect(list.locator(".skill-empty")).toHaveText("还没有记忆");
    await settings.locator("[data-memory-add]").click();
    await detail.locator('[data-memory-field="name"]').fill("ticket-split");
    await detail.locator('[data-memory-field="type"]').selectOption("project");
    await detail.locator('[data-memory-field="description"]').fill("拆票要等真实需求再测");
    await detail.locator('[data-memory-field="body"]').fill("用户要用真实需求测拆票，暂不改提示词。");
    await detail.getByRole("button", { name: "保存" }).click();
    await expect(list.getByRole("button", { name: /ticket-split/ })).toContainText("项目情况");
    const enabled = settings.locator("[data-memory-enabled]");
    await expect(enabled).toBeChecked();
    await enabled.uncheck();
    await expect(enabled).not.toBeChecked();
    const view = await page.request.get(
      `${dashboard.base}/api/memory?scope=project&projectId=${encodeURIComponent(dashboard.projectId)}`
    );
    expect((await view.json()).enabled).toBe(false);

    // Delete asks first.
    await list.getByRole("button", { name: /ticket-split/ }).click();
    await detail.getByRole("button", { name: "删除" }).click();
    const confirm = page.getByRole("dialog", { name: "删除 ticket-split？" });
    await confirm.getByRole("button", { name: "删除" }).click();
    await expect(list.locator(".skill-empty")).toHaveText("还没有记忆");
    expect(existsSync(join(home, "memory", "projects", dashboard.projectId, "ticket-split.md"))).toBe(false);
  } finally {
    await dashboard.stop();
  }
});
