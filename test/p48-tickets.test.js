import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { applyTicketWrite, developmentNext } from "../dist/src/domain/development-ticket.js";
import { createProjectDevelopmentTool } from "../dist/src/runtime/project-development-tool.js";
import { applyTicketAnswer } from "../dist/src/dashboard/ticket-answer.js";
import { renderHumanQuestion } from "../web/assets/human-questions.js";

/**
 * Tickets: the slices a requirement is split into, confirmed by the user on a
 * card and frozen afterwards. The rules run in the domain; the writes go
 * through the real Dashboard, its database and, for a second backend, the
 * authority it reads through.
 */

const run = promisify(execFile);
const git = (cwd, args) => run("git", ["-C", cwd, ...args]).then((result) => result.stdout.trim());

const ticket = (ticketId, extra = {}) => ({
  ticketId,
  title: `票 ${ticketId}`,
  scope: ["src/cli.js"],
  criteria: [{ text: "list 输出第二页", command: "node --test test/page.test.js" }],
  ...extra
});
const emptySet = { projectId: "p", developmentId: "d", revision: 0, tickets: [] };
const at = "2026-11-20T00:00:00.000Z";

test("the ticket rules hold for every route, dependency and revision", () => {
  assert.throws(
    () => applyTicketWrite(emptySet, { op: "propose", tickets: [ticket("01")] }, "quick", at),
    /quick 路线不建票/
  );
  assert.equal(
    applyTicketWrite(emptySet, { op: "propose", tickets: [ticket("01", { scope: [] })] }, "full", at).tickets
      .length,
    1,
    "a ticket may leave its scope out; the Reviewer judges what it changed"
  );
  assert.throws(
    () =>
      applyTicketWrite(
        emptySet,
        { op: "propose", tickets: [ticket("01", { criteria: [{ text: "好用" }] })] },
        "full",
        at
      ),
    /须写明检查方式/
  );
  assert.throws(
    () =>
      applyTicketWrite(
        emptySet,
        { op: "propose", tickets: [ticket("01", { dependsOn: ["09"] })] },
        "full",
        at
      ),
    /依赖的票 09 不存在/
  );
  assert.throws(
    () =>
      applyTicketWrite(
        emptySet,
        {
          op: "propose",
          tickets: [ticket("01", { dependsOn: ["02"] }), ticket("02", { dependsOn: ["01"] })]
        },
        "full",
        at
      ),
    /依赖成环/
  );
  assert.throws(
    () =>
      applyTicketWrite(emptySet, { op: "propose", tickets: [ticket("01", { scope: ["../x"] })] }, "full", at),
    /相对路径/
  );

  const drafted = applyTicketWrite(
    emptySet,
    {
      op: "propose",
      tickets: [
        ticket("01"),
        ticket("02", {
          dependsOn: ["01"],
          criteria: [{ text: "帮助文字读起来清楚", manual: "措辞只能由人判断" }]
        })
      ]
    },
    "full",
    at
  );
  assert.equal(drafted.revision, 1);
  assert.deepEqual(
    drafted.tickets.map((entry) => [entry.ticketId, entry.state]),
    [
      ["01", "draft"],
      ["02", "draft"]
    ]
  );
  assert.deepEqual(drafted.tickets[1].criteria[0], {
    criterionId: "AC1",
    text: "帮助文字读起来清楚",
    check: { manual: "措辞只能由人判断" }
  });

  // A confirmation freezes exactly the drafts the card showed.
  assert.throws(
    () => applyTicketWrite(drafted, { op: "confirm", expectedRevision: 9 }, "full", at),
    /票已更新/
  );
  const confirmed = applyTicketWrite(drafted, { op: "confirm", expectedRevision: 1 }, "full", at);
  assert.ok(confirmed.tickets.every((entry) => entry.state === "confirmed" && entry.confirmedAt === at));

  // A later proposal adds drafts and leaves confirmed tickets alone.
  assert.throws(
    () => applyTicketWrite(confirmed, { op: "propose", tickets: [ticket("01")] }, "full", at),
    /已经确认；修改已确认的票用 revise_ticket/
  );
  const more = applyTicketWrite(
    confirmed,
    { op: "propose", tickets: [ticket("03", { dependsOn: ["02"] })] },
    "full",
    at
  );
  assert.deepEqual(
    more.tickets.map((entry) => entry.state),
    ["confirmed", "confirmed", "draft"]
  );

  // A frozen ticket changes only with the user's decision and Main's reason, and keeps what it replaced.
  const revise = {
    op: "revise",
    ticketId: "01",
    changes: {
      criteria: [{ text: "list 输出第二页，每页 10 条", command: "node --test test/page.test.js" }]
    },
    reason: "用户补充了每页条数",
    expectedRevision: confirmed.revision
  };
  assert.throws(() => applyTicketWrite(confirmed, revise, "full", at), /用户的决定/);
  const revised = applyTicketWrite(confirmed, { ...revise, decision: "确认修改" }, "full", at);
  const changed = revised.tickets[0];
  assert.equal(changed.revision, 2);
  assert.equal(changed.state, "confirmed");
  assert.deepEqual(changed.changes[0].previous, { criteria: confirmed.tickets[0].criteria });
  assert.equal(changed.changes[0].decision, "确认修改");
  assert.equal(changed.changes[0].reason, "用户补充了每页条数");
  assert.throws(
    () =>
      applyTicketWrite(
        confirmed,
        { ...revise, changes: { title: "票 01" }, decision: "确认修改" },
        "full",
        at
      ),
    /与当前票相同/
  );
  const merged = { ...confirmed, tickets: confirmed.tickets.map((entry) => ({ ...entry, state: "merged" })) };
  assert.throws(
    () => applyTicketWrite(merged, { ...revise, decision: "确认修改" }, "full", at),
    /开一张新的修复票/
  );
});

test("the next step follows the records", () => {
  const base = { route: "full", workspaceReady: true, tickets: [] };
  assert.match(developmentNext({ ...base, workspaceReady: false }), /ensure_workspace/);
  assert.match(developmentNext(base), /Propose the tickets with propose_tickets/);
  assert.match(developmentNext({ ...base, tickets: [{ ticketId: "01", state: "draft" }] }), /01 are drafts/);
  const at = (state, extra = {}) => ({ ticketId: "01", state, dependsOn: [], reviewIds: [], ...extra });
  const confirmed = { ...base, tickets: [at("confirmed")] };
  assert.match(
    developmentNext(confirmed),
    /Tickets 01 can start: start_ticket opens a ticket's checkout for you to write it/
  );
  assert.match(
    developmentNext({ ...base, tickets: [at("in_progress", { work: { workspace: "/w/main-01" } })] }),
    /^Ticket 01 is yours: write it in \/w\/main-01, commit, then freeze_candidate with ticketId/
  );
  assert.match(
    developmentNext({
      route: "full",
      workspaceReady: true,
      tickets: [at("in_progress"), at("confirmed", { ticketId: "02", dependsOn: ["01"] })]
    }),
    /^Tickets 01 are being implemented: when the Executor finishes, freeze_candidate with ticketId/
  );
  assert.match(
    developmentNext({
      route: "full",
      workspaceReady: true,
      tickets: [at("merged"), at("confirmed", { ticketId: "02", dependsOn: ["01"] })]
    }),
    /Tickets 02 can start/
  );
  assert.match(
    developmentNext({
      ...base,
      tickets: [at("in_review", { reviewIds: ["r1"] })],
      review: { reviewId: "r1", state: "in_review", reviewer: false }
    }),
    /Ticket 01: Review r1 is frozen: delegate the Reviewer with role=reviewer/
  );
  assert.match(developmentNext({ ...base, tickets: [at("passed")] }), /01 passed review: integrate_ticket/);
  assert.match(developmentNext({ ...base, tickets: [at("rework")] }), /01 need rework: .*continueCallId/);
  assert.match(
    developmentNext({
      ...base,
      tickets: [at("merged")],
      qualification: { eligible: false, reasons: ["candidate_changed"] }
    }),
    /Every ticket is in the requirement checkout\. To build on the target branch's new commits, sync_target merges them in first/
  );
  assert.match(
    developmentNext({
      ...base,
      tickets: [at("merged")],
      finalReview: { reviewId: "rf", state: "passed", reviewer: true },
      qualification: { eligible: false, reasons: ["candidate_changed"] }
    }),
    /moved after final review rf passed: freeze_candidate again with previousReviewId/
  );
  assert.match(
    developmentNext({ ...confirmed, qualification: { eligible: true, reasons: [] } }),
    /qualifies: request_merge/
  );
  assert.match(
    developmentNext({ ...confirmed, merge: { mergeId: "m1", state: "conflict", detail: "src/cli.js" } }),
    /Merge m1 ended conflict: src\/cli.js/
  );
  assert.match(
    developmentNext({ ...confirmed, merge: { mergeId: "m1", state: "applying" } }),
    /do not request it again/
  );
  assert.match(
    developmentNext({
      ...base,
      merge: { mergeId: "m1", state: "merged", mergeCommit: "abc1234" },
      delivery: { state: "synced" }
    }),
    /Merged as abc1234 and delivered/
  );
  assert.match(
    developmentNext({
      route: "quick",
      workspaceReady: true,
      tickets: [],
      qualification: { eligible: false, reasons: ["review_plan_missing"] }
    }),
    /channel=self/
  );
});

async function servingToken(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(join(root, "home")));
    if (instance.value?.token) return instance.value.token;
    await delay(25);
  }
  assert.fail("the backend did not publish its local credential");
}

async function repository(root) {
  const directory = join(root, "repository");
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  // The document registry every requirement merge checks.
  await writeFile(
    join(directory, "AGENTS.md"),
    "## 文档\n\n| 路径 | 类型 | 领域 |\n| --- | --- | --- |\n| AGENTS.md | instructions | global |\n"
  );
  await writeFile(join(directory, "README.md"), "# fixture\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

/** A project on a real repository with one requirement and a Task bound to it. */
async function project(dashboard, directory, name) {
  const post = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = await response.json();
    assert.ok(response.ok, `${path} ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const { project: created } = await post("/api/projects", {
    projectName: name,
    projectDirectory: directory
  });
  const { requirement } = await post(`/api/projects/${encodeURIComponent(created.projectId)}/ledger`, {
    action: "create",
    title: "分页修复",
    summary: "list 命令的分页从第二页开始错位。"
  });
  const { taskId } = await post("/api/tasks", { goal: name, projectId: created.projectId });
  return { projectId: created.projectId, requirementId: requirement.requirementId, taskId, post };
}

test(
  "tickets are proposed, confirmed on a card and revised through the real Dashboard",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "formicand-p48-tickets-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = await repository(root);
    const dashboard = await startDashboard({ defaultProject: false });
    t.after(() => dashboard.stop());
    const { projectId, requirementId, taskId } = await project(dashboard, directory, "票项目");
    const tool = createProjectDevelopmentTool({
      dashboardUrl: dashboard.base,
      taskId,
      token: await servingToken(dashboard.root)
    });
    const created = await tool.execute({
      action: "create",
      request: "这个功能",
      requirementId,
      goal: "list 分页正确",
      completionCriteria: ["第二页从第 11 条开始"],
      route: "full"
    });
    const developmentId = created.development.developmentId;
    assert.match(
      created.next,
      /Propose the tickets with propose_tickets/,
      "every result says what comes next"
    );

    const shown = [];
    const answer = (reply) => async (proposal) => {
      shown.push(proposal);
      return reply;
    };
    // The user answers with a change instead of confirming: nothing is frozen.
    const declined = await tool.execute(
      { action: "propose_tickets", developmentId, tickets: [ticket("01")] },
      answer({ confirmed: false, status: "answered", answer: "验收要写清每页 10 条" })
    );
    assert.equal(declined.confirmed, false);
    assert.equal(declined.tickets.tickets[0].state, "draft");
    assert.match(declined.instruction, /apply them and call again/);
    assert.match(declined.next, /01 are drafts/);
    assert.equal(shown[0].kind, "tickets");
    assert.equal(shown[0].requirementTitle, "分页修复");
    assert.equal(shown[0].tickets[0].criteria[0].check.command, "node --test test/page.test.js");

    const confirmed = await tool.execute(
      {
        action: "propose_tickets",
        developmentId,
        tickets: [
          ticket("01", { criteria: [{ text: "第二页从第 11 条开始，每页 10 条", command: "node --test" }] })
        ]
      },
      answer({ confirmed: true, status: "answered", answer: "确认这些票" })
    );
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.tickets.tickets[0].state, "confirmed");
    assert.match(confirmed.next, /Tickets 01 can start/);

    // No one to ask, no change; a timeout changes nothing either.
    const revise = {
      action: "revise_ticket",
      developmentId,
      ticketId: "01",
      changes: { outOfScope: ["不改 add 命令"] },
      reason: "用户说 add 命令另开需求"
    };
    await assert.rejects(tool.execute(revise), /only after the user confirms/);
    const timedOut = await tool.execute(revise, answer({ confirmed: false, status: "unanswered" }));
    assert.match(timedOut.instruction, /did not answer/);
    assert.equal(shown.at(-1).previous.outOfScope.length, 0, "the card shows the ticket as it is now");
    assert.deepEqual(shown.at(-1).tickets[0].outOfScope, ["不改 add 命令"]);

    const revised = await tool.execute(
      revise,
      answer({ confirmed: true, status: "answered", answer: "确认修改" })
    );
    const stored = revised.tickets.tickets[0];
    assert.equal(stored.revision, 2);
    assert.deepEqual(stored.changes[0].previous, { outOfScope: [] });
    assert.equal(stored.changes[0].decision, "确认修改");

    // The route cannot change under the tickets it would no longer allow.
    const record = await tool.execute({ action: "get", developmentId });
    await assert.rejects(
      tool.execute({
        action: "update",
        developmentId,
        expectedRevision: record.development.revision,
        route: "quick"
      }),
      /quick 路线不建票/
    );

    // The set is stored, not held by this process.
    await dashboard.restart();
    const restartedTool = createProjectDevelopmentTool({
      dashboardUrl: dashboard.base,
      taskId,
      token: await servingToken(dashboard.root)
    });
    const read = await restartedTool.execute({ action: "tickets", developmentId });
    assert.equal(read.tickets.revision, revised.tickets.revision);
    assert.deepEqual(read.tickets.tickets[0].outOfScope, ["不改 add 命令"]);
    assert.equal(read.tickets.projectId, projectId);
  }
);

test("a second backend writes tickets through the authority it reads", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-p48-tickets-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority = await startDashboard({ defaultProject: false });
  t.after(() => authority.stop());
  const secondary = await startDashboard({
    defaultProject: false,
    config: { projectData: { authority: { url: authority.base, token: await servingToken(authority.root) } } }
  });
  t.after(() => secondary.stop());
  const directory = await repository(root);
  const { projectId, requirementId, taskId } = await project(secondary, directory, "远程票项目");
  const tool = createProjectDevelopmentTool({
    dashboardUrl: secondary.base,
    taskId,
    token: await servingToken(secondary.root)
  });
  const { development } = await tool.execute({
    action: "create",
    request: "这个功能",
    requirementId,
    goal: "list 分页正确",
    completionCriteria: ["第二页从第 11 条开始"],
    route: "full"
  });
  const result = await tool.execute(
    {
      action: "propose_tickets",
      developmentId: development.developmentId,
      tickets: [ticket("01"), ticket("02", { dependsOn: ["01"] })]
    },
    async () => ({ confirmed: true, status: "answered", answer: "确认这些票" })
  );
  assert.equal(result.confirmed, true);
  const response = await fetch(
    `${authority.base}/api/projects/${encodeURIComponent(projectId)}/developments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "tickets", developmentId: development.developmentId })
    }
  );
  const { tickets } = await response.json();
  assert.deepEqual(
    tickets.tickets.map((entry) => [entry.ticketId, entry.state, entry.dependsOn]),
    [
      ["01", "confirmed", []],
      ["02", "confirmed", ["01"]]
    ],
    "the authority holds the set the second backend confirmed"
  );
});

for (const late of [false, true])
  test(
    `Main freezes the tickets with one ${late ? "late" : "timely"} card answer`,
    { timeout: 120_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "formicand-p48-tickets-main-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const directory = await repository(root);
      let developmentId = "";
      let requirementId = "";
      const results = [];
      const provider = await modelProtocolFixture("openai-completions", (body) => {
        const tool = body.messages.findLast((message) => message.role === "tool");
        const text =
          typeof tool?.content === "string"
            ? tool.content
            : (tool?.content ?? []).map((part) => part.text).join("");
        if (text) results.push(JSON.parse(text));
        const step = results.length;
        if (step === 0)
          return {
            name: "project_development",
            arguments: {
              action: "create",
              requirementId,
              request: "列表分页",
              goal: "list 分页正确",
              completionCriteria: ["第二页从第 11 条开始"],
              route: "full"
            }
          };
        if (step === 1 || (late && step === 2)) {
          developmentId = results[0].development.developmentId;
          return {
            name: "project_development",
            arguments: { action: "propose_tickets", developmentId, tickets: [ticket("01")] }
          };
        }
        return { text: "票已确认。" };
      });
      t.after(() => provider.close());
      const dashboard = await startDashboard({
        defaultProject: false,
        modelEndpoint: provider.baseUrl,
        model: "protocol-fixture",
        env: {
          FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
          FORMICAND_DISABLE_SESSION_TITLES: "1",
          ...(late ? { FORMICAND_HUMAN_ANSWER_TIMEOUT_MS: "150" } : {})
        }
      });
      t.after(() => dashboard.stop());
      const setup = await project(dashboard, directory, "Main 票项目");
      requirementId = setup.requirementId;
      await setup.post(`/api/tasks/${setup.taskId}/run`, { prompt: "修分页" });

      let question;
      for (let attempt = 0; attempt < 600 && !question; attempt++) {
        const detail = await (await fetch(`${dashboard.base}/api/tasks/${setup.taskId}`)).json();
        question = detail.humanRequests?.find((entry) => entry.status === (late ? "unanswered" : "pending"));
        if (!question) await delay(100);
      }
      assert.ok(question, "the proposal reaches the page as a question");
      assert.equal(question.proposal.kind, "tickets");
      assert.deepEqual(question.options, ["确认这些票", "拒绝"]);
      assert.deepEqual(question.recommended, [1], "silence freezes nothing");
      const card = renderHumanQuestion(question);
      assert.match(card, /ticket-proposal/);
      assert.match(card, /node --test test\/page\.test\.js/);
      assert.match(card, /src\/cli\.js/);

      if (late) {
        for (let attempt = 0; attempt < 300 && results.length < 3; attempt++) await delay(100);
        assert.equal(results[1].status, "timeout");
        assert.equal(results[2].confirmed, false, "retry before the answer reused the expired card");
      }
      await setup.post(`/api/tasks/${setup.taskId}/human/${question.requestId}/answer`, {
        answer: "确认这些票"
      });
      if (late) {
        const ledger = await setup.post(`/api/tasks/${setup.taskId}/developments`, {
          action: "tickets",
          developmentId
        });
        assert.equal(ledger.tickets.tickets[0].state, "confirmed");
        const detail = await (await fetch(`${dashboard.base}/api/tasks/${setup.taskId}`)).json();
        assert.equal(detail.humanRequests.filter((r) => r.proposal?.kind === "tickets").length, 1);
        const client = createProjectDevelopmentTool({
          dashboardUrl: dashboard.base,
          taskId: setup.taskId,
          token: await servingToken(dashboard.root)
        });
        const questions = new HumanRequestStore(dashboard.workspaceRoot);
        async function revisionCard(title, legacy = false) {
          let card;
          const change = {
            action: "revise_ticket",
            developmentId,
            ticketId: "01",
            changes: { title },
            reason: "调整票标题"
          };
          await client.execute(change, async (proposal) => {
            const { expectedRevision, changes, ...older } = proposal;
            card = await questions.create({
              taskId: setup.taskId,
              runId: question.runId,
              question: "修改已确认的票",
              options: ["确认修改", "拒绝"],
              proposal: legacy ? older : proposal
            });
            await questions.markUnanswered(setup.taskId, card.requestId);
            return { confirmed: false, status: "timeout" };
          });
          return card;
        }
        const stale = await revisionCard("另一项修改");
        const legacy = await revisionCard("新标题", true);
        const cli = await run(
          process.execPath,
          [
            "scripts/formicand.mjs",
            "human",
            "reply",
            legacy.requestId,
            "确认修改",
            "--task",
            setup.taskId,
            "--workspace",
            dashboard.workspaceRoot
          ],
          { env: { ...process.env, FORMICAND_HOME: join(dashboard.root, "home") } }
        );
        assert.equal(JSON.parse(cli.stdout).delivered, true);
        await setup.post(`/api/tasks/${setup.taskId}/human/${legacy.requestId}/answer`, {
          answer: "确认修改"
        });
        const after = await setup.post(`/api/tasks/${setup.taskId}/developments`, {
          action: "tickets",
          developmentId
        });
        assert.equal(after.tickets.tickets[0].title, "新标题");
        assert.equal(after.tickets.tickets[0].changes.length, 1);
        const refused = await fetch(
          `${dashboard.base}/api/tasks/${setup.taskId}/human/${stale.requestId}/answer`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answer: "确认修改" })
          }
        );
        assert.equal(refused.status, 409);
        assert.equal((await questions.read(setup.taskId, stale.requestId)).status, "unanswered");
        return;
      }
      for (let attempt = 0; attempt < 600 && results.length < 2; attempt++) await delay(100);
      assert.equal(results[1].confirmed, true, JSON.stringify(results[1]));
      assert.equal(results[1].tickets.tickets[0].state, "confirmed");
      assert.match(results[1].next, /Tickets 01 can start/);
    }
  );

test("retrying the same proposal preserves the card revision and reuses the approved decision", () => {
  const proposal = { op: "propose", tickets: [ticket("01")] };
  const draft = applyTicketWrite(emptySet, proposal, "full", at);
  const later = "2026-11-20T00:01:30.000Z";
  assert.deepEqual(applyTicketWrite(draft, proposal, "full", later), draft);
  const decision = { op: "confirm", expectedRevision: draft.revision, decisionId: "human-original" };
  const confirmed = applyTicketWrite(draft, decision, "full", later);
  assert.deepEqual(applyTicketWrite(confirmed, decision, "full", later), confirmed);
  assert.deepEqual(applyTicketWrite(confirmed, proposal, "full", later), confirmed);
  const changed = applyTicketWrite(
    draft,
    { ...proposal, tickets: [ticket("01", { title: "changed" })] },
    "full",
    later
  );
  assert.throws(() => applyTicketWrite(changed, decision, "full", later), /票已更新/);
});

test("a late confirmation still applies after another ticket moved on, and only while its tickets are as shown", async () => {
  const confirmOne = (set, id) =>
    applyTicketWrite(set, { op: "confirm", expectedRevision: set.revision, decisionId: id }, "full", at);
  let set = confirmOne(
    applyTicketWrite(emptySet, { op: "propose", tickets: [ticket("01")] }, "full", at),
    "h-01"
  );
  set = applyTicketWrite(set, { op: "propose", tickets: [ticket("02", { dependsOn: ["01"] })] }, "full", at);
  // The card is stored as a file, so its tickets come back from JSON.
  const card = {
    kind: "tickets",
    action: "propose",
    developmentId: "d",
    requirementTitle: "分页",
    expectedRevision: set.revision,
    tickets: JSON.parse(JSON.stringify(set.tickets.filter((entry) => entry.state === "draft")))
  };
  const request = { taskId: "t", requestId: "h-02", options: ["确认这些票", "拒绝"], proposal: card };
  const service = (current) => ({
    set: current,
    async ticketsForTask() {
      return this.set;
    },
    async writeTicketsForTask(_taskId, _developmentId, write) {
      this.set = applyTicketWrite(this.set, write, "full", at);
      return this.set;
    }
  });

  // Ticket 01 moves on while the card for 02 waits, as an integration would.
  const moved = applyTicketWrite(
    set,
    {
      op: "revise",
      ticketId: "01",
      expectedRevision: set.revision,
      changes: { title: "票 01 改名" },
      reason: "并入时更名",
      decision: "确认修改",
      decisionId: "h-01-rename"
    },
    "full",
    at
  );
  const late = service(moved);
  await applyTicketAnswer(late, request, "确认这些票");
  assert.equal(late.set.tickets.find((entry) => entry.ticketId === "02").state, "confirmed");

  // Drafts that changed after the card was shown are not what the user approved.
  const redrafted = service(
    applyTicketWrite(
      moved,
      { op: "propose", tickets: [ticket("02", { title: "改过的 02", dependsOn: ["01"] })] },
      "full",
      at
    )
  );
  await assert.rejects(applyTicketAnswer(redrafted, request, "确认这些票"), /票已更新/);
  assert.equal(redrafted.set.tickets.find((entry) => entry.ticketId === "02").state, "draft");
});

test(
  "a new ticket card for the same development withdraws the earlier one",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "formicand-p48-tickets-replaced-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = await repository(root);
    let developmentId = "";
    let requirementId = "";
    const results = [];
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      const tool = body.messages.findLast((message) => message.role === "tool");
      const text =
        typeof tool?.content === "string"
          ? tool.content
          : (tool?.content ?? []).map((part) => part.text).join("");
      if (text) results.push(JSON.parse(text));
      const step = results.length;
      if (step === 0)
        return {
          name: "project_development",
          arguments: {
            action: "create",
            requirementId,
            request: "列表分页",
            goal: "list 分页正确",
            completionCriteria: ["第二页从第 11 条开始"],
            route: "full"
          }
        };
      if (step === 1 || step === 2) {
        developmentId = results[0].development.developmentId;
        // The second proposal differs, so it is a new card rather than the same one reopened.
        return {
          name: "project_development",
          arguments: {
            action: "propose_tickets",
            developmentId,
            tickets: [ticket("01", step === 2 ? { title: "票 01 第二版" } : {})]
          }
        };
      }
      return { text: "等用户确认。" };
    });
    t.after(() => provider.close());
    const dashboard = await startDashboard({
      defaultProject: false,
      modelEndpoint: provider.baseUrl,
      model: "protocol-fixture",
      env: {
        FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
        FORMICAND_DISABLE_SESSION_TITLES: "1",
        FORMICAND_HUMAN_ANSWER_TIMEOUT_MS: "150"
      }
    });
    t.after(() => dashboard.stop());
    const setup = await project(dashboard, directory, "Main 票项目");
    requirementId = setup.requirementId;
    await setup.post(`/api/tasks/${setup.taskId}/run`, { prompt: "修分页" });
    for (let attempt = 0; attempt < 600 && results.length < 3; attempt++) await delay(100);
    assert.deepEqual(
      results.slice(1, 3).map((result) => result.status),
      ["timeout", "timeout"]
    );
    const cards = (await new HumanRequestStore(dashboard.workspaceRoot).list(setup.taskId))
      .filter((request) => request.proposal?.kind === "tickets")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    assert.deepEqual(
      cards.map((card) => [card.proposal.tickets[0].title, card.status]),
      [
        ["票 01", "cancelled"],
        ["票 01 第二版", "unanswered"]
      ]
    );
  }
);
