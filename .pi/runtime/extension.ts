import { createMainJobs } from "./main-jobs.ts";
import { registerMainLifecycle } from "./main-lifecycle.ts";
import {
  availableAgents,
  customAgentsPrompt,
  processAgentLocations
} from "../../dist/src/runtime/agent-definitions.js";
import { configuredWebTools } from "../../dist/src/runtime/web-search-config.js";
import { builtinAgentSettings } from "../../dist/src/runtime/role-models.js";
import { readQueuedUserTurn } from "../../dist/src/runtime/queued-user-turn.js";
import { stripReferencesBlock } from "../../dist/src/runtime/composer-references.js";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry
} from "@earendil-works/pi-coding-agent";
import {
  extractInboxReceipts,
  inboxReceiptKey,
  readPersistedSessionReceiptKeys
} from "../../dist/src/runtime/main-inbox-delivery.js";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  ensureMainContext,
  mainContextPaths,
  persistMainSessionContext,
  readMainContextState,
  updateMainContextRuntime
} from "../../dist/src/runtime/main-context.js";
import {
  MAIN_CONTINUATION_TYPE,
  isMainContinuationMessage,
  registerMainContinuation
} from "../../dist/src/runtime/main-continuation.js";
import { readAcceptedMainMessage } from "../../dist/src/runtime/main-message-edit.js";
import type { PiThinkingLevel } from "../../dist/src/runtime/runtime-settings.js";
import {
  configuredMainMaxTokens,
  configuredContextWindow,
  configuredModelApi,
  configuredThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  configuredWorkspaceRoot,
  normalizeReasoningEffort,
  runtimeSettingsEnv
} from "../../dist/src/runtime/runtime-settings.js";
import { createFormicandModel } from "../../dist/src/runtime/model-profile.js";
import { withEndpointLimits } from "../../dist/src/runtime/model-catalog.js";
import { MAIN_MODEL_FROM_CONFIG, resolveMainTurnModel } from "../../dist/src/runtime/main-turn-model.js";
import { recordModelRequests } from "../../dist/src/runtime/model-request-recording.js";
import { ModelRequestRecorder } from "../../dist/src/storage/model-request-recorder.js";
import {
  MainRequestStore,
  mainRequestPath,
  parseMainRequestModel
} from "../../dist/src/storage/main-request-store.js";
import { MainRequestRetry, mainRequestEnvironment } from "../../dist/src/runtime/main-request-retry.js";
import { projectFormicandSystemMessage } from "../../dist/src/domain/agent-identity.js";
import { JsonlEventStore } from "../../dist/src/storage/event-store.js";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";
import { capabilityProvider } from "../../dist/src/runtime/capability-provider.js";
import {
  processSkillLocations,
  resolveSkillCatalog,
  skillCatalogPrompt,
  type SkillMetadata
} from "../../dist/src/runtime/skill-registry.js";
import { piSkill } from "./skills.ts";
import { attachmentCapabilityProvider } from "../../dist/src/workspace/attachment-capabilities.js";
import { withMainRuntimeContext } from "./main-context-prompt.ts";
import { errorMessage, loadConfig, textFromMessage } from "./helpers.ts";
import { registerCoordinationTools } from "./tools/coordination.ts";
import { registerAgentTools } from "./tools/agents.ts";
import { registerJobsTools } from "./tools/jobs.ts";
import { registerProjectLedgerTool } from "./tools/project-ledger.ts";
import { registerProjectDevelopmentTool } from "./tools/project-development.ts";
import { registerMemoryTool } from "./tools/memory.ts";
import { createProjectLedgerClient } from "../../dist/src/runtime/project-ledger-client.js";
import { registerWorkspaceTools } from "./tools/workspace.ts";
import { registerComputerTools } from "./tools/computer-use.ts";
import { registerBrowserTools } from "./tools/browser-use.ts";
import { createCuaDispatcher } from "./tools/cua-dispatch.ts";
import { registerCuaScriptTools } from "./tools/cua-script.ts";
import { CORE_TOOLS, registerCapabilityTools } from "./tools/capabilities.ts";
import { createCliPresentation } from "./cli-ui.ts";
import { registerCliCommands } from "./cli-commands.ts";
import { recordCliSessionBinding } from "../../scripts/cli-session.mjs";
import { registerWebSearchTools } from "./tools/web-search.ts";
import { registerSearchTools } from "./tools/file-search.ts";
import { registerImageTools } from "./tools/images.ts";
import { registerSubagentAgent } from "./subagent-agent.ts";
import { blockedToolCall, taskProtectedPaths } from "./protected-call.ts";
import { registerFormicandProvider } from "./provider.ts";
import { createMcpRegistration } from "./mcp.ts";
import { registerSessionContext } from "./session-context.ts";
import { registerContextWindows } from "./context-windows.ts";
import { createProjectDevelopmentClient } from "../../dist/src/runtime/project-development-client.js";
import type { WindowDevelopment } from "../../dist/src/runtime/session-handoff.js";
import { registerSessionHistoryTools } from "./tools/session-history.ts";
import { mainContextUsagePath } from "../../dist/src/runtime/session-context-usage.js";

/**
 * One extension entry for Main and delegated agent processes.
 *
 * A delegated process selects its role through the environment the backend
 * launched it with; it loads the same file, tools and lifecycle hooks rather
 * than a second extension that would drift from Main's.
 */
export default async function registerFormicandExtension(pi: ExtensionAPI) {
  const role = process.env.FORMICAND_AGENT_ROLE;
  if (role === "executor" || role === "reviewer") {
    registerSessionHistoryTools(pi);
    await registerSubagentAgent(pi, role);
    return;
  }
  return registerMainExtension(pi);
}

async function registerMainExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const runtimeEnv = runtimeSettingsEnv(config);
  const supportsImages = configuredSupportsImages(runtimeEnv);
  const supportsReasoningEffort = configuredSupportsReasoningEffort(runtimeEnv);
  const currentThinkingLevel = (): PiThinkingLevel =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 宿主不提供 getThinkingLevel，缺方法时回退到配置的推理强度
    normalizeReasoningEffort(pi.getThinkingLevel?.() ?? configuredReasoningEffort(runtimeEnv));
  const baseUrl = process.env.FORMICAND_API_BASE ?? config.baseUrl ?? config.apiBase;
  const apiKey = process.env.FORMICAND_API_KEY ?? config.apiKey;
  const modelId = process.env.FORMICAND_MODEL ?? config.model ?? "glm-5.3";
  // Main is resident, so the search choice saved in the settings page must reach
  // this process's next turn rather than wait for a new process; the turn
  // boundary below re-reads it and keeps `search`/`visit` in step.
  let web = configuredWebTools(config);
  let memoryTool: ReturnType<typeof registerMemoryTool>;
  const workspaceRoot = configuredWorkspaceRoot(config);
  const taskId = process.env.FORMICAND_TASK_ID ?? config.taskId ?? `task-${randomUUID()}`;
  const dashboardUrl = process.env.FORMICAND_DASHBOARD_URL;
  let historyBridge: ReturnType<typeof createProjectLedgerClient> | undefined;
  // The other sessions of this project, through the Dashboard that owns the catalog.
  registerSessionHistoryTools(
    pi,
    dashboardUrl
      ? (input) =>
          (historyBridge ??= createProjectLedgerClient({ dashboardUrl, taskId, label: "历史搜索" })).history(
            input
          )
      : undefined
  );
  registerSessionContext(pi, mainContextUsagePath(workspaceRoot, taskId));
  // A stable task id gives the Main Run a stable Inbox across Pi restarts.
  // Override either value when deliberately starting a fresh run.
  const mainRunId = process.env.FORMICAND_RUN_ID ?? `main-${taskId}`;
  const windows = registerContextWindows(pi, {
    workspaceRoot,
    taskId,
    runId: mainRunId,
    ...(dashboardUrl && process.env.FORMICAND_API_TOKEN
      ? {
          readDevelopment: async (signal) => {
            const response = await createProjectDevelopmentClient({ dashboardUrl, taskId })(
              { action: "context_handoff" },
              signal
            );
            return response.development as WindowDevelopment | undefined;
          }
        }
      : {})
  });
  const taskWorkspace = resolve(workspaceRoot, taskId);
  const projectDirectory = resolve(process.env.FORMICAND_PROJECT_DIR ?? process.cwd());
  const harnessRoot = process.env.FORMICAND_HARNESS_ROOT ?? process.cwd();
  const cliPresentation = createCliPresentation(pi, { harnessRoot, projectDirectory });
  const cliCommands = registerCliCommands(pi, {
    workspaceRoot,
    taskId,
    runId: mainRunId,
    projectDirectory,
    secrets: [
      process.env.FORMICAND_API_KEY,
      config.apiKey,
      process.env.FORMICAND_EXA_API_KEY,
      process.env.EXA_API_KEY,
      config.webSearch?.exaApiKey,
      web?.exaApiKey,
      ...(config.modelProviders?.providers.map((provider) => provider.apiKey) ?? [])
    ].filter((value): value is string => Boolean(value))
  });
  let projectDefaultIdentity = true;
  /**
   * The one skill catalog Main sees in its prompt and loads with load_skill.
   *
   * Pi's own discovery is switched off at launch (`--no-skills`); Formicand
   * resolves the sources, the trust decision and the removed index itself, so
   * a Subagent in the same project sees the same list.
   */
  // What the user set for Main in the Agent page, read again at every turn.
  let mainSettings = builtinAgentSettings(config, "main", projectDirectory);
  const skillCatalogNow = async () => {
    const allowed = mainSettings.skills;
    return (await resolveSkillCatalog(await processSkillLocations(harnessRoot, projectDirectory))).filter(
      (skill) => allowed === "all" || allowed.includes(skill.name)
    );
  };
  let currentSkillsSection: string | undefined;
  const skillsSection = (skills: SkillMetadata[]): string | undefined => {
    const catalog = skillCatalogPrompt(skills);
    return catalog ? `<skills>\n${catalog}\n</skills>` : undefined;
  };
  // Servers registered while the extension loads connect when the session
  // starts; each turn re-reads the configuration (see createMcpRegistration).
  const mcpServers = createMcpRegistration(pi, undefined, () =>
    mainSettings.mcp === "all" ? undefined : mainSettings.mcp
  );
  await mcpServers.sync();
  let mcpProblem: string | undefined;
  const capabilityProviders = capabilityProvider(
    new Map([["attachments", attachmentCapabilityProvider(harnessRoot)]])
  );
  let requestRetry: MainRequestRetry | undefined;
  let freshRetryContext = false;
  let recentContext: unknown[] = [];
  let mainContext: ReturnType<typeof mainContextPaths> | undefined;
  const CONTEXT_PERSIST_INTERVAL_MS = 5_000;
  const CONTEXT_PERSIST_ENTRY_THRESHOLD = 10;
  let lastPersistedBranch:
    { length: number; lastEntryId: string | undefined; compactionCount: number; atMs: number } | undefined;
  let lastPersistedUserEntryId: string | undefined;
  let persistedReceiptKeys = new Set<string>();
  const countCompactions = (branch: SessionEntry[]): number => {
    let count = 0;
    for (const entry of branch) if (entry.type === "compaction") count += 1;
    return count;
  };
  const latestUserEntryId = (branch: SessionEntry[]): string | undefined => {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type === "message" && entry.message.role === "user") return entry.id;
    }
    return undefined;
  };
  const receiptKeysFor = (items: unknown[]): string[] =>
    extractInboxReceipts(items, taskId, mainRunId).map(inboxReceiptKey);
  const persistSessionContext = async (
    ctx: Pick<ExtensionContext, "sessionManager">,
    options: { force: boolean }
  ): Promise<void> => {
    if (!mainContext) return;
    const branch = ctx.sessionManager.getBranch();
    const length = branch.length;
    const lastEntryId = branch.at(-1)?.id;
    const compactionCount = countCompactions(branch);
    const userEntryId = latestUserEntryId(branch);
    const branchReceipts = receiptKeysFor(branch);
    const hasUnpersistedReceipt = branchReceipts.some((key) => !persistedReceiptKeys.has(key));
    const unchanged =
      lastPersistedBranch !== undefined &&
      lastPersistedBranch.length === length &&
      lastPersistedBranch.lastEntryId === lastEntryId &&
      lastPersistedBranch.compactionCount === compactionCount;
    if (unchanged && !hasUnpersistedReceipt) return;
    if (!options.force && lastPersistedBranch !== undefined) {
      const userChanged = userEntryId !== lastPersistedUserEntryId;
      const compactionChanged = compactionCount !== lastPersistedBranch.compactionCount;
      const intervalElapsed = Date.now() - lastPersistedBranch.atMs >= CONTEXT_PERSIST_INTERVAL_MS;
      const entryThresholdReached =
        Math.abs(length - lastPersistedBranch.length) >= CONTEXT_PERSIST_ENTRY_THRESHOLD;
      if (
        !hasUnpersistedReceipt &&
        !userChanged &&
        !compactionChanged &&
        !intervalElapsed &&
        !entryThresholdReached
      )
        return;
    }
    try {
      await persistMainSessionContext(mainContext, branch);
    } catch (error) {
      // A partial write (e.g. messages.json replaced before state.json throws)
      // makes the in-memory cache stale relative to disk; invalidate so the next
      // context pass rebuilds messages.json before acknowledging any receipt.
      lastPersistedBranch = undefined;
      lastPersistedUserEntryId = undefined;
      persistedReceiptKeys = new Set();
      throw error;
    }
    lastPersistedBranch = { length, lastEntryId, compactionCount, atMs: Date.now() };
    lastPersistedUserEntryId = userEntryId;
    persistedReceiptKeys = new Set(branchReceipts);
  };
  const materializeRequestSnapshot = async (): Promise<void> => {
    await requestRetry?.store.materialize();
  };
  let runtimeWrites = Promise.resolve();
  const updateRuntime = (patch: Parameters<typeof updateMainContextRuntime>[1]) => {
    runtimeWrites = runtimeWrites
      .then(async () => {
        await updateMainContextRuntime(mainContext ?? mainContextPaths(workspaceRoot, taskId), patch);
      })
      // eslint-disable-next-line no-restricted-syntax -- runtime 快照只是进度记录，写入失败不能中断串行链和当前 Turn
      .catch(() => {});
    return runtimeWrites;
  };

  const jobs = createMainJobs(workspaceRoot, taskId, mainRunId, taskWorkspace, projectDirectory);
  const lifecycle = registerMainLifecycle(pi, {
    workspaceRoot,
    taskId,
    mainRunId,
    runtimeEnv,
    windows,
    pollJobs: jobs.pollJobs,
    isReplaying: () => requestRetry?.isReplaying === true,
    replayWithoutNewContext: () => Boolean(process.env.FORMICAND_MAIN_RETRY_REQUEST_ID) && !freshRetryContext,
    async persistSession(ctx) {
      await persistSessionContext(ctx, { force: true });
    },
    materializeRequestSnapshot,
    updateRuntime
  });
  const { coordinator, humanStore, questionStore, inboxDelivery, deliverCallbacks } = lifecycle;
  /**
   * Record a refused write to a protected path.
   *
   * A refusal is worth seeing after the fact and not only in the transcript
   * the model reads. Diagnostics must never interfere with the refusal itself.
   */
  const appendGuardEvent = async (path: string, pattern: string, toolName: string): Promise<void> => {
    try {
      await new JsonlEventStore(join(workspaceRoot, taskId, "runs", mainRunId, "run_events.jsonl")).append({
        eventId: `guard-${randomUUID()}`,
        type: "guard.write_refused",
        taskId,
        runId: mainRunId,
        agentId: "main",
        occurredAt: new Date().toISOString(),
        payload: { path, pattern, toolName }
      });
      // eslint-disable-next-line no-restricted-syntax -- 拒绝写入已经通过 tool_call 返回给模型，诊断事件写入失败只少了事后记录
    } catch {
      /* diagnostics only */
    }
  };
  // The guard covers Main as well as Subagents: neither edits this harness or
  // version-control metadata.
  const guard = taskProtectedPaths(projectDirectory);

  pi.on("tool_call", async (event) => {
    const refused = blockedToolCall(event.toolName, event.input, guard, projectDirectory);
    if (!refused) return undefined;
    void appendGuardEvent(refused.path, refused.pattern, event.toolName);
    return { block: true, reason: refused.reason };
  });

  /**
   * Apply the search configuration saved since the last turn.
   *
   * A resident Main outlives the settings page that saved it, so the choice has
   * to reach this process at its next turn: a changed provider replaces the two
   * tool definitions, and turning search off removes them from the active
   * loadout so the model is not offered a provider the user switched off.
   */
  const syncWebToolLoadout = () => {
    const latest = configuredWebTools(loadConfig());
    // These three are everything `configuredWebTools` derives a provider from, so
    // an unchanged turn does not rebuild the tool definitions.
    const unchanged =
      latest?.provider === web?.provider &&
      latest?.exaApiKey === web?.exaApiKey &&
      latest?.exaEndpoint === web?.exaEndpoint;
    if (unchanged) return;
    web = latest;
    const active = pi.getActiveTools();
    if (!latest) {
      pi.setActiveTools(active.filter((name) => name !== "search" && name !== "visit"));
      return;
    }
    registerWebSearchTools(pi, latest);
    pi.setActiveTools([...new Set([...active, "search", "visit"])]);
  };

  /**
   * The memory index, read again every turn so a memory saved or edited in
   * settings applies to the next turn. Memory adds to the conversation and
   * never gates it: a failed read is stated in the section instead.
   */
  const memoryIndexSection = async (): Promise<string> => {
    if (!memoryTool) return "";
    try {
      return await memoryTool.index();
    } catch (error) {
      // Memory only adds context, so a failed read is reported in its section rather than failing the turn.
      return `The memory index could not be read this turn: ${errorMessage(error)}`;
    }
  };

  const prepareMainTurnSections = async () => {
    // Real Pi assembles this hook before the per-request context hook, so tool
    // discovery must finish here to exist on the first model request. A resident
    // Main also reads the search choice saved since its last turn here.
    syncWebToolLoadout();
    mainSettings = builtinAgentSettings(loadConfig(), "main", projectDirectory);
    await capabilityTools.refresh();
    const workspace = [
      `Project directory: ${projectDirectory}`,
      `Task workspace: ${taskWorkspace}`,
      `work/: ${join(taskWorkspace, "agents", "main", "work")}`,
      `artifacts/: ${join(taskWorkspace, "artifacts")}`,
      "read, edit, write and bash resolve relative paths from the project directory; browse_workspace and a collaborator's outputFiles resolve them from the Task workspace, so use absolute paths for Task files. An older path in the history may predate a change of project directory: the directory above is current."
    ].join("\n");
    // The user's own Agents, read again every turn so a new or changed one applies to the next turn.
    const agents = await availableAgents(await processAgentLocations(projectDirectory));
    const memory = await memoryIndexSection();
    // Keep SDK-owned tools and rules dynamic. Returning a forced prompt here
    // freezes snippets when enable_tools changes the active loadout mid-turn.
    return {
      // Pi wraps each section in a tag of its own name.
      current_workspace: workspace,
      custom_agents: agents.length ? customAgentsPrompt(agents) : "",
      memory,
      // The user's extra instructions for Main add to the rules above and never replace them.
      user_main_instructions: mainSettings.prompt
    };
  };

  pi.on("before_agent_start", async (event, ctx) => {
    const sections = await prepareMainTurnSections();
    const problem = await mcpServers.sync();
    // Report a problem once, not again on every turn it persists.
    if (problem && problem !== mcpProblem) ctx.ui.notify(problem, "warning");
    mcpProblem = problem;
    const options = event.systemPromptOptions;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- systemPromptOptions 在旧版 Pi 调用方可能缺失，缺省时按项目默认身份处理
    projectDefaultIdentity = !options?.customPrompt && options?.forceSystemPrompt === undefined;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 调用方可能只提供 event.systemPrompt，缺少该系统选项时走下面的回退分支
    if (options) {
      const catalog = await skillCatalogNow();
      options.skills = catalog.map(piSkill);
      currentSkillsSection = skillsSection(catalog);
      Object.assign(options.sections, sections);
      return;
    }
    // Compatibility with older extension callers lacking structured options.
    return {
      systemPrompt: `${event.systemPrompt}\n<current_workspace>\n${sections.current_workspace}\n</current_workspace>`
    };
  });

  let continuationSections: Awaited<ReturnType<typeof prepareMainTurnSections>> | undefined;
  if (process.env.FORMICAND_MAIN_CONTINUATION) {
    registerMainContinuation(pi, async (ctx) => {
      continuationSections = await prepareMainTurnSections();
      await requestRetry?.restore();
      const options = ctx.getSystemPromptOptions();
      currentSkillsSection = skillsSection(await skillCatalogNow());
      projectDefaultIdentity = !options.customPrompt && options.forceSystemPrompt === undefined;
    });
  }
  pi.on("context_with_system", async (event, ctx) => {
    const sections = continuationSections;
    let messages = sections
      ? event.messages.map((message) =>
          message.role === "system" && message.sections
            ? { ...message, sections: { ...message.sections, ...sections } }
            : message
        )
      : event.messages;
    if (mainContext) {
      try {
        await runtimeWrites;
        const runtime = await readMainContextState(mainContext);
        messages = withMainRuntimeContext(messages, { runtime });
      } catch (error) {
        ctx.ui.notify(`Main current context refresh failed: ${errorMessage(error)}`, "warning");
      }
    }
    const skillSection = currentSkillsSection;
    const scoped = messages.map((message) => {
      if (message.role !== "system") return message;
      const withSkills = skillSection
        ? { ...message, sections: { ...message.sections, skills: skillSection } }
        : message;
      return projectDefaultIdentity ? projectFormicandSystemMessage(withSkills) : withSkills;
    });
    return { messages: scoped };
  });

  // Keep a bounded copy of the user-facing Main transcript. It is passed to
  // Coordinator automatically, so Main only needs to provide `task`.
  pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter((message) => !isMainContinuationMessage(message));
    recentContext = messages.slice(-8);
    const firstUser = messages.find((message) => message.role === "user");
    const goal = firstUser ? stripReferencesBlock(textFromMessage(firstUser)).trim() : "";
    if (goal) {
      const store = new LocalWorkspaceStore(workspaceRoot);
      const task = await store.readTask(taskId);
      const normalizedGoal = task.goal?.trim() || goal.slice(0, 2_000);
      if (!task.goal?.trim()) await store.updateTask(taskId, { goal: normalizedGoal });
      updateRuntime({
        runtimeGoal: normalizedGoal,
        // The goal itself lives in `runtimeGoal` and in the user's message;
        // repeating it in the event line would show it twice in one request.
        runtimeLastEvent: { type: "user_goal_observed", summary: "goal recorded" }
      });
    }
    try {
      await persistSessionContext(ctx, { force: false });
      if (!requestRetry?.isReplaying) {
        const messageKeys = receiptKeysFor(messages);
        if (messageKeys.length > 0) {
          const allowedKeys = new Set(persistedReceiptKeys);
          if (messageKeys.some((key) => !allowedKeys.has(key))) {
            const onDiskKeys = await readPersistedSessionReceiptKeys(
              ctx.sessionManager.getSessionFile(),
              taskId,
              mainRunId
            );
            for (const key of onDiskKeys) allowedKeys.add(key);
          }
          await inboxDelivery.acknowledge(messages, { allowedKeys });
        }
        if (process.env.FORMICAND_MAIN_RETRY_REQUEST_ID) freshRetryContext = true;
      }
      await updateRuntime({ runtimePendingDelegations: inboxDelivery.queuedCount });
      // Refresh between model requests, including changes made during a turn.
      await capabilityTools.refresh();
      currentSkillsSection = skillsSection(await skillCatalogNow());
    } catch (error) {
      ctx.ui.notify(`Main context snapshot failed: ${errorMessage(error)}`, "warning");
    }
    return {
      messages: messages.map((message) => {
        const queued = message.role === "user" ? readQueuedUserTurn(message.content) : undefined;
        return queued ? { ...message, content: [{ type: "text" as const, text: queued.text }] } : message;
      })
    };
  });

  pi.on("session_compact", async (_event, ctx) => {
    await persistSessionContext(ctx, { force: true });
  });

  /**
   * What this resident process sends with, as of its latest turn.
   *
   * A resident Main serves many turns. When the Dashboard resolved its
   * connection from this host's saved configuration it marks the launch, and
   * every later turn re-reads the connection, protocol, model and image
   * capability saved now; the launch values are only the first turn's.
   */
  let currentModel: ReturnType<typeof createFormicandModel> | undefined;
  let currentApiKey = apiKey;
  let currentCacheKey = configuredSupportsPromptCacheKey(runtimeEnv);
  let currentSupportsImages = supportsImages;
  let currentSupportsReasoningEffort = supportsReasoningEffort;
  let currentModelId = modelId;
  if (baseUrl && apiKey) {
    const model = process.env.FORMICAND_MAIN_RETRY_MODEL
      ? parseMainRequestModel(process.env.FORMICAND_MAIN_RETRY_MODEL)
      : createFormicandModel({
          baseUrl,
          api: configuredModelApi(runtimeEnv),
          thinkingFormat: configuredThinkingFormat(runtimeEnv),
          model: modelId,
          maxTokens: configuredMainMaxTokens(runtimeEnv),
          contextWindow: configuredContextWindow(runtimeEnv),
          supportsImages: configuredSupportsImages(runtimeEnv),
          supportsReasoningEffort
        });
    requestRetry = new MainRequestRetry(
      new MainRequestStore(mainRequestPath(workspaceRoot, taskId), taskId),
      mainRunId,
      () => mainRequestEnvironment(workspaceRoot, taskId, projectDirectory),
      process.env.FORMICAND_MAIN_RETRY_REQUEST_ID || undefined,
      (names) => capabilityTools.restoreSelection(names),
      async (deferredContext) => {
        try {
          await deliverCallbacks();
          if (deferredContext && !inboxDelivery.queuedCount)
            pi.sendMessage(
              { customType: MAIN_CONTINUATION_TYPE, content: [], display: false },
              { triggerTurn: true, deliverAs: "steer" }
            );
        } catch (error) {
          console.error(`[Formicand] Deferred callback delivery: ${errorMessage(error)}`);
        }
      }
    );
    const retry = requestRetry;
    const recorder = new ModelRequestRecorder(
      join(taskWorkspace, "sessions", "main", `${mainRunId}-requests.jsonl`),
      { taskId, runId: mainRunId, agentId: "main" },
      [apiKey, web?.exaApiKey].filter((secret): secret is string => Boolean(secret))
    );
    const publishModel = (
      next: ReturnType<typeof createFormicandModel>,
      key: string,
      supportsPromptCacheKey: boolean
    ) =>
      registerFormicandProvider(pi, {
        model: next,
        apiKey: key,
        sessionId: `formicand:${taskId}:main`,
        supportsPromptCacheKey,
        wrap: (streams) => recordModelRequests(streams, recorder, retry)
      });
    publishModel(model, apiKey, currentCacheKey);
    currentModel = model;

    /**
     * Move the process onto the connection saved for the turn that is starting.
     *
     * The Inbox hands over a turn only after the previous one settled, so no
     * model request is on the wire here: the provider, the session model and
     * the thinking level can all change at this boundary. A launch pinned by
     * the environment is never marked, so it keeps its connection. The limits
     * the connection leaves to its provider are applied here exactly as the
     * launch applied them, or the turn would run with the host file's defaults.
     */
    const adoptSavedTurnModel = async (event: BeforeAgentStartEvent) => {
      if (process.env[MAIN_MODEL_FROM_CONFIG] !== "1") return;
      // An exact retry resends the archived connection; changing it would
      // change the request the retry exists to prove.
      if (retry.isReplaying) return;
      const saved = loadConfig();
      const identity = event.messageType === "user" ? readQueuedUserTurn(event.prompt) : undefined;
      // An explicit level belongs to the message that opened this turn. The
      // Run's input file only names the newest accepted message, so a message
      // queued after this one must not replace the level this turn picked.
      const accepted = identity
        ? await readAcceptedMainMessage(workspaceRoot, taskId, identity.messageId).catch((error) => {
            // A record this turn cannot use only drops its optional level: the
            // saved connection's own level still applies to the turn.
            console.error(`[Formicand] Turn input record: ${errorMessage(error)}`);
            return undefined;
          })
        : undefined;
      const explicitLevel = accepted?.thinkingLevel;
      const selection = resolveMainTurnModel(saved, {
        ...(explicitLevel ? { thinkingLevel: explicitLevel } : {}),
        projectDirectory
      });
      if (!selection) return;
      // The launch applied the endpoint's own limits to this connection; the
      // turn must not re-resolve from the host file alone, which would drop the
      // advertised output cap, context window and image support.
      const turn = await withEndpointLimits(selection, saved);
      const next = createFormicandModel({
        baseUrl: turn.baseUrl,
        ...(turn.connectionId ? { connectionId: turn.connectionId } : {}),
        api: turn.profile.api,
        thinkingFormat: turn.profile.thinkingFormat,
        model: turn.model,
        maxTokens: turn.profile.mainMaxTokens,
        contextWindow: turn.profile.contextWindow,
        supportsImages: turn.supportsImages,
        supportsReasoningEffort: turn.profile.supportsReasoningEffort
      });
      const cacheKey = turn.profile.supportsPromptCacheKey;
      const modelChanged =
        !currentModel ||
        currentModel.provider !== next.provider ||
        currentModel.id !== next.id ||
        currentModel.api !== next.api ||
        currentModel.baseUrl !== next.baseUrl ||
        currentModel.reasoning !== next.reasoning ||
        currentModel.maxTokens !== next.maxTokens ||
        currentModel.contextWindow !== next.contextWindow ||
        currentModel.input.join(",") !== next.input.join(",") ||
        JSON.stringify(currentModel.compat) !== JSON.stringify(next.compat);
      if (modelChanged || currentApiKey !== turn.apiKey || currentCacheKey !== cacheKey)
        publishModel(next, turn.apiKey, cacheKey);
      if (modelChanged && !(await pi.setModel(next)))
        throw new Error("保存的模型连接未通过 Pi 的认证，本回合仍沿用当前连接");
      if (pi.getThinkingLevel() !== turn.thinkingLevel) pi.setThinkingLevel(turn.thinkingLevel);
      const imagesChanged = currentSupportsImages !== turn.supportsImages;
      currentModel = next;
      currentApiKey = turn.apiKey;
      currentCacheKey = cacheKey;
      currentSupportsImages = turn.supportsImages;
      currentSupportsReasoningEffort = turn.profile.supportsReasoningEffort;
      currentModelId = turn.model;
      // Image-only tools follow the connection that now sends the turn.
      if (imagesChanged) await capabilityTools.refresh();
    };
    pi.on("before_agent_start", adoptSavedTurnModel);
  }

  const toolContext = {
    capabilityProvider: capabilityProviders,
    refreshCapabilities: () => capabilityTools.refresh(),
    apiKey,
    baseUrl,
    coordinator,
    currentThinkingLevel,
    get cliDebugEnabled() {
      return cliPresentation.debug;
    },
    deliverCallbacks: () => deliverCallbacks(),
    flushSessionContext: (ctx: Pick<ExtensionContext, "sessionManager">) =>
      persistSessionContext(ctx, { force: true }),
    materializeRequestSnapshot,
    harnessRoot,
    humanStore,
    inboxDelivery,
    ...jobs,
    mainRunId,
    get modelId() {
      return currentModelId;
    },
    projectDirectory,
    questionStore,
    get recentContext() {
      return recentContext;
    },
    set recentContext(value) {
      recentContext = value;
    },
    runtimeEnv,
    skillCatalogNow,
    get supportsReasoningEffort() {
      return currentSupportsReasoningEffort;
    },
    get supportsImages() {
      return currentSupportsImages;
    },
    taskId,
    taskWorkspace,
    updateRuntime,
    get web() {
      return web;
    },
    workspaceRoot
  };
  registerCoordinationTools(pi, toolContext);
  registerAgentTools(pi, toolContext);
  registerJobsTools(pi, toolContext);
  registerProjectLedgerTool(pi, toolContext);
  registerProjectDevelopmentTool(pi, toolContext);
  memoryTool = registerMemoryTool(pi, toolContext);
  registerWorkspaceTools(pi, toolContext);
  const cuaBridge = createCuaDispatcher(pi);
  registerImageTools(cuaBridge.capturePi, toolContext);
  registerSearchTools(pi, projectDirectory);
  registerWebSearchTools(pi, web);
  registerComputerTools(cuaBridge.capturePi, taskId, taskWorkspace);
  const browserTools = registerBrowserTools(cuaBridge.capturePi, toolContext);
  const cuaScripts = registerCuaScriptTools(cuaBridge.capturePi, cuaBridge.dispatch);
  pi.on("session_shutdown", async () => {
    if (lifecycle.sessionContext) {
      await persistSessionContext(lifecycle.sessionContext, { force: true }).catch((error) => {
        console.error(`[Formicand] Session context flush on shutdown failed: ${errorMessage(error)}`);
      });
    }
    await materializeRequestSnapshot().catch((error) => {
      console.error(
        `[Formicand] Request snapshot materialization on shutdown failed: ${errorMessage(error)}`
      );
    });
    await lifecycle.close();
    await cuaScripts.dispose();
    await browserTools.dispose();
  });
  const capabilityTools = registerCapabilityTools(pi, {
    workspaceRoot,
    taskId,
    mainRunId,
    // Read per refresh: a resident Main can move to a text-only connection
    // between turns, and image-only tools go with the model that can see.
    get supportsImages() {
      return currentSupportsImages;
    }
  });
  pi.registerCommand("formicand-status", {
    description: "Show Formicand workspace and active Coordinator jobs",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        `workspace=${workspaceRoot}; task=${taskId}; mainTurns=${lifecycle.turnCount}/${lifecycle.maxTurns}`,
        "info"
      )
  });

  pi.registerCommand("formicand-tools", {
    description: "Show Formicand tools currently visible to Main",
    handler: async (_args, ctx) => ctx.ui.notify(`active tools: ${pi.getActiveTools().join(", ")}`, "info")
  });

  pi.on("session_start", async (event, ctx) => {
    lifecycle.setSession(ctx);
    if (event.reason !== "startup") {
      await cuaScripts.reset();
      await browserTools.closeAll();
    }
    cliPresentation.configure(ctx);
    cliCommands.configure(ctx);
    // Direct `pi -e formicand.ts` launches need the same defaults as npm start.
    // Pi has already applied --thinking before session_start; preserve it,
    // and preserve interactive changes when an extension is reloaded/forked.
    const cliArgs = process.argv.slice(2);
    const endOfOptions = cliArgs.indexOf("--");
    const startupArgs = endOfOptions < 0 ? cliArgs : cliArgs.slice(0, endOfOptions);
    if (event.reason !== "reload" && event.reason !== "fork" && !startupArgs.includes("--thinking")) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 Pi 宿主不提供 setThinkingLevel，缺方法时保留宿主已有的 thinking 级别
      pi.setThinkingLevel?.(configuredReasoningEffort(runtimeEnv));
    }
    if (!baseUrl || !apiKey)
      ctx.ui.notify("Formicand 模型未配置：请运行 formicand init，或设置模型环境变量。", "warning");
    else {
      const activeTools = pi.getActiveTools();
      const requiredTools = [...CORE_TOOLS, "find", "grep"];
      const missingTools = requiredTools.filter((name) => !activeTools.includes(name));
      if (missingTools.length > 0) pi.setActiveTools([...activeTools, ...missingTools]);
      const taskStore = new LocalWorkspaceStore(workspaceRoot);
      await taskStore.createTask(taskId, { projectDirectory });
      await taskStore.createRun(taskId, mainRunId);
      if (process.env.FORMICAND_CLI_SESSION === "1") {
        const binding = await recordCliSessionBinding({
          sessionManager: ctx.sessionManager,
          workspaceRoot,
          taskId,
          projectDirectory,
          appendEntry: (type, data) => pi.appendEntry(type, data),
          allowOverride: event.reason === "startup" && process.env.FORMICAND_CLI_TASK_EXPLICIT === "1"
        });
        if (binding.status === "conflict") {
          ctx.ui.notify(
            "当前会话与任务不匹配。请退出后使用 formicand --continue 或 formicand --session <ID|path> 恢复。",
            "error"
          );
          ctx.shutdown();
          return;
        }
      }
      await capabilityTools.refresh();
      mainContext = mainContextPaths(workspaceRoot, taskId);
      await ensureMainContext(mainContext);
      await lifecycle.startInbox(ctx);
      if (
        !cliPresentation.startup(ctx, {
          workspaceRoot,
          taskId,
          mainRunId,
          modelId,
          tools: pi.getActiveTools()
        })
      ) {
        ctx.ui.notify(
          `Formicand loaded · workspace ${workspaceRoot} · task ${taskId} · tools ${requiredTools.join(", ")}`,
          "info"
        );
      }
    }
  });
  if (process.env.FORMICAND_CLI_SESSION === "1") {
    const refuseSessionSwitch = async (_event: unknown, ctx: ExtensionContext) => {
      ctx.ui.notify(
        "请先退出当前会话，再运行 formicand 新建，或 formicand --session <ID|path> 恢复。",
        "info"
      );
      return { cancel: true };
    };
    pi.on("session_before_switch", refuseSessionSwitch);
    pi.on("session_before_fork", refuseSessionSwitch);
  }
  return toolContext;
}

export type FormicandToolContext = Awaited<ReturnType<typeof registerMainExtension>>;
