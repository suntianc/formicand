import { ProjectDataConflictError, ProjectDataInvalidError, ledgerRevision } from "./project-ledger.js";
import type { DevelopmentRoute } from "./project-development.js";
import {
  PITFALLS_DIRECTORY,
  hasRetroSignals,
  type RetroImprovement,
  type RetroSignals
} from "./development-merge.js";

/**
 * A requirement's tickets: the slices it is split into, each with its own
 * scope, acceptance criteria and dependencies.
 *
 * Main drafts them and the user confirms them on a card; from then on the
 * acceptance criteria are frozen, and a change is a revision that records the
 * user's decision and Main's reason. The whole set is one record with one
 * revision, so a proposal, a confirmation and a revision are each atomic and
 * the dependency graph is always checked against the set it lives in.
 */
export type TicketState =
  "draft" | "confirmed" | "in_progress" | "in_review" | "passed" | "merged" | "rework";

export const TICKET_STATES: readonly TicketState[] = [
  "draft",
  "confirmed",
  "in_progress",
  "in_review",
  "passed",
  "merged",
  "rework"
];

/** How one criterion is checked: a command, or why no command can check it. */
export type TicketCheck = { command: string } | { manual: string };

export interface TicketCriterion {
  /** `AC1`, `AC2`… in the order written. */
  criterionId: string;
  text: string;
  check: TicketCheck;
}

/** One revision of a confirmed ticket: who decided, why, and what it replaced. */
export interface TicketChange {
  /** The ticket revision this change produced. */
  revision: number;
  /** The user's answer on the confirmation card. */
  decision: string;
  reason: string;
  /** The fields as they were before this change. */
  previous: Partial<TicketContent>;
  at: string;
}

export interface TicketContent {
  title: string;
  /** Paths the ticket may change; required on the direct route. */
  scope: string[];
  criteria: TicketCriterion[];
  /** Nearby behaviour that must keep working. */
  preserve: string[];
  /** Related changes the user did not ask for. */
  outOfScope: string[];
  /** Tickets that must be done first. */
  dependsOn: string[];
}

/** The Executor work item that implements a ticket, in its own checkout. */
export interface TicketWork {
  callId: string;
  agentId: string;
  workspace: string;
}

/** One check the program ran when it brought a ticket into the requirement checkout. */
export interface TicketCheckResult {
  name: string;
  command: string;
  exitCode: number;
  output: string;
  at: string;
}

/** The ticket's reviewed commit merged into the requirement checkout, with the checks that passed there. */
export interface TicketIntegration {
  /** The requirement checkout's commit after the merge. */
  commit: string;
  tree: string;
  /** The reviewed commit of the ticket's own checkout. */
  itemCommit: string;
  checks: TicketCheckResult[];
  at: string;
}

export interface DevelopmentTicket extends TicketContent {
  ticketId: string;
  state: TicketState;
  revision: number;
  changes: TicketChange[];
  confirmedAt?: string;
  /** The Executor call currently implementing it; a rework replaces it with the continuation. */
  work?: TicketWork;
  /** Reviews of this ticket's checkout, oldest first. */
  reviewIds: string[];
  integration?: TicketIntegration;
  createdAt: string;
  updatedAt: string;
}

export interface TicketSet {
  projectId: string;
  developmentId: string;
  /** 0 before the first proposal. */
  revision: number;
  tickets: DevelopmentTicket[];
  updatedAt?: string;
}

/** What a write asks for; `dryRun` returns the result without storing it. */
export type TicketWrite =
  | { op: "propose"; tickets: unknown; dryRun?: boolean }
  | { op: "confirm"; expectedRevision: unknown }
  | {
      op: "revise";
      ticketId: unknown;
      changes: unknown;
      reason: unknown;
      decision?: unknown;
      expectedRevision: unknown;
      dryRun?: boolean;
    }
  | TicketProgress;

/**
 * A step the program records as the work goes: never sent by Main. The
 * Executor starts, a review is frozen, a verdict lands, the reviewed commit is
 * brought into the requirement checkout.
 */
export type TicketProgress =
  | { op: "start"; ticketId: string; work: TicketWork }
  | { op: "review"; ticketId: string; reviewId: string }
  | { op: "verdict"; ticketId: string; passed: boolean }
  | { op: "integrate"; ticketId: string; integration: TicketIntegration };

export const TICKET_PROGRESS_OPS: readonly string[] = ["start", "review", "verdict", "integrate"];

const MAX_TICKETS = 30;
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const CONTENT_FIELDS = ["title", "scope", "criteria", "preserve", "outOfScope", "dependsOn"] as const;

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new ProjectDataInvalidError(`${label}必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL.test(trimmed))
    throw new ProjectDataInvalidError(`${label}须为 1–${max} 个可打印字符`);
  return trimmed;
}

function list(value: unknown, label: string, max: number, itemMax: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new ProjectDataInvalidError(`${label}最多 ${max} 条`);
  return [...new Set(value.map((item) => text(item, label, itemMax)))];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDataInvalidError(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

export function ticketIdentifier(value: unknown): string {
  const id = text(value, "票编号", 20);
  if (!TICKET_ID.test(id))
    throw new ProjectDataInvalidError("票编号只能用字母、数字、点、下划线和连字符，如 01");
  return id;
}

function scopePaths(value: unknown): string[] {
  return list(value, "改动范围", 50, 300).map((path) => {
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw new ProjectDataInvalidError(`改动范围须为项目内的相对路径：${path}`);
    return path.replace(/^\.\//, "");
  });
}

function criteria(value: unknown): TicketCriterion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20)
    throw new ProjectDataInvalidError("验收标准须为 1–20 条");
  return value.map((item, index) => {
    const input = record(item, "验收标准");
    const command = input.command === undefined ? undefined : text(input.command, "检查命令", 4000);
    const manual = input.manual === undefined ? undefined : text(input.manual, "无法用命令检查的原因", 1000);
    if ((command === undefined) === (manual === undefined))
      throw new ProjectDataInvalidError(
        `验收标准 ${index + 1} 须写明检查方式：一条 command，或说明无法用命令检查的 manual，二选一`
      );
    return {
      criterionId: `AC${index + 1}`,
      text: text(input.text, "验收标准", 1000),
      check: command === undefined ? { manual: manual! } : { command }
    };
  });
}

function content(value: unknown, base?: TicketContent): TicketContent {
  const input = record(value, "票");
  const has = (field: string) => input[field] !== undefined;
  return {
    title: has("title") || !base ? text(input.title, "票标题", 200) : base.title,
    scope: has("scope") || !base ? scopePaths(input.scope) : base.scope,
    criteria: has("criteria") || !base ? criteria(input.criteria) : base.criteria,
    preserve: has("preserve") || !base ? list(input.preserve, "保留不变", 20, 1000) : base.preserve,
    outOfScope: has("outOfScope") || !base ? list(input.outOfScope, "本次不做", 20, 1000) : base.outOfScope,
    dependsOn:
      has("dependsOn") || !base ? list(input.dependsOn, "依赖", 20, 20).map(ticketIdentifier) : base.dependsOn
  };
}

/** Route, dependency and size rules that hold for every stored set. */
export function checkTicketSet(tickets: DevelopmentTicket[], route: DevelopmentRoute): void {
  if (route === "quick" && tickets.length)
    throw new ProjectDataInvalidError("quick 路线不建票；需要票时先把路线改为 direct 或 full");
  if (tickets.length > MAX_TICKETS) throw new ProjectDataInvalidError(`一个需求最多 ${MAX_TICKETS} 张票`);
  if (route === "direct") {
    if (tickets.length > 1) throw new ProjectDataInvalidError("direct 路线只有一张票；需要多张票时改为 full");
    if (tickets.some((ticket) => !ticket.scope.length))
      throw new ProjectDataInvalidError("direct 路线的票必须写明改动范围");
  }
  const byId = new Map(tickets.map((ticket) => [ticket.ticketId, ticket]));
  for (const ticket of tickets)
    for (const dependency of ticket.dependsOn) {
      if (dependency === ticket.ticketId)
        throw new ProjectDataInvalidError(`票 ${ticket.ticketId} 不能依赖自己`);
      if (!byId.has(dependency))
        throw new ProjectDataInvalidError(`票 ${ticket.ticketId} 依赖的票 ${dependency} 不存在`);
    }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new ProjectDataInvalidError(`票的依赖成环：${[...path, id].join(" → ")}`);
    visiting.add(id);
    for (const next of byId.get(id)!.dependsOn) visit(next, [...path, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const ticket of tickets) visit(ticket.ticketId, []);
}

function conflict(message: string, set: TicketSet): ProjectDataConflictError {
  return new ProjectDataConflictError(message, set.revision, "ticket_revision_conflict");
}

/**
 * Apply one write to a set and return the new set, or refuse it.
 *
 * A proposal replaces every unconfirmed draft and leaves confirmed tickets
 * alone; a confirmation freezes exactly the drafts the user saw, which is why
 * it names the revision the card showed; a revision changes one confirmed
 * ticket and records what it replaced.
 */
export function applyTicketWrite(
  set: TicketSet,
  write: TicketWrite,
  route: DevelopmentRoute,
  at: string
): TicketSet {
  if (write.op === "propose") {
    if (!Array.isArray(write.tickets) || write.tickets.length === 0)
      throw new ProjectDataInvalidError("propose 需要至少一张票");
    const kept = set.tickets.filter((ticket) => ticket.state !== "draft");
    const keptIds = new Set(kept.map((ticket) => ticket.ticketId));
    const seen = new Set<string>();
    const drafts = write.tickets.map((item): DevelopmentTicket => {
      const ticketId = ticketIdentifier(record(item, "票").ticketId);
      if (keptIds.has(ticketId))
        throw new ProjectDataInvalidError(`票 ${ticketId} 已经确认；修改已确认的票用 revise_ticket`);
      if (seen.has(ticketId)) throw new ProjectDataInvalidError(`票编号 ${ticketId} 重复`);
      seen.add(ticketId);
      const previous = set.tickets.find((ticket) => ticket.ticketId === ticketId);
      return {
        ticketId,
        ...content(item),
        state: "draft",
        revision: 1,
        changes: [],
        reviewIds: [],
        createdAt: previous?.createdAt ?? at,
        updatedAt: at
      };
    });
    const tickets = [...kept, ...drafts];
    checkTicketSet(tickets, route);
    return { ...set, revision: set.revision + 1, tickets, updatedAt: at };
  }
  if (TICKET_PROGRESS_OPS.includes(write.op)) return applyProgress(set, write as TicketProgress, at);
  const change = write as Exclude<TicketWrite, TicketProgress | { op: "propose" }>;
  const expected = ledgerRevision(change.expectedRevision);
  if (expected !== set.revision) throw conflict("票已更新，请基于最新修订重试", set);
  if (change.op === "confirm") {
    if (!set.tickets.some((ticket) => ticket.state === "draft"))
      throw new ProjectDataInvalidError("没有待确认的票");
    checkTicketSet(set.tickets, route);
    return {
      ...set,
      revision: set.revision + 1,
      tickets: set.tickets.map((ticket) =>
        ticket.state === "draft" ? { ...ticket, state: "confirmed", confirmedAt: at, updatedAt: at } : ticket
      ),
      updatedAt: at
    };
  }
  const ticketId = ticketIdentifier(change.ticketId);
  const current = set.tickets.find((ticket) => ticket.ticketId === ticketId);
  if (!current) throw new ProjectDataInvalidError(`没有票 ${ticketId}`);
  if (current.state === "draft")
    throw new ProjectDataInvalidError(`票 ${ticketId} 还是草稿；直接重新 propose_tickets`);
  if (current.state === "merged")
    throw new ProjectDataInvalidError(`票 ${ticketId} 已合入；后续缺陷开一张新的修复票`);
  const reason = text(change.reason, "修改理由", 2000);
  const patch = record(change.changes, "修改内容");
  if ("ticketId" in patch || "state" in patch)
    throw new ProjectDataInvalidError("修改内容不能改票编号或状态");
  const next = content(patch, current);
  const changed = CONTENT_FIELDS.filter(
    (field) => JSON.stringify(next[field]) !== JSON.stringify(current[field])
  );
  if (!changed.length) throw new ProjectDataInvalidError("修改内容与当前票相同");
  const decision = change.dryRun ? "" : text(change.decision, "用户的决定", 2000);
  const revised: DevelopmentTicket = {
    ...current,
    ...next,
    revision: current.revision + 1,
    changes: [
      ...current.changes,
      {
        revision: current.revision + 1,
        decision,
        reason,
        previous: Object.fromEntries(changed.map((field) => [field, current[field]])),
        at
      }
    ],
    updatedAt: at
  };
  const tickets = set.tickets.map((ticket) => (ticket.ticketId === ticketId ? revised : ticket));
  checkTicketSet(tickets, route);
  return { ...set, revision: set.revision + 1, tickets, updatedAt: at };
}

/** Read back a stored ticket list; a malformed row is corruption, not input. */
export function storedTickets(value: unknown): DevelopmentTicket[] {
  if (!Array.isArray(value)) throw new ProjectDataInvalidError("票记录已损坏");
  return value.map((item) => {
    const input = record(item, "票记录");
    const state = input.state;
    if (typeof state !== "string" || !TICKET_STATES.includes(state as TicketState))
      throw new ProjectDataInvalidError("票记录已损坏");
    return {
      ticketId: ticketIdentifier(input.ticketId),
      ...content({
        ...input,
        criteria: (Array.isArray(input.criteria) ? input.criteria : []).map((criterion) => {
          const entry = record(criterion, "验收标准");
          return { text: entry.text, ...record(entry.check, "检查方式") };
        })
      }),
      state: state as TicketState,
      revision: ledgerRevision(input.revision),
      changes: Array.isArray(input.changes) ? (input.changes as TicketChange[]) : [],
      ...(typeof input.confirmedAt === "string" ? { confirmedAt: input.confirmedAt } : {}),
      ...(input.work ? { work: input.work as TicketWork } : {}),
      reviewIds: Array.isArray(input.reviewIds) ? input.reviewIds.map(String) : [],
      ...(input.integration ? { integration: input.integration as TicketIntegration } : {}),
      createdAt: String(input.createdAt),
      updatedAt: String(input.updatedAt)
    };
  });
}

const PROGRESS_FROM: Record<TicketProgress["op"], readonly TicketState[]> = {
  start: ["confirmed", "rework"],
  review: ["in_progress", "rework"],
  // A rework ticket passes only when Main delivers it as it is after its rounds ran out.
  verdict: ["in_review", "rework"],
  integrate: ["passed"]
};

const STATE_NAMES: Record<TicketState, string> = {
  draft: "草稿",
  confirmed: "已确认",
  in_progress: "执行中",
  in_review: "审查中",
  passed: "已通过",
  merged: "已并入",
  rework: "返修"
};

function applyProgress(set: TicketSet, progress: TicketProgress, at: string): TicketSet {
  const current = set.tickets.find((ticket) => ticket.ticketId === progress.ticketId);
  if (!current) throw new ProjectDataInvalidError(`没有票 ${progress.ticketId}`);
  if (!PROGRESS_FROM[progress.op].includes(current.state))
    throw new ProjectDataConflictError(
      `票 ${current.ticketId} 现在是${STATE_NAMES[current.state]}，不能${
        { start: "开始执行", review: "送审", verdict: "记录审查结论", integrate: "并进需求现场" }[progress.op]
      }`,
      set.revision,
      "ticket_state_conflict"
    );
  if (progress.op === "start" && current.state === "confirmed" && !ticketReady(current, set.tickets))
    throw new ProjectDataConflictError(
      `票 ${current.ticketId} 依赖的票 ${current.dependsOn
        .filter((id) => set.tickets.find((other) => other.ticketId === id)?.state !== "merged")
        .join("、")} 还没有合入`,
      set.revision,
      "ticket_dependency_pending"
    );
  const next: DevelopmentTicket =
    progress.op === "start"
      ? { ...current, state: "in_progress", work: progress.work }
      : progress.op === "review"
        ? { ...current, state: "in_review", reviewIds: [...current.reviewIds, progress.reviewId] }
        : progress.op === "verdict"
          ? { ...current, state: progress.passed ? "passed" : "rework" }
          : { ...current, state: "merged", integration: progress.integration };
  return {
    ...set,
    revision: set.revision + 1,
    tickets: set.tickets.map((ticket) => (ticket === current ? { ...next, updatedAt: at } : ticket)),
    updatedAt: at
  };
}

/** The ticket a review belongs to, if it was a ticket review. */
/**
 * The reviews of the whole requirement on the full route: the ones no ticket
 * owns, frozen on the requirement checkout after every ticket was brought in.
 */
export function finalReviews<T extends { reviewId: string }>(
  tickets: DevelopmentTicket[],
  reviews: T[]
): T[] {
  const owned = new Set(tickets.flatMap((ticket) => ticket.reviewIds));
  return reviews.filter((review) => !owned.has(review.reviewId));
}

export function ticketOfReview(
  tickets: DevelopmentTicket[],
  reviewId: string
): DevelopmentTicket | undefined {
  return tickets.find((ticket) => ticket.reviewIds.includes(reviewId));
}

/** Files outside the ticket's scope; a scope entry is a file or a directory. */
export function outsideScope(scope: string[], files: string[]): string[] {
  const entries = scope.map((entry) => entry.replace(/\/+$/, ""));
  return files.filter(
    (file) => !entries.some((entry) => entry === "." || file === entry || file.startsWith(`${entry}/`))
  );
}

/**
 * What the Executor is told about its ticket, written by the program so Main
 * only adds the background. English, like every other model-facing text.
 */
export function ticketBrief(ticket: DevelopmentTicket): string {
  return [
    `Ticket ${ticket.ticketId}: ${ticket.title}`,
    ...ticketDetails(ticket),
    "Commit the finished work in your checkout and run the check commands there before you hand back."
  ].join("\n\n");
}

/** A ticket's scope, criteria and boundaries, as both the Executor and its Reviewer read them. */
function ticketDetails(ticket: DevelopmentTicket): string[] {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  return [
    ticket.scope.length
      ? `Change only these paths:\n${list(ticket.scope)}`
      : "No scope was recorded; keep the change to what the ticket needs.",
    `Acceptance criteria:\n${ticket.criteria
      .map(
        (criterion) =>
          `- ${criterion.criterionId} ${criterion.text} (${
            "command" in criterion.check
              ? `check: ${criterion.check.command}`
              : `checked by hand: ${criterion.check.manual}`
          })`
      )
      .join("\n")}`,
    ...(ticket.preserve.length ? [`Keep working:\n${list(ticket.preserve)}`] : []),
    ...(ticket.outOfScope.length ? [`Not part of this ticket:\n${list(ticket.outOfScope)}`] : [])
  ];
}

/** The ids a review of the whole requirement cites its completion criteria by: `CC1`, `CC2`… */
export function completionCriterionIds(criteria: string[]): string[] {
  return criteria.map((_, index) => `CC${index + 1}`);
}

/** The previous round a re-review answers: the findings Main ruled to fix, and what changed since. */
export interface RereviewBrief {
  previous: { findingId: string; title: string; location?: string; detail: string }[];
  changedPaths: string[];
}

/**
 * What a Reviewer is told it examines, written by the program from the records
 * so Main does not retype the criteria: one ticket, the whole requirement after
 * every ticket is in (the full route's final review), or a quick change. A
 * re-review is told the previous round's findings and the files changed since,
 * and that it answers those and nothing more.
 */
export function reviewBrief(input: {
  goal: string;
  criteria: string[];
  tickets: DevelopmentTicket[];
  ticket?: DevelopmentTicket;
  rereview?: RereviewBrief;
}): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  const ids = completionCriterionIds(input.criteria);
  const requirement = [
    `Requirement: ${input.goal}`,
    ...(input.criteria.length
      ? [`Completion criteria:\n${list(input.criteria.map((text, index) => `${ids[index]} ${text}`))}`]
      : [])
  ];
  const body = input.ticket
    ? [
        `You review ticket ${input.ticket.ticketId}: ${input.ticket.title}. Part of the requirement: ${input.goal}`,
        ...ticketDetails(input.ticket)
      ]
    : !input.tickets.length
      ? [`You review this change.`, ...requirement]
      : [
          "You give the final review of the whole requirement. Every ticket below was reviewed on its own and brought in; check that together they meet the requirement, and look at what single-ticket reviews could miss: how the parts fit, behaviour across them, the completion criteria as a whole.",
          ...requirement,
          `Tickets:\n${input.tickets
            .map(
              (ticket) =>
                `- ${ticket.ticketId} ${ticket.title}: ${ticket.criteria.map((criterion) => criterion.text).join("; ")}`
            )
            .join("\n")}`
        ];
  if (!input.rereview) return body.join("\n\n");
  const { previous, changedPaths } = input.rereview;
  return [
    ...body,
    "This is a re-review after a fix. Do only three things: answer every finding below in previousFindings, fixed or not, with the command, test or code that shows it; re-run every acceptance command; and look for regression, data loss, security or project-rule problems in the files changed this round. Raise nothing else.",
    previous.length
      ? `Findings of the previous round:\n${list(
          previous.map(
            (finding) =>
              `${finding.findingId} ${finding.title}${finding.location ? ` (${finding.location})` : ""}: ${finding.detail}`
          )
        )}`
      : "The previous round left no finding to fix.",
    changedPaths.length ? `Files changed this round:\n${list(changedPaths)}` : "No file changed this round."
  ].join("\n\n");
}

/** A ticket's dependencies are all merged, so it can start. */
export function ticketReady(ticket: DevelopmentTicket, tickets: DevelopmentTicket[]): boolean {
  return ticket.dependsOn.every((id) => tickets.find((other) => other.ticketId === id)?.state === "merged");
}

/** A write as a request body carries it; only the fields of its operation pass. */
export function ticketWrite(value: unknown, { progress = false } = {}): TicketWrite {
  const input = record(value, "票操作");
  if (typeof input.op === "string" && TICKET_PROGRESS_OPS.includes(input.op)) {
    if (!progress) throw new ProjectDataInvalidError("票的执行进度由程序记录，不能直接写入");
    return input as unknown as TicketProgress;
  }
  const dryRun = input.dryRun === true;
  if (input.op === "propose") return { op: "propose", tickets: input.tickets, dryRun };
  if (input.op === "confirm") return { op: "confirm", expectedRevision: input.expectedRevision };
  if (input.op === "revise")
    return {
      op: "revise",
      ticketId: input.ticketId,
      changes: input.changes,
      reason: input.reason,
      decision: input.decision,
      expectedRevision: input.expectedRevision,
      dryRun
    };
  throw new ProjectDataInvalidError("票操作须为 propose / confirm / revise");
}

/** The facts the next step is worked out from; each comes from a stored record. */
export interface NextStepFacts {
  route: DevelopmentRoute;
  workspaceReady: boolean;
  tickets: DevelopmentTicket[];
  qualification?: { eligible: boolean; reasons: string[] };
  review?: ReviewFact;
  /** The latest review of the whole requirement, on the full route. */
  finalReview?: ReviewFact;
  /** Tickets whose review chain used its rework rounds, with the failed review to change approach on. */
  ticketsAtLimit?: { ticketId: string; reviewId: string }[];
  merge?: { mergeId: string; state: string; detail?: string; mergeCommit?: string };
  delivery?: { state: string };
  /** The requirement's retro: what its records signal, and whether one is recorded. */
  retro?: { signals: RetroSignals; recorded: boolean; improvements?: RetroImprovement[] };
}

/** A review as the next step reads it; `atLimit` means its chain used its rework rounds. */
export interface ReviewFact {
  reviewId: string;
  state: string;
  reviewer: boolean;
  atLimit?: boolean;
}

const ids = (tickets: DevelopmentTicket[]) => tickets.map((ticket) => ticket.ticketId).join(", ");

const LIMIT =
  "used its rework rounds: do not rework it the same way again. Record a change of approach with change_approach and its basis:";

/**
 * What Main should do next, worked out from the records rather than taught by
 * the prompt. Every `project_development` result carries it.
 */
export function developmentNext(facts: NextStepFacts): string {
  const { merge, review, qualification, tickets } = facts;
  if (merge?.state === "merged")
    return (
      (facts.delivery?.state === "synced"
        ? `Merged as ${merge.mergeCommit ?? "the recorded commit"} and delivered. Report the result to the user.`
        : "Merged; the delivery record is syncing by itself. Report the result; delivery_status shows the sync.") +
      improvementStep(facts.retro?.improvements)
    );
  if (merge?.state === "waiting" || merge?.state === "applying")
    return `Merge ${merge.mergeId} is ${merge.state}. Read merge_status; do not request it again.`;
  if (!facts.workspaceReady) return "Run ensure_workspace to prepare the requirement checkout.";
  if (facts.route !== "quick") {
    if (!tickets.length)
      return facts.route === "direct"
        ? "Propose the ticket with propose_tickets (one ticket, with its scope) and wait for the user's confirmation."
        : "Propose the tickets with propose_tickets and wait for the user's confirmation.";
    const drafts = tickets.filter((ticket) => ticket.state === "draft");
    if (drafts.length)
      return `Tickets ${ids(drafts)} are drafts the user has not confirmed. Revise them from the user's answer and propose_tickets again.`;
  }
  const failed = merge && !["waiting", "applying", "merged"].includes(merge.state);
  const mergeNote = failed
    ? `Merge ${merge.mergeId} ended ${merge.state}${merge.detail ? `: ${merge.detail}` : ""}. `
    : "";
  if (qualification?.eligible) return `${mergeNote}${retroStep(facts.retro)}`;
  if (facts.route !== "quick") return mergeNote + ticketSteps(facts);
  if (review?.state === "in_review") return reviewStep(review);
  if (review?.state === "failed" && review.atLimit)
    return `${mergeNote}Review ${review.reviewId} ${LIMIT} new_plan (rework with a different approach), or deliver_partial (dismiss what stays unfixed with category=deferred first).`;
  if (review?.state === "failed" || review?.state === "drifted")
    return `${mergeNote}Review ${review.reviewId} ${review.state}: rule its blocking findings (fix, or dismiss with a basis), rework through the original Executor (continueCallId), then freeze_candidate with previousReviewId.`;
  const reasons = qualification?.reasons ?? [];
  const work = "Make the change in the checkout, run its checks, then record review_plan channel=self.";
  if (reasons.includes("review_plan_missing")) return `${mergeNote}${work}`;
  return `${mergeNote}Not yet qualified (${reasons.join(", ") || "unknown"}). ${work}`;
}

/** After the merge: the environment improvements the retro registered are the next requirements. */
function improvementStep(improvements: RetroImprovement[] = []): string {
  if (!improvements.length) return "";
  const list = improvements.map((item) => `${item.requirementId} (${item.title})`).join(", ");
  return ` Then develop the environment improvements the retro registered, one requirement at a time: ${list}.`;
}

/** Before the last merge: the requirement's retro, unless the records give it nothing to look at. */
function retroStep(retro: NextStepFacts["retro"]): string {
  if (!retro || retro.recorded || !hasRetroSignals(retro.signals))
    return "The candidate qualifies: request_merge.";
  const { reworkRounds, changedApproach, dismissedBlocking, failedMerges } = retro.signals;
  return `The candidate qualifies. Before request_merge, load the retro skill and do the requirement's retro (${reworkRounds} rework rounds, ${changedApproach} changes of approach, ${dismissedBlocking} blocking findings let through, ${failedMerges} failed merges): keep the repository's traps in ${PITFALLS_DIRECTORY} in a commit that touches only that directory, then request_merge with retro.pitfalls saying what changed, or retro.nothing saying why there is nothing to keep; a change to the environment that would stop a trap goes in retro.improvements.`;
}

function reviewStep(review: { reviewId: string; reviewer: boolean }): string {
  return review.reviewer
    ? `Review ${review.reviewId} has its Reviewer's findings: rule the blocking ones (fix, or dismiss with a basis), then complete_review.`
    : `Review ${review.reviewId} is frozen: delegate the Reviewer with role=reviewer and this reviewId; once it has finished, attach_reviewer binds it and imports its findings.`;
}

/** One sentence per group of tickets that has something to do, in the order the work goes. */
function ticketSteps(facts: NextStepFacts): string {
  const { tickets, review } = facts;
  const by = (state: TicketState) => tickets.filter((ticket) => ticket.state === state);
  const steps: string[] = [];
  for (const ticket of by("in_review")) {
    const open = review && ticket.reviewIds.at(-1) === review.reviewId && review.state === "in_review";
    steps.push(
      open ? `Ticket ${ticket.ticketId}: ${reviewStep(review)}` : `Ticket ${ticket.ticketId} is in review.`
    );
  }
  const passed = by("passed");
  if (passed.length)
    steps.push(
      `Tickets ${ids(passed)} passed review: integrate_ticket brings each into the requirement checkout and runs the project's checks and its acceptance commands.`
    );
  const atLimit = facts.ticketsAtLimit ?? [];
  for (const { ticketId, reviewId } of atLimit)
    steps.push(
      `Ticket ${ticketId} ${LIMIT} fresh_executor (start it again with a new Executor, without continueCallId), revised_ticket (revise_ticket, then a new round), or deliver_partial (dismiss what stays unfixed with category=deferred first) — on review ${reviewId}.`
    );
  const rework = by("rework").filter(
    (ticket) => !atLimit.some((entry) => entry.ticketId === ticket.ticketId)
  );
  if (rework.length)
    steps.push(
      `Tickets ${ids(rework)} need rework: rule the blocking findings (fix, or dismiss with a basis), continue the original Executor with continueCallId and reviewId, then freeze_candidate with ticketId and previousReviewId.`
    );
  const working = by("in_progress");
  if (working.length)
    steps.push(
      `Tickets ${ids(working)} are being implemented: when the Executor finishes, freeze_candidate with ticketId and authorCallId.`
    );
  const confirmed = by("confirmed");
  const ready = confirmed.filter((ticket) => ticketReady(ticket, tickets));
  if (ready.length)
    steps.push(`Tickets ${ids(ready)} can start: call_subagent with developmentId and ticketId.`);
  const waiting = confirmed.filter((ticket) => !ready.includes(ticket));
  if (waiting.length && !steps.length)
    steps.push(`Tickets ${ids(waiting)} wait for their dependencies to be merged.`);
  if (steps.length) return steps.join(" ");
  if (facts.route === "full") {
    const final = facts.finalReview;
    if (!final)
      return "Every ticket is in the requirement checkout. Freeze it for the final review of the whole requirement: freeze_candidate without ticketId, then delegate role=reviewer with that reviewId.";
    if (final.state === "in_review") return `Final review: ${reviewStep(final)}`;
    if (final.state === "failed" && final.atLimit)
      return `Final review ${final.reviewId} ${LIMIT} new_plan (propose new fix tickets on a different approach), or deliver_partial (dismiss what stays unfixed with category=deferred first).`;
    if (final.state === "failed" || final.state === "drifted")
      return `Final review ${final.reviewId} ${final.state}: rule its blocking findings. A defect becomes a new fix ticket (propose_tickets); once it is integrated, freeze_candidate again with previousReviewId.`;
  }
  const reasons = facts.qualification?.reasons ?? [];
  return `Every ticket is in the requirement checkout, but it does not qualify yet (${reasons.join(", ") || "unknown"}).`;
}
