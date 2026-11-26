import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";

/** A ledger longer than one read is read page by page, each requirement once. */
test("the requirement query pages through a long ledger with offset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-ledger-offset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(root, "project-data.sqlite") } },
    env: {},
    configPath: join(root, "config.json"),
    dataRoot: root
  });
  t.after(() => runtime.close());
  const service = await runtime.service();
  const { projectId } = await service.ensureProject({
    projectId: "project_offset",
    projectName: "分页",
    projectDirectory: root,
    backendId: "backend_local"
  });
  for (let index = 1; index <= 5; index += 1)
    await service.createRequirement(projectId, { title: `需求 ${index}`, summary: `第 ${index} 条。` });

  const all = await service.queryRequirements(projectId, { limit: 200 });
  const pages = [];
  for (let offset = 0; offset < all.length; offset += 2)
    pages.push(...(await service.queryRequirements(projectId, { limit: 2, offset })));
  assert.deepEqual(
    pages.map((entry) => entry.requirementId),
    all.map((entry) => entry.requirementId)
  );
  await assert.rejects(service.queryRequirements(projectId, { offset: -1 }), /offset/);
});
