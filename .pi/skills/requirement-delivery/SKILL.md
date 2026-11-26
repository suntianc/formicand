---
name: requirement-delivery
description: Develop a requirement in the user's Git project through an isolated checkout, independent review and the project's shared merge entry. Use when the user asks for a feature, fix or change that should be recorded, reviewed and merged as a requirement.
---

# Requirement delivery

`project_development` keeps the record, tickets, reviews and merge; every result carries `next`, the step the program expects. Follow it.

Start with `find_by_requirement` for the feature `project_ledger lookup` settled, continuing its active record; `create` takes `request`, the user's own words. Work happens in the record's checkout, never the user's working tree.

## Choosing the route

- `quick`, the default, also for work in several parts: you write the change in the checkout yourself, check it, and record `review_plan` with `self` and your checks. When the program refuses `self` (a path in the project's `AGENTS.md` review table, or too many files), record `independent` and `freeze_candidate`; a Reviewer only checks, and you fix what it finds.
- `full`: only when the user asks for parts accepted one by one, or the work splits into parts with settled interfaces that Executors can build in parallel. Its spec splits into tickets the user confirms; a final independent review covers the whole requirement.

When the target branch moves on, merge it into the checkout and check again; on `full`, `sync_target` does this without a ticket.

## Writing acceptance criteria

- Start from the smallest solution on the data and flows the project already has; ask the user about the cases it leaves unhandled or put them in `outOfScope`. Robustness nobody raised (concurrency, restarts, old records, reconciling replies) is a criterion only where the project already guards it.
- Say what is observed, when and where: "running `summarize.sh scores.csv` prints `total: 42`", not "totals are correct".
- Give each criterion a check command, or why none can exist and how it is checked.
- Name the inputs and platforms that matter, not "all", "never" or "any input".
- `preserve` names behaviour that must survive, so no criterion needs it changed; `outOfScope` names work nobody asked for.
- Confirmed criteria change only by the user's decision, recorded with `revise_ticket`.

## Ruling review findings

`attach_reviewer` imports a finished Reviewer's findings; only those citing a criterion or a floor class (regression, data loss, security, project rules) block.

- `fix` a right blocking finding yourself on `quick`, or through the ticket's Executor (`continueCallId` and `reviewId`). In code nobody asked for, the fix is removing that code.
- `dismiss` a wrong one (`false_positive`), one outside the ask (`out_of_scope`) or one left for later (`deferred`); the user reads the basis.
- Take a suggestion only when cheap and inside the ticket; else it becomes a new ticket or a note to the user.
- A change to the agreed goal, criteria or trade-offs goes to the user first.
- A re-review only answers the previous round.

## When the rework rounds run out

After two rework rounds on a ticket or the requirement's review, decide yourself and record `change_approach` on the failed review with the reason, then carry it out:

- `fresh_executor`: a new Executor (no `continueCallId`).
- `revised_ticket`: revise a wrong or too big ticket.
- `new_plan`: for the requirement's review, new fix tickets on a different approach.
- `deliver_partial`: deliver what is done, after dismissing what stays unfixed as `deferred`.

## The ledger at merge

`request_merge` carries `ledger`. Rewrite the whole summary as the feature now behaves and the rules it keeps, settled ones in, replaced ones out; the next developer reads only this. The history line says what changed in a sentence.

## Reporting

A requirement is done only when merged. Report what changed, the evidence (checks, review, merge commit), what is left open, and from `delivery_status`'s `reviewReport` each dismissal and change of approach with its reason and how many suggestions were left.
