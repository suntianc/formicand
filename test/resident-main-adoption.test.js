import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createResidentMainRegistry } from "../dist/src/dashboard/resident-main-registry.js";
import { AgentProcessHost, agentProcessRecordPath } from "../dist/src/runtime/agent-process.js";
import { readProcessIdentity } from "../dist/src/runtime/process-identity.js";

async function fixture(t) {
  const taskId = "adopt";
  const workspaceRoot = await mkdtemp(join(tmpdir(), "formicand-adoption-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5 }));
  const identity = await readProcessIdentity(process.pid);
  assert.ok(identity);
  const task = { activeRunId: "first" };
  const location = { workspaceRoot, task, store: { readTask: async () => ({ ...task }) } };
  const residentMains = new Map();
  const interjectionTargets = new Map();
  const registry = createResidentMainRegistry({
    residentMains,
    interjectionTargets,
    activeRunIds: new Map(),
    projectRoot: workspaceRoot
  });
  t.after(() => {
    for (const resident of residentMains.values()) resident.host.close();
  });
  async function writeProcess(runId, token, startedAt = identity.startedAt) {
    const path = agentProcessRecordPath(workspaceRoot, taskId, runId, "main", "main");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        taskId,
        runId,
        role: "main",
        agentId: "main",
        callId: runId,
        token,
        pid: identity.pid,
        startedAt,
        host: hostname(),
        stdoutPath: join(dirname(path), "output.log"),
        resultPath: join(dirname(path), "result.json")
      })
    );
    task.activeRunId = runId;
  }
  return { adopt: () => registry.adoptResidentMain(taskId, location), writeProcess, interjectionTargets };
}

test("concurrent adoption preserves the interjection target of the same Main", async (t) => {
  const f = await fixture(t);
  await f.writeProcess("first", "launch-a");
  const first = f.adopt();
  const second = f.adopt();
  const resident = await first;
  const target = f.interjectionTargets.get("adopt");
  assert.ok(resident && target);
  assert.equal(await second, resident);
  assert.equal(f.interjectionTargets.get("adopt"), target);
});

for (const nextRun of ["first", "second"]) {
  test(`an adoption in progress cannot replace the newer process for Run ${nextRun}`, async (t) => {
    const f = await fixture(t);
    await f.writeProcess("first", "launch-a");
    const original = AgentProcessHost.prototype.adopt;
    const inspected = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.mock.method(AgentProcessHost.prototype, "adopt", async function (input) {
      const live = await original.call(this, input);
      if (live[0]?.token === "launch-a") {
        inspected.resolve();
        await release.promise;
      }
      return live;
    });
    const pending = f.adopt();
    await inspected.promise;
    try {
      await f.writeProcess(nextRun, "launch-b");
      const current = await f.adopt();
      assert.equal(current.record.token, "launch-b");
      const target = f.interjectionTargets.get("adopt");
      release.resolve();
      assert.equal(await pending, undefined);
      assert.equal(f.interjectionTargets.get("adopt"), target);
      assert.equal(await f.adopt(), current);
    } finally {
      release.resolve();
    }
  });
}

test("a failed identity check leaves the Main available for a later adoption", async (t) => {
  const f = await fixture(t);
  await f.writeProcess("first", "launch-a", "");
  await assert.rejects(f.adopt(), /verify the start time/);
  await f.writeProcess("first", "launch-a");
  assert.equal((await f.adopt()).record.token, "launch-a");
});
