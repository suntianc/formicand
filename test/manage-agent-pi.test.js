import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * Main creating Agents: manage_agent shows the whole definition as a question
 * and writes only after the user confirms. Each case runs a real Main process
 * whose model calls the tool, and answers the question the way the page does.
 */

const run = promisify(execFile);
const MODEL = "manage-agent-model";
const TASK = "agents-task";
const RUN = "agents-run";

function lastToolText(body) {
  const message = body.messages.findLast((entry) => entry.role === "tool");
  if (!message) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text).join("");
}

const definition = {
  name: "db-migrator",
  description: "涉及表结构变更时派给它",
  permission: "write",
  tools: ["read", "bash", "edit"],
  mcp: ["postgres"],
  prompt: "先在临时库演练。"
};

async function mainTurn(t, { calls, answer }) {
  const root = await mkdtemp(join(tmpdir(), "manage-agent-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = join(root, "home");
  const project = join(root, "project");
  const workspace = join(root, "workspace");
  for (const folder of [home, project, workspace]) await mkdir(folder, { recursive: true });
  await writeFile(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { postgres: { command: "postgres-mcp", enabled: false } } })
  );
  const store = new LocalWorkspaceStore(workspace);
  await store.createTask(TASK, { goal: "agents", projectDirectory: project });
  await store.createRun(TASK, RUN);
  const results = [];
  const provider = await startLocalProvider({
    model: MODEL,
    handle: (body, requests) => {
      if (requests.length > 1) results.push(lastToolText(body));
      const call = calls[requests.length - 1];
      return call ? { name: "manage_agent", arguments: call } : { text: "AGENT_TURN_DONE" };
    }
  });
  t.after(() => provider.close());
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl: provider.baseUrl,
      apiKey: "manage-agent-key",
      model: MODEL,
      reasoningEffort: "off"
    })
  );
  // Answer each question the way the page does, once it appears.
  const humans = new HumanRequestStore(workspace);
  const questions = [];
  let answering = true;
  const answering_loop = (async () => {
    while (answering) {
      for (const request of await humans.list(TASK, "pending")) {
        questions.push(request);
        await humans.answer(TASK, request.requestId, answer(request));
      }
      await delay(100);
    }
  })();
  const pending = run(
    process.execPath,
    ["scripts/start-pi.mjs", "--print", "--mode", "json", "建一个 Agent"],
    {
      cwd: resolve("."),
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: isolatedPiEnvironment({
        HOME: root,
        ATRIA_HOME: home,
        COWORK_CONFIG: configPath,
        COWORK_PROJECT_DIR: project,
        COWORK_WORKSPACE: workspace,
        COWORK_TASK_ID: TASK,
        COWORK_RUN_ID: RUN,
        PI_CODING_AGENT_DIR: join(root, "pi"),
        COWORK_DISABLE_MAIN_GUARDIAN: "1",
        PI_OFFLINE: "1"
      })
    }
  );
  pending.child.stdin.end();
  try {
    const { stdout, stderr } = await pending;
    assert.ok(stdout.includes("AGENT_TURN_DONE"), stderr);
  } finally {
    answering = false;
    await answering_loop;
  }
  return { home, results, questions };
}

test(
  "a confirmed proposal is written, after the user saw the whole definition",
  { timeout: 90_000 },
  async (t) => {
    const { home, results, questions } = await mainTurn(t, {
      calls: [{ action: "create", scope: "global", definition }, { action: "list" }],
      answer: (request) => request.options[0]
    });
    assert.equal(questions.length, 1);
    assert.equal(questions[0].question, "创建 Agent：db-migrator");
    assert.deepEqual(questions[0].options, ["确认创建", "拒绝"]);
    assert.equal(questions[0].recommended, 1, "a timeout does not write");
    assert.deepEqual(questions[0].proposal, {
      kind: "agent",
      action: "create",
      scope: "global",
      path: join(home, "agents", "db-migrator.md"),
      definition
    });
    assert.equal(JSON.parse(results[0]).saved, true);
    const saved = await readFile(join(home, "agents", "db-migrator.md"), "utf8");
    assert.match(saved, /mcp: \[postgres\]/);
    assert.match(saved, /先在临时库演练。/);
    assert.equal(
      JSON.parse(results[1]).agents.find((agent) => agent.name === "db-migrator").permission,
      "write"
    );
  }
);

test(
  "any other answer writes nothing; unknown servers and untrusted projects are refused without asking",
  { timeout: 90_000 },
  async (t) => {
    const { home, results, questions } = await mainTurn(t, {
      calls: [
        { action: "create", definition },
        { action: "create", definition: { ...definition, mcp: ["github"] } },
        { action: "create", scope: "project", definition },
        { action: "create", definition: { ...definition, permission: "read" } }
      ],
      answer: () => "改成只读"
    });
    assert.equal(questions.length, 1, "only the valid proposal reaches the user");
    const rejected = JSON.parse(results[0]);
    assert.equal(rejected.saved, false);
    assert.equal(rejected.answer, "改成只读");
    assert.equal(existsSync(join(home, "agents", "db-migrator.md")), false);
    assert.match(JSON.parse(results[1]).error, /MCP 服务 github 没有配置/);
    assert.match(JSON.parse(results[2]).error, /还没有被信任/);
    assert.match(JSON.parse(results[3]).error, /只读 Agent 不能使用 edit/);
  }
);
