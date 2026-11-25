import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import {
  deleteMemory,
  listMemories,
  MEMORY_LIMITS,
  memoryIndex,
  readMemory,
  writeMemory
} from "../dist/src/runtime/memory-store.js";
import { createMemoryTool } from "../dist/src/runtime/memory-tool.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";

const sample = (name, extra = {}) => ({
  name,
  type: "feedback",
  description: `${name} 的一句话`,
  body: `${name} 的正文。\n\n**Why:** 用户说过。`,
  ...extra
});

test("memories are one file each, listed newest first, renamed without loss and refused past the limits", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memory-store-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const user = { scope: "user" };
  await writeMemory(home, user, sample("reply-in-chinese"), { now: new Date("2026-11-01T00:00:00Z") });
  await writeMemory(home, user, sample("ask-before-merge"), { now: new Date("2026-11-02T00:00:00Z") });
  assert.deepEqual(
    (await listMemories(home, user)).map((entry) => entry.name),
    ["ask-before-merge", "reply-in-chinese"]
  );
  const file = await readFile(join(home, "memory", "user", "reply-in-chinese.md"), "utf8");
  assert.match(file, /^---\nname: "reply-in-chinese"\n/);
  const read = await readMemory(home, user, "reply-in-chinese");
  assert.equal(read.body, "reply-in-chinese 的正文。\n\n**Why:** 用户说过。");
  assert.equal(read.type, "feedback");

  // A rename writes the new file before removing the old one.
  await writeMemory(home, user, sample("plain-chinese"), { previousName: "reply-in-chinese" });
  assert.equal(await readMemory(home, user, "reply-in-chinese"), undefined);
  assert.ok(await readMemory(home, user, "plain-chinese"));
  await assert.rejects(
    writeMemory(home, user, sample("plain-chinese"), { previousName: "ask-before-merge" }),
    /已有名为 plain-chinese/
  );

  // Projects are kept apart, and a name or project id cannot reach another directory.
  const project = { scope: "project", projectId: "project-a" };
  await writeMemory(home, project, sample("ticket-split", { type: "project" }));
  assert.equal((await listMemories(home, { scope: "project", projectId: "project-b" })).length, 0);
  await assert.rejects(writeMemory(home, user, sample("../escape")), /只能用小写字母/);
  await assert.rejects(listMemories(home, { scope: "project", projectId: "../user" }), /项目 ID 不合法/);
  await assert.rejects(writeMemory(home, user, sample("x", { type: "note" })), /记忆类型只能是/);
  await assert.rejects(writeMemory(home, user, sample("x", { description: " " })), /一句话说明不能为空/);
  await assert.rejects(
    writeMemory(home, user, sample("x", { body: "字".repeat(MEMORY_LIMITS.body + 1) })),
    /正文不能为空，最多/
  );

  // A file that is not a memory is skipped, not shown half-read.
  await writeFile(join(home, "memory", "user", "notes.md"), "no frontmatter");
  assert.deepEqual(
    (await listMemories(home, user)).map((entry) => entry.name),
    ["plain-chinese", "ask-before-merge"]
  );

  // The same fact under a second name is refused; rewriting the memory that holds it is not.
  await assert.rejects(
    writeMemory(
      home,
      user,
      sample("plain-chinese-again", { body: (await readMemory(home, user, "plain-chinese")).body })
    ),
    (error) => error.code === "memory_duplicate" && /记忆 plain-chinese 的正文与此相同/.test(error.message)
  );
  await writeMemory(home, user, sample("plain-chinese", { description: "改过说明" }));

  assert.equal(await deleteMemory(home, user, "ask-before-merge"), true);
  assert.equal(await deleteMemory(home, user, "ask-before-merge"), false);

  const full = { scope: "project", projectId: "full" };
  for (let index = 0; index < MEMORY_LIMITS.entries; index++)
    await writeMemory(home, full, sample(`m-${index}`));
  await assert.rejects(
    writeMemory(home, full, sample("one-more")),
    /这一级已满（80\/80 条），先合并或删除旧的/
  );
  // Replacing an existing one still works at the limit.
  await writeMemory(home, full, sample("m-0", { description: "改过" }));
});

test("the index lists both scopes within its budget and says how many it left out", () => {
  const entry = (name, updatedAt) => ({ name, type: "user", description: "说明".repeat(70), updatedAt });
  assert.equal(memoryIndex([{ label: "User", entries: [] }]), "");
  const many = Array.from({ length: 200 }, (_, index) =>
    entry(`m-${index}`, `2026-11-${String(20 - (index % 20)).padStart(2, "0")}T00:00:00Z`)
  );
  const index = memoryIndex([
    { label: "User (all projects)", entries: many.slice(0, 100) },
    { label: "Project A", entries: many.slice(100) }
  ]);
  assert.ok(index.length <= MEMORY_LIMITS.index, `${index.length} characters`);
  assert.match(index, /^Memories you saved in earlier sessions/);
  assert.match(index, /\nUser \(all projects\) \[100\/80\]:\n- m-0 \[user, 2026-11-20\] /);
  assert.match(index, /\d+ older memories are not shown; list a scope to see them\.$/);
});

async function memoryFixture(t, options = {}) {
  const dashboard = await startDashboard({ defaultProject: false, ...options });
  t.after(() => dashboard.stop());
  const request = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  const project = async (name) => {
    const directory = join(dashboard.root, `memory-${name}`);
    await mkdir(directory, { recursive: true });
    const response = await request("/api/projects", { projectName: name, projectDirectory: directory });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.project;
  };
  const home = join(dashboard.root, "home");
  const instance = await readBackendInstance(backendPaths(home));
  return { ...dashboard, request, project, home, token: instance.value.token };
}

test("settings and Main read one store; Main reaches only its own project and only while it is on", async (t) => {
  const f = await memoryFixture(t);
  const a = await f.project("项目 A");
  const b = await f.project("项目 B");
  for (const [taskId, projectId] of [
    ["task-a", a.projectId],
    ["task-b", b.projectId]
  ])
    assert.equal((await f.request("/api/tasks", { taskId, goal: taskId, projectId })).status, 201);

  // Settings writes a user memory and a project memory.
  const saved = await f.request("/api/memory/save", {
    target: { scope: "user" },
    memory: sample("reply-in-chinese", { type: "user" })
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(
    (
      await f.request("/api/memory/save", {
        target: { scope: "project", projectId: a.projectId },
        memory: sample("ticket-split", { type: "project" })
      })
    ).status,
    200
  );
  const bad = await f.request("/api/memory/save", {
    target: { scope: "user" },
    memory: sample("Bad Name")
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "memory_name_invalid");

  // Main's tool works through the production bridge with the run credential.
  const toolA = createMemoryTool({ dashboardUrl: f.base, taskId: "task-a", token: f.token });
  const toolB = createMemoryTool({ dashboardUrl: f.base, taskId: "task-b", token: f.token });
  const listed = await toolA.execute({ action: "list" });
  assert.deepEqual(
    listed.user.map((entry) => entry.name),
    ["reply-in-chinese"]
  );
  assert.deepEqual(
    listed.projectMemories.map((entry) => entry.name),
    ["ticket-split"]
  );
  assert.match(await toolA.index(), /Project 项目 A \[1\/80\]:\n- ticket-split \[project, /);
  assert.doesNotMatch(await toolB.index(), /ticket-split/);
  const written = await toolB.execute({
    action: "write",
    scope: "project",
    name: "b-only",
    type: "reference",
    description: "B 的看板地址",
    body: "看板在 http://board.example/b"
  });
  assert.equal(written.usage, "1/80");
  assert.equal(
    (await toolA.execute({ action: "read", scope: "project", name: "ticket-split" })).memory.type,
    "project"
  );
  await assert.rejects(
    toolA.execute({ action: "read", scope: "project", name: "b-only" }),
    /没有名为 b-only/
  );
  // A read without a scope finds the memory in either scope, project first.
  const anywhere = await toolA.execute({ action: "read", name: "ticket-split" });
  assert.equal(anywhere.memory.scope, "project");
  assert.equal((await toolA.execute({ action: "read", name: "reply-in-chinese" })).memory.scope, "user");
  await assert.rejects(toolA.execute({ action: "read", name: "b-only" }), /没有名为 b-only/);
  await assert.rejects(
    toolA.execute({ action: "write", name: "no-scope", type: "user", description: "x", body: "x" }),
    /记忆请求参数不合法：scope: /
  );

  // Switching a project's memory off hides it from Main and refuses writes; settings still reads it.
  assert.equal(
    (await f.request("/api/memory/enabled", { projectId: a.projectId, enabled: false })).status,
    200
  );
  assert.doesNotMatch(await toolA.index(), /ticket-split/);
  assert.match(await toolA.index(), /reply-in-chinese/);
  await assert.rejects(
    toolA.execute({ action: "write", scope: "project", ...sample("again") }),
    /用户关闭了这个项目的记忆/
  );
  const settingsView = await f.request(`/api/memory?scope=project&projectId=${a.projectId}`);
  assert.equal(settingsView.body.enabled, false);
  assert.deepEqual(
    settingsView.body.memories.map((entry) => entry.name),
    ["ticket-split"]
  );

  // A delegated subprocess has no run credential, so it has no memory.
  const previous = process.env.FORMICAND_API_TOKEN;
  delete process.env.FORMICAND_API_TOKEN;
  try {
    const delegated = createMemoryTool({ dashboardUrl: f.base, taskId: "task-a" });
    await assert.rejects(delegated.execute({ action: "list" }), /记忆工具不可用：本次运行没有本地服务凭据/);
  } finally {
    if (previous !== undefined) process.env.FORMICAND_API_TOKEN = previous;
  }

  // Deleting from settings removes the file.
  assert.equal(
    (await f.request("/api/memory/delete", { target: { scope: "user" }, name: "reply-in-chinese" })).body
      .deleted,
    true
  );
  await assert.rejects(readFile(join(f.home, "memory", "user", "reply-in-chinese.md")), { code: "ENOENT" });
});

test(
  "a memory Main saves in one turn is in its system prompt on the next",
  { timeout: 90_000 },
  async (t) => {
    let phase = "save";
    const failures = [];
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      const last = body.messages.at(-1);
      if (phase === "save") {
        if (last.role === "tool") return { text: "记下了。" };
        const names = body.tools.map((tool) => tool.function.name);
        if (!names.includes("memory")) failures.push("Main has no memory tool");
        return {
          name: "memory",
          arguments: {
            action: "write",
            scope: "user",
            name: "reply-in-chinese",
            type: "user",
            description: "回复用中文大白话",
            body: "用户英文不好，回复少夹英文术语。"
          }
        };
      }
      return { text: "好的。" };
    });
    t.after(() => provider.close());
    const f = await memoryFixture(t, { modelEndpoint: provider.baseUrl, model: "protocol-fixture" });
    const a = await f.project("项目 A");
    const created = await f.request("/api/tasks", { goal: "memory", projectId: a.projectId });
    const taskId = created.body.task?.taskId ?? created.body.taskId;
    const settle = async () => {
      for (let attempt = 0; attempt < 400; attempt++) {
        await delay(100);
        const detail = await f.request(`/api/tasks/${taskId}`);
        if (
          ["completed", "failed", "cancelled"].includes(detail.body.task?.status) &&
          !detail.body.runtime?.active
        )
          return detail.body;
      }
      throw new Error("the turn did not settle");
    };
    assert.ok((await f.request(`/api/tasks/${taskId}/run`, { prompt: "以后都用中文回复我" })).status < 300);
    await settle();
    const first = provider.requests[0].body.messages[0].content;
    assert.doesNotMatch(first, /<memory>/, "nothing saved yet, no section");
    const stored = await readFile(join(f.home, "memory", "user", "reply-in-chinese.md"), "utf8");
    assert.match(stored, /用户英文不好/);

    // Settings changes it between turns; the next turn sees the edit.
    await f.request("/api/memory/save", {
      target: { scope: "project", projectId: a.projectId },
      memory: sample("ticket-split", { type: "project" })
    });
    phase = "read";
    const before = provider.requests.length;
    assert.ok((await f.request(`/api/tasks/${taskId}/run`, { prompt: "继续" })).status < 300);
    await settle();
    const system = provider.requests[before].body.messages[0].content;
    const section = system.match(/<memory>\n([^]*?)\n<\/memory>/)?.[1];
    assert.ok(section, "the memory section is in the system prompt");
    assert.match(
      section,
      /User \(all projects\) \[1\/80\]:\n- reply-in-chinese \[user, \d{4}-\d{2}-\d{2}\] 回复用中文大白话/
    );
    assert.match(section, /Project 项目 A \[1\/80\]:\n- ticket-split \[project, /);
    assert.doesNotMatch(section, /用户英文不好/, "only the index, not the body");
    assert.deepEqual(failures, []);
  }
);
