import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createDesktopUpdates } = createRequire(import.meta.url)("../desktop/updates.cjs");
const { prepareDesktopChange } = createRequire(import.meta.url)("../desktop/update-lifecycle.cjs");
const root = join(tmpdir(), "atria-update-controller-fixture");
const sourceCheck = {
  mode: "source",
  available: true,
  currentVersion: "1.0.0",
  version: "1.0.0",
  currentCommit: "old-commit",
  remoteCommit: "new-commit",
  branch: "main"
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise((done) => setImmediate(done));
test("the host manifest version is available before an update check", () => {
  const updates = createDesktopUpdates({ root, currentVersion: "1.0.0" });
  assert.equal(updates.status().currentVersion, "1.0.0");
  assert.equal(updates.status().phase, "idle");
});

test("source updates detect same-version commits and wait for host preparation before promotion", async () => {
  const gate = deferred();
  const calls = [];
  const toolchain = { nodeExecutable: "/fixture/node", npmCli: "/fixture/npm-cli.js" };
  const commandRunner = () => {};
  let updates;
  updates = createDesktopUpdates({
    mode: "source",
    root,
    toolchain,
    commandRunner,
    sourceUpdater: async () => ({
      async checkSourceUpdate(input) {
        assert.equal(input.root, root);
        assert.equal(input.target, "desktop");
        input.onProgress("Fetched upstream");
        return { ...sourceCheck };
      },
      async updateSource(input) {
        calls.push("promote");
        assert.equal(input.target, "desktop");
        assert.equal(input.toolchain, toolchain);
        assert.equal(input.commandRunner, commandRunner);
        input.onProgress("Building candidate");
        return { ...sourceCheck, updated: true, needsRelaunch: true };
      }
    }),
    async beforeApply(state) {
      calls.push("prepare");
      assert.equal(state.busy, true);
      assert.equal(state.installMethod, "source");
      await gate.promise;
    }
  });
  const checked = await updates.check();
  assert.equal(checked.available, true);
  assert.equal(checked.currentVersion, checked.version);
  assert.notEqual(checked.currentCommit, checked.remoteCommit);
  const applied = updates.apply();
  await nextTurn();
  assert.deepEqual(calls, ["prepare"]);
  await assert.rejects(updates.apply(), /already running/);
  await assert.rejects(updates.check(), /already running/);
  assert.equal(
    updates.status().error,
    undefined,
    "a competing request cannot overwrite the active operation"
  );
  gate.resolve();
  const result = await applied;
  assert.deepEqual(calls, ["prepare", "promote"]);
  assert.equal(result.updated, true);
  assert.equal(result.needsRelaunch, true);
  assert.equal(result.busy, false);
  await updates.apply();
  assert.deepEqual(
    calls,
    ["prepare", "promote", "prepare"],
    "another relaunch attempt requires preparation without another promotion"
  );
});

test("failed source preparation never calls the updater and a retry can succeed", async () => {
  let writable = false;
  let promotions = 0;
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async () => ({ ...sourceCheck }),
      updateSource: async () => {
        promotions++;
        return { ...sourceCheck, updated: true };
      }
    },
    beforeApply: async () => {
      if (!writable) throw new Error("Documents are not saved");
    }
  });
  await assert.rejects(updates.apply(), /not saved/);
  assert.equal(promotions, 0);
  assert.equal(updates.status().busy, false);
  assert.equal(updates.status().available, true);
  assert.equal(updates.status().needsRelaunch, false);
  writable = true;
  assert.equal((await updates.apply()).updated, true);
  assert.equal(promotions, 1);
});

test("source updates require a host gate and failures remain retryable without a false relaunch", async () => {
  let attempts = 0;
  const sourceUpdater = {
    checkSourceUpdate: async () => ({ ...sourceCheck }),
    updateSource: async () => {
      if (++attempts === 1) throw new Error("Candidate build failed");
      return { ...sourceCheck, updated: true };
    }
  };
  const ungated = createDesktopUpdates({ mode: "source", root, sourceUpdater });
  await assert.rejects(ungated.apply(), /host must prepare/);
  assert.equal(attempts, 0);
  const updates = createDesktopUpdates({ mode: "source", root, sourceUpdater, beforeApply: async () => {} });
  await assert.rejects(updates.apply(), /Candidate build failed/);
  assert.equal(updates.status().updated, false);
  assert.equal(updates.status().needsRelaunch, false);
  assert.equal(updates.status().busy, false);
  assert.equal((await updates.apply()).needsRelaunch, true);
});

test("a promoted source update rechecks new activity when the host retries a failed restart", async () => {
  let builds = 0;
  let backendRunning = true;
  let taskActive = false;
  let draft = "before promotion";
  let savedDraft;
  let stops = 0;
  const backend = {
    url: "http://127.0.0.1:43210",
    token: "fixture-source-retry",
    stop() {
      stops++;
      backendRunning = false;
    }
  };
  const task = { taskId: "new-task", status: "waiting", activeRunId: "new-run" };
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async () => ({ ...sourceCheck }),
      updateSource: async () => {
        assert.equal(backendRunning, false);
        builds++;
        return { ...sourceCheck, updated: true };
      }
    },
    async beforeApply() {
      assert.equal(backendRunning, true);
      await prepareDesktopChange({
        backend,
        documents: {
          async request() {
            savedDraft = draft;
            return true;
          }
        },
        fetchImpl: async (url) =>
          Response.json(
            url.endsWith("/api/tasks") ? { tasks: [task] } : { task, runtime: { active: taskActive } }
          )
      });
      backend.stop();
    }
  });
  assert.equal((await updates.apply()).updated, true);
  assert.equal(builds, 1);
  assert.equal(savedDraft, "before promotion");
  backendRunning = true; // The host's failed restart recovered a usable backend.
  draft = "draft after recovery";
  taskActive = true;
  await assert.rejects(updates.apply(), /任务正在运行/);
  assert.equal(stops, 1);
  assert.equal(builds, 1);
  assert.equal(savedDraft, "before promotion");
  assert.equal(updates.status().updated, true);
  assert.equal(updates.status().needsRelaunch, false);
  taskActive = false;
  const retry = await updates.apply();
  assert.equal(savedDraft, "draft after recovery");
  assert.equal(stops, 2);
  assert.equal(builds, 1, "retrying the restart must not rebuild or promote the source again");
  assert.equal(retry.updated, true);
  assert.equal(retry.needsRelaunch, true);
});

test("an up-to-date source checkout does not stop the backend or run a build", async () => {
  let prepared = 0,
    built = 0;
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async () => ({ ...sourceCheck, available: false }),
      updateSource: async () => built++
    },
    beforeApply: async () => prepared++
  });
  assert.equal((await updates.apply()).phase, "up-to-date");
  assert.equal(prepared, 0);
  assert.equal(built, 0);
});

test("a CLI-only source build can request the App build at the current commit", async () => {
  let built = 0;
  const current = {
    ...sourceCheck,
    remoteCommit: sourceCheck.currentCommit,
    rebuildRequired: true
  };
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async ({ target }) => {
        assert.equal(target, "desktop");
        return { ...current };
      },
      updateSource: async ({ target }) => {
        assert.equal(target, "desktop");
        built++;
        return { ...current, updated: true };
      }
    },
    beforeApply: async () => {}
  });
  const checked = await updates.check();
  assert.equal(checked.available, true);
  assert.equal(checked.rebuildRequired, true);
  assert.equal(checked.currentCommit, checked.remoteCommit);
  const result = await updates.apply();
  assert.equal(built, 1);
  assert.equal(result.updated, true);
  assert.equal(result.rebuildRequired, false);
  assert.equal(result.needsRelaunch, true);
});
