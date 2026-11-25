---
name: code-review
description: Review a candidate change along two axes, Spec (does it do what the ticket or requirement asked?) and Standards (does it follow the project's documented rules and stay clean?). Use as a Reviewer of a frozen candidate, or to review your own change before handing it over.
---

<!-- Adapted from mattpocock/skills (MIT), skills/engineering/code-review at abeeaf9. Changes: the program or your brief supplies the change and the criteria; both axes run in this one session; findings follow Formicand's blocking rules, submitted by a Reviewer and fixed by the author in a self-review. -->

Two-axis review of a candidate change:

- **Spec**: does the code faithfully implement the ticket or requirement in your brief?
- **Standards**: does the code conform to this project's documented rules, and is it free of obvious smells?

Run the two axes one after the other and keep their notes apart, so one does not colour the other. Then act on both together (step 4).

You run it in one of two ways: as an independent **Reviewer** of a frozen candidate, or as the **author** reviewing your own change before handing it over (the last step of `implement`).

## 1. Pin the change

As a Reviewer, your checkout holds the frozen candidate and the brief or task names what it is compared with; if it does not, ask Main with `ask_main`. As the author, compare with the commit your work started from. Capture the diff once (`git diff <base>...HEAD`, three-dot) and the commit list (`git log <base>..HEAD --oneline`). If the base does not resolve or the diff is empty, report that instead of reviewing.

## 2. Spec axis

The brief is the spec: its acceptance criteria (AC1…) or completion criteria (CC1…), "Keep working" and "Not in this change". Older specs, plans or notes in the repository are history, not requirements.

- Re-run every acceptance command the brief names, in your checkout. The Executor's report is a claim; what the command prints is the evidence. Check the criteria without a command by reading the tree or running what they name.
- Report (a) criteria that are missing, partial or wrong, quoting the criterion; (b) behaviour the brief did not ask for (scope creep); (c) behaviour under "Keep working" that broke.

## 3. Standards axis

Find every file that documents how this project's code is written: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, a `GLOSSARY.md` for names, ADRs in `docs/adr/` in the area the change touches. Skip what tooling already enforces.

On top of what the project documents, check the **smell baseline**: Fowler code smells (_Refactoring_, ch.3). A documented project rule always wins; where it endorses something the baseline would flag, drop the smell. Each smell is a judgement call ("possible Feature Envy"), never a hard violation.

- **Mysterious Name**: a name that doesn't reveal what it does or holds. → rename it.
- **Duplicated Code**: the same logic shape in more than one hunk or file. → extract the shared shape.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move it onto that data.
- **Data Clumps**: the same few fields or params travelling together. → bundle them into one type.
- **Primitive Obsession**: a primitive standing in for a domain concept. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurring. → polymorphism, or one shared map.
- **Shotgun Surgery**: one logical change forcing scattered edits across many files. → gather what changes together.
- **Divergent Change**: one module edited for several unrelated reasons. → split it.
- **Speculative Generality**: abstraction, parameters or hooks for needs the brief doesn't have. → inline it back.
- **Message Chains**: long `a.b().c().d()` navigation. → hide the walk behind one method.
- **Middle Man**: a function or class that mostly delegates onward. → call the real target.
- **Refused Bequest**: an implementer that ignores most of what it inherits. → use composition.

## 4. Classify and act

Each finding has a title, a location (`path:line`), evidence (the command and what it printed, or the quoted code and criterion) and whether it blocks.

- **Blocking**, with its basis: a Spec finding cites the criterion id it violates; broken "Keep working" behaviour is `regression`; lost or corrupted data is `data_loss`; a security hole is `security`; a breach of a documented project rule or an ADR is `project_rule`.
- **Not blocking**: every smell, every other design or style preference, extra tests or features nobody asked for. Write them as suggestions; they reach the user's report and block nothing.

As a **Reviewer**, hand the result back with `submit_review`: `pass` when nothing blocks, `changes_requested` when something does, the Spec findings first. On a re-review, follow the brief instead: answer each previous finding, re-run the acceptance commands, and look only for floor problems in the files changed this round.

As the **author**, fix every blocking finding inside your scope and run the checks again; a blocking finding you cannot fix inside the scope goes to whoever gave you the work. List the suggestions in your report and leave them undone.
