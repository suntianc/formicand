import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentProcessHost } from "../dist/src/runtime/agent-process.js";
import { SubagentDispatchService } from "../dist/src/runtime/subagent-dispatch.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";

test("a dispatch and its callback publish new snapshots while readers inspect the previous ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "formicand-dispatch-reader-"));
  const queuePath = join(root, "queue.json");
  const inboxPath = join(root, "inbox.json");
  const scheduler = new DurableScheduler(queuePath);
  const inbox = new InboxStore(inboxPath);
  try {
    const work = { taskId: "task", runId: "run", agentId: "a", importance: "normal", payload: {} };
    const first = await scheduler.enqueue({ ...work, stepId: "executor" });
    const message = await inbox.enqueue({
      messageId: "m1",
      eventId: "e1",
      recipientAgentId: "main",
      kind: "callback",
      priority: 1,
      state: "ready",
      payload: {},
      createdAt: first.createdAt
    });
    const queueReader = await open(queuePath, "r");
    try {
      await scheduler.enqueue({ ...work, stepId: "reviewer" });
      assert.deepEqual(JSON.parse(await queueReader.readFile("utf8")), [first]);
      assert.deepEqual(
        (await scheduler.list()).map((item) => item.stepId),
        ["executor", "reviewer"]
      );
    } finally {
      await queueReader.close();
    }
    const inboxReader = await open(inboxPath, "r");
    try {
      await inbox.enqueue({ ...message, messageId: "m2", eventId: "e2" });
      assert.deepEqual(JSON.parse(await inboxReader.readFile("utf8")), [message]);
      assert.deepEqual(
        (await inbox.list("main")).map((entry) => entry.messageId),
        ["m1", "m2"]
      );
    } finally {
      await inboxReader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const TASK_ID = "outcome-task";
const RUN_ID = "outcome-run";
const CALL_ID = "call-outcome";

/** Wait for an observable condition instead of guessing a fixed delay. */
async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

/** Read the durable Inbox without taking its lock (the test may hold it). */
async function inboxMessages(path) {
  const raw = await readFile(path, "utf8").catch(() => "[]");
  return JSON.parse(raw);
}

/**
 * A settlement records the outcome before it publishes the callback.
 *
 * The Inbox lock is held here so the intermediate pair is observable instead
 * of raced: the queue row is terminal and marked `callbackPending`, and the
 * callback cannot be queued yet.
 */
test("the terminal queue row is durable before its callback is queued", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p46-outcome-pair-"));
  const workspace = join(root, "workspace");
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  const inboxPath = join(runRoot, "agents", "main", "inbox-store.json");
  const processDirectory = join(runRoot, "agents", "subagents", "subagent_1");
  await mkdir(join(runRoot, "agents", "main"), { recursive: true });
  await mkdir(processDirectory, { recursive: true });
  // A process that already exited provides a pid this host cannot mistake for
  // the recorded one, so adopting the record settles it instead of watching.
  const departed = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(departed, "close");
  const service = new SubagentProcessService({
    workspaceRoot: workspace,
    harnessRoot: resolve("."),
    env: {},
    pollMs: 50
  });
  t.after(async () => {
    service.close();
    await rm(root, { recursive: true, force: true });
  });

  const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
  await scheduler.enqueue({
    stepId: CALL_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentId: "subagent_1",
    importance: "normal",
    payload: { task: "write the result", projectDirectory: workspace }
  });
  const claimed = await scheduler.claim("fixture", 60_000, CALL_ID);
  assert.ok(claimed?.lease, "the work item is leased to the attempt under test");
  await writeFile(
    join(processDirectory, "process.json"),
    JSON.stringify({
      version: 1,
      taskId: TASK_ID,
      runId: RUN_ID,
      callId: CALL_ID,
      agentId: "subagent_1",
      role: "executor",
      pid: departed.pid,
      host: hostname(),
      startedAt: "Mon Jan  1 00:00:00 2001",
      token: "attempt-token",
      launchedAt: new Date(0).toISOString(),
      workingDirectory: workspace,
      sessionDirectory: join(workspace, TASK_ID, "sessions", "subagent_1", "pi", CALL_ID),
      resultPath: join(processDirectory, "result.json"),
      stdoutPath: join(processDirectory, "agent-output.log"),
      stderrPath: join(processDirectory, "agent-stderr.log"),
      leaseToken: claimed.lease.token
    })
  );

  // Hold the Inbox lock: the settlement records its terminal row first and
  // then waits here to publish the callback.
  const lockPath = `${inboxPath}.lock`;
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ token: "held-by-test", pid: process.pid, host: hostname() })}\n`
  );
  const adoption = service.adopt({ taskId: TASK_ID, runId: RUN_ID });
  try {
    const terminal = await waitFor(async () => {
      const item = (await scheduler.list()).find((candidate) => candidate.stepId === CALL_ID);
      return item?.status === "failed" ? item : undefined;
    }, "the terminal queue row to be recorded");
    assert.equal(terminal.callbackPending, true, "the row says its callback is still on its way");
    assert.deepEqual(
      await inboxMessages(inboxPath),
      [],
      "the callback cannot be queued while its publisher waits on the held lock"
    );
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
  await adoption;

  const settled = (await scheduler.list()).find((candidate) => candidate.stepId === CALL_ID);
  assert.equal(settled.status, "failed");
  assert.equal(settled.callbackPending, undefined, "the pair is complete once the callback is queued");
  const callbacks = (await new InboxStore(inboxPath).list("main")).filter(
    (message) => message.callId === CALL_ID
  );
  assert.deepEqual(
    callbacks.map((message) => message.payload.status),
    ["failed"]
  );
});

/**
 * Main's completion decision reads the pair, not just the queue status: a
 * terminal row whose callback is not queued yet is still unsettled work.
 */
test(
  "a terminal row without its callback still counts as unsettled for Main",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-outcome-reader-"));
    const workspace = join(root, "workspace");
    const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
    const inboxPath = join(runRoot, "agents", "main", "inbox-store.json");
    await mkdir(join(runRoot, "agents", "main"), { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));

    const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
    await scheduler.enqueue({
      stepId: CALL_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      agentId: "subagent_1",
      importance: "normal",
      payload: { task: "write the result", projectDirectory: workspace }
    });
    const claimed = await scheduler.claim("fixture", 60_000, CALL_ID);
    assert.ok(claimed?.lease);
    await scheduler.fail(CALL_ID, claimed.lease.token, "the attempt failed", 0, {
      callbackPending: true
    });

    const waiting = await new CoordinatorRuntime().waitForSubagents({
      taskId: TASK_ID,
      runId: RUN_ID,
      workspaceRoot: workspace,
      timeoutMs: 0
    });
    assert.deepEqual(waiting.pending, [CALL_ID], "the outcome is not settled for Main without its callback");

    // Publishing the callback completes the pair.
    await new InboxStore(inboxPath).enqueue({
      messageId: `callback-${CALL_ID}-failed`,
      recipientAgentId: "main",
      kind: "callback",
      callId: CALL_ID,
      eventId: "callback-event",
      priority: 1,
      state: "ready",
      payload: { callId: CALL_ID, agentId: "subagent_1", status: "failed", response: "", error: "failed" },
      createdAt: new Date().toISOString()
    });
    await scheduler.clearCallbackPending(CALL_ID);

    const settled = await new CoordinatorRuntime().waitForSubagents({
      taskId: TASK_ID,
      runId: RUN_ID,
      workspaceRoot: workspace,
      timeoutMs: 0
    });
    assert.deepEqual(settled.pending, [], "the settled outcome is no longer pending");
    assert.deepEqual(settled.callbackPending, [CALL_ID], "the callback is what Main reads");
  }
);

/** A queued item in a fresh workspace, with the service that would run it. */
async function queuedItem(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  await mkdir(join(runRoot, "agents", "main"), { recursive: true });
  const service = new SubagentProcessService({
    workspaceRoot: workspace,
    harnessRoot: resolve("."),
    env: {},
    pollMs: 50
  });
  t.after(async () => {
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
  await scheduler.enqueue({
    stepId: CALL_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentId: "subagent_1",
    importance: "normal",
    payload: { task: "write the result", projectDirectory: workspace }
  });
  return { service, scheduler, runRoot, inboxPath: join(runRoot, "agents", "main", "inbox-store.json") };
}

test("a cancel whose callback was never written is delivered on the next pass", async (t) => {
  const { service, scheduler, inboxPath } = await queuedItem(t, "p46-cancel-redeliver-");
  // The cancel reached the queue; the Inbox write after it did not happen.
  await scheduler.cancel(CALL_ID, { callbackPending: true });
  await service.startQueued({ taskId: TASK_ID, runId: RUN_ID });
  const item = (await scheduler.list()).find((entry) => entry.stepId === CALL_ID);
  assert.equal(item.status, "cancelled");
  assert.equal(item.callbackPending, undefined);
  const callbacks = (await inboxMessages(inboxPath)).filter(
    (message) => message.messageId === `callback-${CALL_ID}-cancelled`
  );
  assert.equal(callbacks.length, 1);
  // A second pass finds nothing left to deliver.
  await service.startQueued({ taskId: TASK_ID, runId: RUN_ID });
  assert.equal(
    (await inboxMessages(inboxPath)).filter(
      (message) => message.messageId === `callback-${CALL_ID}-cancelled`
    ).length,
    1
  );
});

test("a launch whose item was cancelled while it prepared starts nothing", async (t) => {
  const { service, scheduler, runRoot } = await queuedItem(t, "p46-cancel-launch-");
  const claimed = await scheduler.claim("fixture", 60_000, CALL_ID);
  await scheduler.cancel(CALL_ID, { callbackPending: true });
  await service.launch(claimed, claimed.payload, claimed.lease.token);
  const processFile = join(runRoot, "agents", "subagents", "subagent_1", "process.json");
  await assert.rejects(readFile(processFile, "utf8"), { code: "ENOENT" });
});

test("cancellation acknowledged before the host launches never delivers the prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p46-cancel-at-spawn-"));
  const workspaceRoot = join(root, "workspace");
  const run = { taskId: TASK_ID, runId: RUN_ID };
  const runRoot = join(workspaceRoot, TASK_ID, "runs", RUN_ID);
  const marker = join(root, "prompt");
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts", "start-pi.mjs"),
    `import { writeFile } from "node:fs/promises"; let prompt = ""; for await (const part of process.stdin) prompt += part; await writeFile(process.env.PROMPT_MARKER, prompt);`
  );
  const dispatch = new SubagentDispatchService({
    workspaceRoot,
    harnessRoot: root,
    env: async () => ({ env: { PROMPT_MARKER: marker } })
  });
  t.after(async () => {
    dispatch.close();
    await rm(root, { recursive: true, force: true });
  });
  const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
  await scheduler.enqueue({
    ...run,
    stepId: CALL_ID,
    agentId: "subagent_1",
    importance: "normal",
    payload: { task: "write the result", projectDirectory: root }
  });
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const launch = AgentProcessHost.prototype.launch;
  t.mock.method(AgentProcessHost.prototype, "launch", async function (input) {
    entered.resolve();
    await resume.promise;
    return launch.call(this, input);
  });
  const starting = dispatch.maintain(run);
  try {
    await entered.promise;
    assert.equal((await dispatch.cancel({ ...run, callId: CALL_ID })).status, "cancelled");
  } finally {
    resume.resolve();
    await starting;
  }
  assert.deepEqual(
    (await new InboxStore(join(runRoot, "agents", "main", "inbox-store.json")).list("main")).map(
      (message) => message.payload.status
    ),
    ["cancelled"]
  );
  await assert.rejects(readFile(join(runRoot, "agents", "subagents", "subagent_1", "process.json")), {
    code: "ENOENT"
  });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("a Reviewer startup failure releases the checkout even without a process record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p46-review-env-failure-"));
  const repository = join(root, "repo");
  const checkout = join(root, "review");
  await mkdir(repository);
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "candidate"
  );
  const workspaceRoot = join(root, "workspace");
  const run = { taskId: TASK_ID, runId: RUN_ID };
  const scheduler = new DurableScheduler(join(workspaceRoot, TASK_ID, "runs", RUN_ID, "queue.json"));
  await scheduler.enqueue({
    ...run,
    stepId: CALL_ID,
    agentId: "subagent_1",
    importance: "normal",
    payload: {
      task: "review",
      delegation: { role: "reviewer" },
      projectDirectory: repository,
      reviewSite: { repository, directory: checkout, commit: git("rev-parse", "HEAD") }
    }
  });
  const dispatch = new SubagentDispatchService({
    workspaceRoot,
    harnessRoot: root,
    env: async () => {
      throw new Error("model configuration unavailable");
    }
  });
  t.after(async () => {
    dispatch.close();
    await rm(root, { recursive: true, force: true });
  });
  await dispatch.maintain(run);
  assert.equal((await scheduler.list())[0].status, "failed");
  assert.equal(git("worktree", "list", "--porcelain").includes(checkout), false);
  await assert.rejects(readFile(join(checkout, ".git")), { code: "ENOENT" });
});
