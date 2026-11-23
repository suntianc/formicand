import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTask } from "../p45-work-helpers.js";
import { cloneRounds, longReply, startPerfDashboard } from "./fixture.js";

/**
 * What a wait costs: the page idle on a conversation, then the same page
 * while Main thinks with no words arriving. Chromium's own process table
 * gives the CPU time of the page's renderer and of the GPU process over the
 * same window, so a mark that keeps animating shows up in both. Results are
 * printed and written to test-results/perf/; no budget is asserted.
 *
 * PERF_CSS adds rules to the page before measuring (to try a change without
 * building it), PERF_SHOT saves a screenshot of the idle page, and
 * PERF_SETTLE_MS sets how long a state settles before its window.
 */
const ROUNDS = Number(process.env.PERF_ROUNDS || 20);
const WINDOW_MS = Number(process.env.PERF_WINDOW_MS || 5_000);
const SETTLE_MS = Number(process.env.PERF_SETTLE_MS || 3_000);
const LABEL = process.env.PERF_LABEL || "current";

/** CPU seconds so far, summed per process type. */
async function cpuTimes(cdp) {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  const totals = {};
  for (const process of processInfo) totals[process.type] = (totals[process.type] ?? 0) + process.cpuTime;
  return totals;
}

/** The page's layout and style recalculation counts so far. */
async function lifecycle(pageCdp) {
  const { metrics } = await pageCdp.send("Performance.getMetrics");
  const value = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { layouts: value("LayoutCount"), styles: value("RecalcStyleCount") };
}

/**
 * Each process type's share of one core over `WINDOW_MS`, in percent, and how
 * often the page was laid out and restyled meanwhile: a mark that animates on
 * the main thread relays the page every frame, which costs with its size.
 */
async function sample(page, cdp, pageCdp) {
  const before = await cpuTimes(cdp);
  const pageBefore = await lifecycle(pageCdp);
  await page.waitForTimeout(WINDOW_MS);
  const after = await cpuTimes(cdp);
  const pageAfter = await lifecycle(pageCdp);
  return {
    ...Object.fromEntries(
      Object.keys(after).map((type) => [
        type,
        Math.round(((after[type] - (before[type] ?? 0)) / (WINDOW_MS / 1000)) * 1000) / 10
      ])
    ),
    layouts: pageAfter.layouts - pageBefore.layouts,
    styles: pageAfter.styles - pageBefore.styles
  };
}

test(`waiting on a ${ROUNDS}-round conversation costs about what idling does`, async ({ page }) => {
  const local = await startPerfDashboard();
  const finals = page.locator('.chat-message.main[data-answer-kind="final"]');
  const report = { label: LABEL, rounds: ROUNDS, windowMs: WINDOW_MS, at: new Date().toISOString() };
  let release;
  try {
    local.queue.push(
      { tool: { id: "step-1", command: "echo first step" } },
      { tool: { id: "step-2", command: "printf 'second\\nstep\\n'" } },
      { text: longReply(0) }
    );
    await createTask(page, local, { taskId: "perf", goal: "等待开销", projectId: local.projectId });
    await page.goto(local.base);
    await page.locator('.conversation-item[data-task="perf"]').click();
    await page.locator("#composer-input").fill("第一轮");
    await page.locator("#send-button").click();
    await expect(finals).toHaveCount(1);
    await expect(page.locator("#run-control")).toBeHidden();
    await cloneRounds(local.workspaceRoot, "perf", ROUNDS);
    await page.reload();
    await page.locator('.conversation-item[data-task="perf"]').click();
    await expect(finals).toHaveCount(ROUNDS);

    // An experiment's extra rules, applied to the page as it stands.
    if (process.env.PERF_CSS) await page.addStyleTag({ content: process.env.PERF_CSS });
    const cdp = await page.context().browser().newBrowserCDPSession();
    const pageCdp = await page.context().newCDPSession(page);
    await pageCdp.send("Performance.enable");
    await page.waitForTimeout(SETTLE_MS);
    report.idle = await sample(page, cdp, pageCdp);
    if (process.env.PERF_SHOT) await page.screenshot({ path: process.env.PERF_SHOT });

    local.queue.push({ hold: new Promise((done) => (release = done)) });
    await page.locator("#composer-input").fill("再想一想");
    await page.locator("#send-button").click();
    await expect(page.locator('[data-answer-kind="pending"]')).toContainText("思考中");
    await expect(page.locator("#run-control")).toBeVisible();
    // The marks have finished whatever they do when the wait begins.
    await page.waitForTimeout(SETTLE_MS);
    report.waiting = await sample(page, cdp, pageCdp);

    release();
    await expect(finals).toHaveCount(ROUNDS + 1);
  } finally {
    release?.();
    console.log(JSON.stringify(report, null, 2));
    const folder = join("test-results", "perf");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `waiting-${LABEL}.json`), JSON.stringify(report, null, 2));
    await local.stop();
  }
});
