import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { reviewMapping, reviewMappingInput } from "../dist/src/domain/development-review.js";
import { reviewBrief, reworkMethod } from "../dist/src/domain/development-ticket.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";

/**
 * The final review's acceptance mapping, Main's map of the plan onto the
 * integrated tree, and the method every rework is told: both written into what
 * the Reviewer and the Executor read by the program.
 */

test("the mapping is numbered by the program and each row needs a requirement and its evidence", () => {
  const mapping = reviewMappingInput([
    { requirement: "导出 CSV", evidence: "npm test -- export" },
    { requirement: "列只往后加", evidence: "test/export.test.js" }
  ]);
  assert.deepEqual(
    mapping.map((row) => row.rowId),
    ["M1", "M2"]
  );
  assert.deepEqual(reviewMapping(mapping), mapping);
  assert.throws(() => reviewMappingInput([]), /对照表须为 1–50 行/);
  assert.throws(() => reviewMappingInput([{ requirement: "导出" }]), /第 1 行的证据/);
  assert.throws(() => reviewMapping([{ ...mapping[1], rowId: "M1" }, mapping[0]]), /依次为 M1/);

  const brief = reviewBrief({
    goal: "导出",
    criteria: ["导出 CSV"],
    tickets: [
      {
        ticketId: "01",
        title: "导出",
        criteria: [{ criterionId: "AC1", text: "有 CSV", check: { command: "true" } }]
      }
    ],
    mapping
  });
  assert.match(brief, /Acceptance mapping, written by Main: claims to verify, not evidence/);
  assert.match(brief, /- M2 列只往后加 — evidence: test\/export\.test\.js/);
  assert.doesNotMatch(reviewBrief({ goal: "导出", criteria: [], tickets: [] }), /Acceptance mapping/);
  assert.match(reworkMethod("review_1"), /^This rework answers review review_1[^]*one line per finding id/);
});

test("a version 10 ledger gains the review mapping", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-mapping-v10-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = async () => {
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: join(root, "project-data.sqlite") } },
      env: {},
      configPath: join(root, "config.json"),
      dataRoot: root
    });
    return { runtime, service: await runtime.service() };
  };
  const first = await open();
  await first.service.ensureProject({
    projectId: "project_v10",
    projectName: "旧项目",
    projectDirectory: root,
    backendId: "backend_local"
  });
  await first.runtime.close();

  const database = await SqliteDatabase.open(join(root, "project-data.sqlite"));
  await database.execute("ALTER TABLE project_data_development_reviews DROP COLUMN mapping");
  await database.execute("ALTER TABLE project_data_projects DROP COLUMN ledger_clock");
  await database.execute("DELETE FROM project_data_migrations");
  await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (10, ?)", [
    new Date().toISOString()
  ]);
  await database.close();

  const again = await open();
  t.after(() => again.runtime.close());
  assert.equal(again.service.description.schemaVersion, 14);
  const reopened = await SqliteDatabase.open(join(root, "project-data.sqlite"));
  const columns = await reopened.query("PRAGMA table_info(project_data_development_reviews)");
  await reopened.close();
  assert.ok(columns.some((column) => column.name === "mapping"));
});
