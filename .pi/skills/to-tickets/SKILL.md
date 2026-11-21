---
name: to-tickets
description: Break a requirement's plan into tracer-bullet tickets, each a vertical slice with its own scope, acceptance criteria and dependencies, and propose them through project_development. Use on the full route, after the plan is written.
---

<!-- Adapted from mattpocock/skills (MIT), skills/engineering/to-tickets at abeeaf9. Changes: tickets go to project_development's propose_tickets instead of an issue tracker or local files; the user confirms them through the program's confirmation. -->

# To Tickets

Break the requirement's plan into **tickets**: tracer-bullet vertical slices, each declaring the tickets it **depends on**.

## Process

### 1. Gather context

Work from the development record (goal, completion criteria, plan) and the conversation. Read `GLOSSARY.md` if the project has one, so ticket titles use its words, and the ADRs in `docs/adr/` in the area the requirement touches.

### 2. Explore the codebase

If you have not already, explore the code the requirement touches. Look for prefactoring that would make the implementation easier: "make the change easy, then make the easy change". Prefactoring goes first, as its own ticket.

### 3. Draft vertical slices

- Each slice cuts a narrow but COMPLETE path through every layer it needs (data, logic, interface, tests): vertical, NOT a horizontal slice of one layer. "The summary shows the total", not "parser" then "renderer".
- A completed slice can be checked on its own: its acceptance criteria hold without the tickets after it.
- Each slice fits in one Executor's fresh session.
- Prefer two to five tickets. More usually means several requirements.

Give each ticket its **dependencies** (`dependsOn`): the tickets that must be merged before it can start. Add one only where a ticket really needs another's result; dependencies serialize the work. A ticket with none can start at once, beside the others.

Give each ticket a **scope**: the paths it may change. Keep scopes apart where you can, so tickets run in parallel and the program's scope check means something.

**Wide refactors are the exception to vertical slicing.** A wide refactor is one mechanical change (rename a column, retype a shared symbol) whose blast radius fans across the codebase, so no vertical slice can land green. Sequence it as **expand–contract**: first expand (add the new form beside the old so nothing breaks); then migrate the call sites in batches sized by blast radius (per package, per directory), each batch its own ticket depending on the expand, the checks green batch to batch because the old form still exists; finally contract (delete the old form once no caller remains), in a ticket depending on every batch.

### 4. Write each ticket

- **title**: the end-to-end behaviour it makes work, from the user's side.
- **criteria**: what is observed, when and where, each with a check command or, when none can exist, the reason and how it is checked instead.
- **preserve**: nearby behaviour that must keep working.
- **outOfScope**: related work the user did not ask for, so the Executor does not drift into it.

Avoid specific code snippets and line numbers: they go stale fast. Exception: a snippet from a prototype that encodes a decision more precisely than prose (a state machine, a schema, a type shape); trim it to the decision and say it came from a prototype.

### 5. Propose

Send the tickets with `propose_tickets`. The program asks the user to confirm them; that confirmation is how the user checks the breakdown: the granularity, the dependencies, what to merge or split. Revise and propose again on their answer. Confirmed criteria change only by the user's decision, recorded with `revise_ticket`.

The program starts every ticket whose dependencies are merged; follow its `next`.
