import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  historyContentForEntry,
  historyPage,
  historyRole
} from "../../../dist/src/runtime/session-history.js";
import {
  readSessionNotes,
  sessionNotesPath,
  writeSessionNotes
} from "../../../dist/src/runtime/session-notes.js";
import {
  archivedToolResultPath,
  sessionDataDirectory
} from "../../../dist/src/runtime/session-tool-results.js";

export const SESSION_HISTORY_TOOLS = ["session_notes", "search_history", "read_history"] as const;

const start = Type.Optional(Type.Integer({ minimum: 0, description: "Start character offset (inclusive)." }));
const end = Type.Optional(Type.Integer({ minimum: 0, description: "End character offset (exclusive)." }));
const text = (value: string) => ({ type: "text" as const, text: value });

function pageContent(value: string, from?: number, to?: number) {
  const page = historyPage(value, from, to);
  return [text(`Characters ${page.start}–${page.end} of ${page.length}.`), text(page.text)];
}

export function registerSessionHistoryTools(pi: ExtensionAPI): void {
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
    description:
      "Find a literal phrase in this session's original messages and tool results, including earlier windows. Returns entry IDs and snippets, newest first.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 300 }),
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
      before: Type.Optional(Type.String({ description: "Only search entries before this entry ID." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
    }),
    async execute(_id, params, signal, _update, ctx) {
      const entries = ctx.sessionManager.getEntries();
      const before =
        params.before === undefined
          ? entries.length
          : entries.findIndex((entry) => entry.id === params.before);
      if (before < 0) throw new Error("The history cursor is not an entry in this session.");
      const directory = sessionDataDirectory(ctx.sessionManager);
      const matches = [];
      const query = new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
      for (const entry of entries.slice(0, before).reverse()) {
        signal?.throwIfAborted();
        const role = historyRole(entry);
        if (!role || (params.role && params.role !== role)) continue;
        const tool =
          entry.type === "message" && entry.message.role === "toolResult"
            ? entry.message.toolName
            : undefined;
        if (params.tool && params.tool !== tool) continue;
        const original = await historyContentForEntry(directory, entry);
        const structured = original.structured === undefined ? "" : JSON.stringify(original.structured);
        const textMatch = query.exec(original.text);
        const value = textMatch ? original.text : structured;
        const match = textMatch ?? query.exec(structured);
        if (!match) continue;
        const offset = match.index;
        matches.push({
          id: entry.id,
          timestamp: entry.timestamp,
          role,
          tool,
          ...(!textMatch && { field: "structured" }),
          offset,
          snippet: value.slice(Math.max(0, offset - 80), offset + match[0].length + 160)
        });
        if (matches.length >= (params.limit ?? 10)) break;
      }
      return { content: [text(JSON.stringify(matches))], details: { count: matches.length } };
    }
  });
  pi.registerTool({
    name: "read_history",
    label: "Read session history",
    description:
      "Read original history by entry ID or a tool result's displayed archive path. Ranges use zero-based character offsets. Select an image by its one-based number.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      start,
      end,
      field: Type.Optional(Type.Literal("structured")),
      image: Type.Optional(Type.Integer({ minimum: 1 }))
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const entry =
        ctx.sessionManager.getEntry(params.id) ??
        ctx.sessionManager.getEntries().find((candidate) => archivedToolResultPath(candidate) === params.id);
      if (!entry || !historyRole(entry))
        throw new Error("No conversation entry with that ID in this session.");
      const original = await historyContentForEntry(sessionDataDirectory(ctx.sessionManager), entry);
      if (params.image !== undefined) {
        const image = original.images.at(params.image - 1);
        if (!image) throw new Error("No image with that number in this entry.");
        return { content: [image], details: { id: entry.id } };
      }
      if (params.field === "structured" && original.structured === undefined)
        throw new Error("This entry has no structured result.");
      const value = params.field === "structured" ? JSON.stringify(original.structured) : original.text;
      return { content: pageContent(value, params.start, params.end), details: { id: entry.id } };
    }
  });
}
