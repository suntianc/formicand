import { readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteDurable, durableRemove, syncDirectory } from "../storage/atomic-file.js";
import { withFileLock } from "../storage/file-lock.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { agentProcessRecordPath, type AgentProcessRecord } from "./agent-process.js";
import { mainContextPaths } from "./main-context.js";
import { mainRequestPath, mainRequestStatePath } from "../storage/main-request-store.js";
import { mainInputPath, readMainInput } from "./main-continuation.js";
import { HumanRequestStore } from "./human.js";
import { mainIsAlive, readHeartbeat } from "./main-heartbeat.js";
import { processIsAlive, readProcessIdentity } from "./process-identity.js";

interface EditTransaction {
  version: 1;
  taskId: string;
  runId: string;
  phase: "prepared" | "launch_ready" | "rolling_back";
  intent: { editId: string; prompt: string };
  sessionFile?: string;
  input?: Awaited<ReturnType<typeof readMainInput>>;
  before: Array<{ path: string; bytes: string | null }>;
  retiredHumanRequests?: string[];
}
const live = new Set<string>();
const pathFor = (root: string, taskId: string) =>
  join(root, taskId, "sessions", "main", "edit-transaction.json");
async function optional(path: string) {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
async function atomic(path: string, bytes: string) {
  await atomicWriteDurable(path, bytes, { mode: 0o600 });
}
async function read(root: string, taskId: string): Promise<EditTransaction | undefined> {
  const bytes = await optional(pathFor(root, taskId));
  if (bytes === null) return;
  const value = JSON.parse(bytes) as EditTransaction;
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 事务文件从磁盘读出，旧版本写入的 version 不是 1 时必须拒绝恢复
    value.version !== 1 ||
    value.taskId !== taskId ||
    !/^[a-zA-Z0-9._-]+$/.test(value.runId) ||
    !["prepared", "launch_ready", "rolling_back"].includes(value.phase) ||
    !Array.isArray(value.before) ||
    (value.retiredHumanRequests !== undefined &&
      (!Array.isArray(value.retiredHumanRequests) ||
        value.retiredHumanRequests.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(id))))
  )
    throw new Error("编辑事务无法恢复，记录已保留。");
  const expected = snapshotPaths(root, taskId);
  const legacy = legacySnapshotPaths(root, taskId);
  const matches = (paths: string[]) =>
    value.before.length === paths.length &&
    value.before.every(
      (entry, index) =>
        entry.path === paths[index] && (entry.bytes === null || typeof entry.bytes === "string")
    );
  if (!matches(expected) && !matches(legacy)) throw new Error("编辑事务恢复路径无效，记录已保留。");
  return value;
}
function legacySnapshotPaths(root: string, taskId: string) {
  const context = mainContextPaths(root, taskId);
  return [
    join(root, taskId, "task.json"),
    join(root, taskId, "sessions", "main", "versions.json"),
    context.messages,
    context.state,
    mainRequestPath(root, taskId)
  ];
}
function snapshotPaths(root: string, taskId: string) {
  return [...legacySnapshotPaths(root, taskId), mainRequestStatePath(root, taskId)];
}
export async function beginMessageEditTransaction(
  root: string,
  taskId: string,
  runId: string,
  baselineVersions: unknown,
  intent: { editId: string; prompt: string },
  retiredHumanRequests: string[] = []
) {
  const path = pathFor(root, taskId);
  if ((await optional(path)) !== null) throw new Error("此前编辑事务尚未恢复。");
  await completeArchiveSync(path);
  const paths = snapshotPaths(root, taskId);
  const requestPath = mainRequestPath(root, taskId);
  const requestStatePath = mainRequestStatePath(root, taskId);
  const nonRequestPaths = paths.slice(0, 4);
  const [nonRequestBefore, requestBefore] = await Promise.all([
    Promise.all(nonRequestPaths.map(async (target) => ({ path: target, bytes: await optional(target) }))),
    withFileLock(
      requestPath,
      async () => [
        { path: requestPath, bytes: await optional(requestPath) },
        { path: requestStatePath, bytes: await optional(requestStatePath) }
      ],
      { recoverDeadOwner: true }
    )
  ]);
  const before = [...nonRequestBefore, ...requestBefore];
  if (before[1].bytes === null) before[1].bytes = JSON.stringify(baselineVersions);
  await atomic(
    path,
    JSON.stringify({ version: 1, taskId, runId, phase: "prepared", before, intent, retiredHumanRequests })
  );
  live.add(path);
}
export async function recordMessageEditBranch(root: string, taskId: string, sessionFile: string) {
  const value = await read(root, taskId);
  if (!value) throw new Error("编辑准备事务缺失。");
  await atomic(pathFor(root, taskId), JSON.stringify({ ...value, sessionFile }));
}
export async function readyMessageEditTransaction(root: string, taskId: string) {
  const value = await read(root, taskId);
  if (!value) throw new Error("编辑启动事务缺失。");
  const input = await readMainInput(mainInputPath(root, taskId, value.runId));
  const task = await new LocalWorkspaceStore(root).readTask(taskId);
  if (!input?.messageId || input.runId !== value.runId || task.activeRunId !== value.runId)
    throw new Error("编辑输入与运行身份尚未持久化。");
  await atomic(pathFor(root, taskId), JSON.stringify({ ...value, phase: "launch_ready", input }));
}
// The marker survives a backend exit between the archive rename and its directory sync.
// Only edit finalization takes this lock. Normal task reads just check for the marker.
async function completeArchiveSync(path: string) {
  const marker = path + ".archive-pending";
  if ((await optional(marker)) === null) return;
  await withFileLock(marker, async () => {
    if ((await optional(marker)) !== null && (await optional(path)) === null) {
      await syncDirectory(dirname(path));
      // If this unlink is lost in a power cut, the next lookup repeats the completed sync.
      await rm(marker);
    }
  });
}

export async function finishMessageEditTransaction(root: string, taskId: string) {
  const path = pathFor(root, taskId);
  const marker = path + ".archive-pending";
  try {
    await withFileLock(marker, async () => {
      const value = await read(root, taskId);
      if (value) {
        await atomic(marker, value.runId);
        await rename(path, join(dirname(path), `edit-transaction-${value.runId}.json`));
      }
      await syncDirectory(dirname(path));
      await rm(marker, { force: true });
    });
  } finally {
    live.delete(path);
  }
}

async function recordedProcessStatus(
  root: string,
  taskId: string,
  runId: string
): Promise<"alive" | "dead" | "unknown" | { host: string }> {
  const raw = await optional(agentProcessRecordPath(root, taskId, runId, "main", "main"));
  if (raw === null) return "dead";
  const record = JSON.parse(raw) as Partial<AgentProcessRecord>;
  if (
    record.taskId !== taskId ||
    record.runId !== runId ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    (record.startedAt !== undefined && typeof record.startedAt !== "string") ||
    typeof record.host !== "string" ||
    !record.host
  )
    throw new Error("编辑运行的进程记录无法核对，事务已保留。");
  if (record.exitCode !== undefined || record.exitSignal !== undefined) return "dead";
  if (record.host !== hostname()) return { host: record.host };
  if (record.startedAt) {
    const identity = await readProcessIdentity(record.pid);
    if (identity) return identity.startedAt === record.startedAt ? "alive" : "dead";
  }
  // A live PID without a verifiable start time can belong to a recycled process.
  return processIsAlive(record.pid) ? "unknown" : "dead";
}

async function editedRunStatus(root: string, taskId: string, runId: string) {
  const [record, heartbeat] = await Promise.allSettled([
    recordedProcessStatus(root, taskId, runId),
    readHeartbeat(root, taskId)
  ]);
  if (record.status === "fulfilled" && record.value === "alive") return "alive";
  if (heartbeat.status === "fulfilled" && heartbeat.value?.runId === runId && mainIsAlive(heartbeat.value))
    return "alive";
  if (record.status === "rejected") throw record.reason;
  if (heartbeat.status === "rejected") throw heartbeat.reason;
  if (typeof record.value === "string") return record.value;
  const beat = heartbeat.value;
  // Only a heartbeat from this remote Run can expire. launchedAt is not a heartbeat.
  if (beat?.runId === runId && beat.host === record.value.host && Number.isFinite(Date.parse(beat.updatedAt)))
    return "dead";
  return "unknown";
}

export async function rollbackMessageEditTransaction(root: string, taskId: string) {
  const path = pathFor(root, taskId);
  try {
    const value = await read(root, taskId);
    if (!value) {
      await completeArchiveSync(path);
      return;
    }
    // Durably record that launch never started and rollback is underway BEFORE
    // rejecting new input or mutating task.json, so an interrupted rollback from
    // `launch_ready` always resumes rollback instead of failing run-id validation.
    if (value.phase === "launch_ready") {
      await atomic(path, JSON.stringify({ ...value, phase: "rolling_back" }));
    } else if (value.phase === "rolling_back") {
      await syncDirectory(dirname(path));
    }
    // Preserve the rejected input and Run evidence; a durable rejection supersedes legacy fallbacks.
    const input = await readMainInput(mainInputPath(root, taskId, value.runId));
    if (input?.messageId && /^[a-zA-Z0-9._-]+$/.test(input.messageId)) {
      const inputRecordPath = join(
        root,
        taskId,
        "sessions",
        "main",
        "user-inputs",
        `${input.messageId}.json`
      );
      const bytes = await optional(inputRecordPath);
      if (bytes !== null)
        await atomic(inputRecordPath, JSON.stringify({ ...JSON.parse(bytes), accepted: false }));
    }
    const requestPath = mainRequestPath(root, taskId);
    const requestStatePath = mainRequestStatePath(root, taskId);
    for (const entry of value.before.slice(0, 4)) {
      if (entry.bytes === null) await durableRemove(entry.path);
      else await atomic(entry.path, entry.bytes);
    }
    await withFileLock(
      requestPath,
      async () => {
        const requestEntry = value.before[4];
        if (requestEntry.bytes === null) await durableRemove(requestEntry.path);
        else await atomic(requestEntry.path, requestEntry.bytes);
        const sidecarEntry = value.before.at(5);
        if (!sidecarEntry || sidecarEntry.bytes === null) await durableRemove(requestStatePath);
        else await atomic(sidecarEntry.path, sidecarEntry.bytes);
      },
      { recoverDeadOwner: true }
    );
    const human = new HumanRequestStore(root);
    for (const requestId of value.retiredHumanRequests ?? [])
      await human.restoreSuperseded(taskId, requestId, value.runId);
    await finishMessageEditTransaction(root, taskId);
  } finally {
    live.delete(path);
  }
}
/** Recover abandoned transactions; return whether the caller must refresh its Task snapshot. */
export async function recoverMessageEditTransaction(
  root: string,
  taskId: string,
  ownsMainProcess?: (root: string, taskId: string, runId: string) => boolean
): Promise<boolean> {
  const path = pathFor(root, taskId);
  if (live.has(path)) return false;
  if ((await optional(path)) === null) {
    await completeArchiveSync(path);
    return false;
  }
  return withFileLock(path, async () => {
    const value = await read(root, taskId);
    // Another process may have recovered the observed transaction while we waited for its lock.
    if (!value) {
      await completeArchiveSync(path);
      return true;
    }
    if (value.phase === "prepared" || value.phase === "rolling_back") {
      await rollbackMessageEditTransaction(root, taskId);
    } else {
      // Spawn may already have executed external actions. Keep the accepted branch and input,
      // and only settle the Run as waiting once we confirm no live Main process owns it.
      const store = new LocalWorkspaceStore(root);
      const task = await store.readTask(taskId);
      if (task.activeRunId !== value.runId) throw new Error("编辑事务与当前运行不一致，记录已保留。");
      if (task.status === "running" && !ownsMainProcess?.(root, taskId, value.runId)) {
        const status = await editedRunStatus(root, taskId, value.runId);
        if (status === "unknown") return false;
        if (status === "dead")
          await store.transitionTask(taskId, "waiting", {
            runId: value.runId,
            reason: "message_edit_launch_recovered"
          });
      }
      await finishMessageEditTransaction(root, taskId);
    }
    return true;
  });
}
