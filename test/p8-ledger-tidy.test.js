import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { similarPairs } from "../dist/src/domain/ledger-lookup.js";
import { duplicateFeature, history } from "../scripts/eval/history.mjs";
import { developmentNext } from "../dist/src/domain/development-ticket.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { SqliteDatabase } from "../dist/src/storage/project-data/sqlite-database.js";

/**
 * The ledger tidy: the program counts new features and lists pairs that look
 * alike, Main folds a true duplicate into the feature that stays, and the
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

test("similar pairs find a short duplicate inside a long feature", () => {
  // The eval's older project: thirteen features and the export rule recorded
  // twice, once under a narrower title.
  const entries = [...history, duplicateFeature].map((entry, index) =>
    feature(`r${index}`, entry.title, entry.summary, {
      description: entry.description,
      history: entry.history,
      status: entry.status ?? "active"
    })
  );
  const exported = entries.find((entry) => entry.title === "导出给财务的 CSV");
  const columns = entries.find((entry) => entry.title === "CSV 列");
  const pairs = similarPairs([
    ...entries,
    // Neither the misc requirement nor a retired feature is folded.
    { ...feature("r_misc", "杂项", columns.summary), kind: "misc" },
    feature("r_old", "旧的 CSV 列", columns.summary, { status: "retired" })
  ]);
  assert.ok(pairs.length <= 10);
  assert.deepEqual(
    [pairs[0].left.requirementId, pairs[0].right.requirementId].sort(),
    [exported.requirementId, columns.requirementId].sort()
  );
  assert.ok(pairs[0].shared.includes("csv"));
  for (const pair of pairs) {
    assert.ok(pair.similarity >= 0.5 && pair.similarity <= 1);
    assert.ok(
      ![pair.left.requirementId, pair.right.requirementId].some((id) => id === "r_misc" || id === "r_old")
    );
  }
});

test("a merged development asks for a tidy once five features are new", () => {
  const merged = {
    route: "quick",
    workspaceReady: true,
    tickets: [],
    merge: { mergeId: "m1", state: "merged", mergeCommit: "abc" },
    delivery: { state: "synced" }
  };
  assert.doesNotMatch(developmentNext({ ...merged, ledgerCreated: 4 }), /tidy/);
  assert.match(developmentNext({ ...merged, ledgerCreated: 5 }), /5 features .* project_ledger tidy/);
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

test("the tidy counts features created since the last one", async (t) => {
  const { service, projectId } = await ledger(t);
  // The misc requirement the project starts with is not a new feature.
  assert.equal((await service.tidyLedger(projectId)).created, 0);
  for (const title of ["导出", "导入", "搜索"]) await service.createRequirement(projectId, { title });
  const read = await service.tidyLedger(projectId);
  assert.equal(read.created, 3);
  assert.equal(read.tidiedAt, undefined);
  assert.equal(read.catalog.length, 4);
  const { tidiedAt } = await service.finishLedgerTidy(projectId);
  await new Promise((done) => setTimeout(done, 5));
  await service.createRequirement(projectId, { title: "标签" });
  const after = await service.tidyLedger(projectId);
  assert.equal(after.tidiedAt, tidiedAt);
  assert.equal(after.created, 1);
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
      summary: "x"
    }),
    { code: "requirement_merge_busy" }
  );
  await service.updateDevelopment(projectId, busy.developmentId, {
    expectedRevision: busy.revision,
    status: "withdrawn"
  });
  // A stale revision of the one that stays, or a missing summary, is refused.
  await assert.rejects(
    service.mergeRequirements(projectId, {
      from: from.requirementId,
      into: into.requirementId,
      expectedRevision: into.revision + 1,
      summary: "x"
    }),
    { code: "revision_conflict" }
  );
  await assert.rejects(
    service.mergeRequirements(projectId, {
      from: from.requirementId,
      into: into.requirementId,
      expectedRevision: into.revision
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
      summary: "x"
    }),
    { code: "requirement_misc_fixed" }
  );

  const merged = await service.mergeRequirements(projectId, {
    from: from.requirementId,
    into: into.requirementId,
    expectedRevision: into.revision,
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

test("a version 9 ledger gains the tidy mark and counts every feature as new", async (t) => {
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
  for (const table of ["project_data_requirements", "project_data_requirement_revisions"])
    await database.execute(`ALTER TABLE ${table} DROP COLUMN description`);
  await database.execute("DELETE FROM project_data_migrations");
  await database.execute("INSERT INTO project_data_migrations (version, applied_at) VALUES (9, ?)", [
    new Date().toISOString()
  ]);
  await database.close();

  const again = await openLedger(t, root);
  t.after(() => again.runtime.close());
  assert.equal(again.service.description.schemaVersion, 10);
  // A version 9 requirement takes its summary's first sentence as its description.
  const upgraded = await again.service.getRequirement(project.projectId, exported.requirementId);
  assert.equal(upgraded.description, "export 输出 CSV。");
  assert.equal(upgraded.revisions[0].description, "export 输出 CSV。");
  const tidy = await again.service.tidyLedger(project.projectId);
  assert.equal(tidy.created, 1);
  assert.equal(tidy.tidiedAt, undefined);
  await again.service.finishLedgerTidy(project.projectId);
  assert.equal((await again.service.tidyLedger(project.projectId)).created, 0);
});
