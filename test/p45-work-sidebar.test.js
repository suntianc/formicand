import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { createProjectController } from "../web/assets/controllers/project-controller.js";

const project = (id, tasks = []) => ({
  projectId: id,
  projectName: `项目${id}`,
  projectDirectory: `/tmp/${id}`,
  tasks
});

function fixture(t, records = new Map()) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const $ = (selector) => document.querySelector(selector);
  const state = {
    projects: [],
    tasks: [],
    collapsedProjects: new Set(),
    collapsedSessions: new Set(),
    selectedProjectId: "a",
    selected: null,
    composingNew: false
  };
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, String(value)),
    removeItem: (key) => records.delete(key)
  };
  const controller = createProjectController({
    state,
    $,
    api: async () => ({}),
    storage,
    beginConversation() {},
    selectConversation() {},
    conversationTitle: (task) => task.title || task.goal,
    shortDate: () => "",
    taskMenuOpen: () => false,
    openTaskMenu() {},
    showToast() {},
    getNavigationIdentity: () => ""
  });
  t.after(() => {
    // An empty tree has no running Subagent, so its clock stops. Another
    // fixture's teardown may already have put the globals back.
    Object.assign(globalThis, { window, document, CSS: { escape: (value) => value } });
    controller.accept({ projects: [], tasks: [] });
    controller.render();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { state, $, controller, storage, records };
}

test("the work tree marks running sessions, nests Subagents with their time, marks questions and remembers a folded project", (t) => {
  const records = new Map();
  const first = fixture(t, records);
  const main = {
    taskId: "main-a",
    projectId: "a",
    goal: "评分汇总验收",
    status: "running",
    activity: {
      agents: [
        { agentId: "main", name: "Main", role: "main", state: "running" },
        {
          agentId: "subagent_1",
          name: "Ara",
          role: "subagent",
          workRole: "executor",
          state: "queued"
        },
        {
          agentId: "subagent_0",
          name: "Circinus",
          role: "subagent",
          workRole: "executor",
          state: "completed"
        },
        {
          agentId: "subagent_2",
          name: "Norma",
          role: "subagent",
          workRole: "reviewer",
          state: "running",
          startedAt: new Date(Date.now() - 65_000).toISOString()
        }
      ]
    }
  };
  const waiting = {
    taskId: "main-b",
    projectId: "a",
    goal: "修复登录超时",
    status: "waiting",
    pendingQuestion: true
  };
  first.controller.accept({ projects: [project("a", [main, waiting])], tasks: [main, waiting] });
  first.controller.render();

  assert.equal(first.$('[data-task="main-a"]').getAttribute("aria-description"), null);
  // A running session says so outside the title mask; a waiting one does not.
  assert.ok(first.$('[data-task="main-a"] > .conversation-activity[data-state="running"]'));
  assert.equal(first.$('[data-task="main-a"] .conversation-item-title .conversation-activity'), null);
  assert.equal(first.$('[data-task="main-b"] .conversation-activity'), null);
  assert.deepEqual(
    [...first.$("#project-list").querySelectorAll(".subagent-row .subagent-name")].map(
      (node) => node.textContent
    ),
    ["Ara", "Norma"]
  );
  const rows = [...first.$("#project-list").querySelectorAll(".subagent-row")];
  assert.match(rows[1].querySelector(".agent-avatar").getAttribute("style"), /ant-02-light\.webp/);
  // A queued Subagent has not started; a running one counts from when it was handed out.
  assert.equal(rows[0].querySelector(".subagent-time").textContent, "排队中");
  assert.match(rows[1].querySelector(".subagent-time").textContent, /^01:0[5-9]$/);
  assert.ok(first.$('[data-task="main-b"] .conversation-question'));
  assert.equal(first.$(".project-question"), null, "an expanded project marks the session itself");

  first.$('[data-session-toggle="main-a"]').click();
  assert.equal(first.$('[data-session-toggle="main-a"]').getAttribute("aria-expanded"), "false");
  assert.equal(first.$(".subagent-row"), null);

  first.$("[data-project-id]").click();
  assert.match(first.$('[data-project="a"]').getAttribute("class"), /collapsed/);
  assert.equal(first.$(".project-count").textContent, "2");
  assert.ok(first.$(".project-question"));
  assert.deepEqual(JSON.parse(records.get("formicand.collapsed-projects.v1")), ["a"]);

  const reloaded = fixture(t, records);
  reloaded.controller.accept({ projects: [project("a", [main, waiting])], tasks: [main, waiting] });
  reloaded.controller.render();
  assert.match(reloaded.$('[data-project="a"]').getAttribute("class"), /collapsed/);
  assert.equal(reloaded.$(".project-count").textContent, "2");
  assert.equal(reloaded.$('[data-project="a"] .conversation-list') !== null, true);
});

test("an empty catalog shows the project empty state next to the add entry", (t) => {
  const empty = fixture(t);
  empty.controller.accept({ projects: [], tasks: [] });
  empty.controller.render();
  assert.equal(empty.$("#project-list").querySelectorAll(".project-group").length, 0);
  assert.equal(empty.$(".sidebar-empty-state").textContent, "还没有项目");
  assert.equal(empty.controller.visibleProjects().length, 0);
  assert.ok(empty.$("#new-project"), "the section's plus remains the way to add the first project");

  const filled = fixture(t);
  filled.controller.accept({ projects: [project("a")], tasks: [] });
  filled.controller.render();
  assert.equal(filled.$(".sidebar-empty-state"), null);
  assert.equal(filled.controller.visibleProjects().length, 1);
});

test("the catalog reports a pending question only while Main can still be waiting", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const response = await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "catalog-question", goal: "等待回答" })
  });
  assert.equal(response.status, 201);
  const taskPath = join(dashboard.workspaceRoot, "catalog-question", "task.json");
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  await writeFile(
    taskPath,
    `${JSON.stringify({ ...task, status: "waiting", activeRunId: "run-question" }, null, 2)}\n`
  );
  const requests = join(dashboard.workspaceRoot, "catalog-question", "human", "requests");
  await mkdir(requests, { recursive: true });
  const requestPath = join(requests, "question-1.json");
  await writeFile(
    requestPath,
    `${JSON.stringify({
      requestId: "question-1",
      taskId: "catalog-question",
      runId: "run-question",
      question: "继续合入吗？",
      status: "pending",
      createdAt: new Date().toISOString()
    })}\n`
  );
  const catalog = await (await fetch(`${dashboard.base}/api/tasks`)).json();
  assert.equal(catalog.tasks.find((entry) => entry.taskId === "catalog-question").pendingQuestion, true);

  const settled = JSON.parse(await readFile(requestPath, "utf8"));
  await writeFile(requestPath, `${JSON.stringify({ ...settled, status: "answered", answer: "继续" })}\n`);
  const answered = await (await fetch(`${dashboard.base}/api/tasks`)).json();
  assert.equal(
    "pendingQuestion" in answered.tasks.find((entry) => entry.taskId === "catalog-question"),
    false
  );
});

test("projects show latest 5 unpinned conversations, paginate by 5, hide arrows and isolate pinned section", (t) => {
  const records = new Map();
  const f = fixture(t, records);
  const makeTask = (n, extra = {}) => ({
    taskId: `t-${n}`,
    projectId: "a",
    goal: `会话 ${n}`,
    status: "completed",
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    ...extra
  });
  const tasks = [
    ...Array.from({ length: 12 }, (_, index) => makeTask(index + 1)),
    makeTask(99, { pinned: true, goal: "置顶任务" })
  ];
  f.controller.accept({ projects: [project("a", tasks)], tasks });
  f.controller.render();

  // No chevron arrow inside project row; expanded shows folder-open, collapsed shows folder.
  assert.equal(f.$(".project-chevron"), null);
  assert.equal(f.$(".project-folder use").getAttribute("href"), "#i-folder-open");

  // Pinned conversation renders in its own section above projects and is not duplicated in the project.
  const pinnedSection = f.$("#pinned-section");
  assert.equal(pinnedSection.hidden, false);
  assert.deepEqual(
    [...pinnedSection.querySelectorAll(".conversation-item")].map((node) => node.dataset.task),
    ["t-99"]
  );
  assert.equal(f.$('[data-project="a"] [data-task="t-99"]'), null);

  // Collapsing pinned section persists and toggles class.
  pinnedSection.querySelector("[data-pinned-toggle]").click();
  assert.match(f.$("#pinned-section").getAttribute("class"), /collapsed/);
  assert.equal(records.get("formicand.collapsed-pinned.v1"), "1");

  // Project defaults to latest 5 unpinned conversations (t-12 down to t-8).
  const visibleIds = () =>
    [...f.$('[data-project="a"]').querySelectorAll(".conversation-item")].map((node) => node.dataset.task);
  assert.deepEqual(visibleIds(), ["t-12", "t-11", "t-10", "t-9", "t-8"]);
  assert.equal(f.$('[data-project-more="a"]').textContent, "展开剩余");

  // Clicking 展开剩余 reveals 5 more, then the remaining 2 and hides the button.
  f.$('[data-project-more="a"]').click();
  assert.deepEqual(visibleIds(), ["t-12", "t-11", "t-10", "t-9", "t-8", "t-7", "t-6", "t-5", "t-4", "t-3"]);
  assert.ok(f.$('[data-project-more="a"]'));

  f.$('[data-project-more="a"]').click();
  assert.equal(visibleIds().length, 12);
  assert.equal(f.$('[data-project-more="a"]'), null);
});
