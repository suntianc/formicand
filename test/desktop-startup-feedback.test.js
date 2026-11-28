import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectBackend } from "../desktop/backend.cjs";
import { desktopPaths } from "../desktop/paths.cjs";
import { launchWithFeedback } from "../desktop/startup-feedback.cjs";

async function setup(t) {
  const logs = await mkdtemp(join(tmpdir(), "formicand-startup-"));
  t.after(() => rm(logs, { recursive: true, force: true }));
  const file = join(logs, "desktop-startup.jsonl");
  const events = [];
  return {
    logs,
    language: "en",
    window: { isDestroyed: () => false },
    cancelled: () => false,
    delayMs: 1,
    showLoading({ openLog }) {
      events.push("loading");
      openLog();
      return () => events.push("hidden");
    },
    openLog(path) {
      assert.equal(path, file);
      events.push("log");
    },
    showFailure() {
      assert.fail("successful launch should not show a dialog");
    },
    events,
    records: async () =>
      (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
  };
}

test("fast launch writes its timeline without a loading view", async (t) => {
  const f = await setup(t);
  await launchWithFeedback({ ...f, launch: async (trace) => trace.mark("renderer_loaded") });
  const records = await f.records();
  assert.deepEqual(
    records.map((r) => r.stage),
    ["window_ready", "renderer_loaded"]
  );
  assert.deepEqual(f.events, []);
  assert.equal(records[0].attempt, records[1].attempt);
});

test("slow launch exposes its log and dismisses the view when the renderer connects", async (t) => {
  const f = await setup(t);
  let resume;
  const waiting = new Promise((resolve) => {
    resume = resolve;
  });
  await launchWithFeedback({
    ...f,
    showLoading(input) {
      const close = f.showLoading(input);
      resume();
      return close;
    },
    launch: async (trace) => {
      await waiting;
      trace.mark("renderer_loaded");
    }
  });
  assert.deepEqual(f.events, ["loading", "log", "hidden"]);
  assert.deepEqual(
    (await f.records()).map((r) => r.stage),
    ["window_ready", "slow_start", "renderer_loaded"]
  );
});

test("failed launch can open diagnostics and retry, with one distinct redacted trace per attempt", async (t) => {
  const f = await setup(t);
  let attempts = 0;
  let response = 1;
  await launchWithFeedback({
    ...f,
    launch: async (trace) => {
      if (++attempts === 1) throw new Error("credential-fixture");
      trace.mark("renderer_loaded");
    },
    showFailure: async () => ({ response: response-- })
  });
  const records = await f.records();
  assert.deepEqual(
    records.map((r) => r.stage),
    ["window_ready", "startup_failed", "window_ready", "renderer_loaded"]
  );
  assert.equal(new Set(records.map((r) => r.attempt)).size, 2);
  assert.doesNotMatch(JSON.stringify(records), /credential-fixture/);
  assert.deepEqual(f.events, ["log"]);
});

test("quitting after a failed launch does not start another backend", async (t) => {
  const f = await setup(t);
  assert.equal(
    await launchWithFeedback({
      ...f,
      launch: async () => {
        throw new Error("offline");
      },
      showFailure: async () => ({ response: 2 })
    }),
    "quit"
  );
  assert.equal((await f.records()).length, 2);
});

test("a failure before backend.log exists keeps its actionable OS cause without exposing the private path", async (t) => {
  const f = await setup(t);
  const error = Object.assign(new Error("EACCES: /private/path/with/secret"), { code: "EACCES" });
  await launchWithFeedback({
    ...f,
    launch: async (trace) => {
      trace.mark("lock_wait");
      throw error;
    },
    showFailure: async (_window, details) => {
      assert.match(details.detail, /access.*data directory/i);
      assert.doesNotMatch(details.detail, /private.path|secret/);
      return { response: 2 };
    }
  });
  const records = await f.records();
  assert.equal(records.at(-1).reason, "access_denied");
  assert.doesNotMatch(JSON.stringify(records), /private.path|secret/);
});

test("missing packaged backend records a reason and supports retry before the service log is created", async (t) => {
  const f = await setup(t);
  const paths = desktopPaths(join(f.logs, "missing-package"), f.logs, {});
  const result = await launchWithFeedback({
    ...f,
    launch: (trace) => connectBackend(paths, undefined, process.execPath, trace),
    showFailure: async (_window, details) => {
      assert.match(details.detail, /missing_file/);
      assert.ok(!details.detail.includes(f.logs));
      return { response: 2 };
    }
  });
  assert.equal(result, "quit");
  assert.equal((await f.records()).at(-1).reason, "missing_file");
  await assert.rejects(access(join(paths.logs, "backend.log")), { code: "ENOENT" });
});
