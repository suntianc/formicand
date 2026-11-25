import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ComposerReference, ResolvedReference } from "../runtime/composer-references.js";
import {
  enabledMcpServers,
  isHttpServer,
  readMcpServers,
  type McpServerConfig
} from "../runtime/mcp-config.js";
import { projectTrustDecision } from "../runtime/project-trust.js";
import { removedSkillDirectories } from "../runtime/skill-index.js";
import { listSkillEntries, skillRootsFor, type SkillSource } from "../runtime/skill-registry.js";
import { parseSkillFrontmatter } from "../runtime/skill-frontmatter.js";
import { agentLocations, availableAgents } from "../runtime/agent-definitions.js";
import { createProjectFileIndex, type ProjectFileIndex } from "../workspace/project-file-index.js";

export { fuzzyScore } from "../workspace/project-file-index.js";

export interface ComposerSkill {
  name: string;
  description: string;
  source: SkillSource;
}

export interface ComposerPrompt {
  name: string;
  description: string;
  source: "global" | "project";
  body: string;
}

export interface ComposerResource {
  server: string;
  uri: string;
  name: string;
  description?: string;
}

export interface ComposerServiceOptions {
  harnessRoot: string;
  home: string;
  userHome: string;
  projectForId(projectId: string): Promise<{ projectDirectory?: string } | null>;
  /** The shared listing of project files; one is made when absent. */
  fileIndex?: ProjectFileIndex;
}

const PROMPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROMPT_LIMIT = 64 * 1024;
const FILE_RESULTS = 30;
const RESOURCE_CACHE_MS = 60_000;
const RESOURCE_TIMEOUT_MS = 10_000;

/** `${VAR}` in a value comes from the environment; `!command` values are not run here. */
function resolveValue(value: string): string | undefined {
  if (value.startsWith("!")) return undefined;
  const keys = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
  if (keys.some((key) => process.env[key] === undefined)) return undefined;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? "");
}

function resolveRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const next = resolveValue(value);
    if (next === undefined) return undefined;
    resolved[key] = next;
  }
  return resolved;
}

/** Every resource one server lists, or nothing when it cannot be reached without help. */
async function serverResources(name: string, config: McpServerConfig): Promise<ComposerResource[]> {
  let transport;
  if (isHttpServer(config)) {
    const headers = resolveRecord(config.headers);
    if (!headers) return [];
    transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
  } else {
    const env = resolveRecord(config.env);
    if (!env) return [];
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...env },
      ...(config.cwd ? { cwd: config.cwd } : {}),
      stderr: "ignore"
    });
  }
  const client = new Client({ name: "formicand-composer", version: "1" });
  try {
    await client.connect(transport, { timeout: RESOURCE_TIMEOUT_MS });
    if (!client.getServerCapabilities()?.resources) return [];
    const found: ComposerResource[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listResources(cursor ? { cursor } : {}, { timeout: RESOURCE_TIMEOUT_MS });
      for (const resource of page.resources) {
        // MCP App interfaces are for hosts that render them, not context for a model.
        if (resource.uri.startsWith("ui://")) continue;
        found.push({
          server: name,
          uri: resource.uri,
          name: resource.title ?? resource.name,
          ...(resource.description ? { description: resource.description } : {})
        });
      }
      cursor = page.nextCursor;
    } while (cursor && found.length < 500);
    return found;
  } finally {
    await client.close();
  }
}

/** The `/` and `@` menus of the composer, and the check of what a message references. */
export function createComposerService(options: ComposerServiceOptions) {
  const fileIndex = options.fileIndex ?? createProjectFileIndex();
  let resourceCache: { at: number; signature: string; resources: Promise<ComposerResource[]> } | undefined;

  async function projectDirectory(projectId: string | undefined): Promise<string | undefined> {
    if (!projectId) return undefined;
    const record = await options.projectForId(projectId);
    return record?.projectDirectory ? resolve(record.projectDirectory) : undefined;
  }

  async function skills(directory: string | undefined): Promise<Array<ComposerSkill & { path: string }>> {
    const trusted = directory ? (await projectTrustDecision(options.home, directory)) === "trusted" : false;
    const entries = await listSkillEntries(
      skillRootsFor({
        harnessRoot: options.harnessRoot,
        home: options.home,
        userHome: options.userHome,
        ...(directory ? { projectDirectory: directory } : {}),
        projectTrusted: trusted
      }),
      await removedSkillDirectories(options.home)
    );
    return entries
      .filter((entry) => !entry.removed && !entry.shadowedBy)
      .map(({ name, description, source, path }) => ({ name, description, source, path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function promptsIn(folder: string, source: ComposerPrompt["source"]): Promise<ComposerPrompt[]> {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const prompts: ComposerPrompt[] = [];
    for (const file of names.sort()) {
      if (!file.endsWith(".md")) continue;
      const name = file.slice(0, -3);
      if (!PROMPT_NAME.test(name)) continue;
      const path = join(folder, file);
      const info = await stat(path);
      if (!info.isFile() || info.size > PROMPT_LIMIT) continue;
      const { frontmatter, body } = parseSkillFrontmatter(await readFile(path, "utf8"));
      const text = body.trim();
      if (!text) continue;
      const description =
        typeof frontmatter.description === "string" && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : (text.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 120);
      prompts.push({ name, description, source, body: text });
    }
    return prompts;
  }

  async function prompts(directory: string | undefined): Promise<ComposerPrompt[]> {
    const global = await promptsIn(join(options.home, "prompts"), "global");
    if (!directory) return global;
    const project = await promptsIn(join(directory, ".formicand", "prompts"), "project");
    const names = new Set(project.map((prompt) => prompt.name));
    return [...project, ...global.filter((prompt) => !names.has(prompt.name))].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  async function resources(): Promise<ComposerResource[]> {
    const servers = enabledMcpServers(await readMcpServers(options.home));
    const signature = JSON.stringify(servers);
    if (
      resourceCache &&
      resourceCache.signature === signature &&
      Date.now() - resourceCache.at < RESOURCE_CACHE_MS
    )
      return resourceCache.resources;
    const listed = Promise.all(
      servers.map(({ name, config }) =>
        // A server that is down or needs sign-in shows no resources; its state is on the MCP page.
        // eslint-disable-next-line no-restricted-syntax -- 单个服务连不上只影响它自己的资源，不影响菜单其余部分
        serverResources(name, config).catch(() => [])
      )
    ).then((lists) => lists.flat());
    resourceCache = { at: Date.now(), signature, resources: listed };
    return listed;
  }

  return {
    /** What the `/` menu offers for a project, or for no project. */
    async slash(projectId?: string) {
      const directory = await projectDirectory(projectId);
      return {
        skills: (await skills(directory)).map(({ name, description, source }) => ({
          name,
          description,
          source
        })),
        prompts: await prompts(directory)
      };
    },

    /** Project files whose path matches the query, best first. */
    async files(projectId: string | undefined, query: string) {
      const directory = await projectDirectory(projectId);
      if (!directory) return { files: [] as string[] };
      return { files: await fileIndex.search(directory, query, FILE_RESULTS) };
    },

    async resources() {
      return { resources: await resources() };
    },

    /** The custom Agents Main can hand work to here, for the `@` menu. */
    async agents(projectId?: string) {
      const directory = await projectDirectory(projectId);
      return {
        agents: (await availableAgents(await agentLocations(options.home, directory))).map((agent) => ({
          name: agent.name,
          description: agent.description,
          permission: agent.permission
        }))
      };
    },

    /**
     * The references a message keeps: skills Main can load, files inside the
     * project, resources of configured servers. Anything else is dropped — the
     * words stay in the message, so nothing the person wrote is lost.
     */
    async resolve(
      directory: string | undefined,
      references: ComposerReference[]
    ): Promise<ResolvedReference[]> {
      const root = directory ? resolve(directory) : undefined;
      const catalog = new Map((await skills(root)).map((skill) => [skill.name, skill.path]));
      const servers = new Set(
        enabledMcpServers(await readMcpServers(options.home)).map((server) => server.name)
      );
      const agents = new Set(
        (await availableAgents(await agentLocations(options.home, root))).map((agent) => agent.name)
      );
      const resolved: ResolvedReference[] = [];
      for (const reference of references) {
        if (reference.kind === "skill") {
          const path = catalog.get(reference.name);
          if (path) resolved.push({ kind: "skill", name: reference.name, path });
        } else if (reference.kind === "file") {
          if (!root || isAbsolute(reference.path) || reference.path.includes("\0")) continue;
          const full = resolve(root, reference.path);
          if (full !== root && !full.startsWith(root + sep)) continue;
          try {
            if ((await stat(full)).isFile())
              resolved.push({ kind: "file", path: relative(root, full).split(sep).join("/") });
            // eslint-disable-next-line no-restricted-syntax -- 不存在的文件不算引用，消息原文照常发送
          } catch {
            continue;
          }
        } else if (reference.kind === "agent") {
          if (agents.has(reference.name)) resolved.push(reference);
        } else if (servers.has(reference.server)) resolved.push(reference);
      }
      // `./a.sql` and `a.sql` are one file.
      const seen = new Set<string>();
      return resolved.filter((reference) => {
        const key = JSON.stringify(reference);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  };
}

export type ComposerService = ReturnType<typeof createComposerService>;
