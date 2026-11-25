# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (where it lives, frontmatter, invocation, and the router). Everything else about writing it is the universal reference in `SKILL.md`.

## Where a skill lives

A skill is a folder holding `SKILL.md`, plus any files it points at. Formicand reads, highest first: a trusted project's `.formicand/skills` and `.agents/skills`, then `~/.formicand/skills`, `~/.agents/skills`, then the skills bundled with Formicand. The first source to hold a name wins; the rest are shadowed.

## Frontmatter and invocation

Every skill in Formicand is **model-invoked**: its `name` and `description` sit in the catalog every Agent sees, and the user reaches any skill by typing `/name` in the composer, which asks Main to load it. A skill without a `description`, or with `disable-model-invocation: true`, is left out of Formicand entirely, so give every skill a description and leave that flag out.

The description is the skill's top-level context pointer, forced to stay loaded at all times: permanent context load in exchange for discoverability. Write it model-facing, carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full). A skill whose content is all reference is also one home for shared reference: another skill loads it by name, so reference needed by several skills lives in one place.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## The router

Formicand's router skill is `task-routing`, loaded at the start of every task: it names the other skills and when to reach for each. When a new skill belongs to a flow, add it there at the step it serves, so Agents reach it in order rather than by its description alone.
