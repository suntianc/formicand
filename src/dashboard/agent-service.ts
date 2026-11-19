import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  agentDefinitionSchema,
  agentToolsFor,
  AGENT_CHANNEL_TOOLS,
  AGENT_NAME,
  BUILTIN_AGENT_NAMES,
  deleteAgentDefinition,
  globalAgentRoot,
  listAgentEntries,
  projectAgentRoot,
  writeAgentDefinition,
  type AgentDefinition,
  type AgentEntry
} from "../runtime/agent-definitions.js";
import { enabledMcpServers, readMcpServers } from "../runtime/mcp-config.js";
import {
  decideProjectTrust,
  projectDefinitionFolders,
  projectTrustDecision,
  type ProjectTrust
} from "../runtime/project-trust.js";
import { removedSkillDirectories } from "../runtime/skill-index.js";
import { discoverSkills, listSkillEntries, skillRootsFor } from "../runtime/skill-registry.js";
import { HttpError } from "./http.js";

export type AgentScope = { scope: "global" } | { scope: "project"; projectId: string };

export interface AgentView {
  name: string;
  source: AgentEntry["source"];
  path?: string;
  definition?: AgentDefinition;
  error?: string;
  /** For a global Agent, the project file that replaces it here. */
  shadowedBy?: string;
  /** Built-ins are shown, not changed. */
  readonly: boolean;
  /** Skills or MCP servers the definition names that no longer exist or are off. */
  problems: string[];
}

export interface AgentProjectView {
  projectId: string;
  projectName: string;
  projectDirectory: string;
  trust: ProjectTrust | null;
  folders: string[];
}

export interface AgentServiceOptions {
  harnessRoot: string;
  home: string;
  userHome: string;
  projectForId(
    projectId: string
  ): Promise<{ projectId: string; projectName?: string; projectDirectory?: string } | null>;
}

/** Settings → Agent: the global and per-project lists, editing, and the trust question. */
export function createAgentService(options: AgentServiceOptions) {
  async function project(projectId: string): Promise<AgentProjectView> {
    const record = await options.projectForId(projectId);
    if (!record?.projectDirectory) throw new HttpError(404, "项目不存在", "agent_project_missing");
    const projectDirectory = resolve(record.projectDirectory);
    return {
      projectId,
      projectName: record.projectName ?? projectId,
      projectDirectory,
      trust: (await projectTrustDecision(options.home, projectDirectory)) ?? null,
      folders: projectDefinitionFolders(projectDirectory)
    };
  }

  /** Skill names and MCP servers a definition may name, for one place. */
  async function references(projectDirectory: string | undefined, trusted: boolean) {
    const entries = await listSkillEntries(
      skillRootsFor({
        harnessRoot: options.harnessRoot,
        home: options.home,
        userHome: options.userHome,
        ...(projectDirectory ? { projectDirectory } : {}),
        projectTrusted: trusted
      }),
      await removedSkillDirectories(options.home)
    );
    const skills = [...new Set(entries.filter((entry) => !entry.removed).map((entry) => entry.name))].sort();
    const records = await readMcpServers(options.home);
    const enabled = new Set(enabledMcpServers(records).map((server) => server.name));
    return {
      skills,
      mcp: records.map((record) => ({ name: record.name, enabled: enabled.has(record.name) }))
    };
  }

  function problems(
    definition: AgentDefinition | undefined,
    known: Awaited<ReturnType<typeof references>>
  ): string[] {
    if (!definition) return [];
    const found: string[] = [];
    for (const skill of definition.skills ?? [])
      if (!known.skills.includes(skill)) found.push(`技能 ${skill} 不存在或已从索引移除`);
    for (const server of definition.mcp ?? []) {
      const record = known.mcp.find((entry) => entry.name === server);
      if (!record) found.push(`MCP 服务 ${server} 未配置`);
      else if (!record.enabled) found.push(`MCP 服务 ${server} 已停用`);
    }
    return found;
  }

  async function views(target: AgentScope) {
    if (target.scope === "global") {
      const known = await references(undefined, false);
      const entries = await listAgentEntries({ home: options.home, projectTrusted: false });
      return {
        agents: entries.map((entry) => view(entry, known))
      };
    }
    const projectView = await project(target.projectId);
    const trusted = projectView.trust === "trusted";
    const known = await references(projectView.projectDirectory, trusted);
    const entries = await listAgentEntries({
      home: options.home,
      projectDirectory: projectView.projectDirectory,
      projectTrusted: trusted
    });
    return {
      project: projectView,
      agents: entries.filter((entry) => entry.source !== "builtin").map((entry) => view(entry, known))
    };
  }

  function view(entry: AgentEntry, known: Awaited<ReturnType<typeof references>>): AgentView {
    return {
      name: entry.name,
      source: entry.source,
      ...(entry.path ? { path: entry.path } : {}),
      ...(entry.definition ? { definition: entry.definition } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
      readonly: entry.source === "builtin",
      problems: problems(entry.definition, known)
    };
  }

  async function root(target: AgentScope): Promise<string> {
    if (target.scope === "global") return globalAgentRoot(options.home);
    const projectView = await project(target.projectId);
    if (projectView.trust !== "trusted")
      throw new HttpError(409, "请先信任这个项目，再编辑项目 Agent", "agent_project_untrusted");
    return projectAgentRoot(projectView.projectDirectory);
  }

  async function existing(target: AgentScope, name: string): Promise<AgentEntry> {
    const entries = await listAgentEntries(
      target.scope === "global"
        ? { home: options.home, projectTrusted: false }
        : {
            home: options.home,
            projectDirectory: (await project(target.projectId)).projectDirectory,
            projectTrusted: true
          }
    );
    const entry = entries.find((candidate) => candidate.name === name && candidate.source === target.scope);
    if (!entry?.path) throw new HttpError(404, "Agent 不存在或已变化，请刷新后重试", "agent_missing");
    return entry;
  }

  return {
    list: views,

    /** What the editor offers: tools per permission, skills and MCP servers to pick from. */
    async options(target: AgentScope) {
      const projectView = target.scope === "project" ? await project(target.projectId) : undefined;
      const known = await references(projectView?.projectDirectory, projectView?.trust === "trusted");
      return {
        tools: { write: agentToolsFor("write"), read: agentToolsFor("read") },
        channels: AGENT_CHANNEL_TOOLS,
        skills: known.skills,
        mcp: known.mcp
      };
    },

    async save(target: AgentScope, raw: unknown, previousName?: string) {
      const parsed = agentDefinitionSchema.safeParse(raw);
      if (!parsed.success)
        throw new HttpError(
          400,
          parsed.error.issues.map((issue) => issue.message).join("；"),
          "agent_definition_invalid"
        );
      const definition = parsed.data;
      if ((BUILTIN_AGENT_NAMES as readonly string[]).includes(definition.name))
        throw new HttpError(409, "executor 与 reviewer 是内置 Agent 的名称，请换一个", "agent_name_reserved");
      const folder = await root(target);
      const names = await definitionNames(folder);
      const renamed = previousName !== undefined && previousName !== definition.name;
      if ((previousName === undefined || renamed) && names.includes(definition.name))
        throw new HttpError(409, "已有同名 Agent", "agent_name_taken");
      if (previousName !== undefined && !names.includes(previousName))
        throw new HttpError(404, "Agent 不存在或已变化，请刷新后重试", "agent_missing");
      const path = await writeAgentDefinition(folder, definition);
      if (renamed) await deleteAgentDefinition(folder, previousName);
      return { path, definition };
    },

    async setEnabled(target: AgentScope, name: string, enabled: boolean) {
      const entry = await existing(target, name);
      if (!entry.definition)
        throw new HttpError(409, `定义有误，先修正：${entry.error}`, "agent_definition_invalid");
      const definition: AgentDefinition = { ...entry.definition };
      if (enabled) delete definition.enabled;
      else definition.enabled = false;
      await writeAgentDefinition(await root(target), definition);
      return { name, enabled };
    },

    async delete(target: AgentScope, name: string) {
      const entry = await existing(target, name);
      await deleteAgentDefinition(await root(target), entry.name);
      return { deleted: entry.path };
    },

    async trust(projectId: string, trust: ProjectTrust) {
      const view = await project(projectId);
      await decideProjectTrust(options.home, view.projectDirectory, trust);
      return { project: await project(projectId) };
    },

    /**
     * What trusting a project would bring in, for the question asked in the
     * work view. Only names are read; nothing reaches a model before the answer.
     */
    async trustPreview(projectId: string) {
      const view = await project(projectId);
      const agentsRoot = projectAgentRoot(view.projectDirectory);
      const agents = (await definitionNames(agentsRoot)).filter((name) => AGENT_NAME.test(name)).sort();
      const skillFolders = view.folders.filter((folder) => folder !== agentsRoot);
      const skills = (await discoverSkills(skillFolders)).map((skill) => skill.name);
      const globalAgents = new Set(
        (await listAgentEntries({ home: options.home, projectTrusted: false }))
          .filter((entry) => entry.source === "global")
          .map((entry) => entry.name)
      );
      const globalSkills = new Set(
        (
          await discoverSkills([join(options.home, "skills"), join(options.userHome, ".agents", "skills")])
        ).map((skill) => skill.name)
      );
      return {
        project: view,
        agents: agents.map((name) => ({ name, overrides: globalAgents.has(name) })),
        skills: skills.map((name) => ({ name, overrides: globalSkills.has(name) }))
      };
    }
  };
}

async function definitionNames(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder))
      .filter((file) => file.endsWith(".md"))
      .map((file) => basename(file, ".md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export type AgentService = ReturnType<typeof createAgentService>;
