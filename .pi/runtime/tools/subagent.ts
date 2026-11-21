import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { agentDisplayName } from "../../../dist/src/runtime/agent-identity.js";
import {
  configuredSubagentMaxQuestions,
  configuredSubagentQuestionTimeout,
  runtimeSettingsEnv
} from "../../../dist/src/runtime/runtime-settings.js";
import { askMain } from "../../../dist/src/runtime/subagent-questions.js";
import { readFile } from "node:fs/promises";
import {
  FLOOR_CLASSES,
  parseReviewConclusion,
  type ReviewConclusion,
  type ReviewScope
} from "../../../dist/src/runtime/subagent-review.js";
import { sendPeerMessage, type PeerMessageResult } from "../../../dist/src/runtime/subagent-peer-message.js";
import { JsonlEventStore } from "../../../dist/src/storage/event-store.js";
import {
  ASK_MAIN_TOOL_DESCRIPTION,
  SEND_PEER_MESSAGE_TOOL_DESCRIPTION
} from "../../../dist/src/runtime/subagent-guidance.js";
import { browseWorkspace } from "../../../dist/src/tools/workspace-browse.js";
import { parseExecutorReport, type ExecutorReport } from "../../../dist/src/runtime/executor-report.js";
import { loadConfig } from "../helpers.ts";
import type { RuntimeToolResult } from "../helpers.ts";
import type { SubagentRole } from "../../../dist/src/runtime/subagent-roles.js";

/**
 * The tools a delegated Pi process registers for its role.
 *
 * Main's orchestration tools are absent by construction: this module registers
 * channels and the Reviewer's conclusion, and the role policy decides which of
 * Pi's own file and shell tools are active. A Subagent never reaches the
 * extension entry that registers call_subagent, finish_task or askhuman.
 */
export interface SubagentToolContext {
  role: SubagentRole;
  /** A custom read Agent answers in text, so it holds no submit_review. */
  customAgent?: boolean;
  workspaceRoot: string;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  taskWorkspace: string;
  /** What this review may cite, fixed when its candidate was frozen; absent outside a requirement. */
  reviewScope?: ReviewScope;
  /** Record a well-formed conclusion; the result record writes it on exit. */
  submitReview(review: ReviewConclusion): void;
  /** A ticket Executor's criterion ids; absent for any other work item. */
  ticketCriteria?: string[];
  /** Record a well-formed ticket report; the result record writes it on exit. */
  submitReport(report: ExecutorReport): void;
}

export function registerSubagentTools(pi: ExtensionAPI, context: SubagentToolContext): void {
  const runtimeEnv = runtimeSettingsEnv(loadConfig());
  // Bounds a Subagent that would rather ask than decide; per attempt, so a
  // rework turn starts with a fresh budget.
  let asked = 0;
  // The question lifecycle is a Run fact every reader agrees on: Main's tools,
  // the status view and completion gating read these events, not this process.
  const events = new JsonlEventStore(
    join(context.workspaceRoot, context.taskId, "runs", context.runId, "run_events.jsonl")
  );
  const recordQuestion = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      await events.append({
        eventId: `event-${type}-${payload.questionId ?? context.callId}`,
        type,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        callId: context.callId,
        occurredAt: new Date().toISOString(),
        payload
      });
      // eslint-disable-next-line no-restricted-syntax -- 提问事件只是诊断记录，写不进去不能阻止这次提问/回答返回给模型
    } catch {
      /* diagnostics only */
    }
  };

  pi.registerTool({
    name: "ask_main",
    label: "Ask Main",
    description: ASK_MAIN_TOOL_DESCRIPTION,
    promptSnippet: "Ask Main a blocking question with a declared fallback",
    parameters: Type.Object(
      {
        question: Type.String({
          description:
            "One concrete decision for Main, with enough context to answer it without reading your transcript."
        }),
        assumption: Type.String({
          description:
            "What you will do if nobody answers. Required, and it must be a course you can actually take."
        })
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, signal): Promise<RuntimeToolResult> {
      const outcome = await askMain({
        workspaceRoot: context.workspaceRoot,
        taskId: context.taskId,
        runId: context.runId,
        callId: context.callId,
        agentId: context.agentId,
        agentName: agentDisplayName(context.agentId),
        question: params.question,
        assumption: params.assumption,
        timeoutMs: configuredSubagentQuestionTimeout(runtimeEnv),
        maxQuestions: configuredSubagentMaxQuestions(runtimeEnv),
        asked,
        onRaised: async (question) => {
          await recordQuestion("question.raised", {
            questionId: question.questionId,
            question: question.question,
            assumption: question.assumption,
            timeoutMs: configuredSubagentQuestionTimeout(runtimeEnv)
          });
        },
        onSettled: async (status, question) => {
          await recordQuestion(`question.${status}`, {
            questionId: question.questionId,
            answer: question.answer
          });
        },
        isCancelled: async () => signal?.aborted === true || (await callCancelled(context)),
        cancellationWatchPaths: [
          join(context.workspaceRoot, context.taskId, "runs", context.runId, "queue.json")
        ]
      });
      if (outcome.status === "refused") {
        const payload = {
          status: "refused",
          reason: outcome.reason,
          instruction: outcome.instruction
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
          isError: true
        };
      }
      asked += 1;
      if (outcome.status === "answered") {
        const payload = {
          status: "answered",
          questionId: outcome.question.questionId,
          question: outcome.question.question,
          answer: outcome.question.answer
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      }
      if (outcome.status === "cancelled") throw new Error("Subagent was cancelled while waiting for Main");
      const payload = {
        status: "timeout",
        questionId: outcome.question.questionId,
        question: outcome.question.question,
        assumption: outcome.question.assumption,
        instruction:
          "Main did not answer in time. Continue under the assumption you declared and say so in your final summary."
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    }
  });

  pi.registerTool({
    name: "send_peer_message",
    label: "Send Peer Message",
    description: SEND_PEER_MESSAGE_TOOL_DESCRIPTION,
    promptSnippet: "Send a non-blocking message to another Subagent",
    parameters: Type.Object(
      {
        targetCallId: Type.String({ description: "The peer callId supplied by Main." }),
        message: Type.String({
          description: "A short question, correction or finding. Include a file or artifact path when useful."
        }),
        priority: Type.Optional(
          Type.Number({
            description: "Optional delivery priority; use a higher value only for time-sensitive guidance."
          })
        )
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const targetCallId = params.targetCallId.trim();
      const message = params.message.trim();
      if (!targetCallId) throw new Error("send_peer_message requires targetCallId");
      if (!message) throw new Error("send_peer_message requires message");
      const result: PeerMessageResult = await sendPeerMessage({
        taskId: context.taskId,
        runId: context.runId,
        workspaceRoot: context.workspaceRoot,
        senderCallId: context.callId,
        targetCallId,
        message,
        priority: typeof params.priority === "number" ? params.priority : undefined
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  pi.registerTool({
    name: "browse_workspace",
    label: "Browse Workspace",
    description:
      "Read-only browser for the entire current Task workspace, not just your working directory. It can show the workspace structure and inspect other Agents' progress, working files, artifacts, sessions, run events, queue and manifests. It never modifies files or runs commands.",
    promptSnippet: "Inspect the shared Task workspace (read-only)",
    promptGuidelines: [
      "Use browse_workspace with mode=tree to understand the Task layout and other Agents' progress.",
      "Use browse_workspace with mode=read for a known artifact, session, event or Agent file, and mode=search to locate evidence across the workspace."
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("read"), Type.Literal("search")])),
      path: Type.Optional(
        Type.String({
          description: "Relative path inside the Task workspace; default is the workspace root."
        })
      ),
      query: Type.Optional(Type.String({ description: "Text to search for when mode=search." })),
      offset: Type.Optional(
        Type.Number({
          description: "Byte offset for mode=read; use nextOffset from a truncated result to continue."
        })
      ),
      depth: Type.Optional(Type.Number({ description: "Tree depth, default 2." })),
      maxEntries: Type.Optional(Type.Number({ description: "Maximum entries or matches, default 200." }))
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const result = await browseWorkspace({ workspaceDirectory: context.taskWorkspace }, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });

  if (context.ticketCriteria) registerSubmitReport(pi, context, context.ticketCriteria);
  if (context.role !== "reviewer" || context.customAgent) return;
  pi.registerTool({
    name: "submit_review",
    label: "Submit Review",
    description:
      "Submit the review conclusion Main acts on. Call it once the examination is complete: verdict is pass or changes_requested; a blocking finding names its basis, the acceptance criterion it violates or a floor class; anything else is a non-blocking suggestion. A re-review answers every finding of the previous round in previousFindings. A work item that ends without a submitted conclusion is recorded as a failure. A malformed submission is reported as an error and can be retried.",
    promptSnippet: "Submit the review verdict and findings",
    promptGuidelines: [
      "Call submit_review once the examination is complete: it is how Main receives your verdict.",
      `A finding blocks only with a basis: the id of the acceptance criterion it violates, or a floor class — ${FLOOR_CLASSES.join(", ")} (breaking the project's own stated rules, such as its AGENTS.md). Anything else is blocking=false: a suggestion that blocks nothing.`,
      "changes_requested needs a blocking finding or a previous finding that is not fixed; pass carries neither.",
      "On a re-review, previousFindings answers every finding listed in the brief by its id, fixed or not with evidence; new findings must block, citing a criterion or a floor problem in a file this round changed.",
      "Location is a file path or path:line, evidence names what you actually observed (command output, code, test result), and findings must be checkable by the Executor."
    ],
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("changes_requested")]),
      findings: Type.Array(
        Type.Object(
          {
            title: Type.String({ description: "A short name for the finding." }),
            location: Type.String({ description: "File path, path:line, or the named area examined." }),
            evidence: Type.String({
              description:
                "What you observed and what supports the finding: code, command output or test result."
            }),
            blocking: Type.Boolean({
              description: "Whether this finding must be resolved before the result is accepted."
            }),
            basis: Type.Optional(
              Type.String({
                description: `Required when blocking: the criterion id it violates (as the brief lists it), or one of ${FLOOR_CLASSES.join(", ")}.`
              })
            )
          },
          { additionalProperties: false }
        ),
        { maxItems: 50 }
      ),
      previousFindings: Type.Optional(
        Type.Array(
          Type.Object(
            {
              findingId: Type.String({ description: "The id of a finding listed under the previous round." }),
              fixed: Type.Boolean(),
              evidence: Type.String({ description: "The command, test or code that shows it." })
            },
            { additionalProperties: false }
          ),
          { description: "Re-review only: one answer per finding of the previous round." }
        )
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const parsed = parseReviewConclusion(params, context.reviewScope);
      if (!parsed.ok) {
        const payload = { submitted: false, errors: parsed.errors };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
          isError: true
        };
      }
      context.submitReview(parsed.review);
      const payload = {
        submitted: true,
        verdict: parsed.review.verdict,
        findings: parsed.review.findings.length,
        blocking: parsed.review.findings.filter((finding) => finding.blocking).length
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    }
  });
}

/** A ticket Executor's report: one answer per acceptance criterion, with its evidence. */
function registerSubmitReport(pi: ExtensionAPI, context: SubagentToolContext, criteria: string[]): void {
  pi.registerTool({
    name: "submit_report",
    label: "Submit Report",
    description: `Report on the ticket's acceptance criteria (${criteria.join(", ")}): one entry each, met or not, with the evidence. Call it after the work is committed and checked, before your hand-back. A ticket work item that ends without one is recorded as a failure; a malformed report is an error you can correct.`,
    promptSnippet: "Report each acceptance criterion of the ticket",
    promptGuidelines: [
      "Call submit_report once the work is committed and its checks have run: one entry per acceptance criterion of the ticket.",
      "Evidence is the command you ran and what it showed, or what you checked by hand; report a criterion you could not meet as met=false and say why."
    ],
    parameters: Type.Object({
      criteria: Type.Array(
        Type.Object(
          {
            criterionId: Type.String({ description: `One of ${criteria.join(", ")}.` }),
            met: Type.Boolean(),
            evidence: Type.String({
              description: "The command and what it showed, or what was checked by hand."
            })
          },
          { additionalProperties: false }
        ),
        { maxItems: 50 }
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const parsed = parseExecutorReport(params, criteria);
      if (!parsed.ok) {
        const payload = { submitted: false, errors: parsed.errors };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
          isError: true
        };
      }
      context.submitReport(parsed.report);
      const payload = {
        submitted: true,
        met: parsed.report.criteria.filter((item) => item.met).length,
        notMet: parsed.report.criteria.filter((item) => !item.met).length
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    }
  });
}

/**
 * Whether the backend cancelled this call while the question was waiting.
 *
 * This is a read-only probe on a file the backend replaces atomically, so it
 * does not take the scheduler's write lock: a blocked question must not hold
 * the lock the backend needs to settle the call it is asking about.
 */
async function callCancelled(context: SubagentToolContext): Promise<boolean> {
  try {
    const items = JSON.parse(
      await readFile(join(context.workspaceRoot, context.taskId, "runs", context.runId, "queue.json"), "utf8")
    ) as Array<{ stepId?: string; status?: string }>;
    return items.find((item) => item.stepId === context.callId)?.status === "cancelled";
    // eslint-disable-next-line no-restricted-syntax -- 队列读不到或正在替换时按未取消继续等待，真正的取消与本次等待超时仍会结束阻塞
  } catch {
    return false;
  }
}
