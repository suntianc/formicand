---
name: task-routing
description: Which flow and which skills fit a task, and how to delegate work to collaborators. Load at the start of every task, before reading code or editing files.
---

# Task routing

Before stating what a skill does or skipping one of its steps, load it: the summaries here are for orientation only.

## A requirement: the main flow

A requirement is a feature, fix or change of behaviour the user wants in a Git project. Load `requirement-delivery`: the program carries the work in a development record, even for a small change (its `quick` route is you editing and checking alone, and the program records and merges). Never change the user's working tree for a requirement.

The method runs along these skills, each naming the next:

1. **`grill-with-docs`** settles the open questions on the goal, scope and acceptance by interview, and records the project's terms and decisions. Skip it when the request already settles them.
2. On the `full` route, **`to-spec`** turns the outcome into a spec, then **`to-tickets`** splits it into tickets.
3. **`implement`** builds each ticket, driving **`tdd`** and closing with a self-review by **`code-review`**. An Executor runs it on a ticket; you run it yourself on the `quick` route.
4. On the `direct` and `full` routes, an independent Reviewer reviews with **`code-review`**.
5. Before the last merge, **`retro`** keeps the repository's pitfalls.

## Something is broken

A bug report, a failing test or wrong behaviour: load **`diagnosing-bugs`** before theorising. It builds a loop that goes red on this bug first, then fixes with a regression test. Diagnosing alone is an investigation; once the fix changes the code, it is a requirement, usually on the `quick` route.

## The words underneath

- **`domain-modeling`**: the project's terms (`GLOSSARY.md`) and decisions (ADRs), when a word is fuzzy or a decision is hard to reverse.
- **`codebase-design`**: the vocabulary for a module's shape (interface, depth, seam), when an interface is being designed.

## Everything else

Questions, investigations, documents, one-off scripts and file handling need no record. Do them yourself, delegating as below when it pays. When unsure, a change to code or behaviour the user will keep is a requirement.

## Delegating

- Each collaborator costs extra time and money. Do simple tasks, single-file edits and work that needs continuity yourself; delegate independent work that can run in parallel, or work that needs a clean context or an independent judgment.
- One delegation is one clear result that can be checked on its own. Brief it as a colleague who has not seen this conversation: the goal, the scope, the question to answer, the input paths, what to hand back and how to tell it is right. Do not forward the user's broad request as it is.
- `call_subagent` returns a callId at once and the result arrives as a callback. Keep doing work that does not depend on it, or end the turn; use `wait_for_subagents` only when this turn needs the result.
- Send independent delegations in the same turn. When one needs another's result, declare `dependsOn` rather than waiting and sending it yourself.
- Do not let two collaborators repeat the same work or edit the same file. When two need to exchange findings, give each the other's callId; they use `send_peer_message`.
- For a costly or risky result, add one independent check: `role=reviewer` with the candidate and its evidence, never the executor's own account. Skip it for simple tasks.
- A collaborator's "succeeded" means it finished running. Check its conclusions, paths, commands and tests before you use them. To change its direction while it runs, use `send_subagent_message`.
- A collaborator's question arrives with a `questionId` and blocks it until answered or timed out. Answer once and promptly with `send_subagent_message`, passing the callId and questionId. After a timeout it goes on with the assumption it stated, so judge its result by that.
- Call collaborators by their `name` when talking to the user.
