import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { readFixtureRequestBody } from "../test/http-request-body-fixture.mjs";
import { createTask } from "./p45-work-helpers.js";

const reply = "查询在 `src/hazard/HazardQuery.kt:3`，上传在 `Shared.kt`，另见 `missing.kt`。";

function complete(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: text }], [{}, "stop"]])
    response.write(
      `data: ${JSON.stringify({ id: "file-preview", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`
    );
  response.end("data: [DONE]\n\n");
}

test("a file a reply names opens from the project folder, at its line, or offers the matches", async ({
  page
}) => {
  test.setTimeout(120_000);
  const provider = createServer(async (request, response) => {
    await readFixtureRequestBody(request);
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    complete(response, reply);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const local = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "fixture-model"
  });
  try {
    const project = local.workspaceRoot;
    await mkdir(join(project, "src", "hazard"), { recursive: true });
    await writeFile(
      join(project, "src", "hazard", "HazardQuery.kt"),
      "package hazard\n\nfun query(change: Change) = platforms.map { it.inspect(change) }\n"
    );
    for (const folder of ["web", "api"]) {
      await mkdir(join(project, folder), { recursive: true });
      await writeFile(join(project, folder, "Shared.kt"), `// ${folder} upload\n`);
    }
    const taskId = "file-preview";
    await createTask(page, local, { taskId, goal: "说明实现位置", projectId: local.projectId });
    await page.goto(local.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await page.locator("#composer-input").fill("实现在哪里");
    await page.locator("#send-button").click();
    const answer = page.locator('.chat-message.main[data-answer-kind="final"] .markdown-body');
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(answer.locator("button.file-chip")).toHaveCount(3);

    const drawer = page.locator("#artifact-drawer");
    await answer.locator("button.file-chip", { hasText: "HazardQuery.kt" }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".drawer-tab.active")).toHaveText("HazardQuery.kt");
    await expect(drawer.locator(".code-line.is-target")).toContainText("fun query(change: Change)");
    // The browser has no host to hand a file to an application.
    await expect(drawer.locator("[data-open-main]")).toHaveCount(0);

    await answer.locator("button.file-chip", { hasText: "Shared.kt" }).click();
    const choices = drawer.locator("[data-choose-file]");
    await expect(choices).toHaveText(["api/Shared.kt", "web/Shared.kt"]);
    await choices.filter({ hasText: "web/Shared.kt" }).click();
    await expect(drawer.locator(".drawer-tab.active")).toHaveText("Shared.kt");
    await expect(drawer.locator(".drawer-content")).toContainText("// web upload");

    await answer.locator("button.file-chip", { hasText: "missing.kt" }).click();
    await expect(page.locator("#toast")).toContainText("项目里找不到这个文件");
  } finally {
    await local.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  }
});
