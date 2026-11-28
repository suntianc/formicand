import assert from "node:assert/strict";
import { test } from "node:test";
import { pickDirectory } from "../dist/src/platform/directory-picker.js";

test("platform directory selection returns the selected path or cancellation", async () => {
  for (const [platform, expected] of [
    ["win32", "powershell.exe"],
    ["darwin", "/usr/bin/osascript"],
    ["linux", "zenity"]
  ]) {
    const selected = await pickDirectory(platform, async (cmd) => {
      assert.equal(cmd, expected);
      return { stdout: "project with spaces\n" };
    });
    assert.equal(selected, "project with spaces");
    assert.equal(await pickDirectory(platform, async () => ({ stdout: "\n" })), undefined);
  }
  const reject = (code) => async () => {
    throw Object.assign(new Error("synthetic failure"), { code });
  };
  assert.equal(await pickDirectory("linux", reject(1)), undefined);
  await assert.rejects(pickDirectory("linux", reject("ENOENT")), /zenity/);
  await assert.rejects(pickDirectory("win32", reject(1)), /无法打开/);
});
