---
name: task-routing
description: Which flow and which skills fit a task, and how to delegate work to collaborators. Load at the start of every task, before reading code or editing files.
---

# Task routing

Load a skill before stating what it does or skipping a step: these summaries only orient.

## A requirement: the main flow

A requirement is a feature, fix or change of behaviour the user wants in a Git project. Load `requirement-delivery`: the program carries the work in a development record, even for a small change (its `quick` route is you editing and checking alone). Never change the user's working tree for a requirement.

Before any question or design, `project_ledger lookup` the user's own words and settle which feature owns it: an existing one, even named differently; misc for a change no feature owns; a new feature only when none fits. Then read its `context`: the summary holds the rules the change must keep.

The method:

1. **`grill-with-docs`** interviews to settle open questions on goal, scope and acceptance, and records the project's terms; a decision hard to reverse becomes an ADR in the development's first commit. Skip it when the request settles them.
2. On the `full` route, **`to-spec`** turns the outcome into a spec, then **`to-tickets`** splits it into tickets.
3. **`implement`** builds the change, driving **`tdd`** and closing with a self-review by **`code-review`**. You run it; an Executor runs it only for a `full` ticket.
4. On `full`, and on `quick` when the program or you call for one, an independent Reviewer reviews with **`code-review`**.
5. Before the last merge, **`retro`** turns its lessons into environment improvements and pitfalls.

## Something is broken

A bug report, failing test or wrong behaviour: load **`diagnosing-bugs`** before theorising. It reproduces the bug first, then fixes it with a regression test. Diagnosing alone is an investigation; once the fix changes the code, it is a requirement, usually on the `quick` route.

## The words underneath

- **`domain-modeling`**: the project's terms (`GLOSSARY.md`) and decisions (ADRs), when a word is fuzzy or a decision is hard to reverse.
- **`codebase-design`**: the vocabulary for a module's shape (interface, depth, seam), when an interface is being designed.

## Everything else

Questions, investigations, documents, one-off scripts and file handling need no record; do them yourself, delegating when it pays. When unsure, a change to code or behaviour the user will keep is a requirement.

## Delegating

- Each collaborator costs time and money, and every handoff loses context. Write code yourself; delegate reading that returns a short answer (code, logs, docs), a check against stated criteria, or independent parts that run in parallel.
- One delegation is one result checkable on its own. Brief it as a colleague who has not seen this conversation: goal, scope, question, input paths, what to hand back and how to tell it is right; never forward the user's broad request as is.
- `call_subagent` returns a callId at once; the result arrives as a callback. Keep working or end the turn; `wait_for_subagents` only when this turn needs the result.
- Send independent delegations in one turn; when one needs another's result, declare `dependsOn` instead of waiting.
- Never let two collaborators repeat work or edit the same file. To exchange findings, give each the other's callId; they use `send_peer_message`.
- For a costly or risky result, add one independent check: `role=reviewer` with the candidate and its evidence, not the executor's account. Skip it for simple tasks.
- A collaborator's "succeeded" means it finished running: check its conclusions, paths and tests before use. To redirect it while it runs, use `send_subagent_message`.
- A collaborator's question carries a `questionId` and blocks it until answered or timed out. Answer once, promptly, with `send_subagent_message` (callId and questionId). After a timeout it goes on with the assumption it stated; judge its result by that.
- Call collaborators by `name` when talking to the user.
