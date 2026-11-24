import { randomUUID } from "node:crypto";
import { saveAcceptedMainMessage } from "../runtime/main-message-edit.js";
import { readQueuedUserTurn } from "../runtime/queued-user-turn.js";
import { mainInputPath, saveMainInput, type MainInput } from "../runtime/main-continuation.js";
import { join } from "node:path";
import { HumanRequestStore } from "../runtime/human.js";
import { InboxStore } from "../runtime/scheduler.js";
import { normalizeReasoningEffort } from "../runtime/runtime-settings.js";
import { now, type TaskRecord } from "../domain/types.js";
import type { TaskLocation } from "./workspace-directory.js";
import {
  type RunServicePorts,
  type MainLaunchSubmission,
  type InterjectionTarget
} from "./run-service-contracts.js";
import { type ResidentMain, residentProcessAlive } from "./resident-main.js";
import type { createResidentMainRegistry } from "./resident-main-registry.js";

export function createResidentMainTurnDelivery({
  residentMain,
  normalizeModel,
  resolveMainModel,
  pendingTurns,
  appendRunEvent,
  interjectionTargets
}: {
  residentMain: ReturnType<typeof createResidentMainRegistry>["residentMain"];
  normalizeModel: RunServicePorts["normalizeModel"];
  resolveMainModel: RunServicePorts["resolveMainModel"];
  pendingTurns: Map<string, number>;
  appendRunEvent: RunServicePorts["appendRunEvent"];
  interjectionTargets: Map<string, InterjectionTarget>;
}) {
  /**
   * Hand one turn to the Main that is already serving this Task.
   *
   * The process stays for its whole Run, so a later message is queued in its
   * own Inbox rather than starting a second process. Returning `undefined`
   * means this request needs a new process (an edit, a retry, another model,
   * or a process that is already gone); the caller starts one.
   */
  async function deliverResidentTurn(input: {
    resident: ResidentMain;
    task: TaskRecord;
    location: TaskLocation;
    prompt: string;
    continuation: boolean;
    submission?: MainLaunchSubmission;
    requestedModel?: string;
    messageId: string;
  }): Promise<
    | { taskId: string; runId: string; status: "running" | "paused"; model: string; sessionId?: string }
    | undefined
  > {
    const { resident, task, location, prompt, continuation, submission, messageId } = input;
    if (residentMain(resident.taskId) !== resident) return undefined;
    if (resident.runId !== (task.activeRunId ?? resident.runId)) return undefined;
    if (task.status === "cancelled" || task.status === "failed") return undefined;
    if (!resident.observed && !(await residentProcessAlive(resident.record))) {
      // The record names the launcher this process was started as; when that
      // identity is gone the adoption path settles the exit instead of a
      // message being queued behind a dead reader. The heartbeat is only the
      // turn state: a process that just started has not written one yet.
      return undefined;
    }
    if (input.requestedModel && normalizeModel(input.requestedModel) !== (task.model || "")) return undefined;
    // Another provider, or back to the host's own connection, needs a process
    // started on that connection.
    const wanted = submission?.profileId
      ? (resolveMainModel({ profileId: submission.profileId }).connectionId ?? submission.profileId)
      : undefined;
    if (wanted !== resident.pinnedConnection) return undefined;
    if (prompt.includes("\0")) throw new Error("消息包含不支持的二进制字符，请移除附件后重试");
    if (Buffer.byteLength(prompt, "utf8") > 512 * 1024) throw new Error("消息及附件合计不能超过 512 KB");
    if (!prompt.trim() && !continuation) throw new Error("prompt must not be empty");
    const taskWorkspace = location.workspaceRoot;
    // The same gates the launch path applies before a Main may take work.
    if ((await new HumanRequestStore(taskWorkspace).list(resident.taskId, "pending")).length)
      throw new Error("请先回答任务中待确认的问题，再继续运行。");
    const model = task.model || "";
    // A message that arrives while the Task is paused stays queued: the pause
    // is the user's hold on new turns, so only an explicit resume clears it and
    // the API answers with the status the Task actually has.
    const staysPaused = !continuation && Boolean(task.pause);
    await location.store.updateTask(resident.taskId, {
      ...(!continuation ? { goal: task.goal || prompt.slice(0, 4_000) } : {}),
      model,
      activeRunId: resident.runId,
      ...(task.pause && !staysPaused ? { pause: undefined } : {})
    });
    const inbox = new InboxStore(
      join(taskWorkspace, resident.taskId, "runs", resident.runId, "agents", "main", "inbox-store.json")
    );
    if (continuation) {
      // An explicit resume always wakes the process: the pause it just lifted
      // stopped its turn loop, so queued work alone would wait for the next
      // file event. The queued work is steered into the turn it starts.
      const resumeId = `main-resume-${randomUUID()}`;
      await inbox.enqueue({
        messageId: resumeId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-resume-event-${resumeId}`,
        priority: 100,
        state: "ready",
        payload: { type: "main.resume" },
        createdAt: now()
      });
    } else {
      const body: MainInput = {
        version: 1,
        prompt,
        submittedAt: Date.now(),
        body: submission?.body,
        taskId: resident.taskId,
        runId: resident.runId,
        attachmentIds: submission?.attachmentIds,
        textAttachments: submission?.textAttachments,
        ...(submission?.thinkingLevel
          ? { thinkingLevel: normalizeReasoningEffort(submission.thinkingLevel, "thinkingLevel") }
          : {}),
        messageId,
        source:
          submission?.source ?? (readQueuedUserTurn(prompt) ? ("inbox" as const) : ("composer" as const))
      };
      await saveMainInput(mainInputPath(taskWorkspace, resident.taskId, resident.runId), body);
      await saveAcceptedMainMessage(taskWorkspace, resident.taskId, body);
      await inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `main-turn-${messageId}`,
        priority: 120,
        state: "ready",
        payload: { type: "human.message", message: prompt, delivery: "steer", initial: true },
        createdAt: now()
      });
    }
    // The message that will open this process's next turn is accepted; until
    // the extension records that boundary, this is what `runtime.active`
    // reports (paused work is not a turn starting).
    if (!staysPaused) pendingTurns.set(resident.taskId, Date.now());
    // The accepted turn is the Task's current work: a reader that sees the
    // resume answered must not still read the state this turn replaces, and an
    // idle resident must not be mistaken for one with nothing to run.
    if (!staysPaused && ["paused", "waiting", "completed"].includes(task.status))
      await location.store.transitionTask(resident.taskId, "running", {
        runId: resident.runId,
        reason: "main_turn_delivered"
      });
    await appendRunEvent(taskWorkspace, resident.taskId, resident.runId, "main.turn_delivered", {
      prompt: prompt.slice(0, 4_000),
      continuation,
      messageId,
      ...(staysPaused ? { queuedWhilePaused: true } : {})
    });
    if (!staysPaused) {
      resident.turnActive = true;
    }
    interjectionTargets.set(resident.taskId, { runId: resident.runId });
    return {
      taskId: resident.taskId,
      runId: resident.runId,
      status: staysPaused ? "paused" : "running",
      model
    };
  }

  return { deliverResidentTurn };
}
