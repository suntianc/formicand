import type { SessionEntry, SessionManager, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "../storage/atomic-file.js";

const ARCHIVE_DIRECTORY = "tool-results";
const ARCHIVE_REFERENCE =
  /^\[Tool result stored at (tool-results\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json)\]/;

export type ArchivedToolResult = Pick<
  ToolResultEvent,
  "toolName" | "toolCallId" | "content" | "structuredContent" | "isError"
>;

export function sessionDataDirectory(
  session: Pick<SessionManager, "getSessionFile" | "getSessionDir">
): string {
  const file = session.getSessionFile();
  return file ? dirname(file) : session.getSessionDir();
}

export async function archiveToolResult(directory: string, result: ArchivedToolResult): Promise<string> {
  const path = `${ARCHIVE_DIRECTORY}/${randomUUID()}.json`;
  await atomicWrite(join(directory, path), JSON.stringify(result), { mode: 0o600, exclusive: true });
  return path;
}

export function archivedToolResultPath(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return;
  const first = entry.message.content.at(0);
  if (first?.type === "text") return ARCHIVE_REFERENCE.exec(first.text)?.[1];
}

export async function readArchivedToolResult(
  directory: string,
  entry: SessionEntry
): Promise<ArchivedToolResult | undefined> {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return;
  const path = archivedToolResultPath(entry);
  if (!path) return;
  const result = JSON.parse(await readFile(join(directory, path), "utf8")) as ArchivedToolResult;
  if (result.toolName !== entry.message.toolName || result.toolCallId !== entry.message.toolCallId)
    throw new Error(`Tool result archive does not match history entry ${entry.id}.`);
  return result;
}

/** A conversation fork carries only archives referred to by its copied entries. */
export async function copyToolResultArchives(
  sourceDirectory: string,
  targetDirectory: string,
  entries: readonly SessionEntry[]
) {
  const paths = new Set(entries.map(archivedToolResultPath).filter((path) => path !== undefined));
  if (!paths.size) return;
  await mkdir(join(targetDirectory, ARCHIVE_DIRECTORY), { recursive: true, mode: 0o700 });
  for (const path of paths) await copyFile(join(sourceDirectory, path), join(targetDirectory, path));
}
