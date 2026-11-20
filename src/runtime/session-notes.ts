import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-file.js";
import { withFileLock } from "../storage/file-lock.js";
import { sessionDataDirectory } from "./session-tool-results.js";

export function sessionNotesPath(session: ExtensionContext["sessionManager"]): string | undefined {
  if (!session.getSessionFile()) return;
  const key = createHash("sha256").update(session.getSessionId()).digest("hex");
  return join(sessionDataDirectory(session), "session-notes", `${key}.md`);
}

export async function readSessionNotes(path: string | undefined): Promise<string> {
  if (!path) return "";
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function writeSessionNotes(path: string, action: "append" | "rewrite", text: string) {
  return withFileLock(path, async () => {
    const existing = action === "append" ? await readSessionNotes(path) : "";
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    const notes = existing + separator + text;
    await atomicWrite(path, notes, { mode: 0o600 });
    return notes.length;
  });
}
