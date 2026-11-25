import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

// Loaded only by the isolated Dashboard in the edit recovery test. Pi runs normally.
if (process.argv[1]?.endsWith(join("dist", "src", "cli", "dashboard.js"))) {
  const task = join(process.env.FORMICAND_WORKSPACE, "edit-task");
  const editRunPrefix = join(task, "runs", "main-edit-");
  const tx = join(task, "sessions", "main", "edit-transaction.json");
  const { readFile, writeFile, rename } = fs;
  let rejectedRun;
  let failedArchive = false;
  let awaitingLookup = false;
  fs.readFile = async (path, ...args) => {
    if (
      !rejectedRun &&
      String(path).startsWith(editRunPrefix) &&
      basename(String(path)) === "inbox-store.json"
    ) {
      const journal = JSON.parse(await readFile(tx, "utf8"));
      if (journal.phase === "launch_ready") {
        rejectedRun = journal.runId;
        throw new Error("fixture inbox failure");
      }
    }
    // The edited child is live, but its first heartbeat has not yet reached the backend.
    if (String(path) === join(task, "agents", "main", "heartbeat.json") && awaitingLookup)
      throw Object.assign(new Error("fixture first heartbeat"), { code: "ENOENT" });
    if (
      awaitingLookup &&
      String(path).startsWith(editRunPrefix) &&
      String(path).endsWith(join("agents", "main", "process.json"))
    ) {
      const record = JSON.parse(await readFile(path, "utf8"));
      return JSON.stringify({ ...record, startedAt: "" });
    }
    return readFile(path, ...args);
  };
  fs.writeFile = async (path, data, ...args) => {
    if (
      String(path).startsWith(join(task, "sessions", "main", "user-inputs")) &&
      JSON.parse(data).accepted === false
    )
      throw new Error("unexpected second write to the rejected input");
    return writeFile(path, data, ...args);
  };
  fs.rename = async (src, dst) => {
    if (
      src === tx &&
      rejectedRun &&
      !String(dst).endsWith(`edit-transaction-${rejectedRun}.json`) &&
      !failedArchive
    ) {
      failedArchive = true;
      awaitingLookup = true;
      throw Object.assign(new Error("fixture archive failure"), { code: "EIO" });
    }
    if (src === tx) awaitingLookup = false;
    return rename(src, dst);
  };
  syncBuiltinESMExports();
}
