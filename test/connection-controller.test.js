import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectionController } from "../web/assets/controllers/connection-controller.js";

function fixture(t) {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget();
  const document = (globalThis.document = new EventTarget());
  const state = { selected: null, tasks: [] };
  const detailReads = [];
  const controller = createConnectionController({
    state,
    loadDetail: (id) => detailReads.push(id)
  });
  t.after(() => {
    controller.dispose();
    globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
  });
  return { controller, state, detailReads, document };
}

test("only the selected open SSE connection slows fallback polling, and disconnect requests recovery", (t) => {
  const f = fixture(t);
  const streams = [];
  window.EventSource = class {
    constructor() {
      streams.push(this);
    }
    close() {}
  };
  const previousSource = globalThis.EventSource;
  globalThis.EventSource = window.EventSource;
  t.after(() => {
    if (previousSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousSource;
  });
  f.state.selected = "a";
  f.state.tasks = ["a", "b"].map((taskId) => ({ taskId, status: "running", activeRunId: taskId }));
  f.controller.connect("a");
  assert.equal(f.controller.isStreaming("a"), false);
  streams[0].onopen();
  assert.equal(f.controller.isStreaming("a"), true);
  f.state.selected = "b";
  f.controller.connect("b");
  const latest = streams.at(-1);
  latest.onopen();
  streams[0].onerror();
  assert.equal(f.controller.isStreaming("b"), true, "an old stream cannot change the new connection");
  assert.deepEqual(f.detailReads, []);
  latest.onerror();
  assert.equal(f.controller.isStreaming("b"), false);
  assert.deepEqual(f.detailReads, ["b"]);
  f.controller.connect("b");
  streams.at(-1).onopen();
  f.controller.close();
  assert.equal(f.controller.isStreaming("b"), false);
});

test("batches pure runtime_event records into streamRecords and resets on non-runtime or close", (t) => {
  const f = fixture(t);
  const calls = [];
  const frames = [];
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancel;
  });

  let emitRecord;
  const controller = createConnectionController({
    state: f.state,
    loadDetail: (id) => f.detailReads.push(id),
    renderRunState: () => {},
    renderConversation: (messages, task, options) => calls.push({ messages, task, options }),
    openStream: (_path, { onOpen, onRecord }) => {
      onOpen?.();
      emitRecord = onRecord;
      return new Promise(() => {});
    }
  });

  f.state.selected = "t1";
  f.state.detail = {
    task: { taskId: "t1", status: "running", activeRunId: "r1" },
    messages: [],
    runtimeEvents: []
  };
  controller.connect("t1");

  const r1 = {
    eventId: "runtime-r1-1",
    type: "runtime_event",
    runId: "r1",
    payload: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" }
    }
  };
  const r2 = {
    eventId: "runtime-r1-2",
    type: "runtime_event",
    runId: "r1",
    payload: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" }
    }
  };
  emitRecord(r1);
  emitRecord(r2);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options?.streamRecords, [r1, r2]);

  // Mixing a non-runtime event clears streamRecords so the frame runs full render.
  const r3 = {
    eventId: "runtime-r1-3",
    type: "runtime_event",
    runId: "r1",
    payload: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "c" }
    }
  };
  emitRecord(r3);
  emitRecord({ eventId: "ledger-1", type: "main.run_completed", runId: "r1" });
  frames.shift()();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options, undefined);
  controller.dispose();
});
