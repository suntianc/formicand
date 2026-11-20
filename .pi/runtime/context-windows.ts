import {
  estimateTokens,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry
} from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CONTEXT_CAPACITY_NOTICE,
  CONTEXT_WINDOW_REQUEST,
  latestWindow,
  recentContextTail,
  sessionHandoff,
  windowDetails,
  type HandoffScope,
  type WindowDetails
} from "../../dist/src/runtime/session-handoff.js";

const NOTICE_THRESHOLD = 0.75;

function overflowAlreadyRecovered(branch: SessionEntry[]): boolean {
  const window = latestWindow(branch);
  if (!window || windowDetails(window.details)?.reason !== "overflow") return false;
  return !branch
    .slice(branch.indexOf(window) + 1)
    .some(
      (entry) =>
        entry.type === "message" &&
        (entry.message.role === "user" ||
          (entry.message.role === "assistant" &&
            !["error", "aborted", "length"].includes(entry.message.stopReason)))
    );
}

export function registerContextWindows(pi: ExtensionAPI, scope: HandoffScope) {
  let toolRequested = false;
  pi.on("session_start", () => {
    toolRequested = false;
  });

  const build = async (ctx: ExtensionContext, reason: WindowDetails["reason"], requestId?: string) => {
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
    try {
      return await sessionHandoff({
        session: ctx.sessionManager,
        entries: ctx.sessionManager.getBranch(),
        scope,
        reason,
        contextWindow,
        firstKeptEntryId:
          reason === "overflow"
            ? null
            : recentContextTail(ctx.sessionManager.buildSessionProjection(), estimateTokens, contextWindow),
        requestId
      });
    } catch (error) {
      console.warn(
        "[CoworkOS] Using a minimal context handoff:",
        error instanceof Error ? error.message : String(error)
      );
      const details: WindowDetails = { kind: "cowork-context-window", reason, requestId };
      return {
        type: "compaction" as const,
        summary:
          "# Context window handoff\nUse search_history and read_history to recover the original conversation and session_notes for working notes.",
        firstKeptEntryId: null,
        details
      };
    }
  };

  pi.on("session_before_compact", async (event, ctx) => {
    const draft = await build(
      ctx,
      event.reason,
      event.reason === "manual" && event.customInstructions?.startsWith("compact-")
        ? event.customInstructions
        : undefined
    );
    const compaction: CompactionResult = {
      summary: draft.summary,
      // @ts-expect-error Pi 1.5.2's hook type omits the null cut accepted by SessionManager.appendCompaction.
      firstKeptEntryId: draft.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      details: draft.details
    };
    return { compaction };
  });

  pi.registerTool({
    name: "clear_context",
    label: "Start a new context window",
    description:
      "Start a fresh context window after this step. Save working notes first with session_notes. Earlier entries remain available through search_history and read_history.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Why a fresh window is useful now." }))
    }),
    async execute(_id, params) {
      toolRequested = true;
      return {
        content: [{ type: "text", text: "A new context window will start at this step boundary." }],
        details: { scheduled: true, reason: params.reason }
      };
    }
  });

  async function requestedWindow(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    const window = latestWindow(branch);
    const request = branch
      .slice(window ? branch.indexOf(window) + 1 : 0)
      .findLast((entry) => entry.type === "custom" && entry.customType === CONTEXT_WINDOW_REQUEST);
    if (!toolRequested && !request) return;
    const requestId =
      request?.type === "custom" && typeof request.data === "string" ? request.data : undefined;
    const draft = await build(ctx, "manual", requestId);
    toolRequested = false;
    return draft;
  }

  pi.on("turn_end", async (event, ctx) => {
    if (event.outcome !== "completed") return;
    const manual = await requestedWindow(ctx);
    if (manual) return { entries: [manual] };
    const branch = ctx.sessionManager.getBranch();
    const current = latestWindow(branch);
    const windowStart = current ? branch.indexOf(current) + 1 : 0;
    if (
      branch
        .slice(windowStart)
        .some((entry) => entry.type === "custom_message" && entry.customType === CONTEXT_CAPACITY_NOTICE)
    )
      return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;
    // The preceding tool-result hook may already have freed space in this batch.
    const tokens = event.entries.some((entry) => entry.type === "context_edit")
      ? event.context.contextMessages.reduce((total, message) => total + estimateTokens(message), 0)
      : usage.tokens;
    if (tokens <= usage.contextWindow * NOTICE_THRESHOLD) return;
    return {
      entries: [
        {
          type: "custom_message",
          customType: CONTEXT_CAPACITY_NOTICE,
          content: `Context capacity: about ${Math.max(0, usage.contextWindow - tokens)} tokens remain. Use session_notes to save constraints, progress and next steps before the window changes.`,
          display: false
        }
      ]
    };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    // Pi checks overflow first. A session consisting of one huge input can
    // have no legal native preparation, so its hook is never called.
    const branch = ctx.sessionManager.getBranch();
    if (event.outcome === "error" && !overflowAlreadyRecovered(branch)) {
      const last = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (
        last?.type === "message" &&
        last.message.role === "assistant" &&
        last.message.stopReason === "error" &&
        isContextOverflow(last.message)
      ) {
        return { entries: [await build(ctx, "overflow")], continue: true };
      }
    }
    const manual = await requestedWindow(ctx);
    if (manual) return { entries: [manual] };
  });

  return {
    async fromComposer(ctx: ExtensionContext, requestId: string): Promise<void> {
      if (
        ctx.sessionManager
          .getBranch()
          .some(
            (entry) =>
              (entry.type === "compaction" && windowDetails(entry.details)?.requestId === requestId) ||
              (entry.type === "custom" &&
                entry.customType === CONTEXT_WINDOW_REQUEST &&
                entry.data === requestId)
          )
      )
        return;
      if (!ctx.isIdle()) {
        pi.appendEntry(CONTEXT_WINDOW_REQUEST, requestId);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        ctx.compact({
          customInstructions: requestId,
          onComplete: () => resolve(),
          onError: reject
        });
      });
    }
  };
}
