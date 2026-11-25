import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executionElapsedMs, formatExecutionDuration } from "../web/assets/execution-time.js";
import { readTaskTimingEvents } from "../dist/src/runtime/conversation-history.js";

const origin = Date.parse("2026-10-08T00:00:00.000Z");
const runtime = (...runIds) => runIds.map((runId) => ({ type: "runtime_event", runId, payload: {} }));
const boundary = (runId, type, ms) => ({
  eventId: `${runId}-${type}-${ms}`,
  runId,
  type: `main.run_${type}`,
  occurredAt: new Date(origin + ms).toISOString()
});

test("execution duration uses matching run boundaries rather than Task age or message timestamps", () => {
  const records = runtime("current");
  // The event's own time only tells which interval it ran in; the length is the ledger's.
  records[0].payload.timestamp = origin + 3000;
  const ledger = [
    boundary("old", "spawned", -500_000),
    boundary("old", "completed", -400_000),
    { runId: "current", type: "task.created", occurredAt: new Date(origin - 60_000).toISOString() },
    boundary("current", "spawned", 2000),
    { runId: "current", type: "run.started", occurredAt: "invalid", payload: { timeoutMs: 120_000 } },
    boundary("current", "completed", 10_000)
  ];
  assert.equal(executionElapsedMs(records, ledger), 8000);
  assert.deepEqual(
    records,
    runtime("current").map((record) => ({
      ...record,
      payload: { timestamp: origin + 3000 }
    }))
  );
});

test("wake intervals on the same run exclude the paused time", () => {
  assert.equal(
    executionElapsedMs(runtime("resumed"), [
      boundary("resumed", "spawned", 0),
      boundary("resumed", "waiting", 3000),
      boundary("resumed", "spawned", 103_000),
      boundary("resumed", "waiting", 108_000),
      boundary("resumed", "spawned", 200_000),
      boundary("resumed", "completed", 209_000)
    ]),
    17_000
  );
});

test("pause closes an interval and resume opens a new one for the same run", () => {
  assert.equal(
    executionElapsedMs(runtime("paused"), [
      boundary("paused", "spawned", 0),
      boundary("paused", "paused", 3000),
      boundary("paused", "spawned", 100_000),
      boundary("paused", "completed", 108_000)
    ]),
    11_000
  );
});

test("multiple runs sum actual execution and exclude idle gaps between runs", () => {
  const ledger = [
    boundary("one", "spawned", 0),
    boundary("one", "failed", 8000),
    boundary("two", "spawned", 100_000),
    boundary("two", "completed", 110_000)
  ];
  assert.equal(executionElapsedMs(runtime("one", "one", "two"), ledger), 18_000);
  assert.equal(executionElapsedMs(runtime("two"), ledger), 10_000);
});

test("duplicate and unordered ledger events never count an interval twice", () => {
  const start = boundary("one", "spawned", 1000);
  const stop = boundary("one", "completed", 9000);
  const ledger = [stop, start, { ...start }, { ...stop }, boundary("one", "waiting", 9000)];
  const original = structuredClone(ledger);
  assert.equal(executionElapsedMs(runtime("one", "one"), ledger), 8000);
  assert.deepEqual(ledger, original, "do not reorder or mutate caller-owned history");
});

test("repeated failure finalizers close only the original interval", () => {
  assert.equal(
    executionElapsedMs(runtime("one"), [
      boundary("one", "spawned", 0),
      boundary("one", "failed", 1000),
      boundary("one", "failed", 1200),
      boundary("one", "spawned", 2000),
      boundary("one", "completed", 5000)
    ]),
    4000
  );
});

test("every referenced run must have both an explicit start and a stop", () => {
  const complete = [boundary("known", "spawned", 0), boundary("known", "completed", 1000)];
  for (const incomplete of [
    [],
    [boundary("unknown", "spawned", 0)],
    [boundary("unknown", "completed", 1000)],
    [
      boundary("unknown", "spawned", 0),
      boundary("unknown", "waiting", 1000),
      boundary("unknown", "spawned", 2000)
    ]
  ]) {
    assert.equal(executionElapsedMs(runtime("known", "unknown"), [...complete, ...incomplete]), null);
  }
});

test("saved conversation timestamps and timeout values cannot supply missing lifecycle times", () => {
  const stop = boundary("one", "completed", 10_000);
  for (const occurredAt of [undefined, null, "", "invalid", "120000", 120_000, "2026-10-08"]) {
    assert.equal(
      executionElapsedMs(runtime("one"), [
        { ...boundary("one", "spawned", 0), occurredAt, timestamp: origin, payload: { timeoutMs: 10_000 } },
        stop
      ]),
      null
    );
  }
  assert.equal(executionElapsedMs([{ payload: { runId: "one", timestamp: origin } }], [stop]), null);
  assert.equal(executionElapsedMs([{ type: "message_end", message: { timestamp: origin } }], [stop]), null);
});

test("contradictory or unclosed intervals remain unknown", () => {
  for (const ledger of [
    [boundary("one", "spawned", 1000), boundary("one", "completed", 0)],
    [boundary("one", "spawned", 0), boundary("one", "spawned", 1000), boundary("one", "completed", 2000)],
    [boundary("one", "spawned", 0), { ...boundary("one", "completed", 1000), occurredAt: "invalid" }]
  ]) {
    assert.equal(executionElapsedMs(runtime("one"), ledger), null);
  }
});

test("invalid unrelated ledger events do not poison the current exchange", () => {
  assert.equal(
    executionElapsedMs(runtime("one"), [
      boundary("one", "spawned", 0),
      { runId: "other", type: "main.run_completed", occurredAt: "invalid" },
      null,
      boundary("one", "waiting", 0)
    ]),
    0
  );
});

test("missing runtime identities or non-array inputs mean unknown", () => {
  for (const [records, ledger] of [
    [[], []],
    [null, []],
    [[], null],
    [{}, []],
    [[null, {}], []]
  ]) {
    assert.equal(executionElapsedMs(records, ledger), null);
  }
});

test("duration formatting uses whole seconds and rejects invalid values", () => {
  for (const [ms, label] of [
    [8000, "8 秒"],
    [181_000, "3 分钟 1 秒"],
    [180_000, "3 分钟"],
    [0, "0 秒"],
    [999, "0 秒"],
    [1999, "1 秒"],
    [3_600_000, "1 小时"],
    [3_661_000, "1 小时 1 分钟 1 秒"]
  ]) {
    assert.equal(formatExecutionDuration(ms), label);
  }
  for (const ms of [null, undefined, "8000", NaN, Infinity, -Infinity, -1, {}, []]) {
    assert.equal(formatExecutionDuration(ms), "");
  }
});

test("each turn of a resident Main counts its own interval, not the Run's first", () => {
  const stamped = (runId, ...ms) =>
    ms.map((at) => ({ type: "runtime_event", runId, payload: { message: { timestamp: origin + at } } }));
  const ledger = [
    boundary("resident", "spawned", 0),
    boundary("resident", "completed", 8000),
    {
      eventId: "delivered",
      runId: "resident",
      type: "main.turn_delivered",
      occurredAt: new Date(origin + 39_000).toISOString()
    },
    boundary("resident", "completed", 87_000)
  ];
  assert.equal(executionElapsedMs(stamped("resident", 500, 7000), ledger), 8000);
  assert.equal(executionElapsedMs(stamped("resident", 39_200, 60_000, 86_000), ledger), 48_000);
  // Events without times, as older logs have, count the whole Run.
  assert.equal(executionElapsedMs(runtime("resident"), ledger), 56_000);
  // A message queued while paused opens no interval of its own.
  assert.equal(
    executionElapsedMs(runtime("paused"), [
      boundary("paused", "spawned", 0),
      boundary("paused", "paused", 3000),
      {
        runId: "paused",
        type: "main.turn_delivered",
        occurredAt: new Date(origin + 4000).toISOString(),
        payload: { queuedWhilePaused: true }
      },
      boundary("paused", "spawned", 10_000),
      boundary("paused", "completed", 12_000)
    ]),
    5000
  );
});

test("resident Main turns woken from waiting or after an earlier stop still report duration", () => {
  const stamped = (runId, ...ms) =>
    ms.map((at) => ({ type: "runtime_event", runId, payload: { message: { timestamp: origin + at } } }));
  const turnEvent = (runId, type, ms) => ({
    eventId: `${runId}-${type}-${ms}`,
    runId,
    type,
    occurredAt: new Date(origin + ms).toISOString()
  });

  // Waiting on a subagent closes the first interval; main.turn_started opens the wakeup interval.
  const wokenLedger = [
    boundary("resident", "spawned", 0),
    boundary("resident", "waiting", 10_000),
    turnEvent("resident", "main.turn_started", 60_000),
    boundary("resident", "completed", 85_000),
    boundary("resident", "stopped", 200_000)
  ];
  assert.equal(executionElapsedMs(stamped("resident", 1000, 9000), wokenLedger), 10_000);
  assert.equal(executionElapsedMs(stamped("resident", 61_000, 84_000), wokenLedger), 25_000);

  // Stopping an earlier turn closes its interval so later turns on the same Run keep their duration.
  const stoppedLedger = [
    boundary("resident", "spawned", 0),
    boundary("resident", "stopped", 12_000),
    turnEvent("resident", "main.turn_delivered", 30_000),
    turnEvent("resident", "main.turn_started", 30_100),
    boundary("resident", "completed", 45_000)
  ];
  assert.equal(executionElapsedMs(stamped("resident", 31_000, 44_000), stoppedLedger), 15_000);

  // While a second turn is still running on the same resident Run, the first
  // settled turn keeps its own closed duration instead of falling back until turn 2 ends.
  const activeSecondTurnLedger = [
    boundary("resident", "spawned", 0),
    boundary("resident", "completed", 8000),
    turnEvent("resident", "main.turn_delivered", 20_000)
  ];
  assert.equal(executionElapsedMs(stamped("resident", 1000, 7000), activeSecondTurnLedger), 8000);
  assert.equal(executionElapsedMs(stamped("resident", 21_000), activeSecondTurnLedger), null);
});

test("readTaskTimingEvents preserves boundaries across older Runs and past the 30-line tail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-timing-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "task-timing";
  const oldRun = join(root, taskId, "runs", "run-1");
  const curRun = join(root, taskId, "runs", "run-2");
  await mkdir(oldRun, { recursive: true });
  await mkdir(curRun, { recursive: true });
  await writeFile(join(oldRun, "run.json"), JSON.stringify({ createdAt: new Date(origin).toISOString() }));
  await writeFile(
    join(curRun, "run.json"),
    JSON.stringify({ createdAt: new Date(origin + 60_000).toISOString() })
  );
  await writeFile(
    join(oldRun, "run_events.jsonl"),
    [boundary("run-1", "spawned", 0), boundary("run-1", "completed", 9_000)]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n"
  );
  const filler = Array.from({ length: 40 }, (_, i) => ({
    eventId: `noise-${i}`,
    runId: "run-2",
    type: "subagent.dispatched",
    occurredAt: new Date(origin + 61_000 + i * 100).toISOString()
  }));
  await writeFile(
    join(curRun, "run_events.jsonl"),
    [boundary("run-2", "spawned", 60_000), ...filler, boundary("run-2", "completed", 80_000)]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n"
  );

  const ledger = await readTaskTimingEvents(root, taskId);
  assert.equal(ledger.length, 4);
  assert.equal(executionElapsedMs(runtime("run-1"), ledger), 9_000);
  assert.equal(executionElapsedMs(runtime("run-2"), ledger), 20_000);
});
