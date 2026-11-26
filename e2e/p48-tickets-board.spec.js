import { agentDisplayName } from "../web/assets/agent-names.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openObservation } from "./p45-observe-fixture.js";
import { REMOTE_BACKEND, configureMerge, seedRequirement } from "./p45-requirement-fixture.js";

/**
 * The page and Main read one ticket record.
 *
 * A requirement split into three tickets — one brought into the requirement
 * checkout, one in review and one waiting for it — is recorded through the same
 * HTTP facts an execution backend relays. The work panel, the observation
 * detail and the overview's phase columns must all show those tickets and the
 * requirement's own phase: development until every ticket is written, even
 * though one ticket is in review and the last review recorded passed.
 */
test.setTimeout(120_000);

test("tickets and the phase they set show in the work panel, the detail and the overview", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "project");
    await mkdir(directory, { recursive: true });
    const response = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "票的显示", projectDirectory: directory }
    });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const project = (await response.json()).project;
    await configureMerge(page, dashboard, project, directory);
    const records = await seedRequirement(page, dashboard, project, {
      phase: "development",
      title: "分三张票的需求"
    });
    const developmentId = records.development.developmentId;
    const tickets = async (body) => {
      const result = await page.request.post(
        `${dashboard.base}/api/projects/${encodeURIComponent(project.projectId)}/developments`,
        {
          data: { action: "write_tickets", developmentId, ...body },
          headers: { "content-type": "application/json", "x-formicand-backend-id": REMOTE_BACKEND }
        }
      );
      const payload = await result.json();
      expect(result.status(), JSON.stringify(payload)).toBeLessThan(300);
      return payload.tickets;
    };
    const ticket = (ticketId, title, dependsOn = []) => ({
      ticketId,
      title,
      scope: ["summarize.sh"],
      criteria: [{ text: `${title}可用`, command: "true" }],
      dependsOn
    });
    let set = await tickets({
      op: "propose",
      tickets: [ticket("01", "读取分数文件"), ticket("02", "汇总总分"), ticket("03", "输出说明", ["02"])]
    });
    set = await tickets({ op: "confirm", expectedRevision: set.revision });
    const work = (callId) => ({
      callId,
      agentId: `agent-${callId}`,
      workspace: join(dashboard.root, callId)
    });
    await tickets({ op: "start", ticketId: "01", work: work("call-1") });
    await page.goto(`${dashboard.base}/?task=${encodeURIComponent(records.session.taskId)}`);
    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");
    await expect(panel.locator('[data-step="development"] .rp-step-meta')).toHaveText(
      `Executor ${agentDisplayName("agent-call-1")}`
    );
    await tickets({ op: "review", ticketId: "01", reviewId: "review-ticket-01" });
    await tickets({ op: "verdict", ticketId: "01", passed: true });
    await tickets({
      op: "integrate",
      ticketId: "01",
      integration: {
        commit: records.checkout.candidate,
        tree: records.checkout.tree,
        itemCommit: records.checkout.candidate,
        checks: [],
        at: new Date().toISOString()
      }
    });
    await tickets({ op: "start", ticketId: "02", work: work("call-2") });
    await tickets({ op: "review", ticketId: "02", reviewId: "review-ticket-02" });

    await expect(panel.locator(".rp-stepper")).toHaveAttribute("data-stage", "development");
    // Development and review are rings cut per ticket: 01 and 02 are written, 01 passed review.
    await expect(panel.locator('[data-step="development"] .rp-arc')).toHaveCount(3);
    await expect(panel.locator('[data-step="development"] .rp-arc.is-done')).toHaveCount(2);
    await expect(panel.locator('[data-step="review"] .rp-arc.is-done')).toHaveCount(1);
    const rows = panel.locator(".rp-ticket");
    await expect(rows).toHaveCount(3);
    await expect(panel.locator(".rp-section:has(.rp-tickets) .rp-label")).toHaveText("票 1/3 已并入");
    expect(
      await rows.evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector(".rp-ticket-id").textContent,
          node.dataset.ticketState,
          node.querySelector(".rp-ticket-state").textContent
        ])
      )
    ).toEqual([
      ["01", "merged", "已并入"],
      ["02", "in_review", "审查中"],
      ["03", "confirmed", "已确认"]
    ]);
    // One ticket in, two to go: the requirement's criteria are not met yet.
    expect(
      await panel.locator(".rp-check").evaluateAll((nodes) => nodes.map((node) => node.dataset.checked))
    ).toEqual(["false", "false"]);

    // The observation detail reads the same record.
    await openObservation(page);
    await page.locator('[data-observe-view="requirements"]').click();
    const row = page.locator("[data-observe-requirement]").filter({ hasText: "分三张票的需求" });
    await expect(row).toContainText("开发中");
    await row.click();
    const section = page.locator('#observe-detail [data-or-section="tickets"]');
    await expect(section.locator(".rp-label")).toHaveText("票 1/3 已并入");
    await expect(section.locator("li")).toHaveCount(3);
    await expect(section.locator("li").nth(2)).toContainText("在 02 之后");

    // The overview's phase columns count it under development.
    await page.locator('[data-observe-view="overview"]').click();
    const matrix = page.locator(`[data-observe-matrix-project="${project.projectId}"]`);
    await expect(matrix.locator('[data-matrix-stage="development"]')).toHaveText("1");
    await expect(matrix.locator('[data-matrix-stage="review"]')).toHaveText("·");
  } finally {
    await dashboard.stop();
  }
});
