import { queuedUserTurn } from "../dist/src/runtime/queued-user-turn.js";
import { resolve } from "node:path";
import { open, realpath, readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mainInputDelivered, readMainInput } from "../dist/src/runtime/main-continuation.js";

/** Resume the same Task in its project's new folder without rewriting its source transcript. */
export async function alignSelectedTaskSession(sessionPath, sessionDirectory, projectDirectory) {
  const target = await realpath(resolve(projectDirectory));
  const session = SessionManager.open(sessionPath, resolve(sessionDirectory));
  if (resolve(session.getHeader().cwd) === target) return sessionPath;
  return SessionManager.forkFrom(sessionPath, target, resolve(sessionDirectory)).getSessionFile();
}

/** Recover a missing Pi transcript from the cancelled request's durable context snapshot. */
export async function restoreUnflushedTaskSession(sessionDirectory, projectDirectory, snapshotPath) {
  const sessions = await SessionManager.listAll(resolve(sessionDirectory));
  if (sessions.some((session) => session.messageCount > 0)) return;
  let entries;
  try {
    entries = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("会话上下文无法恢复，原始记录已保留");
  }
  if (
    !Array.isArray(entries) ||
    !entries.some((entry) => entry?.type === "message" && entry.message?.role === "user")
  )
    return;
  const target = await realpath(resolve(projectDirectory));
  const session = SessionManager.create(target, resolve(sessionDirectory));
  await writeFile(
    session.getSessionFile(),
    [session.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { mode: 0o600, flag: "wx" }
  );
}

/** Recover an accepted input that a crashed process never saved, without replaying delivered input. */
export async function restorePendingTaskInput(
  sessionDirectory,
  projectDirectory,
  inputPath,
  selectedSessionPath
) {
  const input = await readMainInput(inputPath);
  if (!input) throw new Error("这次继续缺少已保存的输入记录，无法恢复；会话与记录仍保留。");
  const directory = resolve(sessionDirectory);
  const [latest] = selectedSessionPath
    ? [{ path: selectedSessionPath }]
    : await SessionManager.listAll(directory);
  let path = latest?.path;
  if (!path) {
    const fresh = SessionManager.create(await realpath(resolve(projectDirectory)), directory);
    path = fresh.getSessionFile();
    await writeFile(path, `${JSON.stringify(fresh.getHeader())}\n`, { mode: 0o600, flag: "wx" });
  }
  // A selected branch must still exist. Pi otherwise opens a missing path as a new session.
  const file = await open(path, "r+");
  try {
    const session = SessionManager.open(path, directory);
    if (mainInputDelivered(session.getBranch(), input)) return;
    const content =
      input.source === "composer" && input.taskId && input.runId && input.messageId
        ? queuedUserTurn({
            taskId: input.taskId,
            runId: input.runId,
            messageId: input.messageId,
            text: input.prompt
          })
        : input.prompt;
    await file.chmod(0o600);
    // Pi appends directly to this transcript, including the first user message.
    // Publish those bytes before launching the child while history readers keep their handles.
    session.appendMessage({ role: "user", content, timestamp: input.submittedAt });
    await file.sync();
  } finally {
    await file.close();
  }
}
