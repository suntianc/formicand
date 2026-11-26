import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { SubagentDispatchService } from "../dist/src/runtime/subagent-dispatch.js";
import { agentLocations, resolveAgent } from "../dist/src/runtime/agent-definitions.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * Custom Agents in real Pi processes: a delegation names an Agent, and the
 * request the model receives holds only the tools, skills and MCP servers its
 * definition gives, with its extra prompt after the role's.
 */

const harness = resolve(".");
const run = promisify(execFile);
const MODEL = "custom-agent-model";
const API_KEY = "custom-agent-key";
const echo = [resolve("test/fixtures/mcp-echo-server.mjs")];

function toolNames(request) {
  return (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name).sort();
}

function systemText(request) {
  const system = request.messages.find((message) => message.role === "system");
  return typeof system.content === "string"
    ? system.content
    : system.content.map((part) => part.text).join("");
}

async function waitFor(check, label, timeout = 120_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function skill(root, name) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nUse it.\n`
  );
}

async function setup(t, handle, ports = {}) {
  const root = await mkdtemp(join(tmpdir(), "custom-agent-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const project = join(root, "project");
  await mkdir(workspace, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "README.md"), "project\n");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "agent@example.test"],
    ["config", "user.name", "Agent"],
    ["add", "-A"],
    ["commit", "-m", "start"]
  ])
    await run("git", args, { cwd: project });
  await skill(join(home, "skills"), "pg-migration");
  await skill(join(home, "skills"), "release-notes");
  await writeFile(
    join(home, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        echoes: { command: process.execPath, args: echo, exposure: "direct" },
        other: { command: process.execPath, args: echo, exposure: "direct" }
      }
    })
  );
  const agents = join(home, "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(
    join(agents, "db-migrator.md"),
    "---\nname: db-migrator\ndescription: 迁移\npermission: write\ntools: [read, bash, edit]\nskills: [pg-migration]\nmcp: [echoes]\n---\nAGENT_PROMPT_MARK 先在临时库演练。\n"
  );
  await writeFile(
    join(agents, "pr-checker.md"),
    "---\nname: pr-checker\ndescription: 检查\npermission: read\nskills: []\n---\nREAD_AGENT_MARK\n"
  );
  await writeFile(
    join(agents, "retired.md"),
    "---\nname: retired\ndescription: 不用了\npermission: write\nenabled: false\n---\n"
  );

  const store = new LocalWorkspaceStore(workspace);
  await store.createTask("task", { projectDirectory: project });
  await store.updateTask("task", { activeRunId: "run" });
  const provider = await startLocalProvider({ model: MODEL, handle });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ api: "openai-completions", baseUrl: provider.baseUrl, apiKey: API_KEY, model: MODEL })
  );
  const env = isolatedPiEnvironment({
    HOME: root,
    TMPDIR: root,
    FORMICAND_HOME: home,
    FORMICAND_CONFIG: join(root, "config.json"),
    FORMICAND_CONFIG_ROOT: root,
    FORMICAND_HARNESS_ROOT: harness,
    FORMICAND_WORKSPACE: workspace,
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
    FORMICAND_DISABLE_SESSION_TITLES: "1",
    FORMICAND_API_BASE: provider.baseUrl,
    FORMICAND_API_KEY: API_KEY,
    FORMICAND_MODEL: MODEL,
    FORMICAND_MODEL_API: "openai-completions",
    FORMICAND_REASONING_EFFORT: "off",
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1"
  });
  const service = new SubagentDispatchService({
    workspaceRoot: workspace,
    harnessRoot: harness,
    pollMs: 50,
    env: () => ({ env }),
    agent: async ({ name }) => await resolveAgent(await agentLocations(home, project), name),
    ...ports
  });
  const runRoot = join(workspace, "task", "runs", "run");
  t.after(async () => {
    service.close();
    await provider.close();
    const subagents = await readdir(join(runRoot, "agents", "subagents")).catch(() => []);
    for (const agent of subagents) {
      const record = await readJson(join(runRoot, "agents", "subagents", agent, "process.json"), undefined);
      if (record?.pid && !record.settledAt)
        try {
          process.kill(-record.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
    }
    // A process that was just stopped may still be finishing its last write.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return { service, provider, runRoot, home };
}

async function settled(runRoot, callId) {
  return await waitFor(async () => {
    const item = (await new DurableScheduler(join(runRoot, "queue.json")).list()).find(
      (entry) => entry.stepId === callId
    );
    return item && ["completed", "failed", "cancelled"].includes(item.status) ? item : undefined;
  }, `${callId} settled`);
}

test(
  "a write Agent holds only its tools, its skills and its MCP server, with its prompt after the role's",
  { timeout: 150_000 },
  async (t) => {
    const { service, provider, runRoot, home } = await setup(t, () => ({ text: "MIGRATED" }));
    const accepted = await service.dispatch({
      taskId: "task",
      task: "加索引",
      role: "executor",
      agent: "db-migrator"
    });
    assert.equal(accepted.role, "executor");
    assert.equal(accepted.agent, "db-migrator");
    const item = await settled(runRoot, accepted.callId);
    assert.equal(item.status, "completed", item.error);
    assert.equal(item.payload.agentDefinition.name, "db-migrator");

    const request = provider.requests[0];
    assert.deepEqual(toolNames(request), [
      "ask_main",
      "bash",
      "clear_context",
      "edit",
      "load_skill",
      "mcp__echoes__echo",
      "mcp__echoes__erase",
      "read",
      "read_history",
      "search_history",
      "send_peer_message",
      "session_notes"
    ]);
    const system = systemText(request);
    assert.match(system, /Instructions for the db-migrator Agent[^]*AGENT_PROMPT_MARK/);
    assert.match(system, /<name>pg-migration<\/name>/);
    assert.doesNotMatch(system, /release-notes/);
    assert.ok(system.indexOf("You run this work item as the Executor") < system.indexOf("AGENT_PROMPT_MARK"));

    const events = (await readFile(join(runRoot, "run_events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.find((event) => event.type === "call.agent_selected").payload.agent, {
      name: "db-migrator",
      source: "global",
      permission: "write",
      modelSource: "role"
    });

    // The item keeps the definition it was dispatched with.
    await writeFile(
      join(home, "agents", "db-migrator.md"),
      "---\nname: db-migrator\ndescription: 改了\npermission: read\n---\n"
    );
    const queue = await new DurableScheduler(join(runRoot, "queue.json")).list();
    assert.equal(
      queue.find((entry) => entry.stepId === accepted.callId).payload.agentDefinition.permission,
      "write"
    );
  }
);

test(
  "a built-in Executor runs with the skills, MCP servers and prompt set for it, fixed at dispatch",
  { timeout: 150_000 },
  async (t) => {
    const asked = [];
    const { service, provider, runRoot } = await setup(t, () => ({ text: "DONE" }), {
      builtinAgent: (input) => {
        asked.push(input);
        return {
          skills: ["release-notes"],
          mcp: ["other"],
          prompt: "BUILTIN_PROMPT_MARK 用中文写提交信息。"
        };
      }
    });
    const accepted = await service.dispatch({
      taskId: "task",
      task: "改个字",
      role: "executor"
    });
    const item = await settled(runRoot, accepted.callId);
    assert.equal(item.status, "completed", item.error);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].role, "executor");
    assert.match(asked[0].projectDirectory, /project$/, "settings are read for the user's project");
    assert.deepEqual(item.payload.builtinAgent, {
      skills: ["release-notes"],
      mcp: ["other"],
      prompt: "BUILTIN_PROMPT_MARK 用中文写提交信息。"
    });
    assert.match(item.payload.delegation.projectDirectory, /project$/);

    const request = provider.requests[0];
    const tools = toolNames(request);
    assert.ok(tools.includes("mcp__other__echo"), tools.join(", "));
    assert.ok(!tools.some((tool) => tool.startsWith("mcp__echoes__")), "a server it was not given stays off");
    assert.ok(tools.includes("edit"), "the role keeps its own tools");
    const system = systemText(request);
    assert.match(system, /Instructions the user set for this role[^]*BUILTIN_PROMPT_MARK/);
    assert.ok(
      system.indexOf("You run this work item as the Executor") < system.indexOf("BUILTIN_PROMPT_MARK")
    );
    assert.match(system, /<name>release-notes<\/name>/);
    assert.doesNotMatch(system, /pg-migration/);
  }
);

test(
  "a read Agent works in its own checkout, has no write tool or review form, and answers in text",
  { timeout: 150_000 },
  async (t) => {
    const { service, provider, runRoot } = await setup(t, () => ({ text: "FOUND_NOTHING_BAD" }));
    const accepted = await service.dispatch({
      taskId: "task",
      task: "看看",
      role: "executor",
      agent: "pr-checker"
    });
    assert.equal(accepted.role, "reviewer");
    const item = await settled(runRoot, accepted.callId);
    assert.equal(item.status, "completed", item.error);
    const request = provider.requests[0];
    assert.deepEqual(toolNames(request), [
      "ask_main",
      "bash",
      "browse_workspace",
      "clear_context",
      "find",
      "grep",
      "ls",
      "read",
      "read_history",
      "search",
      "search_history",
      "send_peer_message",
      "session_notes",
      "visit"
    ]);
    const system = systemText(request);
    assert.match(system, /READ_AGENT_MARK/);
    assert.doesNotMatch(system, /submit_review/);
    assert.doesNotMatch(system, /<available_skills>/, "an Agent that names no skills sees none");
    const result = await readJson(
      join(runRoot, "agents", "subagents", accepted.agentId, "result.json"),
      undefined
    );
    assert.equal(result.response, "FOUND_NOTHING_BAD");
  }
);

test("a switched-off, missing or mismatched Agent is refused with its name, never replaced", async (t) => {
  const { service } = await setup(t, () => ({ text: "unused" }));
  const dispatch = (agent, role = "executor") => service.dispatch({ taskId: "task", task: "x", role, agent });
  await assert.rejects(dispatch("retired"), /Agent retired 已停用/);
  await assert.rejects(dispatch("nobody"), /没有名为 nobody 的 Agent/);
  await assert.rejects(
    dispatch("pr-checker", "reviewer").then(() => dispatch("db-migrator", "reviewer")),
    /db-migrator 的权限是 write/
  );
  await assert.rejects(dispatch("reviewer", "executor"), /agent=reviewer 与 role=executor 不一致/);
});

test("Main is told which Agents exist and can name one in call_subagent", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "custom-agent-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const workspace = join(root, "workspace");
  for (const folder of [join(home, "agents"), join(project, ".formicand", "agents"), workspace])
    await mkdir(folder, { recursive: true });
  await writeFile(
    join(home, "agents", "db-migrator.md"),
    "---\nname: db-migrator\ndescription: 涉及表结构变更时派给它\npermission: write\n---\n"
  );
  await writeFile(
    join(home, "agents", "retired.md"),
    "---\nname: retired\ndescription: 不用了\npermission: write\nenabled: false\n---\n"
  );
  // An untrusted project's Agents are not read.
  await writeFile(
    join(project, ".formicand", "agents", "planted.md"),
    "---\nname: planted\ndescription: 项目里的\npermission: write\n---\n"
  );
  const provider = await startLocalProvider({ model: MODEL, handle: () => ({ text: "MAIN_DONE" }) });
  t.after(() => provider.close());
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ baseUrl: provider.baseUrl, apiKey: API_KEY, model: MODEL, reasoningEffort: "off" })
  );
  const pending = run(process.execPath, ["scripts/start-pi.mjs", "--print", "--mode", "json", "你好"], {
    cwd: harness,
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
    env: isolatedPiEnvironment({
      HOME: root,
      FORMICAND_HOME: home,
      FORMICAND_CONFIG: configPath,
      FORMICAND_PROJECT_DIR: project,
      FORMICAND_WORKSPACE: workspace,
      FORMICAND_TASK_ID: "main-agents",
      FORMICAND_RUN_ID: "main-agents-run",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
      FORMICAND_DISABLE_SESSION_TITLES: "1",
      PI_OFFLINE: "1"
    })
  });
  pending.child.stdin.end();
  const { stdout, stderr } = await pending;
  assert.ok(stdout.includes("MAIN_DONE"), stderr);
  const request = provider.requests[0];
  const system = systemText(request);
  assert.match(system, /<custom_agents>[^]*- db-migrator \(write\): 涉及表结构变更时派给它/);
  assert.doesNotMatch(system, /retired|planted/);
  const call = request.tools.find((tool) => tool.function.name === "call_subagent");
  assert.ok(call.function.parameters.properties.agent, "call_subagent takes an agent name");
});
