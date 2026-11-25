import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { humanAnswerTurn } from "../runtime/human-answer-turn.js";
import { HumanRequestStore } from "../runtime/human.js";
import { InboxStore } from "../runtime/scheduler.js";
import {
  type RunServicePorts,
  type LaunchMainRun,
  type ResumeHumanAnswers
} from "./run-service-contracts.js";
import type { createResidentMainRegistry } from "./resident-main-registry.js";

export function createHumanRunRecovery({
  humanResumes,
  locateTask,
  humanWakeups,
  adoptResidentMain,
  activeRuns,
  startMainRun
}: {
  humanResumes: Map<string, ReturnType<ResumeHumanAnswers>>;
  locateTask: RunServicePorts["locateTask"];
  humanWakeups: Set<string>;
  adoptResidentMain: ReturnType<typeof createResidentMainRegistry>["adoptResidentMain"];
  activeRuns: Map<string, ChildProcess>;
  startMainRun: LaunchMainRun;
}) {
  async function pendingHumanAnswers(taskWorkspace: string, taskId: string, runId?: string) {
    if (!runId) return [];
    return (
      await new InboxStore(
        join(taskWorkspace, taskId, "runs", runId, "agents", "main", "inbox-store.json")
      ).list("main")
    ).filter(
      (message) =>
        message.kind === "human_command" &&
        message.state !== "consumed" &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- payload 来自 inbox-store.json 的持久化消息，旧记录可能没有该字段，直接读会抛错
        (message.payload as { type?: string })?.type === "human.answer"
    );
  }

  function resumeHumanAnswers(taskId: string): Promise<{ status: string; error?: string }> {
    const existing = humanResumes.get(taskId);
    if (existing) return existing;
    const operation = (async () => {
      const location = await locateTask(taskId);
      const runId = location.task.activeRunId;
      if (location.task.status === "cancelled" || !runId) {
        humanWakeups.delete(taskId);
        return { status: "cancelled" };
      }
      const pending = await new HumanRequestStore(location.workspaceRoot).list(taskId, "pending");
      if (pending.length) {
        humanWakeups.delete(taskId);
        return { status: "waiting" };
      }
      const answers = await pendingHumanAnswers(location.workspaceRoot, taskId, runId);
      if (!answers.length) {
        humanWakeups.delete(taskId);
        return { status: "delivered" };
      }
      // A turn that is still producing, or still waiting on the question, takes
      // the answer in the process it owns. A settled Run's answer is a new
      // demand: it goes through admission and the queue like any other, so the
      // resident process is never the reason a full budget is bypassed.
      if (
        ["running", "waiting"].includes(location.task.status) &&
        ((await adoptResidentMain(taskId, location)) || activeRuns.has(taskId))
      ) {
        humanWakeups.add(taskId);
        return { status: "resuming" };
      }
      humanWakeups.delete(taskId);
      const inbox = new InboxStore(
        join(location.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
      );
      // The prior Dashboard process has stopped. Its unacknowledged answer
      // leases must be available to the resumed session immediately.
      for (const message of answers) if (message.state === "leased") await inbox.release(message.messageId);
      // The resumed user turn contains exactly the submitted decisions. The
      // durable Inbox provides delivery acknowledgement and crash recovery.
      // The shape is shared with the browser, which uses it to recognise this
      // turn as an answer and render it against its question rather than as a
      // fresh request the person typed.
      const prompt = answers
        .map((message) => {
          const payload = message.payload as { question: string; answer: string };
          return humanAnswerTurn(payload.question, payload.answer);
        })
        .join("\n\n");
      // A full external budget keeps the submitted answers in the durable
      // Inbox and queues this resume; the program starts it when a slot frees.
      const resumed = await startMainRun(taskId, prompt, runId, true, undefined, undefined, {
        source: "human",
        origin: "internal",
        queueWhenFull: true
      });
      if (resumed.status === "failed") return { status: "error", error: resumed.error };
      // The answers are this demand's own input. Their Inbox copies are the
      // delivery receipt for a waiting tool, not a second instruction the next
      // turn must read again, so they are consumed with the accepted demand.
      for (const message of answers) {
        try {
          if (message.state === "ready")
            await inbox.leaseMessage("main", message.messageId, 60_000, "run-service");
          await inbox.consume(message.messageId);
        } catch (error) {
          console.error(
            `[formicand] consuming a durable answer failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return { status: resumed.status === "queued" ? "queued" : "running" };
    })()
      .catch((error) => ({ status: "error", error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        humanResumes.delete(taskId);
      });
    humanResumes.set(taskId, operation);
    return operation;
  }

  return { pendingHumanAnswers, resumeHumanAnswers };
}
