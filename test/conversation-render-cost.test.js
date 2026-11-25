import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { settledRuntimeEvents, viewRuntimeEvent } from "../dist/src/runtime/conversation-history.js";
import { extractToolCallDetail } from "../dist/src/runtime/tool-event-summary.js";
import { runtimeLogMarks } from "../web/assets/conversation.js";
import { reconcileParts, reconcileRange } from "../web/assets/ui/reconcile.js";
import { fingerprint } from "../web/assets/ui/fingerprint.js";
import { startDashboard } from "./dashboard-fixture.mjs";

const runtime = (payload) => ({ eventId: "runtime-r-1", type: "runtime_event", runId: "r", payload });

test("the conversation view drops the system prompt and agent_end bodies, nothing else", () => {
  const prompt = "x".repeat(10_000);
  assert.deepEqual(
    viewRuntimeEvent(
      runtime({ type: "message_start", message: { role: "system", content: prompt, timestamp: 5 } })
    ),
    runtime({ type: "message_start", message: { role: "system", timestamp: 5 } })
  );
  assert.deepEqual(
    viewRuntimeEvent(runtime({ type: "agent_end", messages: [{ role: "system", content: prompt }] })),
    runtime({ type: "agent_end" })
  );
  for (const record of [
    runtime({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }),
    runtime({ type: "turn_end", message: { role: "assistant" } }),
    { type: "user.interjected", payload: { message: "hi" } }
  ])
    assert.equal(viewRuntimeEvent(record), record);
});

test("a callback's start keeps only what identifies it; its end keeps the report", () => {
  const message = {
    role: "custom",
    customType: "formicand-callback",
    content: "report".repeat(1000),
    details: { callId: "call-1", status: "completed", review: "long".repeat(1000) },
    timestamp: 3
  };
  assert.deepEqual(
    viewRuntimeEvent(runtime({ type: "message_start", message })),
    runtime({
      type: "message_start",
      message: {
        role: "custom",
        customType: "formicand-callback",
        timestamp: 3,
        details: { callId: "call-1", status: "completed" }
      }
    })
  );
  const end = runtime({ type: "message_end", message });
  assert.equal(viewRuntimeEvent(end), end);
});

test("patching from a later part leaves the earlier children untouched", () => {
  const { document } = parseHTML("<!doctype html><html><body><div id=list></div></body></html>");
  const list = document.getElementById("list");
  const first = reconcileParts(list, ['<p data-view-key="a">a</p>', '<p data-view-key="b">b</p><p>tail</p>']);
  assert.deepEqual(first, [1, 2]);
  const kept = list.firstChild;
  kept.setAttribute("data-mark", "kept");
  const second = reconcileParts(list, ['<p data-view-key="b">b2</p>', "<p>new tail</p>"], list.childNodes[1]);
  assert.deepEqual(second, [1, 1]);
  assert.equal(list.firstChild, kept);
  assert.equal(kept.getAttribute("data-mark"), "kept");
  assert.deepEqual(
    [...list.childNodes].map((node) => node.textContent),
    ["a", "b2", "new tail"]
  );
});

test("viewRuntimeEvent drops assistant start bodies, provider metadata and update snapshots", () => {
  const start = runtime({
    type: "message_start",
    message: {
      role: "assistant",
      id: "m1",
      timestamp: 10,
      content: [{ type: "text", text: "heavy".repeat(200) }],
      usage: { input: 100, output: 20 },
      provider: "openai",
      model: "gpt-5",
      api: "responses"
    }
  });
  assert.deepEqual(viewRuntimeEvent(start), {
    ...start,
    payload: { type: "message_start", message: { role: "assistant", id: "m1", timestamp: 10 } }
  });

  const end = runtime({
    type: "message_end",
    message: {
      role: "assistant",
      timestamp: 11,
      stopReason: "stop",
      usage: { totalTokens: 120 },
      provider: "openai",
      model: "gpt-5",
      content: [{ type: "text", text: "ok", textSignature: "sig" }]
    }
  });
  assert.deepEqual(viewRuntimeEvent(end), {
    ...end,
    payload: {
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 11,
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }]
      }
    }
  });

  const update = runtime({
    type: "message_update",
    usage: { totalTokens: 50 },
    message: { role: "assistant", content: [{ type: "text", text: "growing" }] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "g",
      partial: { role: "assistant", content: [{ type: "text", text: "growing" }] }
    }
  });
  assert.deepEqual(viewRuntimeEvent(update), {
    ...update,
    payload: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "g" }
    }
  });
});

test("settledRuntimeEvents drops unused extension and start-only records while keeping run watermarks", () => {
  const rec = (index, payload) => ({
    eventId: `runtime-r1-${index}`,
    type: "runtime_event",
    runId: "r1",
    agentId: "main",
    payload
  });
  const records = [
    rec(0, { type: "message_start", message: { role: "system", content: "prompt" } }),
    rec(1, { type: "extension_ui_request", method: "notify", message: "hello" }),
    rec(2, { type: "message_start", message: { role: "toolResult", toolCallId: "c1", content: "out" } }),
    rec(3, { type: "message_end", message: { role: "toolResult", toolCallId: "c1", content: "out" } }),
    rec(4, { type: "extension_ui_request", method: "notify", message: "trailing watermark" })
  ];
  const kept = settledRuntimeEvents(records);
  assert.deepEqual(
    kept.map((entry) => entry.eventId),
    ["runtime-r1-3", "runtime-r1-4"]
  );
  assert.equal(runtimeLogMarks(kept).get("r1"), 4);
});

test("reconcileRange patches only the requested slice and leaves siblings untouched", () => {
  const { document } = parseHTML("<!doctype html><html><body><div id=list></div></body></html>");
  const list = document.getElementById("list");
  reconcileParts(list, [
    '<p data-view-key="a">a</p>',
    '<p data-view-key="b">b</p><p>b-extra</p>',
    '<p data-view-key="c">c</p>'
  ]);
  const first = list.childNodes[0];
  const last = list.childNodes[3];
  const patched = reconcileRange(list, '<p data-view-key="b">b2</p>', 1, 2);
  assert.equal(patched.count, 1);
  assert.equal(list.childNodes[0], first);
  assert.equal(list.childNodes[2], last);
  assert.deepEqual(
    [...list.childNodes].map((node) => node.textContent),
    ["a", "b2", "c"]
  );
});

test("reconcile preserves hydrated src on img[data-upload-src] until its uploadId changes", () => {
  const { document } = parseHTML("<!doctype html><html><body><div id=list></div></body></html>");
  const list = document.getElementById("list");
  reconcileParts(list, ['<article data-view-key="u1"><img data-upload-src="upload-a" alt="" /></article>']);
  const image = list.querySelector("img");
  image.setAttribute("src", "blob:http://127.0.0.1/upload-a");
  image.setAttribute("data-upload-loaded", "upload-a");

  reconcileRange(
    list,
    '<article data-view-key="u1"><img data-upload-src="upload-a" alt="" /><span>after</span></article>',
    0,
    1
  );
  assert.equal(list.querySelector("img"), image);
  assert.equal(image.getAttribute("src"), "blob:http://127.0.0.1/upload-a");
  assert.equal(image.getAttribute("data-upload-loaded"), "upload-a");

  reconcileRange(
    list,
    '<article data-view-key="u1"><img data-upload-src="upload-b" alt="" /></article>',
    0,
    1
  );
  assert.equal(image.getAttribute("data-upload-src"), "upload-b");
  assert.equal(image.getAttribute("src"), null);
  assert.equal(image.getAttribute("data-upload-loaded"), null);
});

test("fingerprint produces compact stable hashes for nested values", () => {
  const a = { list: [1, "two", { nested: true, empty: null }] };
  const b = { list: [1, "two", { nested: true, empty: null }] };
  const c = { list: [1, "two", { nested: false, empty: null }] };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
  assert.ok(fingerprint(a).length < 40);
});

test("viewRuntimeEvent summarizes bulky tool args and outputs while preserving lifecycle and failure evidence", () => {
  const hugeBody = "line\n".repeat(4000);
  const start = runtime({
    type: "tool_execution_start",
    toolCallId: "write-1",
    toolName: "write",
    args: { path: "src/app.ts", content: hugeBody }
  });
  const slimStart = viewRuntimeEvent(start);
  assert.equal(slimStart.payload.detailOmitted, true);
  assert.deepEqual(slimStart.payload.args, { path: "src/app.ts" });

  const endOk = runtime({
    type: "tool_execution_end",
    toolCallId: "read-1",
    toolName: "read",
    isError: false,
    result: {
      content: [
        { type: "text", text: "preview" },
        { type: "image", mimeType: "image/png", data: "A".repeat(4000) }
      ],
      details: {
        callId: "sub-1",
        accepted: true,
        archivedOutput: { content: [{ type: "text", text: hugeBody }] }
      }
    }
  });
  const slimEndOk = viewRuntimeEvent(endOk);
  assert.equal(slimEndOk.payload.detailOmitted, true);
  assert.equal(slimEndOk.payload.result.details.callId, "sub-1");
  assert.equal(slimEndOk.payload.result.details.accepted, true);
  assert.equal("archivedOutput" in slimEndOk.payload.result.details, false);
  assert.equal(slimEndOk.payload.result.content, undefined);

  const endErr = runtime({
    type: "tool_execution_end",
    toolCallId: "bash-1",
    toolName: "bash",
    isError: true,
    result: {
      content: [
        { type: "text", text: `${"noise\n".repeat(300)}ModuleNotFoundError: No module named 'demo_pkg'\n` }
      ],
      details: { errorCode: "exit_1", dispatchStatus: "unknown" }
    }
  });
  const slimEndErr = viewRuntimeEvent(endErr);
  assert.equal(slimEndErr.payload.detailOmitted, true);
  assert.equal(slimEndErr.payload.result.details.errorCode, "exit_1");
  assert.equal(slimEndErr.payload.result.details.dispatchStatus, "unknown");
  assert.match(slimEndErr.payload.result.content[0].text, /ModuleNotFoundError: No module named 'demo_pkg'/);

  const detail = extractToolCallDetail([start, endOk], "read-1");
  assert.equal(detail.toolCallId, "read-1");
  assert.equal(detail.completed, true);
  assert.equal(detail.result.content[0].text, hugeBody);
});

test("GET /api/tasks/:taskId omits bulky tool bodies and /tool-call fetches full details on demand", async () => {
  const local = await startDashboard();
  try {
    const taskId = "tool-detail-http";
    const runId = "run-1";
    const created = await fetch(`${local.base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, goal: "按需读取工具详情", projectId: local.projectId })
    });
    assert.equal(created.status, 201);
    const runDir = join(local.workspaceRoot, taskId, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), JSON.stringify({ createdAt: "2026-11-23T00:00:00Z" }));
    const bigContent = "alpha-line\n".repeat(2000);
    const bigOutput = "beta-output\n".repeat(2000);
    const logLines = [
      { type: "turn_start" },
      { type: "message_start", message: { role: "user", content: "检查文件", timestamp: 1 } },
      { type: "message_end", message: { role: "user", content: "检查文件", timestamp: 1 } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 2,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call-big",
              name: "write",
              arguments: { path: "big.txt", content: bigContent }
            }
          ]
        }
      },
      {
        type: "tool_execution_start",
        toolCallId: "call-big",
        toolName: "write",
        args: { path: "big.txt", content: bigContent }
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-big",
        toolName: "write",
        isError: false,
        result: {
          content: [{ type: "text", text: "preview only" }],
          details: {
            archivedOutput: {
              content: [
                { type: "text", text: bigOutput },
                { type: "image", mimeType: "image/png", data: "B".repeat(2048) }
              ]
            }
          }
        }
      },
      { type: "turn_end", message: { role: "assistant", timestamp: 3, stopReason: "stop" } }
    ];
    await writeFile(join(runDir, "runtime-output.log"), `${logLines.map(JSON.stringify).join("\n")}\n`);

    const detailRes = await fetch(`${local.base}/api/tasks/${taskId}`);
    assert.equal(detailRes.status, 200);
    const detailText = await detailRes.text();
    assert.equal(detailText.includes("alpha-line\nalpha-line"), false, "task detail omits bulky args");
    assert.equal(detailText.includes("beta-output\nbeta-output"), false, "task detail omits bulky output");
    const detailBody = JSON.parse(detailText);
    const endEvent = detailBody.runtimeEvents.find((entry) => entry.payload?.type === "tool_execution_end");
    assert.equal(endEvent.payload.detailOmitted, true);

    const toolRes = await fetch(`${local.base}/api/tasks/${taskId}/tool-call?callId=call-big&runId=${runId}`);
    assert.equal(toolRes.status, 200);
    const toolBody = await toolRes.json();
    assert.equal(toolBody.toolCallId, "call-big");
    assert.equal(toolBody.arguments.path, "big.txt");
    assert.equal(toolBody.arguments.content, bigContent);
    assert.equal(toolBody.result.content[0].text, bigOutput);
    assert.match(toolBody.result.content[1].data, /图片二进制内容，2048 个编码字符/);

    const missingRes = await fetch(`${local.base}/api/tasks/${taskId}/tool-call?callId=nope`);
    assert.equal(missingRes.status, 404);
    const badRes = await fetch(`${local.base}/api/tasks/${taskId}/tool-call?callId=`);
    assert.equal(badRes.status, 400);
  } finally {
    await local.stop();
  }
});
