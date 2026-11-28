import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deferCleanup } from "./fixtures/cleanup.mjs";
import { shellExecutable } from "./fixtures/script-executable.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { createProjectCloneService } from "../dist/src/dashboard/project-clone-service.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

async function request(dashboard, path, { method = "GET", body } = {}) {
  const response = await fetch(`${dashboard.base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

async function projects(dashboard) {
  return (await request(dashboard, "/api/tasks")).body.projects ?? [];
}

async function waitForClone(dashboard, cloneId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let clone;
  for (;;) {
    const result = await request(dashboard, `/api/project-clones/${encodeURIComponent(cloneId)}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    clone = result.body.clone;
    if (predicate(clone)) return clone;
    if (Date.now() > deadline)
      throw new Error(`clone did not reach the expected state: ${JSON.stringify(clone)}`);
    await delay(50);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** One real repository with `main` and a `release` branch, plus a bare copy. */
async function seedRepository(root) {
  const work = join(root, "seed");
  await mkdir(work, { recursive: true });
  await git(work, ["init", "-b", "main"]);
  await git(work, ["config", "user.email", "fixture@example.test"]);
  await git(work, ["config", "user.name", "Fixture"]);
  await writeFile(join(work, ".gitattributes"), "* text eol=lf\n");
  await writeFile(join(work, "README.md"), "克隆夹具\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "initial"]);
  await git(work, ["checkout", "-b", "release"]);
  await writeFile(join(work, "release.txt"), "release branch\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "release"]);
  await git(work, ["checkout", "main"]);
  const bare = join(root, "remote.git");
  await run("git", ["clone", "--bare", work, bare], { maxBuffer: 8 * 1024 * 1024 });
  return bare;
}

/** A Git stand-in for the paths a real repository cannot hold for long enough. */
async function fakeGit(root) {
  const directory = join(root, "bin");
  await mkdir(directory, { recursive: true });
  const path = await shellExecutable(
    join(directory, "git"),
    `#!/bin/sh
trap 'echo term > "$GIT_TERM_MARKER"; exit 1' TERM INT
for arg in "$@"; do
  case "$arg" in
    *denied*)
      echo "git@example.test: Permission denied (publickey)." >&2
      exit 128;;
    *slow*)
      echo "Cloning into 'website'..." >&2
      sleep 0.2
      "${process.execPath.replaceAll("\\", "/")}" -e 'if (process.env.GIT_PID_MARKER) require("fs").writeFileSync(process.env.GIT_PID_MARKER, String(process.pid)); console.error("Receiving objects:  42% (42/100)"); setTimeout(() => {}, 60000)'
      exit 0;;
    *cred*)
      echo "fatal: unable to access '$arg': repository not found" >&2
      exit 128;;
  esac
done
exit 1
`
  );
  return { directory, path };
}

test("clones a branch from a file URL, reports progress and registers the project", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  deferCleanup(t, () => dashboard.stop());
  const bare = await seedRepository(dashboard.root);
  const destination = join(dashboard.root, "website");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: pathToFileURL(bare).href, destination, branch: "release" }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.clone.state, "cloning");
  assert.equal(started.body.clone.progress, 0);

  const done = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "completed"
  );
  assert.equal(done.progress, 100);
  assert.equal(done.project.projectDirectory, destination);
  assert.equal(done.project.projectName, "website");
  assert.match(done.project.projectId, /^project_[a-f0-9-]{36}$/);
  assert.equal(await readFile(join(destination, "release.txt"), "utf8"), "release branch\n");
  assert.deepEqual(
    (await projects(dashboard)).map((project) => project.projectId),
    [done.project.projectId]
  );
});

test("clones a local path with the default branch", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  deferCleanup(t, () => dashboard.stop());
  const bare = await seedRepository(dashboard.root);
  const destination = join(dashboard.root, "local-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: bare, destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const done = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "completed"
  );
  assert.equal(await readFile(join(destination, "README.md"), "utf8"), "克隆夹具\n");
  assert.equal(await exists(join(destination, ".git")), true);
  assert.equal(done.project.projectName, "local-clone");
  assert.equal((await projects(dashboard)).length, 1);
});

test("refuses an existing target and registers nothing", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  deferCleanup(t, () => dashboard.stop());
  const destination = join(dashboard.root, "taken");
  await mkdir(destination);
  const result = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: join(dashboard.root, "remote.git"), destination }
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /已存在/);
  assert.deepEqual(await projects(dashboard), []);
});

test("an address that is not a repository fails readably and leaves no folder or project", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  deferCleanup(t, () => dashboard.stop());
  const destination = join(dashboard.root, "missing-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: join(dashboard.root, "missing.git"), destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const failed = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "failed"
  );
  assert.match(failed.error, /does not exist|not (?:appear to be )?a git repository|不存在|not found/i);
  assert.equal(await exists(destination), false);
  assert.deepEqual(await projects(dashboard), []);
});

test("an authentication failure is reported without registering a project", async (t) => {
  const root = await mkdtempForTest(t);
  const ssh = await shellExecutable(
    join(root, "fake-ssh"),
    `#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 255\n`
  );
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { GIT_SSH_COMMAND: `"${ssh.replaceAll("\\", "/")}"` }
  });
  deferCleanup(t, () => dashboard.stop());
  const destination = join(dashboard.root, "private-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: "ssh://git@example.test/acme/website.git", destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const failed = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "failed"
  );
  assert.match(failed.error, /Permission denied \(publickey\)/);
  assert.equal(await exists(destination), false);
  assert.deepEqual(await projects(dashboard), []);
});

test("reports clone progress and cancelling stops git and removes the incomplete folder", async (t) => {
  const root = await mkdtempForTest(t);
  const fake = await fakeGit(root);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: {
      PATH: `${fake.directory}${delimiter}${process.env.PATH}`,
      GIT_TERM_MARKER: join(root, "terminated.marker").replaceAll("\\", "/"),
      GIT_PID_MARKER: join(root, "git.pid")
    }
  });
  deferCleanup(t, () => dashboard.stop());
  const destination = join(dashboard.root, "slow-clone");
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: { remoteUrl: "https://example.test/slow.git", destination }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const cloneId = started.body.clone.cloneId;
  const progressed = await waitForClone(dashboard, cloneId, (clone) => clone.progress >= 42);
  assert.equal(progressed.state, "cloning");
  assert.equal(await exists(destination), true);

  const cancelled = await request(dashboard, `/api/project-clones/${cloneId}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.clone.state, "cancelled");
  assert.equal(await exists(destination), false);
  const workerPid = Number(await readFile(join(root, "git.pid"), "utf8"));
  assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
  assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
  if (process.platform !== "win32")
    assert.equal(await readFile(join(root, "terminated.marker"), "utf8"), "term\n");
  assert.deepEqual(await projects(dashboard), []);
});

test("one operation id returns its clone and refuses different content", async (t) => {
  const root = await mkdtempForTest(t);
  const fake = await fakeGit(root);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { PATH: `${fake.directory}${delimiter}${process.env.PATH}` }
  });
  const destination = join(dashboard.root, "operation-clone");
  const body = {
    remoteUrl: "https://example.test/slow.git",
    destination,
    operationId: "clone-operation-1"
  };
  try {
    const first = await request(dashboard, "/api/project-clones", { method: "POST", body });
    const again = await request(dashboard, "/api/project-clones", { method: "POST", body });
    assert.equal(first.status, 202);
    assert.equal(again.body.clone.cloneId, first.body.clone.cloneId);
    const conflict = await request(dashboard, "/api/project-clones", {
      method: "POST",
      body: { ...body, destination: join(dashboard.root, "other-clone") }
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.match(conflict.body.error, /操作标识/);
    await request(dashboard, `/api/project-clones/${first.body.clone.cloneId}/cancel`, { method: "POST" });
  } finally {
    await dashboard.stop();
  }
});

test("recovery fails an interrupted clone, removes its folder and registers nothing", async (t) => {
  const root = await mkdtempForTest(t);
  const fake = await fakeGit(root);
  const dataRoot = join(root, "project-clones");
  const destination = join(root, "crash-clone");
  const created = [];
  const first = createProjectCloneService({
    dataRoot,
    gitCommand: fake.path,
    projectForDirectory: async () => undefined,
    createProject: async (input) => {
      created.push(input);
      return { projectId: "project_crash", ...input };
    }
  });
  deferCleanup(t, () => first.stop());
  const started = await first.start({ remoteUrl: "https://example.test/slow.git", destination });
  assert.equal(started.state, "cloning");
  assert.equal(await exists(destination), true);

  // A new process reads the same durable record; no live process owns it there.
  const second = createProjectCloneService({
    dataRoot,
    gitCommand: fake.path,
    projectForDirectory: async () => undefined,
    createProject: async (input) => {
      created.push(input);
      return { projectId: "project_crash", ...input };
    }
  });
  await second.ready;
  const recovered = await second.status(started.cloneId);
  assert.equal(recovered.state, "failed");
  assert.match(recovered.error, /中断/);
  assert.equal(await exists(destination), false);
  assert.deepEqual(created, []);
  await second.stop();
});

test("a credential embedded in the remote URL never reaches a response or the clone record", async (t) => {
  const root = await mkdtempForTest(t);
  const fake = await fakeGit(root);
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { PATH: `${fake.directory}${delimiter}${process.env.PATH}` }
  });
  deferCleanup(t, () => dashboard.stop());
  const destination = join(dashboard.root, "private-address");
  const token = "secret-token";
  const started = await request(dashboard, "/api/project-clones", {
    method: "POST",
    body: {
      remoteUrl: `https://user:${token}@example.test/acme/cred.git?access_token=${token}`,
      destination
    }
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const failed = await waitForClone(
    dashboard,
    started.body.clone.cloneId,
    (clone) => clone.state === "failed"
  );
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(failed), /access_token/);
  assert.match(failed.error, /repository not found/);
  const records = await readdir(join(dashboard.root, "project-clones"));
  for (const name of records) {
    const content = await readFile(join(dashboard.root, "project-clones", name), "utf8");
    assert.doesNotMatch(content, new RegExp(token));
    assert.doesNotMatch(content, /access_token|user:|example\.test/);
  }
});

test("a crash between registration and completion keeps the folder and the registered project", async (t) => {
  const root = await mkdtempForTest(t);
  const git = await silentGit(root);
  const dataRoot = join(root, "project-clones");
  const destination = join(root, "registering-clone");
  const catalog = new Map();
  const project = {
    projectId: "project_registered",
    projectName: "registering-clone",
    projectDirectory: destination
  };
  const first = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async (directory) => catalog.get(directory),
    createProject: async (input) => {
      catalog.set(input.projectDirectory, project);
      // The process "dies" inside registration: the catalog write happened,
      // but the clone record can never reach completed.
      return new Promise(() => {});
    }
  });
  // No stop for the dead process: a stop waits for registration, which never ends here.
  const started = await first.start({ remoteUrl: "https://example.test/instant.git", destination });
  await waitForServiceState(first, started.cloneId, "registering");
  await waitForCondition(() => catalog.has(destination));

  const second = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async (directory) => catalog.get(directory),
    createProject: async () => {
      throw new Error("an existing registration must not be repeated");
    }
  });
  deferCleanup(t, () => second.stop());
  await second.ready;
  const recovered = await second.status(started.cloneId);
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.project.projectId, "project_registered");
  assert.equal(await exists(destination), true);
});

test("stopping waits for a registration in progress to be written", async (t) => {
  const root = await mkdtempForTest(t);
  const git = await silentGit(root);
  const dataRoot = join(root, "project-clones");
  const destination = join(root, "stopping-clone");
  let release;
  const registered = new Promise((resolve) => {
    release = resolve;
  });
  const project = {
    projectId: "project_stopping",
    projectName: "stopping-clone",
    projectDirectory: destination
  };
  const service = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => undefined,
    createProject: async () => {
      await registered;
      return project;
    }
  });
  const started = await service.start({ remoteUrl: "https://example.test/instant.git", destination });
  await waitForServiceState(service, started.cloneId, "registering");
  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await delay(100);
  assert.equal(stopped, false, "stop returned while the project was still registering");
  release();
  await stopping;

  const again = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => project,
    createProject: async () => project
  });
  deferCleanup(t, () => again.stop());
  await again.ready;
  const record = await again.status(started.cloneId);
  assert.equal(record.state, "completed");
  assert.equal(record.project.projectId, "project_stopping");
});

test("a stop reports an outcome that could not be written, and a restart settles it", async (t) => {
  const root = await mkdtempForTest(t);
  const git = await silentGit(root);
  const dataRoot = join(root, "project-clones");
  const destination = join(root, "unwritable-clone");
  let release;
  const registered = new Promise((resolve) => {
    release = resolve;
  });
  const project = {
    projectId: "project_unwritable",
    projectName: "unwritable-clone",
    projectDirectory: destination
  };
  const service = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => undefined,
    createProject: async () => {
      await registered;
      return project;
    }
  });
  const started = await service.start({ remoteUrl: "https://example.test/instant.git", destination });
  await waitForServiceState(service, started.cloneId, "registering");
  const stopping = service.stop();
  // Make the record directory unavailable at its real path until the final
  // write has failed. This also exercises read-back after restoring it.
  const savedRoot = join(root, "saved-project-clones");
  await rename(dataRoot, savedRoot);
  try {
    await writeFile(dataRoot, "not a directory");
    release();
    await assert.rejects(stopping, { code: "EEXIST" });
  } finally {
    await rm(dataRoot, { force: true });
    await rename(savedRoot, dataRoot);
  }
  assert.equal((await service.status(started.cloneId)).state, "registering");
  await assert.rejects(service.stop(), { code: "EEXIST" });

  const again = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => project,
    createProject: async () => project
  });
  deferCleanup(t, () => again.stop());
  await again.ready;
  const record = await again.status(started.cloneId);
  assert.equal(record.state, "completed");
  assert.equal(record.project.projectId, "project_unwritable");
});

test("recovery finishes registration for a registering record and keeps the clone", async (t) => {
  const root = await mkdtempForTest(t);
  const git = await silentGit(root);
  const dataRoot = join(root, "project-clones");
  const destination = join(root, "pending-registration");
  const first = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => undefined,
    createProject: async () => new Promise(() => {})
  });
  // No stop for the dead process: a stop waits for registration, which never ends here.
  const started = await first.start({ remoteUrl: "https://example.test/instant.git", destination });
  await waitForServiceState(first, started.cloneId, "registering");

  let registrations = 0;
  const second = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => undefined,
    createProject: async (input) => {
      registrations += 1;
      return { projectId: "project_finished", ...input };
    }
  });
  deferCleanup(t, () => second.stop());
  await second.ready;
  const recovered = await second.status(started.cloneId);
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.project.projectId, "project_finished");
  assert.equal(await exists(destination), true);
  assert.equal(registrations, 1);
});

test("recovery keeps a complete clone when the catalog cannot be read", async (t) => {
  const root = await mkdtempForTest(t);
  const git = await silentGit(root);
  const dataRoot = join(root, "project-clones");
  const destination = join(root, "unreadable-catalog");
  const first = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => undefined,
    createProject: async () => new Promise(() => {})
  });
  // No stop for the dead process: a stop waits for registration, which never ends here.
  const started = await first.start({ remoteUrl: "https://example.test/instant.git", destination });
  await waitForServiceState(first, started.cloneId, "registering");

  const second = createProjectCloneService({
    dataRoot,
    gitCommand: git.path,
    projectForDirectory: async () => {
      throw new Error("catalog offline");
    },
    createProject: async () => {
      throw new Error("must not register while the catalog is unreadable");
    }
  });
  deferCleanup(t, () => second.stop());
  await second.ready;
  const recovered = await second.status(started.cloneId);
  assert.equal(recovered.state, "failed");
  assert.match(recovered.error, /已保留/);
  assert.equal(await exists(destination), true);
});

test("non-allowlisted transports are refused before git starts", async (t) => {
  const root = await mkdtempForTest(t);
  const service = createProjectCloneService({
    dataRoot: join(root, "project-clones"),
    projectForDirectory: async () => undefined,
    createProject: async () => {
      throw new Error("must not register");
    }
  });
  deferCleanup(t, () => service.stop());
  for (const remoteUrl of ["ext::sh -c 'touch /tmp/pwned'", "fd::3", "git+ssh://example.test/repo.git"]) {
    await assert.rejects(service.start({ remoteUrl, destination: join(root, "blocked") }), /协议|不合法/);
  }
  assert.equal(await exists(join(root, "blocked")), false);
});

test("git runs with the protocol allowlist and keeps the inherited environment", async (t) => {
  const root = await mkdtempForTest(t);
  const bin = join(root, "env-bin");
  await mkdir(bin, { recursive: true });
  const marker = join(root, "git-env.txt");
  // Git Bash rewrites HOME to an MSYS path. Report the same directory in native form.
  const homeExpression = process.platform === "win32" ? '$(cygpath -m "$HOME")' : "$HOME";
  const path = await shellExecutable(
    join(bin, "git"),
    `#!/bin/sh\nprintf '%s|%s' "$GIT_ALLOW_PROTOCOL" "${homeExpression}" > "$GIT_ENV_MARKER"\nexit 0\n`
  );
  process.env.GIT_ENV_MARKER = marker.replaceAll("\\", "/");
  deferCleanup(t, () => {
    delete process.env.GIT_ENV_MARKER;
  });
  const service = createProjectCloneService({
    dataRoot: join(root, "project-clones"),
    gitCommand: path,
    projectForDirectory: async () => undefined,
    createProject: async (input) => ({ projectId: "project_env", ...input })
  });
  deferCleanup(t, () => service.stop());
  const destination = join(root, "env-clone");
  const started = await service.start({ remoteUrl: "https://example.test/instant.git", destination });
  await waitForServiceState(service, started.cloneId, "completed");
  const [protocols, inheritedHome] = (await readFile(marker, "utf8")).split("|");
  assert.equal(protocols, "file:git:http:https:ssh");
  // GIT_ENV_MARKER also had to survive for the stand-in to create this file.
  if (process.env.HOME) assert.equal(inheritedHome, process.env.HOME.replaceAll("\\", "/"));
});

async function silentGit(root) {
  const directory = join(root, "instant-bin");
  await mkdir(directory, { recursive: true });
  const path = await shellExecutable(join(directory, "git"), "#!/bin/sh\nexit 0\n");
  return { directory, path };
}

async function waitForServiceState(service, cloneId, state, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await service.status(cloneId);
    if (view.state === state) return view;
    if (Date.now() > deadline) throw new Error(`clone ${cloneId} stayed ${view.state}, wanted ${state}`);
    await delay(20);
  }
}

async function waitForCondition(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await delay(20);
  }
}

async function mkdtempForTest(t) {
  const root = await mkdtemp(join(tmpdir(), "project-clone-test-"));
  deferCleanup(t, () => rm(root, { recursive: true, force: true }));
  return root;
}
