import { deferCleanup } from "./fixtures/cleanup.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { developmentNext } from "../dist/src/domain/development-ticket.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";

/**
 * A development the user stops: paused keeps it and its board card for later,
 * withdrawn drops it (and a feature that never merged), and a later
 * development picks the withdrawn one up again.
 */

const BACKEND = "backend_local";
const HOST = { backendId: BACKEND, actor: { id: "host", host: true } };

async function openLedger(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-pause-"));
  deferCleanup(t, () => rm(root, { recursive: true, force: true }));
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(root, "project-data.sqlite") } },
    env: {},
    configPath: join(root, "config.json"),
    dataRoot: root
  });
  deferCleanup(t, () => runtime.close());
  const service = await runtime.service();
  const project = await service.ensureProject({
    projectId: "project_pause",
    projectName: "待办",
    projectDirectory: root,
    backendId: BACKEND
  });
  return { service, projectId: project.projectId };
}

const develop = (service, projectId, requirementId, extra = {}) =>
  service.createDevelopment(projectId, {
    requirementId,
    goal: "做这次改动",
    completionCriteria: ["测试通过"],
    route: "quick",
    baseline: { branch: "main", commit: "0".repeat(40) },
    ...extra
  });

const update = (service, projectId, development, input) =>
  service.updateDevelopment(
    projectId,
    development.developmentId,
    { expectedRevision: development.revision, ...input },
    BACKEND
  );

test("pausing keeps the development and its card; resuming puts both back", async (t) => {
  const { service, projectId } = await openLedger(t);
  const card = await service.publishBoardEntry(
    projectId,
    {
      title: "到期提醒",
      content: "到期前一天提醒。",
      source: { kind: "external" },
      requestId: "publish-remind"
    },
    HOST
  );
  const claimed = await service.boardAction(
    projectId,
    card.boardId,
    "claim",
    { expectedRevision: card.revision, requestId: "claim-remind" },
    HOST
  );
  const development = await develop(service, projectId, card.requirementId);

  await assert.rejects(update(service, projectId, development, { status: "paused" }), /reason/);
  const paused = await update(service, projectId, development, { status: "paused", reason: "客户先不要了" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.reason, "客户先不要了");
  assert.equal((await service.boardEntry(projectId, card.boardId)).state, "paused");

  // A paused development holds the requirement: no second one, no edits, and it is the one found.
  await assert.rejects(develop(service, projectId, card.requirementId), /已暂停/);
  await assert.rejects(update(service, projectId, paused, { goal: "改目标" }), {
    code: "development_paused"
  });
  assert.equal(
    (await service.findDevelopmentByRequirement(projectId, card.requirementId)).developmentId,
    development.developmentId
  );
  // Nor does it take new tickets, an Executor's start or a merge.
  await assert.rejects(
    service.writeTickets(projectId, development.developmentId, { op: "propose", tickets: [] }),
    {
      code: "development_paused"
    }
  );
  const commit = "1".repeat(40);
  await assert.rejects(
    service.createMerge(projectId, development.developmentId, {
      candidate: { commit, tree: "2".repeat(40), branch: "dev", workspace: "/tmp/dev" },
      acceptance: { channel: "self", approvedCommit: commit, approvedTree: "2".repeat(40) },
      checks: [{ name: "测试", command: "npm test" }],
      requestedBy: BACKEND,
      executionBackendId: BACKEND,
      targetBranch: "main"
    }),
    { code: "development_closed" }
  );
  assert.match(
    developmentNext({
      route: "quick",
      status: "paused",
      reason: "客户先不要了",
      workspaceReady: true,
      tickets: []
    }),
    /resume/
  );

  const resumed = await update(service, projectId, paused, { status: "active" });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.reason, undefined);
  // The card returns to the state it was paused from.
  assert.equal((await service.boardEntry(projectId, card.boardId)).state, claimed.state);
  const kinds = (await service.boardEvents(projectId, card.boardId)).map((event) => event.kind);
  assert.deepEqual(kinds, ["published", "claimed", "paused", "resumed"]);

  // A card its owner paused stays paused through the development's pause and resume.
  const card2 = await service.boardEntry(projectId, card.boardId);
  const held = await service.boardAction(
    projectId,
    card.boardId,
    "pause",
    { expectedRevision: card2.revision, requestId: "owner-pause" },
    HOST
  );
  assert.equal(held.state, "paused");
  const again = await update(service, projectId, resumed, { status: "paused", reason: "再等等" });
  await update(service, projectId, again, { status: "active" });
  assert.equal((await service.boardEntry(projectId, card.boardId)).state, "paused");
});

test("withdrawing a feature that never merged retires it; picking it up brings it back", async (t) => {
  const { service, projectId } = await openLedger(t);
  const card = await service.publishBoardEntry(
    projectId,
    {
      title: "到期提醒",
      content: "到期前一天提醒。",
      source: { kind: "external" },
      requestId: "publish-remind"
    },
    HOST
  );
  const development = await develop(service, projectId, card.requirementId);
  const paused = await update(service, projectId, development, { status: "paused", reason: "先放放" });

  await assert.rejects(update(service, projectId, paused, { status: "withdrawn" }), /reason/);
  const withdrawn = await update(service, projectId, paused, {
    status: "withdrawn",
    reason: "客户不做提醒了"
  });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal((await service.boardEntry(projectId, card.boardId)).state, "cancelled");
  assert.equal((await service.getRequirement(projectId, card.requirementId)).status, "retired");

  // Lookup still finds it, marked retired with why it was dropped.
  const found = await service.lookupRequirements(projectId, "到期提醒");
  assert.equal(found.candidates[0].requirementId, card.requirementId);
  assert.deepEqual(found.candidates[0].retired, { withdrawnReason: "客户不做提醒了" });

  // Only a pick-up of a withdrawn development of the same feature may start on it.
  await assert.rejects(develop(service, projectId, card.requirementId), { code: "requirement_retired" });
  const other = await service.createRequirement(projectId, { title: "导出", summary: "导出 CSV。" });
  const elsewhere = await develop(service, projectId, other.requirementId);
  await assert.rejects(
    develop(service, projectId, card.requirementId, { continues: elsewhere.developmentId }),
    /continues/
  );
  const again = await develop(service, projectId, card.requirementId, {
    continues: development.developmentId
  });
  assert.equal(again.continues, development.developmentId);
  assert.equal((await service.getRequirement(projectId, card.requirementId)).status, "active");
  const developments = await service.queryDevelopments(projectId);
  assert.deepEqual(
    developments
      .filter((entry) => entry.requirementId === card.requirementId)
      .map((entry) => [entry.status, entry.reason ?? null, entry.continues ?? null]),
    [
      ["active", null, development.developmentId],
      ["withdrawn", "客户不做提醒了", null]
    ]
  );
});

test("withdrawing more work on a feature that merged before keeps the feature", async (t) => {
  const { service, projectId } = await openLedger(t);
  const feature = await service.createRequirement(projectId, { title: "导出", summary: "导出 CSV。" });
  const first = await develop(service, projectId, feature.requirementId);
  // The first development merged; the store records that as its status.
  await service.transaction((repository) =>
    repository.transaction.execute(
      "UPDATE project_data_developments SET status = 'merged' WHERE development_id = ?",
      [first.developmentId]
    )
  );
  const second = await develop(service, projectId, feature.requirementId);
  await update(service, projectId, second, { status: "withdrawn", reason: "这一列不加了" });
  assert.equal((await service.getRequirement(projectId, feature.requirementId)).status, "active");
  // The misc requirement is never retired either.
  const misc = (await service.queryRequirements(projectId, {})).find((entry) => entry.kind === "misc");
  const tidy = await develop(service, projectId, misc.requirementId);
  await update(service, projectId, tidy, { status: "withdrawn", reason: "不改了" });
  assert.equal((await service.getRequirement(projectId, misc.requirementId)).status, "active");
});
