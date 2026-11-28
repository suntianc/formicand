import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { createMainRunAdmission } from "../dist/src/dashboard/main-run-admission.js";
import {
  identifySpawnedProcess,
  matchProcessIdentity,
  readProcessIdentity,
  verifyProcessIdentity
} from "../dist/src/runtime/process-identity.js";

test(
  "a process keeps its identity across backends started in different time zones",
  { skip: process.platform === "win32" },
  async (t) => {
    // A backend started from a terminal inherits the shell's TZ, one started
    // from the Dock the system's. A record written by one must still name the
    // same live process for the other, or a running Main is taken for dead.
    const saved = process.env.TZ;
    t.after(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });
    process.env.TZ = "Asia/Tokyo";
    const written = await readProcessIdentity(process.pid);
    assert.ok(written?.startedAt);
    process.env.TZ = "Asia/Shanghai";
    assert.deepEqual(await readProcessIdentity(process.pid), written);
    assert.equal(await verifyProcessIdentity(written), true);
  }
);

test("a live PID only matches its recorded start time and an exited child cannot be reclaimed", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn");
    const identity = await readProcessIdentity(child.pid);
    assert.ok(identity);
    assert.equal(await verifyProcessIdentity(identity), true);
    assert.equal(await verifyProcessIdentity({ ...identity, startedAt: "earlier process" }), false);
    assert.deepEqual(await identifySpawnedProcess(child), identity);
    const timing = channel("formicand.process-identity.query");
    const events = [];
    const observe = (event) => events.push(event);
    timing.subscribe(observe);
    try {
      assert.equal(await verifyProcessIdentity(identity), true);
      assert.equal(await verifyProcessIdentity({ ...identity, startedAt: "earlier process" }), false);
      assert.equal(events.length, 0, "the live child handle pins the identity until exit");
    } finally {
      timing.unsubscribe(observe);
    }
  } finally {
    child.kill();
    await exited;
  }
  assert.equal(await readProcessIdentity(child.pid), undefined);
});

test("startup diagnostics measure the actual OS query without its pid or result", async () => {
  const timing = channel("formicand.process-identity.query");
  const events = [];
  const observe = (sample) => events.push(sample);
  timing.subscribe(observe);
  try {
    const [first, second] = await Promise.all([
      readProcessIdentity(process.pid),
      readProcessIdentity(process.pid)
    ]);
    assert.deepEqual(first, second);
    await readProcessIdentity(-1);
    assert.equal(events.length, 1, "overlapping observers share one actual OS query");
    assert.deepEqual(Object.keys(events[0]).sort(), ["durationMs", "started", "tool"]);
    assert.ok(events[0].durationMs >= 0);
    assert.equal(events[0].tool, process.platform === "win32" ? "powershell" : "ps");
  } finally {
    timing.unsubscribe(observe);
  }
});

test("an unavailable OS query cannot confirm the exit of a live process", async () => {
  const identity = await readProcessIdentity(process.pid);
  assert.ok(identity);
  const path = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.equal(await matchProcessIdentity(identity), undefined);
    assert.equal(await verifyProcessIdentity(identity), false);
    const admission = createMainRunAdmission({
      residentFor: async () => ({ observed: false, record: identity }),
      stopResidentMain: () => assert.fail("A pending identity check must not stop the resident Main")
    });
    await assert.rejects(
      admission.reuseResidentMain({ task: { taskId: "live" } }, { prompt: "continue" }, {}),
      /Unable to verify the start time/
    );
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});

test(
  "a PID whose start time this user may not read is not a Formicand process",
  { skip: process.platform !== "win32" },
  async () => {
    // PID 4 is the Windows System process. Its start time is denied even to an
    // administrator, which is what a reused PID owned by a service looks like.
    const recorded = { pid: 4, startedAt: "2000-01-01T00:00:00.0000000Z" };
    assert.equal(await matchProcessIdentity(recorded), false);
  }
);
