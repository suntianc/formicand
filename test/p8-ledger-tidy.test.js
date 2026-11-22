import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { developmentNext } from "../dist/src/domain/development-ticket.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";

/**
 * The ledger tidy: the program counts merged developments and hands Main the
 * whole catalog to compare, Main folds a true duplicate into the feature that stays, and the
 * folded requirement is deleted once everything it held has moved.
 */

const feature = (requirementId, title, summary, extra = {}) => ({
  requirementId,
  kind: "feature",
  status: "active",
  title,
  description: "",
  aliases: [],
  summary,
  history: [],
  ...extra
});

test("every tenth merged development asks for a tidy", () => {
  const merged = {
    route: "quick",
    workspaceReady: true,
    tickets: [],
    merge: { mergeId: "m1", state: "merged", mergeCommit: "abc" },
    delivery: { state: "synced" }
  };
  assert.doesNotMatch(developmentNext({ ...merged, mergedSinceTidy: 9 }), /tidy/);
  assert.match(developmentNext({ ...merged, mergedSinceTidy: 10 }), /10 developments .* project_ledger tidy/);
});

async function openLedger(t, root) {
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(root, "project-data.sqlite") } },
    env: {},
    configPath: join(root, "config.json"),
    dataRoot: root
  });
  const service = await runtime.service();
  return { runtime, service };
}

async function ledger(t) {
  const root = await mkdtemp(join(tmpdir(), "coworkos-tidy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime, service } = await openLedger(t, root);
  t.after(() => runtime.close());
  const project = await service.ensureProject({
    projectId: "project_tidy",
    projectName: "待办",
    projectDirectory: root,
    backendId: "backend_local"
  });
  return { service, projectId: project.projectId, root, runtime };
}

const develop = (service, projectId, requirementId) =>
  service.createDevelopment(projectId, {
    requirementId,
    goal: "做这次改动",
    completionCriteria: ["测试通过"],
    route: "direct",
    baseline: { branch: "main", commit: "0".repeat(40) }
  });

/** Write merged deliveries straight into the file, as merges through the queue would. */
async function recordMerges(root, projectId, developmentId, requirementId, times) {
  const database = await SqliteDatabase.open(join(root, "project-data.sqlite"));
  for (const [index, at] of times.entries())
    await database.execute(
      `INSERT INTO project_data_deliveries
         (project_id, delivery_id, development_id, requirement_id, merge_id, candidate_commit, merged_commit,
          target_branch, merged_at, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'main', ?, 'synced', 1, ?, ?)`,
      [
        projectId,
        `delivery_${at}_${index}`,
        developmentId,
        requirementId,
        `merge_${at}_${index}`,
        "1".repeat(40),
        "2".repeat(40),
        at,
        at,
        at
      ]
    );
  // Each delivery writes one history line naming its development.
  for (const [index, at] of times.entries())
    await database.execute(
      `INSERT INTO project_data_requirement_history
         (project_id, requirement_id, entry_id, day, text, development_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        requirementId,
        `entry_${index}`,
        at.slice(0, 10),
        `第 ${index + 1} 次改动`,
        developmentId,
        at
      ]
    );
  await database.close();
}

test("the tidy counts developments merged since the last one and lists the whole catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-tidy-count-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openLedger(t, root);
  const project = await first.service.ensureProject({
    projectId: "project_tidy",
    projectName: "待办",
    projectDirectory: root,
    backendId: "backend_local"
  });
  const exported = await first.service.createRequirement(project.projectId, {
    title: "导出",
    description: "把条目导出成 CSV。"
  });
  const development = await develop(first.service, project.projectId, exported.requirementId);
  assert.equal((await first.service.tidyLedger(project.projectId)).merged, 0);
  await first.runtime.close();
  await recordMerges(root, project.projectId, development.developmentId, exported.requirementId, [
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z"
  ]);

  const again = await openLedger(t, root);
  t.after(() => again.runtime.close());
  const read = await again.service.tidyLedger(project.projectId);
  assert.equal(read.merged, 2);
  assert.equal(read.tidiedAt, undefined);
  assert.deepEqual(read.catalog.map((entry) => [entry.kind, entry.title, entry.description]).sort(), [
    ["feature", "导出", "把条目导出成 CSV。"],
    ["misc", "杂项", "与任何功能都无关的零碎改动，比如改错别字、调一个配置、改版本号。"]
  ]);
  assert.deepEqual(
    read.changes.map((change) => [change.title, change.history]),
    [
      ["导出", "第 1 次改动"],
      ["导出", "第 2 次改动"]
    ]
  );
  await assert.rejects(again.service.finishLedgerTidy(project.projectId), {
    code: "documents_verdict_missing"
  });
  const misc = read.catalog.find((entry) => entry.kind === "misc");
  const updated = await again.service.finishLedgerTidy(project.projectId, {
    update: [{ path: "README.md", reason: "导出命令改了参数" }]
  });
  assert.match(
    updated.next,
    new RegExp(`misc requirement ${misc.requirementId}[^]*README\\.md \\(导出命令改了参数\\)`)
  );
  // Each finish closes the read it answers: another one needs another read.
  await assert.rejects(again.service.finishLedgerTidy(project.projectId, { unchanged: "x" }), {
    code: "tidy_not_read"
  });
  await again.service.tidyLedger(project.projectId);
  const { tidiedAt, next } = await again.service.finishLedgerTidy(project.projectId, {
    unchanged: "两次只改了内部实现"
  });
  assert.equal(next, undefined);
  const after = await again.service.tidyLedger(project.projectId);
  assert.equal(after.tidiedAt, tidiedAt);
  assert.equal(after.merged, 0);
});

test("a merge that lands while Main tidies counts toward the next tidy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-tidy-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openLedger(t, root);
  const project = await first.service.ensureProject({
    projectId: "project_tidy",
    projectName: "待办",
    projectDirectory: root,
    backendId: "backend_local"
  });
  const exported = await first.service.createRequirement(project.projectId, { title: "导出" });
  const development = await develop(first.service, project.projectId, exported.requirementId);
  const read = await first.service.tidyLedger(project.projectId);
  assert.equal(read.merged, 0);
  await first.runtime.close();
  // Landed after the read, before the verdict.
  await recordMerges(root, project.projectId, development.developmentId, exported.requirementId, [
    new Date(Date.now() + 1000).toISOString()
  ]);

  const again = await openLedger(t, root);
  t.after(() => again.runtime.close());
  await again.service.finishLedgerTidy(project.projectId, { unchanged: "读到时没有合入" });
  const next = await again.service.tidyLedger(project.projectId);
  assert.equal(next.merged, 1);
  assert.deepEqual(
    next.changes.map((change) => change.history),
    ["第 1 次改动"]
  );
});

test("merging moves everything to the feature that stays and deletes the duplicate", async (t) => {
  const { service, projectId } = await ledger(t);
  const into = await service.createRequirement(projectId, {
    title: "导出给财务的 CSV",
    summary: "export 输出 CSV。",
    aliases: ["导出"]
  });
  const from = await service.createRequirement(projectId, {
    title: "CSV 列",
    summary: "表头行固定在第一行。",
    aliases: ["导出", "表头"],
    references: [{ kind: "task", value: "task_1" }]
  });
  const fromWithHistory = await service.updateRequirement(projectId, from.requirementId, {
    expectedRevision: from.revision,
    history: "把表头行固定下来"
  });
  const development = await develop(service, projectId, from.requirementId);

  // Both busy: each requirement keeps one active development, so this waits.
  const busy = await develop(service, projectId, into.requirementId);
  await assert.rejects(
    service.mergeRequirements(projectId, {
      from: from.requirementId,
      into: into.requirementId,
      expectedRevision: into.revision,
      fromRevision: fromWithHistory.revision,
      summary: "x"
    }),
    { code: "requirement_merge_busy" }
  );
  await service.updateDevelopment(projectId, busy.developmentId, {
    expectedRevision: busy.revision,
    status: "withdrawn"
  });
  // A stale revision of either side, or a missing summary, is refused: a merge
  // written from the duplicate's old text would drop what changed since.
  await assert.rejects(
    service.mergeRequirements(projectId, {
      from: from.requirementId,
      into: into.requirementId,
      expectedRevision: into.revision,
      fromRevision: from.revision,
      summary: "x"
    }),
    { code: "revision_conflict" }
  );
  await assert.rejects(
    service.mergeRequirements(projectId, {
      from: from.requirementId,
      into: into.requirementId,
      expectedRevision: into.revision + 1,
      fromRevision: fromWithHistory.revision,
      summary: "x"
    }),
    { code: "revision_conflict" }
  );
  await assert.rejects(
    service.mergeRequirements(projectId, {
      from: from.requirementId,
      into: into.requirementId,
      expectedRevision: into.revision,
      fromRevision: fromWithHistory.revision
    }),
    { code: "invalid_project_data" }
  );
  const misc = (await service.queryRequirements(projectId)).find((entry) => entry.kind === "misc");
  await assert.rejects(
    service.updateRequirement(projectId, misc.requirementId, {
      expectedRevision: misc.revision,
      description: "改掉杂项的描述"
    }),
    { code: "requirement_misc_fixed" }
  );
  await assert.rejects(
    service.mergeRequirements(projectId, {
      from: misc.requirementId,
      into: into.requirementId,
      expectedRevision: into.revision,
      fromRevision: misc.revision,
      summary: "x"
    }),
    { code: "requirement_misc_fixed" }
  );

  const merged = await service.mergeRequirements(projectId, {
    from: from.requirementId,
    into: into.requirementId,
    expectedRevision: into.revision,
    fromRevision: fromWithHistory.revision,
    summary: "export 输出 CSV。表头行固定在第一行。",
    taskId: "task_main"
  });
  assert.equal(merged.summary, "export 输出 CSV。表头行固定在第一行。");
  assert.equal(merged.revision, into.revision + 1);
  assert.equal(merged.revisions.at(-1).note, `并入 ${from.requirementId}`);
  // The duplicate's title joins its aliases; a name both had is kept once.
  assert.deepEqual(merged.aliases.map((alias) => alias.alias).sort(), ["CSV 列", "导出", "表头"].sort());
  assert.deepEqual(
    merged.history.map((entry) => entry.text),
    [fromWithHistory.history[0].text, "合并了重复的需求「CSV 列」"]
  );
  assert.ok(merged.references.some((reference) => reference.value === "task_1"));
  assert.equal(
    (await service.getDevelopment(projectId, development.developmentId)).requirementId,
    into.requirementId
  );
  await assert.rejects(service.getRequirement(projectId, from.requirementId), { code: "not_found" });
  assert.equal(
    (await service.queryRequirements(projectId)).some((entry) => entry.requirementId === from.requirementId),
    false
  );
});

test("a version 9 ledger gains the tidy mark and each requirement a description", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-tidy-v9-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openLedger(t, root);
  const project = await first.service.ensureProject({
    projectId: "project_v9",
    projectName: "旧项目",
    projectDirectory: root,
    backendId: "backend_local"
  });
  const exported = await first.service.createRequirement(project.projectId, {
    title: "导出",
    summary: "export 输出 CSV。列只能往后加。"
  });
  await first.runtime.close();

  // Put the file back to version 9: no tidy mark, recorded at 9.
  const database = await SqliteDatabase.open(join(root, "project-data.sqlite"));
  await database.execute("ALTER TABLE project_data_projects DROP COLUMN ledger_tidied_at");
  await database.execute("ALTER TABLE project_data_projects DROP COLUMN ledger_tidy_read_at");
  for (const table of ["project_data_requirements", "project_data_requirement_revisions"])
    await database.execute(`ALTER TABLE ${table} DROP COLUMN description`);
  await database.execute("ALTER TABLE project_data_development_reviews DROP COLUMN mapping");
  await database.execute("DELETE FROM project_data_migrations");
  await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (9, ?)", [
    new Date().toISOString()
  ]);
  await database.close();

  const again = await openLedger(t, root);
  t.after(() => again.runtime.close());
  assert.equal(again.service.description.schemaVersion, 12);
  // A version 9 requirement takes its summary's first sentence as its description.
  const upgraded = await again.service.getRequirement(project.projectId, exported.requirementId);
  assert.equal(upgraded.description, "export 输出 CSV。");
  assert.equal(upgraded.revisions[0].description, "export 输出 CSV。");
  // Never tidied: every merge so far counts toward the first tidy.
  assert.equal((await again.service.tidyLedger(project.projectId)).tidiedAt, undefined);
});

test("a version 11 ledger gains the tidy read time, with no tidy in progress", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-tidy-v11-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openLedger(t, root);
  const project = await first.service.ensureProject({
    projectId: "project_v11",
    projectName: "旧项目",
    projectDirectory: root,
    backendId: "backend_local"
  });
  await first.runtime.close();

  const database = await SqliteDatabase.open(join(root, "project-data.sqlite"));
  await database.execute("ALTER TABLE project_data_projects DROP COLUMN ledger_tidy_read_at");
  await database.execute("DELETE FROM project_data_migrations");
  await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (11, ?)", [
    new Date().toISOString()
  ]);
  await database.close();

  const again = await openLedger(t, root);
  t.after(() => again.runtime.close());
  assert.equal(again.service.description.schemaVersion, 12);
  await assert.rejects(again.service.finishLedgerTidy(project.projectId, { unchanged: "x" }), {
    code: "tidy_not_read"
  });
  await again.service.tidyLedger(project.projectId);
  assert.ok((await again.service.finishLedgerTidy(project.projectId, { unchanged: "x" })).tidiedAt);
});
