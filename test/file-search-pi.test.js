import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";
import { startDashboard } from "./dashboard-fixture.mjs";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * File search as Main and a Reviewer actually receive it.
 *
 * Both cases run a real Pi process against a recorded local provider. The tool
 * table and the tool results are read from the model requests, so the test
 * covers the production role context instead of calling the search helpers
 * directly. The fixture keeps the indexed tree small, and the exact-mode case
 * writes its file after the first index is open to check immediate visibility.
 */

const execFileAsync = promisify(execFile);
const harness = resolve(".");
const MODEL = "file-search-fixture-model";
const TASK_ID = "file-search-task";
const RUN_ID = "file-search-run";
const API_KEY = "file-search-test-key";

const SEARCH_ALIASES = ["ff", "fffind", "ffgrep", "fff", "multi_grep", "fff-multi-grep"];

function toolNames(body) {
  return (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function lastToolText(body) {
  const last = (body.messages ?? []).findLast(
    (message) => message.role === "tool" || message.role === "toolResult"
  );
  return last ? messageText(last) : "";
}

function systemText(body) {
  return messageText((body.messages ?? []).find((message) => message.role === "system"));
}

/** The one find and the one grep the production role gives the model. */
function assertSearchTools(body, role) {
  const names = toolNames(body);
  assert.equal(names.filter((name) => name === "find").length, 1, `${role} gets one find tool`);
  assert.equal(names.filter((name) => name === "grep").length, 1, `${role} gets one grep tool`);
  for (const alias of SEARCH_ALIASES)
    assert.equal(names.includes(alias), false, `${role} must not receive the ${alias} alias`);
}

/** The files both roles search. Keep it small so the FFF scan settles quickly. */
async function writeSearchProject(root) {
  await mkdir(join(root, "src", "runtime"), { recursive: true });
  await mkdir(join(root, "scope"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(
    join(root, "src", "runtime", "http-transport.ts"),
    "export function createHttpTransport() {\n  return 'ready';\n}\n"
  );
  await writeFile(join(root, "src", "runtime", "other.ts"), "export const other = true;\n");
  await writeFile(join(root, "scope", "notes.txt"), "flag.v2\nflagXv2\nFLAG.V2\n");
  await writeFile(join(root, "scope", "other.txt"), "flag.v2 is not in the glob\n");
  await writeFile(join(root, "outside", "notes.txt"), "flag.v2 is outside the scope\n");
}

/** The exact-mode file is created after the index is open, immediately before the next search. */
async function writeFreshFile(root) {
  await writeFile(join(root, "scope", "fresh-notes.txt"), "fresh-visible-marker\n");
}

function assertExactFlagResult(text) {
  const lines = text.split("\n").filter((line) => line.includes("flag.v2"));
  assert.equal(lines.length, 1, `exact mode returns only the literal line:\n${text}`);
  assert.match(text, /notes\.txt:1: flag\.v2/, "the exact result names the scoped file and line");
  assert.doesNotMatch(text, /flagXv2/, "a dot is literal in exact mode");
  assert.doesNotMatch(text, /FLAG\.V2/, "exact mode is case-sensitive by default");
  assert.doesNotMatch(text, /outside/, "the path scope keeps other directories out");
}

async function waitFor(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function git(directory, args) {
  return (await execFileAsync("git", ["-C", directory, ...args], { windowsHide: true })).stdout.trim();
}

async function createCandidateSite(root) {
  const repository = join(root, "candidate");
  await mkdir(repository, { recursive: true });
  await writeSearchProject(repository);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "file-search@example.test"]);
  await git(repository, ["config", "user.name", "File Search"]);
  await git(repository, ["add", "-A"]);
  await git(repository, ["commit", "-m", "search fixture"]);
  // The service creates this path as a detached worktree of the candidate and
  // refuses to overwrite an existing directory, so leave it absent.
  return {
    repository,
    directory: join(root, "review-site"),
    commit: await git(repository, ["rev-parse", "HEAD"])
  };
}

function searchProvider(directory, role) {
  const calls = [
    { name: "find", arguments: { pattern: "http transprt", limit: 10 } },
    { name: "grep", arguments: { pattern: "createHttpTransprt" } },
    { name: "grep", arguments: { pattern: "flag.v2", path: "scope", glob: "notes.txt", mode: "exact" } },
    { name: "grep", arguments: { pattern: "fresh-visible-marker", path: "scope", mode: "exact" } },
    ...(role === "Main"
      ? [
          {
            name: "grep",
            arguments: { pattern: "flag.v2", path: "scope", glob: "notes.txt", literal: true }
          },
          {
            name: "grep",
            arguments: { pattern: "createHttpTransp(ort|rt)", path: "src", literal: false, mode: "exact" }
          },
          { name: "find", arguments: { pattern: "@(other|http-transport).ts" } },
          { name: "grep", arguments: { pattern: "uniqueIgnoredNeedle", path: "src" } },
          { name: "grep", arguments: { pattern: "longPreviewNeedle" } }
        ]
      : [{ name: "submit_review", arguments: { verdict: "pass", findings: [] } }])
  ];
  let turn = 0;
  return startLocalProvider({
    model: MODEL,
    handle: async (body) => {
      if (!toolNames(body).includes("grep")) return { text: "fixture response" };
      if (turn === 3) await writeFreshFile(directory());
      return calls[turn++] ?? { text: "Search complete" };
    }
  });
}

/** Run a real Main turn through the Dashboard and the real launcher. */
async function runMainSearch(t) {
  let projectDirectory;
  const provider = await searchProvider(() => projectDirectory, "Main");
  t.after(() => provider.close());
  const dashboard = await startDashboard({
    modelEndpoint: provider.baseUrl.replace(/\/v1$/, ""),
    model: MODEL,
    defaultProject: false
  });
  t.after(() => dashboard.stop());
  // The project is separate from the Task's runtime directory: logs contain the
  // model's own search strings and must not become grep matches.
  projectDirectory = join(dashboard.root, "search-project");
  await writeSearchProject(projectDirectory);
  await git(projectDirectory, ["init", "-b", "main"]);
  await writeFile(join(projectDirectory, ".gitignore"), "src/generated.txt\n");
  await writeFile(join(projectDirectory, "src", "generated.txt"), "uniqueIgnoredNeedle\n");
  await writeFile(join(projectDirectory, "long.txt"), "longPreviewNeedle" + "x".repeat(3000));
  const projectResponse = await fetch(`${dashboard.base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectName: "Search fixture", projectDirectory })
  });
  const projectBody = await projectResponse.text();
  assert.ok(projectResponse.ok, projectBody);
  const { project } = JSON.parse(projectBody);
  await writeFile(
    join(dashboard.root, "config.json"),
    JSON.stringify({ api: "openai-completions", mainMaxTokens: 256 })
  );
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(
    join(dashboard.root, "pi", "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
  );

  const create = await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId: TASK_ID,
      goal: "Search the fixture files",
      projectId: project.projectId
    })
  });
  assert.equal(create.status, 201, await create.text());
  const run = await fetch(`${dashboard.base}/api/tasks/${TASK_ID}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Use find and grep to inspect the fixture files." })
  });
  assert.equal(run.status, 202, await run.text());
  const detail = await waitFor(async () => {
    const value = await (await fetch(`${dashboard.base}/api/tasks/${TASK_ID}`)).json();
    return value.runtime.active ? undefined : value;
  }, "Main turn to settle");
  assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));

  const searchRequests = provider.requests.filter(
    (body) => toolNames(body).includes("find") && toolNames(body).includes("grep")
  );
  assert.ok(searchRequests.length >= 10, `Main made the scripted search requests (${searchRequests.length})`);
  assertSearchTools(searchRequests[0], "Main");
  assert.match(systemText(searchRequests[0]), /Formicand Main Agent/, "Main's production prompt reached it");
  return { searchRequests };
}

/** Run a Reviewer through the backend that launches delegated work. */
async function runReviewerSearch(t) {
  const root = await mkdtemp(join(tmpdir(), "file-search-reviewer-"));
  const workspace = join(root, "workspace");
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  await mkdir(workspace, { recursive: true });
  const site = await createCandidateSite(root);
  const provider = await searchProvider(() => site.directory, "Reviewer");
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ api: "openai-completions", baseUrl: provider.baseUrl, apiKey: API_KEY, model: MODEL })
  );
  const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
  await scheduler.enqueue({
    stepId: "call-file-search",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentId: "subagent_search",
    importance: "normal",
    payload: {
      task: "Review the search fixture",
      delegation: { role: "reviewer" },
      reviewSite: {
        repository: site.repository,
        commit: site.commit,
        directory: site.directory
      }
    },
    maxAttempts: 1
  });
  const service = new SubagentProcessService({
    workspaceRoot: workspace,
    harnessRoot: harness,
    env: isolatedPiEnvironment({
      HOME: root,
      TMPDIR: root,
      FORMICAND_HOME: join(root, "home"),
      FORMICAND_CONFIG: join(root, "config.json"),
      FORMICAND_CONFIG_ROOT: root,
      FORMICAND_HARNESS_ROOT: harness,
      FORMICAND_WORKSPACE: workspace,
      FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
      FORMICAND_API_BASE: provider.baseUrl,
      FORMICAND_API_KEY: API_KEY,
      FORMICAND_MODEL: MODEL,
      FORMICAND_MODEL_API: "openai-completions",
      FORMICAND_REASONING_EFFORT: "off",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1"
    }),
    pollMs: 50,
    graceMs: 500
  });
  t.after(async () => {
    service.close();
    await provider.close();
    const directory = join(runRoot, "agents", "subagents");
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const record = await readJson(join(directory, entry.name, "process.json"), undefined);
      if (!record?.pid || record.settledAt) continue;
      try {
        process.kill(-record.pid, "SIGKILL");
      } catch {
        /* the process group has already exited */
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  await service.startQueued({ taskId: TASK_ID, runId: RUN_ID });
  const callback = await waitFor(async () => {
    const messages = await readJson(join(runRoot, "agents", "main", "inbox-store.json"), []);
    return messages.find((message) => message.callId === "call-file-search" && message.kind === "callback");
  }, "Reviewer callback");
  const result = await waitFor(
    () => readJson(join(runRoot, "agents", "subagents", "subagent_search", "result.json"), undefined),
    "Reviewer result record",
    10_000
  );
  // A callback is queued before the outcome is recorded, so wait for the
  // settled process record before the test's cleanup removes its workspace.
  await waitFor(
    async () => {
      const record = await readJson(
        join(runRoot, "agents", "subagents", "subagent_search", "process.json"),
        undefined
      );
      return record?.settledAt ? record : undefined;
    },
    "Reviewer settled process record",
    10_000
  );
  const searchRequests = provider.requests.filter(
    (body) => toolNames(body).includes("find") && toolNames(body).includes("grep")
  );
  assert.ok(
    searchRequests.length >= 5,
    `Reviewer made the scripted search requests (${searchRequests.length})`
  );
  assertSearchTools(searchRequests[0], "Reviewer");
  assert.match(
    systemText(searchRequests[0]),
    /independent Reviewer/,
    "Reviewer's production prompt reached it"
  );
  assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
  assert.equal(result.termination, "completed", JSON.stringify(result));
  return { searchRequests };
}

function assertExploration(requests, role) {
  assert.match(
    lastToolText(requests[1]),
    /src\/runtime\/http-transport\.ts/,
    `${role}'s fuzzy find locates the file from a misspelled concept`
  );
  const typo = lastToolText(requests[2]);
  assert.match(typo, /(?:0|no) exact matches?/i, `${role}'s misspelled grep says it found none`);
  assert.match(typo, /(?:similar|maybe you meant)/i, `${role}'s misspelled grep marks a suggestion`);
  assert.match(typo, /createHttpTransport/, `${role}'s misspelled grep suggests the real symbol`);
}

test("Main's production search tools explore fuzzily and query exactly", { timeout: 180_000 }, async (t) => {
  const main = await runMainSearch(t);
  assertExploration(main.searchRequests, "Main");
  assertExactFlagResult(lastToolText(main.searchRequests[3]));
  assert.match(
    lastToolText(main.searchRequests[4]),
    /fresh-notes\.txt:1: fresh-visible-marker/,
    "Main's exact grep sees a file written after the index opened"
  );
  assertExactFlagResult(lastToolText(main.searchRequests[5]));
  assert.match(
    lastToolText(main.searchRequests[6]),
    /createHttpTransport/,
    "Main's exact grep still honors a regex query"
  );
  assert.deepEqual(lastToolText(main.searchRequests[7]).split("\n").sort(), [
    "src/runtime/http-transport.ts",
    "src/runtime/other.ts"
  ]);
  assert.doesNotMatch(lastToolText(main.searchRequests[8]), /generated\.txt/);
  assert.match(lastToolText(main.searchRequests[9]), /lines truncated/i);
});

test(
  "the Reviewer's production search tools explore fuzzily and query exactly",
  { timeout: 180_000 },
  async (t) => {
    const reviewer = await runReviewerSearch(t);
    assertExploration(reviewer.searchRequests, "the Reviewer");
    assertExactFlagResult(lastToolText(reviewer.searchRequests[3]));
    assert.match(
      lastToolText(reviewer.searchRequests[4]),
      /fresh-notes\.txt:1: fresh-visible-marker/,
      "the Reviewer's exact grep sees a file written after the index opened"
    );
  }
);
