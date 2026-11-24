import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeJsonSnapshot } from "../dist/src/storage/snapshot-file.js";

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "cowork-snapshot-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "snapshot.json") };
}

const privateFile = { mode: 0o600, dirMode: 0o700 };
const message = (text) => JSON.stringify({ text });

test("large snapshot replacements preserve exact UTF-8, shortening, and existing readers", async (t) => {
  const { dir, path } = await fixture(t);
  const slab = "z".repeat(1024 * 1024);
  const original = message(slab + slab + slab);
  await writeJsonSnapshot(path, original, privateFile);
  const reader = await fs.open(path, "r");
  try {
    for (const next of [
      message("前" + slab.slice(1) + "😀" + slab + slab + "tail"),
      message("次" + slab.slice(1) + "中" + slab.slice(123)),
      message("短")
    ]) {
      await writeJsonSnapshot(path, next, privateFile);
      assert.equal(await fs.readFile(path, "utf8"), next);
      if (process.platform !== "win32") assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    }
    assert.equal(await reader.readFile("utf8"), original);
  } finally {
    await reader.close();
  }
  assert.deepEqual(await fs.readdir(dir), ["snapshot.json"]);
});

test("a failed snapshot publication keeps the previous file and cleans the private temporary copy", async (t) => {
  const { dir, path } = await fixture(t);
  const original = message("a".repeat(2 * 1024 * 1024));
  await writeJsonSnapshot(path, original, privateFile);
  const rename = fs.rename;
  const publication = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path) throw new Error("simulated rename failure");
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      writeJsonSnapshot(path, message("b" + original), privateFile),
      /simulated rename failure/
    );
  } finally {
    publication.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await fs.readFile(path, "utf8"), original);
  assert.deepEqual(await fs.readdir(dir), ["snapshot.json"]);
});
