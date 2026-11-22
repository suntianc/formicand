import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { prepareWorkItemSite } from "../dist/src/workspace/work-item-workspace.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";

/**
 * A ticket's whole way: dispatched with its brief, implemented in its own
 * checkout, frozen there with a scope check, reviewed, sent back for rework,
 * reviewed again, brought into the requirement checkout by the program with
 * its checks; then the full route's final review of the whole requirement,
 * whose defect becomes a fix ticket, and the merge.
 *
 * The Git checkouts, the database and the merge are real; the Executor and
 * Reviewer are stood in for by commits in their own checkouts and the call
 * facts their queue would record.
 */

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

async function repository(directory) {
  await mkdir(join(directory, "src"), { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  // The document registry every requirement merge checks.
  await writeFile(
    join(directory, "AGENTS.md"),
    "## 文档\n\n| 路径 | 类型 | 领域 |\n| --- | --- | --- |\n| AGENTS.md | instructions | global |\n"
  );
  await writeFile(join(directory, "src", "cli.js"), "export const page = 1;\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

const ticket = (ticketId, file, extra = {}) => ({
  ticketId,
  title: `写 ${file}`,
  scope: [file],
  criteria: [{ text: `${file} 存在`, command: `test -f ${file}` }],
  ...extra
});

async function commit(directory, files, message) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-m", message]);
}

test(
  "a ticket is reviewed in its own checkout and brought in by the program",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p48-ticket-flow-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = await repository(join(root, "repository"));
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: join(root, "project-data.sqlite") } },
      configPath: join(root, "config.json"),
      dataRoot: root,
      env: {}
    });
    t.after(() => runtime.close());
    const gateway = await runtime.service();
    const projectId = "project_flow";
    await gateway.ensureProject({
      projectId,
      projectName: "票流程",
      projectDirectory: repo,
      backendId: "backend_flow"
    });
    const requirement = await gateway.createRequirement(projectId, { title: "分页", summary: "两张票" });
    const projectInfo = { projectId, projectName: "票流程", projectDirectory: repo };
    const calls = {};
    const developmentRoot = join(root, "development-workspaces");
    const service = createProjectDevelopmentService({
      runtime: { service: async () => gateway },
      backendId: "backend_flow",
      developmentRoot,
      project: async (id) => (id === projectId ? projectInfo : undefined),
      taskProject: async (id) => (id === "task-flow" ? projectInfo : undefined),
      call: async (_taskId, callId) => calls[callId]
    });
    await service.setMergeConfig(projectId, { repository: repo, targetBranch: "main" });
    const development = await service.create(projectId, {
      requirementId: requirement.requirementId,
      goal: "两个文件",
      completionCriteria: ["两个文件都在"],
      route: "full"
    });
    const developmentId = development.developmentId;
    const integration = development.workspace.directory;
    let set = await service.writeTickets(projectId, developmentId, {
      op: "propose",
      tickets: [
        ticket("01", "src/a.txt"),
        ticket("02", "src/b.txt", { dependsOn: ["01"] }),
        // A Chinese path: git quotes it unless told not to.
        ticket("03", "src/说明.txt")
      ]
    });
    set = await service.writeTickets(projectId, developmentId, {
      op: "confirm",
      expectedRevision: set.revision
    });

    // Only a ticket whose dependencies are merged can start; the brief carries the ticket.
    await assert.rejects(
      service.ticketForDispatch("task-flow", developmentId, "02"),
      /依赖的票 01 还没有合入/
    );
    const dispatched = await service.ticketForDispatch("task-flow", developmentId, "01");
    assert.match(dispatched.brief, /^Ticket 01: 写 src\/a\.txt/);
    assert.match(dispatched.brief, /Change only these paths:\n- src\/a\.txt/);
    assert.match(dispatched.brief, /AC1 src\/a\.txt 存在 \(check: test -f src\/a\.txt\)/);
    assert.deepEqual(dispatched.criteria, ["AC1"], "the Executor answers each criterion in its report");
    assert.match(await service.next(projectId, developmentId), /Tickets 01, 03 can start/);

    // A finished Executor in its own checkout, the way the queue records it.
    const executor = async (callId, ticketId, files) => {
      const directory = join(developmentRoot, "work-items", callId);
      await prepareWorkItemSite({
        developmentDirectory: integration,
        directory,
        branch: `coworkos/work/${callId}`
      });
      await service.ticketStarted("task-flow", developmentId, ticketId, {
        callId,
        agentId: `agent-${callId}`,
        workspace: directory
      });
      calls[callId] = {
        callId,
        agentId: `agent-${callId}`,
        role: "executor",
        workspace: directory,
        developmentId,
        status: "running"
      };
      await commit(directory, files, `ticket ${ticketId}`);
      calls[callId].status = "completed";
      return directory;
    };
    // A Reviewer's checkout of the frozen commit, as dispatch prepares it.
    const reviewer = async (review, callId) => {
      const directory = join(developmentRoot, "work-items", callId);
      await git(integration, ["worktree", "add", "--detach", directory, review.candidate.commit]);
      calls[callId] = {
        callId,
        agentId: `agent-${callId}`,
        role: "reviewer",
        workspace: directory,
        developmentId,
        status: "completed"
      };
      return service.attachReviewer(projectId, "task-flow", { reviewId: review.reviewId, callId });
    };
    const passing = [{ name: "存在", command: "ls src", exitCode: 0, output: "a.txt" }];
    const mapping = [{ requirement: "两个文件都在", evidence: "test -f src/a.txt && test -f src/b.txt" }];

    const site = await executor("call-e1", "01", { "src/a.txt": "a\n", "notes.txt": "stray\n" });
    assert.equal((await service.tickets(projectId, developmentId)).tickets[0].state, "in_progress");
    await assert.rejects(
      service.startReview(projectId, "task-flow", { developmentId, kind: "independent" }),
      /还没有并进需求现场；整体终审在全部票并入之后/,
      "before every ticket is in, the full route reviews tickets, not the requirement checkout"
    );
    await assert.rejects(
      service.startReview(projectId, "task-flow", { developmentId, ticketId: "01" }),
      /范围以外的文件：notes\.txt/
    );
    await git(site, ["rm", "-q", "notes.txt"]);
    await git(site, ["commit", "-m", "keep to the ticket"]);
    let review = await service.startReview(projectId, "task-flow", { developmentId, ticketId: "01" });
    assert.equal(review.candidate.workspace, site, "the ticket's own checkout is frozen");
    assert.equal(review.author.callId, "call-e1");
    assert.equal((await service.tickets(projectId, developmentId)).tickets[0].state, "in_review");
    assert.match(await service.next(projectId, developmentId), /Ticket 01: Review .* is frozen/);

    // A failed review sends the ticket back; the rework continues the same checkout.
    review = await reviewer(review, "call-r1");
    await service.completeReview(projectId, {
      reviewId: review.reviewId,
      verdict: "failed",
      summary: "内容要两行",
      checks: []
    });
    assert.equal((await service.tickets(projectId, developmentId)).tickets[0].state, "rework");
    assert.deepEqual(await service.ticketForDispatch("task-flow", developmentId, "01", true), {
      ticketId: "01",
      criteria: ["AC1"],
      start: true
    });
    await service.ticketStarted("task-flow", developmentId, "01", {
      callId: "call-e1b",
      agentId: "agent-call-e1",
      workspace: site
    });
    calls["call-e1b"] = { ...calls["call-e1"], callId: "call-e1b", status: "completed" };
    await commit(site, { "src/a.txt": "a\nsecond\n" }, "rework");
    review = await service.startReview(projectId, "task-flow", {
      developmentId,
      ticketId: "01",
      previousReviewId: review.reviewId
    });
    review = await reviewer(review, "call-r2");
    await service.completeReview(projectId, {
      reviewId: review.reviewId,
      verdict: "passed",
      summary: "可以",
      checks: passing
    });
    assert.equal((await service.tickets(projectId, developmentId)).tickets[0].state, "passed");
    assert.match(await service.next(projectId, developmentId), /01 passed review: integrate_ticket/);

    // A failing project check leaves the requirement checkout as it was.
    const before = await git(integration, ["rev-parse", "HEAD"]);
    const failed = await service.integrateTicket(projectId, {
      developmentId,
      ticketId: "01",
      checks: [{ name: "项目检查", command: "exit 3" }]
    });
    assert.equal(failed.integrated, false);
    assert.equal(failed.checks[0].exitCode, 3);
    assert.equal(await git(integration, ["rev-parse", "HEAD"]), before);
    assert.equal(await git(integration, ["status", "--porcelain"]), "");

    const integrated = await service.integrateTicket(projectId, {
      developmentId,
      ticketId: "01",
      checks: [{ name: "项目检查", command: "test -f src/cli.js" }]
    });
    assert.equal(integrated.integrated, true);
    const first = integrated.tickets.tickets[0];
    assert.equal(first.state, "merged");
    assert.deepEqual(
      first.integration.checks.map((check) => [check.name, check.exitCode]),
      [
        ["项目检查", 0],
        ["01 AC1", 0]
      ],
      "the project's check, then the ticket's acceptance command"
    );
    assert.equal(await readFile(join(integration, "src", "a.txt"), "utf8"), "a\nsecond\n");
    assert.equal(first.integration.commit, await git(integration, ["rev-parse", "HEAD"]));

    // The second ticket is unblocked now and goes the same way.
    assert.match(await service.next(projectId, developmentId), /Tickets 02, 03 can start/);
    let qualification = await service.delivery(projectId, developmentId);
    assert.ok(qualification.reasons.includes("tickets_pending"));
    // Two tickets in review at once: a Reviewer must say which one it examines.
    await service.ticketForDispatch("task-flow", developmentId, "02");
    await executor("call-e2", "02", { "src/b.txt": "b\n" });
    await executor("call-e3", "03", { "src/说明.txt": "c\n" });
    const second = await service.startReview(projectId, "task-flow", { developmentId, ticketId: "02" });
    const third = await service.startReview(projectId, "task-flow", { developmentId, ticketId: "03" });
    await assert.rejects(service.frozenCandidateForTask("task-flow", developmentId), /用 reviewId 指明/);
    assert.equal(
      (await service.frozenCandidateForTask("task-flow", developmentId, third.reviewId)).commit,
      third.candidate.commit
    );
    for (const [frozen, callId] of [
      [second, "call-r3"],
      [third, "call-r4"]
    ]) {
      const bound = await reviewer(frozen, callId);
      await service.completeReview(projectId, {
        reviewId: bound.reviewId,
        verdict: "passed",
        summary: "可以",
        checks: passing
      });
    }
    // Main may bring two tickets in at once: one's failing check undoes only its own merge.
    const [slowFailure, other] = await Promise.all([
      service.integrateTicket(projectId, {
        developmentId,
        ticketId: "02",
        checks: [{ name: "项目检查", command: "sleep 0.3; exit 3" }]
      }),
      service.integrateTicket(projectId, {
        developmentId,
        ticketId: "03",
        checks: [{ name: "项目检查", command: "test -f src/cli.js" }]
      })
    ]);
    assert.equal(slowFailure.integrated, false);
    assert.equal(other.integrated, true, JSON.stringify(other));
    assert.equal(await readFile(join(integration, "src", "说明.txt"), "utf8"), "c\n");
    const kept = other.tickets.tickets.find((entry) => entry.ticketId === "03").integration.commit;
    await git(integration, ["merge-base", "--is-ancestor", kept, "HEAD"]);
    const retried = await service.integrateTicket(projectId, {
      developmentId,
      ticketId: "02",
      checks: [{ name: "项目检查", command: "test -f src/cli.js" }]
    });
    assert.equal(retried.integrated, true, JSON.stringify(retried));

    // A hand-made commit after the last ticket is not the version the tickets produced.
    await commit(integration, { "src/extra.txt": "x\n" }, "not a ticket");
    qualification = await service.delivery(projectId, developmentId);
    assert.ok(qualification.reasons.includes("candidate_changed"));
    await git(integration, ["reset", "-q", "--hard", "HEAD~1"]);

    // Every ticket is in: the full route still needs one review of the whole requirement.
    qualification = await service.delivery(projectId, developmentId);
    assert.deepEqual(qualification.reasons, ["final_review_missing"]);
    assert.match(await service.next(projectId, developmentId), /Write the acceptance mapping, then freeze/);
    // Main maps the plan onto the integrated tree before the final review, every round.
    await assert.rejects(
      service.startReview(projectId, "task-flow", { developmentId }),
      /整体终审先写对照表/
    );
    await assert.rejects(
      service.startReview(projectId, "task-flow", { developmentId, ticketId: "01", mapping }),
      /只有 full 路线的整体终审带对照表/
    );
    // Two freezes at once open one final review.
    const freezes = await Promise.allSettled([
      service.startReview(projectId, "task-flow", { developmentId, mapping }),
      service.startReview(projectId, "task-flow", { developmentId, mapping })
    ]);
    assert.deepEqual(freezes.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.match(
      freezes.find((result) => result.status === "rejected").reason.message,
      /已有一份进行中的整体终审/
    );
    let final = freezes.find((result) => result.status === "fulfilled").value;
    assert.deepEqual(
      final.mapping.map((row) => row.rowId),
      ["M1"]
    );
    assert.equal(final.candidate.workspace, integration, "the final review freezes the requirement checkout");
    assert.equal(final.candidate.commit, await git(integration, ["rev-parse", "HEAD"]));
    await assert.rejects(
      service.startReview(projectId, "task-flow", { developmentId, mapping }),
      /已有一份进行中的整体终审/
    );
    // The Reviewer is told what it examines, from the records.
    const frozenFinal = await service.frozenCandidateForTask("task-flow", developmentId, final.reviewId);
    assert.match(frozenFinal.brief, /^You give the final review of the whole requirement/);
    assert.match(frozenFinal.brief, /Requirement: 两个文件/);
    assert.match(frozenFinal.brief, /Completion criteria:\n- CC1 两个文件都在/);
    assert.match(frozenFinal.brief, /- 02 写 src\/b\.txt: src\/b\.txt 存在/);
    assert.match(frozenFinal.brief, /Acceptance mapping, written by Main: claims to verify, not evidence/);
    assert.match(frozenFinal.brief, /- M1 两个文件都在 — evidence: test -f src\/a\.txt/);
    assert.deepEqual(frozenFinal.scope.criteria, ["CC1", "M1"], "a blocking finding may cite a mapping row");
    assert.match(
      (
        await service
          .frozenCandidateForTask("task-flow", developmentId, review.reviewId)
          .catch((error) => error)
      ).message,
      /不是这个需求里正在进行的审查/
    );
    final = await reviewer(final, "call-rf1");
    assert.match(
      await service.next(projectId, developmentId),
      /Final review: Review .* has its Reviewer's findings/
    );
    final = await service.recordFinding(projectId, {
      reviewId: final.reviewId,
      blocking: true,
      basis: "CC1",
      title: "缺少总说明",
      detail: "三个文件之间没有说明",
      checks: []
    });
    final = await service.completeReview(projectId, {
      reviewId: final.reviewId,
      verdict: "failed",
      summary: "缺少总说明",
      checks: []
    });
    await service.ruleFinding(projectId, {
      reviewId: final.reviewId,
      findingId: final.findings[0].findingId,
      decision: "fix",
      basis: "完成标准要求整体可用"
    });
    assert.match(
      await service.next(projectId, developmentId),
      /becomes a new fix ticket[^]*reproduce the defect yourself on the requirement checkout/
    );
    qualification = await service.delivery(projectId, developmentId);
    assert.ok(qualification.reasons.includes("review_failed"), JSON.stringify(qualification.reasons));
    // Leaving out the previous review does not reopen the failed version.
    await assert.rejects(service.startReview(projectId, "task-flow", { developmentId, mapping }), {
      code: "review_candidate_unchanged"
    });
    await assert.rejects(
      service.startReview(projectId, "task-flow", {
        developmentId,
        mapping,
        previousReviewId: review.reviewId
      }),
      { code: "review_previous_mismatch" }
    );

    // The defect becomes a fix ticket, confirmed and brought in like the others.
    set = await service.writeTickets(projectId, developmentId, {
      op: "propose",
      tickets: [ticket("04", "src/README.txt")]
    });
    set = await service.writeTickets(projectId, developmentId, {
      op: "confirm",
      expectedRevision: set.revision
    });
    await service.ticketForDispatch("task-flow", developmentId, "04");
    await executor("call-e4", "04", { "src/README.txt": "a, b, c\n" });
    let fix = await service.startReview(projectId, "task-flow", { developmentId, ticketId: "04" });
    fix = await reviewer(fix, "call-r5");
    await service.completeReview(projectId, {
      reviewId: fix.reviewId,
      verdict: "passed",
      summary: "可以",
      checks: passing
    });
    await service.integrateTicket(projectId, {
      developmentId,
      ticketId: "04",
      checks: [{ name: "项目检查", command: "test -f src/cli.js" }]
    });
    // The re-review follows the failed one, and its pass settles the ruled finding.
    let again = await service.startReview(projectId, "task-flow", {
      developmentId,
      previousReviewId: final.reviewId,
      mapping
    });
    assert.deepEqual(again.changedPaths, ["src/README.txt"]);
    again = await reviewer(again, "call-rf2");
    await service.completeReview(projectId, {
      reviewId: again.reviewId,
      verdict: "passed",
      summary: "整体可以",
      checks: passing
    });
    const settled = (await gateway.queryReviews(projectId, developmentId)).find(
      (entry) => entry.reviewId === final.reviewId
    );
    assert.equal(settled.findings[0].state, "fixed");

    qualification = await service.delivery(projectId, developmentId);
    assert.equal(qualification.eligible, true, JSON.stringify(qualification.reasons));
    assert.equal(qualification.reviewId, again.reviewId);
    assert.match(await service.next(projectId, developmentId), /qualifies: request_merge/);
    const merge = await service.requestMerge(projectId, {
      developmentId,
      ledger: { summaryUnchanged: "测试不改现状", history: "测试合入", descriptionUnchanged: true }
    });
    assert.equal(merge.state, "merged", JSON.stringify(merge));
    assert.equal(merge.acceptance.tickets, true);
    assert.equal(merge.acceptance.reviewId, again.reviewId, "the final review the merge was accepted on");
    assert.deepEqual(
      merge.checks.map((check) => check.command),
      [
        "test -f src/cli.js",
        "test -f src/a.txt",
        "test -f src/b.txt",
        "test -f src/说明.txt",
        "test -f src/README.txt"
      ],
      "the checks each ticket passed run again on the combined version"
    );
    assert.equal(await git(repo, ["show", "main:src/b.txt"]), "b");
    assert.match(await service.next(projectId, developmentId), /^Merged/);
  }
);

async function servingToken(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token) return instance.value.token;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

test(
  "call_subagent with a ticket writes its brief into the task and starts the ticket",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p48-ticket-dispatch-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = await repository(join(root, "repository"));
    const provider = await modelProtocolFixture("openai-completions", () => ({ text: "完成。" }));
    t.after(() => provider.close());
    const dashboard = await startDashboard({
      defaultProject: false,
      modelEndpoint: provider.baseUrl,
      model: "protocol-fixture",
      env: { COWORK_DISABLE_MAIN_GUARDIAN: "1" }
    });
    t.after(() => dashboard.stop());
    const token = await servingToken(dashboard.root);
    const post = async (path, body, auth = false) => {
      const response = await fetch(`${dashboard.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { "x-atria-token": token } : {}) },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    const project = (await post("/api/projects", { projectName: "派单票", projectDirectory: repo })).body
      .project;
    const requirement = (
      await post(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
        action: "create",
        title: "分页",
        summary: "一张票"
      })
    ).body.requirement;
    const { taskId } = (await post("/api/tasks", { goal: "派单", projectId: project.projectId })).body;
    await post(`/api/tasks/${taskId}/run`, { prompt: "开始" });
    const developments = `/api/tasks/${taskId}/developments`;
    const created = await post(
      developments,
      {
        action: "create",
        requirementId: requirement.requirementId,
        goal: "一个文件",
        completionCriteria: ["文件在"],
        route: "direct"
      },
      true
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const developmentId = created.body.development.developmentId;
    const dispatch = (body) =>
      post(`/api/tasks/${taskId}/subagents`, { action: "dispatch", role: "executor", ...body }, true);

    const drafted = await post(
      developments,
      { action: "write_tickets", op: "propose", developmentId, tickets: [ticket("01", "src/a.txt")] },
      true
    );
    const early = await dispatch({ task: "做票 01", developmentId, ticketId: "01" });
    assert.match(early.body.error, /还没有经用户确认/, "an unconfirmed ticket is not dispatched");
    const forged = await post(
      developments,
      { action: "write_tickets", op: "start", developmentId, ticketId: "01" },
      true
    );
    assert.equal(forged.status, 400, "Main cannot record the program's progress");
    await post(
      developments,
      {
        action: "write_tickets",
        op: "confirm",
        developmentId,
        expectedRevision: drafted.body.tickets.revision
      },
      true
    );

    const accepted = await dispatch({ task: "背景：分页从 1 开始。", developmentId, ticketId: "01" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.ticketId, "01");
    const detail = await fetch(`${dashboard.base}/api/tasks/${taskId}`).then((response) => response.json());
    const queue = await new DurableScheduler(
      join(dashboard.workspaceRoot, taskId, "runs", detail.task.activeRunId, "queue.json")
    ).list();
    const item = queue.find((entry) => entry.stepId === accepted.body.callId);
    assert.match(item.payload.task, /^Ticket 01: 写 src\/a\.txt[^]*背景：分页从 1 开始。$/);
    assert.equal(item.payload.ticketId, "01");
    const { tickets } = (await post(developments, { action: "tickets", developmentId }, true)).body;
    assert.equal(tickets.tickets[0].state, "in_progress");
    assert.equal(tickets.tickets[0].work.callId, accepted.body.callId);
    assert.equal(tickets.tickets[0].work.workspace, accepted.body.workspace);
    const again = await dispatch({ task: "再做一次", developmentId, ticketId: "01" });
    assert.match(again.body.error, /已经在执行或已完成，返修用 continueCallId/);
  }
);

test(
  "a ticket that used its rework rounds changes approach before another round",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p48-ticket-rounds-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = await repository(join(root, "repository"));
    const runtime = new ProjectDataRuntime({
      config: { sqlite: { path: join(root, "project-data.sqlite") } },
      configPath: join(root, "config.json"),
      dataRoot: root,
      env: {}
    });
    t.after(() => runtime.close());
    const gateway = await runtime.service();
    const projectId = "project_rounds";
    await gateway.ensureProject({
      projectId,
      projectName: "返修轮次",
      projectDirectory: repo,
      backendId: "backend_rounds"
    });
    const requirement = await gateway.createRequirement(projectId, { title: "文件", summary: "一张票" });
    const projectInfo = { projectId, projectName: "返修轮次", projectDirectory: repo };
    const calls = {};
    const developmentRoot = join(root, "development-workspaces");
    const service = createProjectDevelopmentService({
      runtime: { service: async () => gateway },
      backendId: "backend_rounds",
      developmentRoot,
      project: async (id) => (id === projectId ? projectInfo : undefined),
      taskProject: async (id) => (id === "task-rounds" ? projectInfo : undefined),
      call: async (_taskId, callId) => calls[callId]
    });
    await service.setMergeConfig(projectId, { repository: repo, targetBranch: "main" });
    const development = await service.create(projectId, {
      requirementId: requirement.requirementId,
      goal: "一个文件",
      completionCriteria: ["文件在"],
      route: "direct"
    });
    const developmentId = development.developmentId;
    const integration = development.workspace.directory;
    let set = await service.writeTickets(projectId, developmentId, {
      op: "propose",
      tickets: [ticket("01", "src/a.txt")]
    });
    set = await service.writeTickets(projectId, developmentId, {
      op: "confirm",
      expectedRevision: set.revision
    });

    const executor = async (callId, agentId) => {
      const directory = join(developmentRoot, "work-items", callId);
      await prepareWorkItemSite({
        developmentDirectory: integration,
        directory,
        branch: `coworkos/work/${callId}`
      });
      await service.ticketStarted("task-rounds", developmentId, "01", {
        callId,
        agentId,
        workspace: directory
      });
      calls[callId] = {
        callId,
        agentId,
        role: "executor",
        workspace: directory,
        developmentId,
        status: "completed"
      };
      return directory;
    };
    let reviewers = 0;
    const reviewer = async (review, conclusion) => {
      const callId = `call-r${++reviewers}`;
      const directory = join(developmentRoot, "work-items", callId);
      await git(integration, ["worktree", "add", "--detach", directory, review.candidate.commit]);
      calls[callId] = {
        callId,
        agentId: `agent-${callId}`,
        role: "reviewer",
        workspace: directory,
        developmentId,
        status: "completed",
        review: conclusion
      };
      return service.attachReviewer(projectId, "task-rounds", { reviewId: review.reviewId, callId });
    };
    const defect = {
      title: "内容不对",
      location: "src/a.txt",
      evidence: "cat src/a.txt",
      blocking: true,
      basis: "AC1"
    };
    // One failed round: freeze, the Reviewer's conclusion is imported, Main rules it to fix.
    const failedRound = async (previous) => {
      let review = await service.startReview(projectId, "task-rounds", {
        developmentId,
        ticketId: "01",
        ...(previous ? { previousReviewId: previous.reviewId } : {})
      });
      const findingId = previous?.findings.find((entry) => entry.state === "fix_claimed")?.findingId;
      review = await reviewer(
        review,
        previous
          ? {
              verdict: "changes_requested",
              findings: [],
              previousFindings: [{ findingId, fixed: false, evidence: "还是不对" }]
            }
          : { verdict: "changes_requested", findings: [defect] }
      );
      review = await service.ruleFinding(projectId, {
        reviewId: review.reviewId,
        findingId: review.findings[0].findingId,
        decision: "fix",
        basis: "照验收标准修"
      });
      return service.completeReview(projectId, {
        reviewId: review.reviewId,
        verdict: "failed",
        summary: "没过",
        checks: []
      });
    };

    const first = await executor("call-e1", "agent-e1");
    await commit(first, { "src/a.txt": "1\n" }, "one");
    const round1 = await failedRound();
    await commit(first, { "src/a.txt": "2\n" }, "two");
    const round2 = await failedRound(round1);
    assert.equal(
      round2.findings[0].findingId,
      round1.findings[0].findingId,
      "the unfixed finding keeps its id"
    );
    await commit(first, { "src/a.txt": "3\n" }, "three");
    await assert.rejects(
      service.startReview(projectId, "task-rounds", {
        developmentId,
        ticketId: "01",
        previousReviewId: round2.reviewId
      }),
      (error) => error.code === "review_round_limit"
    );
    assert.match(await service.next(projectId, developmentId), /Ticket 01 used its rework rounds/);
    await assert.rejects(
      service.changeApproach(projectId, { reviewId: round2.reviewId, approach: "new_plan", basis: "x" }),
      (error) => error.code === "review_approach_invalid"
    );
    await service.changeApproach(projectId, {
      reviewId: round2.reviewId,
      approach: "fresh_executor",
      basis: "第一个执行者两轮都没理解要求"
    });
    // The change must be carried out: the old Executor's checkout is refused.
    await assert.rejects(
      service.startReview(projectId, "task-rounds", {
        developmentId,
        ticketId: "01",
        previousReviewId: round2.reviewId
      }),
      (error) => error.code === "review_approach_not_applied"
    );
    const fresh = await executor("call-e2", "agent-e2");
    await commit(fresh, { "src/a.txt": "right\n" }, "fresh");
    const rereview = await service.startReview(projectId, "task-rounds", {
      developmentId,
      ticketId: "01",
      previousReviewId: round2.reviewId
    });
    assert.equal(rereview.author.agentId, "agent-e2");
    assert.deepEqual(rereview.changedPaths, ["src/a.txt"], "only what changed since the previous candidate");
    const frozen = await service.frozenCandidateForTask("task-rounds", developmentId, rereview.reviewId);
    assert.deepEqual(frozen.scope, {
      criteria: ["AC1"],
      previous: [{ findingId: round2.findings[0].findingId, title: "内容不对" }],
      changedPaths: ["src/a.txt"]
    });
    assert.match(frozen.brief, /This is a re-review after a fix/);
    await assert.rejects(
      service.changeApproach(projectId, {
        reviewId: round2.reviewId,
        approach: "fresh_executor",
        basis: "again"
      }),
      (error) => error.code === "review_not_latest"
    );
  }
);
