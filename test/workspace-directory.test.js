import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createWorkspaceDirectory } = await import("../dist/src/dashboard/workspace-directory.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

test("empty storage roots are omitted and project edits keep conversations in their storage root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-workspace-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a");
  const b = join(root, "b");
  await mkdir(b);
  const index = join(root, "catalog.json");
  let directory = createWorkspaceDirectory(a, index, () => "fixture");
  await directory.register(b);
  assert.deepEqual((await directory.globalTaskPayload()).projects, []);
  const project = await directory.createProject({ projectName: "保留我的历史", projectDirectory: b });
  await directory.createProjectTask("session", project.projectId, { goal: "保留我的历史" });
  const history = join(a, "session", "agents", "main", "context", "messages.json");
  await writeFile(history, "不能丢失的历史");
  directory = createWorkspaceDirectory(a, index, () => "fixture");
  const payload = await directory.globalTaskPayload();
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0].workspaceRoot, b);
  assert.equal(payload.projects[0].tasks[0].workspaceRoot, b);
  assert.equal(payload.currentWorkspaceRoot, a);
  const location = await directory.locateTask("session");
  assert.equal(location.workspaceRoot, a);
  assert.equal(location.projectId, project.projectId);
  assert.equal((await directory.taskListItem(location)).workspaceRoot, b);
  assert.equal(await readFile(history, "utf8"), "不能丢失的历史");
  await directory.updateProject(project.projectId, { projectDirectory: a }, (_taskIds, action) => action());
  assert.equal((await directory.globalTaskPayload()).projects[0].workspaceRoot, a);
});

test("a Task without a project is left off the list and on disk, while explicit empty projects remain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-project-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "workspace"),
    emptyRoot = join(root, "empty");
  await mkdir(emptyRoot);
  const directory = createWorkspaceDirectory(storage, join(root, "global.json"), () => "fixture");
  const store = new LocalWorkspaceStore(storage);
  await store.createTask("unassigned", { goal: "没有项目的历史" });
  assert.deepEqual((await directory.globalTaskPayload()).tasks, []);
  await assert.rejects(directory.locateTask("unassigned"), /找不到会话所属项目/);
  const explicit = await directory.createProject({
    projectName: "Explicit empty",
    projectDirectory: emptyRoot
  });
  const indexBefore = await readFile(directory.projectCatalog.filePath, "utf8");
  const payload = await directory.globalTaskPayload();
  assert.deepEqual(
    payload.projects.map((project) => project.projectId),
    [explicit.projectId]
  );
  // Reading the list neither rewrites nor prunes records or Task files.
  assert.equal(await readFile(directory.projectCatalog.filePath, "utf8"), indexBefore);
  await access(join(storage, "unassigned", "task.json"));
});

test("project order stays fixed when conversations in a later project are updated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-project-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "workspace");
  const dirA = join(root, "alpha");
  const dirB = join(root, "beta");
  await mkdir(dirA);
  await mkdir(dirB);
  const directory = createWorkspaceDirectory(storage, join(root, "global.json"), () => "fixture");
  const projectA = await directory.createProject({ projectName: "Alpha", projectDirectory: dirA });
  const projectB = await directory.createProject({ projectName: "Beta", projectDirectory: dirB });
  await directory.createProjectTask("task-a", projectA.projectId, { goal: "早期会话" });
  await new Promise((done) => setTimeout(done, 15));
  await directory.createProjectTask("task-b", projectB.projectId, { goal: "最新会话" });

  const payload = await directory.globalTaskPayload();
  assert.deepEqual(
    payload.projects.map((entry) => entry.projectId),
    [projectA.projectId, projectB.projectId],
    "updating a task in Beta must not reorder Beta ahead of Alpha"
  );
});
