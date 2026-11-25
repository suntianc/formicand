import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  historyEntryById,
  historyPage,
  readHistoryEntry,
  searchHistoryEntries
} from "../../../dist/src/runtime/session-history.js";
import {
  readSessionNotes,
  sessionNotesPath,
  writeSessionNotes
} from "../../../dist/src/runtime/session-notes.js";
import { sessionDataDirectory } from "../../../dist/src/runtime/session-tool-results.js";

export const SESSION_HISTORY_TOOLS = ["session_notes", "search_history", "read_history"] as const;

const start = Type.Optional(Type.Integer({ minimum: 0, description: "Start character offset (inclusive)." }));
const end = Type.Optional(Type.Integer({ minimum: 0, description: "End character offset (exclusive)." }));
const text = (value: string) => ({ type: "text" as const, text: value });

function pageContent(value: string, from?: number, to?: number) {
  const page = historyPage(value, from, to);
  return [text(`Characters ${page.start}–${page.end} of ${page.length}.`), text(page.text)];
}

/** Main's way to the other sessions of its project; a Subagent has none. */
export type ProjectHistory = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function registerSessionHistoryTools(pi: ExtensionAPI, projectHistory?: ProjectHistory): void {
  pi.registerTool({
    name: "session_notes",
    label: "Session notes",
    description:
      "Read, append to, or rewrite notes for this session. Notes survive window changes and restart.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("append"), Type.Literal("rewrite")]),
      text: Type.Optional(
        Type.String({ description: "Text to append or rewrite; an empty rewrite clears the notes." })
      ),
      start,
      end
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const path = sessionNotesPath(ctx.sessionManager);
      if (params.action === "read")
        return { content: pageContent(await readSessionNotes(path), params.start, params.end), details: {} };
      if (!path) throw new Error("Session notes require a saved session.");
      if (params.text === undefined) throw new Error("Supply text to append or rewrite the notes.");
      const length = await writeSessionNotes(path, params.action, params.text);
      return { content: [text(`Saved session notes (${length} characters).`)], details: { length } };
    }
  });
  pi.registerTool({
    name: "search_history",
    label: "Search session history",
    description: projectHistory
      ? "Find a literal phrase in original messages and tool results, newest first. Scope session (default) searches this session, including earlier windows; scope project searches the other sessions of this project, newest session first, and each match names its session for read_history."
      : "Find a literal phrase in this session's original messages and tool results, including earlier windows. Returns entry IDs and snippets, newest first.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 300 }),
      ...(projectHistory && {
        scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("project")]))
      }),
      role: Type.Optional(
        Type.Union([
          Type.Literal("user"),
          Type.Literal("assistant"),
          Type.Literal("toolResult"),
          Type.Literal("custom")
        ])
      ),
      tool: Type.Optional(
        Type.String({ description: "Exact tool name; restricts the search to its results." })
      ),
      before: Type.Optional(
        Type.String({ description: "Only search entries before this entry ID of this session." })
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
    }),
    async execute(_id, params, signal, _update, ctx) {
      const search = {
        query: params.query,
        ...(params.role && { role: params.role }),
        ...(params.tool && { tool: params.tool }),
        limit: params.limit ?? 10
      };
      if (projectHistory && "scope" in params && params.scope === "project") {
        if (params.before !== undefined) throw new Error("before applies only to scope session.");
        const result = await projectHistory({ action: "search", ...search });
        const matches = result.matches as unknown[];
        return { content: [text(JSON.stringify(matches))], details: { count: matches.length } };
      }
      const entries = ctx.sessionManager.getEntries();
      const before =
        params.before === undefined
          ? entries.length
          : entries.findIndex((entry) => entry.id === params.before);
      if (before < 0) throw new Error("The history cursor is not an entry in this session.");
      const matches = await searchHistoryEntries(
        sessionDataDirectory(ctx.sessionManager),
        entries.slice(0, before),
        search,
        signal
      );
      return { content: [text(JSON.stringify(matches))], details: { count: matches.length } };
    }
  });
  pi.registerTool({
    name: "read_history",
    label: "Read session history",
    description:
      "Read original history by entry ID or a tool result's displayed archive path. Ranges use zero-based character offsets. Select an image by its one-based number." +
      (projectHistory ? " Name the session a project search returned to read from another session." : ""),
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      ...(projectHistory && {
        session: Type.Optional(Type.String({ minLength: 1, description: "Another session's ID." }))
      }),
      start,
      end,
      field: Type.Optional(Type.Literal("structured")),
      image: Type.Optional(Type.Integer({ minimum: 1 }))
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const read = {
        ...(params.start !== undefined && { start: params.start }),
        ...(params.end !== undefined && { end: params.end }),
        ...(params.field && { field: params.field }),
        ...(params.image !== undefined && { image: params.image })
      };
      if (projectHistory && "session" in params && params.session !== undefined) {
        const result = await projectHistory({
          action: "read",
          session: params.session,
          id: params.id,
          ...read
        });
        return {
          content: result.content as Awaited<ReturnType<typeof readHistoryEntry>>,
          details: { session: params.session, id: params.id }
        };
      }
      const entry = historyEntryById(ctx.sessionManager.getEntries(), params.id);
      if (!entry) throw new Error("No conversation entry with that ID in this session.");
      return {
        content: await readHistoryEntry(sessionDataDirectory(ctx.sessionManager), entry, read),
        details: { id: entry.id }
      };
    }
  });
}
