import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("a conversation shows its context window and estimated usage", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "上下文测试完成。" }));
  let dashboard;
  try {
    dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    const usage = page.locator("#context-usage");
    await expect(usage).toBeHidden();
    await page.locator("#composer-input").fill("请确认上下文用量。");
    await page.locator("#send-button").click();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("上下文测试完成。", {
      timeout: 30000
    });
    await expect(usage).toHaveText(/窗口 1 · \d+%/);
    await expect(usage).toHaveAttribute("title", /上下文已用 [\d,]+ \/ [\d,]+ tokens/);
    await page.locator("#new-conversation").click();
    await expect(usage).toBeHidden();
  } finally {
    await dashboard?.stop();
    await provider.close();
  }
});
