import {
  createProjectDevelopmentClient,
  type ProjectDevelopmentClient
} from "./project-development-client.js";

/** What the user is asked to confirm before tickets are frozen or a frozen ticket changes. */
export interface TicketProposal {
  kind: "tickets";
  action: "propose" | "revise";
  developmentId: string;
  requirementTitle: string;
  /** The drafts to freeze, or the one ticket as it would be after the change. */
  tickets: Record<string, unknown>[];
  /** revise: the ticket as it is now, and why it should change. */
  previous?: Record<string, unknown>;
  reason?: string;
}

export interface TicketConfirmation {
  confirmed: boolean;
  /** answered, unanswered (timed out) or cancelled. */
  status: string;
  answer?: string;
}

export interface ProjectDevelopmentToolOptions {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}

/** Shows the proposal to the user and waits; absent where no one can be asked. */
export type ConfirmTickets = (proposal: TicketProposal) => Promise<TicketConfirmation>;

const ID = { type: "string", minLength: 1, maxLength: 300 };
const CHECK = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    command: { type: "string", maxLength: 4000 },
    exitCode: { type: "integer", minimum: 0, maximum: 255 },
    output: { type: "string", maxLength: 8000 }
  },
  required: ["name", "exitCode"],
  additionalProperties: false
} as const;

const CRITERION = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 1000 },
    command: { type: "string", minLength: 1, maxLength: 4000, description: "A command that checks it." },
    manual: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description: "Instead of command: why no command can check it."
    }
  },
  required: ["text"],
  additionalProperties: false
} as const;

const PATHS = (description: string) =>
  ({
    type: "array",
    maxItems: 50,
    items: { type: "string", minLength: 1, maxLength: 300 },
    description
  }) as const;

const TICKET_FIELDS = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  scope: PATHS("Relative paths or directories the ticket may change; required on the direct route."),
  criteria: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: CRITERION,
    description:
      "Acceptance criteria: what to observe, under which condition, each with a command or a manual reason."
  },
  preserve: PATHS("Nearby behaviour that must keep working."),
  outOfScope: PATHS("Related changes the user did not ask for."),
  dependsOn: PATHS("Ticket ids that must be merged first.")
} as const;

const MERGE_ACTIONS = ["request_merge", "apply_merge", "merge_status"] as const;

const REVIEW_ACTIONS = [
  "review_plan",
  "freeze_candidate",
  "attach_reviewer",
  "record_finding",
  "rule_finding",
  "record_rework",
  "complete_review",
  "delivery_check",
  "query_reviews",
  "get_review"
] as const;

/**
 * The Main tool over requirement development records and their reviews.
 *
 * Kept out of the Pi extension so the production path — this executor and its
 * real HTTP bridge — can be exercised without a model. The extension only
 * registers it.
 */
export function createProjectDevelopmentTool(options: ProjectDevelopmentToolOptions) {
  // The bridge is built on first call. Registration must not depend on this
  // run's credential: a delegated subprocess keeps the Dashboard URL while the
  // run credential is removed, and a missing credential must disable only this
  // tool rather than abort every later registration in the extension.
  let client: ReturnType<typeof createProjectDevelopmentClient> | undefined;
  const bridge = () => (client ??= createProjectDevelopmentClient(options));
  return {
    name: "project_development",
    label: "Project Development",
    description:
      "The current project's requirement development records: create one with its isolated Git checkout, read and revise it, propose its tickets for the user to confirm, review a fixed candidate, merge an accepted candidate through the project's shared entry, and read delivery status. Load the requirement-delivery skill for the order of these steps. One record exists per requirement, so look it up before creating; update carries the revision you last read. Each result's next field says what to do next. The project and Task come from this conversation, so no project id or path is accepted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "get",
            "query",
            "find_by_requirement",
            "update",
            "ensure_workspace",
            "tickets",
            "propose_tickets",
            "revise_ticket",
            "integrate_ticket",
            ...REVIEW_ACTIONS,
            ...MERGE_ACTIONS,
            "delivery_status"
          ]
        },
        requirementId: {
          ...ID,
          description: "create/find_by_requirement/delivery_status target requirement."
        },
        developmentId: {
          ...ID,
          description: "get/update/ensure_workspace/review/merge/delivery_status target."
        },
        goal: {
          type: "string",
          maxLength: 4000,
          description: "create/update: what this development must achieve."
        },
        completionCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 1000 },
          description: "create/update: observable conditions that make the requirement done."
        },
        route: {
          type: "string",
          enum: ["quick", "direct", "full"],
          description: "The suggested path: quick, direct or full. A suggestion, not a quota."
        },
        tickets: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: { ticketId: { type: "string", minLength: 1, maxLength: 20 }, ...TICKET_FIELDS },
            required: ["ticketId", "title", "criteria"],
            additionalProperties: false
          },
          description:
            "propose_tickets: the drafts, ids like 01, 02. They replace earlier unconfirmed drafts; confirmed tickets stay. The user confirms them on a card."
        },
        ticketId: {
          type: "string",
          minLength: 1,
          maxLength: 20,
          description:
            "revise_ticket/integrate_ticket target. freeze_candidate: review this ticket's own checkout (direct and full routes); on full, without it once every ticket is in, the final review of the whole requirement."
        },
        changes: {
          type: "object",
          properties: TICKET_FIELDS,
          additionalProperties: false,
          description: "revise_ticket: only the fields that change. The user confirms the change on a card."
        },
        reason: {
          type: "string",
          maxLength: 2000,
          description: "revise_ticket: why the confirmed ticket must change."
        },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "update: the revision returned by the last read; a stale value is refused."
        },
        channel: {
          type: "string",
          enum: ["self", "independent", "combined"],
          description:
            "review_plan: self (Main verified a small change), independent, or combined for a final version. self checks bind to the current commit/tree; record them again after the checkout moves."
        },
        basis: {
          type: "string",
          maxLength: 2000,
          description:
            "review_plan: why this channel is justified. rule_finding: required for fix and dismiss alike."
        },
        checks: {
          type: "array",
          maxItems: 20,
          items: CHECK,
          description: "review_plan/record_finding/complete_review: command, exit code and captured output."
        },
        kind: {
          type: "string",
          enum: ["independent", "combined"],
          description:
            "freeze_candidate: independent review, or combined (which requires a combined plan) for the final version."
        },
        previousReviewId: {
          ...ID,
          description: "freeze_candidate: the review whose findings and new changes this re-review covers."
        },
        authorCallId: {
          ...ID,
          description:
            "freeze_candidate: the Executor work item that produced the candidate; its identity must differ from the Reviewer's."
        },
        reviewId: { ...ID, description: "attach_reviewer/record/rule/complete/get_review target." },
        callId: {
          ...ID,
          description:
            "attach_reviewer: the Reviewer work item returned by call_subagent. The first Reviewer owns the review; retrying the same call is safe and another call is refused."
        },
        title: { type: "string", maxLength: 300, description: "record_finding: short finding title." },
        detail: { type: "string", maxLength: 4000, description: "record_finding: what is wrong and why." },
        location: { type: "string", maxLength: 1000, description: "record_finding: file or symbol." },
        rawFailure: {
          type: "string",
          maxLength: 8000,
          description: "record_finding: the Reviewer's verbatim failing output, kept for later reading."
        },
        findingId: { ...ID, description: "rule_finding: the finding to rule on." },
        decision: {
          type: "string",
          enum: ["fix", "dismiss"],
          description:
            "rule_finding: fix it or dismiss it; every ruling needs basis — for fix, how it is or will be fixed; for dismiss, why it is not a defect. Findings of failed or drifted reviews stay rulable; a passed review is closed."
        },
        category: {
          type: "string",
          enum: ["false_positive", "out_of_scope", "other"],
          description: "rule_finding with dismiss: why the finding does not stand."
        },
        findingIds: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 300 },
          description: "record_rework: findings this continuation fixed."
        },
        fromCallId: {
          ...ID,
          description: "record_rework: the original Executor call whose session and checkout continued."
        },
        continuationCallId: {
          ...ID,
          description: "record_rework: the continuation call returned by call_subagent continueCallId."
        },
        mergeChecks: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              command: { type: "string", minLength: 1, maxLength: 4000 }
            },
            required: ["name", "command"],
            additionalProperties: false
          },
          description:
            "request_merge: commands to run on the target-plus-candidate version; omit to reuse the recorded checks. integrate_ticket: the project's checks, run with the ticket's acceptance commands."
        },
        verdict: {
          type: "string",
          enum: ["passed", "failed"],
          description: "complete_review: whether the fixed candidate satisfies the completion criteria."
        },
        summary: {
          type: "string",
          maxLength: 2000,
          description: "complete_review: the Reviewer's conclusion."
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    async execute(
      input: Record<string, unknown>,
      confirm?: ConfirmTickets
    ): Promise<Record<string, unknown>> {
      const request = bridge();
      const result = await run(request, input, confirm);
      const developmentId = developmentOf(input, result);
      if (!developmentId) return result;
      try {
        const { next } = await request({ action: "next", developmentId });
        return { ...result, next };
        // eslint-disable-next-line no-restricted-syntax -- the next step is a hint beside a result that already succeeded; failing to work it out must not turn that success into an error
      } catch {
        return result;
      }
    }
  };

  async function proposeTickets(
    request: ProjectDevelopmentClient,
    input: Record<string, unknown>,
    confirm: ConfirmTickets | undefined
  ) {
    const developmentId = input.developmentId;
    const { tickets: drafted } = await request({
      action: "write_tickets",
      op: "propose",
      developmentId,
      tickets: input.tickets
    });
    const set = drafted as TicketSetView;
    if (!confirm)
      return {
        confirmed: false,
        tickets: set,
        instruction: "The drafts are saved; only Main can ask the user to confirm them."
      };
    const { development } = await request({ action: "get", developmentId });
    const answer = await confirm({
      kind: "tickets",
      action: "propose",
      developmentId: String(developmentId),
      requirementTitle: titleOf(development),
      tickets: set.tickets.filter((ticket) => ticket.state === "draft")
    });
    if (!answer.confirmed) return unconfirmed(answer, set, "The drafts stay unconfirmed.");
    const { tickets } = await request({
      action: "write_tickets",
      op: "confirm",
      developmentId,
      expectedRevision: set.revision
    });
    return { confirmed: true, tickets };
  }

  async function reviseTicket(
    request: ProjectDevelopmentClient,
    input: Record<string, unknown>,
    confirm: ConfirmTickets | undefined
  ) {
    const developmentId = input.developmentId;
    const { tickets: current } = await request({ action: "tickets", developmentId });
    const set = current as TicketSetView;
    const write = {
      action: "write_tickets",
      op: "revise",
      developmentId,
      ticketId: input.ticketId,
      changes: input.changes,
      reason: input.reason,
      expectedRevision: set.revision
    };
    const { tickets: preview } = await request({ ...write, dryRun: true });
    if (!confirm) throw new Error("A confirmed ticket changes only after the user confirms it on Main.");
    const { development } = await request({ action: "get", developmentId });
    const pick = (view: TicketSetView) => view.tickets.find((ticket) => ticket.ticketId === input.ticketId)!;
    const answer = await confirm({
      kind: "tickets",
      action: "revise",
      developmentId: String(developmentId),
      requirementTitle: titleOf(development),
      tickets: [pick(preview as TicketSetView)],
      previous: pick(set),
      reason: String(input.reason ?? "")
    });
    if (!answer.confirmed) return unconfirmed(answer, set, "The ticket is unchanged.");
    const { tickets } = await request({ ...write, decision: answer.answer });
    return { confirmed: true, tickets };
  }

  async function run(
    request: ProjectDevelopmentClient,
    input: Record<string, unknown>,
    confirm?: ConfirmTickets
  ): Promise<Record<string, unknown>> {
    const action = typeof input.action === "string" ? input.action : "";
    if (action === "create")
      return request({
        action,
        requirementId: input.requirementId,
        goal: input.goal,
        completionCriteria: input.completionCriteria,
        route: input.route
      });
    if (action === "get") return request({ action, developmentId: input.developmentId });
    if (action === "query") return request({ action });
    if (action === "find_by_requirement") return request({ action, requirementId: input.requirementId });
    if (action === "update")
      return request({
        action,
        developmentId: input.developmentId,
        expectedRevision: input.expectedRevision,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.completionCriteria === undefined ? {} : { completionCriteria: input.completionCriteria }),
        ...(input.route === undefined ? {} : { route: input.route })
      });
    if (action === "ensure_workspace") return request({ action, developmentId: input.developmentId });
    if (action === "tickets") return request({ action, developmentId: input.developmentId });
    if (action === "propose_tickets") return proposeTickets(request, input, confirm);
    if (action === "revise_ticket") return reviseTicket(request, input, confirm);
    if (action === "integrate_ticket")
      return request({
        action,
        developmentId: input.developmentId,
        ticketId: input.ticketId,
        ...(input.mergeChecks === undefined ? {} : { checks: input.mergeChecks })
      });

    const review = request.reviews;
    if (action === "review_plan")
      return review({
        action: "plan",
        developmentId: input.developmentId,
        channel: input.channel,
        basis: input.basis,
        checks: input.checks
      });
    if (action === "freeze_candidate")
      return review({
        action: "start",
        developmentId: input.developmentId,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
        ...(input.previousReviewId === undefined ? {} : { previousReviewId: input.previousReviewId }),
        ...(input.authorCallId === undefined ? {} : { authorCallId: input.authorCallId })
      });
    if (action === "attach_reviewer")
      return review({ action: "attach_reviewer", reviewId: input.reviewId, callId: input.callId });
    if (action === "record_finding")
      return review({
        action: "record_finding",
        reviewId: input.reviewId,
        title: input.title,
        detail: input.detail,
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.checks === undefined ? {} : { checks: input.checks }),
        ...(input.rawFailure === undefined ? {} : { rawFailure: input.rawFailure })
      });
    if (action === "rule_finding")
      return review({
        action: "rule_finding",
        reviewId: input.reviewId,
        findingId: input.findingId,
        decision: input.decision,
        ...(input.category === undefined ? {} : { category: input.category }),
        basis: input.basis
      });
    if (action === "record_rework")
      return review({
        action: "record_rework",
        reviewId: input.reviewId,
        findingIds: input.findingIds,
        fromCallId: input.fromCallId,
        continuationCallId: input.continuationCallId
      });
    if (action === "complete_review")
      return review({
        action: "complete",
        reviewId: input.reviewId,
        verdict: input.verdict,
        summary: input.summary,
        checks: input.checks
      });
    if (action === "delivery_check")
      return review({ action: "delivery", developmentId: input.developmentId });
    if (action === "query_reviews")
      return review({
        action: "query",
        ...(input.developmentId === undefined ? {} : { developmentId: input.developmentId })
      });
    if (action === "get_review") return review({ action: "get", reviewId: input.reviewId });

    const merges = request.merges;
    if (action === "request_merge")
      return merges({
        action: "request",
        developmentId: input.developmentId,
        ...(input.mergeChecks === undefined ? {} : { checks: input.mergeChecks })
      });
    if (action === "apply_merge") return merges({ action: "apply" });
    if (action === "merge_status")
      return merges({
        action: "query",
        ...(input.developmentId === undefined ? {} : { developmentId: input.developmentId })
      });
    if (action === "delivery_status")
      return request.deliveries({
        action: "view",
        ...(input.developmentId === undefined ? {} : { developmentId: input.developmentId }),
        ...(input.requirementId === undefined ? {} : { requirementId: input.requirementId })
      });
    throw new Error(`未知的开发记录操作：${String(action)}`);
  }
}

interface TicketSetView {
  developmentId: string;
  revision: number;
  tickets: (Record<string, unknown> & { ticketId: string; state: string })[];
}

function titleOf(development: unknown): string {
  const record = development as { requirementTitle?: string; goal?: string } | undefined;
  return record?.requirementTitle || record?.goal || "";
}

function unconfirmed(answer: TicketConfirmation, tickets: TicketSetView, unchanged: string) {
  return {
    confirmed: false,
    status: answer.status,
    ...(answer.answer ? { answer: answer.answer } : {}),
    tickets,
    instruction:
      answer.status === "answered"
        ? `${unchanged} If the answer asks for changes, apply them and call again; otherwise stop and tell the user.`
        : `${unchanged} The user did not answer; work only on confirmed tickets as they stand.`
  };
}

/** The development a call acted on, from its arguments or from what it returned. */
function developmentOf(input: Record<string, unknown>, result: Record<string, unknown>): string | undefined {
  if (typeof input.developmentId === "string" && input.developmentId) return input.developmentId;
  for (const key of ["development", "review", "merge", "tickets", "plan", "qualification", "view"]) {
    const value = result[key] as { developmentId?: unknown } | null | undefined;
    if (value && typeof value.developmentId === "string") return value.developmentId;
  }
  return undefined;
}
