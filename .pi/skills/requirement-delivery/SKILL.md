---
name: requirement-delivery
description: Develop a requirement in the user's Git project through an isolated checkout, independent review and the project's shared merge entry. Use when the user asks for a feature, fix or change that should be recorded, reviewed and merged as a requirement.
---

# Requirement delivery

All steps use `project_development` unless another tool is named.

## Record and checkout

- Look the requirement up with `find_by_requirement` first; one record exists per requirement. `create` records the goal, the completion criteria, the route (`quick`, `direct` or `full`) and the code baseline, and prepares an isolated Git checkout. The user's own working tree is never changed.
- `ensure_workspace` continues or repairs that checkout at its recorded baseline. Retries and recovery reuse it; never delete or reset it.
- `update` appends a revision and carries the revision you last read.
- On the `direct` and `full` routes, `propose_tickets` records the tickets: scope, acceptance criteria with a check command each, what must keep working, what is not part of this change, and dependencies. The user confirms them on a card; after that `revise_ticket` changes one only with the user's confirmation.

## Doing the work

- Small changes can be made directly in the checkout; run the checks there.
- To delegate, pass `developmentId` to `call_subagent`. Each item gets its own checkout forked from the requirement checkout, so parallel items do not overwrite each other, the integration checkout or the user's tree. When an item finishes, bring its result into the integration checkout with the ordinary file and Git tools.

## Review

1. `review_plan` records the review channel and your self-checks. A `self` check is bound to the commit it ran on: after the checkout moves, record it again on the new version.
2. `freeze_candidate` freezes the integration checkout's current commit (record a non-`self` channel first; for a combined review set the channel to `combined`). Then delegate with `role=reviewer`.
3. `attach_reviewer` binds that Reviewer call; then `record_finding` and `rule_finding`. A review belongs to its first Reviewer: a different Reviewer needs a new review. Dismissed findings and out-of-scope suggestions still get a category and a reason. A change to the agreed requirement, criteria or trade-offs goes to the user first.
4. To fix a finding, call `call_subagent` with `continueCallId` (the finished Executor's callId) and `reviewId`: it continues that Executor's own session and checkout. Do not start a fresh Agent with a summary of the first attempt. After bringing the fix in, review the new candidate with `previousReviewId`; a passed re-review settles the fixes along the chain. Findings of a failed or drifted review can still be ruled or reworked.
5. `delivery_check` gives the current candidate, its qualification and the reasons. A review stops counting once the candidate changes.

## Merge

- When the candidate qualifies, `request_merge` submits it to the project's shared entry. The execution location updates the target branch in order and reruns the checks you gave on the combined version if the target moved meanwhile.
- After an interruption or a conflict, `merge_status` reads the operation and the actual merged SHA; `apply_merge` makes the execution backend reconcile the Git facts. Do not use a lock inside the requirement instead of the shared entry, and never report an unmerged candidate as done.
- After a real merge the program records the delivery: an external board item becomes ready to release with its owner and merged commit; an internal one is written to the ledger. `delivery_status` reads the phase, collaborator progress, diff, checks and the sync receipt. A pending sync retries by itself: do not develop, merge or record the delivery again.
