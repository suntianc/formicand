import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { expectNoHorizontalOverflow, openSettings } from "./settings-helper.js";

async function seedReferences(home) {
  await mkdir(join(home, "skills", "pg-migration"), { recursive: true });
  await writeFile(
    join(home, "skills", "pg-migration", "SKILL.md"),
    "---\nname: pg-migration\ndescription: 迁移\n---\n"
  );
  await writeFile(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { postgres: { command: "postgres-mcp" } } })
  );
}

test("global Agents: built-ins are read-only, a copy is edited, saved, switched off and deleted", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const home = dashboard.env.ATRIA_HOME;
    await seedReferences(home);
    await page.goto(dashboard.base);
    const settings = await openSettings(page, "agents");
    const list = settings.locator("[data-agent-list]");
    const detail = settings.locator("[data-agent-detail]");
    await expect(list.locator(".agent-group")).toHaveText(["内置只读"]);
    await expect(list.locator(".skill-row")).toHaveCount(2);

    // A built-in shows its shape and cannot be changed, only copied.
    await list.getByRole("button", { name: /reviewer/ }).click();
    await expect(detail.getByLabel("名称")).toBeDisabled();
    await expect(detail.getByRole("button", { name: "保存" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "删除" })).toHaveCount(0);
    await detail.getByRole("button", { name: "复制" }).click();
    await expect(detail.getByLabel("名称")).toHaveValue("reviewer-copy");

    // Read permission cannot hold write tools.
    await expect(detail.locator('[data-agent-tool][value="edit"]')).toBeDisabled();
    await detail.getByLabel("名称").fill("db-migrator");
    await detail.getByLabel("给 Main 的使用说明").fill("涉及表结构变更时派给它");
    await detail.getByText("可写", { exact: true }).click();
    await expect(detail.locator('[data-agent-tool][value="edit"]')).toBeEnabled();
    await detail.locator('[data-agent-tool][value="edit"]').check();
    await detail.getByRole("radio", { name: "只用指定的" }).click();
    await detail.getByLabel("添加技能").selectOption("pg-migration");
    await detail.getByLabel("添加 MCP 服务").selectOption("postgres");
    await detail.getByLabel("附加提示词").fill("先在临时库演练。");
    await expectNoHorizontalOverflow(page, settings.locator(".settings-content"));
    await detail.getByRole("button", { name: "保存" }).click();

    await expect(list.locator(".agent-group")).toHaveText(["内置只读", "全局~/.atria/agents"]);
    const row = list.getByRole("button", { name: /db-migrator/ });
    await expect(row).toContainText("可写 · 1 技能 · 1 MCP");
    const file = join(home, "agents", "db-migrator.md");
    const saved = await readFile(file, "utf8");
    expect(saved).toContain("permission: write");
    expect(saved).toContain("skills: [pg-migration]");
    expect(saved).toContain("mcp: [postgres]");
    expect(saved).toContain("先在临时库演练。");

    // Switched off, it is marked; a reference that disappears is named.
    await detail.getByRole("switch", { name: "启用" }).click();
    await expect(row).toContainText("已停用");
    expect(await readFile(file, "utf8")).toContain("enabled: false");
    await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    await settings.locator('[data-agent-scope-value="project"]').click();
    await settings.locator('[data-agent-scope-value="global"]').click();
    await list.getByRole("button", { name: /db-migrator/ }).click();
    await expect(list.getByRole("button", { name: /db-migrator/ })).toContainText("引用失效");
    await expect(detail).toContainText("MCP 服务 postgres 未配置");

    await detail.getByRole("button", { name: "删除" }).click();
    const confirm = page.getByRole("dialog", { name: "删除 db-migrator？" });
    await expect(confirm).toContainText("之后再派给它会报错");
    await confirm.getByRole("button", { name: "删除" }).click();
    await expect(list.locator(".skill-row")).toHaveCount(2);
  } finally {
    await dashboard.stop();
  }
});

test("a project with its own Agents is asked about once; trusted, its Agents are listed and offered by @", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const home = dashboard.env.ATRIA_HOME;
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(
      join(home, "agents", "db-migrator.md"),
      "---\nname: db-migrator\ndescription: 全局版本\npermission: write\n---\n"
    );
    await writeFile(
      join(home, "agents", "pr-writer.md"),
      "---\nname: pr-writer\ndescription: 写 PR 说明\npermission: read\n---\n"
    );
    const agents = join(dashboard.workspaceRoot, ".atria", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "db-migrator.md"),
      "---\nname: db-migrator\ndescription: 项目版本\npermission: write\n---\n"
    );
    await writeFile(
      join(agents, "coworkos-tester.md"),
      "---\nname: coworkos-tester\ndescription: 补测试时派给它\npermission: read\n---\n"
    );
    await page.goto(dashboard.base);

    // The work view asks before anything in the project reaches Main.
    const ask = page.getByRole("dialog", { name: /信任项目/ });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("2 个 Agent：coworkos-tester、db-migrator（覆盖同名全局 Agent）");
    await ask.getByRole("button", { name: "信任", exact: true }).click();
    await expect(ask).toBeHidden();
    await page.reload();
    await expect(page.locator("#composer-input")).toBeEditable();
    await expect(ask).toBeHidden();

    // `@` offers the Agents this project can use: its own, then the global ones it does not replace.
    const input = page.locator("#composer-input");
    const menu = page.locator("#composer-menu");
    await input.pressSequentially("交给 @db");
    await expect(menu.locator(".composer-menu-group")).toHaveText(["Agent"]);
    await expect(menu).toContainText("项目版本");
    await input.press("Enter");
    await expect(input).toHaveValue("交给 @db-migrator ");
    await input.fill("");

    const settings = await openSettings(page, "agents");
    await settings.locator('[data-agent-scope-value="project"]').click();
    await expect(settings.locator("[data-agent-trust]")).toContainText("已信任此项目");
    const list = settings.locator("[data-agent-list]");
    await expect(list.locator(".agent-group")).toHaveCount(2);
    await expect(list.getByRole("button", { name: /db-migrator/ }).first()).toContainText("覆盖全局");
    await expect(list.getByRole("button", { name: /pr-writer/ })).toContainText("全局");
    await expect(list).toContainText("被项目版本覆盖");
    // A global Agent is edited on the global page.
    await list.getByRole("button", { name: /pr-writer/ }).click();
    await expect(settings.locator("[data-agent-detail]")).toContainText("全局 Agent 在「全局」页编辑");
    await expect(settings.getByLabel("名称")).toBeDisabled();
  } finally {
    await dashboard.stop();
  }
});
