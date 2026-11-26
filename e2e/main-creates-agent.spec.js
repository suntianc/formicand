import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { waitForMarkedDelegations } from "../test/fixtures/delegation-wait.mjs";

const definition = {
  name: "db-migrator",
  description: "涉及表结构变更时派给它",
  permission: "write",
  tools: ["read", "bash"],
  prompt: "先在临时库演练。"
};

function systemText(body) {
  const system = body.messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
}

/** Main proposes the Agent, then delegates to it; a delegated process answers at once. */
function provider() {
  let mainStep = 0;
  const isSubagent = (body) => /Formicand Subagent/.test(systemText(body));
  return modelProtocolFixture(
    "openai-completions",
    waitForMarkedDelegations(
      (body) => {
        if (isSubagent(body)) return { text: "SUBAGENT_DONE" };
        mainStep += 1;
        if (mainStep === 1) return { name: "manage_agent", arguments: { action: "create", definition } };
        const last = body.messages.findLast((message) => message.role === "tool");
        const result = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
        if (mainStep === 2 && result.includes('"saved":true'))
          return {
            name: "call_subagent",
            arguments: { task: "加一个索引", wait: true, agent: "db-migrator" }
          };
        return { text: result.includes("SUBAGENT_DONE") ? "AGENT_USED" : "NOT_SAVED" };
      },
      (body) => !isSubagent(body)
    )
  );
}

test("Main drafts an Agent, the user confirms it on the card, and Main delegates to it", async ({ page }) => {
  const model = await provider();
  const dashboard = await startDashboard({ modelEndpoint: model.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("帮我建一个专门做数据库迁移的 Agent");
    await page.locator("#send-button").click();

    const card = page.locator("#human-questions .agent-proposal");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("h3")).toHaveText("db-migrator");
    await expect(card).toContainText("创建 Agent");
    await expect(card).toContainText(join(dashboard.env.FORMICAND_HOME, "agents", "db-migrator.md"));
    await expect(card).toContainText("涉及表结构变更时派给它");
    await expect(card).toContainText("可写");
    await expect(card).toContainText("先在临时库演练。");
    await expect(card.getByRole("button", { name: "发送修改意见" })).toBeHidden();
    const file = join(dashboard.env.FORMICAND_HOME, "agents", "db-migrator.md");
    expect(existsSync(file), "nothing is written before the user confirms").toBe(false);

    // The card takes focus from the hidden composer, so Enter alone confirms it.
    await expect(card.getByRole("button", { name: "确认创建" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-message.main").last()).toContainText("AGENT_USED", { timeout: 60_000 });
    expect(await readFile(file, "utf8")).toContain("name: db-migrator");
  } finally {
    await dashboard.stop();
    await model.close();
  }
});

test("'Edit in settings' writes nothing and opens the definition on the Agent page", async ({ page }) => {
  const model = await provider();
  const dashboard = await startDashboard({ modelEndpoint: model.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("帮我建一个 Agent");
    await page.locator("#send-button").click();
    const card = page.locator("#human-questions .agent-proposal");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: "在设置里修改" }).click();

    const settings = page.locator('[data-settings-panel="agents"]');
    await expect(settings).toBeVisible();
    await expect(settings.getByLabel("名称")).toHaveValue("db-migrator");
    await expect(settings.getByLabel("给 Main 的使用说明")).toHaveValue("涉及表结构变更时派给它");
    await expect(settings.getByLabel("附加提示词")).toHaveValue("先在临时库演练。");
    await settings.getByRole("button", { name: "保存" }).click();
    await expect(settings.locator("[data-agent-list]")).toContainText("db-migrator");
    expect(await readFile(join(dashboard.env.FORMICAND_HOME, "agents", "db-migrator.md"), "utf8")).toContain(
      "name: db-migrator"
    );
    // Main was told not to save it: its turn ends without using the Agent.
    await page.locator("#settings-back").click();
    await expect(page.locator(".chat-message.main").last()).toContainText("NOT_SAVED", { timeout: 60_000 });
  } finally {
    await dashboard.stop();
    await model.close();
  }
});

test("'Ask Main to write it' starts a conversation with the request ready to finish", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="agents"]').click();
    await page.getByRole("button", { name: "让 Main 帮我写" }).click();
    await expect(page.locator("#settings-entry")).toBeHidden();
    const input = page.locator("#composer-input");
    await expect(input).toHaveValue("帮我创建一个 Agent：");
    await expect(input).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});
