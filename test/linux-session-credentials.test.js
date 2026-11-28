import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);

test("Linux protects persisted sessions and uses memory when its keyring is unavailable", async (t) => {
  const { createSessionCredentialStore } = require("../desktop/session-credentials.cjs");
  const userData = await mkdtemp(join(tmpdir(), "formicand-linux-keyring-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  let backend = "gnome_libsecret",
    available = true,
    encryptions = 0;
  const storage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => {
      encryptions++;
      return Buffer.from(text.split("").reverse().join(""));
    },
    decryptString: (buffer) => buffer.toString().split("").reverse().join("")
  };
  const createStore = () => createSessionCredentialStore({ userData, storage, linuxKeyring: true });
  const store = createStore();
  const existing = { sessionId: "a", token: "persisted-fixture" };
  await store.write("previous", existing);
  assert.deepEqual(await createStore().read("previous"), existing);
  const file = join(userData, "client-sessions.json");
  const previous = await readFile(file, "utf8");
  assert.doesNotMatch(previous, /persisted-fixture/);
  for (const [provider, enabled] of [
    ["basic_text", true],
    ["unknown", true],
    ["gnome_libsecret", false]
  ]) {
    backend = provider;
    available = enabled;
    const session = { sessionId: "b", token: "temporary-fixture" };
    assert.equal((await store.write("current", session)).temporary, true);
    assert.deepEqual(await store.read("current"), session);
    assert.equal(await createStore().read("current"), undefined);
    assert.equal(await readFile(file, "utf8"), previous);
  }
  assert.equal(encryptions, 1);
});
