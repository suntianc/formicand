import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { withFileLock } from "./file-lock.js";
import {
  validMainRequestExecutionScope,
  type MainRequestExecutionScope
} from "../runtime/main-request-execution-scope.js";

export type MainRequestModel = Model<"openai-completions" | "openai-responses">;
export class MainRequestSnapshotError extends Error {
  readonly status = 400;
  readonly code = "main_retry_snapshot_invalid";
}
export interface MainRequestEnvironment {
  projectDirectory: string;
}
/** Why a retry rebuilt the context instead of replaying the archived wire body. */
export interface MainRequestReplaySkip {
  reason: "pi_version_mismatch";
  /** Pi version that wrote the skipped archive. */
  archivedPiVersion: string;
}
export interface MainRequestSnapshot {
  version: 1;
  taskId: string;
  runId: string;
  requestId: string;
  retryOf?: string;
  state: "pending" | "failed" | "completed";
  model: MainRequestModel;
  context: Context;
  sessionId?: string;
  environment: MainRequestEnvironment;
  /** Ownership of the directories a replay may touch. */
  executionScope: MainRequestExecutionScope;
  /** Model endpoint the archive was sent to. */
  endpoint: string;
  /** Pi version that wrote this snapshot; an archive only replays on that version. */
  piVersion: string;
  replaySkipped?: MainRequestReplaySkip;
  body: string;
  bodySha256: string;
  checksum: string;
}

export const mainRequestPath = (workspaceRoot: string, taskId: string): string =>
  join(workspaceRoot, taskId, "sessions", "main", "request-retry.json");
export const mainRequestStatePathFor = (filePath: string): string =>
  filePath.endsWith(".json") ? `${filePath.slice(0, -".json".length)}.state.json` : `${filePath}.state.json`;
export const mainRequestStatePath = (workspaceRoot: string, taskId: string): string =>
  mainRequestStatePathFor(mainRequestPath(workspaceRoot, taskId));
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const checksum = (snapshot: Partial<MainRequestSnapshot>) =>
  hash(JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "checksum"))));
interface MainRequestStateSidecar {
  version: 1;
  taskId: string;
  runId: string;
  requestId: string;
  state: "failed" | "completed";
  snapshotChecksum: string;
  checksum: string;
}
const sidecarChecksum = (sidecar: Omit<MainRequestStateSidecar, "checksum">) =>
  hash(JSON.stringify(Object.fromEntries(Object.entries(sidecar).filter(([key]) => key !== "checksum"))));

async function syncDirectory(dirPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dirPath, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" ||
      code === "EISDIR" ||
      code === "EINVAL" ||
      code === "EPERM" ||
      code === "EBADF"
    )
      return;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWriteDurable(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, targetPath);
    await syncDirectory(dir);
  } finally {
    await rm(temporary, { force: true });
  }
}
const validModel = (model: MainRequestModel | null | undefined) =>
  model &&
  typeof model.id === "string" &&
  typeof model.provider === "string" &&
  ["openai-completions", "openai-responses"].includes(model.api) &&
  typeof model.baseUrl === "string" &&
  typeof model.reasoning === "boolean" &&
  Array.isArray(model.input) &&
  Number.isFinite(model.maxTokens) &&
  Number.isFinite(model.contextWindow);
const validReplaySkip = (skip: unknown): skip is MainRequestReplaySkip => {
  if (!skip || typeof skip !== "object") return false;
  const value = skip as { reason?: unknown; archivedPiVersion?: unknown };
  return value.reason === "pi_version_mismatch" && typeof value.archivedPiVersion === "string";
};

export function parseMainRequestModel(serialized: string): MainRequestModel {
  const model = JSON.parse(serialized) as MainRequestModel;
  if (!validModel(model)) throw new Error("原请求模型记录损坏，已保留记录。请检查后重试。");
  return model;
}

/** Private execution state, distinct from redacted audit archives. Never stores auth headers. */
export class MainRequestStore {
  readonly statePath: string;

  constructor(
    readonly filePath: string,
    readonly taskId: string
  ) {
    this.statePath = mainRequestStatePathFor(filePath);
  }

  async read(): Promise<MainRequestSnapshot | undefined> {
    return withFileLock(this.filePath, () => this.readUnlocked(), { recoverDeadOwner: true });
  }

  async pending(): Promise<MainRequestSnapshot | undefined> {
    return withFileLock(this.filePath, () => this.pendingUnlocked(), { recoverDeadOwner: true });
  }

  /** Validate the slot's Task/Run/request identity while another process cannot replace it. */
  async inspectPending<T>(inspect: (snapshot: MainRequestSnapshot | undefined) => Promise<T>): Promise<T> {
    return withFileLock(this.filePath, async () => inspect(await this.pendingUnlocked()), {
      recoverDeadOwner: true
    });
  }

  /** Keep a retry recoverable if its selected Run fails before opening HTTP. */
  async reassignRun(original: MainRequestSnapshot, runId: string): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const current = await this.pendingUnlocked();
        if (
          current?.requestId !== original.requestId ||
          current.runId !== original.runId ||
          current.checksum !== original.checksum
        )
          throw new MainRequestSnapshotError("要重试的原请求已变化，已有内容仍保留。请刷新后重试。");
        if (current.runId !== runId) {
          await this.writeBaseUnlocked({ ...current, runId });
          await this.removeStateUnlocked();
        }
      },
      { recoverDeadOwner: true }
    );
  }

  async begin(
    input: Omit<MainRequestSnapshot, "version" | "taskId" | "state" | "bodySha256" | "checksum">,
    expected?: { runId: string; requestId: string }
  ): Promise<void> {
    const model = { ...input.model };
    delete model.headers;
    await withFileLock(
      this.filePath,
      async () => {
        if (expected) {
          const current = await this.pendingUnlocked();
          if (current?.runId !== expected.runId || current.requestId !== expected.requestId)
            throw new MainRequestSnapshotError("要重试的原请求已变化，已有内容仍保留。请刷新后重试。");
        }
        await this.writeBaseUnlocked({
          ...input,
          model,
          version: 1,
          taskId: this.taskId,
          state: "pending",
          bodySha256: hash(input.body)
        });
        await this.removeStateUnlocked();
      },
      { recoverDeadOwner: true }
    );
  }

  async settle(requestId: string, state: "failed" | "completed"): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const base = await this.readBaseUnlocked();
        // A later request, or a newly accepted user turn, owns this slot now.
        if (base?.requestId !== requestId) return;
        const current = await this.mergeSidecarUnlocked(base);
        if (current.state === state) return;
        if (state === "failed") {
          await this.writeBaseUnlocked({ ...base, state: "failed" });
          await this.removeStateUnlocked();
          return;
        }
        await this.writeStateUnlocked(base, "completed");
      },
      { recoverDeadOwner: true }
    );
  }

  /** Flush a matching state sidecar back into the v1 snapshot file and clear stale or orphaned sidecars. */
  async materialize(): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const base = await this.readBaseUnlocked();
        if (!base) {
          await this.removeStateUnlocked();
          return;
        }
        const sidecar = await this.readStateUnlocked();
        if (!sidecar) return;
        const matches =
          sidecar.taskId === base.taskId &&
          sidecar.runId === base.runId &&
          sidecar.requestId === base.requestId &&
          sidecar.snapshotChecksum === base.checksum;
        if (!matches) {
          await this.removeStateUnlocked();
          return;
        }
        if (sidecar.state !== base.state) await this.writeBaseUnlocked({ ...base, state: sidecar.state });
        await this.removeStateUnlocked();
      },
      { recoverDeadOwner: true }
    );
  }

  async clear(): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        await rm(this.filePath, { force: true });
        await this.removeStateUnlocked();
      },
      {
        recoverDeadOwner: true
      }
    );
  }

  private async readBaseUnlocked(): Promise<MainRequestSnapshot | undefined> {
    let snapshot: MainRequestSnapshot;
    try {
      snapshot = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new MainRequestSnapshotError("原请求快照无法读取，已保留记录。请检查后重试。", { cause: error });
    }
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 快照来自磁盘上的 JSON，可能是 null 或非对象；直接读 version 会抛 TypeError 而不是按损坏快照报告
      snapshot?.version !== 1 ||
      snapshot.taskId !== this.taskId ||
      typeof snapshot.runId !== "string" ||
      typeof snapshot.requestId !== "string" ||
      !["pending", "failed", "completed"].includes(snapshot.state) ||
      !validModel(snapshot.model) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版快照可能没有 context 字段，缺失时须按损坏快照报错而不是抛 TypeError
      !Array.isArray(snapshot.context?.messages) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版快照可能没有 environment 字段，缺失时须按损坏快照报错而不是抛 TypeError
      typeof snapshot.environment?.projectDirectory !== "string" ||
      !validMainRequestExecutionScope(snapshot.executionScope) ||
      typeof snapshot.endpoint !== "string" ||
      typeof snapshot.piVersion !== "string" ||
      (snapshot.replaySkipped !== undefined && !validReplaySkip(snapshot.replaySkipped)) ||
      typeof snapshot.body !== "string" ||
      snapshot.bodySha256 !== hash(snapshot.body) ||
      snapshot.checksum !== checksum(snapshot)
    )
      throw new MainRequestSnapshotError("原请求快照损坏，已保留记录。请检查后重试。");
    try {
      JSON.parse(snapshot.body);
      const endpoint = new URL(snapshot.endpoint);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.origin !== new URL(snapshot.model.baseUrl).origin
      )
        throw new Error("Invalid endpoint");
    } catch (error) {
      throw new MainRequestSnapshotError("原请求正文损坏，已保留记录。请检查后重试。", { cause: error });
    }
    return snapshot;
  }

  private async readStateUnlocked(): Promise<MainRequestStateSidecar | undefined> {
    let sidecar: MainRequestStateSidecar;
    try {
      sidecar = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new MainRequestSnapshotError("原请求状态记录无法读取，已保留记录。请检查后重试。", {
        cause: error
      });
    }
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 侧车来自磁盘 JSON，可能是 null 或非对象；直接读 version 会抛 TypeError 而不是按损坏快照报告
      sidecar?.version !== 1 ||
      sidecar.taskId !== this.taskId ||
      typeof sidecar.runId !== "string" ||
      typeof sidecar.requestId !== "string" ||
      !["failed", "completed"].includes(sidecar.state) ||
      typeof sidecar.snapshotChecksum !== "string" ||
      sidecar.checksum !== sidecarChecksum(sidecar)
    )
      throw new MainRequestSnapshotError("原请求状态记录损坏，已保留记录。请检查后重试。");
    return sidecar;
  }

  private async mergeSidecarUnlocked(base: MainRequestSnapshot): Promise<MainRequestSnapshot> {
    const sidecar = await this.readStateUnlocked();
    if (!sidecar) return base;
    if (
      sidecar.taskId !== base.taskId ||
      sidecar.runId !== base.runId ||
      sidecar.requestId !== base.requestId ||
      sidecar.snapshotChecksum !== base.checksum
    )
      return base;
    if (sidecar.state === base.state) return base;
    const merged = { ...base, state: sidecar.state };
    return { ...merged, checksum: checksum(merged) };
  }

  private async readUnlocked(): Promise<MainRequestSnapshot | undefined> {
    const base = await this.readBaseUnlocked();
    if (!base) return;
    return this.mergeSidecarUnlocked(base);
  }

  private async pendingUnlocked(): Promise<MainRequestSnapshot | undefined> {
    const snapshot = await this.readUnlocked();
    return snapshot?.state === "completed" ? undefined : snapshot;
  }

  private async writeBaseUnlocked(snapshot: Omit<MainRequestSnapshot, "checksum">): Promise<void> {
    await atomicWriteDurable(this.filePath, JSON.stringify({ ...snapshot, checksum: checksum(snapshot) }));
  }

  private async writeStateUnlocked(base: MainRequestSnapshot, state: "failed" | "completed"): Promise<void> {
    const payload: Omit<MainRequestStateSidecar, "checksum"> = {
      version: 1,
      taskId: base.taskId,
      runId: base.runId,
      requestId: base.requestId,
      state,
      snapshotChecksum: base.checksum
    };
    await atomicWriteDurable(
      this.statePath,
      JSON.stringify({ ...payload, checksum: sidecarChecksum(payload) })
    );
  }

  private async removeStateUnlocked(): Promise<void> {
    await rm(this.statePath, { force: true });
    await syncDirectory(dirname(this.statePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      throw error;
    });
  }
}
