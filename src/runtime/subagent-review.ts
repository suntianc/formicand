/**
 * The Reviewer's conclusion, in the one shape Main can act on.
 *
 * A delegated Reviewer does not submit prose Main has to interpret: it calls
 * `submit_review`, the process records the conclusion, and the backend imports
 * it into the review record. The same validator runs in the extension (so a
 * malformed submission is an error the model can retry) and in the backend (so
 * an imported conclusion is re-checked against the review it belongs to).
 *
 * What a review may block on is bounded: a blocking finding names the
 * acceptance criterion it violates or one of the floor classes every change
 * must hold. Anything else is a suggestion and blocks nothing. A re-review is
 * narrower still: it answers each finding the previous round asked to fix, and
 * a new blocking finding must cite a criterion or a floor problem in the files
 * this round changed.
 */

export type ReviewVerdict = "pass" | "changes_requested";

/** Problems any change must not introduce, whatever its criteria say. */
export type FloorClass = "regression" | "data_loss" | "security" | "project_rule";

export interface ReviewFinding {
  /** A short name for the finding. */
  title: string;
  /** Where the finding is: a file path, a path:line, or a named area. */
  location: string;
  /** What was actually observed, and what supports it. */
  evidence: string;
  /** Whether this finding blocks acceptance. */
  blocking: boolean;
  /** For a blocking finding: the criterion id it violates, or a floor class. */
  basis?: string;
}

/** A re-review's answer for one finding the previous round asked to fix. */
export interface PreviousFindingAnswer {
  findingId: string;
  fixed: boolean;
  evidence: string;
}

export interface ReviewConclusion {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  /** Present on a re-review: one answer per finding of the previous round. */
  previousFindings?: PreviousFindingAnswer[];
}

/**
 * What one review may cite, fixed by the program when the candidate is frozen.
 *
 * Without a scope only the shape is checked; the backend always checks the
 * conclusion against the scope of the review it is imported into.
 */
export interface ReviewScope {
  /** Criterion ids a blocking finding may cite. */
  criteria: string[];
  /** On a re-review: the findings the previous round asked to fix. */
  previous?: { findingId: string; title: string }[];
  /** On a re-review: the files changed since the previous candidate. */
  changedPaths?: string[];
}

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["pass", "changes_requested"];
export const FLOOR_CLASSES: readonly FloorClass[] = ["regression", "data_loss", "security", "project_rule"];
export const MAX_REVIEW_FINDINGS = 50;

export type ReviewValidation = { ok: true; review: ReviewConclusion } | { ok: false; errors: string[] };

const CRITERION = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/;

export function isFloorClass(value: string): value is FloorClass {
  return (FLOOR_CLASSES as readonly string[]).includes(value);
}

/** The file part of a location: `src/a.ts:12` names `src/a.ts`. */
export function locationPath(location: string): string {
  return location.replace(/:\d+(?:[-:]\d+)*$/, "").trim();
}

function inChangedPaths(location: string, changed: string[]): boolean {
  const path = locationPath(location).replace(/^\.\//, "").replace(/\/$/, "");
  return changed.some((entry) => entry === path || entry.startsWith(`${path}/`));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validate one submission or one stored record; every error names the field. */
export function parseReviewConclusion(value: unknown, scope?: ReviewScope): ReviewValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, errors: ["conclusion must be an object with verdict and findings"] };
  const input = value as { verdict?: unknown; findings?: unknown; previousFindings?: unknown };
  const verdict = input.verdict;
  if (verdict !== "pass" && verdict !== "changes_requested")
    errors.push('verdict must be "pass" or "changes_requested"');
  const rawFindings = input.findings;
  if (!Array.isArray(rawFindings)) {
    errors.push("findings must be an array");
    return { ok: false, errors };
  }
  if (rawFindings.length > MAX_REVIEW_FINDINGS)
    errors.push(`findings must contain at most ${MAX_REVIEW_FINDINGS} entries`);
  const rereview = Boolean(scope?.previous);
  const findings: ReviewFinding[] = [];
  rawFindings.forEach((entry, index) => {
    const label = `findings[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object with title, location, evidence and blocking`);
      return;
    }
    const finding = entry as Record<string, unknown>;
    const title = text(finding.title);
    const location = text(finding.location);
    const evidence = text(finding.evidence);
    const basis = text(finding.basis);
    const before = errors.length;
    if (!title) errors.push(`${label}.title must be a non-empty string`);
    else if (title.length > 300) errors.push(`${label}.title must be at most 300 characters`);
    if (!location) errors.push(`${label}.location must be a non-empty string`);
    if (!evidence) errors.push(`${label}.evidence must be a non-empty string`);
    if (typeof finding.blocking !== "boolean") errors.push(`${label}.blocking must be true or false`);
    else if (finding.blocking) {
      if (!basis)
        errors.push(
          `${label}.basis is required on a blocking finding: the criterion id it violates, or one of ${FLOOR_CLASSES.join(", ")}`
        );
      else if (!isFloorClass(basis)) {
        if (!CRITERION.test(basis))
          errors.push(`${label}.basis must be a criterion id or one of ${FLOOR_CLASSES.join(", ")}`);
        else if (scope && !scope.criteria.includes(basis))
          errors.push(
            `${label}.basis ${basis} is not a criterion of this review${
              scope.criteria.length ? ` (${scope.criteria.join(", ")})` : ""
            }; a problem no criterion covers blocks only as ${FLOOR_CLASSES.join(", ")}, otherwise set blocking=false`
          );
      } else if (rereview && location && !inChangedPaths(location, scope?.changedPaths ?? []))
        errors.push(
          `${label}: a re-review blocks on a ${basis} problem only in a file this round changed; ${location} is not one of them`
        );
    } else if (rereview)
      errors.push(`${label}: a re-review carries no suggestions; report only blocking findings with a basis`);
    if (errors.length > before) return;
    findings.push({
      title,
      location,
      evidence,
      blocking: finding.blocking as boolean,
      ...(finding.blocking && basis ? { basis } : {})
    });
  });
  const answers = parsePreviousAnswers(input.previousFindings, scope, errors);
  const unfixed = answers?.some((answer) => !answer.fixed) ?? false;
  const blocking = findings.some((finding) => finding.blocking);
  if (verdict === "changes_requested" && !blocking && !unfixed)
    errors.push("changes_requested requires a blocking finding or a previous finding that is not fixed");
  if (verdict === "pass" && blocking) errors.push("pass cannot carry a blocking finding");
  if (verdict === "pass" && unfixed) errors.push("pass cannot leave a previous finding unfixed");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    review: { verdict: verdict as ReviewVerdict, findings, ...(answers ? { previousFindings: answers } : {}) }
  };
}

function parsePreviousAnswers(
  value: unknown,
  scope: ReviewScope | undefined,
  errors: string[]
): PreviousFindingAnswer[] | undefined {
  const expected = scope?.previous;
  if (value === undefined || value === null) {
    if (expected?.length)
      errors.push(
        `previousFindings must answer every finding of the previous round: ${expected
          .map((finding) => finding.findingId)
          .join(", ")}`
      );
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push("previousFindings must be an array");
    return undefined;
  }
  if (scope && !expected) {
    errors.push("previousFindings belongs to a re-review; this is a first review");
    return undefined;
  }
  const answers: PreviousFindingAnswer[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const label = `previousFindings[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object with findingId, fixed and evidence`);
      return;
    }
    const answer = entry as Record<string, unknown>;
    const findingId = text(answer.findingId);
    const evidence = text(answer.evidence);
    const before = errors.length;
    if (!findingId) errors.push(`${label}.findingId must be a non-empty string`);
    else if (seen.has(findingId)) errors.push(`${label}.findingId ${findingId} is answered twice`);
    else if (expected && !expected.some((finding) => finding.findingId === findingId))
      errors.push(`${label}.findingId ${findingId} is not a finding of the previous round`);
    if (typeof answer.fixed !== "boolean") errors.push(`${label}.fixed must be true or false`);
    if (!evidence) errors.push(`${label}.evidence must be a non-empty string`);
    if (errors.length > before) return;
    seen.add(findingId);
    answers.push({ findingId, fixed: answer.fixed as boolean, evidence });
  });
  const missing = (expected ?? []).filter((finding) => !seen.has(finding.findingId));
  if (missing.length)
    errors.push(`previousFindings is missing ${missing.map((finding) => finding.findingId).join(", ")}`);
  return answers;
}

/** The review scope a dispatcher hands the Reviewer process, read back from its environment. */
export function parseReviewScope(raw: string | undefined): ReviewScope | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as Partial<ReviewScope>;
  if (!Array.isArray(value.criteria)) throw new Error("COWORK_REVIEW_SCOPE has no criteria");
  return {
    criteria: value.criteria.map(String),
    ...(Array.isArray(value.previous)
      ? {
          previous: value.previous.map((entry) => ({
            findingId: String(entry.findingId),
            title: String(entry.title)
          }))
        }
      : {}),
    ...(Array.isArray(value.changedPaths) ? { changedPaths: value.changedPaths.map(String) } : {})
  };
}
