import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, publishNamedArtifact, seedRequirement } from "./p45-requirement-fixture.js";

test("long criteria, changes and attachments fold, and the phase reads as one line over a dot track", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "project");
    await mkdir(directory, { recursive: true });
    const created = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "折叠验收", projectDirectory: directory }
    });
    expect(created.status()).toBeLessThan(300);
    const project = (await created.json()).project;
    await configureMerge(page, dashboard, project, directory);
    const criteria = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 条标准，${"说明".repeat(30)}`);
    // The checkout adds seven files; the largest change is `big.ts`.
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`f${index}.ts`, "x\n".repeat(index + 1)])
    );
    files["big.ts"] = "x\n".repeat(40);
    const records = await seedRequirement(page, dashboard, project, {
      phase: "review",
      title: "折叠",
      criteria,
      files
    });
    const taskId = records.session.taskId;
    for (const index of [1, 2, 3, 4, 5, 6, 7])
      await publishNamedArtifact(page, dashboard, taskId, {
        relativePath: `loose-${index}.md`,
        content: `# ${index}\n`
      });
    for (const name of ["a.md", "b.csv", "c.png"])
      await publishNamedArtifact(page, dashboard, taskId, {
        relativePath: `reports/${name}`,
        content: "x"
      });

    await page.goto(`${dashboard.base}/?task=${encodeURIComponent(taskId)}`);
    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");

    // ---- the phase: one status line over five dots ----------------------------
    await expect(panel.locator(".rp-status-label")).toHaveText("审查中");
    await expect(panel.locator(".rp-status-meta")).toHaveText(/^Reviewer /);
    await expect(panel.locator(".rp-step")).toHaveCount(5);
    // Once a finished step's pop settles, every dot sits on one row.
    await expect
      .poll(
        async () =>
          new Set(
            await panel
              .locator(".rp-step .rp-node")
              .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)))
          ).size
      )
      .toBe(1);

    // ---- criteria: one line each, five shown, the rest folded --------------------
    const checks = panel.locator(".rp-check");
    await expect(checks).toHaveCount(5);
    const heights = await checks.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height)
    );
    for (const height of heights) expect(height).toBeLessThan(24);
    await expect(checks.first()).toHaveAttribute("title", criteria[0]);
    await expect(panel.locator(".rp-count.is-end")).toHaveText(/^\d \/ 8$/);
    const moreCriteria = panel.locator('[data-unfold="criteria"]');
    await expect(moreCriteria).toHaveText("其余 3 条");
    await moreCriteria.click();
    await expect(checks).toHaveCount(8);
    await expect(moreCriteria).toHaveAttribute("aria-expanded", "true");
    await expect(moreCriteria).toBeFocused();

    // ---- changes: the three largest, then the rest ---------------------------
    const diffFiles = panel.locator(".rp-diff-file");
    await expect(diffFiles).toHaveCount(3);
    await expect(diffFiles.first()).toContainText("big.ts");
    const moreDiff = panel.locator('[data-unfold="diff"]');
    await expect(moreDiff).toHaveText(/^其余 \d+ 个$/);
    await moreDiff.click();
    expect(await diffFiles.count()).toBeGreaterThan(5);

    // ---- attachments: loose files fold past three, folders fold whole ----------
    const list = panel.locator("#output-list");
    await expect(list.locator(".rp-attachment")).toHaveCount(3);
    const folder = list.locator('[data-unfold="folder:reports"]');
    await expect(folder).toContainText("reports");
    await expect(folder.locator(".rp-folder-count")).toHaveText("3");
    await expect(list.locator('[data-unfold="attachments"]')).toHaveText("其余 4 个");
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await expect(list.locator(".rp-attachment.is-nested")).toHaveCount(3);
    await expect(list.locator('[data-artifact="reports/b.csv"]')).toContainText("b.csv");
    await list.locator('[data-unfold="attachments"]').click();
    await expect(list.locator(".rp-attachment:not(.is-nested)")).toHaveCount(7);
  } finally {
    await dashboard.stop();
  }
});
