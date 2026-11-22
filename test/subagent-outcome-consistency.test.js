import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";

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
