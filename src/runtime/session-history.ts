import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { readQueuedUserTurn } from "./queued-user-turn.js";
import {
  archivedToolResultPath,
  readArchivedToolResult,
  type ArchivedToolResult
} from "./session-tool-results.js";

const HISTORY_ROLES = ["user", "assistant", "toolResult", "custom"] as const;
export type HistoryRole = (typeof HISTORY_ROLES)[number];
export const HISTORY_PAGE_CHARS = 16_000;

export function historyRole(entry: SessionEntry): HistoryRole | undefined {
  if (entry.type === "custom_message") return historyUserText(entry) === undefined ? "custom" : "user";
  if (entry.type !== "message") return;
  switch (entry.message.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
      return entry.message.role;
  }
}

export function historyUserText(entry: SessionEntry): string | undefined {
  if (entry.type === "custom_message") {
    const details = entry.details as { message?: unknown; answer?: unknown } | undefined;
    if (entry.customType === "formicand-human-answer" && typeof details?.answer === "string")
      return details.answer;
    if (
      (entry.customType === "formicand-user-message" || entry.customType === "formicand-user-turn") &&
      typeof details?.message === "string"
    )
      return details.message;
  }
  if (entry.type !== "message" || entry.message.role !== "user") return;
  const { content } = entry.message;
  return readQueuedUserTurn(content)?.text ?? historyContent(content).text;
}

type HistoryContent =
  | string
  | readonly (
      | ImageContent
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "toolCall"; name: string; id: string; arguments: unknown }
    )[];

function historyContent(content: HistoryContent) {
  const images: ImageContent[] = [];
  if (typeof content === "string") return { text: content, images };
  const text = content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "thinking":
          return block.thinking;
        case "toolCall":
          return `[${block.name} call ${block.id}]\n${JSON.stringify(block.arguments)}`;
        case "image":
          images.push(block);
          return `[Image ${images.length}: ${block.mimeType}]`;
      }
    })
    .join("\n");
  return { text, images };
}

export async function historyContentForEntry(
  directory: string,
  entry: SessionEntry
): Promise<{ text: string; images: ImageContent[]; structured?: ArchivedToolResult["structuredContent"] }> {
  const original = await readArchivedToolResult(directory, entry);
  if (original) {
    const { text, images } = historyContent(original.content);
    return { text, images, structured: original.structuredContent };
  }
  if (entry.type === "custom_message") {
    return historyContent(historyUserText(entry) ?? entry.content);
  }
  if (entry.type === "message") {
    const message = entry.message;
    switch (message.role) {
      case "user": {
        const content = historyContent(message.content);
        return { ...content, text: readQueuedUserTurn(message.content)?.text ?? content.text };
      }
      case "assistant":
      case "custom":
      case "toolResult":
        return historyContent(message.content);
    }
  }
  throw new Error(`History entry ${entry.id} has no conversation content.`);
}

/** A read the entry cannot satisfy: a range, image or field it does not have. */
export class HistoryReadError extends Error {}

export function historyPage(text: string, start = 0, end = text.length) {
  if (end < start || start > text.length) throw new HistoryReadError("Invalid history range.");
  const limit = Math.min(end, text.length, start + HISTORY_PAGE_CHARS);
  return { text: text.slice(start, limit), start, end: limit, length: text.length };
}

export interface HistorySearch {
  query: string;
  role?: HistoryRole;
  /** Exact tool name; restricts the search to its results. */
  tool?: string;
  limit: number;
}

export interface HistoryMatch {
  id: string;
  timestamp: string;
  role: HistoryRole;
  tool?: string;
  field?: "structured";
  offset: number;
  snippet: string;
}

/** Literal, case-insensitive matches in `entries`, newest first, at most `limit`. */
export async function searchHistoryEntries(
  directory: string,
  entries: readonly SessionEntry[],
  search: HistorySearch,
  signal?: AbortSignal
): Promise<HistoryMatch[]> {
  const matches: HistoryMatch[] = [];
  if (search.limit <= 0) return matches;
  const query = new RegExp(search.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  for (const entry of [...entries].reverse()) {
    signal?.throwIfAborted();
    const role = historyRole(entry);
    if (!role || (search.role && search.role !== role)) continue;
    const tool =
      entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolName : undefined;
    if (search.tool && search.tool !== tool) continue;
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
      ...(tool === undefined ? {} : { tool }),
      ...(!textMatch && { field: "structured" as const }),
      offset,
      snippet: value.slice(Math.max(0, offset - 80), offset + match[0].length + 160)
    });
    if (matches.length >= search.limit) break;
  }
  return matches;
}

/** The entry `id` names, or the entry whose archived tool result is at that displayed path. */
export function historyEntryById(entries: readonly SessionEntry[], id: string): SessionEntry | undefined {
  const entry =
    entries.find((candidate) => candidate.id === id) ??
    entries.find((candidate) => archivedToolResultPath(candidate) === id);
  return entry && historyRole(entry) ? entry : undefined;
}

export interface HistoryRead {
  start?: number;
  end?: number;
  field?: "structured";
  /** One-based image number. */
  image?: number;
}

/** One page of an entry's original content, or one of its images. */
export async function readHistoryEntry(
  directory: string,
  entry: SessionEntry,
  read: HistoryRead
): Promise<Array<ImageContent | { type: "text"; text: string }>> {
  const original = await historyContentForEntry(directory, entry);
  if (read.image !== undefined) {
    const image = original.images.at(read.image - 1);
    if (!image) throw new HistoryReadError("No image with that number in this entry.");
    return [image];
  }
  if (read.field === "structured" && original.structured === undefined)
    throw new HistoryReadError("This entry has no structured result.");
  const value = read.field === "structured" ? JSON.stringify(original.structured) : original.text;
  const page = historyPage(value, read.start, read.end);
  return [
    { type: "text", text: `Characters ${page.start}–${page.end} of ${page.length}.` },
    { type: "text", text: page.text }
  ];
}
