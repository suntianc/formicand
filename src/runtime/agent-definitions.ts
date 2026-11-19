import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../storage/atomic-file.js";
import { atriaHome } from "../../scripts/data-home.cjs";
import { projectTrustDecision } from "./project-trust.js";
import { parseSkillFrontmatter } from "./skill-frontmatter.js";

/**
 * Custom Agents: Markdown files whose header names the Agent, tells Main when
 * to use it and fixes what it may do; the body is extra prompt text placed
 * after the role's own. Global ones live in `~/.atria/agents/`, a project's in
 * its `.atria/agents/`, and a project one wins over a global one of the same
 * name. The built-in Executor and Reviewer are shown in the same shape and
 * cannot be changed.
 */

export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const AGENT_PERMISSIONS = ["write", "read"] as const;
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];
export const BUILTIN_AGENT_NAMES = ["executor", "reviewer"] as const;

/** Tools an Agent may be given, by permission. Main's own tools and desktop control are never here. */
const READ_TOOLS = ["read", "bash", "grep", "find", "ls", "browse_workspace", "search", "visit"] as const;
const WRITE_ONLY_TOOLS = ["edit", "write"] as const;
export const AGENT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "browse_workspace",
  "search",
  "visit"
] as const;
/** The tools every delegated process keeps, whatever the definition says. */
export const AGENT_CHANNEL_TOOLS = ["ask_main", "send_peer_message"] as const;
/** What an Agent holds when its definition names no tools: the role's own set. */
const DEFAULT_TOOLS: Record<AgentPermission, readonly string[]> = {
  write: ["read", "bash", "edit", "write", "browse_workspace", "search", "visit"],
  read: ["read", "bash", "grep", "find", "ls", "browse_workspace", "search", "visit"]
};

export function agentToolsFor(permission: AgentPermission): readonly string[] {
  return permission === "write" ? AGENT_TOOLS : READ_TOOLS;
}

const nameList = z.array(z.string().trim().min(1).max(100)).max(100);

export const agentDefinitionSchema = z
  .object({
    name: z
      .string({ error: "请写 Agent 名称" })
      .regex(AGENT_NAME, "名称只能用字母、数字和连字符，最长 64 个字符"),
    description: z
      .string({ error: "请写给 Main 的使用说明" })
      .trim()
      .min(1, "请写给 Main 的使用说明")
      .max(1000),
    permission: z.enum(AGENT_PERMISSIONS, { error: "权限只能是 write 或 read" }),
    /** A model on the connection the role resolves to; omitted means the role's model. */
    model: z.string().trim().min(1).max(200).optional(),
    /** A model connection; omitted means the role's connection. */
    profile: z.string().trim().min(1).max(200).optional(),
    tools: nameList.optional(),
    /** Omitted: every skill is visible. */
    skills: nameList.optional(),
    /** Omitted: no MCP server. */
    mcp: nameList.optional(),
    enabled: z.boolean().optional(),
    prompt: z
      .string()
      .max(64 * 1024)
      .default("")
  })
  .superRefine((value, ctx) => {
    const allowed: readonly string[] = agentToolsFor(value.permission);
    for (const tool of value.tools ?? [])
      if (!allowed.includes(tool))
        ctx.addIssue({
          code: "custom",
          path: ["tools"],
          message: (WRITE_ONLY_TOOLS as readonly string[]).includes(tool)
            ? `只读 Agent 不能使用 ${tool}`
            : `不能给 Agent 的工具：${tool}`
        });
  });
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export type AgentSource = "builtin" | "global" | "project";

export interface AgentEntry {
  name: string;
  source: AgentSource;
  /** The definition file; absent for a built-in Agent. */
  path?: string;
  definition?: AgentDefinition;
  /** Why the file could not be used. */
  error?: string;
  /** For a global Agent, the project file that replaces it. */
  shadowedBy?: string;
}

/** The fixed Agents, in the same shape as a file one. */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "executor",
    description: "实现与验证：在隔离现场修改代码、运行检查并交回证据。",
    permission: "write",
    prompt: ""
  },
  {
    name: "reviewer",
    description: "独立审查：在候选的独立副本里检查，用 submit_review 交回结论与发现。",
    permission: "read",
    prompt: ""
  }
];

export function globalAgentRoot(home: string): string {
  return join(home, "agents");
}

export function projectAgentRoot(projectDirectory: string): string {
  return join(resolve(projectDirectory), ".atria", "agents");
}

/** A definition file's header and body as an Agent, or the reason it is not one. */
export function parseAgentDefinition(
  text: string,
  fileName?: string
): { definition: AgentDefinition } | { error: string } {
  const { frontmatter, body } = parseSkillFrontmatter(text);
  const result = agentDefinitionSchema.safeParse({ ...frontmatter, prompt: body });
  if (!result.success) return { error: result.error.issues.map((issue) => issue.message).join("；") };
  if (fileName && basename(fileName, ".md") !== result.data.name)
    return { error: `文件名应为 ${result.data.name}.md` };
  return { definition: result.data };
}

function quoted(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value);
}

/** The Markdown file for a definition; lists are written as `[a, b]`. */
export function serializeAgentDefinition(definition: AgentDefinition): string {
  const lines = [
    "---",
    `name: ${definition.name}`,
    `description: ${JSON.stringify(definition.description)}`,
    `permission: ${definition.permission}`
  ];
  if (definition.profile) lines.push(`profile: ${quoted(definition.profile)}`);
  if (definition.model) lines.push(`model: ${quoted(definition.model)}`);
  for (const key of ["tools", "skills", "mcp"] as const) {
    const list = definition[key];
    if (list) lines.push(`${key}: [${list.map(quoted).join(", ")}]`);
  }
  if (definition.enabled === false) lines.push("enabled: false");
  lines.push("---");
  const prompt = definition.prompt.trim();
  return `${lines.join("\n")}\n${prompt ? `\n${prompt}\n` : ""}`;
}

async function readFolder(root: string, source: "global" | "project"): Promise<AgentEntry[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: AgentEntry[] = [];
  for (const file of names.sort()) {
    if (!file.endsWith(".md")) continue;
    const path = join(root, file);
    const parsed = parseAgentDefinition(await readFile(path, "utf8"), file);
    entries.push({
      name: "definition" in parsed ? parsed.definition.name : basename(file, ".md"),
      source,
      path,
      ...parsed
    });
  }
  return entries;
}

export interface AgentLocations {
  home: string;
  /** Read only when the user trusts the project. */
  projectDirectory?: string;
  projectTrusted: boolean;
}

/** Every Agent a place can see: built-in, global, and the trusted project's, project first. */
export async function listAgentEntries(locations: AgentLocations): Promise<AgentEntry[]> {
  const project =
    locations.projectDirectory && locations.projectTrusted
      ? await readFolder(projectAgentRoot(locations.projectDirectory), "project")
      : [];
  const projectNames = new Map(
    project.filter((entry) => entry.definition).map((entry) => [entry.name, entry.path!])
  );
  const global = (await readFolder(globalAgentRoot(locations.home), "global")).map((entry) => {
    const shadowedBy = projectNames.get(entry.name);
    return shadowedBy ? { ...entry, shadowedBy } : entry;
  });
  const builtin: AgentEntry[] = BUILTIN_AGENTS.map((definition) => ({
    name: definition.name,
    source: "builtin",
    definition
  }));
  return [...builtin, ...project, ...global];
}

/** The Agents Main may delegate to: one per name, enabled and valid, built-ins excluded. */
export async function availableAgents(locations: AgentLocations): Promise<AgentDefinition[]> {
  const seen = new Set<string>(BUILTIN_AGENT_NAMES);
  const found: AgentDefinition[] = [];
  for (const entry of await listAgentEntries(locations)) {
    if (entry.source === "builtin" || seen.has(entry.name) || entry.shadowedBy) continue;
    seen.add(entry.name);
    if (entry.definition && entry.definition.enabled !== false) found.push(entry.definition);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The definition a delegation names, fixed for the work item. A missing,
 * switched-off or broken Agent is an error that names it, never a quiet
 * fallback to another Agent.
 */
export async function resolveAgent(
  locations: AgentLocations,
  name: string
): Promise<AgentEntry & { definition: AgentDefinition }> {
  const entries = await listAgentEntries(locations);
  const entry = entries.find((candidate) => candidate.name === name && !candidate.shadowedBy);
  if (!entry) throw new Error(`没有名为 ${name} 的 Agent；在设置 · Agent 中查看可用的 Agent`);
  if (!entry.definition) throw new Error(`Agent ${name} 的定义有误（${entry.path}）：${entry.error}`);
  if (entry.definition.enabled === false) throw new Error(`Agent ${name} 已停用（${entry.path}）`);
  return { ...entry, definition: entry.definition };
}

/** Where a project's Agents are read from, given the user's trust decision for it. */
export async function agentLocations(
  home: string,
  projectDirectory: string | undefined
): Promise<AgentLocations> {
  const trusted = projectDirectory
    ? (await projectTrustDecision(home, projectDirectory)) === "trusted"
    : false;
  return { home, ...(projectDirectory ? { projectDirectory } : {}), projectTrusted: trusted };
}

/** The same for a running process, from its environment's data home. */
export async function processAgentLocations(
  projectDirectory: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentLocations> {
  return agentLocations(atriaHome(env), projectDirectory);
}

export async function writeAgentDefinition(root: string, definition: AgentDefinition): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, `${definition.name}.md`);
  await atomicWrite(path, serializeAgentDefinition(definition));
  return path;
}

export async function deleteAgentDefinition(root: string, name: string): Promise<void> {
  if (!AGENT_NAME.test(name)) throw new Error("Agent 名称不合法");
  await rm(join(root, `${name}.md`), { force: true });
}

/** The tools a delegated process declares for a definition, channels included. */
export function agentToolNames(definition: AgentDefinition): string[] {
  const chosen = definition.tools ?? DEFAULT_TOOLS[definition.permission];
  const allowed: readonly string[] = agentToolsFor(definition.permission);
  return [
    ...chosen.filter((tool) => allowed.includes(tool)),
    ...(definition.skills === undefined || definition.skills.length ? ["load_skill"] : []),
    ...AGENT_CHANNEL_TOOLS
  ];
}

/** The Main system prompt section that lists the user's Agents. */
export function customAgentsPrompt(agents: AgentDefinition[]): string {
  return [
    "The user defined these Agents. Delegate to one with call_subagent agent=<name> when its description fits the work; omit agent for the built-in Executor or Reviewer. A write Agent changes code in its own checkout; a read Agent examines a copy and answers in text.",
    ...agents.map(
      (agent) => `- ${agent.name} (${agent.permission}): ${agent.description.replace(/\s+/g, " ")}`
    )
  ].join("\n");
}

/** What the run records about the definition: nothing that is a secret or a prompt. */
export function agentSnapshot(entry: AgentEntry & { definition: AgentDefinition }) {
  return {
    name: entry.definition.name,
    source: entry.source,
    permission: entry.definition.permission,
    modelSource: entry.definition.model || entry.definition.profile ? "agent" : "role"
  };
}
