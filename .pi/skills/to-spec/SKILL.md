---
name: to-spec
description: Turn the conversation and the codebase into a spec for a requirement - problem, solution, implementation and testing decisions, out of scope - and record it as the requirement's content in the ledger. Use on the full route, after the interview and before splitting into tickets.
---

<!-- Adapted from mattpocock/skills (MIT), skills/engineering/to-spec at abeeaf9. Changes: the spec is written to the requirement's content in project_ledger instead of an issue tracker; user stories become the requirement's completion criteria; seams are stated in the spec and checked with the user through the ticket confirmation. -->

This skill takes the current conversation and your understanding of the code and produces a spec. Do NOT interview the user; just synthesise what you already know. If questions are still open, run `grill-with-docs` first.

## Process

1. Explore the repo to understand the current state of the code, if you haven't already. Use the project's `GLOSSARY.md` vocabulary throughout the spec, and respect any ADRs in `docs/adr/` in the area you're touching.

2. Sketch the seams at which the feature will be tested. Prefer existing seams to new ones, and the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better; the ideal number is one. Write them under Testing Decisions; the user checks them when confirming the tickets.

3. Write the spec with the template below and record it as the requirement's `content` with `project_ledger` (`update`, carrying the revision you last read). What the user must be able to observe when it is done goes into the development record's completion criteria, not into the spec as user stories.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- The seams under test
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>

Then load `to-tickets` and split the spec into tickets.
