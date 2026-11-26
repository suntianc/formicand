import {
  createProjectDevelopmentClient,
  type ProjectDevelopmentClient
} from "./project-development-client.js";
import { pitfallsHint } from "./project-pitfalls.js";

import type { TicketsProposal } from "./human.js";
export type TicketProposal = TicketsProposal & { expectedRevision: number };

export interface TicketConfirmation {
  confirmed: boolean;
  requestId?: string;
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
  scope: PATHS(
    "Relative paths or directories the ticket is meant to change; the Reviewer judges any file changed outside them."
  ),
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
  "change_approach",
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
      "The current project's requirement development records: create one with its isolated Git checkout, read and revise it, propose its tickets for the user to confirm, review a fixed candidate (the Reviewer's findings are imported by the program; a review chain has two rework rounds before Main must change approach), merge an accepted candidate through the project's shared entry, and read delivery status. Load the requirement-delivery skill for the order of these steps. A requirement is a long-lived feature with one development per piece of work and at most one active: find_by_requirement returns the active one (or the latest), so continue it rather than creating another; withdraw stops one that will not be finished. update and withdraw carry the revision you last read. Each result's next field says what to do next. The project and Task come from this conversation, so no project id or path is accepted.",
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
            "withdraw",
            "ensure_workspace",
            "tickets",
            "propose_tickets",
            "revise_ticket",
            "start_ticket",
            "integrate_ticket",
            "sync_target",
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
          description:
            "get/update/ensure_workspace/sync_target/review/merge/delivery_status target. sync_target merges the target branch's new commits into a full route's requirement checkout, with no ticket of its own."
        },
        request: {
          type: "string",
          maxLength: 100,
          description:
            "create: the user's own words naming this feature, as they said it; kept as an alias when lookup would not have found the requirement by them."
        },
        goal: {
          type: "string",
          maxLength: 20000,
          description: "create/update: what this development must achieve; on the full route, its spec."
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
          enum: ["quick", "full"],
          description:
            "quick (the default, also for work in several parts: you write and check the change yourself; the program may require an independent review) or full (parts with settled interfaces that Executors build in parallel, or parts the user wants to accept one by one: tickets the user confirms, each reviewed, then a final review)."
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
            "revise_ticket/start_ticket/integrate_ticket target. start_ticket opens the ticket's own checkout for you to write it yourself. freeze_candidate: review this ticket's own checkout; without it once every ticket is in, the final review of the whole requirement."
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
            "review_plan: self (Main checked the change itself), independent, or combined for a final version. self checks bind to the current commit/tree; record them again after the checkout moves. When the program refuses self it says why; use independent then."
        },
        basis: {
          type: "string",
          maxLength: 2000,
          description:
            "review_plan: why this channel is justified. rule_finding: required for fix and dismiss alike. change_approach: why this approach, and for deliver_partial what is left undone."
        },
        checks: {
          type: "array",
          maxItems: 20,
          items: CHECK,
          description: "review_plan/record_finding/complete_review: command, exit code and captured output."
        },
        approach: {
          type: "string",
          enum: ["fresh_executor", "revised_ticket", "new_plan", "deliver_partial"],
          description:
            "change_approach, on the latest failed review once its chain used its two rework rounds: fresh_executor (a ticket restarts with a new Executor), revised_ticket (revise_ticket, then a new round), new_plan (the whole requirement's review: new fix tickets), or deliver_partial (accept the failed review as it is; first dismiss what stays unfixed with category=deferred). Each of the first three is used once per chain."
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
            "freeze_candidate: the Executor work item that produced the candidate, when an Executor wrote it; its identity must differ from the Reviewer's."
        },
        mapping: {
          type: "array",
          maxItems: 50,
          description:
            "freeze_candidate, the final review only (required there, every round): the acceptance mapping the final Reviewer verifies, written for this requirement checkout. One row per completion criterion or plan requirement; rows are numbered M1, M2… and a blocking finding may cite one.",
          items: {
            type: "object",
            properties: {
              requirement: { type: "string", description: "The completion criterion or plan requirement." },
              evidence: {
                type: "string",
                description: "The test, command or file on this checkout that shows it holds."
              }
            },
            required: ["requirement", "evidence"]
          }
        },
        reviewId: {
          ...ID,
          description: "attach_reviewer/record/rule/change_approach/complete/get_review target."
        },
        callId: {
          ...ID,
          description:
            "attach_reviewer, once the Reviewer work item returned by call_subagent has finished: binds it to the review and imports its submitted findings. A running Reviewer is refused; a conclusion that breaks the review's rules is refused and leaves the review free for another Reviewer. The bound Reviewer owns the review; retrying the same call is safe."
        },
        title: {
          type: "string",
          maxLength: 300,
          description:
            "record_finding (only for a custom Reviewer that answers in prose): short finding title."
        },
        detail: { type: "string", maxLength: 4000, description: "record_finding: what is wrong and why." },
        location: { type: "string", maxLength: 1000, description: "record_finding: file or symbol." },
        blocking: { type: "boolean", description: "record_finding: whether it blocks acceptance." },
        findingBasis: {
          type: "string",
          maxLength: 40,
          description:
            "record_finding with blocking=true: the criterion id it violates, or regression, data_loss, security, project_rule."
        },
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
            "rule_finding: fix it or dismiss it; every ruling needs basis — for fix, how it is or will be fixed; for dismiss, why it does not stand. A suggestion blocks nothing and can only be picked up to fix. A claimed fix on a failed review can still be dismissed. Findings of failed or drifted reviews stay rulable; a passed review is closed."
        },
        category: {
          type: "string",
          enum: ["false_positive", "out_of_scope", "deferred", "other"],
          description:
            "rule_finding with dismiss: why the finding does not stand — or deferred, when it is left for later and reported as not done."
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
            "request_merge: commands to run on the target-plus-candidate version; omit to reuse the recorded checks. integrate_ticket: the tests of the modules this ticket changes, run with its acceptance commands; the whole suite only when it changes something all modules depend on, such as shared models, migrations, dependency locks or build configuration."
        },
        retro: {
          type: "object",
          properties: {
            pitfalls: { type: "string", minLength: 1, maxLength: 2000 },
            nothing: { type: "string", minLength: 1, maxLength: 2000 },
            improvements: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 200 },
                  content: { type: "string", minLength: 1, maxLength: 4000 }
                },
                required: ["title", "content"],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false,
          description:
            "request_merge: the requirement's retro, once before its last merge. pitfalls: which entries in docs/pitfalls/ were added, merged or removed (committed on top of the approved version, touching only that directory); nothing: why there is nothing to keep. improvements: changes to the agents' environment (code structure, checks, tests, instructions, tools) that would stop a trap better than a pitfall; each becomes a ledger requirement to develop after this merge. Omit retro when next does not ask for one."
        },
        ledger: {
          type: "object",
          properties: {
            summary: { type: "string", minLength: 1, maxLength: 20000 },
            summaryUnchanged: { type: "string", minLength: 1, maxLength: 1000 },
            history: { type: "string", minLength: 1, maxLength: 1000 },
            description: { type: "string", minLength: 1, maxLength: 200 },
            descriptionUnchanged: { type: "boolean", enum: [true] }
          },
          required: ["history"],
          additionalProperties: false,
          description:
            "request_merge: the requirement's ledger once this development lands, written only when it is delivered. summary: the whole summary rewritten as the feature now is and its rules; summaryUnchanged: why it stays. history: one line on what this development changed. description: the new description when what the feature does, whom it serves or its scope changed; descriptionUnchanged: true otherwise. A retry reuses the earlier request's ledger."
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
      // The checks outlive this call. Their outcome, with the next step, comes
      // back as an Inbox event; the next step worked out now would be stale.
      if (result.pending === true)
        return {
          ...result,
          note: "The checks are running in the background. Their result, with the next step, arrives as a message that wakes you, so do not repeat this call: do other work or park with sleep_until."
        };
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
    const drafts = set.tickets.filter((ticket) => ticket.state === "draft");
    if (!drafts.length) return { confirmed: true, tickets: set };
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
      expectedRevision: set.revision,
      tickets: drafts
    });
    if (!answer.confirmed) return unconfirmed(answer, set, "The drafts stay unconfirmed.");
    const { tickets } = await request({
      action: "write_tickets",
      op: "confirm",
      decisionId: answer.requestId,
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
    if ((preview as TicketSetView).revision === set.revision) return { confirmed: true, tickets: set };
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
      expectedRevision: set.revision,
      changes: input.changes as Record<string, unknown>,
      reason: String(input.reason ?? "")
    });
    if (!answer.confirmed) return unconfirmed(answer, set, "The ticket is unchanged.");
    const { tickets } = await request({ ...write, decision: answer.answer, decisionId: answer.requestId });
    return { confirmed: true, tickets };
  }

  async function run(
    request: ProjectDevelopmentClient,
    input: Record<string, unknown>,
    confirm?: ConfirmTickets
  ): Promise<Record<string, unknown>> {
    const action = typeof input.action === "string" ? input.action : "";
    if (action === "create") {
      // The user's words are required so the program can learn them as an alias.
      if (typeof input.request !== "string" || !input.request.trim())
        throw new Error("create 需要 request：用户对这个功能的原话");
      const created = await request({
        action,
        requirementId: input.requirementId,
        request: input.request,
        goal: input.goal,
        completionCriteria: input.completionCriteria,
        route: input.route
      });
      // Main is told once, when the requirement's checkout opens, to read its pitfalls.
      const directory = (created.development as { workspace?: { directory?: string } } | undefined)?.workspace
        ?.directory;
      const pitfalls = directory ? await pitfallsHint(directory) : undefined;
      return pitfalls ? { ...created, pitfalls } : created;
    }
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
    if (action === "withdraw")
      return request({
        action: "update",
        developmentId: input.developmentId,
        expectedRevision: input.expectedRevision,
        status: "withdrawn"
      });
    if (action === "ensure_workspace") return request({ action, developmentId: input.developmentId });
    if (action === "tickets") return request({ action, developmentId: input.developmentId });
    if (action === "propose_tickets") return proposeTickets(request, input, confirm);
    if (action === "revise_ticket") return reviseTicket(request, input, confirm);
    if (action === "sync_target") return request({ action, developmentId: input.developmentId });
    if (action === "start_ticket")
      return request({ action, developmentId: input.developmentId, ticketId: input.ticketId });
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
        ...(input.authorCallId === undefined ? {} : { authorCallId: input.authorCallId }),
        ...(input.mapping === undefined ? {} : { mapping: input.mapping })
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
        blocking: input.blocking,
        ...(input.findingBasis === undefined ? {} : { basis: input.findingBasis }),
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
    if (action === "change_approach")
      return review({
        action: "change_approach",
        reviewId: input.reviewId,
        approach: input.approach,
        basis: input.basis
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
        ...(input.mergeChecks === undefined ? {} : { checks: input.mergeChecks }),
        ...(input.retro === undefined ? {} : { retro: input.retro }),
        ...(input.ledger === undefined ? {} : { ledger: input.ledger })
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
