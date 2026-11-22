import {
  latestEditableMessage,
  readMessageVersions,
  messageVersionSummaries,
  readArchivedMessageVersion,
  versionRuntimeEvents
} from "../runtime/main-message-edit.js";
import { basename, join } from "node:path";
import { mainContextUsagePath, type SessionContextUsage } from "../runtime/session-context-usage.js";
import { conversationWindows } from "../runtime/session-handoff.js";
import {
  messagesWithRuntimeHistory,
  readTaskRuntimeEvents,
  settledRuntimeEvents,
  viewRuntimeEvent
} from "../runtime/conversation-history.js";
import { conversationMessages } from "../runtime/conversation-view.js";
import { MainRequestStore, mainRequestPath } from "../storage/main-request-store.js";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { listJobs } from "../tools/jobs.js";
import { HumanRequestStore } from "../runtime/human.js";
import { readSubagentProgress } from "../runtime/progress.js";
import { readRunStatistics } from "../runtime/run-statistics.js";
import { listTaskArtifacts } from "../workspace/artifact-store.js";

import { readJsonFile, readJsonLines } from "./event-stream.js";
import { mainIsAlive, readHeartbeat } from "../runtime/main-heartbeat.js";
import { readSleep } from "../runtime/main-sleep.js";
import { createModelSettings } from "./model-settings.js";
import { projectRoleSettings, resolveModelRole } from "../runtime/role-models.js";
import { createWorkspaceDirectory } from "./workspace-directory.js";
import { HttpError } from "./http.js";
import { copyMainConversation } from "../runtime/conversation-fork.js";

import type { CoworkConfig } from "../runtime/config.js";
import type { RunService } from "./run-service.js";

type WorkspaceDirectory = ReturnType<typeof createWorkspaceDirectory>;

export function createTaskConversationService({
  workspaces,
  coordinator,
  runs,
  runtimeConfig,
  runtimeValue,
  modelSettings
}: {
  workspaces: Pick<
    WorkspaceDirectory,
    "locateTask" | "taskListItem" | "createProjectTask" | "createTemporaryTask"
  >;
  coordinator: Pick<CoordinatorRuntime, "waitForSubagents">;
  runs: Pick<RunService, "taskTurnActive" | "mainProcessRunning" | "pendingHumanAnswers" | "cancellations">;
  runtimeConfig: Pick<CoworkConfig, "modelProviders">;
  runtimeValue: () => string | undefined;
  modelSettings: Pick<ReturnType<typeof createModelSettings>, "config">;
}) {
  const { locateTask, taskListItem } = workspaces;
  const { pendingHumanAnswers } = runs;

  /**
   * A new conversation beside the source, in the same project (or temporary
   * folder), that starts from one reply's history. Only the transcript is
   * copied; the new conversation is settled, so its last reply reads as the
   * answer and the next message continues from it.
   */
  async function forkConversation(
    sourceTaskId: string,
    input: { taskId: string; messageId: string; title?: string }
  ) {
    const source = await locateTask(sourceTaskId);
    const metadata = { goal: source.task.goal };
    const temporaryRoot = source.task.temporaryWorkspaceRoot;
    if (temporaryRoot) await workspaces.createTemporaryTask(input.taskId, metadata, temporaryRoot);
    else await workspaces.createProjectTask(input.taskId, source.projectId, metadata);
    const target = await locateTask(input.taskId);
    try {
      const copied = await copyMainConversation(
        { root: source.workspaceRoot, taskId: sourceTaskId },
        { root: target.workspaceRoot, taskId: input.taskId },
        input.messageId
      );
      if (!copied) throw new HttpError(404, "这条回复已不在当前会话里，无法 Fork。");
      if (input.title) await target.store.updateTask(input.taskId, { title: input.title });
      // A Task leaves "created" only through a run; the copy stands for one.
      await target.store.transitionTask(input.taskId, "running", { reason: "conversation_fork" });
      await target.store.transitionTask(input.taskId, "completed", { reason: "conversation_fork" });
    } catch (error) {
      await target.store.deleteTask(input.taskId);
      throw error;
    }
    return taskListItem(await locateTask(input.taskId));
  }

  async function taskDetails(taskId: string): Promise<unknown> {
    // A run may settle while the slower history reads are in progress. Keep
    // that snapshot active instead of pairing stale task data with an idle run.
    // A resident Main is alive while it is idle; "active" is about a turn.
    const activeAtStart = await runs.taskTurnActive(taskId);
    const location = await locateTask(taskId);
    const { task } = location;
    const taskWorkspace = location.workspaceRoot;
    const runId = task.activeRunId;
    // The page reads the calls, not how long this zero-timeout check took: a
    // timing that differed on every read made each poll redraw the conversation.
    const { waitedMs: _waited, ...coordination } = runId
      ? await coordinator.waitForSubagents({ taskId, runId, workspaceRoot: taskWorkspace, timeoutMs: 0 })
      : { calls: [], pending: [], callbackPending: [], timedOut: false, waitedMs: 0 };
    const events = runId
      ? await readJsonLines(join(taskWorkspace, taskId, "runs", runId, "run_events.jsonl"), 30)
      : [];
    const messageVersions = await readMessageVersions(taskWorkspace, taskId);
    const contextUsage = await readJsonFile<SessionContextUsage | null>(
      mainContextUsagePath(taskWorkspace, taskId),
      null
    );
    const runtimeEvents = versionRuntimeEvents(
      await readTaskRuntimeEvents(taskWorkspace, taskId),
      messageVersions
    );
    const artifacts = await listTaskArtifacts({ workspaceRoot: taskWorkspace, taskId, runId });
    const sessionEntries = await readJsonFile(
      join(taskWorkspace, taskId, "agents", "main", "context", "messages.json"),
      []
    );
    const messages = messagesWithRuntimeHistory(conversationMessages(sessionEntries), runtimeEvents);
    const progress = runId
      ? // eslint-disable-next-line no-restricted-syntax -- 进度只是详情里的可选项，读取失败按无进度返回
        await readSubagentProgress({ taskId, runId, workspaceRoot: taskWorkspace }).catch(() => null)
      : null;
    const jobs = runId
      ? await listJobs({
          directory: join(taskWorkspace, taskId, "runs", runId, "agents", "main", "jobs")
          // eslint-disable-next-line no-restricted-syntax -- 作业目录要到第一个后台调用才创建，缺失时按空列表展示
        }).catch(() => [])
      : [];
    const heartbeat = await readHeartbeat(taskWorkspace, taskId);
    const mainRunning = runs.mainProcessRunning(taskId) || mainIsAlive(heartbeat);
    const active = activeAtStart;
    let damagedRetry = false;
    const requestStore = new MainRequestStore(mainRequestPath(taskWorkspace, taskId), taskId);
    const retry =
      !active && ["failed", "waiting"].includes(task.status)
        ? // eslint-disable-next-line no-restricted-syntax -- 请求记录损坏时置 damagedRetry，由 retryRequestUnavailable 告知前端需要重发
          await requestStore.pending().catch(() => {
            damagedRetry = true;
            return undefined;
          })
        : undefined;
    const retryRequest =
      retry && retry.taskId === taskId && retry.runId === runId && retry.state !== "completed"
        ? { requestId: retry.requestId, model: retry.model.id }
        : undefined;
    const lastFailure = [...events].reverse().find((event) => event.type === "main.run_failed")?.payload as
      { failure?: { kind?: string } } | undefined;
    const retryRequestUnavailable =
      !active &&
      ["failed", "waiting"].includes(task.status) &&
      !retryRequest &&
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- damagedRetry 在上面的 catch 回调里赋值，TS 在读取处看不到这次写入
      (damagedRetry || lastFailure?.failure?.kind === "model_request");
    const statistics = await readRunStatistics({ workspaceRoot: taskWorkspace, task, active });
    const humanRequests = await new HumanRequestStore(taskWorkspace).list(taskId);
    // eslint-disable-next-line no-restricted-syntax -- 停泊记录缺失或损坏按未停泊展示，任务详情仍要返回其余字段
    const parked = await readSleep(taskWorkspace, taskId).catch(() => undefined);
    const humanResumePending =
      !active &&
      task.status !== "cancelled" &&
      !humanRequests.some((request) => request.status === "pending") &&
      (await pendingHumanAnswers(taskWorkspace, taskId, runId)).length > 0;
    let editableMessage;
    let editableMessageError;
    try {
      editableMessage = (await latestEditableMessage(taskWorkspace, taskId, runId))?.target;
      // eslint-disable-next-line no-restricted-syntax -- 校验失败的原因已经由 editableMessageError 反馈给用户，历史消息保留
    } catch {
      editableMessageError = "原消息或附件记录无法校验，历史已保留，请重新添加有效附件并主动发送新消息。";
    }
    return {
      task: await taskListItem(location),
      workspaceRoot: location.projectDirectory,
      storageRoot: taskWorkspace,
      projectId: location.projectId,
      projectName: location.projectName,
      projectDirectory: location.projectDirectory,
      coordination,
      events,
      runtimeEvents: settledRuntimeEvents(runtimeEvents).map(viewRuntimeEvent),
      artifacts,
      messages,
      contextWindows: conversationWindows(sessionEntries),
      editableMessage,
      ...(editableMessageError ? { editableMessageError } : {}),
      conversationVersions: messageVersionSummaries(messageVersions),
      conversationVersion: messageVersions?.versionId,
      contextUsage:
        !messageVersions || contextUsage?.sessionFile === basename(messageVersions.sessionFile)
          ? contextUsage && {
              tokens: contextUsage.tokens,
              contextWindow: contextUsage.contextWindow,
              window: contextUsage.window
            }
          : null,
      retryRequest,
      ...(retryRequestUnavailable ? { retryRequestUnavailable: true } : {}),
      progress,
      statistics,
      humanRequests,
      jobs: jobs.map(({ jobId, state, exitCode, signal, logPath }) => ({
        jobId,
        state,
        exitCode,
        signal,
        logPath
      })),
      humanResumePending,
      ...(parked ? { parked: { wakeAt: parked.wakeAt, reason: parked.reason } } : {}),
      runtime: {
        active,
        /** A resident Main process exists for this Task, idle or working. */
        mainRunning,
        stopping: runs.cancellations.has(taskId),
        model:
          active || !runtimeConfig.modelProviders
            ? task.model || runtimeValue()
            : idleMainModel(task.projectDirectory)
      }
    };
  }

  /** The model the next Main run of a Task in this project uses: the project's own, else the host's. */
  function idleMainModel(projectDirectory: string | undefined): string | undefined {
    const config = modelSettings.config();
    if (!projectDirectory || !projectRoleSettings(config, "main", projectDirectory)?.profileId)
      return runtimeValue();
    return resolveModelRole(config, { role: "main", projectDirectory }).model;
  }

  async function messageVersion(taskId: string, versionId: string) {
    const location = await locateTask(taskId);
    return readArchivedMessageVersion(location.workspaceRoot, taskId, versionId);
  }

  return { taskDetails, forkConversation, messageVersion };
}
