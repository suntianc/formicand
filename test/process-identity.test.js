import assert from "node:assert/strict";
import { test } from "node:test";
import { readProcessIdentity, verifyProcessIdentity } from "../dist/src/runtime/process-identity.js";

test(
  "a process keeps its identity across backends started in different time zones",
  { skip: process.platform === "win32" },
  async (t) => {
    // A backend started from a terminal inherits the shell's TZ, one started
    // from the Dock the system's. A record written by one must still name the
    // same live process for the other, or a running Main is taken for dead.
    const saved = process.env.TZ;
    t.after(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });
    process.env.TZ = "Asia/Tokyo";
    const written = await readProcessIdentity(process.pid);
    assert.ok(written?.startedAt);
    process.env.TZ = "Asia/Shanghai";
    assert.deepEqual(await readProcessIdentity(process.pid), written);
    assert.equal(await verifyProcessIdentity(written), true);
  }
);
