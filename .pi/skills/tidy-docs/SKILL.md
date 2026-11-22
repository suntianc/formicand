---
name: tidy-docs
description: Keep a project's documents in order through the registry table in its AGENTS.md. Use when a final review refuses for the registry, when a ledger tidy asks about the documents, or when the user asks to tidy, sort or clean up the project's documents.
---

# Tidy docs

The registry is a table under a `## 文档` heading in the project's root `AGENTS.md`: one row per path, with its type and domain. A path is a file or a directory that covers the files below it; a file belongs to the first row that covers it, so put specific rows first.

```
| 路径 | 类型 | 领域 |
| --- | --- | --- |
| docs/adr | adr | global |
| docs/api.md | product | api |
```

| Type         | Holds                                 | Read when                                               |
| ------------ | ------------------------------------- | ------------------------------------------------------- |
| instructions | instructions for agents               | every session                                           |
| standards    | how code is written                   | writing or reviewing code                               |
| glossary     | the project's terms                   | naming things                                           |
| adr          | decisions in force, `docs/adr/`       | a change touches their area                             |
| history      | `docs/adr-history.md`                 | superseding or tracing a decision                       |
| pitfalls     | `docs/pitfalls/`                      | starting work                                           |
| product      | README, user, API and operations docs | a change touches their domain; they must match the code |
| generated    | generated or vendored files           | never; not edited by hand                               |
| unsorted     | not classified yet                    | until the next full tidy                                |

- Domain is a term from `GLOSSARY.md`, or `global`.
- instructions, standards, glossary and product: one document per domain. Merge another into it instead of adding beside it.
- Plans, progress notes and handoffs live in the development records, never in the repository: delete them.
- The root `AGENTS.md` and `CLAUDE.md`, and `docs/pitfalls/`, count as registered without a row.

## When a final review refuses for the registry

On the full route the program checks the registry before the final review, as Workloop does; quick and direct changes are not checked. Fix it with a fix ticket, then freeze the final review again.

- **No registry yet**: build it. Register every document in the repository; classify each by its path and first lines, and mark what you cannot place `unsorted`. Change and delete nothing else.
- **Unregistered**: for each document the requirement added, delete it if it is a process document, else add a row.
- **Stale row**: point it at the document's new path, or delete it.
- **Same type and domain twice**: give one its own domain if it is really another, else merge the documents as rework.

## At a ledger tidy

`tidy` lists what each development since the last tidy changed. From those changes and the registry, pick the documents they could have outdated, mostly product and instructions, and read only those against the code. `finish_tidy` takes `documents.update` (each path and why) or `documents.unchanged` (why none fell behind). Updates become one development; make each document match the code as it is now.

## A full tidy, when the user asks

One ordinary development, reviewed like any other: follow [FULL-TIDY.md](FULL-TIDY.md).
