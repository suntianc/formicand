---
name: requirement-delivery
description: Develop a requirement in the user's Git project through an isolated checkout, independent review and the project's shared merge entry. Use when the user asks for a feature, fix or change that should be recorded, reviewed and merged as a requirement.
---

# Requirement delivery

`project_development` keeps the record, tickets, reviews and merge; every result carries `next`, the step the program expects. Follow it.

The requirement is the feature `project_ledger lookup` settled. Start with `find_by_requirement` and continue its active record rather than create another; `create` takes `request`, the user's own words. Work happens in the record's checkout, never the user's working tree.

The method itself lives in the skills `task-routing` names (`grill-with-docs`, `to-spec`, `to-tickets`, `implement`, `code-review`); this skill covers how the program carries it and the judgments the program cannot make.

## Choosing the route

- `quick`, the default: you make the change in the checkout and check it, then record `review_plan` with `self` and your checks. The program refuses `self` when the change touches a path in the project's `AGENTS.md` independent-review table, or more files than one person can check; then record `independent` and `freeze_candidate`, and an independent Reviewer looks at it. Record `independent` yourself when you cannot fully check the change. A change of documents only is quick.
- `full`: only when the user wants parts accepted one by one, or the work splits into parts that can each be built and accepted alone. The spec goes into the requirement and splits into tickets the user confirms; once every ticket is in, an independent final review looks at the whole requirement.

When the target branch moves on, a quick change merges it in its checkout and checks again; on `full`, `sync_target` merges it in without a ticket.

## Writing acceptance criteria

- Say what is observed, when and where: "running `summarize.sh scores.csv` prints `total: 42`", not "totals are correct".
- Give each criterion a check command, or say why none can exist and how it is checked instead.
- Avoid unbounded words such as "all", "never" or "any input": name the inputs and platforms that matter.
- `preserve` names behaviour that must survive and `outOfScope` work nobody asked for.
- Confirmed criteria change only by the user's decision, recorded with `revise_ticket`.

## Ruling review findings

`attach_reviewer` imports a finished Reviewer's findings. Only a finding citing a criterion or a floor class (regression, data loss, security, project rules) blocks; the rest are suggestions.

- `fix` a right blocking finding through the Executor that made the change (`continueCallId` and `reviewId`).
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

## The ledger at merge

`request_merge` carries `ledger`. Rewrite the whole summary as the feature now behaves and the rules it keeps, adding the rules this work settled and dropping the ones it replaced; the next developer reads only this. The history line says what changed in a sentence.

## Reporting

A requirement is done only when merged. Report what changed, the evidence (checks, review, merge commit) and what is left open.

From `delivery_status`'s `reviewReport`, report every dismissal and change of approach with its reason, and how many suggestions were left.
