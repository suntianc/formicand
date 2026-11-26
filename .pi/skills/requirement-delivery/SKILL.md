---
name: requirement-delivery
description: Develop a requirement in the user's Git project through an isolated checkout, independent review and the project's shared merge entry. Use when the user asks for a feature, fix or change that should be recorded, reviewed and merged as a requirement.
---

# Requirement delivery

`project_development` keeps the record, tickets, reviews and merge; every result carries `next`, the step the program expects. Follow it.

Start with `find_by_requirement` for the feature `project_ledger lookup` settled, and continue its active record if there is one; `create` takes `request`, the user's own words. Work happens in the record's checkout, never the user's working tree.

## Choosing the route

- `quick` is the default, also when the work has several parts. You write the whole change in the checkout yourself, check it, and record `review_plan` with `self` and the checks you ran. If the program refuses `self`, it says why; then record `independent` and `freeze_candidate`. The Reviewer only checks the candidate against the criteria; you fix what it finds.
- `full` is for work too large to check as one change, or that the user wants to accept part by part. The spec becomes tickets the user confirms. You write them yourself, one at a time: `start_ticket` opens a ticket's own checkout. Give an Executor only a ticket that can be built beside yours without touching it. Each ticket is reviewed, then a final review covers the whole requirement.

When the target branch moves on, merge it into the checkout and check again; on `full`, `sync_target` does this.

## Scope and acceptance criteria

- Start from the smallest solution built on the data and flows the project already has. Name the cases it leaves unhandled, then ask the user about them or put them in `outOfScope`.
- Robustness nobody asked for (concurrency, restarts, old records, retries) becomes a criterion only where the project already guards it.
- Say what is observed, when and where: "running `summarize.sh scores.csv` prints `total: 42`", not "totals are correct". Give each criterion a check command, or say how it is checked instead.
- Name the inputs that matter instead of "all" or "any".
- `preserve` lists behaviour that must keep working, so no criterion may require changing it.
- Confirmed criteria change only by the user's decision, recorded with `revise_ticket`.

## Review findings

`attach_reviewer` imports the Reviewer's findings. Only a finding that cites a criterion, a regression, data loss, security or a project rule blocks; the rest are suggestions.

- Fix a right blocking finding yourself, in the checkout that holds the change; when an Executor wrote the ticket, through that Executor (`continueCallId` and `reviewId`). When it sits in code nobody asked for, remove that code.
- `dismiss` a wrong finding (`false_positive`), one outside the ask (`out_of_scope`) or one left for later (`deferred`), with a basis the user will read.
- Take a suggestion only when it is cheap and inside the scope; otherwise mention it to the user.
- A change to the agreed goal, criteria or trade-offs goes to the user first.

After two failed rework rounds, the program asks for `change_approach` on the failed review. Choose it yourself and give the reason: `fresh_executor` (a ticket restarts with a new Executor), `revised_ticket` (the ticket was wrong or too big), `new_plan` (new fix tickets for the final review) or `deliver_partial` (deliver what is done; first dismiss the rest as `deferred`).

## Merging and reporting

`request_merge` carries `ledger`: rewrite the whole summary as the feature now behaves and the rules it keeps, since the next developer reads only this, and add one history line saying what changed.

A requirement is done only when merged. Report what changed, the evidence (checks, review, merge commit) and what is left open; from `delivery_status`'s `reviewReport`, also each dismissal and change of approach with its reason, and how many suggestions were left.
