import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSkillFrontmatter } from "./skill-frontmatter.js";

/**
 * Main's memory across sessions.
 *
 * Two scopes: `user` follows the person across projects, `project` belongs to
 * one project. Each memory is one Markdown file with a small frontmatter; the
 * index Main sees every turn is derived from those files by the program, so it
 * can never drift from what is stored. Nothing is written into the user's
 * repository: both scopes live in Formicand's data home.
 */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryTarget = { scope: "user" } | { scope: "project"; projectId: string };

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  updatedAt: string;
}

export interface MemoryRecord extends MemoryEntry {
  body: string;
}

export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export const MEMORY_LIMITS = {
  /** Memories per scope; past it the oldest must be merged or removed first. */
  entries: 80,
  description: 150,
  body: 4000,
  /** Characters of index Main receives each turn, both scopes together. */
  index: 12_000
} as const;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROJECT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const SETTINGS = "settings.json";

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

export function memoryDirectory(home: string, target: MemoryTarget): string {
  if (target.scope === "user") return join(home, "memory", "user");
  if (!PROJECT_ID.test(target.projectId)) throw new MemoryError("项目 ID 不合法", "memory_project_invalid");
  return join(home, "memory", "projects", target.projectId);
}

function fileFor(home: string, target: MemoryTarget, name: string): string {
  if (!NAME.test(name))
    throw new MemoryError("记忆名只能用小写字母、数字和连字符，最多 64 个字符", "memory_name_invalid");
  return join(memoryDirectory(home, target), `${name}.md`);
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}

// Double-quoted YAML scalars are JSON strings, which the frontmatter reader accepts.
function serialize(record: MemoryRecord): string {
  return [
    "---",
    `name: ${JSON.stringify(record.name)}`,
    `description: ${JSON.stringify(record.description)}`,
    `type: ${JSON.stringify(record.type)}`,
    `updated: ${JSON.stringify(record.updatedAt)}`,
    "---",
    "",
    record.body,
    ""
  ].join("\n");
}

function parse(name: string, content: string): MemoryRecord | undefined {
  const { frontmatter, body } = parseSkillFrontmatter(content);
  const type = frontmatter.type;
  if (typeof type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(type)) return undefined;
  return {
    name,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    type: type as MemoryType,
    updatedAt: typeof frontmatter.updated === "string" ? frontmatter.updated : "",
    body
  };
}

async function readRecord(file: string, name: string): Promise<MemoryRecord | undefined> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parse(name, content);
}

async function names(directory: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .filter((name) => NAME.test(name));
}

/** Newest first; a file that is not a memory is skipped rather than shown half-read. */
export async function listMemories(home: string, target: MemoryTarget): Promise<MemoryEntry[]> {
  const directory = memoryDirectory(home, target);
  const records = await Promise.all(
    (await names(directory)).map((name) => readRecord(join(directory, `${name}.md`), name))
  );
  return records
    .filter((record): record is MemoryRecord => record !== undefined)
    .map(({ body: _body, ...entry }) => entry)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

export async function readMemory(
  home: string,
  target: MemoryTarget,
  name: string
): Promise<MemoryRecord | undefined> {
  return readRecord(fileFor(home, target, name), name);
}

function validated(input: MemoryInput): MemoryInput {
  const description = input.description.trim().replace(/\s+/g, " ");
  const body = input.body.trim();
  if (!(MEMORY_TYPES as readonly string[]).includes(input.type))
    throw new MemoryError(`记忆类型只能是 ${MEMORY_TYPES.join("、")}`, "memory_type_invalid");
  if (!description || description.length > MEMORY_LIMITS.description)
    throw new MemoryError(
      `一句话说明不能为空，最多 ${MEMORY_LIMITS.description} 个字符`,
      "memory_description_invalid"
    );
  if (!body || body.length > MEMORY_LIMITS.body)
    throw new MemoryError(`正文不能为空，最多 ${MEMORY_LIMITS.body} 个字符`, "memory_body_invalid");
  return { ...input, description, body };
}

/**
 * Create a memory, or replace one of the same name. `previousName` renames:
 * the new file is written before the old one is removed, so a failed write
 * loses nothing.
 */
export async function writeMemory(
  home: string,
  target: MemoryTarget,
  input: MemoryInput,
  options: { previousName?: string; now?: Date } = {}
): Promise<MemoryRecord> {
  const memory = validated(input);
  const file = fileFor(home, target, memory.name);
  const previous = options.previousName && options.previousName !== memory.name ? options.previousName : "";
  const previousFile = previous ? fileFor(home, target, previous) : "";
  const directory = memoryDirectory(home, target);
  const existing = await names(directory);
  if (previous && existing.includes(memory.name))
    throw new MemoryError(`已有名为 ${memory.name} 的记忆`, "memory_name_taken");
  if (!existing.includes(memory.name) && !previous && existing.length >= MEMORY_LIMITS.entries)
    throw new MemoryError(
      `这一级已满（${existing.length}/${MEMORY_LIMITS.entries} 条），先合并或删除旧的再写新的`,
      "memory_full"
    );
  for (const other of existing) {
    if (other === memory.name || other === previous) continue;
    if ((await readRecord(join(directory, `${other}.md`), other))?.body === memory.body)
      throw new MemoryError(`记忆 ${other} 的正文与此相同，更新那一条`, "memory_duplicate");
  }
  const record: MemoryRecord = { ...memory, updatedAt: (options.now ?? new Date()).toISOString() };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(file, serialize(record));
  if (previousFile) await rm(previousFile, { force: true });
  return record;
}

export async function deleteMemory(home: string, target: MemoryTarget, name: string): Promise<boolean> {
  const file = fileFor(home, target, name);
  const existed = (await readRecord(file, name)) !== undefined;
  await rm(file, { force: true });
  return existed;
}

/** A project's memory is on unless the user switched it off. */
export async function projectMemoryEnabled(home: string, projectId: string): Promise<boolean> {
  const file = join(memoryDirectory(home, { scope: "project", projectId }), SETTINGS);
  try {
    return (JSON.parse(await readFile(file, "utf8")) as { enabled?: unknown }).enabled !== false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function setProjectMemoryEnabled(
  home: string,
  projectId: string,
  enabled: boolean
): Promise<void> {
  const directory = memoryDirectory(home, { scope: "project", projectId });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(join(directory, SETTINGS), `${JSON.stringify({ enabled }, null, 2)}\n`);
}

/**
 * The index Main reads every turn: one line per memory, user scope first.
 * Past the character budget the oldest lines are left out and counted, so Main
 * knows to list the rest instead of assuming there is nothing more.
 */
export function memoryIndex(scopes: { label: string; entries: MemoryEntry[] }[]): string {
  const filled = scopes.filter((scope) => scope.entries.length);
  if (!filled.length) return "";
  const lines = [
    "Memories you saved in earlier sessions. Each line is an index entry; read the memory before relying on it, and check that it is still true when it names code or files."
  ];
  let used = lines[0].length;
  let omitted = 0;
  for (const scope of filled) {
    const header = `${scope.label} [${scope.entries.length}/${MEMORY_LIMITS.entries}]:`;
    let headed = false;
    for (const entry of scope.entries) {
      const line = `- ${entry.name} [${entry.type}, ${entry.updatedAt.slice(0, 10)}] ${entry.description}`;
      const cost = line.length + 1 + (headed ? 0 : header.length + 1);
      if (used + cost > MEMORY_LIMITS.index) {
        omitted++;
        continue;
      }
      if (!headed) lines.push(header);
      headed = true;
      lines.push(line);
      used += cost;
    }
  }
  if (omitted) lines.push(`${omitted} older memories are not shown; list a scope to see them.`);
  return lines.join("\n");
}
