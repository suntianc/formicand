---
name: retro
description: A requirement's retro, once before its last merge, which keeps the repository's pitfalls in docs/pitfalls/. Use when project_development's next asks for one, or when the user asks for a retro.
---

# Retro

A retro looks back over one whole requirement, whatever its tickets, reviews and rework rounds, and keeps what the repository taught: its **pitfalls**. They live in the repository's `docs/pitfalls/`, travel with it, and are read by whoever works there next. The retro produces nothing else.

## What to look for

Read the requirement's records first: reviews and their findings, rework, changes of approach, dismissals, failed merges, and the collaborators' reports. `next` names the signals it counted. Look for:

- an external dependency, tool or environment that kept failing here;
- a meaning in this domain that was misunderstood more than once;
- a wrong move repeated, or the same exploration done twice.

A single ordinary review correction, or a transient error fixed at once, is not a pitfall.

## What is a pitfall

A situation in this repository where the obvious move goes wrong, and a way out that works here. It comes from the code, its configuration or environment, or how a tool or external system behaves in this project.

Not a pitfall: advice on how to work anywhere ("read the original log"); an agent overstepping (killing processes by name); anything a test, a check or the project's instructions already cover. Ask: would the next agent who meets this act differently after reading it? If not, leave it out.

## Write reusable lessons, not the story

Keep what lets someone recognise the situation; leave out how this requirement went. No commit SHAs, ticket or review ids, round counts, test counts or absolute paths. Write "a new checkout lacks the env file Git ignores", not the device model and the probe command of one run.

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

Commit the changes in the requirement's checkout, on top of the approved version, touching only `docs/pitfalls/`. Then `request_merge` with `retro.pitfalls`: what was added, merged and removed. With nothing to keep, commit nothing and pass `retro.nothing` with why. Report the pitfall changes to the user with the delivery.
