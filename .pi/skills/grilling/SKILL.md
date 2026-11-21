---
name: grilling
description: The interview primitive - rounds of numbered questions with recommended answers until you share an understanding of a plan, decision or idea. In a project, grill-with-docs runs it and also records terms and decisions; use it directly when there is nothing to record into, or when the user asks to be grilled.
---

<!-- Adapted from mattpocock/skills (MIT), skills/productivity/grilling at abeeaf9. Changes: questions go through askhuman; an unanswered round proceeds on the recommended answers. -->

Interview the user until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, in a single `askhuman` call: number each question in `question` and give your recommended answer under it, like so:

```
Q1 <question title>: <question body, might include multiple choices>
→ <your recommended answer>

Q2 <question title>: <question body>
→ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer, and say that replying "yes" accepts them all. Then wait for the answers before the next round.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (files, code, commands), look it up yourself or delegate it to a collaborator; don't ask the user for anything you could look up. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the result; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

Scale the interview to what is missing. A request that already settles the goal, scope and acceptance needs no round at all.

If a round goes unanswered (`askhuman` times out, or no one can answer in this conversation), take your recommended answers as the decisions, keep going, and list each one you took in the confirmation you ask for next or in your final reply, so the user can correct it.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding, or, unanswered, until you have recorded the answers you took.
