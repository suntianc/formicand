import { type EndpointLimits } from "../runtime/model-limits.js";
import { type MessageEditRequest, type EditTextFile } from "../runtime/main-message-edit.js";
import { InputStore } from "../workspace/input-store.js";
import type { WindowDevelopment } from "../runtime/session-handoff.js";
import { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { type PiThinkingLevel } from "../runtime/runtime-settings.js";
import type { MainCapacityDecision, MainCapacityRequest } from "../domain/main-capacity.js";
import { type ModelRoleRequest, type ResolvedModelRole } from "../runtime/role-models.js";

import type { TaskLocation } from "./workspace-directory.js";

/** A fresh object per Main process; runId alone can be reused after a stop. */
export interface InterjectionTarget {
  readonly runId: string;
}

/**
 * What the caller adds to one Main start beyond the prompt.
 *
 * `onRunAccepted` is the only place a caller may record ownership; it runs
 * after every refusal check, so a queued or refused request records no Run.
 */
export interface MainLaunchSubmission {
  body?: string;
  edit?: MessageEditRequest;
  attachmentIds?: string[];
  textAttachments?: EditTextFile[];
  /** Explicit one-off connection; an unknown id refuses instead of falling back. */
  profileId?: string;
  thinkingLevel?: PiThinkingLevel;
  onPrepared?: (rollback: () => Promise<void>) => void;
  onRunAccepted?: (location: TaskLocation, runId: string) => Promise<void>;
  source?: "composer" | "human" | "inbox";
  /** Which entry point asked, so the queue can report where a demand came from. */
  origin?: "http" | "worker" | "cli" | "internal";
  /** The persistent session this request names, when the caller knows it. */
  mainSessionId?: unknown;
  /** The requirement this Run works on, for capacity dedupe. */
  requirementId?: unknown;
  /** A person waiting on the page keeps the demand; a background retry reports it full. */
  queueWhenFull?: boolean;
  /** A slot this request already owns; the dispatch of a queued demand sets it. */
  admittedRequestId?: string;
}

/** Mutable launch facts: what admission gave this request and whether it spawned. */
export interface MainLaunchAdmission {
  requestId?: string;
  spawned: boolean;
  /** This launch replaces a running Main, so the new process keeps its system prompt. */
  replacedResident?: boolean;
}

export type MainLaunchReceipt = {
  taskId: string;
  runId: string;
  model: string;
  sessionId?: string;
  queuePosition?: number;
} & ({ status: "running" | "paused" | "queued" | "duplicate" } | { status: "failed"; error: string });

export interface MainLaunchOptions {
  prompt: string;
  requestedRunId?: string;
  resume: boolean;
  requestedModel?: string;
  retryRequestId?: string;
  submission?: MainLaunchSubmission;
}

export type FinalizedRunStatus = "completed" | "failed" | "cancelled";

export function deferredMainLaunch(
  decision: Exclude<MainCapacityDecision, { state: "running" }>,
  sessionId: string,
  taskId: string,
  runId: string,
  model: string
): MainLaunchReceipt {
  if (decision.state === "queued")
    return { taskId, runId, model, status: "queued", sessionId, queuePosition: decision.position };
  return {
    taskId,
    runId: decision.runId ?? runId,
    model,
    status: "duplicate",
    sessionId,
    ...(decision.position === undefined ? {} : { queuePosition: decision.position })
  };
}

export interface RunServicePorts {
  uploads?: InputStore;
  projectRoot: string;
  dashboardUrl: string;
  runCredential: string;
  coordinator: CoordinatorRuntime;
  /**
   * The backend that owns delegated processes.
   *
   * Closing a session must end the Subagents it started, and their processes
   * are not the coordinator's any more: the same owner that launched them is
   * the one that stops them.
   */
  subagents?: {
    cancel(input: { taskId: string; runId: string; callId: string; reason?: string }): Promise<unknown>;
    /** Whether this Run still has delegated work in flight or undelivered. */
    unfinishedWork?(input: { taskId: string; runId: string }): Promise<boolean>;
  };
  locateTask(taskId: string): Promise<TaskLocation>;
  readWindowDevelopment?(taskId: string): Promise<WindowDevelopment | undefined>;
  /**
   * Resolve the execution host's connection for one admitted Run.
   *
   * Called at the moment the launch is admitted, so a queued request that only
   * starts later reads the settings in force then. The returned snapshot is
   * fixed for the life of the process.
   */
  resolveMainModel(request: ModelRoleRequest): ResolvedModelRole;
  /** The host's model for context summaries; absent, or returning undefined, uses Main's. */
  resolveUtilityModel?: () => ResolvedModelRole | undefined;
  /** The chosen model's own limits from its connection's `/models` entry, when listed (#27). */
  endpointLimits?: (selection: ResolvedModelRole) => Promise<EndpointLimits | undefined>;
  /**
   * The Run's work ended: its turn settled completed, failed or cancelled and
   * no delegated work is outstanding.
   *
   * A resident Main outlives its work, so a resource held for that work — the
   * Computer Use session — is released at this boundary rather than when the
   * process exits. The process exit calls it again as a fallback.
   */
  onRunSettled?: (taskId: string) => void;
  /** A resident Main's turn ended, whether its Run goes on waiting or is done. */
  onTurnSettled?: (location: TaskLocation) => void;
  onRunExit?: (taskId: string) => void;
  onRunFinalized?: (location: TaskLocation, runId: string, status: FinalizedRunStatus) => Promise<void>;
  onTaskCancelling?: (taskId: string) => void;
  withTaskProjectLock?<T>(taskId: string, action: () => Promise<T>): Promise<T>;
  /**
   * Who owns a start: which persistent Main session already holds this Task.
   * Read before admission so an external demand is decided before it is recorded.
   */
  mainSessions?: {
    resolve(
      location: TaskLocation,
      input: { mainSessionId?: unknown }
    ): Promise<
      { sessionId: string; entryKind: "internal" | "external"; kind: "regular" | "continuation" } | undefined
    >;
  };
  /** The external Main budget this host applies to every entry point. */
  mainCapacity?: {
    /** Whether this host runs external Mains at all; a disabled host reads no session. */
    enabled(): boolean;
    admit(request: MainCapacityRequest): Promise<MainCapacityDecision>;
    bindProcess(requestId: string, pid: number): Promise<boolean>;
    release(requestId: string): Promise<void>;
    /** The slot one Run still owns, so a resident Main between turns is not counted. */
    requestFor(taskId: string, runId: string): Promise<string | undefined>;
    /**
     * Release the claim a turn boundary ran under, only while it is still the
     * Run's current claim. Returns whether it was released.
     */
    releaseIfCurrent(taskId: string, runId: string, requestId: string): Promise<boolean>;
    /** The process exists: remove the queue row but keep the slot until it exits. */
    markStarted(requestId: string): Promise<void>;
    /** A cancelled Task gives up its waiting demand, if it has one. */
    cancelTask(taskId: string): Promise<void>;
  };
  /**
   * Every workspace root whose Tasks the Main guardian inspects.
   *
   * The guardian belongs to this service: a parked Task with an unconsumed
   * callback is resumed without any other scheduler running.
   */
  mainGuardian?: {
    workspaceRoots(): Promise<string[]>;
    /**
     * Whether this host has a Main model connection.
     *
     * Read every cycle, not at startup: a connection completed later applies
     * on the next tick, while a host without one takes no launch decision.
     */
    modelConfigured(): boolean;
  };
  normalizeModel(value: unknown): string | undefined;
  appendRunEvent(
    workspace: string,
    taskId: string,
    runId: string,
    type: string,
    payload: unknown
  ): Promise<void>;
  readJsonFile<T>(path: string, fallback: T): Promise<T>;
}

export type LaunchMainRun = (
  taskId: string,
  prompt: string,
  requestedRunId?: string,
  resume?: boolean,
  requestedModel?: string,
  retryRequestId?: string,
  submission?: MainLaunchSubmission
) => Promise<MainLaunchReceipt>;

export type SerializeTask = <T>(taskId: string, action: () => Promise<T>) => Promise<T>;
export type ResumeHumanAnswers = (taskId: string) => Promise<{ status: string; error?: string }>;
