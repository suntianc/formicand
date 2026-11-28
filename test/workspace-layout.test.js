import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-workspace-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new LocalWorkspaceStore(root) };
}

test("a new Task creates Main's advertised scratch directory before the first model request", async (t) => {
  const { root, store } = await fixture(t);
  await store.createTask("task", { goal: "prepare a presentation" });
  assert.equal((await stat(join(root, "task", "agents", "main", "work"))).isDirectory(), true);
});

test("metadata and status updates publish a new Task version while readers finish the old one", async (t) => {
  const { root, store } = await fixture(t);
  await store.createTask("task", { goal: "keep the published version readable" });
  const file = join(root, "task", "task.json");
  for (const change of [
    () => store.updateTask("task", { title: "updated" }),
    () => store.transitionTask("task", "running", { runId: "run" })
  ]) {
    const before = await store.readTask("task");
    const reader = await open(file, "r");
    try {
      const next = await change();
      assert.equal(next.version, before.version + 1);
      assert.equal(JSON.parse(await reader.readFile("utf8")).version, before.version);
      assert.equal((await store.readTask("task")).version, next.version);
    } finally {
      await reader.close();
    }
  }
});

test("an update cannot recreate a Task directory deleted after its record was read", async (t) => {
  const { root, store } = await fixture(t);
  const reader = store.readTask.bind(store);
  t.mock.method(store, "readTask", async (taskId) => {
    const record = await reader(taskId);
    await rm(join(root, taskId), { recursive: true });
    return record;
  });
  for (const [taskId, change] of [
    ["metadata", () => store.updateTask("metadata", { title: "new title" })],
    ["status", () => store.transitionTask("status", "running", { runId: "run" })]
  ]) {
    await store.createTask(taskId);
    await assert.rejects(change, { code: "ENOENT" });
    await assert.rejects(stat(join(root, taskId)), { code: "ENOENT" });
  }
});

test("starting an existing Task keeps its saved state and does not reopen its layout", async (t) => {
  const { root, store } = await fixture(t);
  await store.createTask("task", { goal: "keep the original goal" });
  const taskRoot = join(root, "task");
  const history = join(taskRoot, "agents", "main", "context", "messages.json");
  const artifact = join(taskRoot, "artifacts", "result.txt");
  await writeFile(history, "SAVED_HISTORY");
  await writeFile(artifact, "SAVED_ARTIFACT");
  await store.createRun("task", "resumed-run");
  assert.equal((await store.readTask("task")).goal, "keep the original goal");
  assert.equal(await readFile(history, "utf8"), "SAVED_HISTORY");
  assert.equal(await readFile(artifact, "utf8"), "SAVED_ARTIFACT");
  await writeFile(join(taskRoot, "agents", "main", "work", "draft.txt"), "SAVED_DRAFT");
  await store.createTask("task");
  assert.equal(await readFile(join(taskRoot, "agents", "main", "work", "draft.txt"), "utf8"), "SAVED_DRAFT");
});
