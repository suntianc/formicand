import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMainPromptSnapshot,
  requestMainPromptRefresh,
  takeMainPromptRefresh,
  writeMainPromptSnapshot
} from "../dist/src/runtime/main-prompt-snapshot.js";

const snapshot = {
  version: 1,
  model: "provider/model",
  skills: [{ name: "a", description: "A", path: "/s/a/SKILL.md", directory: "/s/a" }],
  customAgents: "",
  memory: "MEMORY_INDEX",
  userMainInstructions: "",
  mcpServers: ["docs"],
  webSearch: true
};

test("a conversation's prompt snapshot round-trips and a reload request is consumed once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-prompt-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readMainPromptSnapshot(root, "task"), undefined, "no snapshot before the first turn");
  assert.equal(await takeMainPromptRefresh(root, "task"), false);

  // A reload asked for before Main ever ran still reaches its first turn.
  await requestMainPromptRefresh(root, "task");
  assert.equal(await takeMainPromptRefresh(root, "task"), true);
  assert.equal(await takeMainPromptRefresh(root, "task"), false, "one request, one regeneration");

  await writeMainPromptSnapshot(root, "task", snapshot);
  assert.deepEqual(await readMainPromptSnapshot(root, "task"), snapshot);
});

test("a snapshot of another version is generated again rather than read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-prompt-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "task", "agents", "main", "context");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "prompt-snapshot.json"), JSON.stringify({ ...snapshot, version: 2 }));
  assert.equal(await readMainPromptSnapshot(root, "task"), undefined);
});
