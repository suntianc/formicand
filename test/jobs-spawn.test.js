import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const jobsUrl = new URL("../dist/src/tools/jobs.js", import.meta.url).href;

test(
  "a Windows background command runs without a visible console",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { startJob, jobStatus } = await import(jobsUrl);
    const root = await mkdtemp(join(tmpdir(), "formicand-job-console-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
    await writeFile(
      join(root, "probe.ps1"),
      `
Add-Type -Name ConsoleProbe -Namespace Jobs -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr window);
'@
[Jobs.ConsoleProbe]::IsWindowVisible([Jobs.ConsoleProbe]::GetConsoleWindow())
`
    );
    const shell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const job = await startJob({
      directory: root,
      cwd: root,
      command: `"${shell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File probe.ps1`
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const status = await jobStatus({ directory: root, jobId: job.jobId });
      if (status.exitCode !== undefined) {
        assert.equal(status.exitCode, 0, status.tail);
        assert.equal(status.tail.trim(), "False");
        break;
      }
      assert.ok(Date.now() < deadline, "console probe must complete");
      await new Promise((done) => setTimeout(done, 50));
    }
  }
);

test(
  "a restarted Windows agent stops the shell, command and grandchild and releases their directory",
  {
    skip: process.platform !== "win32"
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "formicand-job-tree-"));
    const cwd = join(root, "working directory");
    const directory = join(root, "records");
    const proof = join(root, "pids.json");
    await mkdir(cwd);
    await writeFile(
      join(cwd, "parent.cjs"),
      `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const fs = require("node:fs");
    setTimeout(() => console.log("output after restart"), 500);
    fs.writeFileSync(process.argv[2] + ".tmp", JSON.stringify([process.pid, child.pid]));
    fs.renameSync(process.argv[2] + ".tmp", process.argv[2]);
  `
    );
    let pids = [];
    t.after(async () => {
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const start = `import { startJob } from ${JSON.stringify(jobsUrl)};
      console.log(JSON.stringify(await startJob(JSON.parse(process.argv[1]))));`;
    const command = `"${process.execPath}" parent.cjs "${proof}"`;
    const starter = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", start, JSON.stringify({ directory, cwd, command })],
      { windowsHide: true, timeout: 15_000 }
    );
    const job = JSON.parse(starter.stdout);
    pids.push(job.pid);
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        pids.push(...JSON.parse(await readFile(proof, "utf8")));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise((done) => setTimeout(done, 30));
      }
    }
    while (!(await readFile(job.logPath, "utf8")).includes("output after restart")) {
      assert.ok(Date.now() < deadline, "the job still owns its log after the starter exits");
      await new Promise((done) => setTimeout(done, 30));
    }
    const script = `import { killJob } from ${JSON.stringify(jobsUrl)};
    console.log((await killJob({ directory: process.argv[1], jobId: process.argv[2] })).state);`;
    const runStop = () =>
      execFileAsync(process.execPath, ["--input-type=module", "-e", script, directory, job.jobId]);
    assert.equal((await runStop()).stdout.trim(), "exited");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    pids = [];
    await rename(cwd, join(root, "released"));
    assert.equal((await runStop()).stdout.trim(), "exited");
  }
);

test(
  "stopping a Windows job ends its grandchild after the intermediate process exits",
  {
    skip: process.platform !== "win32"
  },
  async (t) => {
    const { startJob, killJob } = await import(jobsUrl);
    const { readProcessIdentity, matchProcessIdentity } = await import(
      new URL("../runtime/process-identity.js", jobsUrl)
    );
    const root = await mkdtemp(join(tmpdir(), "formicand-orphan-job-"));
    const directory = join(root, "records");
    const sentinel = join(root, "keep-running");
    let identity;
    async function waitFor(check, message) {
      const until = Date.now() + 15_000;
      for (;;) {
        const result = await check();
        if (result) return result;
        assert.ok(Date.now() < until, message);
        await delay(30);
      }
    }
    async function report(name) {
      try {
        return JSON.parse(await readFile(join(root, name), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    t.after(async () => {
      await rm(sentinel, { force: true });
      try {
        if (identity)
          await waitFor(
            async () => (await matchProcessIdentity(identity)) === false,
            "the fixture grandchild did not exit after cleanup"
          );
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
    await writeFile(sentinel, "");
    const worker = fileURLToPath(new URL("./fixtures/orphaned-job.cjs", import.meta.url));
    const job = await startJob({ directory, cwd: root, command: `"${process.execPath}" "${worker}" outer` });
    const middle = await waitFor(() => report("middle-exit"), "the intermediate process did not exit");
    assert.equal(middle.code, 0);
    const leaf = await waitFor(() => report("leaf"), "the grandchild did not start");
    assert.equal(leaf.parent, middle.pid);
    identity = await readProcessIdentity(leaf.pid);
    assert.ok(identity, "the fixture identified its still-running grandchild");
    const stopped = await killJob({ directory, jobId: job.jobId });
    assert.equal(stopped.state, "exited");
    await writeFile(join(root, "challenge"), "");
    const outcome = await waitFor(async () => {
      const reply = await report("reply");
      if (reply) {
        assert.equal(reply.pid, identity.pid);
        return "grandchild acknowledged new work";
      }
      if ((await matchProcessIdentity(identity)) === false) return "exited";
    }, "the grandchild never exited after the job was stopped");
    assert.equal(outcome, "exited", "killJob reported exited while its grandchild still accepted work");
  }
);

test(
  "a stale Windows job record cannot stop a process outside its launch window",
  {
    skip: process.platform !== "win32"
  },
  async (t) => {
    const { killJob } = await import(jobsUrl);
    const directory = await mkdtemp(join(tmpdir(), "formicand-job-identity-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => target.once("exit", resolve));
    t.after(async () => {
      target.kill();
      await exited;
    });
    const old = new Date(Date.now() - 60_000);
    const record = {
      jobId: "job-1",
      logPath: join(directory, "job-1.log"),
      command: "old command",
      cwd: directory,
      pid: target.pid,
      startedAt: old.toISOString()
    };
    const path = join(directory, "job-1.json");
    await writeFile(path, JSON.stringify(record));
    await utimes(path, old, old);
    await assert.rejects(killJob({ directory, jobId: record.jobId }), /does not belong to the recorded job/);
    process.kill(target.pid, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).finishedAt, undefined);
  }
);

for (const failure of ["missing-cwd", "missing-executable", "invalid-command"]) {
  test(`job startup failure is recoverable in the same process: ${failure}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "formicand-spawn-error-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // A separate Node process proves that an unhandled ChildProcess error
    // cannot be hidden by the test runner's own uncaught-exception handling.
    const script = `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import { join } from "node:path";
      import { startJob, jobStatus, listJobs } from ${JSON.stringify(jobsUrl)};
      const [root, failure] = process.argv.slice(1);
      const directory = join(root, "logs", "jobs");
      const options = { directory, cwd: root, command: "echo unused" };
      if (failure === "missing-cwd") options.cwd = join(root, "missing");
      if (failure === "missing-executable") {
        options.shell = false;
        options.command = join(root, "missing-executable");
      }
      if (failure === "invalid-command") options.command = "bad\\0command";
      const launch = () => startJob(options);
      await assert.rejects(launch, (error) => {
        assert.match(error.message, /Failed to start job job-1/);
        assert.equal(error.cause.code, failure === "invalid-command" ? "ERR_INVALID_ARG_VALUE" : "ENOENT");
        return true;
      });
      const [failed] = await listJobs({ directory });
      assert.equal(failed.state, "exited");
      assert.match(failed.spawnError, /Failed to start job job-1/);
      assert.equal(failed.exitCode, undefined, "a spawn failure is not a command exit code");
      assert.equal(failed.note, undefined, "a known failure must not look like an unobserved exit");
      const record = JSON.parse(await readFile(join(directory, "job-1.json"), "utf8"));
      assert.ok(record.finishedAt);
      assert.equal(record.pid, undefined);
      const next = await startJob({ directory, cwd: root, command: "echo recovered", shell: true });
      assert.equal(next.jobId, "job-2", "preserve the failed attempt instead of overwriting it");
      const deadline = Date.now() + 10000;
      let done;
      do {
        done = await jobStatus({ directory, jobId: next.jobId });
        if (done.exitCode !== undefined && done.tail.includes("recovered")) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.equal(done.exitCode, 0);
      assert.match(done.tail, /recovered/);
      assert.equal(done.spawnError, undefined);
      console.log("recovered in the same process");
    `;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, root, failure],
      { timeout: 20_000 }
    );
    assert.match(stdout, /recovered in the same process/);
    assert.doesNotMatch(stderr, /Unhandled|uncaught/i);
  });
}
