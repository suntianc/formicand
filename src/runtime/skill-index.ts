import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite } from "../storage/atomic-file.js";

/**
 * Skills removed from CoworkOS's index.
 *
 * Removing hides a skill from the settings list and from every Agent without
 * touching its files, so a skill in the shared `~/.agents/skills` keeps working
 * in other tools. Entries are keyed by the skill's directory.
 */
export interface RemovedSkill {
  directory: string;
  name: string;
  removedAt: string;
}

interface SkillIndexFile {
  removed: RemovedSkill[];
}

export function skillIndexPath(home: string): string {
  return join(home, "skill-index.json");
}

export async function readRemovedSkills(home: string): Promise<RemovedSkill[]> {
  const path = skillIndexPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<SkillIndexFile>;
  if (!Array.isArray(parsed.removed)) throw new Error(`${path}: "removed" must be a list`);
  return parsed.removed.filter(
    (entry): entry is RemovedSkill =>
      typeof entry.directory === "string" &&
      typeof entry.name === "string" &&
      typeof entry.removedAt === "string"
  );
}

export async function removedSkillDirectories(home: string): Promise<Set<string>> {
  return new Set((await readRemovedSkills(home)).map((entry) => entry.directory));
}

export async function removeSkillFromIndex(
  home: string,
  skill: { directory: string; name: string }
): Promise<void> {
  const directory = resolve(skill.directory);
  const removed = await readRemovedSkills(home);
  if (removed.some((entry) => entry.directory === directory)) return;
  removed.push({ directory, name: skill.name, removedAt: new Date().toISOString() });
  await writeIndex(home, removed);
}

export async function restoreSkillToIndex(home: string, directory: string): Promise<boolean> {
  const target = resolve(directory);
  const removed = await readRemovedSkills(home);
  const kept = removed.filter((entry) => entry.directory !== target);
  if (kept.length === removed.length) return false;
  await writeIndex(home, kept);
  return true;
}

async function writeIndex(home: string, removed: RemovedSkill[]): Promise<void> {
  await atomicWrite(skillIndexPath(home), `${JSON.stringify({ removed }, null, 2)}\n`);
}
