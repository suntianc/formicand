import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startDashboard } from "./dashboard-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectLedgerClient } from "../dist/src/runtime/project-ledger-client.js";

const assistant = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: "stop",
  timestamp: Date.now()
});

test("Main searches and reads the other sessions of its own project only", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const post = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const project = async (name) => {
    const directory = join(dashboard.root, `history-${name}`);
    await mkdir(directory, { recursive: true });
    return (await post("/api/projects", { projectName: name, projectDirectory: directory })).body.project;
  };
  const a = await project("A");
  const b = await project("B");
  for (const [taskId, projectId] of [
    ["task-current", a.projectId],
    ["task-earlier", a.projectId],
    ["task-other", b.projectId]
  ])
    assert.equal((await post("/api/tasks", { taskId, goal: `${taskId} 的目标`, projectId })).status, 201);
  const tasks = (await (await fetch(`${dashboard.base}/api/tasks`)).json()).tasks;
  const session = (taskId, user, reply) => {
    const { storageRoot } = tasks.find((task) => task.taskId === taskId);
    const manager = SessionManager.create(
      dashboard.root,
      join(storageRoot, taskId, "sessions", "main", "pi")
    );
    manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
    return { manager, reply: manager.appendMessage(assistant(reply)) };
  };
  session("task-current", "当前会话", "部署口令是 current-only");
  const earlier = session("task-earlier", "上次怎么部署的", "部署口令是 rotate-weekly，每周一换");
  session("task-other", "别的项目", "部署口令是 other-project");

  const token = (await readBackendInstance(backendPaths(join(dashboard.root, "home")))).value.token;
  const history = createProjectLedgerClient({
    dashboardUrl: dashboard.base,
    taskId: "task-current",
    token
  }).history;

  // Only the other sessions of this project are searched; this session and project B are not.
  const found = await history({ action: "search", query: "部署口令" });
  assert.deepEqual(
    found.matches.map((match) => [match.session, match.title, match.id, match.role]),
    [["task-earlier", "task-earlier 的目标", earlier.reply, "assistant"]]
  );
  assert.match(found.matches[0].snippet, /rotate-weekly/);
  assert.deepEqual(
    (await history({ action: "search", query: "部署", role: "user" })).matches.map((match) => match.role),
    ["user"]
  );

  const read = await history({ action: "read", session: "task-earlier", id: earlier.reply, start: 6 });
  assert.equal(read.content[1].text, "rotate-weekly，每周一换");

  // Another project's session cannot be read even by its exact id.
  await assert.rejects(
    history({ action: "read", session: "task-other", id: earlier.reply }),
    /这个项目里没有会话 task-other/
  );
  await assert.rejects(
    history({ action: "read", session: "task-earlier", id: "missing" }),
    /会话 task-earlier 里没有条目 missing/
  );
  await assert.rejects(
    history({ action: "read", session: "task-earlier", id: earlier.reply, start: 999 }),
    /Invalid history range/
  );
});
