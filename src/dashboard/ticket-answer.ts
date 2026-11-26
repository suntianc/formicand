import { isDeepStrictEqual } from "node:util";
import { ProjectDataConflictError } from "../domain/project-ledger.js";
import type { DevelopmentTicket, TicketSet, TicketWrite } from "../domain/development-ticket.js";
import type { HumanRequest, TicketsProposal } from "../runtime/human.js";
import type { ProjectDevelopmentService } from "./project-development-service.js";

function hasDecision(set: TicketSet, id: string) {
  return set.tickets.some(
    (ticket) => ticket.confirmationId === id || ticket.changes.some((change) => change.decisionId === id)
  );
}

/** Old cards stored the displayed tickets but not the set revision or the original patch. */
function legacyWrite(
  card: TicketsProposal,
  current: TicketSet,
  decisionId: string,
  decision: string
): TicketWrite {
  const changed = () =>
    new ProjectDataConflictError(
      "票已更新，请基于最新修订重试",
      current.revision,
      "ticket_revision_conflict"
    );
  if (card.action === "propose") {
    if (
      !hasDecision(current, decisionId) &&
      !isDeepStrictEqual(
        current.tickets.filter((ticket) => ticket.state === "draft"),
        card.tickets
      )
    )
      throw changed();
    return { op: "confirm", expectedRevision: current.revision, decisionId };
  }
  const preview = card.tickets[0] as unknown as DevelopmentTicket;
  const ticket = current.tickets.find((item) => item.ticketId === preview.ticketId);
  if (!hasDecision(current, decisionId) && !isDeepStrictEqual(ticket, card.previous)) throw changed();
  const changes = { ...preview, criteria: preview.criteria.map(({ text, check }) => ({ text, ...check })) };
  const fields = Object.keys(preview.changes.at(-1)!.previous) as (keyof typeof changes)[];
  return {
    op: "revise",
    ticketId: preview.ticketId,
    expectedRevision: current.revision,
    changes: Object.fromEntries(fields.map((field) => [field, changes[field]])),
    reason: card.reason,
    decisionId,
    decision
  };
}

/** Commit the displayed decision before publishing the answer to a waiting or newly woken Main. */
export async function applyTicketAnswer(
  service: ProjectDevelopmentService,
  request: HumanRequest,
  answer: string
) {
  const card = request.proposal;
  if (card?.kind !== "tickets") return;
  if (answer !== request.options?.[0]) {
    // The authority may have committed a prior confirmation before saving its local answer failed.
    const set = await service.ticketsForTask(request.taskId, card.developmentId);
    if (hasDecision(set, request.requestId))
      throw new ProjectDataConflictError("这张卡的确认已生效，请重新提交确认以同步记录", set.revision);
    return;
  }
  const { taskId, requestId: decisionId } = request;
  let write: TicketWrite;
  if (card.expectedRevision === undefined) {
    // A still-waiting older Pi writes its own timely confirmation.
    if (request.status === "pending" && (!request.expiresAt || Date.parse(request.expiresAt) > Date.now()))
      return;
    write = legacyWrite(card, await service.ticketsForTask(taskId, card.developmentId), decisionId, answer);
  } else {
    const at = (expectedRevision: number): TicketWrite =>
      card.action === "propose"
        ? { op: "confirm", expectedRevision, decisionId }
        : {
            op: "revise",
            expectedRevision,
            decisionId,
            ticketId: card.tickets[0].ticketId,
            changes: card.changes,
            reason: card.reason,
            decision: answer
          };
    try {
      await service.writeTicketsForTask(taskId, card.developmentId, at(card.expectedRevision));
      return;
    } catch (error) {
      // Another ticket of the set moved on after the card was shown (one was
      // integrated, say). What the user approved still stands as displayed, so
      // the decision applies at the current revision; any other change refuses it.
      if (!(error instanceof ProjectDataConflictError)) throw error;
      const current = await service.ticketsForTask(taskId, card.developmentId);
      if (!stillAsShown(card, current)) throw error;
      write = at(current.revision);
    }
  }
  await service.writeTicketsForTask(taskId, card.developmentId, write);
}

/** The tickets the card asks about are as it showed them. */
function stillAsShown(card: TicketsProposal, current: TicketSet): boolean {
  if (card.action === "propose")
    return isDeepStrictEqual(
      current.tickets.filter((ticket) => ticket.state === "draft"),
      card.tickets
    );
  const ticket = current.tickets.find((item) => item.ticketId === card.tickets[0]?.ticketId);
  return card.previous !== undefined && isDeepStrictEqual(ticket, card.previous);
}
