import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { readQueuedUserTurn } from "./queued-user-turn.js";
import { readArchivedToolResult, type ArchivedToolResult } from "./session-tool-results.js";

export const HISTORY_ROLES = ["user", "assistant", "toolResult", "custom"] as const;
export type HistoryRole = (typeof HISTORY_ROLES)[number];
export const HISTORY_PAGE_CHARS = 16_000;

export function historyRole(entry: SessionEntry): HistoryRole | undefined {
  if (entry.type === "custom_message") return entry.customType === "cowork-user-message" ? "user" : "custom";
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
  if (entry.type === "custom_message" && entry.customType === "cowork-user-message") {
    const details = entry.details as { message?: unknown } | undefined;
    if (typeof details?.message === "string") return details.message;
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

export function historyPage(text: string, start = 0, end = text.length) {
  if (end < start || start > text.length) throw new Error("Invalid history range.");
  const limit = Math.min(end, text.length, start + HISTORY_PAGE_CHARS);
  return { text: text.slice(start, limit), start, end: limit, length: text.length };
}
