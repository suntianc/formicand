import {
  estimateTokens,
  type ContextEditEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import type { SessionContextUsage } from "../../dist/src/runtime/session-context-usage.js";
import { archiveToolResult, sessionDataDirectory } from "../../dist/src/runtime/session-tool-results.js";
import { truncateToolText } from "../../dist/src/runtime/tool-output.js";
import { atomicWrite } from "../../dist/src/storage/atomic-file.js";

const LARGE_RESULT_CHARS = 20_000;
const RESULT_PREVIEW_CHARS = 1_000;
const EDIT_THRESHOLD = 0.5;
const MINIMUM_SAVINGS = 0.1;
const RECENT_RESULTS = 5;
const PROTECTED_TOOLS = new Set(["load_skill", "askhuman"]);

function editsForTurn(event: TurnEndEvent, ctx: ExtensionContext): ContextEditEntryDraft[] {
  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens === null || usage.tokens <= usage.contextWindow * EDIT_THRESHOLD) return [];
  const edited = new Set(
    ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "context_edit" ? [entry.targetId] : []))
  );
  const results = event.context.contextEntries.flatMap(({ sourceEntry, messages }) =>
    messages.flatMap((message) => (message.role === "toolResult" ? [{ id: sourceEntry.id, message }] : []))
  );
  const latestDevelopment = results.findLast(({ message }) => message.toolName === "project_development");
  const entries: ContextEditEntryDraft[] = [];
  let saved = 0;
  for (const result of results.slice(0, -RECENT_RESULTS)) {
    const { id, message } = result;
    if (edited.has(id) || PROTECTED_TOOLS.has(message.toolName) || result === latestDevelopment) continue;
    const content = [
      {
        type: "text" as const,
        text: `[${message.toolName} result ${message.toolCallId} cleared. Use read_history with entry ID ${id} to retrieve the original.]`
      }
    ];
    const savings = estimateTokens(message) - estimateTokens({ ...message, content });
    if (savings <= 0) continue;
    saved += savings;
    entries.push({ type: "context_edit", targetId: id, replacement: { content } });
    if (saved >= usage.contextWindow * MINIMUM_SAVINGS) return entries;
  }
  return [];
}

export function registerSessionContext(pi: ExtensionAPI, usagePath?: string): void {
  pi.on("tool_result", async (event, ctx) => {
    // Nested tool calls feed script execution. Their outer result is sized separately.
    if (event.parentToolCallId) return;
    const { toolName, toolCallId, content, structuredContent, isError } = event;
    const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const structuredText = structuredContent === undefined ? "" : JSON.stringify(structuredContent);
    if (Math.max(text.length, structuredText.length) <= LARGE_RESULT_CHARS) return;
    const path = await archiveToolResult(sessionDataDirectory(ctx.sessionManager), {
      toolName,
      toolCallId,
      content,
      structuredContent,
      isError
    });
    return {
      content: [
        {
          type: "text",
          text: `[Tool result stored at ${path}]\n${truncateToolText(text || structuredText, RESULT_PREVIEW_CHARS)}`
        },
        ...content.filter((block) => block.type === "image")
      ]
    };
  });
  pi.on("turn_end", (event, ctx) => {
    const entries = editsForTurn(event, ctx);
    if (entries.length) return { entries };
  });
  if (usagePath) {
    const saveUsage = async (_event: unknown, ctx: ExtensionContext) => {
      const usage = ctx.getContextUsage();
      const file = ctx.sessionManager.getSessionFile();
      if (!usage || !file) return;
      const branch = ctx.sessionManager.getBranch();
      const snapshot: SessionContextUsage = {
        contextWindow: usage.contextWindow,
        // Pi reports unknown until the first reply in a new window. Use its
        // message estimator to show the size of the handoff in the meantime.
        tokens:
          usage.tokens ??
          ctx.sessionManager
            .buildSessionProjection()
            .messages.reduce((total, message) => total + estimateTokens(message), 0),
        sessionFile: basename(file),
        window: 1 + branch.filter((entry) => entry.type === "compaction").length
      };
      await atomicWrite(usagePath, JSON.stringify(snapshot), { mode: 0o600 });
    };
    pi.on("context", saveUsage);
    pi.on("session_compact", saveUsage);
    pi.on("agent_settled", saveUsage);
  }
}
