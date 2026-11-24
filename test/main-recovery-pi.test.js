import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startDashboard } from "./dashboard-fixture.mjs";
const { mainInputPath, saveMainInput } = await import("../dist/src/runtime/main-continuation.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
const { DurableScheduler, InboxStore } = await import("../dist/src/runtime/scheduler.js");
const { MainRequestStore, mainRequestPath, mainRequestStatePath } =
  await import("../dist/src/storage/main-request-store.js");

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function stream(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "main-recovery-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  );
}
function complete(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  stream(response, { role: "assistant", content: text });
  stream(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}

async function fixture(t, handle, { retryBaseDelayMs } = {}) {
  const requests = [],
    rawRequests = [];
  let dashboard;
  const provider = createServer(async (request, response) => {
    try {
      const raw = await readFixtureRequestBody(request);
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      rawRequests.push(raw);
      await handle({ body, response, dashboard, requests });
    } catch (error) {
      response.destroy(error);
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "fixture-model"
  });
  if (retryBaseDelayMs !== undefined) {
    await mkdir(join(dashboard.root, "pi"), { recursive: true });
    await writeFile(
      join(dashboard.root, "pi", "settings.json"),
      JSON.stringify({ retry: { baseDelayMs: retryBaseDelayMs } })
    );
  }
  t.after(async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  const api = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }),
      signal: AbortSignal.timeout(5_000)
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  };
  const settle = async (taskId, status) => {
    const until = Date.now() + 30_000;
    let detail;
    while (Date.now() < until) {
      detail = await api(`/api/tasks/${taskId}`);
      if (!detail.runtime.active) {
        assert.equal(detail.task.status, status, JSON.stringify(detail.task));
        return detail;
      }
      await delay(40);
    }
    assert.fail(`Main did not settle: ${JSON.stringify(detail?.task)}`);
  };
  return { ...dashboard, api, settle, requests, rawRequests };
}

async function receipt(root, name, value) {
  const evidence = join(root, "evidence");
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

for (const recover of [true, false])
  test(
    `real Main uses exactly five automatic retries and ${recover ? "recovers on the last" : "stops when exhausted"}`,
    { timeout: 60_000 },
    async (t) => {
      const local = await fixture(
        t,
        ({ response, requests }) => {
          if (recover && requests.length === 6) return complete(response, "Fifth retry recovered.");
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic service temporarily unavailable" } }));
        },
        { retryBaseDelayMs: 1 }
      );
      const taskId = `five-retries-${recover}`;
      await local.api("/api/tasks", { taskId, goal: "Exercise the fifth retry." });
      await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise the fifth retry." });
      const detail = await local.settle(taskId, recover ? "completed" : "failed");
      assert.equal(local.requests.length, 6);
      for (const request of local.requests) assert.deepEqual(request.messages, local.requests[0].messages);
      const starts = detail.runtimeEvents
        .filter((event) => event.payload.type === "auto_retry_start")
        .map((event) => event.payload);
      assert.deepEqual(
        starts.map((event) => [event.attempt, event.maxAttempts]),
        [
          [1, 5],
          [2, 5],
          [3, 5],
          [4, 5],
          [5, 5]
        ]
      );
      const end = detail.runtimeEvents.findLast((event) => event.payload.type === "auto_retry_end").payload;
      assert.equal(end.success, recover);
      assert.equal(end.attempt, 5);
    }
  );

test("real Main does not retry a structured model-not-found 404", { timeout: 60_000 }, async (t) => {
  const local = await fixture(
    t,
    ({ response }) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ message: "No configured account supports this model", type: "model_not_found" })
      );
    },
    { retryBaseDelayMs: 1 }
  );
  const taskId = "nonretryable-model";
  await local.api("/api/tasks", { taskId, goal: "Exercise a model-not-found error." });
  await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise a model-not-found error." });
  const detail = await local.settle(taskId, "failed");
  assert.equal(local.requests.length, 1);
  assert.equal(detail.runtimeEvents.filter((event) => event.payload.type === "auto_retry_start").length, 0);
});

test(
  "real Main cancellation during retry backoff prevents another request",
  { timeout: 60_000 },
  async (t) => {
    const local = await fixture(
      t,
      ({ response }) => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Synthetic service temporarily unavailable" } }));
      },
      { retryBaseDelayMs: 10_000 }
    );
    const taskId = "cancel-retry-wait";
    await local.api("/api/tasks", { taskId, goal: "Cancel while retrying." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Cancel while retrying." });
    let retrying = false;
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const detail = await local.api(`/api/tasks/${taskId}`);
      if (detail.runtimeEvents.some((event) => event.payload.type === "auto_retry_start")) {
        retrying = true;
        break;
      }
      await delay(40);
    }
    assert.equal(retrying, true);
    await local.api(`/api/tasks/${taskId}/action`, { action: "cancel" });
    await local.settle(taskId, "cancelled");
    assert.equal(local.requests.length, 1);
  }
);

test(
  "real Main resumes a failed SSE turn with completed tool evidence and no repeated side effect",
  { timeout: 60_000 },
  async (t) => {
    let recovering = false;
    let marker;
    const local = await fixture(t, ({ body, response }) => {
      if (recovering) return complete(response, "Recovered from the preserved tool evidence.");
      response.writeHead(200, { "content-type": "text/event-stream" });
      stream(response, { role: "assistant" });
      if (!body.messages.some((message) => message.role === "tool")) {
        stream(response, {
          tool_calls: [
            {
              index: 0,
              id: "fixture-append-once",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: `printf 'done\\n' >> ${shellQuote(marker)}` })
              }
            }
          ]
        });
        stream(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
        return;
      }
      stream(response, { content: "The tool completed; this response is partial." });
      response.end(`data: ${JSON.stringify({ error: { message: "fixture-fixture-denied" } })}\n\n`);
    });
    const taskId = "effect-before-error";
    const prompt = "Record the isolated fixture result exactly once, then explain the result.";
    await local.api("/api/tasks", { taskId, goal: prompt });
    marker = join(local.workspaceRoot, taskId, "agents", "main", "work", "effect.txt");
    await mkdir(join(local.workspaceRoot, taskId, "agents", "main", "work"), { recursive: true });
    const first = await local.api(`/api/tasks/${taskId}/run`, { prompt });
    const failed = await local.settle(taskId, "failed");
    assert.match(failed.task.lastError, /fixture-fixture-denied/);
    assert.equal(await readFile(marker, "utf8"), "done\n");
    const firstRequests = local.requests.length;
    assert.equal(firstRequests, 2, "a deterministic SSE error must not trigger an unbounded retry");
    recovering = true;
    const next = await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.notEqual(next.runId, first.runId);
    assert.equal(local.requests.length, firstRequests + 1);
    const resumed = local.requests.at(-1);
    assert.equal(local.rawRequests.at(-1), local.rawRequests[firstRequests - 1]);
    assert.equal(resumed.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
    assert.deepEqual(
      resumed,
      local.requests[firstRequests - 1],
      "manual retry must replay the complete failed body, including system and tool definitions"
    );
    assert.ok(
      resumed.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "fixture-append-once"
      )
    );
    assert.equal(
      resumed.messages.filter(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(prompt)
      ).length,
      1
    );
    assert.equal(
      await readFile(marker, "utf8"),
      "done\n",
      "a successful side effect must remain single after recovery"
    );
    const toolRuns = completed.runtimeEvents.filter((event) => event.payload.type === "tool_execution_end");
    assert.equal(toolRuns.length, 1);
    assert.equal(completed.messages.at(-1).stopReason, "stop");
    assert.deepEqual(
      completed.events.filter((event) => event.type === "main.run_failed").map((event) => event.runId),
      [first.runId],
      "the task history retains only the original run's terminal error"
    );
    await receipt(local.root, "sse-after-effect", {
      failed: failed.task.status,
      recovered: completed.task.status,
      requests: local.requests.length,
      sideEffectLines: 1,
      completedToolExecutions: toolRuns.length,
      priorUserPromptCopies: 1
    });
  }
);

test(
  "real Main restores an accepted input after startup failed before saving any transcript",
  { timeout: 60_000 },
  async (t) => {
    const local = await fixture(t, ({ response }) => complete(response, "Recovered the original input."));
    const taskId = "startup-before-transcript";
    const prompt = `Original request with attachment:\n${"fixture attachment body\n".repeat(300)}`;
    await local.api("/api/tasks", { taskId, goal: "Original startup request" });
    const store = new LocalWorkspaceStore(local.workspaceRoot);
    await store.createRun(taskId, "failed-startup");
    await store.transitionTask(taskId, "running", { runId: "failed-startup" });
    await store.transitionTask(taskId, "failed", { runId: "failed-startup", reason: "fixture_startup_exit" });
    await saveMainInput(mainInputPath(local.workspaceRoot, taskId, "failed-startup"), {
      version: 1,
      prompt,
      submittedAt: Date.now()
    });
    await local.restart();
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    const users = local.requests.at(-1).messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0].content, prompt);
    assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
  }
);

test(
  "repeated manual continuation keeps one user turn and retains bounded retries",
  { timeout: 60_000 },
  async (t) => {
    let rejecting = true;
    const local = await fixture(
      t,
      ({ response }) => {
        if (!rejecting) return complete(response, "Manual continuation succeeded.");
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Synthetic transient service error" } }));
      },
      { retryBaseDelayMs: 1 }
    );
    const taskId = "repeated-continuation";
    await local.api("/api/tasks", { taskId, goal: "Keep this original request exactly once." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Keep this original request exactly once." });
    await local.settle(taskId, "failed");
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    await local.settle(taskId, "failed");
    assert.equal(local.requests.length, 12, "each invocation retains five bounded automatic retries");
    rejecting = false;
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.equal(completed.messages.filter((message) => message.role === "user").length, 1);
    for (const request of local.requests)
      assert.deepEqual(
        request.messages.filter((message) => message.role !== "system"),
        local.requests[0].messages.filter((message) => message.role !== "system")
      );
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "A separate follow-up." });
    const followUp = await local.settle(taskId, "completed");
    assert.equal(followUp.messages.filter((message) => message.role === "user").length, 2);
    assert.equal(local.requests.at(-1).messages.filter((message) => message.role === "user").length, 2);
  }
);

test(
  "real Main exposes a zero-output HTTP rejection and continues without inheriting that error",
  { timeout: 60_000 },
  async (t) => {
    let rejecting = true;
    const local = await fixture(t, ({ response }) => {
      if (!rejecting) return complete(response, "HTTP rejection recovered.");
      response.writeHead(400, { "content-type": "application/json", "x-request-id": "fixture-http-request" });
      response.end(
        JSON.stringify({ error: { message: "fixture-invalid-parameter", type: "invalid_request_error" } })
      );
    });
    const taskId = "http-rejection";
    await local.api("/api/tasks", { taskId, goal: "Exercise isolated provider rejection." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise isolated provider rejection." });
    const failed = await local.settle(taskId, "failed");
    assert.match(failed.task.lastError, /400|fixture-invalid-parameter/);
    assert.equal(local.requests.length, 1);
    rejecting = false;
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.equal(local.requests.length, 2);
    assert.deepEqual(local.requests[1], local.requests[0]);
    assert.equal(local.rawRequests[1], local.rawRequests[0]);
    assert.equal(completed.messages.at(-1).content.at(-1).text, "HTTP rejection recovered.");
    await receipt(local.root, "http-zero-output", {
      failed: failed.task.status,
      failedMessage: failed.task.lastError,
      recovered: completed.task.status,
      requests: local.requests.length
    });
  }
);

test(
  "real Main cancellation of a partial stream stays cancelled and can explicitly continue",
  { timeout: 60_000 },
  async (t) => {
    let held = false;
    let recovering = false;
    const local = await fixture(t, ({ response }) => {
      if (recovering) return complete(response, "Explicitly continued after cancellation.");
      response.writeHead(200, { "content-type": "text/event-stream" });
      stream(response, { role: "assistant", content: "Partial before cancellation." });
      held = true;
    });
    const taskId = "cancelled-stream";
    await local.api("/api/tasks", { taskId, goal: "Exercise isolated cancellation." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise isolated cancellation." });
    const until = Date.now() + 20_000;
    while (!held && Date.now() < until) await delay(20);
    assert.equal(held, true);
    await local.api(`/api/tasks/${taskId}/action`, { action: "cancel" });
    const cancelled = await local.settle(taskId, "cancelled");
    assert.equal(cancelled.events.filter((event) => event.type === "main.run_failed").length, 0);
    recovering = true;
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    const completed = await local.settle(taskId, "completed");
    assert.equal(local.requests.length, 2);
    assert.equal(completed.messages.at(-1).content.at(-1).text, "Explicitly continued after cancellation.");
    await receipt(local.root, "cancel-and-continue", {
      cancelled: cancelled.task.status,
      recovered: completed.task.status,
      requests: local.requests.length,
      falseFailureEvents: 0
    });
  }
);

test(
  "real Main completes after a transient HTTP service failure without persisting a false terminal failure",
  { timeout: 60_000 },
  async (t) => {
    const local = await fixture(t, ({ response, requests }) => {
      if (requests.length > 1) return complete(response, "Transient service failure recovered.");
      response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "fixture-service-temporarily-unavailable" } }));
    });
    const taskId = "transient-service";
    await local.api("/api/tasks", { taskId, goal: "Exercise existing bounded provider retry." });
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Exercise existing bounded provider retry." });
    const completed = await local.settle(taskId, "completed");
    assert.equal(local.requests.length, 2);
    assert.equal(completed.messages.at(-1).content.at(-1).text, "Transient service failure recovered.");
    assert.equal(completed.events.filter((event) => event.type === "main.run_failed").length, 0);
    assert.ok(completed.runtimeEvents.some((event) => event.payload.type === "auto_retry_start"));
    await receipt(local.root, "transient-service", {
      status: completed.task.status,
      requests: local.requests.length,
      falseFailureEvents: 0,
      existingProviderRetryObserved: true
    });
  }
);

for (const finalFails of [true, false]) {
  test(
    `real Main finish_task followed by ${finalFails ? "SSE failure remains recoverable" : "a final answer retains explicit completion"}`,
    { timeout: 60_000 },
    async (t) => {
      let recovering = false;
      const local = await fixture(t, ({ body, response }) => {
        const finishResult = body.messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "fixture-finish"
        );
        if (recovering || (finishResult && !finalFails))
          return complete(response, "Explicit finish result delivered.");
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream(response, { role: "assistant" });
        if (!finishResult) {
          stream(response, {
            tool_calls: [
              {
                index: 0,
                id: "fixture-finish",
                type: "function",
                function: {
                  name: "finish_task",
                  arguments: JSON.stringify({ summary: "Isolated fixture work verified." })
                }
              }
            ]
          });
          stream(response, {}, "tool_calls");
          response.end("data: [DONE]\n\n");
        } else
          response.end(
            `data: ${JSON.stringify({ error: { message: "fixture-final-delivery-denied" } })}\n\n`
          );
      });
      const taskId = finalFails ? "finish-before-error" : "finish-before-stop";
      await local.api("/api/tasks", {
        taskId,
        goal: "Verify explicit finish and final delivery consistency."
      });
      await local.api(`/api/tasks/${taskId}/run`, {
        prompt: "Verify explicit finish and final delivery consistency."
      });
      const terminal = await local.settle(taskId, finalFails ? "failed" : "completed");
      const finishCall = terminal.runtimeEvents.find(
        (event) =>
          event.payload.type === "tool_execution_end" && event.payload.toolCallId === "fixture-finish"
      );
      assert.ok(finishCall, "the real finish_task tool must execute");
      assert.equal(finishCall.payload.isError, false);
      assert.equal(finishCall.payload.result.details.completed, true);
      if (finalFails) {
        assert.match(terminal.task.lastError, /fixture-final-delivery-denied/);
        assert.equal(terminal.events.filter((event) => event.type === "main.run_failed").length, 1);
        recovering = true;
        await local.api(`/api/tasks/${taskId}/run`, { resume: true });
        const recovered = await local.settle(taskId, "completed");
        assert.equal(
          recovered.runtimeEvents.filter(
            (event) =>
              event.payload.type === "tool_execution_end" && event.payload.toolCallId === "fixture-finish"
          ).length,
          1,
          "manual recovery must retain rather than rerun finish_task"
        );
      } else assert.equal(terminal.task.completion.signal, "finish_task");
      await receipt(local.root, taskId, {
        terminalStatus: terminal.task.status,
        finalDeliveryFailed: finalFails,
        finishToolSucceeded: true,
        requests: local.requests.length,
        explicitCompletionRetained: !finalFails
      });
    }
  );
}

for (const action of ["cancel", "shutdown"]) {
  test(
    `real Main ${action} after finish_task settles its still-active final response truthfully`,
    { timeout: 60_000 },
    async (t) => {
      let finalResponseStarted = false;
      const local = await fixture(t, ({ body, response }) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream(response, { role: "assistant" });
        if (
          body.messages.some(
            (message) => message.role === "tool" && message.tool_call_id === "fixture-finish-held"
          )
        ) {
          finalResponseStarted = true;
          stream(response, { content: "Final response awaiting delivery." });
          return;
        }
        stream(response, {
          tool_calls: [
            {
              index: 0,
              id: "fixture-finish-held",
              type: "function",
              function: {
                name: "finish_task",
                arguments: JSON.stringify({
                  summary: "Isolated fixture work verified before final delivery."
                })
              }
            }
          ]
        });
        stream(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
      });
      const taskId = `finish-before-${action}`;
      await local.api("/api/tasks", { taskId, goal: "Exercise stop while final delivery is pending." });
      const run = await local.api(`/api/tasks/${taskId}/run`, {
        prompt: "Exercise stop while final delivery is pending."
      });
      const until = Date.now() + 20_000;
      while (!finalResponseStarted && Date.now() < until) await delay(20);
      assert.equal(finalResponseStarted, true);
      const before = await local.api(`/api/tasks/${taskId}`);
      assert.equal(before.runtime.active, true);
      assert.equal(before.task.completion.signal, "finish_task");
      let status;
      if (action === "cancel") {
        await local.api(`/api/tasks/${taskId}/action`, { action: "cancel" });
        status = (await local.settle(taskId, "cancelled")).task.status;
      } else {
        const exited = once(local.child, "exit");
        local.child.kill("SIGTERM");
        await exited;
        // The resident Main is not a child of the backend: the shutdown ends
        // the backend only, and the still-active final response keeps the
        // provisional finish_task completion it recorded.
        const stored = JSON.parse(await readFile(join(local.workspaceRoot, taskId, "task.json"), "utf8"));
        assert.equal(stored.status, "completed");
        assert.equal(stored.completion.signal, "finish_task");
        assert.equal(stored.activeRunId, run.runId);
        const record = JSON.parse(
          await readFile(
            join(local.workspaceRoot, taskId, "runs", run.runId, "agents", "main", "process.json"),
            "utf8"
          )
        );
        assert.equal(processAlive(record.pid), true, "the resident Main survives the backend shutdown");
        status = stored.status;
      }
      await receipt(local.root, taskId, {
        action,
        status,
        stillActiveBeforeStop: true,
        finishTaskHadCompleted: true
      });
    }
  );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

test(
  "real Pi: SIGKILL immediately after acknowledging wait_for_subagents receipts preserves results exactly once",
  { timeout: 60_000 },
  async (t) => {
    let runId = "";
    let step2Reached = false;
    let releaseStep2;
    const step2Held = new Promise((resolve) => {
      releaseStep2 = resolve;
    });
    let killed = false;
    const local = await fixture(t, async ({ body, response }) => {
      if (!killed && !body.messages.some((m) => m.role === "tool")) {
        const taskId = "wait-receipt-sigkill";
        if (!runId) {
          runId = JSON.parse(
            await readFile(join(local.workspaceRoot, taskId, "task.json"), "utf8")
          ).activeRunId;
        }
        const scheduler = new DurableScheduler(
          join(local.workspaceRoot, taskId, "runs", runId, "queue.json")
        );
        const inbox = new InboxStore(
          join(local.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
        );
        const now = new Date().toISOString();
        const leaseExpiry = new Date(Date.now() + 200).toISOString();
        const claimedLeases = [];
        for (const [stepId, messageId, marker] of [
          ["sub-wait-a", "cb-wait-a", "SUBAGENT_UNIQUE_MARKER_A"],
          ["sub-wait-b", "cb-wait-b", "SUBAGENT_UNIQUE_MARKER_B"]
        ]) {
          await scheduler.enqueue({
            stepId,
            taskId,
            runId,
            agentId: `agent-${stepId}`,
            importance: "normal",
            payload: { task: "inspect" }
          });
          const leased = await scheduler.claim("worker");
          claimedLeases.push([stepId, leased.lease.token]);
          await inbox.enqueue({
            messageId,
            recipientAgentId: "main",
            callId: stepId,
            kind: "callback",
            eventId: `ev-${messageId}`,
            priority: 1,
            state: "leased",
            lease: { consumerId: "fixture-pre-wait", expiresAt: leaseExpiry },
            payload: { callId: stepId, response: marker },
            createdAt: now
          });
        }
        // Complete the two subagent calls in queue.json after the short pre-wait lease expires
        // (without touching inbox-store.json), so wait_for_subagents deterministically claims both
        // callbacks into details._coworkInboxMessages.
        void delay(300).then(async () => {
          for (const [stepId, token] of claimedLeases) await scheduler.complete(stepId, token);
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream(response, { role: "assistant" });
        stream(response, {
          tool_calls: [
            {
              index: 0,
              id: "call_wait_receipts",
              type: "function",
              function: {
                name: "wait_for_subagents",
                arguments: JSON.stringify({ callIds: ["sub-wait-a", "sub-wait-b"], timeoutMs: 4000 })
              }
            }
          ]
        });
        stream(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
        return;
      }
      if (!killed) {
        step2Reached = true;
        await step2Held;
        response.destroy();
        return;
      }
      return complete(response, "Resumed cleanly after wait receipt SIGKILL.");
    });

    const taskId = "wait-receipt-sigkill";
    await local.api("/api/tasks", { taskId, goal: "Wait for two callbacks." });
    const started = await local.api(`/api/tasks/${taskId}/run`, { prompt: "Wait for two callbacks." });
    runId = started.runId;

    const until = Date.now() + 25_000;
    while (!step2Reached && Date.now() < until) await delay(20);
    assert.equal(step2Reached, true, "Pi must reach the post-wait model request");

    const inbox = new InboxStore(
      join(local.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
    );
    const msgsBeforeKill = await inbox.list("main");
    assert.equal(msgsBeforeKill.find((m) => m.messageId === "cb-wait-a")?.state, "consumed");
    assert.equal(msgsBeforeKill.find((m) => m.messageId === "cb-wait-b")?.state, "consumed");

    // Pre-ack forced flush must have already persisted both wait receipts to messages.json BEFORE SIGKILL.
    const persistedBeforeKill = await readFile(
      join(local.workspaceRoot, taskId, "agents", "main", "context", "messages.json"),
      "utf8"
    );
    assert.match(persistedBeforeKill, /SUBAGENT_UNIQUE_MARKER_A/);
    assert.match(persistedBeforeKill, /SUBAGENT_UNIQUE_MARKER_B/);

    const proc = JSON.parse(
      await readFile(
        join(local.workspaceRoot, taskId, "runs", runId, "agents", "main", "process.json"),
        "utf8"
      )
    );
    killed = true;
    process.kill(proc.pid, "SIGKILL");
    releaseStep2();
    await local.settle(taskId, "failed");

    // Resume and then send one follow-up turn so Pi rebuilds live context from its session.
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    await local.settle(taskId, "completed");
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Confirm the two callback markers." });
    await local.settle(taskId, "completed");

    const finalReq = JSON.stringify(local.requests.at(-1).messages);
    assert.equal((finalReq.match(/SUBAGENT_UNIQUE_MARKER_A/g) ?? []).length, 1);
    assert.equal((finalReq.match(/SUBAGENT_UNIQUE_MARKER_B/g) ?? []).length, 1);
  }
);

test(
  "real Pi: missing Pi transcript recovers original context from compact messages.json on --continue",
  { timeout: 60_000 },
  async (t) => {
    let firstHeld = false;
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let recoveredPhase = false;
    const local = await fixture(t, async ({ response }) => {
      if (!recoveredPhase) {
        firstHeld = true;
        await firstGate;
        response.destroy();
        return;
      }
      return complete(response, "Restored from compact messages.json.");
    });

    const taskId = "compact-restore-unflushed";
    const uniquePrompt = "COMPACT_RESTORE_UNIQUE_PROMPT_9481";
    await local.api("/api/tasks", { taskId, goal: uniquePrompt });
    const started = await local.api(`/api/tasks/${taskId}/run`, { prompt: uniquePrompt });

    const until = Date.now() + 20_000;
    while (!firstHeld && Date.now() < until) await delay(20);
    assert.equal(firstHeld, true);

    const messagesPath = join(local.workspaceRoot, taskId, "agents", "main", "context", "messages.json");
    const rawCompact = await readFile(messagesPath, "utf8");
    assert.match(rawCompact, new RegExp(uniquePrompt));
    assert.ok(!rawCompact.includes("\n  "), "messages.json must be compact single-line JSON");

    const proc = JSON.parse(
      await readFile(
        join(local.workspaceRoot, taskId, "runs", started.runId, "agents", "main", "process.json"),
        "utf8"
      )
    );
    recoveredPhase = true;
    process.kill(proc.pid, "SIGKILL");
    releaseFirst();
    await local.settle(taskId, "failed");

    // Actively construct a workspace with valid compact messages.json and NO usable Pi jsonl transcript,
    // and clear request-retry.json so --continue must rebuild from restoreUnflushedTaskSession().
    const piDir = join(local.workspaceRoot, taskId, "sessions", "main", "pi");
    for (const file of await readdir(piDir)) {
      if (file.endsWith(".jsonl")) await rm(join(piDir, file), { force: true });
    }
    const sessionsBefore = await SessionManager.listAll(piDir);
    assert.equal(
      sessionsBefore.some((s) => s.messageCount > 0),
      false,
      "fixture must have no usable Pi transcript before --continue"
    );
    await new MainRequestStore(mainRequestPath(local.workspaceRoot, taskId), taskId).clear();

    const requestsBeforeContinue = local.requests.length;
    await local.api(`/api/tasks/${taskId}/run`, { resume: true });
    await local.settle(taskId, "completed");

    assert.equal(local.requests.length, requestsBeforeContinue + 1);
    const continuedBody = JSON.stringify(local.requests.at(-1).messages);
    assert.match(continuedBody, new RegExp(uniquePrompt));
    const sessionsAfter = await SessionManager.listAll(piDir);
    assert.equal(
      sessionsAfter.some((s) => s.messageCount > 0),
      true,
      "restoreUnflushedTaskSession must recreate a Pi transcript from compact messages.json"
    );
  }
);

test(
  "real Pi: SIGKILL during a throttled intermediate tool step preserves loadDetail, SSE after cursor, materialized v1 retry state, and follow-up continuity",
  { timeout: 60_000 },
  async (t) => {
    let phase = "step1";
    let tool2Marker = "";
    const local = await fixture(t, async ({ body, response }) => {
      const toolCount = body.messages.filter((m) => m.role === "tool").length;
      if (phase === "step1" && toolCount === 0) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream(response, { role: "assistant" });
        stream(response, {
          tool_calls: [
            {
              index: 0,
              id: "call_step1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "printf 'STEP1_MARKER\\n'" }) }
            }
          ]
        });
        stream(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
        return;
      }
      if (phase === "step1" && toolCount === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream(response, { role: "assistant", content: "PARTIAL_MID_TOOL_TEXT" });
        stream(response, {
          tool_calls: [
            {
              index: 0,
              id: "call_step2_hold",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: `printf 'TOOL2_RUNNING\\n' > ${shellQuote(tool2Marker)}; sleep 30`
                })
              }
            }
          ]
        });
        stream(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
        return;
      }
      return complete(response, "FOLLOW_UP_CONTINUITY_OK");
    });

    const taskId = "throttled-mid-tool-sigkill";
    tool2Marker = join(local.root, "tool2-running.txt");
    await local.api("/api/tasks", { taskId, goal: "Run two steps and survive SIGKILL." });
    const started = await local.api(`/api/tasks/${taskId}/run`, {
      prompt: "Run two steps and survive SIGKILL."
    });

    // Wait until tool 2 is actively running (so step 2's settle('completed') has written the sidecar
    // and step 3's begin() has NOT started yet).
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const ready = await readFile(tool2Marker, "utf8").catch(() => "");
      if (ready.includes("TOOL2_RUNNING")) break;
      await delay(20);
    }
    assert.match(await readFile(tool2Marker, "utf8"), /TOOL2_RUNNING/);

    // Verify BEFORE SIGKILL:
    // 1. messages.json was throttled on step 2 (< 5s, < 10 entries) and does NOT yet contain STEP1_MARKER.
    // 2. request-retry.state.json ACTUALLY EXISTS with state='completed' while base file is still 'pending'.
    const rawMessagesMidTurn = await readFile(
      join(local.workspaceRoot, taskId, "agents", "main", "context", "messages.json"),
      "utf8"
    );
    assert.doesNotMatch(rawMessagesMidTurn, /STEP1_MARKER/);
    const statePath = mainRequestStatePath(local.workspaceRoot, taskId);
    const reqPath = mainRequestPath(local.workspaceRoot, taskId);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).state, "completed");
    assert.equal(JSON.parse(await readFile(reqPath, "utf8")).state, "pending");

    const proc = JSON.parse(
      await readFile(
        join(local.workspaceRoot, taskId, "runs", started.runId, "agents", "main", "process.json"),
        "utf8"
      )
    );
    phase = "followup";
    process.kill(proc.pid, "SIGKILL");
    const failed = await local.settle(taskId, "failed");

    // 1. Backend loadDetail() retains original user prompt, step 1 tool output, and partial text.
    const detailJson = JSON.stringify({ messages: failed.messages, runtimeEvents: failed.runtimeEvents });
    assert.match(detailJson, /Run two steps and survive SIGKILL/);
    assert.match(detailJson, /STEP1_MARKER/);
    assert.match(detailJson, /PARTIAL_MID_TOOL_TEXT/);

    // 2. Backend exit settlement materialized the sidecar into native v1 request-retry.json (state='completed') and cleared sidecar.
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(reqPath, "utf8")).state, "completed");
    const materialized = await new MainRequestStore(reqPath, taskId).read();
    assert.equal(materialized?.state, "completed");

    // 3. SSE replay with `after` cursor yields contiguous runtime event indices without gaps or duplicates.
    const runtimeIndex = (eventId) => {
      const match = String(eventId ?? "").match(/-(\d+)$/);
      return match ? Number(match[1]) : undefined;
    };
    const allIndices = failed.runtimeEvents
      .map((e) => runtimeIndex(e.eventId))
      .filter((n) => Number.isInteger(n));
    assert.ok(allIndices.length >= 2, JSON.stringify(failed.runtimeEvents.map((e) => e.eventId)));
    const pivot = allIndices[Math.floor(allIndices.length / 2)];
    const expectedTail = allIndices.filter((n) => n >= pivot);
    const sseController = new AbortController();
    const sseRes = await fetch(`${local.base}/api/tasks/${taskId}/stream?after=${pivot}`, {
      signal: sseController.signal
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    let sseBuf = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const nextChunk = await Promise.race([
        reader.read(),
        delay(200).then(() => ({ done: true, value: undefined }))
      ]);
      if (nextChunk.value) sseBuf += Buffer.from(nextChunk.value).toString("utf8");
      if (nextChunk.done) break;
    }
    sseController.abort();
    const replayedIndices = [...sseBuf.matchAll(/^id: runtime-.*-(\d+)$/gm)].map((m) => Number(m[1]));
    assert.ok(replayedIndices.length > 0, `SSE stream?after=${pivot} returned no runtime events: ${sseBuf}`);
    assert.equal(replayedIndices[0], pivot, `SSE after=${pivot} must start at pivot`);
    for (let i = 1; i < replayedIndices.length; i++) {
      assert.ok(
        replayedIndices[i] > replayedIndices[i - 1],
        `SSE indices must be strictly increasing without duplicates: ${JSON.stringify(replayedIndices)}`
      );
    }
    assert.deepEqual(replayedIndices, expectedTail);

    // 4. Follow-up message continues seamlessly and syncs messages.json.
    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Continue after crash." });
    await local.settle(taskId, "completed");
    const syncedMessages = await readFile(
      join(local.workspaceRoot, taskId, "agents", "main", "context", "messages.json"),
      "utf8"
    );
    assert.match(syncedMessages, /STEP1_MARKER/);
    assert.match(syncedMessages, /FOLLOW_UP_CONTINUITY_OK/);
  }
);

test(
  "real Pi: startInbox() on a two-branch persisted session consumes active-branch via messages.json and other-branch via persisted jsonl without mixing branches",
  { timeout: 60_000 },
  async (t) => {
    const local = await fixture(t, async ({ response }) => complete(response, "BRANCH_RESTART_OK"));
    const taskId = "two-branch-start-inbox";
    const runId = "main-branch-run";
    await local.api("/api/tasks", { taskId, goal: "Two-branch inbox recovery." });
    const wsStore = new LocalWorkspaceStore(local.workspaceRoot);
    await wsStore.createRun(taskId, runId);
    await wsStore.updateTask(taskId, { activeRunId: runId });
    await wsStore.transitionTask(taskId, "running", { runId });
    await wsStore.transitionTask(taskId, "waiting", { runId });

    const piDir = join(local.workspaceRoot, taskId, "sessions", "main", "pi");
    await mkdir(piDir, { recursive: true });
    const createdDetail = await local.api(`/api/tasks/${taskId}`);
    const sessionCwd = await realpath(createdDetail.projectDirectory ?? local.workspaceRoot);
    const session = SessionManager.create(sessionCwd, piDir);
    const rootId = session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "ROOT_BRANCH_PROMPT" }],
      timestamp: Date.now()
    });
    session.appendCustomMessageEntry("cowork-callback", "OTHER_BRANCH_CALLBACK_TEXT", true, {
      _coworkInbox: { taskId, runId, messageId: "other-branch-cb" }
    });
    session.branch(rootId);
    session.appendCustomMessageEntry("cowork-callback", "ACTIVE_BRANCH_CALLBACK_TEXT", true, {
      _coworkInbox: { taskId, runId, messageId: "active-branch-cb" }
    });

    const inbox = new InboxStore(
      join(local.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
    );
    const now = new Date().toISOString();
    for (const messageId of ["active-branch-cb", "other-branch-cb"]) {
      await inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        callId: `call-${messageId}`,
        kind: "callback",
        eventId: `ev-${messageId}`,
        priority: 1,
        state: "ready",
        payload: { callId: `call-${messageId}`, response: messageId },
        createdAt: now
      });
    }
    await saveMainInput(mainInputPath(local.workspaceRoot, taskId, runId), {
      version: 1,
      prompt: "ROOT_BRANCH_PROMPT",
      submittedAt: Date.now(),
      taskId,
      runId,
      messageId: "root-input",
      source: "composer"
    });

    await local.api(`/api/tasks/${taskId}/run`, { prompt: "Follow up after branch restart." });
    await local.settle(taskId, "completed");

    const afterInbox = await inbox.list("main");
    assert.equal(afterInbox.find((m) => m.messageId === "active-branch-cb")?.state, "consumed");
    assert.equal(afterInbox.find((m) => m.messageId === "other-branch-cb")?.state, "consumed");
    const savedMessages = await readFile(
      join(local.workspaceRoot, taskId, "agents", "main", "context", "messages.json"),
      "utf8"
    );
    assert.match(savedMessages, /ACTIVE_BRANCH_CALLBACK_TEXT/);
    assert.doesNotMatch(savedMessages, /OTHER_BRANCH_CALLBACK_TEXT/);
  }
);

test(
  "real Pi standalone --print CLI launcher materializes request sidecar when Pi receives SIGKILL mid-tool",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-cli-sigkill-"));
    const workspaceRoot = join(root, "workspace");
    const projectDir = join(root, "project");
    const piAgentDir = join(root, "pi-agent");
    const pidFile = join(root, "pi-child.pid");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(piAgentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
    );

    const provider = createServer(async (request, response) => {
      await readFixtureRequestBody(request);
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      stream(response, { role: "assistant" });
      stream(response, {
        tool_calls: [
          {
            index: 0,
            id: "call_cli_hold",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: `printf '%s\\n' "$PPID" > ${shellQuote(pidFile)}; sleep 30`
              })
            }
          }
        ]
      });
      stream(response, {}, "tool_calls");
      response.end("data: [DONE]\n\n");
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: "fixture-key",
        model: "fixture-model",
        workspaceRoot
      })
    );

    const taskId = "cli-sigkill-materialize";
    const launcher = spawn(
      process.execPath,
      [resolve("scripts/start-pi.mjs"), "--print", "Run a tool and wait."],
      {
        cwd: projectDir,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          COWORK_CONFIG: configPath,
          COWORK_HARNESS_ROOT: process.cwd(),
          COWORK_WORKSPACE: workspaceRoot,
          COWORK_TASK_ID: taskId,
          COWORK_PROJECT_DIR: projectDir,
          PI_CODING_AGENT_DIR: piAgentDir
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stderr = "";
    launcher.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    t.after(async () => {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
      provider.closeAllConnections();
      await new Promise((done) => provider.close(done));
      await rm(root, { recursive: true, force: true });
    });

    const until = Date.now() + 25_000;
    let piPid = 0;
    while (Date.now() < until) {
      const raw = await readFile(pidFile, "utf8").catch(() => "");
      const parsed = Number(raw.trim());
      if (Number.isInteger(parsed) && parsed > 0) {
        piPid = parsed;
        break;
      }
      await delay(25);
    }
    assert.ok(piPid > 0, `Pi child did not start tool execution; stderr=${stderr}`);

    const reqPath = mainRequestPath(workspaceRoot, taskId);
    const statePath = mainRequestStatePath(workspaceRoot, taskId);
    assert.equal(JSON.parse(await readFile(reqPath, "utf8")).state, "pending");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).state, "completed");

    const launcherClosed = once(launcher, "close");
    process.kill(piPid, "SIGKILL");
    const [exitCode] = await launcherClosed;
    assert.notEqual(exitCode, 0, "standalone CLI launcher must report non-zero exit after child SIGKILL");

    await assert.rejects(readFile(statePath), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(reqPath, "utf8")).state, "completed");
    const materialized = await new MainRequestStore(reqPath, taskId).read();
    assert.equal(materialized?.state, "completed");
  }
);
