import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { atriaHome } from "../../../scripts/data-home.cjs";
import {
  agentDefinitionSchema,
  agentLocations,
  BUILTIN_AGENT_NAMES,
  globalAgentRoot,
  listAgentEntries,
  projectAgentRoot,
  writeAgentDefinition,
  type AgentDefinition
} from "../../../dist/src/runtime/agent-definitions.js";
import { readMcpServers } from "../../../dist/src/runtime/mcp-config.js";
import { displayPath } from "../../../dist/src/runtime/display-path.js";
import type { AgentProposal } from "../../../dist/src/runtime/human.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CoworkToolContext } from "../extension.ts";
import type { RuntimeToolResult } from "../helpers.ts";
import { askHumanAndWait } from "./coordination.ts";

const CONFIRM: Record<AgentProposal["action"], string> = {
  create: "确认创建",
  update: "确认修改",
  disable: "确认停用",
  enable: "确认启用"
};
const QUESTION: Record<AgentProposal["action"], string> = {
  create: "创建 Agent",
  update: "修改 Agent",
  disable: "停用 Agent",
  enable: "启用 Agent"
};

function result(payload: Record<string, unknown>, isError = false): RuntimeToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
    ...(isError ? { isError: true } : {})
  };
}

/**
 * Main's way to list, create, change and switch off the user's Agents.
 *
 * Every write is shown to the user as the full definition first and happens
 * only after they confirm; a timeout or any other answer writes nothing. Main
 * can name MCP servers the user configured but cannot add one.
 */
export function registerAgentTools(pi: ExtensionAPI, context: CoworkToolContext) {
  const home = () => atriaHome();

  async function places() {
    const locations = await agentLocations(home(), context.projectDirectory);
    return { locations, entries: await listAgentEntries(locations) };
  }

  /** The change as it will be written, or the reason it cannot be. */
  async function plan(params: {
    action: AgentProposal["action"];
    scope?: "global" | "project";
    name?: string;
    definition?: unknown;
  }): Promise<{ proposal: AgentProposal } | { error: string }> {
    const scope = params.scope ?? "global";
    const { locations, entries } = await places();
    if (scope === "project" && !locations.projectTrusted)
      return {
        error: "这个项目还没有被信任，不能写项目 Agent；请用户先在工作区或设置里信任它，或者改为全局。"
      };
    const root = scope === "project" ? projectAgentRoot(context.projectDirectory) : globalAgentRoot(home());
    const existing = (name: string) =>
      entries.find((entry) => entry.name === name && entry.source === scope && entry.path);
    let definition: AgentDefinition;
    if (params.action === "create" || params.action === "update") {
      const parsed = agentDefinitionSchema.safeParse(params.definition);
      if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join("；") };
      definition = parsed.data;
      if ((BUILTIN_AGENT_NAMES as readonly string[]).includes(definition.name))
        return { error: "executor 与 reviewer 是内置 Agent 的名称，请换一个。" };
      const found = existing(definition.name);
      if (params.action === "create" && found)
        return {
          error: `${scope === "project" ? "项目" : "全局"}已有 Agent ${definition.name}；要改它请用 action=update。`
        };
      if (params.action === "update" && !found)
        return {
          error: `${scope === "project" ? "项目" : "全局"}没有 Agent ${definition.name}；新建请用 action=create。`
        };
      const configured = new Set((await readMcpServers(home())).map((server) => server.name));
      const missing = (definition.mcp ?? []).filter((name) => !configured.has(name));
      if (missing.length)
        return {
          error: `MCP 服务 ${missing.join("、")} 没有配置。只能引用设置 · MCP 里已有的服务，Main 不能新增服务；可请用户先添加。`
        };
    } else {
      const found = params.name ? existing(params.name) : undefined;
      if (!found?.definition)
        return {
          error: found
            ? `Agent ${params.name} 的定义有误：${found.error}`
            : `${scope === "project" ? "项目" : "全局"}没有 Agent ${params.name ?? ""}`
        };
      definition = { ...found.definition };
      if (params.action === "disable") definition.enabled = false;
      else delete definition.enabled;
    }
    return {
      proposal: {
        kind: "agent",
        action: params.action,
        scope,
        path: join(root, `${definition.name}.md`),
        displayPath: displayPath(join(root, `${definition.name}.md`), {
          userHome: homedir(),
          projectDirectory: context.projectDirectory
        }),
        definition
      }
    };
  }

  pi.registerTool({
    name: "manage_agent",
    label: "Manage Agent",
    description:
      "List the user's custom Agents, or propose creating, changing, switching off or on one. A proposal is shown to the user as the full definition and is written only after they confirm; any other answer writes nothing, and a timeout writes nothing. MCP servers must already be configured: you can name them, not add them.",
    promptSnippet: "List or propose changes to the user's custom Agents",
    promptGuidelines: [
      "Use manage_agent when the user asks for a reusable Agent or a change to one. Call action=list first to see what exists.",
      "Draft the whole definition: a short name, a description that tells Main when to delegate to it, permission (write changes code in its own checkout, read examines a copy and answers in text), the tools it needs, skills (omit for all), MCP servers it needs (only configured ones) and extra instructions.",
      "If the user answers with changes instead of confirming, revise the definition and call manage_agent again. Nothing was saved."
    ],
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("disable"),
          Type.Literal("enable")
        ]),
        scope: Type.Optional(
          Type.Union([Type.Literal("global"), Type.Literal("project")], {
            description:
              "global (~/.atria/agents, every project) or project (this project's .atria/agents). Default global."
          })
        ),
        name: Type.Optional(Type.String({ description: "The Agent to switch off or on." })),
        definition: Type.Optional(
          Type.Object(
            {
              name: Type.String({ description: "Letters, digits and hyphens." }),
              description: Type.String({ description: "When Main should delegate to this Agent." }),
              permission: Type.Union([Type.Literal("write"), Type.Literal("read")]),
              model: Type.Optional(Type.String({ description: "Omit to use the role's model." })),
              tools: Type.Optional(
                Type.Array(Type.String(), {
                  description:
                    "From read, bash, edit, write, grep, find, ls, browse_workspace, search, visit; read Agents cannot have edit or write."
                })
              ),
              skills: Type.Optional(Type.Array(Type.String(), { description: "Omit to see every skill." })),
              mcp: Type.Optional(Type.Array(Type.String(), { description: "Configured MCP server names." })),
              prompt: Type.Optional(
                Type.String({ description: "Extra instructions after the role's prompt." })
              )
            },
            { additionalProperties: false }
          )
        )
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<RuntimeToolResult> {
      if (params.action === "list") {
        const { locations, entries } = await places();
        return result({
          projectTrusted: locations.projectTrusted,
          agents: entries.map((entry) => ({
            name: entry.name,
            source: entry.source,
            ...(entry.path ? { path: entry.path } : {}),
            ...(entry.definition
              ? {
                  description: entry.definition.description,
                  permission: entry.definition.permission,
                  enabled: entry.definition.enabled !== false,
                  ...(entry.definition.skills ? { skills: entry.definition.skills } : {}),
                  ...(entry.definition.mcp ? { mcp: entry.definition.mcp } : {})
                }
              : { error: entry.error }),
            ...(entry.shadowedBy ? { replacedBy: entry.shadowedBy } : {})
          }))
        });
      }
      const planned = await plan({
        action: params.action,
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.name ? { name: params.name } : {}),
        ...(params.definition
          ? { definition: { ...params.definition, prompt: params.definition.prompt ?? "" } }
          : {})
      });
      if ("error" in planned) return result({ saved: false, error: planned.error }, true);
      const { proposal } = planned;
      const confirm = CONFIRM[proposal.action];
      const { settled } = await askHumanAndWait(
        context,
        {
          question: `${QUESTION[proposal.action]}：${proposal.definition.name}`,
          options: [confirm, "拒绝"],
          // A timeout proceeds on the recommended option: not writing.
          recommended: 1,
          proposal
        },
        signal,
        ctx
      );
      const answer = settled.status === "answered" ? (settled.request.answer ?? "").trim() : "";
      if (!answer.startsWith(confirm))
        return result({
          saved: false,
          status: settled.status,
          ...(answer ? { answer } : {}),
          instruction:
            settled.status === "answered"
              ? "用户没有确认，什么也没写入。如果回答里有修改意见，改好定义后再调用 manage_agent；用户选择在设置里修改时不要再提议。"
              : "没有得到确认，什么也没写入。"
        });
      // Written as confirmed; the state is checked again in case it changed while the user read it.
      const again = await plan(
        proposal.action === "create" || proposal.action === "update"
          ? { action: proposal.action, scope: proposal.scope, definition: proposal.definition }
          : { action: proposal.action, scope: proposal.scope, name: proposal.definition.name }
      );
      if ("error" in again) return result({ saved: false, error: again.error }, true);
      const path = await writeAgentDefinition(
        proposal.scope === "project" ? projectAgentRoot(context.projectDirectory) : globalAgentRoot(home()),
        proposal.definition
      );
      return result({
        saved: true,
        action: proposal.action,
        path,
        note: "下一次派单起生效，可用 call_subagent agent=<name> 派给它。"
      });
    }
  });
}
