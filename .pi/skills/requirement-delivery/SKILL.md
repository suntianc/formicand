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
- `full`: several parts that can be built and accepted separately, or an approach that needs agreeing first. Write the plan, then split it into tickets; once every ticket is in, an independent final review looks at the whole requirement.

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

The program imports the Reviewer's findings when you `attach_reviewer` after it finishes; you do not copy them. A finding blocks only when it cites an acceptance criterion or a floor class (regression, data loss, security, the project's own rules); everything else arrives as a suggestion that blocks nothing.

- `fix` a blocking finding that is right. Fix it through the Executor that made the change (`continueCallId`), so its session and checkout carry over.
- `dismiss` a blocking finding that is wrong (`false_positive`), outside what was asked (`out_of_scope`), or left for later (`deferred`); the basis is what the user will read.
- Pick up a suggestion only when it is cheap and inside the ticket; leave the rest. A suggestion that still matters becomes a new ticket or a note to the user, not an expansion of this one.
- Anything that would change the agreed goal, criteria or trade-offs goes to the user first.
- A re-review only answers the previous round. Do not ask it for more.

## When the rework rounds run out

Each ticket, and the whole requirement's own review, has two rework rounds. After the second failed round the program refuses a third round of the same rework: record `change_approach` on the failed review, with the reason, and carry it out.

- `fresh_executor`: start the ticket again with a new Executor (no `continueCallId`), when the first one keeps missing the point.
- `revised_ticket`: the ticket itself is wrong or too big; revise it, then a new round.
- `new_plan`: for the whole requirement's review, propose new fix tickets on a different approach.
- `deliver_partial`: deliver what is done. Dismiss what stays unfixed with `deferred` first, saying what is left undone.

You decide these yourself; do not stop to ask.

## Reporting

A requirement is done only when it is merged. Report what changed, the evidence (checks, review, merge commit) and anything left open. Never report an unmerged candidate as delivered.

`delivery_status` lists in `reviewReport` every blocking finding you dismissed with its reason, every change of approach, and the suggestions. Report all dismissals and changes of approach with their reasons, and the number of suggestions left as they are.
