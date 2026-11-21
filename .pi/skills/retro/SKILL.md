---
name: retro
description: A requirement's retro, once before its last merge. It turns its lessons into environment improvements and pitfalls in docs/pitfalls/. Use when project_development's next asks for one, or when the user asks for a retro.
---

# Retro

A retro looks back over one whole requirement, whatever its tickets and rework rounds, and asks what made the work harder than it needed to be and what stops the next agent meeting it again: a change to the agents' environment, registered as a new requirement, or a **pitfall** in the repository's `docs/pitfalls/`, read by whoever works there next.

## What to look for

Read the requirement's records first: reviews and their findings, rework, changes of approach, dismissals, failed merges, and the collaborators' reports. `next` names the signals it counted. Look for:

- an external dependency, tool or environment that kept failing here;
- a meaning in this domain that was misunderstood more than once;
- a wrong move repeated, or the same exploration done twice;
- code hard to navigate, or shaped to invite the wrong change;
- a mistake a test or check could have caught, or the Reviewer missed;
- instructions (`AGENTS.md`, a skill) missing, wrong, or too long;
- information the agents could not reach, or a tool used wastefully.

An ordinary review correction, or a transient error fixed at once, is neither.

## Where each lesson goes

Take the first that would stop the trap:

1. the code's structure: a clearer module, name or interface;
2. a check: lint, type or script;
3. a test;
4. the project's instructions or a skill;
5. information or a tool the agents can use;
6. only when none of these can stop it: a pitfall.

Items 1–5 are **improvements**. Do not make them now: pass each in `retro.improvements` as a title and content (what to change, and the trap it stops). The program registers each as a requirement and `next` sends you to it after this merge. An improvement's own retro keeps pitfalls only.

## What is a pitfall

A situation in this repository where the obvious move goes wrong, and a way out that works here. It comes from the code, its configuration or environment, or how a tool or external system behaves in this project.

Not a pitfall: advice for working anywhere; an agent overstepping (killing processes by name); anything a test, a check or the project's instructions already cover. Ask: would the next agent who meets this act differently after reading it? If not, leave it out.

## Write reusable lessons, not the story

Keep what lets someone recognise the situation, not how this requirement went. No commit SHAs, ticket or review ids, round counts, test counts or absolute paths. Write "a new checkout lacks the env file Git ignores", not the device model and the probe command of one run.

Each entry has five fields of one or two sentences:

- **Trigger:** the situation: a path, command, tool, interface, error text or domain state.
- **What happens:** what goes wrong.
- **Confirm:** a check anyone can do today, whose result changes once the trap is gone.
- **Avoid:** the way out.
- **Sources:** the requirement's title and the date.

One entry is one trigger and one way out. Pages are grouped by where the trap is met (`testing.md`, `database.md`, an external system); `docs/pitfalls/README.md` indexes every entry in one table row: `| Trigger | [Entry](page.md#anchor) |`.

## Tidy on every write

Each time you write, go over the whole directory:

- merge entries with the same or a similar trigger and the same way out, joining their sources;
- delete entries whose trap is gone: the code changed, a test or check now stops it, or Confirm no longer shows it;
- keep the index in step with the pages.

## Record it

Commit the pitfall changes in the requirement's checkout, on top of the approved version, touching only `docs/pitfalls/`. Then `request_merge` with `retro.pitfalls`: what was added, merged and removed. With no pitfall to keep, commit nothing and pass `retro.nothing` with why. Either way, add `retro.improvements` when the retro found any.
