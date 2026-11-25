# Architecture and code map

[简体中文](../architecture.md) | English

Formicand is a single-user, local multi-agent workbench. One backend manages every task and agent process; the Mac App, the browser page and the CLI are its clients and share one runtime.

## Overview

```text
Mac App (desktop/) ──┐
Browser page (web/) ─┼── HTTP / SSE ──→ backend src/dashboard/ ──→ runtime src/runtime/
CLI (src/cli/) ──────┘                         │                    │
                                               │                    ├→ Main process (Pi, resident)
                                               │                    └→ subagent processes (Pi, one per work item)
                                               ├→ window control src/gui/, permissions src/security/
                                               └→ task data src/workspace/, storage src/storage/, types src/domain/
```

Main and every subagent are separate Pi coding agent (`@earendil-works/pi-coding-agent`) processes. Formicand adds its tools, context and prompts through the Pi extension `.pi/extensions/formicand.ts` and does not modify Pi itself.

Dependency rules: reusable services do not import CLI entry points; `src/runtime/` does not import the backend HTTP layer; `src/gui/` imports neither HTTP nor CLI. ESLint and the [architecture tests](../../test/architecture-boundaries.test.js) enforce these directions.

## Layers

| Layer                | Owns                                                                        | Main entry points                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                  | Arguments, diagnostics, startup and signals                                 | [launcher](../../scripts/formicand.mjs), [CLI](../../src/cli/formicand.ts), [backend entry](../../src/cli/dashboard.ts)                                             |
| Page                 | Navigation, display, drafts, SSE and user interaction                       | [app](../../web/app.js), [controllers](../../web/assets/controllers/), [UI](../../web/assets/ui/)                                                                   |
| Backend              | Service assembly, HTTP/SSE routes, starting and stopping Main               | [application](../../src/dashboard/application.ts), [routes](../../src/dashboard/routes.ts), [run service](../../src/dashboard/run-service.ts)                       |
| Runtime              | Pi processes, delegation, inboxes, recovery, completion                     | [Coordinator](../../src/runtime/coordinator-runtime.ts), [subagent backend](../../src/dashboard/subagent-backend.ts), [process](../../src/runtime/agent-process.ts) |
| Process host         | Process groups, duplicate-start guard, bounded shutdown                     | [ProcessHost](../../src/runtime/process-host.ts)                                                                                                                    |
| Pi integration       | Pi hooks, tool registration, context assembly                               | [extension entry](../../.pi/extensions/formicand.ts), [runtime](../../.pi/runtime/extension.ts), [tools](../../.pi/runtime/tools/)                                  |
| Windows, permissions | Window grants, observation and actions, serial queue, execution permissions | [ComputerUse](../../src/gui/computer-use.ts), [permissions](../../src/security/execution-permissions.ts)                                                            |
| Data                 | Task data, attachments, artifacts, events, file locks, project data         | [workspace](../../src/workspace/), [storage](../../src/storage/), [domain types](../../src/domain/)                                                                 |
| Desktop              | Native windows, trusted IPC, encrypted credentials, save before quit        | [main](../../desktop/main.cjs), [preload](../../desktop/preload.cjs), [backend](../../desktop/backend.cjs)                                                          |

## Processes and lifecycle

**The backend outlives its clients.** It can run on its own (`formicand backend start|status|stop`). Quitting the App only closes the window; the backend and running tasks continue, and the App reconnects to the same backend next time.

**Main is resident.** One run is served by one Pi process, which stays alive after a turn and handles later messages and callbacks. Main ends only when the session is closed, it times out idle, or a model request cannot continue. An idle exit keeps the session, and the next message starts it again. After a backend restart, running Mains are taken over again.

**Delegation goes through the backend.** `call_subagent` only registers a work item with the backend. The backend writes it to the run's durable queue, starts a separate subagent Pi process once its dependencies are met, and writes the result back to the queue with a callback to Main. Delegation is always asynchronous; use `wait_for_subagents` when the turn needs the result. Each data directory has exactly one backend that starts and settles subagents, and it takes them over from durable records after a restart.

**Inboxes deliver messages.** Callbacks, follow-up messages, answers to questions and peer messages for Main or a subagent are first written to that process's durable inbox. The process rereads its inbox at every turn boundary; when idle, the writer sends a wake-up notification. A message counts as read only once it is in the session context, so it is delivered across backend restarts and read exactly once.

**The program decides completion.** A run is complete only after its state and output are on disk; the last reply is never taken as proof. Completion checks for unfinished delegations, background jobs, pending questions and unread messages.

**Sessions and context.** Pi keeps an append-only session log. When the context fills up, Formicand rotates the window: the model writes a summary, the program carries the necessary records, and work continues in the same session. Session notes and history search are scoped per session.

## Development workflow

Main can hand a requirement to subagents through a Workloop-style flow whose state and rules are kept and enforced by the program:

1. **Requirement ledger** (`project_ledger`): each project's long-lived requirements, their current state and history.
2. **Development record** (`project_development`): an isolated `git worktree` per requirement under `~/.formicand/runtime/development-workspaces/`, never touching the user's own working tree.
3. **Ticket**: scope, acceptance criteria with how to check them, what must stay unchanged, what is out of scope, and dependencies. Frozen once the user confirms.
4. **Delegation**: the Executor works in its own worktree branched from the requirement's site and reports on each criterion with `submit_report`.
5. **Review**: the Reviewer reviews a frozen candidate commit and returns `pass` or `changes_requested` with `submit_review`. Blocking findings must cite an acceptance criterion or one of four baselines: regression, data loss, security, project rule.
6. **Rework**: When a ticket returns to rework, the service checks the remaining rounds before dispatching a continuation. If a round remains, `continueCallId` resumes the original Executor's session and worktree. Once the rounds are exhausted, Main records the next approach on the latest failed review. If Main chooses a fresh Executor, the ticket stays in rework until the new Executor takes it.
7. **Integrate into the requirement site**: once a ticket passes review the program merges it into the requirement's site (`integrate_ticket`), runs the project checks and then that ticket's acceptance commands; the `full` route freezes its final review only after every ticket is in.
8. **Final review**: on the `full` route freezing the final review requires an acceptance mapping (`mapping`, one row per requirement with the test, command or file that proves it); the program numbers the rows so blocking findings can cite them. Before it freezes, the program also checks the document registry in the project's `AGENTS.md`: with no table it asks for one covering every document, and it refuses documents the requirement added or renamed without a row, rows pointing at deleted documents, and two documents of one type and domain. A fix ticket repairs it.
9. **Merge into the target branch**: once the route's own acceptance is met, the change is merged into the configured target branch in a temporary combined worktree with the project's checks; the `full` route also requires the final review of that same version to pass.

There are three routes: `quick` lets Main collect the result itself; `direct` and `full` freeze and review per ticket before integrating.

## Data layout

```text
~/.formicand/                      move it with FORMICAND_HOME
├── config.json                    configuration (0600)
├── credentials.json               model and search keys (0600)
├── workspace/<taskId>/            per-task data, see below
├── runtime/
│   ├── projects.json              project names, IDs and folders
│   ├── workspaces.json            global task index
│   ├── project-data.sqlite        project database (default engine)
│   ├── development-workspaces/    requirement worktrees
│   └── main-capacity/state.json   external Main slots
├── pi/                            Pi state
├── memory/                        Main's memory: user/ and projects/<projectId>/
├── client-sessions.json           the App's encrypted backend sessions
├── composer-drafts.json           composer drafts
├── ui-preferences.json            remembered UI choices
├── computer-policy.json           window access switch
└── logs/
```

Per task:

```text
<taskId>/
├── task.json, task_events.jsonl   task state and events
├── inputs/<uploadId>/             original user uploads
├── artifacts/                     final deliverables
├── visual/images/, downloads/     screenshots, images read, browser downloads
├── agents/main/work/              Main's drafts and intermediate files
├── agents/subagents/<id>/         subagent work directories and candidate files
├── sessions/main/pi/              Main's Pi session
├── sessions/<agentId>/pi/<callId> each subagent's Pi session
└── runs/<runId>/                  run events, delegation queue, inboxes and results
```

- Intermediate files go in `work/`, subagent candidates in `deliverables/`; Main publishes checked files to `artifacts/` with `publish_artifact`. The artifact panel shows only `artifacts/`.
- `sessions/main/request-retry.json` keeps the exact body of Main's latest model request so a failed request can be resent unchanged. It holds unredacted user content and has mode 0600.
- The App and CLI share this directory, and so do the development and release Apps, so two default desktop instances cannot run at once. Use `FORMICAND_HOME` or `FORMICAND_DESKTOP_DATA` for a separate directory in tests.

## Project data

Projects, the ledger, the board, Main sessions, development, review and merge records are held by the [project data service](../../src/workspace/project-data-service.ts). At startup the backend opens SQLite or PostgreSQL as configured and runs versioned migrations; SQL differences stay inside the [storage adapters](../../src/storage/project-data/) so business code never branches on the database. Other backends can share the same data through the [remote client](../../src/workspace/project-data-remote.ts) and register only their own local folders. Tasks, Pi sessions and worktrees always stay on the backend that runs them. See [Configuration](configuration.md#project-data).

## Backend interface

All endpoints listen on `127.0.0.1`, check Host and Origin, and require a client session credential. Routes are defined in [routes.ts](../../src/dashboard/routes.ts) and the `*-routes.ts` files:

| Prefix                                           | Content                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/tasks`                                     | Tasks, messages, runs, delegation, artifacts, window control                                                                                                                                |
| `/api/events`                                    | SSE stream, replayed by sequence number after a reconnect                                                                                                                                   |
| `/api/projects`, `/api/tasks`                    | Projects, ledger, board, Main sessions, development and merge records; ledger actions (`lookup`, `context`, `tidy`, …) are POSTs to `/api/projects/:id/ledger` (or `/api/tasks/:id/ledger`) |
| `/api/project-data`                              | Project-data service description, project list and directory bindings                                                                                                                       |
| `/api/composer`, `/api/uploads`                  | Drafts and uploads                                                                                                                                                                          |
| `/api/model-settings`, `/api/models`             | Model providers and models                                                                                                                                                                  |
| `/api/agents`, `/api/skills`, `/api/mcp`         | Custom agents, skills, MCP servers                                                                                                                                                          |
| `/api/memory`                                    | Memory; Main reads and writes through `/api/tasks/:id/memory` and searches and reads this project's other sessions through `/api/tasks/:id/history`                                         |
| `/api/computer`                                  | Window access state                                                                                                                                                                         |
| `/api/web-search-settings`, `/api/main-capacity` | Web search, external Main slots                                                                                                                                                             |
| `/api/backend`, `/api/host`                      | Backend identity, desktop host only endpoints                                                                                                                                               |

Project data is backed up and restored with the CLI's `formicand data backup` and `formicand data restore`, not over HTTP.

When changing an endpoint, change the producer, the consumers and the behavior tests together.

## Pi dependency boundary

Runtime imports of Pi packages (`@earendil-works/pi-*`) are allowed only where the Pi process is owned; every other module may use `import type` only. The allowed set is an explicit list in the [ESLint rule](../../eslint.config.mjs) `formicand/pi-import-boundary`, and the [boundary test](../../test/architecture-boundaries.test.js) checks that the list matches this section:

- Directories: `.pi/` (extension and tools) and `scripts/` (launchers).
- Model configuration: `src/runtime/main-request-retry.ts`, `src/runtime/model-cache.ts`, `src/runtime/model-connection.ts`, `src/runtime/model-levels.ts`, `src/runtime/model-profile.ts`, `src/runtime/model-provider.ts`, `src/runtime/model-request-recording.ts`.
- Main session file writes (the backend edits a session while Main is not running, for edit-and-resend, forks and offline window rotation): `src/runtime/conversation-fork.ts`, `src/runtime/main-message-edit.ts`.

Deep imports into Pi packages (such as `@earendil-works/pi-ai/api/...`) are allowed only in the model configuration modules, so a Pi upgrade only needs checking in the listed modules.

## Terminal UI adaptation

The CLI's interactive interface runs the original Pi 1.5.2 without changing its files. At startup, in the interactive child process only, six text replacements are applied to one reviewed code chunk (restart, tmux, feedback and crash messages now name Formicand), and three more make the shell identity `AI_AGENT=formicand` and long output files `formicand-bash-*.log`.

The replacements are pinned in [cli-ui-policy.json](../../scripts/cli-ui-policy.json) and [cli-shell-policy.json](../../scripts/cli-shell-policy.json). Build and startup both check the Pi version, file hashes and replacement positions, and fail with an error on any mismatch instead of running an unadapted interface. Regenerate and recheck both policies when upgrading Pi.

## Trust boundaries

- The backend listens locally only. The desktop uses a random port and talks to the main window through a trusted preload; the renderer has no Node access.
- Keys never enter page state, source, logs or packages.
- Window access must be turned on by the user in the App with local confirmation; agents cannot turn it on or resume it. See [Built-in capabilities](capabilities.md#native-windows).
- That permission covers window control only and is not a sandbox for the whole product: commands run by agents are not isolated by the operating system.
- The App supports Apple Silicon Macs only. Windows/Linux desktops, remote workers and multi-user isolation are not built yet.

## Code map

```text
scripts/formicand.mjs   CLI launcher: init, doctor, start and more
scripts/                build, packaging, development start, tests and doc checks
src/cli/                executable entry points
src/dashboard/          backend: HTTP/SSE, service assembly, Main lifecycle, delegation
src/runtime/            Pi processes, context, recovery, inboxes, model connections, configuration
src/tools/              file, command, background job and web tool implementations
src/workspace/          task data, attachments, artifacts, projects and the project data service
src/storage/            event files, file locks, project database adapters
src/domain/             domain types
src/gui/, src/security/ browser and window control, execution permissions
src/platform/           small platform helpers
.pi/extensions/         Pi extension entry
.pi/runtime/            Pi lifecycle assembly and tools by domain
.pi/skills/             bundled skills
web/                    page, native ES modules
desktop/                Electron main process, preload, credential encryption, save before quit
test/                   Node behavior, protocol and lifecycle tests
e2e/                    browser and Electron user flow tests
```

Build output lives in `dist/`, `build/` and `.tmp/`. Rebuild after changing source; never edit the output.

Where to start for a change:

| To change                          | Look at                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main's prompt and context          | [extension](../../.pi/runtime/extension.ts) and the context modules in `.pi/runtime/`                                                                                                                   |
| A new Main tool                    | Add it by domain under [.pi/runtime/tools/](../../.pi/runtime/tools/), then register it as a core tool or in a group in [capabilities](../../.pi/runtime/tools/capabilities.ts)                         |
| Delegation, subagent roles, tools  | [coordination](../../.pi/runtime/tools/coordination.ts), [subagent backend](../../src/dashboard/subagent-backend.ts), [process settlement](../../src/runtime/subagent-processes.ts)                     |
| Ledger, development, review, merge | [project_ledger](../../.pi/runtime/tools/project-ledger.ts), [project_development](../../.pi/runtime/tools/project-development.ts), [project data service](../../src/workspace/project-data-service.ts) |
| Model connections, request retry   | [model-connection](../../src/runtime/model-connection.ts), [model-profile](../../src/runtime/model-profile.ts), [main-request-retry](../../src/runtime/main-request-retry.ts)                           |
| Settings                           | [config](../../src/runtime/config.ts), [runtime-settings](../../src/runtime/runtime-settings.ts)                                                                                                        |
| HTTP endpoints                     | [routes](../../src/dashboard/routes.ts) and the matching `*-routes.ts` and `*-service.ts`                                                                                                               |
| The page                           | [app](../../web/app.js), [controllers](../../web/assets/controllers/), [ui](../../web/assets/ui/)                                                                                                       |
| Desktop windows, IPC, quitting     | [main](../../desktop/main.cjs), [preload](../../desktop/preload.cjs)                                                                                                                                    |
| CLI commands                       | [formicand.mjs](../../scripts/formicand.mjs), [src/cli/](../../src/cli/)                                                                                                                                |
| Browser and window control         | [browser-use](../../src/gui/browser-use.ts), [computer-use](../../src/gui/computer-use.ts)                                                                                                              |

When making the change:

- **Fixing a user flow**: find the layer at fault and its consumers, add a test that reproduces the failure, then fix the implementation. Do not add branches to entry files to work around it.
- **Adding a tool**: put it in the module for its domain, define parameters with typebox, and update [Built-in capabilities](capabilities.md) and the related tests.
- **Splitting a large module**: split by responsibility into new files while keeping the public interface, and adjust callers only after all tests pass.
