import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedRequirement } from "./p45-requirement-fixture.js";

/**
 * The observation detail reads one requirement's recorded facts.
 *
 * Each section is asserted against the records a real backend published —
 * phase, handling session, owner, merge, ledger revision, completion criteria,
 * review conclusion and change size — and the view must not offer to open the
 * session or the diff, because observation is read-only.
 */
test.setTimeout(120_000);

test("the detail shows the recorded requirement and offers no session or diff", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "project");
    await mkdir(directory, { recursive: true });
    const response = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "P4 验收示例项目", projectDirectory: directory }
    });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const project = (await response.json()).project;
    await configureMerge(page, dashboard, project, directory);
    await seedRequirement(page, dashboard, project, {
      phase: "delivered",
      title: "按分数文件汇总总分",
      description: "把分数文件里的分数加起来输出总分。",
      aliases: ["算总分"],
      ledger: {
        summary: "summarize.sh 读 CSV，输出 total；只有 header 时输出 0。",
        history: "加了 summarize.sh"
      },
      criteria: ["bash summarize.sh 输出 30", "只有 header 的 CSV 输出 0", "文件不存在时退出码 1"],
      findings: [
        { title: "给 summarize.sh 增加参数校验" },
        { title: "README 补充用法示例" },
        { title: "失败时输出可读原因" }
      ]
    });

    await page.goto(dashboard.base);
    await page.getByRole("tab", { name: "观测", exact: true }).click();
    await page.locator('[data-observe-view="requirements"]').click();
    const row = page.locator("[data-observe-requirement]").filter({ hasText: "按分数文件汇总总分" });
    await expect(row).toContainText("已交付");
    await row.click();

    const detail = page.locator("#observe-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator(".or-crumb")).toHaveText("需求详情");
    await expect(detail.locator(".or-detail-title")).toHaveText("按分数文件汇总总分");

    // The feature as the ledger keeps it: what it is, how it behaves now, its
    // other names, what each development changed and every development.
    await expect(detail.locator(".or-description")).toHaveText("把分数文件里的分数加起来输出总分。");
    await expect(detail.locator('[data-or-section="summary"] .or-summary')).toHaveText(
      "summarize.sh 读 CSV，输出 total；只有 header 时输出 0。"
    );
    await expect(detail.locator(".or-alias")).toHaveText(["算总分"]);
    await expect(detail.locator('[data-or-section="history"] li')).toHaveCount(1);
    await expect(detail.locator('[data-or-section="history"] li')).toContainText("加了 summarize.sh");
    const developments = detail.locator('[data-or-section="developments"]');
    await expect(developments.locator(".rp-label")).toHaveText("历次开发");
    await expect(developments.locator(".rp-count")).toHaveText("1");
    await expect(developments.locator(".or-development-state")).toHaveText(/^已合入 · [0-9a-f]{8}$/);
    await expect(detail.locator(".rp-status-label")).toHaveText("已交付");
    await expect(detail.locator(".or-tag")).toHaveText(["内部", "Full"]);

    // The phase strip highlights the current phase and marks the settled ones.
    const stepper = detail.locator(".rp-stepper");
    await expect(stepper).toHaveAttribute("data-stage", "delivered");
    await expect(stepper.locator(".rp-step")).toHaveCount(5);
    expect(
      await stepper.locator(".rp-step").evaluateAll((nodes) => nodes.map((node) => node.dataset.state))
    ).toEqual(["done", "done", "done", "done", "done"]);

    // The facts come from the records: the Main session that handled it, the
    // current owner, the merged commit and the ledger revision.
    const facts = detail.locator(".or-fact");
    await expect(facts.nth(0)).toContainText("处理会话");
    await expect(facts.nth(0)).toContainText("按分数文件汇总总分");
    await expect(facts.nth(1)).toContainText("归属人");
    await expect(facts.nth(2)).toContainText("合入");
    await expect(facts.nth(2).locator(".or-fact-value")).toHaveText(/^main · [0-9a-f]{8}$/);
    await expect(facts.nth(3).locator(".or-fact-value")).toHaveText(/^v\d+ · 在用$/);

    // A passed review and the merge confirm every completion criterion.
    const criteria = detail.locator('[data-or-section="criteria"]');
    await expect(criteria.locator(".rp-label")).toHaveText("完成标准");
    await expect(criteria.locator(".rp-count")).toHaveText("3 / 3");
    expect(
      await criteria.locator(".rp-check").evaluateAll((nodes) => nodes.map((node) => node.dataset.checked))
    ).toEqual(["true", "true", "true"]);

    // The review conclusion names the verdict and how many blocking findings
    // were let through; expanding it lists them with why.
    const review = detail.locator('[data-or-section="review"]');
    await expect(review.locator(".or-review-text")).toHaveText("独立审查通过");
    await expect(review.locator(".or-review-findings")).toHaveText("放行 3");
    await expect(review.locator(".or-findings")).toBeHidden();
    await review.locator("[data-observe-review]").click();
    await expect(review.locator(".or-findings")).toBeVisible();
    await expect(review.locator(".or-findings li")).toHaveCount(3);
    await expect(review.locator(".or-findings li").first()).toContainText("已放行");

    // The change is only the file and its line counts.
    const change = detail.locator('[data-or-section="change"]');
    await expect(change.locator(".rp-diff-file")).toHaveCount(2);
    await expect(change.locator(".rp-diff-file").nth(0)).toContainText("notes.md");
    await expect(change.locator(".rp-diff-file").nth(0).locator(".rp-add")).toHaveText("+1");
    await expect(change.locator(".rp-diff-file").nth(1).locator(".rp-file-name")).toHaveText("summarize.sh");

    // Observation never opens a session or a diff.
    await expect(page.getByRole("button", { name: "打开会话" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "查看 diff" })).toHaveCount(0);
    await expect(page.locator("#observe-detail")).not.toContainText("查看 diff");
    await expect(page.locator("#observe-detail a")).toHaveCount(0);

    // The three legacy dialogs and their sidebar entries are gone.
    for (const selector of ["#ledger-nav", "#board-nav", "#development-nav", ".ledger-card", ".board-card"])
      await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "需求台账", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "需求看板", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "需求现场", exact: true })).toHaveCount(0);

    // Closing the detail returns to the list alone.
    await detail.locator("[data-observe-detail-close]").click();
    await expect(detail).toBeHidden();
    // The project's misc requirement has no development, so it is not listed.
    await expect(page.locator("[data-observe-requirement]")).toHaveCount(1);
  } finally {
    await dashboard.stop();
  }
});
