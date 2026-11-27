import type { ChildProcess } from "node:child_process";
import { AgentProcessHost } from "../runtime/agent-process.js";
import { requestMainPromptRefresh } from "../runtime/main-prompt-snapshot.js";
import { MainRunOutput } from "./main-run-outcome.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import type { TaskLocation } from "./workspace-directory.js";
import { type RunServicePorts, type InterjectionTarget } from "./run-service-contracts.js";
import { type ResidentMain, mainTurnState } from "./resident-main.js";
import type { createResidentMainSettlement } from "./resident-main-settlement.js";

export function createResidentMainRegistry({
  residentMains,
  taskFinalizations,
  projectRoot,
  handleResidentExit,
  activeRunIds,
  interjectionTargets,
  mainCapacity,
  locateTask,
  isStopping,
  mainGuardian,
  appendRunEvent,
  activeRuns,
  pendingTurns
}: {
  residentMains: Map<string, ResidentMain>;
  taskFinalizations: Map<string, Promise<void>>;
  projectRoot: RunServicePorts["projectRoot"];
  handleResidentExit: ReturnType<typeof createResidentMainSettlement>["handleResidentExit"];
  activeRunIds: Map<string, string>;
  interjectionTargets: Map<string, InterjectionTarget>;
  mainCapacity: RunServicePorts["mainCapacity"];
  locateTask: RunServicePorts["locateTask"];
  isStopping: () => boolean;
  mainGuardian: RunServicePorts["mainGuardian"];
  appendRunEvent: RunServicePorts["appendRunEvent"];
  activeRuns: Map<string, ChildProcess>;
  pendingTurns: Map<string, number>;
}) {
  const residentMain = (taskId: string): ResidentMain | undefined => residentMains.get(taskId);

  /** End the resident Main serving a Task, waiting for its Run to settle. */
  async function stopResidentMain(taskId: string, options: { replacing?: boolean } = {}): Promise<void> {
    const resident =
      residentMains.get(taskId) ??
      (await residentFor(taskId).catch((error) => {
        // A close that lands before the startup sweep must still reach the
        // process; a lookup failure is reported and leaves nothing to stop.
        console.error(
          `[formicand] resolving the Main for ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
      }));
    if (!resident) return;
    resident.replacing = options.replacing === true;
    await resident.host
      .stop(resident.record)
      .catch((error) =>
        console.error(
          `[formicand] stopping the resident Main failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    await taskFinalizations.get(taskId);
  }

  /**
   * Take over a Main a previous backend left running for this Task.
   *
   * The process record carries the pid, host and OS start time it was launched
   * with, so a recycled pid is never mistaken for it. An adopted process keeps
   * running; later messages go to its Inbox and its own heartbeat reports the
   * state this backend cannot observe directly.
   */
  async function adoptResidentMain(
    taskId: string,
    location: TaskLocation
  ): Promise<ResidentMain | undefined> {
    const existing = residentMains.get(taskId);
    if (existing) return existing;
    const task = await location.store.readTask(taskId);
    if (!task.activeRunId) return undefined;
    const host = new AgentProcessHost({
      workspaceRoot: location.workspaceRoot,
      harnessRoot: projectRoot,
      onExit: (record) => handleResidentExit(taskId, record.runId, record)
    });
    // `adopt` watches a live process and settles a dead record through the one
    // deduplicated settlement path, so a record found after a restart is
    // projected exactly once.
    // This host manages Main only: a delegated process in the same run
    // directory is the subagent backend's, and settling it here would finalize
    // the Task on a Subagent's exit.
    const live = await host.adopt({ taskId, runId: task.activeRunId, roles: ["main"] });
    const record = live.find((candidate) => candidate.role === "main");
    if (!record) return undefined;
    // A Main that outlived its backend generates its system prompt again at its
    // next turn, as a restarted app would; settings saved meanwhile apply then.
    await requestMainPromptRefresh(location.workspaceRoot, taskId).catch((error) =>
      console.error(
        `[formicand] prompt refresh request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
    const resident: ResidentMain = {
      taskId,
      runId: record.runId,
      location,
      host,
      record,
      output: new MainRunOutput(),
      // A process that survived a backend restart may be mid-turn, and this
      // backend cannot observe that turn; its own heartbeat carries the state.
      turnActive: false,
      observed: false,
      replacing: false,
      settled: false
    };
    residentMains.set(taskId, resident);
    activeRunIds.set(taskId, record.runId);
    interjectionTargets.set(taskId, { runId: record.runId });
    // The place this Run still owns belongs to the adopted process too: the
    // next message must use it instead of admitting a second claim for it.
    if (mainCapacity?.enabled()) {
      // eslint-disable-next-line no-restricted-syntax -- 只读查询：读不到时按“没有名额”处理，下一条消息会重新准入
      const owned = await mainCapacity.requestFor(taskId, record.runId).catch(() => undefined);
      resident.requestId = owned;
    }
    return resident;
  }

  /**
   * The resident Main for a Task, taking it over from the previous backend if
   * this one has not met it yet.
   *
   * Management actions go through here so a still-running Main is reachable
   * after a restart before any new message names it.
   */
  async function residentFor(taskId: string): Promise<ResidentMain | undefined> {
    const known = residentMains.get(taskId);
    if (known) return known;
    const location = await locateTask(taskId);
    return adoptResidentMain(taskId, location);
  }

  /**
   * Take over every Main a previous backend left running.
   *
   * Runs once when the service starts: management actions (close, pause,
   * interrupt, insertion) and status reads must see a surviving Main without
   * waiting for the next message to name it.
   */
  async function adoptExistingMains(): Promise<{ adopted: number }> {
    const result = { adopted: 0 };
    if (isStopping()) return result;
    const report = (taskId: string | undefined, error: unknown) => {
      console.error(
        `[formicand] main adoption failed${taskId ? ` for ${taskId}` : ""}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    };
    const roots = await mainGuardian?.workspaceRoots().catch((error) => {
      report(undefined, error);
      return [] as string[];
    });
    for (const workspaceRoot of roots ?? []) {
      if (isStopping()) break;
      const tasks = await new LocalWorkspaceStore(workspaceRoot).listTasks().catch((error) => {
        report(workspaceRoot, error);
        return [];
      });
      for (const task of tasks) {
        const location = await locateTask(task.taskId).catch((error) => {
          report(task.taskId, error);
          return undefined;
        });
        if (!location) continue;
        const before = residentMains.get(task.taskId);
        try {
          const adopted = await adoptResidentMain(task.taskId, location);
          if (adopted && adopted !== before) result.adopted += 1;
        } catch (error) {
          // The failure is reported and left on the task's run log; the next
          // management call still adopts on demand.
          report(task.taskId, error);
          if (location.task.activeRunId)
            await appendRunEvent(
              location.workspaceRoot,
              task.taskId,
              location.task.activeRunId,
              "main.adoption_failed",
              { error: error instanceof Error ? error.message : String(error) }
              // eslint-disable-next-line no-restricted-syntax -- 诊断事件写失败不能中断其余会话的接管
            ).catch(() => {});
        }
      }
    }
    return result;
  }

  /**
   * Whether a turn is running for this Task right now.
   *
   * `undefined` means this backend does not know the Task's Main (no resident
   * and no live process); the caller then reads the heartbeat itself. A
   * process this backend observed reports its own event stream; an adopted one
   * reports the durable turn state it writes at every boundary.
   */
  async function taskTurnActive(taskId: string): Promise<boolean> {
    // The heartbeat is the one record both the Task view and the interrupt
    // command read, so they cannot disagree about whether a turn exists. The
    // turn counts only while that process is still alive: a record left by a
    // dead Main is how the exit is classified, not a turn the user can stop.
    const resident = residentMains.get(taskId);
    const location = resident?.location ?? (await locateTask(taskId));
    // eslint-disable-next-line no-restricted-syntax -- 读不到任务时按没有回合处理：状态查询不能因为损坏的记录抛出
    const task = await location.store.readTask(taskId).catch(() => location.task);
    const runId = task.activeRunId ?? resident?.runId;
    if (!runId) return false;
    // A paused Task is not running a turn. The extension writes `pausedAt` at
    // the boundary before anything else, so from then on the Task view and the
    // interrupt must not report the turn the record still describes while the
    // pause is being written. A pause only asked for leaves the turn running
    // until that boundary: the page shows it as pausing, and stop still works.
    if (task.pause?.pausedAt || task.status === "paused") return false;
    const state = await mainTurnState(location, taskId, runId);
    if (state) {
      // A record that says "running" stays the answer while this backend is
      // still settling that Run: a process that just exited has not written its
      // terminal Task status yet, and reporting "no turn" there is what lets a
      // reader see a running Task as idle.
      if (state.active && (state.alive || activeRuns.has(taskId))) return true;
      // The extension writes its own boundary; once that record is newer than
      // the acceptance, it is the answer and the acceptance no longer counts.
      const pendingAt = pendingTurns.get(taskId);
      if (pendingAt !== undefined && state.recordedAt >= pendingAt) {
        pendingTurns.delete(taskId);
        return false;
      }
    }
    const pendingAt = pendingTurns.get(taskId);
    if (pendingAt === undefined) return false;
    // A turn accepted for delivery has not written its first boundary yet.
    // Until this Run is settled it stays in flight even when the process has
    // already exited: the exit's settlement is what finishes it, and reporting
    // "no turn" in that window lets a reader decide the Task settled while its
    // status is still `running`.
    if (resident) return !resident.settled;
    return activeRuns.has(taskId);
  }

  /** Whether a Main process for this Task exists, idle or working. */
  function mainProcessRunning(taskId: string): boolean {
    return activeRuns.has(taskId) || residentMains.has(taskId);
  }

  /**
   * Whether a Main owns this Task, taking it over first when this backend has
   * not met it yet. Destructive management decisions use this instead of the
   * in-memory map so a Main still running from the previous backend cannot be
   * deleted, archived or duplicated during the startup adoption window.
   */
  async function ensureMainProcess(taskId: string): Promise<boolean> {
    if (mainProcessRunning(taskId)) return true;
    // eslint-disable-next-line no-restricted-syntax -- 未知或不可用的 Task 由调用方的正常 404 处理，这里只回答“有没有 Main”
    const resident = await residentFor(taskId).catch(() => undefined);
    return resident !== undefined;
  }

  /**
   * End a resident Main that sits idle, before its conversation is archived or
   * deleted. A finished round leaves its Main resident for the next message;
   * that process is no reason to refuse. The Task keeps its state and outcome.
   * Returns false, ending nothing, while a turn is still producing.
   */
  async function closeIdleMain(taskId: string): Promise<boolean> {
    if (!(await ensureMainProcess(taskId))) return true;
    if ((await taskTurnActive(taskId)) === true) return false;
    await stopResidentMain(taskId);
    return !mainProcessRunning(taskId);
  }

  return {
    residentMain,
    stopResidentMain,
    adoptResidentMain,
    residentFor,
    adoptExistingMains,
    taskTurnActive,
    mainProcessRunning,
    ensureMainProcess,
    closeIdleMain
  };
}
