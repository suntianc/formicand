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

test("global Agents: a built-in's fixed fields stay locked, a copy is edited, saved, switched off and deleted", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const home = dashboard.env.FORMICAND_HOME;
    await seedReferences(home);
    await page.goto(dashboard.base);
    const settings = await openSettings(page, "agents");
    const list = settings.locator("[data-agent-list]");
    const detail = settings.locator("[data-agent-detail]");
    await expect(list.locator(".agent-group")).toHaveText(["内置"]);
    await expect(list.locator(".skill-row")).toHaveCount(3);

    // A built-in keeps its name, description, permission and tools; it is never deleted.
    await list.getByRole("button", { name: /reviewer/ }).click();
    await expect(detail.getByLabel("名称")).toBeDisabled();
    await expect(detail.getByLabel("给 Main 的使用说明")).toBeDisabled();
    await expect(detail.locator("[data-agent-permission]").first()).toBeDisabled();
    await expect(detail.locator('[data-agent-tool][value="read"]')).toBeDisabled();
    await expect(detail.getByLabel("附加提示词")).toBeEnabled();
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
    await detail.getByRole("radio", { name: "指定", exact: true }).click();
    await detail.getByLabel("添加技能").selectOption("pg-migration");
    await detail.getByLabel("添加 MCP 服务").selectOption("postgres");
    // Once every server is added, 添加 stays in place but cannot open.
    await expect(detail.getByLabel("添加 MCP 服务")).toBeDisabled();
    await detail.getByLabel("附加提示词").fill("先在临时库演练。");
    await expectNoHorizontalOverflow(page, settings.locator(".settings-content"));
    await detail.getByRole("button", { name: "保存" }).click();

    await expect(list.locator(".agent-group")).toHaveText(["内置", "全局"]);
    const row = list.getByRole("button", { name: /db-migrator/ });
    await expect(row).toContainText("涉及表结构变更时派给它");
    const file = join(home, "agents", "db-migrator.md");
    const saved = await readFile(file, "utf8");
    expect(saved).toContain("permission: write");
    // A copy keeps the reviewer's own skills; the one added here comes last.
    expect(saved).toMatch(/^skills: \[(?:[\w-]+, )+pg-migration\]$/m);
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
    await expect(list.locator(".skill-row")).toHaveCount(3);
  } finally {
    await dashboard.stop();
  }
});

test("built-in Agents: Main, Executor and Reviewer keep their settings, and a project overrides single fields", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const home = dashboard.env.FORMICAND_HOME;
    await seedReferences(home);
    await page.goto(dashboard.base);
    const settings = await openSettings(page, "agents");
    const list = settings.locator("[data-agent-list]");
    const detail = settings.locator("[data-agent-detail]");
    const roles = async () =>
      (await (await page.request.get(`${dashboard.base}/api/model-settings`)).json()).modelRoles.roles;
    const host = async (role) => (await roles()).find((entry) => entry.role === role).host;

    // Main: its duty is shown, it has no permission field and its tools are a fixed line.
    await list.locator('[data-agent-select="builtin:main"]').click();
    await expect(detail.getByLabel("职责")).toBeDisabled();
    await expect(detail.locator("[data-agent-permission]")).toHaveCount(0);
    await expect(detail.locator(".agent-tools-text")).toBeVisible();
    await expect(detail.locator('[data-agent-mcp-mode-value="all"]')).toHaveAttribute("aria-checked", "true");
    await detail.locator('[data-agent-skill-mode-value="some"]').click();
    await detail.getByLabel("添加技能").selectOption("pg-migration");
    await detail.locator('[data-agent-mcp-mode-value="some"]').click();
    await detail.getByLabel("附加提示词").fill("回答用中文。");
    await detail.getByRole("button", { name: "保存" }).click();
    await expect(page.locator("#toast")).toContainText("已保存");
    expect(await host("main")).toEqual({ skills: ["pg-migration"], mcp: [], prompt: "回答用中文。" });

    // Executor: no MCP server until one is added; its effort is its own.
    await list.locator('[data-agent-select="builtin:executor"]').click();
    await expect(detail.locator('[data-agent-mcp-mode-value="all"]')).toHaveCount(0);
    await detail.getByLabel("添加 MCP 服务").selectOption("postgres");
    await detail.locator("[data-agent-effort]").selectOption("high");
    await detail.getByRole("button", { name: "保存" }).click();
    await expect(page.locator("#toast")).toContainText("已保存");
    expect(await host("executor")).toEqual({ thinkingLevel: "high", mcp: ["postgres"] });
    await expect(detail.locator(".agent-effort")).toContainText("高");

    // A project starts out following the global settings and overrides one field at a time.
    await settings.locator('[data-agent-scope-value="project"]').click();
    const executor = list.locator('[data-agent-select="builtin:executor"]');
    await expect(executor).toContainText("跟随全局");
    await executor.click();
    await expect(detail.locator(".agent-chip", { hasText: "postgres" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "全部跟随全局" })).toBeDisabled();
    await detail.getByLabel("附加提示词").fill("这个项目先跑 npm test。");
    await detail.getByRole("button", { name: "保存" }).click();
    await expect(executor).toContainText("本项目单独设置了附加提示词");
    const config = JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8"));
    expect(Object.values(config.roleModels.projects)).toEqual([
      { executor: { prompt: "这个项目先跑 npm test。" } }
    ]);
    await detail.getByRole("button", { name: "全部跟随全局" }).click();
    await expect(executor).toContainText("跟随全局");
    expect(
      JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8")).roleModels.projects
    ).toBeUndefined();
  } finally {
    await dashboard.stop();
  }
});

test("a project with its own Agents is asked about once; trusted, its Agents are listed and offered by @", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    const home = dashboard.env.FORMICAND_HOME;
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(
      join(home, "agents", "db-migrator.md"),
      "---\nname: db-migrator\ndescription: 全局版本\npermission: write\n---\n"
    );
    await writeFile(
      join(home, "agents", "pr-writer.md"),
      "---\nname: pr-writer\ndescription: 写 PR 说明\npermission: read\n---\n"
    );
    const agents = join(dashboard.workspaceRoot, ".formicand", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "db-migrator.md"),
      "---\nname: db-migrator\ndescription: 项目版本\npermission: write\n---\n"
    );
    await writeFile(
      join(agents, "formicand-tester.md"),
      "---\nname: formicand-tester\ndescription: 补测试时派给它\npermission: read\n---\n"
    );
    await page.goto(dashboard.base);

    // The work view asks before anything in the project reaches Main.
    const ask = page.getByRole("dialog", { name: /信任项目/ });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("2 个 Agent");
    await expect(ask.locator(".trust-names li")).toHaveText(["db-migrator", "formicand-tester"]);
    await expect(ask.locator(".trust-names li.is-override")).toHaveText(["db-migrator"]);
    await expect(ask).toContainText("标黄的会覆盖同名全局 Agent");
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
    await expect(list.locator(".agent-group")).toHaveCount(3);
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
