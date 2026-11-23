---
name: implement
description: Implement a piece of work from a ticket, a requirement's criteria or a spec, test-first, and close it with a self-review. Use as an Executor on a delegated ticket, or as Main on a quick route.
---

<!-- Adapted from mattpocock/skills (MIT), skills/engineering/implement at abeeaf9. Changes: the work comes from the brief or the development record instead of an issue tracker; skills load with load_skill; the self-review runs even when an independent Reviewer follows. -->

Implement the work in your brief: the ticket with its scope, acceptance criteria, `preserve` and `outOfScope`, or, as Main on a quick route, the development record's goal and completion criteria. State the ticket's title, or the goal, before starting. If the brief is ambiguous in a way that changes what you build, ask whoever gave you the work (Main through `ask_main`, for a collaborator).

Load `tdd` with `load_skill` and build with it, at the seams the criteria observe. When the work is a bug fix, or a bug resists explanation, load `diagnosing-bugs` and follow it before you change the code.

Run type checking regularly, single test files regularly, and once at the end the tests of every module your change touches; the whole suite only when you change something all modules depend on, such as shared models, migrations, dependency locks or build configuration. Run every acceptance command the brief names and keep what it printed: that is your evidence.

Once done, load `code-review` and review your own change with it, as a self-review. Fix what it finds that blocks; list its suggestions in your report rather than acting on them. An independent Reviewer may still review the change after you; the self-review is what you hand over, not a replacement for it.

Commit your work to the current branch, leaving nothing staged or untracked. Stay inside the brief's scope.
