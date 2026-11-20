---
name: requirement-delivery
description: Develop a requirement in the user's Git project through an isolated checkout, independent review and the project's shared merge entry. Use when the user asks for a feature, fix or change that should be recorded, reviewed and merged as a requirement.
---

# Requirement delivery

`project_development` keeps the record, the tickets, the reviews and the merge, and every result carries `next`: the step the program expects from the current state. Follow it. This skill covers the judgments the program cannot make.

Start with `find_by_requirement`: one record exists per requirement, so continue an existing one instead of creating another. The user's own working tree is never changed; work happens in the record's checkout.

## Choosing the route

- `quick`: a small, clear change you can make and check yourself in a few files. No tickets and no independent review; your own checks gate the merge. Most fixes and small features belong here.
- `direct`: one coherent change worth an independent Executor and Reviewer, for example because it touches behaviour other people rely on or you cannot fully check it yourself.
- `full`: several parts that can be built and accepted separately, or an approach that needs agreeing first. Write the plan, then split it into tickets.

Pick the smallest route that keeps the result trustworthy. A route is cheaper to raise later than to carry unused. Questions, investigations and one-off scripts are not requirements: do them without a record.

## Splitting into tickets

- Split by vertical slices that can each be checked on their own, not by layer: "the summary shows the total" rather than "parser" then "renderer".
- Each ticket's scope lists the paths it may change. Keep scopes apart where you can, so tickets can run in parallel and the scope check means something.
- Put a dependency only where a ticket really needs another's result; dependencies serialize the work.
- Prefer two to five tickets. More than that usually means the requirement should be split into several requirements.
- "Keep working" names nearby behaviour that must survive. "Not in this change" names related work the user did not ask for, so the Executor does not drift into it.

## Writing acceptance criteria

- Say what is observed, under which condition and where: "running `summarize.sh scores.csv` prints `total: 42`", not "totals are correct".
- Give each criterion a check command when one exists. When none can, say why and how it is checked instead (a screenshot, a manual step the user confirms).
- Avoid unbounded words such as "all", "never" or "any input": name the inputs and platforms that matter.
- Criteria the user confirmed are fixed. A change needs the user's decision, recorded with `revise_ticket`.

## Ruling review findings

- `fix` when the finding breaks a criterion, a kept behaviour or the project's checks, or is a real defect inside the ticket's scope.
- `dismiss` when it is wrong, out of scope or a preference; give the reason.
- A finding outside the ticket that still matters becomes a new ticket or a note to the user, not an expansion of this one.
- Anything that would change the agreed goal, criteria or trade-offs goes to the user first.
- Fix a finding through the Executor that made the change (`continueCallId`), so its session and checkout carry over. Do not start a fresh Agent with a summary.

## Reporting

A requirement is done only when it is merged. Report what changed, the evidence (checks, review, merge commit) and anything left open. Never report an unmerged candidate as delivered.
