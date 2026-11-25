import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import pg from "pg";
import { PROJECT_DATA_ENGINES, startPostgresProjectDatabase } from "./p3-storage-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";
import { PostgresDatabase } from "../dist/src/storage/project-data/postgres-database.js";

/**
 * A version 8 ledger, written with that version's own schema, is converted in
 * place when a build at version 9 opens it: requirements become long-lived
 * features with a summary and history, developments may be many, and every
 * project gains its miscellaneous requirement.
 */
let postgres;

before(
  async () => {
    postgres = await startPostgresProjectDatabase();
  },
  { timeout: 180_000 }
);

after(async () => {
  await postgres?.stop();
});

const at = "2026-03-01T08:00:00.000Z";
const later = "2026-03-02T08:00:00.000Z";
const project = "project_migrated";

/** One project's records in version 8: two requirements, decisions, a merged development and a board card. */
async function seedVersion8(database) {
  const schema = JSON.parse(
    await readFile(new URL("./fixtures/project-data-schema-v8.json", import.meta.url))
  );
  await database.execute(
    "CREATE TABLE project_data_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const statement of schema) await database.execute(statement);
  await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (8, ?)", [at]);
  const insert = (table, row) =>
    database.execute(
      `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(", ")})`,
      Object.values(row)
    );
  await insert("project_data_projects", {
    project_id: project,
    project_name: "旧项目",
    created_at: at,
    updated_at: at
  });
  const requirement = (id, title, content, status) =>
    insert("project_data_requirements", {
      project_id: project,
      requirement_id: id,
      title,
      content,
      source_kind: "external",
      source_reference: "工单 7",
      status,
      revision: 1,
      created_at: at,
      updated_at: at
    }).then(() =>
      insert("project_data_requirement_revisions", {
        project_id: project,
        requirement_id: id,
        revision: 1,
        title,
        content,
        status,
        source_kind: "external",
        source_reference: "工单 7",
        note: null,
        task_id: null,
        created_at: at
      })
    );
  await requirement("requirement_export", "导出", "export 输出 CSV。", "delivered");
  await requirement("requirement_import", "导入", "import 读入 CSV。", "withdrawn");
  const decision = (id, text, effective, createdAt) =>
    insert("project_data_decisions", {
      project_id: project,
      requirement_id: "requirement_export",
      decision_id: id,
      text,
      effective,
      source_kind: "internal",
      source_reference: null,
      at_revision: 1,
      created_at: createdAt
    });
  await decision("decision_old", "日期写成 MM/DD/YYYY。", 0, at);
  await decision("decision_new", "列只能往后加。", 1, later);
  await insert("project_data_references", {
    project_id: project,
    requirement_id: "requirement_export",
    reference_id: "reference_delivery",
    kind: "delivery",
    value: "0123456789abcdef0123456789abcdef01234567",
    created_at: later
  });
  await insert("project_data_board_entries", {
    project_id: project,
    board_id: "board_export",
    requirement_id: "requirement_export",
    entry_kind: "external",
    state: "pending_release",
    revision: 3,
    backend_id: "backend_a",
    publish_request_id: "publish-1",
    assignment_kind: null,
    assignee_id: null,
    handler_backend_id: null,
    handler_project_id: null,
    handler_task_id: null,
    assigned_at: null,
    delivery_merge_id: "merge_export",
    delivery_commit: "0123456789abcdef0123456789abcdef01234567",
    delivery_merged_at: later,
    created_at: at,
    updated_at: later
  });
  await insert("project_data_developments", {
    project_id: project,
    development_id: "development_export",
    requirement_id: "requirement_export",
    goal: "导出 CSV",
    completion_criteria: JSON.stringify(["export 输出表头"]),
    route: "quick",
    status: "active",
    revision: 1,
    baseline_branch: "main",
    baseline_commit: "fedcba9876543210fedcba9876543210fedcba98",
    session_id: null,
    task_id: null,
    created_at: at,
    updated_at: at
  });
  await insert("project_data_deliveries", {
    project_id: project,
    delivery_id: "delivery_export",
    development_id: "development_export",
    requirement_id: "requirement_export",
    merge_id: "merge_export",
    candidate_commit: "1111111111111111111111111111111111111111",
    merged_commit: "0123456789abcdef0123456789abcdef01234567",
    target_branch: "main",
    merged_at: later,
    board_id: "board_export",
    state: "synced",
    attempts: 1,
    error: null,
    synced_at: later,
    created_at: later,
    updated_at: later
  });
}

async function version8Database(t, engine) {
  if (engine === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "formicand-ledger-v8-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "project-data.sqlite");
    const database = await SqliteDatabase.open(path);
    await seedVersion8(database);
    await database.close();
    return { config: { sqlite: { path } }, dataRoot: directory };
  }
  const name = `formicand_v8_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: postgres.connectionString });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  t.after(() => admin.end().catch(() => undefined));
  t.after(() => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined));
  const url = new URL(postgres.connectionString);
  url.pathname = `/${name}`;
  const database = new PostgresDatabase({ connectionString: url.toString() });
  await seedVersion8(database);
  await database.close();
  const directory = await mkdtemp(join(tmpdir(), "formicand-ledger-v8-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { config: { engine, postgres: { connectionString: url.toString() } }, dataRoot: directory };
}

for (const engine of PROJECT_DATA_ENGINES) {
  test(`${engine}: a version 8 ledger is converted to long-lived features`, async (t) => {
    const legacy = await version8Database(t, engine);
    const runtime = new ProjectDataRuntime({
      config: legacy.config,
      env: {},
      configPath: join(legacy.dataRoot, "config.json"),
      dataRoot: legacy.dataRoot
    });
    const service = await runtime.service();
    assert.equal(service.description.schemaVersion, 14);

    const requirements = await service.queryRequirements(project);
    assert.deepEqual(requirements.map((entry) => [entry.kind, entry.title, entry.status]).sort(), [
      ["feature", "导入", "retired"],
      ["feature", "导出", "active"],
      ["misc", "杂项", "active"]
    ]);

    // The content and the decisions still in force make the summary; a
    // retracted decision and the delivery become history lines.
    const exported = await service.getRequirement(project, "requirement_export");
    assert.equal(exported.summary, "export 输出 CSV。\n- 列只能往后加。");
    assert.equal(exported.description, "export 输出 CSV。");
    assert.deepEqual(
      exported.history.map((entry) => [entry.day, entry.text]),
      [
        ["2026-03-01", "不再生效的决定：日期写成 MM/DD/YYYY。"],
        ["2026-03-02", "合入 0123456789ab"]
      ]
    );
    assert.equal(exported.revisions[0].summary, "export 输出 CSV。");
    assert.equal(exported.revisions[0].status, "active");
    assert.equal(exported.source.reference, "工单 7");

    // The delivered development is closed, so the feature takes a new one.
    const developments = await service.queryDevelopments(project);
    assert.deepEqual(
      developments.map((entry) => [entry.developmentId, entry.status]),
      [["development_export", "merged"]]
    );
    const [card] = await service.boardEntries(project);
    assert.deepEqual(
      [card.title, card.content, card.source.kind, card.state],
      ["导出", "export 输出 CSV。", "external", "pending_release"]
    );
    const [delivery] = await service.queryDeliveries(project);
    assert.equal(delivery.state, "synced");

    // Opening again leaves the converted database as it is.
    await runtime.close();
    const reopened = new ProjectDataRuntime({
      config: legacy.config,
      env: {},
      configPath: join(legacy.dataRoot, "config.json"),
      dataRoot: legacy.dataRoot
    });
    t.after(() => reopened.close());
    const again = await reopened.service();
    assert.equal((await again.queryRequirements(project)).length, 3);
  });
}
