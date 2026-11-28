import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { atomicWrite } from "../../dist/src/storage/atomic-file.js";
import { JsonlEventStore } from "../../dist/src/storage/event-store.js";
import { listAgentOutputFiles } from "../../dist/src/runtime/progress.js";
import { createFormicandModel } from "../../dist/src/runtime/model-profile.js";
import { formicandRoleIdentity } from "../../dist/src/domain/agent-identity.js";
import { agentDisplayName } from "../../dist/src/runtime/agent-identity.js";
import { delegationRoleGuidance } from "../../dist/src/runtime/delegation-model.js";
import { ASK_MAIN_GUIDANCE, SEND_PEER_MESSAGE_GUIDANCE } from "../../dist/src/runtime/subagent-guidance.js";
import { parseReviewScope, type ReviewConclusion } from "../../dist/src/runtime/subagent-review.js";
import {
  capabilityToolNames,
  subagentToolNames,
  type SubagentRole
} from "../../dist/src/runtime/subagent-roles.js";
import { capabilityProvider, parseCapabilityGrants } from "../../dist/src/runtime/capability-provider.js";
import {
  processSkillLocations,
  resolveSkillCatalog,
  skillCatalogPrompt
} from "../../dist/src/runtime/skill-registry.js";
import { piSkill } from "./skills.ts";
import { configuredWebTools } from "../../dist/src/runtime/web-search-config.js";
import { attachmentCapabilityProvider } from "../../dist/src/workspace/attachment-capabilities.js";
import {
  configuredContextWindow,
  configuredModelApi,
  configuredSubagentMaxTokens,
  configuredSupportsImages,
  configuredSupportsPromptCacheKey,
  configuredSupportsReasoningEffort,
  configuredThinkingFormat,
  runtimeSettingsEnv
} from "../../dist/src/runtime/runtime-settings.js";
import { loadConfig } from "./helpers.ts";
import { registerFormicandProvider } from "./provider.ts";
import { registerContextWindows } from "./context-windows.ts";
import { registerSessionContext } from "./session-context.ts";
import { SESSION_HISTORY_TOOLS } from "./tools/session-history.ts";
import { registerSubagentInbox } from "./subagent-inbox.ts";
import { blockedToolCall, taskProtectedPaths } from "./protected-call.ts";
import { processKillRefusal } from "../../dist/src/tools/process-kill.js";
import { parseTicketCriteria, type ExecutorReport } from "../../dist/src/runtime/executor-report.js";
import { registerSubagentTools } from "./tools/subagent.ts";
import { registerLoadSkillTool } from "./tools/workspace.ts";
import { registerWebSearchTools } from "./tools/web-search.ts";
import { SubagentQuestionStore } from "../../dist/src/runtime/subagent-questions.js";
import {
  agentDefinitionSchema,
  agentToolNames,
  type AgentDefinition
} from "../../dist/src/runtime/agent-definitions.js";
import { parseBuiltinAgentSettings, type BuiltinAgentSettings } from "../../dist/src/runtime/role-models.js";
import { createMcpRegistration } from "./mcp.ts";
import { readSubagentPause } from "../../dist/src/runtime/subagent-pause.js";

/**
 * The delegated process half of the shared agent extension.
 *
 * A work item's conclusion is written by the process that produced it, before
 * that process exits: a backend that only watched an exit would have to guess.
 * The backend treats a missing record as a failure, so this record is the one
 * success signal for a delegated call. A Reviewer's record must additionally
 * carry a well-formed conclusion — the verdict is a structured fact, not prose
 * the backend would have to interpret.
 */

export type AgentRole = SubagentRole;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Agent process is missing ${name}`);
  return value;
}

function textFrom(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
    .join("")
    .trim();
}

/** The custom Agent this process runs as, fixed by the backend when the item was dispatched. */
function customAgent(): AgentDefinition | undefined {
  const raw = process.env.FORMICAND_AGENT_DEFINITION;
  if (!raw) return undefined;
  return agentDefinitionSchema.parse(JSON.parse(raw));
}

/** A built-in Executor's or Reviewer's settings, fixed by the backend when the item was dispatched. */
function builtinAgent(): BuiltinAgentSettings | undefined {
  const raw = process.env.FORMICAND_BUILTIN_AGENT;
  if (!raw) return undefined;
  return parseBuiltinAgentSettings(JSON.parse(raw));
}

/** MCP tools come and go with their servers; the definition's list keeps whatever Pi activated for them. */
const MCP_TOOL = /^(mcp__|tool_search$|list_mcp_resources$|list_mcp_resource_templates$|read_mcp_resource$)/;

export async function registerSubagentAgent(pi: ExtensionAPI, role: AgentRole): Promise<void> {
  const workspaceRoot = required("FORMICAND_WORKSPACE");
  const taskId = required("FORMICAND_TASK_ID");
  const runId = required("FORMICAND_RUN_ID");
  const callId = required("FORMICAND_SUBAGENT_CALL_ID");
  const agentId = required("FORMICAND_AGENT_ID");
  const token = required("FORMICAND_SUBAGENT_TOKEN");
  const resultPath = required("FORMICAND_SUBAGENT_RESULT");
  const taskWorkspace = join(workspaceRoot, taskId);
  const workingDirectory = resolve(process.cwd());
  const name = agentDisplayName(agentId);
  const deliverablesDirectory = join(taskWorkspace, "agents", "subagents", agentId, "deliverables");
  let submittedReview: ReviewConclusion | undefined;
  let submittedReport: ExecutorReport | undefined;
  // A ticket Executor answers each of the ticket's criteria through submit_report.
  const ticketCriteria =
    role === "executor" ? parseTicketCriteria(process.env.FORMICAND_TICKET_CRITERIA) : undefined;
  const reportTool = ticketCriteria ? ["submit_report"] : [];
  const agent = customAgent();
  const builtin = agent ? undefined : builtinAgent();
  // Only the servers the definition or the role's setting names; they connect when the session starts.
  const servers = agent ? (agent.mcp ?? []) : (builtin?.mcp ?? []);
  if (servers === "all" || servers.length) {
    const problem = await createMcpRegistration(
      pi,
      undefined,
      servers === "all" ? undefined : servers
    ).sync();
    if (problem) console.error(problem);
  }
  const skillFilter = agent ? agent.skills : builtin?.skills === "all" ? undefined : builtin?.skills;

  // The same provider the Main process registers, with this agent's session and
  // limits; without it Pi has no stream to the configured connection.
  const config = loadConfig();
  const runtimeEnv = runtimeSettingsEnv(config);
  // The same public web provider Main reads from this config: a delegated item
  // that must cite a source reads it itself. Search turned off registers nothing,
  // and the role table's names for it then resolve to no tool, as on Main.
  const web = configuredWebTools(config);
  const baseUrl = process.env.FORMICAND_API_BASE ?? config.baseUrl ?? config.apiBase ?? "";
  const apiKey = process.env.FORMICAND_API_KEY ?? config.apiKey;
  if (!baseUrl || !apiKey)
    throw new Error("Formicand model configuration is missing for the delegated agent process");
  const model = createFormicandModel({
    baseUrl,
    api: configuredModelApi(runtimeEnv),
    thinkingFormat: configuredThinkingFormat(runtimeEnv),
    model: process.env.FORMICAND_MODEL ?? config.model ?? "glm-5.3",
    maxTokens: configuredSubagentMaxTokens(runtimeEnv),
    contextWindow: configuredContextWindow(runtimeEnv),
    supportsImages: configuredSupportsImages(runtimeEnv),
    supportsReasoningEffort: configuredSupportsReasoningEffort(runtimeEnv)
  });
  registerFormicandProvider(pi, {
    model,
    apiKey,
    sessionId: `formicand:${taskId}:${agentId}`,
    supportsPromptCacheKey: configuredSupportsPromptCacheKey(runtimeEnv)
  });

  // The same protected-path rule Main enforces, with this process's checkout as
  // the project root. A shell command is a write path too, so the shared guard
  // reads it rather than trusting that the Reviewer merely lacks write/edit.
  const guard = taskProtectedPaths(workingDirectory);
  const guardEvents = new JsonlEventStore(join(workspaceRoot, taskId, "runs", runId, "run_events.jsonl"));
  const appendGuardEvent = async (path: string, pattern: string, toolName: string): Promise<void> => {
    try {
      await guardEvents.append({
        eventId: `guard-${randomUUID()}`,
        type: "guard.write_refused",
        taskId,
        runId,
        agentId,
        occurredAt: new Date().toISOString(),
        payload: { path, pattern, toolName }
      });
      // eslint-disable-next-line no-restricted-syntax -- 拒绝写入已经通过 tool_call 返回给模型，诊断事件写入失败只少了事后记录
    } catch {
      /* diagnostics only */
    }
  };

  // The backend passes what this work item was granted. No grant means no
  // capability tool at all: an ungranted reader is not registered rather than
  // registered and made to refuse every id.
  const harnessRoot = resolve(process.env.FORMICAND_HARNESS_ROOT ?? process.cwd());
  // Project skills are read from the user's project, whose trust decision is
  // recorded there, not from this process's isolated checkout.
  // A definition that lists skills sees only those; one that lists none sees all.
  const skillCatalogNow = async () =>
    (
      await resolveSkillCatalog(
        await processSkillLocations(harnessRoot, process.env.FORMICAND_PROJECT_DIR ?? workingDirectory)
      )
    ).filter((skill) => !skillFilter || skillFilter.includes(skill.name));
  const grants = parseCapabilityGrants(process.env.FORMICAND_AGENT_GRANTS);
  if (grants.some((grant) => grant.provider !== "attachments"))
    throw new Error(
      `Delegated agent received an unsupported capability grant: ${grants.map((grant) => grant.provider).join(", ")}`
    );
  // Capability registration is async (a grant is checked against this Task's
  // own upload records), so it happens at the start boundary, before Pi builds
  // the first request's tool table and system prompt.
  let capabilityPrompt: string | undefined;
  const rolePrompt = () =>
    subagentRolePrompt({
      role,
      ...(agent ? { agent } : {}),
      ...(builtin?.prompt ? { extraPrompt: builtin.prompt } : {}),
      name,
      workingDirectory,
      taskWorkspace,
      deliverablesDirectory,
      ...(capabilityPrompt ? { capabilityPrompt } : {})
    });

  // Pi 1.5 warms the prompt cache by default. A delegated process does not
  // adopt the capability either, so every refresh stops until the next real
  // request instead of sending an extra model call while the work item runs.
  pi.on("cache_warming_decision", () => ({ action: "stop" }));

  pi.on("tool_call", async (event) => {
    const refused =
      processKillRefusal(event.toolName, event.input) ??
      blockedToolCall(event.toolName, event.input, guard, workingDirectory);
    if (!refused) return undefined;
    void appendGuardEvent(refused.path, refused.pattern, event.toolName);
    return { block: true, reason: refused.reason };
  });

  pi.on("session_start", async () => {
    // The role — not the extension entry — decides what this process may do.
    // The Reviewer has no write/edit tool; its shell runs inside its own
    // candidate checkout, so a later tool discovery cannot hand it a way to
    // change the Executor's checkout or the candidate commit.
    await mkdir(deliverablesDirectory, { recursive: true });
    if (grants.length) {
      const provided = await capabilityProvider(
        new Map([["attachments", attachmentCapabilityProvider(harnessRoot)]])
      )(grants, {
        taskId,
        runId,
        callId,
        agentId,
        workspaceRoot,
        workingDirectory,
        supportsImages: configuredSupportsImages(runtimeEnv)
      });
      capabilityPrompt = provided.prompt;
      for (const [toolName, tool] of provided.tools)
        pi.registerTool({
          name: toolName,
          label: toolName,
          description: tool.description ?? toolName,
          parameters: Type.Unsafe(tool.parameters ?? { type: "object", properties: {} }),
          async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
            return (await tool.execute(params, signal)) as AgentToolResult<unknown>;
          }
        });
    }
    pi.setActiveTools(
      agent
        ? [
            ...agentToolNames(agent),
            ...reportTool,
            ...SESSION_HISTORY_TOOLS,
            "clear_context",
            ...capabilityToolNames(grants),
            ...pi.getActiveTools().filter((tool) => MCP_TOOL.test(tool))
          ]
        : [
            ...subagentToolNames(role, grants),
            ...reportTool,
            ...SESSION_HISTORY_TOOLS,
            "clear_context",
            // The servers the role's setting names were the only ones registered.
            ...pi.getActiveTools().filter((tool) => MCP_TOOL.test(tool))
          ]
    );
  });

  // Role text is additive: Pi's own tool list and rules stay, and the role
  // section states what this process is for. The transcript's identity line is
  // rewritten per request below, like Main does for its own sessions.
  pi.on("before_agent_start", async (event) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 调用方可能只提供 systemPrompt，缺少结构化选项时走下面的回退分支
    if (event.systemPromptOptions) {
      const catalog = await skillCatalogNow();
      event.systemPromptOptions.skills = catalog.map(piSkill);
      // Pi's own section tells the model to read SKILL.md; every process loads skills with load_skill.
      event.systemPromptOptions.sections.skills = skillCatalogPrompt(catalog);
      event.systemPromptOptions.sections.subagent_role = rolePrompt();
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n<subagent_role>\n${rolePrompt()}\n</subagent_role>` };
  });

  pi.on("context_with_system", (event) => ({
    messages: event.messages.map((message) =>
      message.role === "system" && message.sections
        ? {
            ...message,
            sections: {
              ...message.sections,
              preamble: formicandRoleIdentity("Subagent"),
              // The harness's own documentation pointer is Main's business; a
              // delegated work item reads the project, not the runtime.
              docs: null
            }
          }
        : message
    )
  }));

  registerSessionContext(pi);
  registerContextWindows(pi, { workspaceRoot, taskId, runId, callId });

  registerSubagentTools(pi, {
    role,
    customAgent: Boolean(agent),
    workspaceRoot,
    taskId,
    runId,
    callId,
    agentId,
    taskWorkspace,
    ...(role === "reviewer" && process.env.FORMICAND_REVIEW_SCOPE
      ? { reviewScope: parseReviewScope(process.env.FORMICAND_REVIEW_SCOPE) }
      : {}),
    ...(ticketCriteria ? { ticketCriteria } : {}),
    submitReview: (review) => {
      submittedReview = review;
    },
    submitReport: (report) => {
      submittedReport = report;
    }
  });

  // The same loader over the same catalog as Main: a published skill that tells
  // a Subagent to load itself returns the instructions, directory and bundled
  // script paths Main would get, and grants nothing beyond read-only loading.
  registerLoadSkillTool(pi, skillCatalogNow);
  registerWebSearchTools(pi, web);

  // Main's guidance and a peer's message reach this process through its own
  // durable Inbox; nothing about that channel is Main-specific.
  registerSubagentInbox(pi, { workspaceRoot, taskId, runId, agentId });

  // A paused Main holds its Subagents. The hold is read at the end of each
  // step, so the step in flight finishes and the next one waits here until
  // Main's next turn lifts the hold (or the process is stopped).
  pi.on("turn_end", async (_event, ctx) => {
    let held: string | undefined;
    while (!ctx.signal?.aborted) {
      // eslint-disable-next-line no-restricted-syntax -- 暂停记录读不到时按未暂停处理，子助手继续工作而不是卡住
      const pause = await readSubagentPause(workspaceRoot, taskId, runId).catch(() => undefined);
      if (!pause) break;
      if (!held) {
        held = new Date().toISOString();
        await recordHold("subagent.paused", { pausedAt: pause.pausedAt });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (held) await recordHold("subagent.resumed", { heldSince: held });
  });
  const recordHold = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      await guardEvents.append({
        eventId: `${type}-${randomUUID()}`,
        type,
        taskId,
        runId,
        agentId,
        callId,
        occurredAt: new Date().toISOString(),
        payload
      });
      // eslint-disable-next-line no-restricted-syntax -- 暂停的记录只是事后诊断，写不进去不影响暂停本身
    } catch {
      /* diagnostics only */
    }
  };

  // `agent_end` is the last hook Pi awaits before a --print host may dispose the
  // session, so the record is durable before the process can exit.
  pi.on("agent_end", async (event) => {
    // A question this attempt left open can never be answered once it ends.
    // Closing it here keeps a finished work item from parking its Task.
    try {
      const expired = await new SubagentQuestionStore(workspaceRoot).expireForCall(taskId, callId);
      if (expired.length > 0)
        await guardEvents.append({
          eventId: `question-expired-${randomUUID()}`,
          type: "question.expired_on_terminal",
          taskId,
          runId,
          agentId,
          callId,
          occurredAt: new Date().toISOString(),
          payload: { questionIds: expired.map((question) => question.questionId) }
        });
      // eslint-disable-next-line no-restricted-syntax -- 关闭遗留提问是收尾簿记，失败不能把已结束的一轮判成失败
    } catch {
      /* bookkeeping only */
    }
    const last = event.messages.findLast((message) => message.role === "assistant");
    const completed = Boolean(last && !["error", "aborted", "length"].includes(last.stopReason));
    const response = last && completed ? textFrom(last.content) : "";
    // eslint-disable-next-line no-restricted-syntax -- 候选文件扫描失败不应阻止写出本轮结论；没有列表比没有结果记录更接近事实
    const outputFiles = await listAgentOutputFiles({ workspaceRoot, taskId, agentId }).catch(() => []);
    const error = completed
      ? role === "reviewer" && !agent && !submittedReview
        ? "Reviewer ended without submitting a review conclusion; call submit_review with a verdict and findings."
        : ticketCriteria && !submittedReport
          ? "Executor ended without a ticket report; call submit_report with each acceptance criterion."
          : undefined
      : (last?.errorMessage ?? `Subagent turn ended with stop reason ${last?.stopReason ?? "missing"}`);
    const termination = completed && !error && response ? "completed" : "failed";
    await atomicWrite(
      resultPath,
      `${JSON.stringify(
        {
          version: 1,
          taskId,
          runId,
          callId,
          agentId,
          role,
          token,
          termination,
          stopReason: last?.stopReason,
          response,
          outputFiles,
          ...(submittedReview ? { review: submittedReview } : {}),
          ...(submittedReport ? { report: submittedReport } : {}),
          diagnostics: {
            tracePath: relative(taskWorkspace, join(taskWorkspace, "sessions", agentId, "pi", callId))
              .split(sep)
              .join("/"),
            resultPath: relative(taskWorkspace, resultPath).split(sep).join("/")
          },
          ...(error ? { error } : {}),
          completedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
  });
}

/** How every delegated role ends its work, so Main reads one shape. */
const HAND_BACK =
  "End with a hand-back in three short parts. Result: what you changed or found, and whether the task is done. Evidence: the commands you ran with what they showed, and the files and commits involved. Tried and dropped: approaches that did not work and why, so nobody repeats them (write none if there were none). Claim only work you did, and state any assumption you made.";

/**
 * The role half of a delegated process's system prompt.
 *
 * Only the workspace facts and the tool set the role actually holds are added
 * here; the role text itself is shared with the delegation tools.
 */
export function subagentRolePrompt(input: {
  role: SubagentRole;
  /** The custom Agent: its read permission answers in text, and its prompt follows the role's. */
  agent?: AgentDefinition;
  /** The user's extra prompt for a built-in role, from the Agent page. */
  extraPrompt?: string;
  name: string;
  workingDirectory: string;
  taskWorkspace: string;
  deliverablesDirectory: string;
  /** Text the granted capabilities add, such as the upload ids this item may read. */
  capabilityPrompt?: string;
}): string {
  const shared = [
    delegationRoleGuidance({ role: input.role }),
    `Your team name is ${input.name}. Main and the UI use this stable name to identify your work.`,
    `Your working directory: ${input.workingDirectory}. File and command tools resolve relative paths from there.`,
    `Shared Task workspace (browse_workspace paths start here): ${input.taskWorkspace}.`,
    "Read the brief and the files Main names. browse_workspace shows shared Task state, other Agents' progress and published artifacts when the task depends on them.",
    "When choosing a test command, run the full required scope with up to two parallel workers (node --test --test-concurrency=2, playwright test --workers=2). Honor explicit commands and tighter project limits.",
    HAND_BACK,
    ...(input.capabilityPrompt ? [input.capabilityPrompt] : [])
  ];
  const extra = input.agent?.prompt.trim()
    ? [
        `Instructions for the ${input.agent.name} Agent, from its definition. They add to the rules above and never replace them:\n${input.agent.prompt.trim()}`
      ]
    : input.extraPrompt?.trim()
      ? [
          `Instructions the user set for this role. They add to the rules above and never replace them:\n${input.extraPrompt.trim()}`
        ]
      : [];
  if (input.agent && input.role === "reviewer")
    return [
      ...shared,
      "You work in a checkout of the project that is yours alone. You have no edit or write tool; files you create stay in that checkout and never reach the project. Run the commands that support your conclusion.",
      ASK_MAIN_GUIDANCE,
      SEND_PEER_MESSAGE_GUIDANCE,
      ...extra
    ].join("\n\n");
  if (input.role === "reviewer")
    return [
      ...shared,
      "You examine a checkout of the candidate that is yours alone: run the tests and commands that prove or reproduce what you report. You have no edit or write tool, so files you create stay in your checkout and never reach the candidate, the Executor's checkout or the project.",
      "Run every acceptance command in the brief yourself: the Executor's report is a claim, not evidence. Then check the criteria that have no command.",
      "A finding blocks only on a basis: an acceptance criterion it violates (cite its id), or a floor problem — regression (behaviour that worked before is broken), data_loss, security, or project_rule (it breaks the project's stated rules, such as its AGENTS.md). Anything else, however worthwhile, is a non-blocking suggestion: another design, style, extra tests or features nobody asked for.",
      "On a re-review the brief lists the previous round's findings: answer each, re-run the acceptance commands, and look only at the files changed this round.",
      "When you review a code change, load the code-review skill with load_skill and follow it.",
      "Your verdict reaches Main only through submit_review: pass or changes_requested, and every finding states its title, location, evidence, whether it blocks and, if it does, its basis. A work item that ends without one is recorded as a failure; a malformed submission returns an error you can correct.",
      ASK_MAIN_GUIDANCE,
      SEND_PEER_MESSAGE_GUIDANCE,
      ...extra
    ].join("\n\n");
  return [
    ...shared,
    "Stay inside the brief: when the task needs a change it does not cover, ask Main rather than widening it yourself.",
    ...(input.agent
      ? []
      : ["When the brief asks you to change code, load the implement skill with load_skill and follow it."]),
    `Put substantial reusable candidate outputs under ${input.deliverablesDirectory}; keep scratch files and intermediate logs in the work site. Do not write to Task artifacts/ — Main publishes accepted files.`,
    ASK_MAIN_GUIDANCE,
    SEND_PEER_MESSAGE_GUIDANCE,
    ...extra
  ].join("\n\n");
}
