# A full tidy

Read every document and decide each one's fate:

| What it is                  | Action                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| current product docs        | keep and register                                                                        |
| stale                       | rewrite to the present, or delete                                                        |
| reasons behind past choices | decisions still valid and hard to reverse become ADRs (domain-modeling); delete the rest |
| terms                       | merge into `GLOSSARY.md`                                                                 |
| notes for agents            | merge into `AGENTS.md`                                                                   |
| plans, progress, handoffs   | delete                                                                                   |
| traps and lessons           | leave to the retro; do not rewrite them                                                  |
| generated                   | register as generated                                                                    |

Classify the `unsorted` rows too. Ask the user only about documents you cannot place, and about which old decisions still hold.

For every document deleted, add a row to the "已删除文档" table in `docs/adr-history.md`: what it was in one line, where its open items went, and `git show <base commit>:<path>` to read it. Delete it and add its row in the same commit.
