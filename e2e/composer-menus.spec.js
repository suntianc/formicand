import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

async function seed(dashboard) {
  const home = dashboard.env.ATRIA_HOME;
  const skill = join(home, "skills", "pg-migration");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: pg-migration\ndescription: PostgreSQL 迁移脚本与回滚\n---\n先写回滚。\n"
  );
  await mkdir(join(home, "prompts"), { recursive: true });
  await writeFile(
    join(home, "prompts", "pg-review.md"),
    "---\ndescription: 按团队规范审查迁移 PR\n---\n请按团队规范审查这次迁移。\n"
  );
  await writeFile(
    join(home, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        postgres: {
          command: process.execPath,
          args: [resolve("test/fixtures/mcp-echo-server.mjs")],
          env: { ECHO_RESOURCES: "1" }
        }
      }
    })
  );
  const migrations = join(dashboard.workspaceRoot, "src", "storage", "migrations");
  await mkdir(migrations, { recursive: true });
  await writeFile(join(migrations, "0007_add_task_index.sql"), "create index;\n");
  await writeFile(join(migrations, "0007_add_task_index.down.sql"), "drop index;\n");
}

test("/ and @ leave words in the draft and send what they name to Main", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions");
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await seed(dashboard);
    await page.goto(dashboard.base);
    const input = page.locator("#composer-input");
    const menu = page.locator("#composer-menu");
    await expect(input).toBeEditable();
    // The draft's project, whose files `@` searches, is known once the project list is drawn.
    await expect(page.locator(".project-group").first()).toBeVisible();

    // `/` offers the skill, the prompt template and commands; a template becomes the draft's words.
    await input.pressSequentially("/pg");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".composer-menu-group")).toHaveText(["技能", "指令模板"]);
    await expect(menu.locator(".composer-menu-item.is-active")).toContainText("/pg-migration");
    await expect(menu).toContainText("全局");
    await expect(menu).toContainText("~/.atria/prompts");
    await input.press("ArrowDown");
    await expect(menu.locator(".composer-menu-item.is-active")).not.toContainText("/pg-migration");
    await input.press("ArrowUp");
    await expect(menu.locator(".composer-menu-item.is-active")).toContainText("/pg-migration");
    // Skills in the user's own ~/.agents/skills may also match, so the template is picked by name.
    await menu.locator(".composer-menu-item", { hasText: "/pg-review" }).click();
    await expect(menu).toBeHidden();
    await expect(input).toHaveValue("请按团队规范审查这次迁移。");
    await input.fill("");

    // A skill leaves `/name`; Enter picks it instead of sending.
    await input.pressSequentially("/pg");
    await input.press("Enter");
    await expect(input).toHaveValue("/pg-migration ");

    // `@` searches project files and MCP resources.
    await input.pressSequentially("处理 @0007");
    await expect(menu.locator(".composer-menu-group")).toHaveText(["文件"]);
    await expect(menu.locator(".composer-menu-item").first()).toContainText("0007_add_task_index.sql");
    await expect(menu.locator(".composer-menu-item").first()).toContainText("src/storage/migrations/");
    await input.press("Tab");
    await expect(input).toHaveValue("/pg-migration 处理 @src/storage/migrations/0007_add_task_index.sql ");
    await input.pressSequentially("对照 @public");
    await expect(menu.locator(".composer-menu-group")).toHaveText(["MCP 资源"]);
    await expect(menu).toContainText("postgres · public.tasks");
    await expect(menu).not.toContainText("ui://panel");
    await input.press("Enter");
    const full =
      "/pg-migration 处理 @src/storage/migrations/0007_add_task_index.sql 对照 @postgres:schema://public/tasks ";
    await expect(input).toHaveValue(full);

    // Backspace after a referenced word takes the whole word; Esc closes a menu and keeps the words.
    await input.press("Backspace");
    await expect(input).toHaveValue(
      "/pg-migration 处理 @src/storage/migrations/0007_add_task_index.sql 对照 "
    );
    await input.pressSequentially("@public");
    await expect(menu).toBeVisible();
    await input.press("Escape");
    await expect(menu).toBeHidden();
    await expect(input).toHaveValue(
      "/pg-migration 处理 @src/storage/migrations/0007_add_task_index.sql 对照 @public"
    );
    await input.fill(full + "上的索引");

    // At phone width the menu stays inside the screen.
    await page.setViewportSize({ width: 390, height: 800 });
    await input.press("End");
    await input.pressSequentially(" /pg");
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0);
    await input.press("Escape");
    await input.fill(full + "上的索引");
    await page.setViewportSize({ width: 1280, height: 900 });

    await input.press("Enter");
    // Main starts a real Pi process; on a busy machine that takes longer than the default wait.
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const sent = JSON.stringify(provider.requests[0].body.messages);
    const manifest = JSON.parse(
      JSON.parse(`"${/<atria_references>\\n(.*?)\\n<\/atria_references>/.exec(sent)[1]}"`)
    );
    expect(manifest.references).toEqual([
      {
        kind: "skill",
        name: "pg-migration",
        path: join(dashboard.env.ATRIA_HOME, "skills", "pg-migration", "SKILL.md")
      },
      { kind: "file", path: "src/storage/migrations/0007_add_task_index.sql" },
      { kind: "mcp_resource", server: "postgres", uri: "schema://public/tasks" }
    ]);
    expect(manifest.note).toMatch(/read_mcp_resource/);

    // The sent message shows the words as typed, the referenced ones marked; the manifest stays hidden.
    const message = page.locator(".chat-message.user").first();
    await expect(message.locator(".reference-chip")).toHaveText([
      "/pg-migration",
      "@src/storage/migrations/0007_add_task_index.sql",
      "@postgres:schema://public/tasks"
    ]);
    await expect(message).not.toContainText("atria_references");

    // A command runs at once and leaves nothing in the draft.
    await expect(input).toHaveValue("");
    await input.pressSequentially("/mod");
    await expect(menu.locator(".composer-menu-group")).toHaveText(["命令"]);
    await input.press("Enter");
    await expect(page.locator("#model-menu")).toBeVisible();
    await expect(input).toHaveValue("");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
