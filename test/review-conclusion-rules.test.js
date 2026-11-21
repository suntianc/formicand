import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewBrief } from "../dist/src/domain/development-ticket.js";
import { locationPath, parseReviewConclusion } from "../dist/src/runtime/subagent-review.js";

const finding = (extra = {}) => ({
  title: "total row missing",
  location: "src/export.ts:12",
  evidence: "tail -1 prints body",
  blocking: true,
  basis: "AC1",
  ...extra
});
const errors = (value, scope) => {
  const parsed = parseReviewConclusion(value, scope);
  assert.equal(parsed.ok, false, "the conclusion is refused");
  return parsed.errors.join("\n");
};

test("a blocking finding cites a criterion of this review or a floor class", () => {
  const scope = { criteria: ["AC1", "AC2"] };
  assert.match(
    errors({ verdict: "changes_requested", findings: [finding({ basis: undefined })] }, scope),
    /basis is required on a blocking finding/
  );
  assert.match(
    errors({ verdict: "changes_requested", findings: [finding({ basis: "AC9" })] }, scope),
    /AC9 is not a criterion of this review/
  );
  for (const basis of ["AC2", "regression", "data_loss", "security", "project_rule"]) {
    const parsed = parseReviewConclusion(
      { verdict: "changes_requested", findings: [finding({ basis })] },
      scope
    );
    assert.equal(parsed.ok, true, basis);
  }
  // A suggestion needs no basis and blocks nothing, so a pass may carry it.
  const pass = parseReviewConclusion(
    { verdict: "pass", findings: [finding({ blocking: false, basis: undefined })] },
    scope
  );
  assert.equal(pass.ok, true);
  assert.equal(pass.review.findings[0].basis, undefined);
  assert.match(
    errors({ verdict: "changes_requested", findings: [finding({ blocking: false })] }, scope),
    /changes_requested requires a blocking finding/
  );
  assert.match(errors({ verdict: "pass", findings: [finding({ title: "" })] }, scope), /title must be/);
});

test("a re-review answers the previous round and blocks only on this round's changes", () => {
  const scope = {
    criteria: ["AC1"],
    previous: [{ findingId: "finding-1", title: "total row missing" }],
    changedPaths: ["src/export.ts", "test/export.test.js"]
  };
  assert.match(errors({ verdict: "pass", findings: [] }, scope), /must answer every finding.*finding-1/);
  assert.match(
    errors(
      {
        verdict: "pass",
        findings: [],
        previousFindings: [{ findingId: "finding-2", fixed: true, evidence: "ok" }]
      },
      scope
    ),
    /finding-2 is not a finding of the previous round[\s\S]*missing finding-1/
  );
  const answered = [{ findingId: "finding-1", fixed: true, evidence: "tail -1 prints total" }];
  assert.match(
    errors(
      {
        verdict: "changes_requested",
        findings: [finding({ basis: "regression", location: "src/other.ts:3" })],
        previousFindings: answered
      },
      scope
    ),
    /only in a file this round changed; src\/other.ts:3/
  );
  assert.match(
    errors(
      {
        verdict: "pass",
        findings: [finding({ blocking: false, basis: undefined })],
        previousFindings: answered
      },
      scope
    ),
    /a re-review carries no suggestions/
  );
  assert.match(
    errors({ verdict: "pass", findings: [], previousFindings: [{ ...answered[0], fixed: false }] }, scope),
    /pass cannot leave a previous finding unfixed/
  );
  // A floor problem in a changed file, or a criterion anywhere, still blocks.
  for (const extra of [
    { basis: "security", location: "src/export.ts:40" },
    { basis: "AC1", location: "src/x.ts" }
  ]) {
    const parsed = parseReviewConclusion(
      { verdict: "changes_requested", findings: [finding(extra)], previousFindings: answered },
      scope
    );
    assert.equal(parsed.ok, true, JSON.stringify(extra));
  }
  const unfixed = parseReviewConclusion(
    { verdict: "changes_requested", findings: [], previousFindings: [{ ...answered[0], fixed: false }] },
    scope
  );
  assert.equal(unfixed.ok, true, "an unfixed previous finding is reason enough to request changes");
  assert.equal(locationPath("src/export.ts:12:4"), "src/export.ts");
});

test("a re-review brief lists the previous round and the files changed since", () => {
  const brief = reviewBrief({
    goal: "export has a total row",
    criteria: ["the last line is total"],
    tickets: [],
    rereview: {
      previous: [
        { findingId: "finding-1", title: "total row missing", location: "export.txt:3", detail: "body" }
      ],
      changedPaths: ["export.txt"]
    }
  });
  assert.match(brief, /CC1 the last line is total/);
  assert.match(brief, /re-review after a fix\. Do only three things/);
  assert.match(brief, /finding-1 total row missing \(export.txt:3\): body/);
  assert.match(brief, /Files changed this round:\n- export.txt/);
});
