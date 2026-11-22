# Runtime reference

[简体中文](../runtime-reference.md) | English

This page maintains runtime contracts for tools, delegation, recovery and parking. See [configuration reference](configuration-reference.md) for models and budgets, [data layout](../task-workspace-layout.md) for stored files, and [Product API](../product-api.md) for HTTP fields.

## Conversations and messages

The project folder supplies file and command operations; history and recovery data live in user data storage. Changing the project folder does not move history or external files. Existing absolute paths and document bindings retain their locations. See [project ownership](../task-workspace-layout.md#项目与会话归属) for path contracts.

App/Web persist text, attachments and edit drafts separately by project or conversation. Ordinary messages submitted during execution queue; steering instructions enter at the next model call, after the current call or tool finishes. An interrupt ends only the current turn and keeps the session, drafts, file changes already made and running Subagents; closing the session is what stops the process and cancels its delegations.

Main is resident: one Run is served by one Pi process, a finished turn leaves it running, and later user messages and callbacks arrive through its durable Inbox and start the next turn. It exits only when the session is closed, when it has been idle long enough (5 minutes by default, `mainIdleTimeoutMs`) and when a model request cannot continue; a working Subagent keeps it alive. The settled-turn boundary writes the Run's terminal record (`main.run_completed`, or `main.run_waiting` while work items are still open), so a turn settles while its process lives and a reader does not wait for an exit. An idle exit keeps the session file and Task state, and the next message or callback starts the same session again. A backend restart does not end Main: the new backend adopts the process still running.

Each turn re-reads the model configuration saved on this host — connection, protocol, model, output limit, context window and image capability — together with the thinking level the message itself chose. All of them take effect at the turn boundary without restarting the process, and the connection and protocol may change too: the same Pi session continues, keeping its history and tool results, while images in that history become Pi's placeholder when the model cannot see them. A connection fixed at launch by the environment, by a one-off selection (`profileId`/`model`) or by a failed-request replay stays fixed: it belongs to that process or request, not to the saved defaults. An explicit thinking level belongs to the message that opens its turn: a message queued later that rewrites the Run's input record does not replace it, and a message steered into a turn already in flight leaves that turn's level unchanged — a level applies when a message opens a turn of its own.

An external slot is held per turn and per delegation: a Main occupies it while a turn is in flight, or while it has unfinished delegated work (including a callback that has not reached it). When the turn settles and no delegated work is left, the slot is released at that boundary and the process stays; the next message is admitted again before it is delivered, and an idle Main is never killed to free a place. A paused Main keeps its slot while delegated work is unfinished, and the resume is delivered to the same process; once nothing is left to run the slot is released, and a later resume is admitted as a new demand, waits in the queue when the budget is full, and is started by the backend once a slot frees.

Pause is not stop: the request is written to the Task record, and Main reads it after the current tool call or model reply and before the next tool call or model request. The process and session stay, and the workspace, candidates and requirement records are preserved. Work that arrives during the pause stays durable in the Inbox until the resume; a boundary that completed the Task stays `completed`. Continuing uses the same Run, process and Pi session, keeps completed tool results and does not repeat finished steps; a paused Main with no Subagent working still follows the idle clock. Cancelling (closing the session) from `paused` follows the existing terminal cleanup for unfinished delegations and background work.

Editing the latest accepted message runs again from the preceding conversation history with the new input. It does not undo earlier file changes or external actions. See [request retry and context recovery](#request-retry-and-context-recovery) for exact replay of failed requests.

## Pi version and rollback

Main, subagents and session files all run on Pi. `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` stay on one version, currently 1.5.2. Pi writes session files verbatim under `sessions/` (see [data layout](../task-workspace-layout.md)); CoworkOS applies no format conversion of its own.

### Reading sessions in both directions

0.87.1 and 1.5.2 both write v3 session files. `test/p46-session-compat-pi.test.js` measures both directions with real Pi processes that load the real Main extension and a recorded local provider:

| Direction                                      | Measured result                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Written by 0.87.1, read and continued by 1.5.2 | It continues. The model receives the complete history: `system → user → assistant(toolCall) → toolResult → assistant → user`; the tool call ID matches its result, the result text is unchanged, earlier user messages keep their text, and the continuation appends to the same session file.                                                                                             |
| Written by 1.5.2, read and continued by 0.87.1 | It continues with the same complete history. The assistant field `thinkingLevel`, which only 1.5.2 writes, is not part of 0.87.1's message type and is ignored on read; system-message fields such as `toolsRemoved` are declared and handled by both versions. 0.87.1's session projection maps entry types it does not know to empty entries and does not break the surrounding history. |

Both runs confirm Main's system prompt injection (`<current_workspace>`) is present. The test covers an ordinary Main conversation (system prompt, user/assistant messages, tool call and result); compaction, branch and custom-message entries were not measured one by one. The test installs 0.87.1 from the local npm cache into a temporary directory, so project dependencies do not change; when the cache is missing it skips with a stated reason, and a skip is not evidence of compatibility.

### Rolling back to 0.87.1

Downgrading the three packages is not enough to start: the upgraded launcher passes `--no-mcp`, which only 1.x accepts, and 0.87.1 exits with `Error: Unknown option: --no-mcp`; `scripts/cli-ui-policy.json` and `scripts/cli-shell-policy.json` pin 1.5.2 bundle hashes; and the source now imports `Type` from the direct `typebox` dependency. The rollback therefore reverts the whole upgrade commit `4e5bde0` ("升级 Pi 运行时到 1.5.2（行为不变）"), restoring the 0.87.1 dependencies, launch arguments and UI policy together:

```sh
# Stop App/CLI, Main, workers and the guardian first so running processes cannot keep writing sessions.
cd <repository root>
git status --short                     # the worktree must be clean
git switch -c rollback/pi-0.87.1       # keep the current branch
git revert --no-edit 4e5bde0
npm ci
npm run build:cli
npm run build:web-assets
npm run verify
```

For a packaged CLI/App install, reinstall the 0.87.1 package; installing and uninstalling do not touch `sessions/` in the user data directory, so existing sessions are available immediately after the rollback.

Handling sessions after the rollback:

- Main sessions that 1.5.x wrote during the upgrade continue as the table above says; no conversion or rewriting of the session file is needed, and editing the session JSONL by hand to make it "work" is not supported.
- If a session cannot be opened or continued by 0.87.1 (for example because it uses an entry 0.87.1 does not have), keep the original file and back it up first, preserve evidence with `coworkos session export <session-id-or-path> --format json --output audit.json`, then start a new session and restate the still-active objective and finished results in its first message. See [request retry and context recovery](#request-retry-and-context-recovery) for recovery entry points.
- On a later upgrade, sessions written by 0.87.1 still continue under 1.5.x (the first row above), but the upgrade commit reintroduces the launch arguments and UI policy described here, so changing only the versions in `package.json` is not enough.

## Input formats

### Mathematical formulas

Web/App support inline `\(...\)` and `$...$`, and display math with `\[...\]` and `$$...$$`. Code and unsupported formulas retain their source. The terminal does not render formulas.

## General and optional tools

Terminal and App Main share the Cowork extension and capability rules; a delegated agent gets the same extension with its tools narrowed by role. Coordinator accepts an external `capabilityProvider`.

`enable_tools({})` discovers groups; `enable_tools({groups:["attachments"]})` loads attachment readers and `delivery` publishes artifacts. Explicit loading survives Main Run recovery. Attachments and granted jobs can also enable tools through context. Loading does not grant permission: jobs still require `longRunning`, and computer actions check authorization on every call.

Browser/CUA objects belong to the current Pi session and are cleared on exit or session change. Restoring groups does not restore pages or script objects. Ordinary subagents do not inherit them automatically. See [Browser Use](../browser-use.md), [Computer Use](../computer-use.md) and [CUA scripting](../cua-scripting.md).

Main and delegated agents both use Pi's native `bash` and file tools. The default working directory is the selected project (a delegated agent uses its own work site). There is no second `run_command` / `run_tests` tool and no programmatic tool factory. Work that must outlive one tool call uses `start_job` and `check_job`. Stopping Main's current turn does not cancel delegated agents; use `cancel_subagent` explicitly.

### MCP servers

There is one MCP configuration, `~/.atria/mcp.json` (the `mcpServers` format other clients use), shared by every project and unreadable to agents. Main keeps Pi's built-in MCP client, but servers reach it only through the extension ([MCP registration](../../.pi/runtime/mcp.ts)): enabled servers are registered at startup, and each turn re-reads the file, registering new or changed servers and dropping removed or disabled ones; a file that cannot be read keeps the current servers and is reported once. Pi's own `mcp.json` stays empty, and Main and delegated processes start with `--no-approve`, so a project's `.pi/mcp.json`, settings and extensions are not loaded. Three exposures exist: `deferred` (the default; declared to the model once `tool_search` finds it), `direct` and `hidden`, with per-tool overrides; CoworkOS does not enable codemode and refuses that exposure. The built-in Executor and Reviewer still start with `--no-mcp` and use no server.

Settings → MCP checks connections, lists tools and signs in with Pi's own `pi mcp list --json` and `pi mcp login`: for each operation the backend creates a temporary folder under `~/.atria/runtime/mcp-probe/` holding only the servers involved (removed afterwards), and that folder is trusted in Pi's `trust.json`. Sign-in credentials go to `mcp-auth.json` in Pi's folder, keyed by server name and URL, so Main uses them when it connects to the same server.

### Custom Agents

A custom Agent is a Markdown file ([definition and validation](../../src/runtime/agent-definitions.ts)): the header holds `name`, the `description` Main reads, `permission` (`write` or `read`) and optionally `profile`/`model`, `tools`, `skills`, `mcp` and `enabled`; the body is extra prompt text. Global ones live in `~/.atria/agents/`, a project's in `.atria/agents/` (read only once the project is trusted), and the project's wins on a name clash; `executor` and `reviewer` are the built-in names.

Rules the code holds: `read` cannot have `edit` or `write`; the only tools to choose from are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `browse_workspace`, `search` and `visit`, so Main's own tools and desktop or browser control are never given; `ask_main` and `send_peer_message` are always held; no `skills` means every skill, an empty list means none; no `mcp` means no server.

When the user's project keeps a pitfalls index at `docs/pitfalls/README.md`, the program tells an agent once, when its work starts, to read it; the index never goes into a system prompt. Main gets a `pitfalls` field in the result of `project_development create`, which opens the requirement's checkout; Executor and Reviewer get it in their first task message, judged by their own checkout (a rework continuation is not told again). The hint says to open only the entries whose trigger matches the work, and that the code wins where an entry disagrees. See [the code](../../src/runtime/project-pitfalls.ts).

Each turn Main sees the enabled, valid Agents in `<custom_agents>` and delegates with the `agent` parameter of `call_subagent`. The backend resolves the definition at dispatch and stores it on the work item (later edits do not change it), recording `call.agent_selected` (name, source, permission, model source); a missing, switched-off or broken Agent is an error naming it, never a different Agent. `write` runs as an Executor in its own checkout; `read` runs in a Reviewer-style checkout without a review form and answers in text. The process sets its tools from the definition, filters the skill catalog, registers only the listed MCP servers and adds the extra prompt after the role's. The sidebar and requirement panel show the Agent's name in place of the role.

Main lists, creates, changes, switches off or on Agents with `manage_agent` ([tool](../../.pi/runtime/tools/agents.ts)). Before each write it hands the full definition to the user as a question carrying a `proposal`: the conversation shows a definition card and the file is written only when the user confirms. Rejecting, typing changes, choosing "Edit in settings" or a timeout writes nothing; "Edit in settings" opens the Agent page with that draft. Main can name configured MCP servers but cannot add one, and cannot write project Agents for an untrusted project. "Ask Main to write it" on the Agent page starts a conversation with the request in the composer.

Settings → Agent has a global and a project page ([routes](../../src/dashboard/agent-routes.ts)) to create, copy, edit, switch on or off and delete Agents, marking those that name missing or switched-off skills or MCP servers. The first time the work view opens a project with `.atria/agents`, `.atria/skills` or `.agents/skills`, it asks whether to trust it ([prompt](../../web/assets/controllers/project-trust-prompt.js)), reading only names to ask.

### Composer `/` and `@`

Typing `/` in the composer lists skills, prompt templates and commands; `@` searches project files, custom Agents and MCP resources ([menu](../../web/assets/controllers/composer-menu.js), lists from the [composer service](../../src/dashboard/composer-service.ts)). The skills are the ones Main sees. Prompt templates are Markdown files in `~/.atria/prompts/` and the project's `.atria/prompts/`, the project's winning on a name clash, and a chosen one becomes editable text. Files follow `.gitignore` in a Git repository and otherwise come from walking the folder, skipping `node_modules` and the like. MCP resources come from the backend connecting to enabled servers; `ui://` interfaces are left out, and servers that need sign-in or take a value from a `!command` list none.

A chosen skill, file, Agent or resource leaves `/name`, `@path`, `@agent-name` or `@server:uri` in the message, and the page turns these words into references sent with the request when sending, steering a running turn or editing a message. The backend keeps only references that resolve (a skill in the catalog, an existing file inside the project, an enabled server) and puts an `<atria_references>` manifest in front of the message ([format](../../src/runtime/composer-references.ts)) with how to use each kind; a skill appears by name only, and Main loads it with `load_skill`. The conversation hides the manifest and marks the words as chips.

## Delegated attachments

Ordinary `call_subagent({task})` remains supported. Attachments and desktop authorization are not all inherited. Share the required scope explicitly:

```javascript
call_subagent({
  task: "Check assembly parts and motion parameters; return evidence",
  attachments: ["explicitly-shared-upload-id"]
});
```

Attachment readers accept only shared IDs; an attachment Main can read does not automatically reach a subagent. A successful subagent or its summary does not replace Main's own verification.

### Dispatch through the backend

`call_subagent` only registers a work item with the backend: the backend writes it into that Run's durable queue and answers with the `callId`, then launches a separate subagent Pi process once its dependencies allow and projects the process's conclusion back into the queue, the Run events and Main's callback. Delegation is always asynchronous: the call returns once the registration is durable and the result arrives by callback. When the result is needed within the turn, `wait_for_subagents` waits for it, and a Subagent's question or a message from the user ends that wait early. `wait_for_subagents`, `get_subagent_status` and `get_task_status` read the same queue, callback and result records and never ask the backend for in-memory state.

One owner per workspace root launches and settles delegated processes: while the Dashboard serves the root, the CLI worker takes no work (it reports the owner and exits), and adoption across restarts, starting queued items and settlement all belong to the owner. At startup the owner re-adopts the subagents still running from durable records and delivers the callbacks of those that ended while it was away; settlement is deduplicated by a file lock on the process record, so one work item never produces two callbacks. A refusal happens before any durable write and leaves no work item nobody settles; once an item is queued, a start failure is settled as that item's own failure.

The serving backend decides the site and candidate at dispatch: `developmentId` uses this backend's ready requirement checkout, and a Reviewer's `reviewSite` is pinned to the commit frozen by the requirement's open review (or to the dispatch-time commit when no review is frozen yet), so advancing the Executor's checkout after the freeze cannot move the Reviewer's subject. Work-item site, session directory and conclusion are durable, and a rework continues the same Executor's Pi session file (`sessions/<agentId>/pi/<original callId>`) and checkout, appending one turn. Attachment grants travel with the item: the delegated IDs are checked at dispatch, and the delegated process registers `read_attachment` only when one was granted.
A backend restart preserves these records: Main's local credential lives in the data root beside the backend identity, so an adopted Main keeps reaching the new backend process, and subagents outlive the backend like Main does. A CLI run with no Dashboard gets the same backend assembled by its CLI host, exposed on a loopback route scoped to that Task; its subagents are separate Pi processes, and `call_subagent` has no in-process fallback.

### Execution roles, work-item dependencies and the requirement checkout

A delegation runs as `executor` by default; use `role: "reviewer"` for an independent review session. Both roles read the execution host's role configuration when the work item is about to start — after its prerequisites and immediately before the session exists: an explicit `profileId`/`model` wins, then the host default; with none of them the item keeps the launching Main Run's connection, so ordinary `call_subagent({task,mode})` behaves as before. The selection is recorded as a non-sensitive snapshot in `call.model_selected` only when the item really starts: a binding edited while it is queued decides that start, and a deleted reference ends it with an error naming the role and connection id instead of using another account. A started request keeps its connection, and later changes only affect later starts. Keys stay on the execution host and never enter work-item records, callbacks or interface responses.

`dependsOn: ["<callId>", …]` names prerequisites. Until all of them are terminal the item stays queued (shown as waiting for a prerequisite) without starting a process or requesting the model; it continues once they finish, and a failed or cancelled prerequisite ends it unexecuted with the reason. Cancelling an item ends only that item — including one that is still waiting, which reports cancelled rather than queued — while other work items, Main and callbacks are unaffected. A restart restores dependencies and role requests from the durable queue; an item that cannot even be re-entered ends as failed with its reason kept, rather than being retried silently or dropped.

Passing `developmentId` runs the item in its own execution site for the requirement: a `git worktree` and branch forked from this backend's ready development checkout at its current commit (under `work-items/<callId>` beside that checkout), used as the Subagent's project directory. Parallel items neither see nor overwrite each other, the requirement's integration checkout or the user's working tree; a checkout that is not ready is refused with a prompt to run `ensure_workspace` first. With `ticketId` as well, the program writes the confirmed ticket's scope, acceptance criteria, what must keep working and what is out of scope ahead of the task and records the call on the ticket; on the direct and full routes each ticket is frozen and reviewed in the Executor's own checkout (the freeze checks that no change leaves the ticket's scope), and `integrate_ticket` brings a passed ticket into the integration checkout and runs the project's checks with its acceptance commands. On the quick route Main collects results into the integration checkout with its existing file/Git tools; to review a collected result, delegate the Reviewer afterwards so its site forks from the new committed state. Retries, restart recovery and rework reuse the same directory and branch, keeping their commits and files — never rebuilding or resetting them. `get_subagent_status` and Task detail report each item's callId, name, role, model, actual working directory, dependencies, blocked state and failure reason; the interface renders the role, model and isolated site from them.

`continueCallId` (optionally with `reviewId`) is the original-context rework contract: it must name a finished Executor work item in this Run, reuses that item's agent identity, Pi session file and checkout, and appends the rework instruction as the next turn of the same session (a call with no earlier session record is refused) — never a fresh Agent or a repeat of work that already finished. A running item, a Reviewer, an item whose continuation is already in flight, or an item without a resumable checkout is refused; restart recovery re-enters the same continuation record. The `project_development` review actions record the candidate commit and tree, the Reviewer identity and site, findings, rulings and the rework linkage as shared facts; a changed candidate commit or reviewed content is never treated as an approval of the current candidate. Findings of a failed or drifted review stay rulable and reworkable, a passing review settles verified repairs along the explicit previousReview chain without touching findings outside it, and a `self` plan's checks are bound to the commit/tree they ran on, so a moved checkout needs verification on the new version. See the Product API review section for the full surface. `request_merge` applies an accepted requirement candidate at the shared project entry, where the configured execution backend updates the target branch one operation at a time; if the target moved while the request waited, the checks run again on the combined target-plus-candidate version. `apply_merge` is that backend's reconciliation and queue step, and `merge_status` reads operations, the actual merge commit and the idempotent receipt; a failure only touches the operation's own site and keeps the user's dirty files, earlier merges and unmerged branches. The request also carries `ledger`: the new summary or why it stays, one history line, and a new description when the feature changed a lot, else that it stays. After a real merge the program records the ledger/board delivery automatically and writes that summary, history line and description to the requirement; a merge that never lands leaves the ledger unchanged. On the `full` route, as in Workloop, the final review's freeze first checks the document registry in the requirement checkout's root `AGENTS.md`: it is refused with no table, with a document this requirement added left unregistered, with a row covering no document, or with two documents of one single type and domain (with a table at the base, only problems this requirement brought count), and a fix ticket repairs it; `quick` and `direct` are not checked. A finished ledger tidy's `finish_tidy` must say which documents fell behind the code, or why none did. An external need becomes pending release with its owner and actual merge commit, while an internal need stays ledger-only. `delivery_status` reads the phase, collaborator progress, the diff frozen to the delivered version, checks and the synchronization receipt; while the shared service is unreachable the execution host keeps the local pending fact and a bounded retry completes it after recovery without redoing development or the merge.

### Role tool sets and the review conclusion

A delegated process loads the same extension as Main but declares its tools by role. The Executor has `read`, `bash`, `edit`, `write`, read-only `browse_workspace`, `ask_main`, `send_peer_message` and `search`/`visit`; the Reviewer has `read`, `bash`, `grep`, `find`, `ls`, `browse_workspace`, the same two channels, `search`/`visit` and `submit_review`, and no `write`/`edit`. `search`/`visit` are Main's implementation over Main's configuration: they are registered unless search is switched off, and `COWORK_WEB_TOOLS=0` or `provider: "off"` leaves both roles declaring neither. Both roles can use `load_skill`, the same implementation as Main over the same skill catalog; it loads instructions only and grants no new tool or permission. The [skill catalog](../../src/runtime/skill-registry.ts) reads, highest priority first, the project's `.atria/skills/`, the project's `.agents/skills/` (from the project folder up to the repository root), `~/.atria/skills/`, `~/.agents/skills/` and the bundled `.pi/skills/`; a name found earlier wins. The two project sources are read only after the user trusts that project (recorded in `~/.atria/project-trust.json`), and a skill removed from the index (`~/.atria/skill-index.json`) leaves the catalog while its files stay. Pi's own skill discovery is switched off with `--no-skills`, so Main's and a Subagent's system prompts and `load_skill` use one catalog; the prompt lists skill names and descriptions without file paths, and every skill is loaded with `load_skill`. a Subagent judges trust by the original project folder, not its isolated copy. The backend creates a detached checkout of the reviewed candidate commit as the Reviewer's project directory; a successful review keeps that site, because Main binds the review and checks the candidate for drift only after the process is over; an attempt that produced no conclusion is cleaned at once, a drifted review releases its site with the drift, and a merged requirement releases all of its review checkouts while the record keeps the Reviewer identity and the path it used. Without a requirement site the candidate is frozen at the dispatch-time HEAD and copied the same way, and a project that is not a Git repository is refused before dispatch. The tests it runs and the files it writes stay in that copy and never reach the candidate commit, the Executor's checkout or the user's working tree. Neither role has `call_subagent`, `send_subagent_message`, `cancel_subagent`, `get_subagent_status`, `wait_for_subagents`, `get_task_status`, `finish_task`, `askhuman`, `sleep_until`, `grant_capabilities`, `enable_tools`, `project_ledger`, `project_development` or `publish_artifact`, so a Subagent cannot delegate again or change the Task lifecycle. Role text is the same wording every delegation path uses; a role only decides tools and grants nothing extra: computer, browser and CUA tools are registered by Main's extension and are not offered to a delegated process yet. Attachment grants travel with the work item, so only an authorized upload ID makes a delegated process register `read_attachment`. Main and both roles block writes to protected paths through `write`, `edit` and `bash` under one rule and return one refusal text; shell targets follow `cd`, `pushd`/`popd`, `git -C` and subshell directory changes, and a directory that cannot be resolved conservatively refuses a relative write while any protected path exists in the project. Shell recognition is best-effort, not a sandbox: writes from inside an interpreter, quoted command substitution, backticks, `xargs`, `find -delete`, `git clean`, a directory target such as `git restore .` or `git checkout .`, and archives unpacked by `tar` or `unzip` can still get through. Any tool call by Main or either role whose arguments name CoworkOS's own data home (`ATRIA_HOME`, `~/.atria` by default) is refused whole, for reading, listing and writing alike; only the task workspaces `workspace/`, requirement checkouts `runtime/development-workspaces/`, temporary workspaces `runtime/temporary-workspaces/` and installed skills `skills/` stay reachable; installed skills are still protected from `write`, `edit` and `bash` writes. CoworkOS's own file names such as `backend-instance.json` or `project-data.sqlite` are refused anywhere in the arguments, so a relative path climbing out of an allowed directory is caught too. The rule answers a Main that read the backend's host credential to work around a missing merge configuration; it is not a sandbox either, a path built at run time is not seen, and OS-level isolation for outside work comes with P5. Like Main, a delegated process answers `cache_warming_decision` with `stop` and does not warm the prompt cache. Delegated sessions use the same context management and history tools as Main.
A Reviewer's conclusion is submitted only through `submit_review({verdict, findings, previousFindings?})`: `verdict` is `pass` or `changes_requested`, and every finding states its `title`, `location`, `evidence` and `blocking`; a blocking one also names its `basis`, a criterion id of this review (a ticket's `AC1`…, the whole requirement's completion criteria `CC1`…) or one of the floor classes `regression`, `data_loss`, `security`, `project_rule`, and a non-blocking one is a suggestion. A re-review answers in `previousFindings` whether each finding the previous round asked to fix is fixed, and its new findings must block, on a criterion or on a floor problem in a file this round changed. `changes_requested` needs a blocking finding or an unfixed previous one, and `pass` carries neither. The citable ids, the previous round's findings and this round's changed files are fixed when the candidate is frozen and passed to the Reviewer process with the dispatch (`COWORK_REVIEW_SCOPE`); the backend checks the same rules again when it imports the conclusion; a malformed submission is a tool error the model can correct and retry. The conclusion is written to the work item's result record under `review` and reaches Main with the callback; a Reviewer that ends without submitting one is recorded as failed, and the backend re-checks the same format when it reads the record. Verify [real role tool tables and conclusion](../../test/subagent-roles-pi.test.js).

An Executor dispatched with a ticket also holds `submit_report({criteria})`: one entry per acceptance criterion of the ticket, with `criterionId`, `met` and `evidence`; the ids travel with the dispatch (`COWORK_TICKET_CRITERIA`), and a missing, repeated or unknown id is a tool error. The report is written to the result record under `report`, re-checked by the backend under the same rules and appended to the Executor's hand-back for Main; an Executor that ends without one is recorded as failed. In both roles' `bash`, stopping processes by name (`pkill`, `killall`, or `kill` fed by `pgrep`/`pidof`) is refused, because it also reaches the user's own app and services; stopping a PID the process kept when it started it is unaffected. Verify [the ticket report and kill-by-name refusal](../../test/subagent-roles-pi.test.js) and [the rule unit tests](../../test/executor-rules.test.js).

### A delegated process's durable Inbox and guidance

Guidance Main sends to a running Subagent, the answer to its `ask_main` question and a peer message are all written first to that Subagent's own durable Inbox (`runs/<runId>/agents/subagents/<id>/inbox-store.json`). The extension inside the process reads it at a safe turn boundary and feeds it as the next turn's input. Messages never travel over standard input, and delivery does not require the backend to still be running: a backend restart, or work continuing while it is down, does not lose them.

An idle process is woken by the writer: the process registers a local endpoint in its durable process record, and whoever writes the Inbox or an `ask_main` answer nudges that endpoint after the durable write, so the woken process re-reads the whole Inbox or question record without trusting the notification; a writer whose endpoint is unreachable (the process exited, a socket file was left behind) skips silently. A blocking `ask_main` subscribes to the same nudge. A file watch remains a fallback and nothing polls; it also re-reads the whole Inbox at every turn end before the turn continues, so a watch event that arrives late, is coalesced, or misses the process entirely only costs promptness, not the message. A message is leased to that process and recorded as consumed only once it appears in the process's Pi session context, which also writes an `inbox.consumed` event; each message is read once. A message whose process exits before reading it stays durable and is delivered again by that agent's next process. `ask_main` still returns Main's answer as the result of the blocking tool rather than as ordinary guidance — Pi drains its steer queue only after the current turn's tool calls return, so a tool waiting on it would deadlock.

Verify with [real delegated delivery, questions and cancellation](../../test/p46-subagent-messages-pi.test.js).

### One-way Subagent peer messages

An active Subagent can call `send_peer_message({targetCallId, message, priority?})` to send a non-blocking message to another Subagent in the same Task/Run. Main must provide `targetCallId` in the delegated brief or later guidance. Messages are limited to 8,000 characters and are intended for short questions, corrections, findings, or file/artifact paths.

The message is persisted in the recipient's Inbox and injected at its next safe model turn. The tool returns only a queued result and never waits for a reply; the recipient may send another message independently. Missing or terminal calls are rejected. A peer message does not create nested delegation or a synchronous dependency; Main remains responsible for final acceptance and Task completion.

### Querying Task and delegation status

`get_task_status()` returns compact delegation identities, states, callback states and diagnostic paths by default. It omits repeated subtask briefs, result bodies, error bodies and output lists. `resultAvailable` means a persisted callback or diagnostic file exists; during a retry it may describe an earlier attempt, and does not establish completion or successful verification. `resultDelivered` is `true` only after callback consumption has been durably confirmed. A call with no callback record omits that field and uses `callbackState: "none"`.

To recover a specific asynchronous result, pass `get_task_status({resultCallIds:["<callId>"]})`. Only those calls include the stored callback body, error and output paths; other calls remain compact. Queries neither claim nor consume Inbox messages. Receive pending results through the existing callback or `wait_for_subagents`. `wait_for_subagents` delivers a settled callback as its tool result and acknowledges it with that result; it stays readable through `resultCallIds`, and diagnostic paths point to complete execution records.

### Partial progress after subagent interruption

When a subagent fails, times out or is cancelled, its result includes at most 6,000 characters of partial progress:

- The two latest visible statements;
- The six latest file changes with tool receipts;
- The four latest returned tool records;
- Up to two operations with unknown completion.

Command records retain exit codes and output excerpts from both ends. File bodies, patch content and reasoning are excluded, and no extra model request generates the handoff. Excerpts may omit earlier work and do not establish task or test completion. Inspect the effects of an operation with unknown completion before repeating it.

The result arrives through the existing Inbox. Diagnostic paths remain available for targeted inspection of full records when needed.

## Request retry and context recovery

Main and subagents default to at most five automatic retries after the first request. Main normally backs off for 2, 4, 8, 16 and 32 seconds while retaining explicit Pi settings. Subagents can override `maxErrorRetries`. Explicit missing-model, authentication, permission and exhausted-quota errors do not retry automatically. Connection tests request once. `COWORK_MAX_ATTEMPTS` is a separate delegation budget.

App/Web Retry resends the failed request's saved serialized body, including system messages, model, tool definitions, attachments and generation parameters, without adding a recovery instruction. Completed tool results are retained. New callbacks queue during replay and enter afterward; inputs and document changes absent from that body are not treated as already read.

A private snapshot is saved before transmission with the Pi version that wrote it, and checks the Task storage root and working folder. Changed settings or sources, damaged snapshots and snapshots without ownership records prevent exact replay while preserving the data. When the recorded version differs from the running runtime the retry continues the turn without replaying: Pi rebuilds the context from the session and the new snapshot states why. Older conversations without snapshots can continue only from saved context. Cancellation takes precedence; stale retry actions cannot revive a cancelled run. See [data layout](../task-workspace-layout.md) for formats and backup boundaries.

Recovery reads the Run's Pi session and run records; when the headless Run already ends with complete final text and has no unfinished tool call, it finishes persistence without another model request. A successful Run ID cannot be reused; new work needs a new Run. Lifecycle commands alone do not start model execution.

Explicit CLI `COWORK_TASK_ID` takes precedence over automatic association. Recovery rejects Tasks and conversations from different projects. For legacy sessions without an association, use `COWORK_TASK_ID=my-task coworkos --session <session-id-or-path>`; later recovery uses that association.

### Context windows and handoffs

Main and subagents use the same five levels of context management. The first three make no model request; a window change asks the model for one summary.

1. Tool text or structured output above 20,000 characters goes to `tool-results/` beside the Pi session. The model sees `Output too large (N KB). Full output saved to: <relative path>` and a 1,000-character head-and-tail preview. The result keeps the original in `details.archivedOutput` for the conversation view. Image blocks retain their native form. For nested calls the outer result is the unit of archiving.
2. At a turn boundary above 50% usage, Pi writes one batch of `context_edit` entries once it can reclaim an estimated 10% of the window. The latest five results, every `load_skill` and `askhuman` result, and the latest `project_development` result are protected. The placeholder is `[Old tool result content cleared]`; the tool call stays, and `search_history` and `read_history` retrieve the original.
3. The first boundary above 75% in each window adds the approximate remaining tokens and a reminder to save working notes.
4. Pi's threshold, `clear_context`, or the composer's `/compact` starts a new window. The model summarizes the window being left, and the program adds the records to form the handoff. The normal tail keeps at most eight visible entries and at most 2,000 estimated tokens, capped at 10% of the window, starting on a user or assistant entry. A command sent during a step applies at a boundary. The conversation shows only a divider; the handoff is never sent to the browser. The title bar shows usage, with the window number in its tooltip.
5. A context-length error asks for no summary and retries with a shorter handoff and an empty original tail. This includes the case where Pi has no native cut for the first input. The handoff is capped at 6,000 characters and may be smaller on a small model.

The handoff is at most 60,000 characters and never more than the window. It opens with a note on continuing, then the model's summary, the current development goal, criteria, route, ticket states and the current `next` from the development service, pending delegations and questions, session notes, and the user's messages. The summary request carries only the window being left, keeping its start and latest part when it does not fit, forbids tool calls, and keeps only the `<summary>` block. A failed, timed-out or empty summary leaves a note that there is none. Each record section has a cap and unused space goes to the user's messages, placed whole from the newest back; older ones that do not fit are counted, and an over-long newest message is named by entry ID and length. When Main is offline, `/compact` has the Dashboard ask Main's model for the summary. System instructions and the skill catalog are supplied through their normal prompt paths.

Use `session_notes` to read, append or rewrite session notes. Reopening the same Pi session retains the notes. Use `search_history` to search original user, assistant and custom messages and tool results, optionally filtering by role and tool name. Use `read_history` with a returned entry ID or the archive path shown in the result preview. A read returns up to 16,000 characters with zero-based offsets and an exclusive end, and can retrieve an image by number or select archived structured output.

## CLI exports and feedback

These exports need no model connection:

```sh
coworkos session export <session-id-or-path> --format json --output audit.json
coworkos session export <session-id-or-path> --format html --output conversation.html
# Compatible legacy offline HTML export.
coworkos --export /path/to/session.jsonl conversation.html
```

The session argument accepts a full ID, unique prefix or path. Existing files are preserved by default. Even `--force` cannot overwrite the source session or its links. Export validates branch references and preserves source and existing output on failure. JSON includes all branches; standalone HTML has no scripts or external resources. See the [export format](../task-workspace-layout.md#coworkos-会话导出格式).

The interactive terminal supports `/export [json|html] [path]`, `/share [path]` and `/bug [description]`. Sharing copies and feedback reports stay local without automatic upload. `/help` lists commands and `/changelog` shows updates. Diagnostics are available through `/coworkos-debug`, `ATRIA_DEBUG=1 coworkos` and `Ctrl+O`.

Model-request archives and private retry snapshots are separate. Archives contain user content, tool results and model responses. Although authentication headers are excluded, protect these as private data. Usage represents only fields reported by the service; missing values are not zero and cannot prove upstream cache behavior. Paths, formats and retention belong to [data layout](../task-workspace-layout.md).

## Tasks, workers and human questions

Installed CLI users can replace `npm run cli --` with `coworkos`. These examples use an isolated development workspace:

```sh
npm run cli -- task cancel <task-id> --workspace /tmp/atria-dev
npm run cli -- task resume <task-id> --workspace /tmp/atria-dev
```

`coworkos start` has no local service; its launcher assembles its own subagent backend, so no separate `single` command or in-process session entry exists.

While Main waits for human input, list and answer durable questions from the CLI:

```sh
npm run cli -- human list --workspace /tmp/atria-dev --task <task-id> --status pending
npm run cli -- human reply --workspace /tmp/atria-dev --task <task-id> --request <request-id> --answer "Confirmed answer"
```

Accepted answers are consumed once. Reply drafts are saved per Task and question through failed submission and navigation. Waiting and background callbacks share durable delivery; read-only status checks do not consume callback results.

Independent recovery requires the correct Task, Run, model connection and budget:

```sh
# Restore the subagent queue and check once.
npm run cli -- worker --workspace /tmp/atria-dev --task <task-id> --run <run-id> --once
# Restore Main Inbox.
npm run main-worker -- --workspace /tmp/atria-dev --task <task-id> --once true
# Report by default; --spawn true starts model processes.
npm run cli -- main-supervisor --workspace /tmp/atria-dev
npm run cli -- main-supervisor --workspace /tmp/atria-dev --spawn true
```

Task/Worker commands validate options before execution. Place task or answer text beginning with `-` after `--`. Help and version queries do not start supervisors.

## Parking and timed wakes

`sleep_until(reason, wakeInSeconds)` records that the current Task is waiting. The Task stays open across process restarts; when the time arrives the Main guardian writes one durable Inbox wake, and reading it clears the park. `wakeInSeconds` has a 60-second floor. A park without a due time is refused because no other scheduler could wake it. Ending a turn is not parking: without a park record and with no outstanding work, a Task is completed.

`COWORK_DISABLE_MAIN_GUARDIAN=1` turns the guardian off; `COWORK_MAIN_GUARDIAN_INTERVAL_MS` defaults to 60000. It reads only the Task, its Inbox, human questions and the park record, and starts a Main again for a Task with an unconsumed callback and no live Main.

## Shared tool contract

`load_skill` keeps complete instructions by default so required middle rules are not lost; an explicit budget can still limit it. `browse_workspace` reads the whole Task workspace, while writes and commands stay inside the agent's own site. There is no programmatic `PiSession` / `RunService.runPi` entry and no `createBuiltinTools`: Main uses the tools its extension registers, delegated agents use the same set narrowed by role, and both share Pi's context compaction.

`createWebTools` keeps its public contract. Without `provider: "exa"`, `visit` reads source text directly. Optional Jina Reader and extraction callbacks remain subject to total timeout and cancellation. Product Main search settings are in [web search](configuration.md#web-search). Model smoke and evaluation entry points are in [local testing](testing-local-run.md).
