import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { normalizeContext } from "@earendil-works/pi-ai";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { MainRequestRetry, mainRequestEnvironment } from "../dist/src/runtime/main-request-retry.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { installedPiVersion } from "./pi-version-fixture.mjs";

const storeModule = new URL("../dist/src/storage/main-request-store.js", import.meta.url).href;
const retryModule = new URL("../dist/src/runtime/main-request-retry.js", import.meta.url).href;
const childEnvironment = Object.fromEntries(
  ["PATH", "SystemRoot", "LANG", "TMPDIR", "TEMP", "TMP"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
);
const snapshotChanged = { code: "main_retry_snapshot_invalid", status: 400 };

async function storage(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-request-slot-"));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  await new LocalWorkspaceStore(root).createTask("task", { goal: "Request slot fixture", projectDirectory });
  const environment = await mainRequestEnvironment(root, "task", projectDirectory);
  const model = {
    id: "fixture",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 64
  };
  const context = normalizeContext({
    systemPrompt: "Original system",
    tools: [{ name: "fixture_tool", description: "Fixture tool", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "Original input", timestamp: 1 }]
  });
  const { executionScope, ...recordedEnvironment } = environment;
  const input = {
    runId: "original-run",
    requestId: "original-request",
    model,
    context,
    environment: recordedEnvironment,
    executionScope,
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
    piVersion: installedPiVersion,
    body: '{ "model": "fixture", "messages": [], "temperature": 0.4 }'
  };
  const capture = {
    requestId: "retry-request",
    retryOf: input.requestId,
    model,
    context,
    endpoint: input.endpoint,
    body: input.body
  };
  return {
    root,
    children,
    environment,
    model,
    context,
    input,
    capture,
    store: new MainRequestStore(mainRequestPath(root, "task"), "task")
  };
}

test("claiming an original request refuses a replaced Run, replaced request, completed or missing slot", async (t) => {
  for (const [name, replace] of [
    ["same requestId in a different Run", (f) => f.store.begin({ ...f.input, runId: "new-run" })],
    ["different request", (f) => f.store.begin({ ...f.input, requestId: "new-request" })],
    ["completed request", (f) => f.store.settle(f.input.requestId, "completed")],
    ["cleared request", (f) => f.store.clear()]
  ]) {
    await t.test(name, async (t) => {
      const f = await storage(t);
      await f.store.begin(f.input);
      await replace(f);
      const before = await readFile(f.store.filePath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      await assert.rejects(
        f.store.begin(
          { ...f.input, runId: "retry-run", requestId: "retry-request" },
          { runId: f.input.runId, requestId: f.input.requestId }
        ),
        snapshotChanged
      );
      if (before === undefined) await assert.rejects(readFile(f.store.filePath), { code: "ENOENT" });
      else assert.equal(await readFile(f.store.filePath, "utf8"), before);
    });
  }
});

test("a prepared retry cannot overwrite a replacement request or recreate a cleared turn", async (t) => {
  for (const [name, replace] of [
    ["same requestId in a different Run", (f) => f.store.begin({ ...f.input, runId: "new-run" })],
    ["different request", (f) => f.store.begin({ ...f.input, requestId: "new-request" })],
    ["completed request", (f) => f.store.settle(f.input.requestId, "completed")],
    ["cleared turn", (f) => f.store.clear()]
  ]) {
    await t.test(name, async (t) => {
      const f = await storage(t);
      await f.store.begin(f.input);
      await f.store.settle(f.input.requestId, "failed");
      const retry = new MainRequestRetry(f.store, "retry-run", async () => f.environment, f.input.requestId);
      assert.equal((await retry.prepare(f.model, f.context)).replay.requestId, f.input.requestId);
      await replace(f);
      const before = await f.store.read();
      const bytes = before ? await readFile(f.store.filePath, "utf8") : undefined;
      await assert.rejects(retry.capture(f.capture), snapshotChanged);
      assert.deepEqual(await f.store.read(), before);
      if (bytes !== undefined) assert.equal(await readFile(f.store.filePath, "utf8"), bytes);
      else await assert.rejects(readFile(f.store.filePath), { code: "ENOENT" });
    });
  }
});

test("a retry Run transfer preserves the complete request and refuses stale or cleared ownership", async (t) => {
  const f = await storage(t);
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "failed");
  const original = await f.store.pending();
  await f.store.reassignRun(original, "selected-retry-run");
  const moved = await f.store.pending();
  assert.equal(moved.runId, "selected-retry-run");
  assert.equal(moved.state, "failed");
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
  const { runId: _run, checksum: _checksum, ...request } = moved;
  const { runId: _originalRun, checksum: _originalChecksum, ...originalRequest } = original;
  assert.deepEqual(request, originalRequest);
  const bytes = await readFile(f.store.filePath, "utf8");
  await assert.rejects(f.store.reassignRun(original, "stale-run"), snapshotChanged);
  assert.equal(await readFile(f.store.filePath, "utf8"), bytes);
  await f.store.clear();
  await assert.rejects(f.store.reassignRun(moved, "cleared-run"), snapshotChanged);
  assert.equal(await f.store.read(), undefined);
});

function waitForMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.child.off("message", onMessage);
      worker.child.off("error", onError);
      worker.child.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`retry contender exited before ${type}: ${code ?? signal}; ${worker.errors()}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`retry contender did not send ${type}; ${worker.errors()}`));
    }, 5000);
    worker.child.on("message", onMessage);
    worker.child.once("error", onError);
    worker.child.once("exit", onExit);
  });
}

function contender(f, runId) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { MainRequestStore } from ${JSON.stringify(storeModule)};
        import { MainRequestRetry } from ${JSON.stringify(retryModule)};
        const { path, environment, model, context, capture, runId, originalRequestId } = JSON.parse(process.argv[1]);
        const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
        const retry = new MainRequestRetry(new MainRequestStore(path, "task"), runId, async () => environment, originalRequestId);
        try {
          await retry.prepare(model, context);
          const start = new Promise((resolve) => process.once("message", resolve));
          await send({ type: "ready" });
          await start;
          try {
            await retry.capture({ ...capture, requestId: runId + "-request" });
            await send({ type: "result", claimed: true, runId });
          } catch (error) {
            await send({ type: "result", claimed: false, code: error.code, runId });
          }
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        } finally {
          process.disconnect();
        }
      `,
      JSON.stringify({
        path: f.store.filePath,
        environment: f.environment,
        model: f.model,
        context: f.context,
        capture: f.capture,
        runId,
        originalRequestId: f.input.requestId
      })
    ],
    { cwd: f.root, env: childEnvironment, stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  f.children.add(child);
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  return { child, errors: () => errors, closed: once(child, "close") };
}

test(
  "two independently prepared processes can claim an original request only once",
  { timeout: 15000 },
  async (t) => {
    const f = await storage(t);
    await f.store.begin(f.input);
    await f.store.settle(f.input.requestId, "failed");
    const workers = [contender(f, "retry-one"), contender(f, "retry-two")];
    await Promise.all(workers.map((worker) => waitForMessage(worker, "ready")));
    const results = workers.map((worker) => waitForMessage(worker, "result"));
    for (const worker of workers) worker.child.send({ type: "start" });
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter((outcome) => outcome.claimed).length, 1);
    const winner = outcomes.find((outcome) => outcome.claimed);
    const loser = outcomes.find((outcome) => !outcome.claimed);
    assert.equal(loser.code, snapshotChanged.code);
    const claimed = await f.store.pending();
    assert.equal(claimed.runId, winner.runId);
    assert.equal(claimed.requestId, `${winner.runId}-request`);
    assert.equal(claimed.retryOf, f.input.requestId);
    assert.equal(claimed.body, f.input.body);
    for (const worker of workers) {
      const [code, signal] = await worker.closed;
      assert.equal(code, 0, worker.errors());
      assert.equal(signal, null, worker.errors());
    }
  }
);

test("clearing the active slot survives a process restart", async (t) => {
  const f = await storage(t);
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "failed");
  await f.store.clear();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { MainRequestStore } from ${JSON.stringify(storeModule)};
      const store = new MainRequestStore(process.argv[1], "task");
      console.log(JSON.stringify({ pending: Boolean(await store.pending()) }));
    `,
      f.store.filePath
    ],
    { cwd: f.root, env: childEnvironment, timeout: 5000 }
  );
  assert.deepEqual(JSON.parse(stdout), { pending: false });
  await assert.rejects(readFile(f.store.filePath), { code: "ENOENT" });
});

test("malformed version annotations report a damaged snapshot instead of throwing", async (t) => {
  for (const [name, patch] of [
    ["a non-string Pi version", { piVersion: 123 }],
    ["a missing Pi version", { piVersion: undefined }],
    ["a null replay reason", { replaySkipped: null }],
    ["an unknown replay reason", { replaySkipped: { reason: "unknown" } }],
    ["a missing execution scope", { executionScope: undefined }],
    ["a missing endpoint", { endpoint: undefined }]
  ]) {
    await t.test(name, async (t) => {
      const f = await storage(t);
      await f.store.begin({ ...f.input, ...patch });
      await assert.rejects(f.store.read(), snapshotChanged);
    });
  }
});

test("settle('completed') uses the light sidecar without rewriting base bytes and read() recomputes a valid v1 checksum", async (t) => {
  const f = await storage(t);
  await f.store.begin(f.input);
  const baseBefore = await readFile(f.store.filePath, "utf8");
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });

  await f.store.settle(f.input.requestId, "completed");
  assert.equal(await readFile(f.store.filePath, "utf8"), baseBefore);
  const sidecar = JSON.parse(await readFile(f.store.statePath, "utf8"));
  assert.equal(sidecar.state, "completed");
  assert.equal(sidecar.snapshotChecksum, JSON.parse(baseBefore).checksum);

  const merged = await f.store.read();
  assert.equal(merged.state, "completed");
  assert.notEqual(merged.checksum, JSON.parse(baseBefore).checksum);
  assert.equal(await f.store.pending(), undefined);

  // Merged snapshot must independently pass pure v1 validation without any sidecar.
  const standalonePath = join(f.root, "standalone-v1.json");
  await writeFile(standalonePath, JSON.stringify(merged), { mode: 0o600 });
  const standalone = await new MainRequestStore(standalonePath, "task").read();
  assert.deepEqual(standalone, merged);

  // settle('failed') writes directly to v1 base and removes the sidecar.
  await f.store.settle(f.input.requestId, "failed");
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(f.store.filePath, "utf8")).state, "failed");
  assert.equal((await f.store.pending()).state, "failed");
});

test("sidecar corruption fails closed, stale sidecar is ignored, and rejected claim leaves both files untouched", async (t) => {
  const f = await storage(t);
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "completed");
  const baseBytes = await readFile(f.store.filePath, "utf8");
  const sidecarBytes = await readFile(f.store.statePath, "utf8");

  // Rejected begin(expected) alters neither base nor sidecar.
  await assert.rejects(
    f.store.begin(
      { ...f.input, runId: "retry-run", requestId: "retry-req" },
      { runId: f.input.runId, requestId: f.input.requestId }
    ),
    snapshotChanged
  );
  assert.equal(await readFile(f.store.filePath, "utf8"), baseBytes);
  assert.equal(await readFile(f.store.statePath, "utf8"), sidecarBytes);

  // Tampered sidecar fails closed without deleting evidence.
  const tampered = JSON.stringify({ ...JSON.parse(sidecarBytes), state: "failed" });
  await writeFile(f.store.statePath, tampered, { mode: 0o600 });
  await assert.rejects(f.store.read(), snapshotChanged);
  await assert.rejects(f.store.pending(), snapshotChanged);
  assert.equal(await readFile(f.store.statePath, "utf8"), tampered);

  // Stale sidecar left over from a begin() crash before sidecar removal is ignored and cleaned by materialize().
  await f.store.begin({ ...f.input, requestId: "next-request" });
  await writeFile(f.store.statePath, sidecarBytes, { mode: 0o600 });
  assert.equal((await f.store.pending()).requestId, "next-request");
  assert.equal((await f.store.pending()).state, "pending");
  await f.store.materialize();
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
  assert.equal((await f.store.pending()).requestId, "next-request");
});

test("materialize() prepares native v1 downgrade for settled and unsettled snapshots, and cleans orphan sidecars", async (t) => {
  const f = await storage(t);

  // 1. Settled request: materialize() flushes completed state into v1 base and removes sidecar.
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "completed");
  await f.store.materialize();
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
  const v1SettledPath = join(f.root, "downgrade-settled.json");
  await copyFile(f.store.filePath, v1SettledPath);
  const v1Settled = new MainRequestStore(v1SettledPath, "task");
  assert.equal((await v1Settled.read()).state, "completed");
  assert.equal(await v1Settled.pending(), undefined);

  // 2. Unsettled request (exit after begin(), before settle()): materialize() is a no-op and preserves pending retryability.
  await f.store.begin({ ...f.input, requestId: "unsettled-req" });
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
  await f.store.materialize();
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
  const v1UnsettledPath = join(f.root, "downgrade-unsettled.json");
  await copyFile(f.store.filePath, v1UnsettledPath);
  const v1Unsettled = new MainRequestStore(v1UnsettledPath, "task");
  assert.equal((await v1Unsettled.pending()).requestId, "unsettled-req");
  assert.equal((await v1Unsettled.pending()).state, "pending");

  // 3. clear() interrupted between deleting base file and deleting sidecar: read() returns undefined, materialize() cleans orphan sidecar.
  await f.store.settle("unsettled-req", "completed");
  await rm(f.store.filePath);
  assert.equal(await f.store.read(), undefined);
  assert.equal(await f.store.pending(), undefined);
  await f.store.materialize();
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
});

test("materialize() write failure preserves both base and sidecar and recovers once writable", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const f = await storage(t);
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "completed");
  const baseBefore = await readFile(f.store.filePath, "utf8");
  const sidecarBefore = await readFile(f.store.statePath, "utf8");
  const dir = dirname(f.store.filePath);
  await chmod(dir, 0o500);
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
  });
  await assert.rejects(f.store.materialize());
  assert.equal(await readFile(f.store.filePath, "utf8"), baseBefore);
  assert.equal(await readFile(f.store.statePath, "utf8"), sidecarBefore);
  await chmod(dir, 0o700);
  assert.equal((await f.store.read()).state, "completed");
  assert.equal(await f.store.pending(), undefined);
  await f.store.materialize();
  await assert.rejects(readFile(f.store.statePath), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(f.store.filePath, "utf8")).state, "completed");
});

test("settle('completed') reads and validates the base snapshot file only once", async (t) => {
  const f = await storage(t);
  const largeBody = JSON.stringify({ message: "x".repeat(256 * 1024) });
  await f.store.begin({ ...f.input, body: largeBody });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import fsPromises from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const target = process.argv[1];
      let baseReads = 0;
      const origReadFile = fsPromises.readFile;
      fsPromises.readFile = async function (p, ...args) {
        if (String(p) === target) baseReads += 1;
        return origReadFile.call(this, p, ...args);
      };
      syncBuiltinESMExports();
      const { MainRequestStore } = await import(${JSON.stringify(storeModule)});
      const store = new MainRequestStore(target, "task");
      await store.settle(${JSON.stringify(f.input.requestId)}, "completed");
      const readsDuringSettle = baseReads;
      console.log(JSON.stringify({ readsDuringSettle, state: (await store.read()).state }));
    `,
      f.store.filePath
    ],
    { cwd: f.root, env: childEnvironment, timeout: 5000 }
  );
  assert.deepEqual(JSON.parse(stdout), { readsDuringSettle: 1, state: "completed" });
});

test("directory sync failure prevents materialize() from removing the sidecar and retry completes directory sync before unlink", async (t) => {
  if (process.platform === "win32") return;
  const f = await storage(t);
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "completed");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import fsPromises from "node:fs/promises";
      import { dirname } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const filePath = process.argv[1];
      const statePath = process.argv[2];
      const dir = dirname(filePath);
      let failDirSync = true;
      let failUnlinkSync = false;
      const ops = [];
      const origOpen = fsPromises.open;
      const origRm = fsPromises.rm;
      fsPromises.open = async function (p, flags, ...rest) {
        const handle = await origOpen.call(this, p, flags, ...rest);
        if (String(p) === dir && flags === "r") {
          const origSync = handle.sync.bind(handle);
          handle.sync = async () => {
            ops.push(failDirSync ? "dirSync:fail" : "dirSync:ok");
            if (failDirSync) {
              const err = new Error("EPERM: simulated dir sync failure");
              err.code = "EPERM";
              throw err;
            }
            return origSync();
          };
        }
        return handle;
      };
      fsPromises.rm = async function (p, ...rest) {
        if (String(p) === statePath) { ops.push("rm:sidecar"); failDirSync = failUnlinkSync; }
        return origRm.call(this, p, ...rest);
      };
      syncBuiltinESMExports();
      const { MainRequestStore } = await import(${JSON.stringify(storeModule)});
      const store = new MainRequestStore(filePath, "task");
      let firstErrorCode = null;
      try {
        await store.materialize();
      } catch (err) {
        firstErrorCode = err.code ?? err.message;
      }
      const sidecarAfterFailure = await fsPromises.readFile(statePath, "utf8").then(() => true, () => false);
      failDirSync = false;
      failUnlinkSync = true;
      const { default: assert } = await import("node:assert/strict");
      await assert.rejects(store.materialize(), { code: "EPERM" });
      await assert.rejects(fsPromises.readFile(statePath), { code: "ENOENT" });
      // The unlink already took effect. A new store must retry the missing barrier.
      await assert.rejects(new MainRequestStore(filePath, "task").materialize(), { code: "EPERM" });
      failDirSync = false;
      await store.materialize();
      const sidecarAfterRetry = await fsPromises.readFile(statePath, "utf8").then(() => true, () => false);
      const finalState = JSON.parse(await fsPromises.readFile(filePath, "utf8")).state;
      console.log(JSON.stringify({ firstErrorCode, sidecarAfterFailure, sidecarAfterRetry, finalState, ops }));
    `,
      f.store.filePath,
      f.store.statePath
    ],
    { cwd: f.root, env: childEnvironment, timeout: 5000 }
  );
  const res = JSON.parse(stdout);
  assert.equal(res.firstErrorCode, "EPERM");
  assert.equal(res.sidecarAfterFailure, true, "sidecar must remain on disk when base directory sync fails");
  assert.equal(
    res.sidecarAfterRetry,
    false,
    "retry materialize() must remove sidecar after syncing directory"
  );
  assert.equal(res.finalState, "completed");
  const okSyncIdx = res.ops.indexOf("dirSync:ok");
  const rmIdx = res.ops.indexOf("rm:sidecar");
  assert.ok(
    okSyncIdx >= 0 && rmIdx > okSyncIdx,
    `expected dirSync:ok before rm:sidecar, got ${JSON.stringify(res.ops)}`
  );
});

test("retrying settle('completed') after a post-rename directory sync EIO finishes directory sync without rewriting base", async (t) => {
  if (process.platform === "win32") return;
  const f = await storage(t);
  await f.store.begin(f.input);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import fsPromises from "node:fs/promises";
      import { dirname } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const filePath = process.argv[1];
      const dir = dirname(filePath);
      let failDirSync = true;
      let retryDirSyncs = 0;
      let retryBaseRenames = 0;
      let inRetry = false;
      const origOpen = fsPromises.open;
      const origRename = fsPromises.rename;
      fsPromises.open = async function (p, flags, ...rest) {
        const handle = await origOpen.call(this, p, flags, ...rest);
        if (String(p) === dir && flags === "r") {
          const origSync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (failDirSync) {
              const err = new Error("EIO: simulated post-rename dir sync failure");
              err.code = "EIO";
              throw err;
            }
            if (inRetry) retryDirSyncs += 1;
            return origSync();
          };
        }
        return handle;
      };
      fsPromises.rename = async function (src, dst, ...rest) {
        if (inRetry && String(dst) === filePath) retryBaseRenames += 1;
        return origRename.call(this, src, dst, ...rest);
      };
      syncBuiltinESMExports();
      const { MainRequestStore } = await import(${JSON.stringify(storeModule)});
      const store = new MainRequestStore(filePath, "task");
      let firstErrorCode = null;
      try {
        await store.settle(${JSON.stringify(f.input.requestId)}, "completed");
      } catch (err) {
        firstErrorCode = err.code ?? err.message;
      }
      failDirSync = false;
      inRetry = true;
      await store.settle(${JSON.stringify(f.input.requestId)}, "completed");
      console.log(JSON.stringify({ firstErrorCode, retryDirSyncs, retryBaseRenames, state: (await store.read()).state }));
    `,
      f.store.filePath
    ],
    { cwd: f.root, env: childEnvironment, timeout: 5000 }
  );
  const res = JSON.parse(stdout);
  assert.equal(res.firstErrorCode, "EIO");
  assert.ok(res.retryDirSyncs >= 1, `retry settle() must complete directory sync, got ${res.retryDirSyncs}`);
  assert.equal(res.retryBaseRenames, 0, "retry settle() must not rewrite the base snapshot");
  assert.equal(res.state, "completed");
});
