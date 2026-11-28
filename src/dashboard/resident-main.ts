import { RuntimeOutputRecorder } from "../runtime/runtime-output.js";
import { isCancelledCallback, isMainControlType } from "../runtime/main-inbox-delivery.js";
import { AgentProcessHost, type AgentProcessRecord } from "../runtime/agent-process.js";
import { InboxStore } from "../runtime/scheduler.js";
import { MainRunOutput } from "./main-run-outcome.js";
import { mainIsAlive, readHeartbeat } from "../runtime/main-heartbeat.js";
import { processIsAlive, requireProcessIdentityCheck } from "../runtime/process-identity.js";
import { hostname } from "node:os";
import type { TaskLocation } from "./workspace-directory.js";

/**
 * A Run keeps one resident Main process for its whole life.
 *
 * The process does not end with its turn: its Inbox wakes it for the next
 * one, and only closing the session, the idle timeout or a model request
 * that could not continue ends it. One process therefore owns one Run, and
 * a later message is delivered to it instead of starting a second one.
 */
export interface ResidentMain {
  taskId: string;
  runId: string;
  location: TaskLocation;
  host: AgentProcessHost;
  record: AgentProcessRecord;
  output: MainRunOutput;
  /** Writes the process's runtime log; only a process this backend spawned. */
  runtimeOutput?: RuntimeOutputRecorder;
  /**
   * Turn state from this process's own event stream.
   *
   * Only meaningful when `observed` is true; an adopted process's turns are
   * reported by the durable heartbeat instead.
   */
  turnActive: boolean;
  /** Whether this backend observes the process's own event stream. */
  observed: boolean;
  /** This exit replaces the process; it must not settle the Run. */
  replacing: boolean;
  /** The exit was already handled; a late spawn must not re-register it. */
  settled: boolean;
  requestId?: string;
  /**
   * The connection a launch pinned with an explicit profile. A pinned process
   * keeps it for its life; an unpinned one follows the host file each turn.
   */
  pinnedConnection?: string;
}

/**
 * The turn a resident process reports in its durable heartbeat.
 *
 * A backend that adopted the process cannot see its event stream, so the
 * heartbeat written at every turn boundary is the only witness to whether a
 * turn is running. It belongs to this Main only when it names the same Run
 * and this host: the record names the launcher, the heartbeat the Pi process
 * it started, so their pids differ by design.
 */
export async function mainTurnState(
  location: TaskLocation,
  taskId: string,
  runId: string
): Promise<{ active: boolean; alive: boolean; recordedAt: number; turnId?: string } | undefined> {
  // eslint-disable-next-line no-restricted-syntax -- 心跳只是一个提示；读不到时由调用方按没有回合处理，而不是阻断退出结算
  const beat = await readHeartbeat(location.workspaceRoot, taskId).catch(() => undefined);
  // The Run identity plus this host ties the record to this Main: the process
  // record names the launcher, the heartbeat the Pi process it started, so
  // their pids differ by design. `turnActive` outlives the process on purpose,
  // because the last value it wrote is how a crash is told from an idle stop.
  if (!beat || (beat.host && beat.host !== hostname()) || beat.runId !== runId) return undefined;
  return {
    active: beat.turnActive === true,
    alive: mainIsAlive(beat),
    recordedAt: Date.parse(beat.updatedAt),
    ...(beat.turnId ? { turnId: beat.turnId } : {})
  };
}

/**
 * Whether the process a durable record names is still the same process.
 *
 * A bare pid is not an identity: this host recycles numbers, and a recycled
 * pid would look like a live Main whose Inbox nobody reads. A record without
 * a readable start time (a host where `ps` failed at launch) falls back to
 * the pid, which is the most that record can support.
 */
export async function residentProcessAlive(record: AgentProcessRecord): Promise<boolean> {
  if (!record.startedAt) return processIsAlive(record.pid);
  return requireProcessIdentityCheck(record);
}

/**
 * Whether an Inbox already holds a turn's worth of work.
 *
 * A continuation (or an edit) needs a wake command only when nothing else is
 * queued: a queued user message or callback starts the turn itself, and a
 * second empty continuation would add a turn nobody asked for.
 */
export async function hasQueuedTurn(inbox: InboxStore): Promise<boolean> {
  const at = Date.now();
  return (await inbox.list("main")).some(
    (message) =>
      // Only work the reader can take now counts: a live lease from a dead
      // process is not deliverable until it expires, and waiting for it
      // would leave the new process idle with nothing to do.
      (message.state === "ready" ||
        (message.state === "leased" && Date.parse(message.lease?.expiresAt ?? "") <= at)) &&
      !isMainControlType((message.payload as { type?: unknown } | undefined)?.type) &&
      // A cancelled Subagent's callback is read with a turn but never starts one.
      !isCancelledCallback(message)
  );
}
