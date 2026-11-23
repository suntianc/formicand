import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { settledRuntimeEvents, viewRuntimeEvent } from "../dist/src/runtime/conversation-history.js";
import { runtimeLogMarks } from "../web/assets/conversation.js";
import { reconcileParts, reconcileRange } from "../web/assets/ui/reconcile.js";
import { fingerprint } from "../web/assets/ui/fingerprint.js";

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
    customType: "cowork-callback",
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
        customType: "cowork-callback",
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

test("fingerprint produces compact stable hashes for nested values", () => {
  const a = { list: [1, "two", { nested: true, empty: null }] };
  const b = { list: [1, "two", { nested: true, empty: null }] };
  const c = { list: [1, "two", { nested: false, empty: null }] };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
  assert.ok(fingerprint(a).length < 40);
});
