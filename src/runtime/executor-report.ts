/**
 * An Executor's report on a ticket, in the one shape Main can check: one entry
 * per acceptance criterion of the ticket, met or not, with the evidence. The
 * process submits it with `submit_report`; a ticket Executor that ends without
 * one is a failed call, so Main never has to read the criteria out of prose.
 */

export interface ExecutorCriterionReport {
  criterionId: string;
  met: boolean;
  /** The command and what it showed, or what was checked by hand. */
  evidence: string;
}

export interface ExecutorReport {
  criteria: ExecutorCriterionReport[];
}

export type ExecutorReportValidation = { ok: true; report: ExecutorReport } | { ok: false; errors: string[] };

const EVIDENCE_LIMIT = 2000;

/** Validate one submission or one stored record against the ticket's criterion ids. */
export function parseExecutorReport(
  value: unknown,
  criterionIds: readonly string[]
): ExecutorReportValidation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, errors: ["report must be an object with criteria"] };
  const raw = (value as { criteria?: unknown }).criteria;
  if (!Array.isArray(raw)) return { ok: false, errors: ["criteria must be an array"] };
  const errors: string[] = [];
  const criteria: ExecutorCriterionReport[] = [];
  raw.forEach((entry: unknown, index) => {
    const label = `criteria[${index}]`;
    const { criterionId, met, evidence } = (entry ?? {}) as Record<string, unknown>;
    if (typeof criterionId !== "string" || !criterionIds.includes(criterionId))
      errors.push(`${label}.criterionId must be one of ${criterionIds.join(", ")}`);
    else if (criteria.some((item) => item.criterionId === criterionId))
      errors.push(`${label}.criterionId ${criterionId} is reported twice`);
    if (typeof met !== "boolean") errors.push(`${label}.met must be true or false`);
    const text = typeof evidence === "string" ? evidence.trim() : "";
    if (!text || text.length > EVIDENCE_LIMIT)
      errors.push(`${label}.evidence must be 1–${EVIDENCE_LIMIT} characters`);
    if (typeof criterionId === "string" && typeof met === "boolean" && text)
      criteria.push({ criterionId, met, evidence: text });
  });
  const missing = criterionIds.filter(
    (id) => !raw.some((entry) => (entry as { criterionId?: unknown } | null)?.criterionId === id)
  );
  if (missing.length) errors.push(`criteria is missing ${missing.join(", ")}`);
  return errors.length ? { ok: false, errors } : { ok: true, report: { criteria } };
}

/** The report as Main reads it, after the Executor's own hand-back. */
export function executorReportText(report: ExecutorReport): string {
  return [
    "Acceptance criteria, as the Executor reported them:",
    ...report.criteria.map(
      (item) => `- ${item.criterionId} ${item.met ? "met" : "NOT met"}: ${item.evidence}`
    )
  ].join("\n");
}

/** The ticket's criterion ids a dispatcher hands the Executor process, read back from its environment. */
export function parseTicketCriteria(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || !value.length) throw new Error("FORMICAND_TICKET_CRITERIA has no criteria");
  return value.map(String);
}
