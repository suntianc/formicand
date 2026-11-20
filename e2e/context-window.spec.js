import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("the composer switches windows and the conversation shows usage and the handoff", async ({ page }) => {
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
    await expect(usage).toHaveText(/^上下文 \d+%$/);
    await expect(usage).toHaveAttribute("title", /上下文窗口 1 · 已用 [\d,]+ \/ [\d,]+ tokens/);
    const count = provider.requests.length;
    await page.locator("#composer-input").fill("/compact");
    await page.locator("#send-button").click();
    const divider = page.locator(".context-window-divider");
    await expect(divider.getByText("新的上下文窗口")).toBeVisible({ timeout: 20000 });
    await expect(usage).toHaveAttribute("title", /上下文窗口 2 · /);
    await expect(divider.locator("details")).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue("");
    // The window change asks the model for one summary and starts no turn.
    expect(provider.requests).toHaveLength(count + 1);
    await page.locator("#new-conversation").click();
    await expect(usage).toBeHidden();
  } finally {
    await dashboard?.stop();
    await provider.close();
  }
});
