import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { compactStoredMainSession, currentMainSession } from "../runtime/main-message-edit.js";
import { resumeSubagents } from "../runtime/subagent-pause.js";
import { readdir } from "node:fs/promises";
import { listJobs } from "../tools/jobs.js";
import { basename, join } from "node:path";
import { mainContextUsagePath, type SessionContextUsage } from "../runtime/session-context-usage.js";
import { readSleep, clearSleep } from "../runtime/main-sleep.js";
import { InboxStore } from "../runtime/scheduler.js";
import { mainIsAlive, readHeartbeat } from "../runtime/main-heartbeat.js";
import { projectExecutionIsAlive } from "../workspace/project-execution.js";
import { ProjectCatalogError } from "../workspace/project-catalog.js";
import { roleCompletion } from "../runtime/model-connection.js";
import { withFallbackModel, type SummaryModel } from "../runtime/session-summary.js";
import { stripReferencesBlock } from "../runtime/composer-references.js";
import { now, type TaskRecord } from "../domain/types.js";
import { type RunServicePorts, type SerializeTask } from "./run-service-contracts.js";
import type { ResidentMain } from "./resident-main.js";
import type { createResidentMainRegistry } from "./resident-main-registry.js";
import type { createResidentMainSettlement } from "./resident-main-settlement.js";

export function createTaskRunControl({
  serialize,
  locateTask,
  adoptResidentMain,
  taskTurnActive,
  stopResidentMain,
  activeRuns,
  residentMains,
  taskFinalizations,
  coordinator,
  withTaskProjectLock,
  readJsonFile,
  resolveMainModel,
  resolveUtilityModel,
  readWindowDevelopment,
  appendRunEvent,
  subagents,
  onTaskCancelling,
  finalizeSessionRun,
  cancellations,
  mainCapacity,
  humanWakeups,
  activeRunIds,
  prepareRunTransition
}: {
  serialize: SerializeTask;
  locateTask: RunServicePorts["locateTask"];
  adoptResidentMain: ReturnType<typeof createResidentMainRegistry>["adoptResidentMain"];
  taskTurnActive: ReturnType<typeof createResidentMainRegistry>["taskTurnActive"];
  stopResidentMain: ReturnType<typeof createResidentMainRegistry>["stopResidentMain"];
  activeRuns: Map<string, ChildProcess>;
  residentMains: Map<string, ResidentMain>;
  taskFinalizations: Map<string, Promise<void>>;
  coordinator: RunServicePorts["coordinator"];
  withTaskProjectLock: NonNullable<RunServicePorts["withTaskProjectLock"]>;
  readJsonFile: RunServicePorts["readJsonFile"];
  resolveMainModel: RunServicePorts["resolveMainModel"];
  resolveUtilityModel: NonNullable<RunServicePorts["resolveUtilityModel"]>;
  readWindowDevelopment: RunServicePorts["readWindowDevelopment"];
  appendRunEvent: RunServicePorts["appendRunEvent"];
  subagents: RunServicePorts["subagents"];
  onTaskCancelling: NonNullable<RunServicePorts["onTaskCancelling"]>;
  finalizeSessionRun: ReturnType<typeof createResidentMainSettlement>["finalizeSessionRun"];
  cancellations: Set<string>;
  mainCapacity: RunServicePorts["mainCapacity"];
  humanWakeups: Set<string>;
  activeRunIds: Map<string, string>;
  prepareRunTransition: ReturnType<typeof createResidentMainSettlement>["prepareRunTransition"];
}) {
  /** The utility model for a summary; an unusable one leaves the summary to Main's. */
  function utilitySummaryModel(): SummaryModel | undefined {
    try {
      const selection = resolveUtilityModel();
      return (
        selection && { complete: roleCompletion(selection), contextWindow: selection.profile.contextWindow }
      );
    } catch (error) {
      console.warn(
        "[Formicand] The utility model is unusable; using Main's:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  /** `change` names what waits for the project to be idle, for the refusal. */
  function withIdleProjectTasks<T>(
    taskIds: string[],
    action: () => Promise<T>,
    change = "更改项目文件夹"
  ): Promise<T> {
    const ids = [...new Set(taskIds)].sort();
    const lockTasks = (index: number): Promise<T> =>
      index < ids.length ? serialize(ids[index], () => lockTasks(index + 1)) : inspect();
    async function inspect() {
      for (const taskId of ids) {
        const location = await locateTask(taskId);
        // A refusal names the conversation, so the person knows which one to stop.
        const name = stripReferencesBlock(location.task.title ?? location.task.goal ?? "")
          .trim()
          .slice(0, 40);
        const refuse = (what: string) =>
          new ProjectCatalogError(
            `请先停止项目中的${what}，再${change}${name ? `（会话「${name}」）` : ""}`,
            409
          );
        // eslint-disable-next-line no-restricted-syntax -- 接管失败只表示这里不认识该进程，后续的活进程检查仍会读心跳与执行记录
        const resident = await adoptResidentMain(taskId, location).catch(() => undefined);
        // A resident Main between turns is not activity: stop it so the folder
        // change can fork the session, exactly as an edit does. A turn that is
        // still producing an answer keeps the refusal.
        if (resident) {
          if (await taskTurnActive(taskId)) throw refuse("会话及后台工作");
          await stopResidentMain(taskId, { replacing: true });
        }
        if (
          activeRuns.has(taskId) ||
          // The adopted resident was stopped above; a record this backend did
          // not stop is still an owner.
          residentMains.has(taskId) ||
          taskFinalizations.has(taskId) ||
          // Paused and waiting runs have nothing working: they wait for the
          // person to continue. What could still be working — a park, a live
          // process, a Subagent or a job — is checked on its own below.
          location.task.status === "running" ||
          // eslint-disable-next-line no-restricted-syntax -- 停泊记录损坏时按未停泊处理，读不出的记录不冒充活动中的会话
          (await readSleep(location.workspaceRoot, taskId).catch(() => undefined)) ||
          (await projectExecutionIsAlive(location.workspaceRoot, taskId))
        )
          throw refuse("会话及后台工作");
        const privateAgents = join(location.workspaceRoot, taskId, "agents", "subagents");
        // eslint-disable-next-line no-restricted-syntax -- 没有 subagents 目录表示该会话没有私有子代理，按空列表继续检查
        for (const agent of await readdir(privateAgents).catch(() => [])) {
          if (
            (await listJobs({ directory: join(privateAgents, agent, "logs", "jobs") })).some(
              (job) => job.state === "running"
            )
          )
            throw refuse("后台命令");
        }
        const runIds = await readdir(join(location.workspaceRoot, taskId, "runs")).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          }
        );
        for (const runId of runIds) {
          const coordination = await coordinator.waitForSubagents({
            taskId,
            runId,
            workspaceRoot: location.workspaceRoot,
            timeoutMs: 0
          });
          // Only a Subagent still working holds the project. A finished one's
          // result waiting for a stopped Main is a record, not activity: it
          // stays in the Inbox and reaches Main when the conversation resumes.
          if (coordination.pending.length) throw refuse("后台协作");
          const agents = join(location.workspaceRoot, taskId, "runs", runId, "agents");
          // eslint-disable-next-line no-restricted-syntax -- 该 Run 可能从未启动子代理，subagents 目录缺失按空列表继续
          const subagents = await readdir(join(agents, "subagents")).catch(() => []);
          for (const agent of [
            join(agents, "main"),
            ...subagents.map((subagent) => join(agents, "subagents", subagent))
          ]) {
            if ((await listJobs({ directory: join(agent, "jobs") })).some((job) => job.state === "running"))
              throw refuse("后台命令");
          }
        }
      }
      return action();
    }
    return lockTasks(0);
  }

  function compactMainContext(taskId: string) {
    return withTaskProjectLock(taskId, () =>
      serialize(taskId, async () => {
        await taskFinalizations.get(taskId);
        const location = await locateTask(taskId);
        const { task, workspaceRoot } = location;
        const resident = await adoptResidentMain(taskId, location);
        if (resident) {
          const { runId } = resident;
          const messageId = `compact-${randomUUID()}`;
          await new InboxStore(
            join(workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
          ).enqueue({
            messageId,
            recipientAgentId: "main",
            kind: "human_command",
            eventId: messageId,
            priority: 130,
            state: "ready",
            payload: { type: "main.compact" },
            createdAt: now()
          });
          return { queued: true };
        }
        if (activeRuns.has(taskId) || mainIsAlive(await readHeartbeat(workspaceRoot, taskId)))
          return { error: "会话由另一个 Main 进程持有，请在该进程中换窗口。" };
        const { session } = await currentMainSession(workspaceRoot, taskId);
        if (!session) return { error: "发送第一条消息后可换窗口。" };
        const usage = await readJsonFile<SessionContextUsage | null>(
          mainContextUsagePath(workspaceRoot, taskId),
          null
        );
        const file = session.getSessionFile();
        const selection = resolveMainModel({
          ...(task.projectDirectory ? { projectDirectory: task.projectDirectory } : {}),
          taskModel: task.model
        });
        const compacted = await compactStoredMainSession(
          session,
          {
            workspaceRoot,
            taskId,
            runId: task.activeRunId,
            ...(task.projectId &&
              readWindowDevelopment && { readDevelopment: () => readWindowDevelopment(taskId) })
          },
          usage && file && usage.sessionFile === basename(file) ? usage.contextWindow : undefined,
          withFallbackModel(utilitySummaryModel(), {
            complete: roleCompletion(selection),
            contextWindow: selection.profile.contextWindow
          })
        );
        return compacted ? { queued: false } : { error: "发送第一条消息后可换窗口。" };
      })
    );
  }

  /**
   * Ask Main to pause: its Subagents first, then itself.
   *
   * The request is durable on the Task record. A turn in flight reads it at
   * its next tool/model boundary; a Main between turns (waiting for its
   * Subagents) is sent a `main.pause` command and takes it at once. Either
   * way Main's runtime holds the Run's Subagents at the end of their current
   * step before it records the pause (see `subagent-pause.ts`).
   */
  function pauseTask(taskId: string) {
    return serialize(taskId, async () => {
      const location = await locateTask(taskId);
      if (location.task.status === "paused") return { task: location.task };
      // Take over a Main the previous backend left running before deciding
      // whether a turn is in flight.
      if (!(await adoptResidentMain(taskId, location))) return { refused: "no_active_run" as const };
      const runId = location.task.activeRunId;
      if (!["running", "waiting"].includes(location.task.status) || !runId)
        return { refused: "no_active_run" as const };
      if (location.task.pause) return { task: location.task };
      const task = await location.store.updateTask(taskId, {
        pause: { requestedAt: new Date().toISOString(), requestedBy: "user" }
      });
      await appendRunEvent(location.workspaceRoot, taskId, runId, "main.run_pause_requested", {
        reason: "ui_pause"
      });
      if (!(await taskTurnActive(taskId))) {
        const messageId = `main-pause-${randomUUID()}`;
        await new InboxStore(
          join(location.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
        ).enqueue({
          messageId,
          recipientAgentId: "main",
          kind: "human_command",
          eventId: `main-pause-event-${messageId}`,
          priority: 110,
          state: "ready",
          payload: { type: "main.pause" },
          createdAt: now()
        });
      }
      return { task };
    });
  }

  /**
   * Stop the round: Main's turn and every Subagent still working, at once.
   *
   * Nothing is asked of Main here. The backend cancels the Run's working
   * Subagents itself (the same cancel closing a session uses, but the
   * session stays open), drops a pause that has not taken effect, and aborts
   * the turn Main is producing where Pi next checks its signal. Finished steps
   * and results stay. A cancelled Subagent's callback does not start a turn of
   * its own (see `main-inbox-delivery.ts` and `main-supervisor.ts`), so the
   * stopped round is not woken again by its own Subagents.
   */
  function stopTask(taskId: string) {
    return serialize(taskId, async () => {
      const location = await locateTask(taskId);
      if (location.task.status === "paused") return { refused: "paused" as const };
      // The adopted process reports its turn through the durable heartbeat;
      // a process this backend observes reports its event stream.
      // eslint-disable-next-line no-restricted-syntax -- 接管失败时仍按持久回合记录判断，消息留给下一个 Main 读取
      const resident = await adoptResidentMain(taskId, location).catch(() => undefined);
      const runId = resident?.runId ?? location.task.activeRunId;
      if (!runId) return { refused: "no_active_turn" as const };
      const turnActive = await taskTurnActive(taskId);
      const coordination = await coordinator.waitForSubagents({
        taskId,
        runId,
        workspaceRoot: location.workspaceRoot,
        timeoutMs: 0
      });
      if (!turnActive && !coordination.pending.length) return { refused: "no_active_turn" as const };
      // A pause still waiting for its boundary would otherwise be recorded
      // when the aborted turn settles.
      if (location.task.pause) await location.store.updateTask(taskId, { pause: undefined });
      await appendRunEvent(location.workspaceRoot, taskId, runId, "main.run_stopped", {
        reason: "ui_stop",
        subagents: coordination.pending.length
      });
      await resumeSubagents(location.workspaceRoot, taskId, runId);
      if (subagents) {
        const results = await Promise.allSettled(
          coordination.pending.map((callId) =>
            subagents.cancel({ taskId, runId, callId, reason: "User stopped the round" })
          )
        );
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
      }
      if (turnActive) {
        const messageId = `main-interrupt-${randomUUID()}`;
        await new InboxStore(
          join(location.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
        ).enqueue({
          messageId,
          recipientAgentId: "main",
          kind: "human_command",
          eventId: `main-interrupt-event-${messageId}`,
          // Ahead of callbacks and external events, but behind a user insertion
          // enqueued before it: the person's message belongs to the turn the
          // stop then ends, not to a fresh turn after it.
          priority: 110,
          state: "ready",
          payload: { type: "main.interrupt" },
          createdAt: now()
        });
        await appendRunEvent(location.workspaceRoot, taskId, runId, "main.interrupt_requested", {
          messageId
        });
      }
      return { taskId, runId, stopped: true, subagents: coordination.pending.length };
    });
  }

  function cancelTask(taskId: string) {
    return serialize(taskId, async () => {
      const location = await locateTask(taskId);
      onTaskCancelling(taskId);
      const settleCancellation = async (task: TaskRecord) => {
        const cancelledRunId = location.task.activeRunId;
        if (cancelledRunId) await finalizeSessionRun({ ...location, task }, cancelledRunId, "cancelled");
        return task;
      };
      cancellations.add(taskId);
      // eslint-disable-next-line no-restricted-syntax -- 取消要继续停止进程，容量队列清理失败由进程退出时的 release 承接
      await mainCapacity?.cancelTask(taskId).catch(() => {});
      humanWakeups.delete(taskId);
      try {
        // Closing is the destructive management action: it must reach a Main
        // the startup sweep has not taken over yet (or could not), so adoption
        // is resolved here instead of trusting the in-memory map.
        const resident = await adoptResidentMain(taskId, location).catch((error) => {
          console.error(
            `[formicand] resolving the Main to close for ${taskId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return undefined;
        });
        if (location.task.status === "completed") {
          const runId = resident?.runId ?? activeRunIds.get(taskId);
          // A finished Task whose resident Main is idle keeps its completed
          // outcome; closing only ends that process. A turn still producing
          // the final response is a provisional completion, so cancelling it
          // takes the ordinary terminal path below.
          if (resident && (await taskTurnActive(taskId)) !== true) {
            await stopResidentMain(taskId);
            return await settleCancellation((await locateTask(taskId)).task);
          }
          if (!runId || !(await prepareRunTransition(location, runId, "cancelled")))
            return await settleCancellation(location.task);
        }
        let failed = false;
        let failure: unknown;
        const attempt = async (action: () => Promise<unknown>) => {
          try {
            await action();
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        };
        // A persistence failure must not skip cancellation or process cleanup;
        // retain its original cause even when a later cleanup attempt also fails.
        await attempt(async () => {
          await location.store.transitionTask(taskId, "cancelled", { reason: "ui_cancel" });
          if (location.task.activeRunId)
            await appendRunEvent(
              location.workspaceRoot,
              taskId,
              location.task.activeRunId,
              "main.run_cancelled",
              { reason: "ui_cancel" }
            );
        });
        await attempt(() => clearSleep(location.workspaceRoot, taskId));
        // End the session before its delegated work settles: the settlement
        // callback is durable, and a Main still watching its Inbox would start
        // a turn from it and reopen the Task that was just closed.
        await attempt(() => stopResidentMain(taskId));
        await attempt(async () => {
          await taskFinalizations.get(taskId);
        });
        await attempt(async () => {
          if (location.task.activeRunId) {
            const coordination = await coordinator.waitForSubagents({
              taskId,
              runId: location.task.activeRunId,
              workspaceRoot: location.workspaceRoot,
              timeoutMs: 0
            });
            // Delegated processes belong to the backend that launched them;
            // without one there is no process this host could stop, so the
            // durable queue row is the only thing left to settle.
            const results = subagents
              ? await Promise.allSettled(
                  coordination.pending.map((call) =>
                    subagents.cancel({
                      taskId,
                      runId: location.task.activeRunId!,
                      callId: call,
                      reason: "User stopped the task"
                    })
                  )
                )
              : [];
            const rejected = results.find((result) => result.status === "rejected");
            if (rejected?.status === "rejected") throw rejected.reason;
          }
        });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- failed 由 attempt 的 catch 回调置位，TS 在读取处看不到这次闭包写入
        if (failed) throw failure;
        return await settleCancellation((await locateTask(taskId)).task);
      } finally {
        cancellations.delete(taskId);
      }
    });
  }

  return { withIdleProjectTasks, compactMainContext, pauseTask, stopTask, cancelTask };
}
