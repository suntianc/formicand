import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { expectNoHorizontalOverflow, openSettings } from "./settings-helper.js";

async function skill(directory, name, description, scripts = []) {
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`
  );
  for (const script of scripts) await writeFile(join(directory, "scripts", script), "echo\n");
}

/** A backend whose user home is a temporary folder, so `~/.agents/skills` is the test's own. */
async function startWithHome() {
  const userHome = await mkdtemp(join(tmpdir(), "atria-skill-home-"));
  const dashboard = await startDashboard({ env: { HOME: userHome } });
  const home = dashboard.env.ATRIA_HOME;
  return {
    dashboard,
    userHome,
    home,
    async stop() {
      await dashboard.stop();
      await rm(userHome, { recursive: true, force: true });
    }
  };
}

test("global skills list every source, remove one from the index and restore it", async ({ page }) => {
  const fixture = await startWithHome();
  try {
    await skill(join(fixture.userHome, ".agents", "skills", "docx"), "docx", "生成与修改 Word 文档");
    await skill(join(fixture.home, "skills", "notes"), "notes", "从提交生成发布说明", ["build.sh"]);
    await page.goto(fixture.dashboard.base);
    const settings = await openSettings(page, "skills");
    const list = settings.locator("[data-skill-list]");
    const rows = list.locator("[data-skill-select]");
    const filter = (value) => settings.locator(`[data-skill-filter="${value}"]`).click();
    // The bundled catalogue grows with the product, so each source is checked under
    // its own filter and only the skills this test wrote are counted.
    await filter("global");
    await expect(rows).toHaveCount(1);
    await expect(list.getByRole("button", { name: /notes/ })).toContainText("本产品");
    await filter("global-agents");
    await expect(rows).toHaveCount(1);
    await expect(list.getByRole("button", { name: /docx/ })).toContainText("通用");
    await filter("bundled");
    await settings.locator("[data-skill-search]").fill("cua");
    await expect(list.getByRole("button", { name: /^cua/ })).toContainText("自带");
    await settings.locator("[data-skill-search]").fill("");
    await expectNoHorizontalOverflow(page, settings.locator(".settings-content"));

    await filter("global");
    await list.getByRole("button", { name: /notes/ }).click();
    const detail = settings.locator("[data-skill-detail]");
    await expect(detail).toContainText("scripts/build.sh");
    await expect(detail.locator(".skill-mark.is-script")).toBeVisible();

    await filter("global-agents");
    await list.getByRole("button", { name: /docx/ }).click();
    await expect(detail.getByRole("button", { name: "删除" })).toHaveCount(0);
    await detail.getByRole("button", { name: "从索引移除" }).click();
    const confirm = page.getByRole("dialog", { name: "从索引移除 docx？" });
    await expect(confirm).toContainText("保持不动");
    await confirm.getByRole("button", { name: "从索引移除" }).click();
    await expect(rows).toHaveCount(0);
    expect(existsSync(join(fixture.userHome, ".agents", "skills", "docx", "SKILL.md"))).toBe(true);

    const toggle = settings.locator("[data-skill-removed-toggle]");
    await expect(toggle).toContainText("1");
    await toggle.click();
    await list.getByRole("button", { name: /docx/ }).click();
    await detail.getByRole("button", { name: "恢复到索引" }).click();
    await expect(rows).toHaveCount(0);
    await toggle.click();
    await expect(list.getByRole("button", { name: /docx/ })).toBeVisible();
  } finally {
    await fixture.stop();
  }
});

test("a skill is added from a folder, then deleted", async ({ page }) => {
  const fixture = await startWithHome();
  try {
    const source = join(fixture.userHome, "downloads", "pack");
    await skill(join(source, "alpha"), "alpha", "Alpha workflow", ["run.sh"]);
    await skill(join(source, "beta"), "beta", "Beta workflow");
    await page.goto(fixture.dashboard.base);
    const settings = await openSettings(page, "skills");
    await settings.getByRole("button", { name: "添加技能" }).click();
    const dialog = page.getByRole("dialog", { name: "添加技能" });
    await dialog.getByRole("radio", { name: "本地文件夹" }).click();
    await dialog.locator("[data-skill-folder]").fill(source);
    await dialog.getByRole("button", { name: "读取" }).click();
    await expect(dialog.locator("[data-skill-found-name]")).toHaveCount(2);
    await expect(dialog.locator("[data-skill-found-warning]")).toBeVisible();
    await dialog.locator('[data-skill-found-name][value="beta"]').uncheck();
    await expect(dialog).toContainText("已选 1 个");
    await dialog.getByRole("button", { name: "安装", exact: true }).click();
    await expect(dialog).toBeHidden();

    const list = settings.locator("[data-skill-list]");
    await expect(list.getByRole("button", { name: /alpha/ })).toContainText("本产品");
    await expect(list.getByRole("button", { name: /beta/ })).toHaveCount(0);
    expect(existsSync(join(fixture.home, "skills", "alpha", "scripts", "run.sh"))).toBe(true);

    await list.getByRole("button", { name: /alpha/ }).click();
    await settings.locator("[data-skill-detail]").getByRole("button", { name: "删除" }).click();
    const confirm = page.getByRole("dialog", { name: "删除 alpha？" });
    await expect(confirm).toContainText("无法撤销");
    await confirm.getByRole("button", { name: "删除" }).click();
    await expect(list.getByRole("button", { name: /alpha/ })).toHaveCount(0);
    expect(existsSync(join(fixture.home, "skills", "alpha"))).toBe(false);
  } finally {
    await fixture.stop();
  }
});

test("project skills appear after the project is trusted, and long lists page", async ({ page }) => {
  const fixture = await startWithHome();
  try {
    const project = fixture.dashboard.workspaceRoot;
    await skill(join(project, ".atria", "skills", "deploy"), "deploy", "Deploy this project");
    for (let index = 0; index < 12; index += 1)
      await skill(
        join(fixture.home, "skills", `bulk-${String(index).padStart(2, "0")}`),
        `bulk-${index}`,
        "Bulk"
      );
    await page.goto(fixture.dashboard.base);
    // The work view asks about the project's skills first; leaving it unanswered keeps the decision for settings.
    const ask = page.getByRole("dialog", { name: /信任项目/ });
    await expect(ask).toContainText("1 个技能：deploy");
    await ask.getByLabel("记住我的选择（可在设置 · Agent · 项目中撤销）").uncheck();
    await ask.getByRole("button", { name: "不信任，忽略这些配置" }).click();
    const settings = await openSettings(page, "skills");
    const list = settings.locator("[data-skill-list]");
    // Paging is checked on the test's own twelve skills; the bundled ones vary by release.
    await settings.locator('[data-skill-filter="global"]').click();
    await expect(settings.locator("[data-skill-page-label]")).toHaveText("1 / 2");
    await expect(list.locator("[data-skill-select]")).toHaveCount(10);
    await settings.getByRole("button", { name: "下一页" }).click();
    await expect(settings.locator("[data-skill-page-label]")).toHaveText("2 / 2");
    await expect(list.locator("[data-skill-select]")).toHaveCount(2);

    await settings.locator('[data-skill-scope-value="project"]').click();
    await expect(settings.locator("[data-skill-project-select]")).toHaveValue(fixture.dashboard.projectId);
    await expect(list).toContainText("信任这个项目后");
    await expect(settings.getByRole("button", { name: "添加到此项目" })).toBeDisabled();
    await settings.getByRole("button", { name: "信任此项目" }).click();
    await expect(list.getByRole("button", { name: /deploy/ })).toContainText(".atria");
    await expect(settings.locator("[data-skill-trust]")).toContainText("已信任");
    await expect(settings.getByRole("button", { name: "添加到此项目" })).toBeEnabled();
  } finally {
    await fixture.stop();
  }
});
