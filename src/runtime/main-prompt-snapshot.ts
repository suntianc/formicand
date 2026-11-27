import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-file.js";
import { mainContextPaths } from "./main-context.js";
import type { SkillMetadata } from "./skill-registry.js";

/**
 * The parts of Main's system prompt that come from the user's settings.
 *
 * A conversation keeps the prompt it was given: a skill, MCP server, Agent or
 * memory added while it runs reaches it only when the prompt is generated again
 * (a new process that does not replace one, another model, or a reload), so the
 * provider's cached prefix survives the turns in between. Holds no secrets: the
 * MCP servers and the search provider are kept by name only.
 */
export interface MainPromptSnapshot {
  version: 1;
  /** `provider/id` of the model the prompt was generated for. */
  model: string;
  skills: SkillMetadata[];
  customAgents: string;
  memory: string;
  userMainInstructions: string;
  mcpServers: string[];
  webSearch: boolean;
}

/** Set by the backend when it replaces a running Main (edit, retry, next Run): reuse the prompt. */
export const MAIN_PROMPT_REUSE = "FORMICAND_MAIN_PROMPT_REUSE";

function paths(workspaceRoot: string, taskId: string) {
  const { directory } = mainContextPaths(workspaceRoot, taskId);
  return { snapshot: join(directory, "prompt-snapshot.json"), refresh: join(directory, "prompt-refresh") };
}

export async function readMainPromptSnapshot(
  workspaceRoot: string,
  taskId: string
): Promise<MainPromptSnapshot | undefined> {
  let text: string;
  try {
    text = await readFile(paths(workspaceRoot, taskId).snapshot, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text) as Partial<MainPromptSnapshot>;
  // A snapshot this version cannot read is generated again, not guessed at.
  return value.version === 1 ? (value as MainPromptSnapshot) : undefined;
}

export async function writeMainPromptSnapshot(
  workspaceRoot: string,
  taskId: string,
  snapshot: MainPromptSnapshot
): Promise<void> {
  await atomicWrite(paths(workspaceRoot, taskId).snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Ask the Main serving this Task to generate its prompt again at its next turn. */
export async function requestMainPromptRefresh(workspaceRoot: string, taskId: string): Promise<void> {
  await mkdir(mainContextPaths(workspaceRoot, taskId).directory, { recursive: true });
  await writeFile(paths(workspaceRoot, taskId).refresh, `${new Date().toISOString()}\n`);
}

/** Consume a pending refresh request; true when one was waiting. */
export async function takeMainPromptRefresh(workspaceRoot: string, taskId: string): Promise<boolean> {
  try {
    await rm(paths(workspaceRoot, taskId).refresh);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
