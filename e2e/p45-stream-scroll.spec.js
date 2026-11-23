import { test, expect } from "@playwright/test";
import { createTask } from "./p45-work-helpers.js";
import { cloneRounds, longReply, startPerfDashboard } from "./perf/fixture.js";

/**
 * Scrolling while a reply streams (#24): sending shows the new message once,
 * then the reader's position decides. Scrolling up is not pulled back to the
 * end by each streamed piece.
 */
test("a reader scrolled up while a reply streams stays where they are", async ({ page }) => {
  const local = await startPerfDashboard();
  const finals = page.locator('.chat-message.main[data-answer-kind="final"]');
  const scroll = page.locator("#conversation");
  const fromEnd = () => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    local.queue.push({ text: longReply(0) });
    await createTask(page, local, { taskId: "stream", goal: "流式滚动", projectId: local.projectId });
    await page.goto(local.base);
    await page.locator('.conversation-item[data-task="stream"]').click();
    await page.locator("#composer-input").fill("第一轮");
    await page.locator("#send-button").click();
    await expect(finals).toHaveCount(1);
    await expect(page.locator("#run-control")).toBeHidden();
    await cloneRounds(local.workspaceRoot, "stream", 6);
    await page.reload();
    await page.locator('.conversation-item[data-task="stream"]').click();
    await expect(finals).toHaveCount(6);

    // Sending from the top of the conversation brings the new message into view.
    await scroll.evaluate((node) => (node.scrollTop = 0));
    local.queue.push({ stream: Array.from({ length: 160 }, (_, index) => `第 ${index} 段，`), interval: 20 });
    await page.locator("#composer-input").fill("再来一轮");
    await page.locator("#send-button").click();
    await expect(page.locator('.chat-message.main[aria-busy="true"]')).toBeVisible();
    await expect.poll(fromEnd).toBeLessThan(100);

    // While it streams, the reader scrolls up and stays there.
    await expect(page.locator('.chat-message.main[aria-busy="true"]')).toContainText("第 0 段");
    await scroll.evaluate((node) => (node.scrollTop = 0));
    for (let step = 0; step < 8; step += 1) {
      await page.waitForTimeout(150);
      expect(await scroll.evaluate((node) => node.scrollTop)).toBeLessThan(10);
    }
    await expect(page.locator('.chat-message.main[aria-busy="true"]')).toBeVisible();
    await expect(finals).toHaveCount(7);
    expect(await scroll.evaluate((node) => node.scrollTop)).toBeLessThan(10);
  } finally {
    await local.stop();
  }
});

test("small upward wheel scrolls pause streaming follow until the reader returns to the end", async ({
  page
}) => {
  const local = await startPerfDashboard();
  const whileReading = Promise.withResolvers();
  const afterReturn = Promise.withResolvers();
  try {
    await createTask(page, local, { taskId: "wheel", goal: "阅读流式回复", projectId: local.projectId });
    await page.goto(local.base);
    await page.locator('[data-task="wheel"].conversation-item').click();
    local.queue.push({ stream: [longReply(0), whileReading.promise, afterReturn.promise] });
    await page.locator("#composer-input").fill("请输出长回复");
    await page.locator("#send-button").click();
    const scroll = page.locator("#conversation");
    const height = () => scroll.evaluate((node) => node.scrollHeight);
    const gap = () => scroll.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
    const box = await scroll.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const beforeWheel = await scroll.evaluate((node) => node.scrollTop);
    await page.mouse.wheel(0, -36);
    await expect.poll(gap).toBeGreaterThanOrEqual(35);
    const firstHeight = await height();
    whileReading.resolve("\n\n" + longReply(1));
    await expect.poll(height).toBeGreaterThan(firstHeight + 100);
    expect(await scroll.evaluate((node) => node.scrollTop)).toBeLessThan(beforeWheel);

    await page.mouse.wheel(0, 8000);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    const resumedHeight = await height();
    afterReturn.resolve("\n\n" + longReply(2));
    await expect.poll(height).toBeGreaterThan(resumedHeight + 100);
    expect(await gap()).toBeLessThanOrEqual(1);
  } finally {
    whileReading.resolve("");
    afterReturn.resolve("");
    await local.stop();
  }
});
