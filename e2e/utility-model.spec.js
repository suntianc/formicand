import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { pageRequest, saveTestConnection } from "../test/model-provider-fixture.mjs";

test("the general page picks the utility model from the configured models and saves it on the host", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  test.info().annotations.push({ type: "backend", description: dashboard.base });
  try {
    const request = pageRequest(page, dashboard.base);
    const main = await saveTestConnection(request, {
      profileName: "主力",
      baseUrl: "https://main.example.test/v1",
      model: "main-model",
      apiKey: "local-main-key"
    });
    const cheap = await saveTestConnection(request, {
      profileName: "便宜",
      baseUrl: "https://cheap.example.test/v1",
      model: "cheap-model",
      apiKey: "local-cheap-key",
      activate: false
    });
    expect(main.status).toBe(200);
    expect(cheap.status).toBe(200);
    const openGeneral = async () => {
      await page.locator("#user-menu-button").click();
      await page.locator('[data-settings-section="general"]').click();
      const select = page.locator("#utility-model-select");
      await expect(select).toBeVisible();
      return select;
    };
    await page.goto(dashboard.base);
    let select = await openGeneral();
    await expect(select.locator("option")).toHaveText(["跟随会话模型", "main-model", "cheap-model"]);
    expect(
      await select.locator("optgroup").evaluateAll((groups) => groups.map((group) => group.label))
    ).toEqual(["主力", "便宜"]);
    await expect(select).toHaveValue("");

    await select.selectOption(cheap.profileId);
    await expect
      .poll(async () => (await request("/api/model-settings")).body.utilityModel)
      .toBe(cheap.profileId);
    // A model in use as the utility model is not removed under it.
    const removed = await request("/api/model-settings/providers/delete", {
      id: cheap.profileId.split("#")[0]
    });
    expect(removed.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(removed.body)).toContain("辅助模型");

    await page.reload();
    select = await openGeneral();
    await expect(select).toHaveValue(cheap.profileId);
    await select.selectOption("");
    await expect.poll(async () => (await request("/api/model-settings")).body.utilityModel).toBe(null);
  } finally {
    await dashboard.stop();
  }
});
