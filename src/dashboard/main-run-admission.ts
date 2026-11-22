import { randomUUID } from "node:crypto";
import { readQueuedUserTurn } from "../runtime/queued-user-turn.js";
import type { MainCapacityDecision } from "../domain/main-capacity.js";
import type { TaskLocation } from "./workspace-directory.js";
import {
  deferredMainLaunch,
  type RunServicePorts,
  type MainLaunchReceipt,
  type MainLaunchSubmission,
  type MainLaunchAdmission,
  type MainLaunchOptions
} from "./run-service-contracts.js";
import type { createResidentMainRegistry } from "./resident-main-registry.js";
import { residentProcessAlive } from "./resident-main.js";
import type { createResidentMainTurnDelivery } from "./resident-main-turn-delivery.js";

export function createMainRunAdmission({
  mainSessions,
  mainCapacity,
  residentFor,
  stopResidentMain,
  coordinator,
  deliverResidentTurn
}: {
  mainSessions: RunServicePorts["mainSessions"];
  mainCapacity: RunServicePorts["mainCapacity"];
  residentFor: ReturnType<typeof createResidentMainRegistry>["residentFor"];
  stopResidentMain: ReturnType<typeof createResidentMainRegistry>["stopResidentMain"];
  coordinator: RunServicePorts["coordinator"];
  deliverResidentTurn: ReturnType<typeof createResidentMainTurnDelivery>["deliverResidentTurn"];
}) {
  /** Whether this Task is the history container of a persistent Main session. */
  async function sessionForTask(location: TaskLocation, submission?: MainLaunchSubmission): Promise<boolean> {
    if (!mainSessions || !location.projectId) return false;
    const owner = await mainSessions.resolve(location, {
      ...(submission?.mainSessionId === undefined || submission.mainSessionId === null
        ? {}
        : { mainSessionId: submission.mainSessionId })
    });
    return Boolean(owner);
  }

  /**
   * The external budget decision for one demand.
   *
   * A demand that already owns a slot, or one whose Task has no external
   * Session, takes no decision here. Every other demand is either reserved,
   * queued, or reported as the demand that already owns this Task, and the
   * caller applies the decision before any Run or process is recorded.
   */
  async function admitExternal(input: {
    location: TaskLocation;
    runId: string;
    prompt: string;
    resume: boolean;
    submission?: MainLaunchSubmission;
    requestedModel?: string;
    retryRequestId?: string;
  }): Promise<{ sessionId: string; decision: MainCapacityDecision } | undefined> {
    const { location, submission } = input;
    if (!mainCapacity?.enabled() || !mainSessions || !location.projectId || submission?.admittedRequestId)
      return undefined;
    const owner = await mainSessions.resolve(location, {
      ...(submission?.mainSessionId === undefined || submission.mainSessionId === null
        ? {}
        : { mainSessionId: submission.mainSessionId })
    });
    if (owner?.entryKind !== "external") return undefined;
    const decision = await mainCapacity.admit({
      projectId: location.projectId,
      sessionId: owner.sessionId,
      taskId: location.task.taskId,
      kind: owner.kind,
      ...(typeof submission?.requirementId === "string" ? { requirementId: submission.requirementId } : {}),
      runId: input.runId,
      resume: input.resume,
      // Keep only the explicit choice: a queued demand resolves the host and
      // project defaults when it actually gets a slot.
      ...(input.requestedModel ? { model: input.requestedModel } : {}),
      ...(input.retryRequestId ? { retryRequestId: input.retryRequestId } : {}),
      prompt: input.prompt,
      ...(submission
        ? {
            submission: {
              ...(submission.body === undefined ? {} : { body: submission.body }),
              // The explicit connection and thinking level are user choices, so
              // a queued demand keeps them across the wait.
              ...(submission.profileId ? { profileId: submission.profileId } : {}),
              ...(submission.thinkingLevel ? { thinkingLevel: submission.thinkingLevel } : {}),
              ...(submission.attachmentIds ? { attachmentIds: submission.attachmentIds } : {}),
              ...(submission.textAttachments ? { textAttachments: submission.textAttachments } : {}),
              ...(submission.source ? { source: submission.source } : {})
            }
          }
        : {}),
      origin: submission?.origin ?? "internal",
      queueWhenFull: submission?.queueWhenFull === true
    });
    return { sessionId: owner.sessionId, decision };
  }

  async function reuseResidentMain(
    location: TaskLocation,
    { prompt, requestedRunId, resume, requestedModel, retryRequestId, submission }: MainLaunchOptions,
    admission: MainLaunchAdmission
  ): Promise<MainLaunchReceipt | { replaceResident: boolean }> {
    const { task, workspaceRoot: taskWorkspace } = location;
    const { taskId } = task;
    // A resident Main serving this Task takes the turn in the process it
    // already has. Only a request that needs a different process (an edit, a
    // retry, another model, or the next Run of a Session) falls through, and
    // that one replaces it.
    let resident = await residentFor(taskId);
    if (resident && !resident.observed && !(await residentProcessAlive(resident.record))) {
      // The entry may predate a crash: its process is gone but the exit has
      // not been projected yet. Drop it and look again, so a Main the recovery
      // supervisor started for the same session is adopted instead of a
      // second process being started beside it. The process record, not the
      // heartbeat, says whether it is alive: a just-started one has no
      // heartbeat of its own yet.
      await stopResidentMain(taskId, { replacing: true });
      resident = await residentFor(taskId);
    }
    if (!resident) return { replaceResident: false };
    // A retry or a request for another Run while a Main still serves this
    // Task is the same duplicate the launch check always refused: the Run
    // it names has already started.
    if (retryRequestId || (requestedRunId !== undefined && requestedRunId !== resident.runId))
      throw new Error("Task already has an active Main run");
    const settled = !["running", "waiting", "paused"].includes(task.status);
    // A Session holds one Run at a time. Its next requirement opens a new Run,
    // and this process wrote the records of the Run it started with. A plain
    // conversation keeps its Run, so its idle process takes the next message.
    const session = await sessionForTask(location, submission);
    const nextSessionRun =
      session &&
      settled &&
      requestedRunId === undefined &&
      !submission?.edit &&
      typeof submission?.requirementId === "string";
    // A queued demand for the next Run of a Session must leave its idle Main in place.
    if (nextSessionRun) return { replaceResident: true };
    // A second demand for a Session whose turn is producing an answer is a
    // duplicate start, not input to that turn: the interjection path is how
    // a person adds input. A Main waiting for delegated work can still take
    // a change at its next boundary. A wake, an answer or a resume names the
    // Run it continues, so none of them is refused here.
    if (
      session &&
      task.status === "running" &&
      requestedRunId === undefined &&
      !submission?.edit &&
      prompt.trim()
    ) {
      const coordination = await coordinator
        .waitForSubagents({ taskId, runId: resident.runId, workspaceRoot: taskWorkspace, timeoutMs: 0 })
        // eslint-disable-next-line no-restricted-syntax -- 读不到协作队列时按“没有待办工作”处理：拒绝请求比让它插进一个无法确认的回合更安全
        .catch(() => undefined);
      if (!coordination?.pending.length && !coordination?.callbackPending.length)
        throw new Error("Task already has an active Main run");
    }
    const continuationTurn = resume === true && !prompt.trim();
    if (!submission?.edit) {
      // A turn takes the place its Run already owns; a resident between
      // turns (paused, or released after its last turn) is admitted first,
      // so an idle process never keeps a place it is not using.
      let place = resident.requestId;
      if (!place && mainCapacity?.enabled()) place = await mainCapacity.requestFor(taskId, resident.runId);
      if (!place && (continuationTurn || !task.pause)) {
        const admitted = await admitExternal({
          location,
          runId: resident.runId,
          prompt,
          resume: resume === true || Boolean(task.activeRunId),
          ...(submission ? { submission } : {}),
          ...(requestedModel ? { requestedModel } : {}),
          ...(retryRequestId ? { retryRequestId } : {})
        });
        if (admitted) {
          if (admitted.decision.state !== "running")
            return deferredMainLaunch(
              admitted.decision,
              admitted.sessionId,
              taskId,
              resident.runId,
              task.model || ""
            );
          place = admitted.decision.requestId;
          admission.requestId = place;
        }
      }
      const delivered = await deliverResidentTurn({
        resident,
        task,
        location,
        prompt,
        continuation: continuationTurn,
        ...(submission ? { submission } : {}),
        ...(requestedModel ? { requestedModel } : {}),
        messageId: readQueuedUserTurn(prompt)?.messageId ?? randomUUID()
      });
      if (delivered) {
        const requestId = place ?? admission.requestId;
        resident.requestId = requestId;
        if (requestId && mainCapacity)
          await mainCapacity
            .bindProcess(requestId, resident.record.pid)
            .catch((error) =>
              console.error(
                `[cowork] external capacity process record failed: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            );
        return delivered;
      }
    }
    // An edit, another model or a process that is already gone replaces it.
    await stopResidentMain(taskId, { replacing: true });
    return { replaceResident: false };
  }

  return { admitExternal, reuseResidentMain };
}
