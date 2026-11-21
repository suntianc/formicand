---
name: requirement-delivery
description: Develop a requirement in the user's Git project through an isolated checkout, independent review and the project's shared merge entry. Use when the user asks for a feature, fix or change that should be recorded, reviewed and merged as a requirement.
---

# Requirement delivery

`project_development` keeps the record, tickets, reviews and merge; every result carries `next`, the step the program expects. Follow it. This skill covers the judgments the program cannot make.

Start with `find_by_requirement` and continue an existing record rather than create another. Work happens in the record's checkout, never the user's working tree.

## Before the record

- When open questions on the goal, scope or acceptance would change the design, load `grilling` and settle them first.
- Read the parts of `GLOSSARY.md` and `docs/adr/` the requirement touches. Load `domain-modeling` when a term needs sharpening or a decision is worth an ADR.

## Choosing the route

- `quick`: a small, clear change you can make and check yourself in a few files. No tickets and no independent review; your own checks gate the merge. Most fixes and small features belong here.
- `direct`: one coherent change worth an independent Executor and Reviewer, because it touches behaviour others rely on or you cannot fully check it yourself.
- `full`: several parts that can be built and accepted separately, or an approach that needs agreeing first. Write the plan, then split it into tickets; once every ticket is in, an independent final review looks at the whole requirement.

Pick the smallest route that keeps the result trustworthy. A route is cheaper to raise later than to carry unused.

## Splitting into tickets

On the full route, load `to-tickets` and follow it. On any route, `preserve` names behaviour that must survive and `outOfScope` work nobody asked for.

## Executors and Reviewers

Built-in Executors build with `tdd` and Reviewers review with `code-review`, as their role prompts say. An Executor stuck on an unexplained bug loads `diagnosing-bugs`.

## Writing acceptance criteria

- Say what is observed, when and where: "running `summarize.sh scores.csv` prints `total: 42`", not "totals are correct".
- Give each criterion a check command, or say why none can exist and how it is checked instead.
- Avoid unbounded words such as "all", "never" or "any input": name the inputs and platforms that matter.
- Confirmed criteria change only by the user's decision, recorded with `revise_ticket`.

## Ruling review findings

`attach_reviewer` imports a finished Reviewer's findings. Only a finding citing a criterion or a floor class (regression, data loss, security, project rules) blocks; the rest are suggestions.

- `fix` a right blocking finding through the Executor that made the change (`continueCallId`).
- `dismiss` a wrong one (`false_positive`), one outside the ask (`out_of_scope`) or one left for later (`deferred`); the user reads the basis.
- Take a suggestion only when cheap and inside the ticket; one that matters becomes a new ticket or a note to the user.
- A change to the agreed goal, criteria or trade-offs goes to the user first.
- A re-review only answers the previous round.

## When the rework rounds run out

A ticket, and the requirement's own review, get two rework rounds; then the program refuses a third until you record `change_approach` on the failed review, with the reason, and carry it out:

- `fresh_executor`: a new Executor (no `continueCallId`).
- `revised_ticket`: revise a wrong or too big ticket.
- `new_plan`: for the requirement's review, new fix tickets on a different approach.
- `deliver_partial`: deliver what is done, after dismissing what stays unfixed as `deferred`.

Decide these yourself.

## Reporting

A requirement is done only when merged. Report what changed, the evidence (checks, review, merge commit) and what is left open.

From `delivery_status`'s `reviewReport`, report every dismissal and change of approach with its reason, and how many suggestions were left.
