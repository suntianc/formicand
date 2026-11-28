import { deferCleanup } from "./fixtures/cleanup.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";

/** A ledger longer than one read is read page by page, each requirement once. */
test("the requirement query pages through a long ledger by id, unmoved by updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-ledger-pages-"));
  deferCleanup(t, () => rm(root, { recursive: true, force: true }));
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(root, "project-data.sqlite") } },
    env: {},
    configPath: join(root, "config.json"),
    dataRoot: root
  });
  deferCleanup(t, () => runtime.close());
  const service = await runtime.service();
  const { projectId } = await service.ensureProject({
    projectId: "project_pages",
    projectName: "分页",
    projectDirectory: root,
    backendId: "backend_local"
  });
  for (let index = 1; index <= 5; index += 1)
    await service.createRequirement(projectId, { title: `需求 ${index}`, summary: `第 ${index} 条。` });

  const all = await service.queryRequirements(projectId, { limit: 200 });
  const pages = [];
  let after = "";
  for (;;) {
    const page = await service.queryRequirements(projectId, { limit: 2, after });
    pages.push(...page);
    if (page.length < 2) break;
    after = page.at(-1).requirementId;
    // An update between pages moves the row in the default order, not in this one.
    if (pages.length === 2)
      await service.updateRequirement(projectId, page[0].requirementId, {
        expectedRevision: page[0].revision,
        summary: "改过。"
      });
  }
  assert.deepEqual(
    pages.map((entry) => entry.requirementId).sort(),
    all.map((entry) => entry.requirementId).sort()
  );
  assert.equal(new Set(pages.map((entry) => entry.requirementId)).size, all.length);
  await assert.rejects(service.queryRequirements(projectId, { after: "../x" }), /需求 ID/);
});
