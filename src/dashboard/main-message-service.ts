import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  latestEditableMessage,
  rejectAcceptedMainMessage,
  readMessageVersions,
  MainMessageEditConflict,
  type MessageEditRequest,
  type EditTextFile
} from "../runtime/main-message-edit.js";
import { inputPrompt, readTaskInput } from "../workspace/input-store.js";
import { queuedUserTurn } from "../runtime/queued-user-turn.js";
import { MainInboxDelivery } from "../runtime/main-inbox-delivery.js";
import { mainContextPaths } from "../runtime/main-context.js";
import { mainInputPath, readMainInput } from "../runtime/main-continuation.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HumanRequestStore } from "../runtime/human.js";
import { InboxStore } from "../runtime/scheduler.js";
import { now } from "../domain/types.js";
import {
  type RunServicePorts,
  type InterjectionTarget,
  type LaunchMainRun,
  type SerializeTask
} from "./run-service-contracts.js";
import type { createResidentMainRegistry } from "./resident-main-registry.js";

export function createMainMessageService({
  withTaskProjectLock,
  serialize,
  locateTask,
  taskFinalizations,
  taskTurnActive,
  adoptResidentMain,
  stopResidentMain,
  uploads,
  launchMainRun,
  residentMain,
  activeRuns,
  residentFor,
  interjectionTargets,
  isStopping,
  activeRunIds,
  appendRunEvent,
  readJsonFile
}: {
  withTaskProjectLock: NonNullable<RunServicePorts["withTaskProjectLock"]>;
  serialize: SerializeTask;
  locateTask: RunServicePorts["locateTask"];
  taskFinalizations: Map<string, Promise<void>>;
  taskTurnActive: ReturnType<typeof createResidentMainRegistry>["taskTurnActive"];
  adoptResidentMain: ReturnType<typeof createResidentMainRegistry>["adoptResidentMain"];
  stopResidentMain: ReturnType<typeof createResidentMainRegistry>["stopResidentMain"];
  uploads: RunServicePorts["uploads"];
  launchMainRun: LaunchMainRun;
  residentMain: ReturnType<typeof createResidentMainRegistry>["residentMain"];
  activeRuns: Map<string, ChildProcess>;
  residentFor: ReturnType<typeof createResidentMainRegistry>["residentFor"];
  interjectionTargets: Map<string, InterjectionTarget>;
  isStopping: () => boolean;
  activeRunIds: Map<string, string>;
  appendRunEvent: RunServicePorts["appendRunEvent"];
  readJsonFile: RunServicePorts["readJsonFile"];
}) {
  function editMainMessage(
    taskId: string,
    request: MessageEditRequest,
    body: string,
    attachmentIds: string[],
    model?: string,
    textAttachments: EditTextFile[] = [],
    references = ""
  ) {
    return withTaskProjectLock(taskId, () =>
      serialize(taskId, async () => {
        const location = await locateTask(taskId);
        const versions = await readMessageVersions(location.workspaceRoot, taskId);
        const repeated = versions?.edits.find((edit) => edit.editId === request.editId);
        if (repeated) {
          const input = await readMainInput(mainInputPath(location.workspaceRoot, taskId, repeated.runId));
          if (
            JSON.stringify(repeated.target) !== JSON.stringify(request) ||
            input?.body !== body ||
            JSON.stringify(attachmentIds) !== JSON.stringify(input.attachmentIds) ||
            JSON.stringify(textAttachments) !== JSON.stringify(input.textAttachments ?? [])
          )
            throw new MainMessageEditConflict("该重发标识已用于其他输入，请刷新后重试。");
          return {
            taskId,
            runId: repeated.runId,
            status: location.task.status,
            model: location.task.model || ""
          };
        }
        await taskFinalizations.get(taskId);
        // An edit rewrites the session behind a Main. A turn that is still
        // producing an answer is not editable: stopping it to rewrite its
        // transcript would discard work the person never cancelled. An idle
        // process — or one parked on a durable question — is stopped and
        // relaunched on the edited version, which is what keeps editing
        // possible now that the process outlives its turns.
        if (
          (await taskTurnActive(taskId)) &&
          (await new HumanRequestStore(location.workspaceRoot).list(taskId, "pending")).length === 0
        )
          throw new MainMessageEditConflict("当前回合仍在运行，请先停止或等待它结束后再修改重发。");
        if (location.task.activeRunId !== request.runId)
          throw new MainMessageEditConflict("请先停止当前运行并等待停止完成，再修改重发。");
        // An edit stops the process that owns the session, whether this
        // backend started it or took it over after a restart.
        if (await adoptResidentMain(taskId, location)) await stopResidentMain(taskId, { replacing: true });
        const source = await latestEditableMessage(location.workspaceRoot, taskId, request.runId);
        if (
          !source ||
          source.target.messageId !== request.messageId ||
          source.target.versionId !== request.versionId ||
          source.target.scopeToken !== request.scopeToken
        )
          throw new MainMessageEditConflict("可编辑的消息或会话版本已变化，编辑内容仍保留，请刷新后重试。");
        const files = [];
        for (const uploadId of [...new Set(attachmentIds)]) {
          if (source.target.attachments.some((file) => "uploadId" in file && file.uploadId === uploadId))
            files.push((await readTaskInput(join(location.workspaceRoot, taskId), uploadId)).file);
          else {
            if (!uploads) throw new Error("附件服务不可用");
            files.push(...(await uploads.attach(location.workspaceRoot, taskId, [uploadId])));
          }
        }
        const inline = textAttachments.length
          ? `\n\nAttached files:\n${textAttachments.map((file) => `--- ${file.name} ---\n${file.text}`).join("\n\n")}`
          : "";
        const typed =
          (body.trim() ? body : "") + inline + inputPrompt(join(location.workspaceRoot, taskId), files);
        const prompt = typed.trim() ? references + typed : typed;
        if (!prompt.trim()) throw new Error("请输入消息或保留至少一个附件。");
        let rollback: (() => Promise<void>) | undefined;
        let acceptedMessageId: string | undefined;
        try {
          return await launchMainRun(taskId, prompt, `main-edit-${randomUUID()}`, false, model, undefined, {
            body,
            edit: request,
            attachmentIds,
            textAttachments,
            onAcceptedInput: (messageId) => {
              acceptedMessageId = messageId;
            },
            onPrepared: (restore) => {
              rollback = restore;
            }
          });
        } catch (error) {
          if (rollback && !residentMain(taskId) && !activeRuns.has(taskId)) {
            if (acceptedMessageId)
              await rejectAcceptedMainMessage(location.workspaceRoot, taskId, acceptedMessageId);
            await rollback();
            const task = location.task;
            await location.store.updateTask(taskId, {
              activeRunId: task.activeRunId,
              goal: task.goal,
              model: task.model
            });
            const current = await location.store.readTask(taskId);
            if (current.status !== task.status)
              await location.store.transitionTask(taskId, task.status, {
                runId: task.activeRunId,
                reason: "message_edit_launch_rollback"
              });
          }
          throw error;
        }
      })
    );
  }

  async function interjectionTarget(taskId: string): Promise<InterjectionTarget | undefined> {
    // A resident Main is reachable while its entry exists, whether this
    // backend spawned it or took it over from the previous backend.
    if (!(await residentFor(taskId))) return;
    return interjectionTargets.get(taskId);
  }

  function queueInterjection(
    taskId: string,
    target: InterjectionTarget,
    message: string,
    delivery: "steer" | "followUp"
  ) {
    return serialize(taskId, async () => {
      await taskFinalizations.get(taskId);
      const location = await locateTask(taskId);
      // Keep the identity captured when the request entered the route. Reading
      // its body may span a stop or a whole new Run, which must not receive it.
      if (
        isStopping() ||
        residentMain(taskId)?.runId !== target.runId ||
        interjectionTargets.get(taskId) !== target ||
        activeRunIds.get(taskId) !== target.runId ||
        location.task.activeRunId !== target.runId ||
        location.task.status === "cancelled"
      )
        return { error: "该消息所属回合已结束或变更，请确认当前会话后重新发送。" };
      if (!message) throw new Error("message must not be empty");
      if (message.includes("\0") || Buffer.byteLength(message, "utf8") > 512 * 1024)
        throw new Error("补充消息包含二进制字符或超过 512 KB");
      const inbox = new InboxStore(
        join(location.workspaceRoot, taskId, "runs", target.runId, "agents", "main", "inbox-store.json")
      );
      const messageId = `user-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = now();
      await inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `user-message-event-${messageId}`,
        priority: 120,
        state: "ready",
        payload: { type: "human.message", message, delivery },
        createdAt
      });
      await appendRunEvent(location.workspaceRoot, taskId, target.runId, "user.interjected", {
        message,
        messageId,
        delivery,
        createdAt
      });
      return { taskId, runId: target.runId, messageId, delivered: true, delivery };
    });
  }

  function queuedMessageAction(taskId: string, messageId: string, action: "send" | "cancel") {
    return withTaskProjectLock(taskId, () =>
      serialize(taskId, async () => {
        await taskFinalizations.get(taskId);
        const location = await locateTask(taskId);
        const currentRunId = location.task.activeRunId;
        if (!currentRunId) return { error: "这条消息已不在队列中。" };
        const active = (await adoptResidentMain(taskId, location)) !== undefined;
        // A process can exit between saving its first prompt and acknowledging it.
        if (!active)
          await new MainInboxDelivery(location.workspaceRoot, taskId, currentRunId).acknowledge(
            await readJsonFile(mainContextPaths(location.workspaceRoot, taskId).messages, [])
          );
        const directory = join(location.workspaceRoot, taskId, "runs");
        const runs = await readdir(directory, { withFileTypes: true });
        for (const runId of [
          currentRunId,
          ...runs
            .filter((entry) => entry.isDirectory() && entry.name !== currentRunId)
            .map((entry) => entry.name)
        ]) {
          const inbox = new InboxStore(join(directory, runId, "agents", "main", "inbox-store.json"));
          const message = (await inbox.list("main")).find((entry) => entry.messageId === messageId);
          const payload = message?.payload as
            { type?: string; message?: string; delivery?: string; cancelled?: boolean } | undefined;
          if (
            !message ||
            message.kind !== "human_command" ||
            payload?.type !== "human.message" ||
            typeof payload.message !== "string"
          )
            continue;
          if (!active && message.state === "leased") await inbox.release(messageId);
          if (action === "cancel") {
            if (!(await inbox.cancelUserMessage(messageId)))
              return { error: "这条消息已开始处理，无法取消。" };
            await appendRunEvent(location.workspaceRoot, taskId, runId, "user.message_cancelled", {
              messageId
            });
            return { taskId, messageId, cancelled: true };
          }
          if (payload.cancelled) return { error: "这条消息已取消。" };
          if (message.state === "consumed")
            return { taskId, runId: currentRunId, messageId, delivery: "steer" };
          // Our resumed prompt already owns this message; a repeated click is a no-op.
          if (active && message.state === "leased" && message.lease?.consumerId.startsWith("queue-resume-"))
            return { taskId, runId: currentRunId, messageId, delivery: "steer" };
          if (active && runId === currentRunId) {
            if (!(await inbox.promoteUserMessage(messageId)))
              return { error: "这条消息已开始处理或不在当前队列中。" };
            await appendRunEvent(location.workspaceRoot, taskId, runId, "user.message_promoted", {
              messageId,
              delivery: "steer"
            });
            return { taskId, runId: currentRunId, messageId, delivery: "steer" };
          }
          const consumer = `queue-resume-${messageId}`;
          const leased = await inbox.leaseMessage("main", messageId, 60_000, consumer);
          if (leased?.state !== "leased" || leased.lease?.consumerId !== consumer)
            return { error: "这条消息已开始处理，请稍后刷新。" };
          try {
            if (active) {
              // A remaining message can belong to an older run. Transfer its identity,
              // not a copy with a new id, into the currently running inbox.
              const target = new InboxStore(
                join(directory, currentRunId, "agents", "main", "inbox-store.json")
              );
              await target.enqueue({
                ...message,
                state: "ready",
                lease: undefined,
                payload: { ...payload, delivery: "steer" }
              });
              await inbox.consume(messageId);
              await appendRunEvent(location.workspaceRoot, taskId, runId, "user.message_promoted", {
                messageId,
                delivery: "steer"
              });
              return { taskId, runId: currentRunId, messageId, delivery: "steer" };
            }
            const result = await launchMainRun(
              taskId,
              queuedUserTurn({ taskId, runId, messageId, text: payload.message }),
              currentRunId,
              true,
              undefined,
              undefined,
              { origin: "internal", queueWhenFull: true }
            );
            // The first saved context acknowledges the durable message. Until then
            // its lease prevents the normal inbox poll from delivering it twice.
            return { ...result, messageId, delivery: "steer" };
          } catch (error) {
            await inbox.release(messageId);
            throw error;
          }
        }
        return { error: "这条消息已不在队列中。" };
      })
    );
  }

  return { editMainMessage, interjectionTarget, queueInterjection, queuedMessageAction };
}
