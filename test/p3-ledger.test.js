import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { join } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import {
  PROJECT_DATA_ENGINES,
  projectDataConfig,
  startPostgresProjectDatabase,
  startProjectDataDashboard
} from "./p3-storage-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";

/**
 * One contract, two real engines.
 *
 * The same scenarios run against the default SQLite file and a disposable
 * PostgreSQL 18 server, through the real Dashboard HTTP surface. Nothing here
 * substitutes an in-memory store for a database: a restart has to read the fact
 * back from the engine that committed it.
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

const ledgerFixture = (t, engine, options) => startProjectDataDashboard(t, engine, { postgres, ...options });

async function createProject(fixture, name) {
  const directory = join(fixture.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const response = await fixture.request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.project;
}

async function openService(fixture, engine, info) {
  // The default SQLite run names no engine in configuration; the reported target
  // is the file it actually opened, so a second connection reads the same data.
  const config =
    engine === "sqlite"
      ? { sqlite: { path: info.target } }
      : { engine, postgres: { connectionString: postgres.connectionString } };
  const runtime = new ProjectDataRuntime({
    config,
    configPath: join(fixture.root, "config.json"),
    dataRoot: fixture.root,
    env: {}
  });
  return { service: await runtime.service(), close: () => runtime.close() };
}

/** An HTTP port with nothing listening on it, for the unreachable-database case. */
async function closedPort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

for (const engine of PROJECT_DATA_ENGINES) {
  test(`${engine}: ledger contract survives restart, conflicts, rollback and restore`, async (t) => {
    const f = await ledgerFixture(t, engine);
    const a = await createProject(f, "a");
    const b = await createProject(f, "b");
    const ledger = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/ledger`;

    // Engine choice and versioned schema are observable, and the report carries
    // no credential material.
    const info = await f.request("/api/project-data", undefined, "GET");
    assert.equal(info.status, 200);
    assert.equal(info.body.engine, engine);
    // v1 and v2 stayed intact; v3 adds project Main sessions and v4 adds
    // development records. Migrations are applied one version at a time, so a
    // later version does not hide an unapplied one.
    assert.equal(info.body.schemaVersion, 14);
    assert.ok(info.body.serverVersion, "the engine version is reported");
    assert.doesNotMatch(JSON.stringify(info.body), /password/i);
    if (engine === "sqlite")
      assert.equal(info.body.target, join(f.root, "project-data.sqlite"), "the default SQLite file");

    const created = await f.request(ledger(a.projectId), {
      action: "create",
      title: "登录需要记住设备",
      summary: "用户每天在同一台设备登录，不应反复输入验证码。",
      aliases: ["免验证码登录"],
      source: { kind: "internal", reference: "会话 a" },
      references: [{ kind: "session", value: "session-a" }]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requirement = created.body.requirement;
    assert.equal(requirement.revision, 1);
    assert.equal(requirement.source.kind, "internal");
    assert.equal(requirement.kind, "feature");
    assert.equal(requirement.status, "active");
    assert.deepEqual(
      requirement.aliases.map((alias) => alias.alias),
      ["免验证码登录"]
    );
    assert.deepEqual(requirement.history, []);
    assert.equal(requirement.revisions.length, 1);
    assert.equal(requirement.references[0].value, "session-a");
    // An internal requirement is ledger-only: this ticket adds no board projection.
    assert.ok(!("boardEntry" in requirement));
    const emptyBoard = await f.request(
      `/api/projects/${encodeURIComponent(a.projectId)}/board`,
      undefined,
      "GET"
    );
    assert.equal(emptyBoard.status, 200);
    assert.deepEqual(emptyBoard.body.entries, [], "an internal need creates no board item");

    const revised = await f.request(ledger(a.projectId), {
      action: "update",
      requirementId: requirement.requirementId,
      expectedRevision: 1,
      summary: "用户每天在同一台设备登录，记住 30 天，敏感操作仍需验证。",
      history: "加上 30 天有效期",
      note: "补充有效期与敏感操作"
    });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.requirement.revision, 2);
    assert.deepEqual(
      revised.body.requirement.revisions.map((revision) => revision.revision),
      [1, 2]
    );
    assert.equal(revised.body.requirement.revisions[1].note, "补充有效期与敏感操作");

    assert.equal(
      revised.body.requirement.summary,
      "用户每天在同一台设备登录，记住 30 天，敏感操作仍需验证。"
    );
    assert.deepEqual(
      revised.body.requirement.history.map((entry) => entry.text),
      ["加上 30 天有效期"]
    );
    assert.match(revised.body.requirement.history[0].day, /^\d{4}-\d{2}-\d{2}$/);

    // Text query matches the summary and the aliases, both as a page read and as
    // the tool-shaped POST the Main bridge uses.
    const byText = await f.request(
      `${ledger(a.projectId)}?q=${encodeURIComponent("设备")}`,
      undefined,
      "GET"
    );
    assert.equal(byText.status, 200);
    assert.equal(byText.body.requirements.length, 1);
    assert.equal(byText.body.requirements[0].source.kind, "internal");
    assert.equal(byText.body.requirements[0].source.reference, "会话 a");
    const byAlias = await f.request(ledger(a.projectId), { action: "query", q: "免验证码" });
    assert.deepEqual(
      byAlias.body.requirements.map((entry) => entry.requirementId),
      [requirement.requirementId]
    );
    const retired = await f.request(`${ledger(a.projectId)}?status=retired`, undefined, "GET");
    assert.deepEqual(retired.body.requirements, []);
    // Every project starts with its one miscellaneous requirement, which keeps its name.
    const isolation = await f.request(ledger(b.projectId), { action: "query" });
    assert.equal(isolation.status, 200);
    assert.deepEqual(
      isolation.body.requirements.map((entry) => [entry.kind, entry.title]),
      [["misc", "杂项"]]
    );
    const misc = isolation.body.requirements[0];
    const renamed = await f.request(ledger(b.projectId), {
      action: "update",
      requirementId: misc.requirementId,
      expectedRevision: misc.revision,
      status: "retired"
    });
    assert.equal(renamed.status, 409, JSON.stringify(renamed.body));
    assert.equal(renamed.body.code, "requirement_misc_fixed");

    // A stale page cannot overwrite the newer revision.
    const stale = await f.request(ledger(a.projectId), {
      action: "update",
      requirementId: requirement.requirementId,
      expectedRevision: 1,
      title: "过期页面写入"
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, "revision_conflict");
    assert.equal(stale.body.currentRevision, 2);

    const before = await openService(f, engine, info.body);
    t.after(() => before.close());
    const history = await before.service.getRequirement(a.projectId, requirement.requirementId);
    assert.equal(history.revisions.length, 2);

    // A failure inside a transaction leaves no requirement and no revision behind.
    await assert.rejects(
      before.service.transaction(async (repository) => {
        await repository.createRequirement(a.projectId, { title: "临时", summary: "不应保存" });
        throw new Error("fixture rollback");
      }),
      /fixture rollback/
    );
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 2);

    // Two writers from revision 2: exactly one wins and every accepted revision stays.
    const race = await Promise.allSettled([
      before.service.updateRequirement(a.projectId, requirement.requirementId, {
        expectedRevision: 2,
        title: "并发写入一"
      }),
      before.service.updateRequirement(a.projectId, requirement.requirementId, {
        expectedRevision: 2,
        title: "并发写入二"
      })
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(race));
    const rejected = race.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.status, 409);
    assert.equal(rejected.reason.code, "revision_conflict");
    const afterRace = await before.service.getRequirement(a.projectId, requirement.requirementId);
    assert.equal(afterRace.revisions.length, 3);
    assert.deepEqual(
      afterRace.revisions.map((revision) => revision.revision),
      [1, 2, 3]
    );

    // Backup, mutate, restore: the snapshot is the observable source of truth.
    const backupPath = join(f.root, `ledger-backup-${engine}.json`);
    const backup = await before.service.backupTo(backupPath);
    assert.equal(backup.engine, engine);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    await f.request(ledger(a.projectId), {
      action: "create",
      title: "备份后新增",
      summary: "这一条不应在恢复后出现。"
    });
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 3);
    const restored = await before.service.restoreFrom(backupPath);
    assert.equal(restored.counts.project_data_requirements, backup.counts.project_data_requirements);
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 2);

    // A snapshot cannot shape the restore statement, and a rejected file changes nothing.
    const tampered = JSON.parse(await readFile(backupPath, "utf8"));
    tampered.tables.project_data_requirements[0]["project_id; DROP TABLE project_data_projects"] = "x";
    const tamperedPath = join(f.root, `ledger-backup-tampered-${engine}.json`);
    await writeFile(tamperedPath, JSON.stringify(tampered));
    await assert.rejects(before.service.restoreFrom(tamperedPath), /不是已知字段/);
    assert.equal((await before.service.queryRequirements(a.projectId)).length, 2);

    // Restart reads the restored fact back from the engine, not from memory.
    await f.restart();
    const reopened = await f.request(
      `${ledger(a.projectId)}?q=${encodeURIComponent("设备")}`,
      undefined,
      "GET"
    );
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.requirements.length, 1);
    const detail = await f.request(
      `${ledger(a.projectId)}/${encodeURIComponent(requirement.requirementId)}`,
      undefined,
      "GET"
    );
    assert.equal(detail.body.requirement.revision, 3);
    assert.equal(detail.body.requirement.revisions.length, 3);
    assert.equal(detail.body.requirement.history.length, 1);
    const infoAfterRestart = await f.request("/api/project-data", undefined, "GET");
    assert.equal(infoAfterRestart.body.schemaVersion, 14);
  });

  test(`${engine}: an explicit project and its task keep their identity and files`, async (t) => {
    const f = await ledgerFixture(t, engine);
    const project = await createProject(f, "history");
    const task = await f.request("/api/tasks", {
      taskId: "history-task",
      goal: "历史任务",
      projectId: project.projectId
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));

    const catalogPath = join(f.root, "projects.json");
    const catalogBefore = await readFile(catalogPath, "utf8");
    const taskFile = join(f.workspaceRoot, "history-task", "task.json");
    const taskBefore = await readFile(taskFile, "utf8");

    const created = await f.request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "项目需求",
      summary: "项目继续记录需求。"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.requirement.projectId, project.projectId);
    // Ledger writes never touch the catalog or the task snapshot.
    assert.equal(await readFile(catalogPath, "utf8"), catalogBefore);
    assert.equal(await readFile(taskFile, "utf8"), taskBefore);

    await f.restart();
    const history = await f.request("/api/tasks", undefined, "GET");
    assert.ok(
      history.body.projects
        .find((entry) => entry.projectId === project.projectId)
        ?.tasks.some((entry) => entry.taskId === "history-task")
    );
    const ledger = await f.request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "query"
    });
    assert.deepEqual(ledger.body.requirements.map((entry) => entry.title).sort(), ["杂项", "项目需求"]);
  });
}

if (PROJECT_DATA_ENGINES.includes("postgres"))
  test("postgres: an older tidy finishing concurrently cannot move the mark back", async (t) => {
    const fixture = await ledgerFixture(t, "postgres");
    const { service, close } = await openService(fixture, "postgres");
    t.after(close);
    const project = await service.ensureProject({
      projectId: "project_tidy",
      projectName: "维护",
      projectDirectory: fixture.root,
      backendId: "backend_tidy"
    });
    const older = await service.tidyLedger(project.projectId);
    const newer = await service.tidyLedger(project.projectId);

    const gate = new pg.Client({ connectionString: postgres.connectionString });
    await gate.connect();
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT project_id FROM project_data_projects WHERE project_id=$1 FOR UPDATE", [
        project.projectId
      ]);
      // Queue both transactions behind the same row lock, newer first.
      async function waitForWriters(count) {
        for (let attempt = 0; attempt < 300; attempt++) {
          const { rows } = await gate.query(
            "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND application_name='formicand-project-data' AND wait_event_type='Lock'"
          );
          if (Number(rows[0].waiting) === count) return;
          await delay(10);
          await gate.query("SELECT pg_stat_clear_snapshot()");
        }
        assert.fail(`expected ${count} blocked writers`);
      }
      const finish = (read) =>
        service.finishLedgerTidy(project.projectId, { unchanged: "已核对" }, read.readAt);
      const first = finish(newer);
      await waitForWriters(1);
      const second = finish(older);
      const completed = Promise.allSettled([first, second]);
      await waitForWriters(2);
      await gate.query("COMMIT");
      const [accepted, rejected] = await completed;
      assert.equal(accepted.status, "fulfilled");
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.reason.code, "tidy_stale");
      assert.equal((await service.tidyLedger(project.projectId)).tidiedAt, accepted.value.tidiedAt);
    } finally {
      await gate.end();
    }
  });

test("an invalid engine is refused with a locatable error and no fallback database", async (t) => {
  await assert.rejects(
    startDashboard({ defaultProject: false, config: { projectData: { engine: "mysql" } } }),
    (error) => {
      assert.match(error.message, /projectData/);
      assert.match(error.message, /engine 须为 sqlite \/ postgres/);
      return true;
    }
  );
  t.diagnostic("invalid engine refused at startup");
});

test("a malformed PostgreSQL URL refuses startup with a locatable configuration error", async (t) => {
  const password = "fixture-password";
  const raw = `postgresql://formicand_test:${encodeURIComponent(password)}@127.0.0.1:not-a-port/ledger`;
  const fallback = join("/tmp", `formicand-p3-malformed-fallback-${process.pid}-${Date.now()}.sqlite`);
  await assert.rejects(
    startDashboard({
      defaultProject: false,
      config: { projectData: { engine: "postgres", postgres: { connectionString: raw } } },
      env: { FORMICAND_PROJECT_DATA_SQLITE: fallback }
    }),
    (error) => {
      assert.match(error.message, /PostgreSQL/);
      assert.match(error.message, /postgres\.connectionString/);
      assert.ok(!error.message.includes(password), "the password is not echoed");
      assert.ok(!error.message.includes("not-a-port"), "the raw address is not echoed");
      return true;
    }
  );
  await assert.rejects(stat(fallback), "no SQLite database was opened as a fallback");
  t.diagnostic("malformed postgresql:// URL refused at the configuration boundary");
});

test("an unreachable PostgreSQL refuses to start instead of writing SQLite", async (t) => {
  const port = await closedPort();
  const password = "fixture-password";
  const fallback = join("/tmp", `formicand-p3-fallback-${process.pid}-${Date.now()}.sqlite`);
  await assert.rejects(
    startDashboard({
      defaultProject: false,
      config: {
        projectData: {
          engine: "postgres",
          postgres: {
            connectionString: `postgresql://formicand_test:${encodeURIComponent(password)}@127.0.0.1:${port}/unreachable`
          }
        }
      },
      env: { FORMICAND_PROJECT_DATA_SQLITE: fallback }
    }),
    (error) => {
      assert.match(error.message, /PostgreSQL/);
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
      assert.ok(!error.message.includes(password), error.message);
      return true;
    }
  );
  await assert.rejects(stat(fallback), "no SQLite database was opened as a fallback");
  t.diagnostic(`refused postgres target 127.0.0.1:${port}`);
});
