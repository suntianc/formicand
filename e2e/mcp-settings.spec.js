import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { expectNoHorizontalOverflow, openSettings } from "./settings-helper.js";

const echoServer = resolve("test/fixtures/mcp-echo-server.mjs");
const stored = async (home) => JSON.parse(await readFile(join(home, "mcp.json"), "utf8")).mcpServers;

test("a local server is tested, saved, tuned, switched off and deleted", async ({ page }) => {
  // `${HOST_TOKEN}` is read from the backend's environment when Pi connects.
  const dashboard = await startDashboard({ env: { HOST_TOKEN: "token-value" } });
  try {
    const home = dashboard.env.FORMICAND_HOME;
    await page.goto(dashboard.base);
    const settings = await openSettings(page, "mcp");
    const list = settings.locator("[data-mcp-list]");
    await expect(list).toContainText("还没有 MCP 服务");

    await settings.getByRole("button", { name: "新建", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建 MCP 服务" });
    await dialog.getByLabel("名称").fill("echoes");
    await dialog.getByLabel("命令").fill(process.execPath);
    await dialog.getByLabel("参数").fill(echoServer);
    await dialog.getByRole("button", { name: "添加变量" }).click();
    await dialog.locator("[data-mcp-pair-key]").fill("ECHO_TOKEN");
    await dialog.locator("[data-mcp-pair-value]").fill("${HOST_TOKEN}");
    await dialog.getByRole("button", { name: "测试连接" }).click();
    await expect(dialog.locator("[data-mcp-test-result]")).toContainText("连接成功：2 个工具");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();

    await expect(list.getByRole("button", { name: /echoes/ })).toContainText("本地命令 · 2 个工具");
    const detail = settings.locator("[data-mcp-detail]");
    await expect(detail.locator("[data-mcp-state]")).toContainText("已连接 · 2 个工具");
    await expect(detail).toContainText("ECHO_TOKEN: ${HOST_TOKEN}");
    await expect(detail).toContainText("取自环境变量");
    expect((await stored(home)).echoes).toEqual({
      command: process.execPath,
      args: [echoServer],
      env: { ECHO_TOKEN: "${HOST_TOKEN}" }
    });
    await expectNoHorizontalOverflow(page, settings.locator(".settings-content"));

    await detail.getByLabel("erase 的可见方式").selectOption("hidden");
    await expect.poll(async () => (await stored(home)).echoes.toolExposure).toEqual({ erase: "hidden" });
    await detail.locator('[data-mcp-exposure="direct"]').click();
    await expect(detail.locator('[data-mcp-exposure="direct"]')).toHaveAttribute("aria-checked", "true");
    expect((await stored(home)).echoes.exposure).toBe("direct");

    // Editing keeps what the form does not show.
    await detail.getByRole("button", { name: "编辑" }).click();
    const edit = page.getByRole("dialog", { name: "编辑 echoes" });
    await expect(edit.getByLabel("参数")).toHaveValue(echoServer);
    await edit.getByRole("button", { name: "保存" }).click();
    await expect(edit).toBeHidden();
    expect((await stored(home)).echoes.toolExposure).toEqual({ erase: "hidden" });

    await detail.getByRole("switch", { name: "启用" }).click();
    await expect(list.getByRole("button", { name: /echoes/ })).toContainText("已停用");
    expect((await stored(home)).echoes.enabled).toBe(false);
    await settings.locator('[data-mcp-filter="connected"]').click();
    await expect(list.locator("[data-mcp-select]")).toHaveCount(0);
    await settings.locator('[data-mcp-filter="disabled"]').click();
    await expect(list.locator("[data-mcp-select]")).toHaveCount(1);

    await detail.getByRole("button", { name: "删除" }).click();
    const confirm = page.getByRole("dialog", { name: "删除 echoes？" });
    await expect(confirm).toContainText("不再连接它");
    await confirm.getByRole("button", { name: "删除" }).click();
    await settings.locator('[data-mcp-filter="all"]').click();
    await expect(list).toContainText("还没有 MCP 服务");
    expect(await stored(home)).toEqual({});
  } finally {
    await dashboard.stop();
  }
});

test("pasted JSON imports several servers and problems are listed with their reason", async ({ page }) => {
  const dashboard = await startDashboard();
  // A remote server that answers 401 asks for an OAuth sign-in.
  const locked = createServer((_request, response) => {
    response.writeHead(401, { "www-authenticate": 'Bearer realm="mcp"' });
    response.end();
  }).listen(0, "127.0.0.1");
  await once(locked, "listening");
  try {
    await page.goto(dashboard.base);
    const settings = await openSettings(page, "mcp");
    await settings.getByRole("button", { name: "粘贴 JSON" }).click();
    const dialog = page.getByRole("dialog", { name: "新建 MCP 服务" });
    await dialog.getByLabel("JSON").fill(
      JSON.stringify({
        mcpServers: {
          echoes: { command: process.execPath, args: [echoServer] },
          broken: { command: join(dashboard.env.FORMICAND_HOME, "missing-binary") },
          remote: { url: `http://127.0.0.1:${locked.address().port}/mcp` }
        }
      })
    );
    await dialog.getByRole("button", { name: "导入" }).click();
    await expect(dialog).toBeHidden();
    const list = settings.locator("[data-mcp-list]");
    await expect(list.locator("[data-mcp-select]")).toHaveCount(3);
    await expect(list.getByRole("button", { name: /echoes/ })).toContainText("2 个工具");
    await settings.locator('[data-mcp-filter="problem"]').click();
    await expect(list.locator("[data-mcp-select]")).toHaveCount(2);
    await list.getByRole("button", { name: /broken/ }).click();
    await expect(settings.locator("[data-mcp-detail]")).toContainText("ENOENT");
    await expect(list.getByRole("button", { name: /remote/ })).toContainText("需要登录");
    await list.getByRole("button", { name: /remote/ }).click();
    await expect(settings.locator("[data-mcp-detail]").getByRole("button", { name: "登录" })).toBeVisible();
    await list.getByRole("button", { name: /broken/ }).click();
    await expect(settings.locator("[data-mcp-detail]").getByRole("button", { name: "登录" })).toHaveCount(0);

    await settings.getByRole("button", { name: "粘贴 JSON" }).click();
    await dialog.getByLabel("JSON").fill(JSON.stringify({ echoes: { command: "x" } }));
    await dialog.getByRole("button", { name: "导入" }).click();
    await expect(dialog.locator("[data-mcp-editor-error]")).toContainText("已存在同名服务：echoes");
  } finally {
    locked.close();
    await dashboard.stop();
  }
});

test("a long tool list scrolls inside the server's details, not the whole settings page", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await writeFile(
      join(dashboard.env.FORMICAND_HOME, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          many: { command: process.execPath, args: [echoServer], env: { ECHO_EXTRA_TOOLS: "40" } }
        }
      })
    );
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto(dashboard.base);
    const settings = await openSettings(page, "mcp");
    const detail = settings.locator("[data-mcp-detail]");
    // Past four tools the list folds behind one row.
    await expect(detail.locator(".mcp-tool")).toHaveCount(4);
    const fold = detail.locator("[data-mcp-tools-fold]");
    await expect(fold).toHaveText("其余 38 个");
    await fold.click();
    await expect(detail.locator(".mcp-tool")).toHaveCount(42);
    await expect(detail.locator("[data-mcp-tools-fold]")).toBeFocused();
    const overflow = (node) => node.scrollHeight - node.clientHeight;
    expect(await detail.evaluate(overflow)).toBeGreaterThan(0);
    expect(await page.locator(".settings-content").evaluate(overflow)).toBeLessThanOrEqual(0);
  } finally {
    await dashboard.stop();
  }
});
