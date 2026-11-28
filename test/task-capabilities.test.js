import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { resolveCapabilities } from "../dist/src/runtime/task-capabilities.js";
import { jobStatus, killJob, listJobs, startJob } from "../dist/src/tools/jobs.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  configuredCommandTimeout
} from "../dist/src/runtime/runtime-settings.js";

test("the default is the sandbox: nothing is granted unless something says so", () => {
  const resolved = resolveCapabilities(undefined, {});
  assert.equal(
    resolved.projectWrite,
    false,
    "an ordinary task must not hold permission over the user's code"
  );
  assert.equal(resolved.shell, false);
  assert.equal(resolved.longRunning, false);
  assert.equal(resolved.maxAttempts, 3);
  assert.equal(resolved.source, "default");
});

test("a Task grant is what widens capabilities", () => {
  const resolved = resolveCapabilities(
    { projectWrite: true, shell: true, longRunning: true, maxAttempts: 1 },
    {}
  );
  assert.equal(resolved.projectWrite, true);
  assert.equal(resolved.shell, true);
  assert.equal(resolved.longRunning, true);
  assert.equal(resolved.maxAttempts, 1);
  assert.equal(resolved.source, "task");
});

test("the environment preset covers a run configured ahead of time", () => {
  const preset = resolveCapabilities(undefined, {
    FORMICAND_PROJECT_WRITE: "1",
    FORMICAND_MAX_ATTEMPTS: "1"
  });
  assert.equal(preset.projectWrite, true);
  assert.equal(preset.shell, true, "a shell is what makes project edits usable");
  assert.equal(preset.longRunning, true);
  assert.equal(preset.maxAttempts, 1);
  assert.equal(preset.source, "environment");
});

test("a malformed grant on disk narrows to the sandbox rather than being trusted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-caps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("t", { goal: "x" });

  // Values that are not booleans must not read as true.
  await store.updateTask("t", {
    capabilities: { projectWrite: "yes", shell: 1, maxAttempts: -5 }
  });
  const task = await store.readTask("t");
  assert.equal(task.capabilities.projectWrite, false);
  assert.equal(task.capabilities.shell, false);
  assert.equal(task.capabilities.maxAttempts, undefined, "a negative attempt count is not a grant");
});

test("a grant survives a round trip and records who made it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-caps-rt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("t", { goal: "optimize" });
  await store.updateTask("t", {
    capabilities: {
      projectWrite: true,
      shell: true,
      longRunning: true,
      maxAttempts: 1,
      grantedBy: "user",
      grantedAt: "2026-09-15T00:00:00.000Z",
      reason: "优化数据合成 pipeline"
    }
  });
  const task = await store.readTask("t");
  assert.equal(task.capabilities.projectWrite, true);
  assert.equal(task.capabilities.grantedBy, "user");
  assert.equal(task.capabilities.reason, "优化数据合成 pipeline");
});

async function waitForJob(directory, jobId, ready) {
  const deadline = Date.now() + 20_000;
  do {
    const status = await jobStatus({ directory, jobId });
    if (ready(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${jobId}`);
}

test("a job reports progress, completion and its output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-job-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { jobId } = await startJob({
    command: `"${process.execPath}" -e "console.log('first');setTimeout(() => console.log('second'), 400)"`,
    cwd: root,
    directory: join(root, "logs")
  });
  const early = await jobStatus({ directory: join(root, "logs"), jobId });
  assert.equal(early.state, "running", "a long job returns immediately instead of holding the agent");

  const done = await waitForJob(join(root, "logs"), jobId, (status) => status.exitCode !== undefined);
  assert.equal(done.state, "exited");
  assert.equal(done.exitCode, 0);
  assert.match(done.tail, /first/);
  assert.match(done.tail, /second/);
  assert.ok(done.elapsedMs >= 350, `elapsedMs should include the job's own delay, got ${done.elapsedMs}`);
  // A later query must use the recorded finish time even while wall time advances.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await jobStatus({ directory: join(root, "logs"), jobId })).elapsedMs, done.elapsedMs);
  // The log is on disk, so a restarted agent can still read what happened.
  assert.match(await readFile(done.logPath, "utf8"), /second/);
});

test("quiet time is reported so the model can judge a wedged job", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-job-quiet-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // A job that printed once and then went silent: exactly the case a fixed
  // deadline cannot distinguish from healthy slow work.
  const { jobId } = await startJob({
    command: `"${process.execPath}" -e "console.log('started');setTimeout(() => {}, 30000)"`,
    cwd: root,
    directory: join(root, "logs")
  });
  const status = await waitForJob(
    join(root, "logs"),
    jobId,
    (s) => s.tail.includes("started") && s.quietMs >= 300
  );
  assert.equal(status.state, "running");
  assert.match(status.tail, /started/);
  assert.ok(status.quietMs >= 300, `quiet time is evidence for the judgment, got ${status.quietMs}`);

  const killed = await killJob({ directory: join(root, "logs"), jobId });
  assert.equal(killed.state, "exited");
  assert.ok(killed.signal === "SIGTERM" || killed.signal === "SIGKILL" || killed.exitCode !== undefined);
});

test("killing a job takes its children with it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-job-group-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // The work worth killing is usually a child of the shell, so the signal has
  // to reach the whole group rather than the shell alone.
  const { jobId } = await startJob({
    command: `"${process.execPath}" -e "console.log('child=' + process.pid);setTimeout(() => {}, 45000)"`,
    cwd: root,
    directory: join(root, "logs")
  });
  const before = await waitForJob(join(root, "logs"), jobId, (s) => /child=\d+/.test(s.tail));
  const pid = Number(/child=(\d+)/.exec(before.tail)?.[1]);
  assert.ok(Number.isFinite(pid), `expected a child pid, got ${before.tail}`);

  await killJob({ directory: join(root, "logs"), jobId });
  await new Promise((resolve) => setTimeout(resolve, 300));
  let childAlive = true;
  try {
    process.kill(pid, 0);
  } catch {
    childAlive = false;
  }
  assert.equal(childAlive, false, "a killed job must not leave the real work running");
});

test("an unknown job is an error, not a silent empty status", async () => {
  await assert.rejects(
    () => jobStatus({ directory: "/tmp/formicand-nonexistent", jobId: "job-1" }),
    /unknown job/
  );
  await assert.rejects(
    () => killJob({ directory: "/tmp/formicand-nonexistent", jobId: "job-1" }),
    /unknown job/
  );
});

test("a job survives the process that started it, and is found again by a later Agent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-job-persist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "logs");

  // A three-hour training run outlives the Agent that launched it, so the
  // record has to be on disk rather than in that process's memory.
  const { jobId } = await startJob({
    command: `"${process.execPath}" -e "console.log('working');setTimeout(() => {}, 20000)"`,
    cwd: root,
    directory
  });

  // A fresh caller with no in-memory state — what a restarted Agent looks like.
  const seen = await waitForJob(directory, jobId, (s) => s.tail.includes("working"));
  assert.equal(seen.state, "running", "a restarted Agent must still find a job that is still running");
  assert.match(seen.tail, /working/);

  const all = await listJobs({ directory });
  assert.equal(all.length, 1);
  assert.equal(all[0].jobId, jobId);

  // And it can still stop it, which is the point of being able to find it.
  const killed = await killJob({ directory, jobId });
  assert.equal(killed.state, "exited");
});

test("a job that ended unobserved is reported as ended, not as running", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-job-orphan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "logs");
  const { jobId } = await startJob({ command: "echo quick", cwd: root, directory });
  await waitForJob(directory, jobId, (s) => s.exitCode !== undefined);

  // Simulate the record as a crashed launcher would leave it: started, never
  // updated with an exit. Liveness comes from the pid, so the truth still wins.
  const recordPath = join(directory, `${jobId}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  delete record.exitCode;
  delete record.finishedAt;
  delete record.signal;
  await writeFile(recordPath, JSON.stringify(record));

  const status = await jobStatus({ directory, jobId });
  assert.equal(status.state, "exited", "a dead pid must not read as a running job");
  assert.match(status.note, /ended while unobserved/);
  assert.match(status.tail, /quick/, "the log remains the evidence for what it did");
});

test("the unsupervised command deadline leaves room for ordinary work", () => {
  // Thirty minutes covers a test suite, an install or a build. Genuinely long
  // work belongs in start_job, which is supervised instead of deadlined.
  assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 30 * 60_000);
  assert.equal(configuredCommandTimeout({}), 30 * 60_000);
  assert.equal(
    configuredCommandTimeout({ FORMICAND_COMMAND_TIMEOUT_MS: "0" }),
    0,
    "zero still means unlimited"
  );
});
