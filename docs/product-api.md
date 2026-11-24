# Cowork Product API

Route implementations: [Dashboard](../src/dashboard/routes.ts) and [HTTP boundary](../src/dashboard/http.ts). This document covers the local HTTP API.

Computer Use discovers/selects windows using an enabled desktop global policy or consumes a legacy Task grant for observation/actions through [task-scoped HTTP routes](computer-use.md#产品和宿主边界). GET /api/computer/access reports policy/ownership metadata; GET /api/computer/status reports the execution host's native capabilities and permission state. Task status includes access, and POST discover/select/release consumes or releases existing global authority. The internal host endpoints require a matching backend identity and an explicit token, and reject browser Origin, fetch metadata and cookies. Permission requests, local confirmation and enabling or resuming access require the host credential; session credentials can still read, pause or revoke access. The backend supplies Main and delegated commands with an in-memory business credential that expires on restart. Coordinator command environments stay in memory, and standalone CLI or Main delegation forwards a credential only after the backend identifies it as a business session.

Actions accept optional `observeAfter: true` for atomic post-action feedback; `dispatched` acknowledges delivery, while `effectVerified: false` requires the caller to inspect the returned observation.

GET preview returns the last frame without replacing the agent observation; POST preview refreshes a human screenshot using the existing task session without issuing or replacing an agent observation ID.

This is the boundary between the Cowork Runtime and the desktop/Web UI. The UI must consume this API instead of reading Task workspace files directly.

The current implementation is a local single-user service bound to `127.0.0.1`. Host/Origin checks apply to every request.

The serving process publishes a host credential in its instance record. A client exchanges that credential for a named local session, which authorizes business requests; see [Local sessions and management commands](#local-sessions-and-management-commands). Development mode without a token remains local-only. Remote/multi-user deployment is unsupported: the listener stays on `127.0.0.1`, and Host/Origin checks run before any credential check. See [architecture](architecture.md) for current module boundaries.

## Global APIs

```text
GET  /api/backend
POST /api/session
GET  /api/session
DELETE /api/session/:sessionId
GET  /api/operations/:operationId
GET  /api/events/snapshot
GET  /api/events/stream?cursor=<seq>
GET  /api/models
GET  /api/model-settings?projectId=<stable project id>
POST /api/model-settings/providers
POST /api/model-settings/providers/delete
POST /api/model-settings/models
POST /api/model-settings/models/list
POST /api/model-settings/test
POST /api/model-settings/levels
POST /api/model-settings/roles
GET  /api/web-search-settings
POST /api/web-search-settings
POST /api/workspace/choose
POST /api/projects
PATCH /api/projects/:projectId
DELETE /api/projects/:projectId
POST /api/projects/choose-directory
POST /api/project-clones
GET  /api/project-clones/:cloneId
POST /api/project-clones/:cloneId/cancel
```

Models returns `{ current, models, configured, levels }`; `levels` maps each model ID to `{ levels, source }`, the reasoning levels that model accepts and where they came from: `endpoint` (the provider's `/models` entry: `reasoning_levels`, `supported_reasoning_levels[].effort`, or `reasoning: false` for off only), `official` (Pi's built-in table, when the provider address is a host Pi knows) or `manual` (the model's `reasoningLevels`, all six by default). Levels Pi cannot send, such as `ultra`, are dropped. `POST /api/model-settings/levels { id?, baseUrl?, api?, apiKey?, model }` answers the same question for one model of a provider and returns `{ levels, source, limits, official }`; omitted address, format and key come from the saved provider `id`. `limits` is what the model's `/models` entry says about `contextWindow` (`context_window`, `context_length`), `maxOutputTokens` (`max_output_tokens`, `max_completion_tokens`) and `images` (`modalities.input` contains `image`). A model saves `autoLimits` (`contextWindow`, `maxTokens`, `images`): the fields that take the model's own values at the start of a Main Run; a field edited by hand is left out and its saved value wins. A model saved without `autoLimits` treats a field as following while it still holds the default (256000, 8192, no images). The output cap taken from the endpoint stays within 65536 and half the context window. `GET /api/tasks` returns the grouped catalog `{ workspaceRoot, currentWorkspaceRoot, model, tasks, projects }`, rather than a bare Task array. Explicit projects remain in `projects` with `tasks: []`. A Task that Main is waiting on a person carries `pendingQuestion: true`; the field is absent once the question is answered or the Task is no longer running or waiting.

`GET /api/backend` returns `{ backendId, pid, startedAt, protocol }` for the process serving this data root. `protocol` is `{ version, minClientVersion, capabilities }`. The standalone backend keeps `backendId` across restarts, so a client can tell a restarted process from a different backend, and `pid` lets a host stop only the process it recorded. The route is local and credential-checked like the other `/api/*` routes and exposes no configuration.

Desktop and Web use the same model and search HTTP routes. Desktop keeps its client session credential in the host and authorizes the selected backend's requests through the host-managed session.

`GET /api/model-settings` also returns `modelRoles`: each known role with `wired`, its host binding, and its effective `source`, `connectionName`, `model` and reasoning level when it has one. Main, Executor and Reviewer are wired; `router` is the remaining placeholder and is listed with `wired: false`. Main reports the model its next Run would admit (with no binding, the first model of the first enabled provider); a delegated role reports the binding a work item would read at its start, and with no binding its `effective` is `null` because the item keeps the launching Run's own model. `POST /api/model-settings/roles { role, profileId }` saves a host default and returns the same redacted status; `profileId` is `<providerId>#<modelId>`, and `""` clears the binding. Role bindings may change while a Run is active. A binding that names a missing or disabled model is refused here, and a stored reference that has disappeared is reported through `modelRoles.roles[].error` and fails the next use instead of using another account. Role bindings are local to the execution host, so they never carry a key or follow a project to a remote host. There is no per-project override; a conversation picks another model in the conversation panel. Main's role applies to its next Run and an active Run keeps its admitted snapshot; a delegated role is read when each work item actually starts, so a change reaches items that are still queued and never rewrites one already running.

Models are configured per provider. `GET /api/model-settings` returns `providers` (each with `id`, `name`, optional `preset`, `baseUrl`, `api`, `thinkingFormat`, `supportsPromptCacheKey`, `enabled`, `configured` and its `models`; each model carries its own `profileId`, `supportsImages`, `contextWindow`, `mainMaxTokens`, `subagentMaxTokens`, `reasoningEffort`, `reasoningLevels`, `supportsReasoningEffort` and `autoLimits`), `activeProfileId` (the model Main uses), `model`, `configured`, `managedByEnvironment`, `modelRoles`, and `credentialError` when the host credential file cannot be read. It never returns a key.

- `POST /api/model-settings/providers { id?, name, preset?, baseUrl, api?, thinkingFormat?, supportsPromptCacheKey?, enabled?, apiKey? }` creates a provider (no `id`, key required) or edits one; omitted fields keep their saved values and a blank key keeps the stored one. A provider's `apiKey` goes to the host credential file (`credentials.json`, mode 0600, beside the configuration; `COWORK_CREDENTIALS` overrides the path).
- `POST /api/model-settings/providers/delete { id }` removes a provider and its key.
- `POST /api/model-settings/models { providerId, models?, remove? }` adds or updates models by `id` (omitted fields keep their values) and removes the ids in `remove`.
- `POST /api/model-settings/models/list { id? , baseUrl?, api?, apiKey? }` reads the provider's model listing (`/models`, or Anthropic's `/v1/models`) without saving and returns `{ models: [{ id, name?, contextWindow?, maxTokens?, images?, reasoning?, added }] }`, filling what the listing omits from Pi's catalog for a known address.

A model or provider that a role binding uses cannot be removed or disabled. Every change except a role binding is refused while a Run is active, and an environment-managed connection (`COWORK_API_BASE`, `COWORK_API_KEY` and the other `COWORK_*` model variables) refuses all changes. `GET /api/web-search-settings` follows the same rule; `POST` stores or clears the Exa key in that file. See [connection storage](configuration-reference.md#连接存储与兼容).

Create a project with `POST /api/projects { projectName, projectDirectory, projectId? }`; update its name and/or folder with `PATCH /api/projects/:projectId`. Both return `{ project }`, containing `projectId`, `projectName`, `projectDirectory`, `workspaceRoot` (the project folder), `createdAt`, `updatedAt`, and `tasks`. Newly created IDs are stable `project_<uuid>` values; a secondary backend may pass the shared `projectId` of an existing project to map its own folder onto the same shared identity. Duplicate IDs and duplicate directories are refused, and a directory is never used as the shared identity. Names must be nonempty and at most 120 characters. The directory must be an existing absolute folder; duplicate project directories return 409. Creation persists an empty project without creating a Task or calling the model. `DELETE /api/projects/:projectId` takes an idle project off the list and returns `{ projectId, removed: true }`: the project and its conversations leave `/api/tasks` and the event snapshot, but the folder, the conversation records and the project identity stay on disk. A project with a running, paused or waiting conversation, a background command or pending collaboration is refused with 409. `POST /api/projects` with the same folder restores the removed project with its original `projectId` and returns its conversations in `tasks`; a removed project cannot be renamed or moved until then.

Folder changes apply to every associated conversation. Active Main/subagents, waiting work, scheduled wakeups, or command jobs reject directory changes with 409; renaming is allowed. Project changes and run startup are serialized to prevent changing a running conversation's CWD.

`POST /api/projects/choose-directory` opens the local picker and returns `{ cancelled, projectDirectory? }`; choosing a folder does not save a project.

`POST /api/project-clones { remoteUrl, destination, branch?, operationId? }` starts a Git clone on the execution host and returns 202 `{ clone: { cloneId, state, progress } }`; `GET /api/project-clones/:cloneId` reports the same shape with `state` `cloning`, `registering`, `completed`, `failed` or `cancelled`, a 0–100 `progress`, a readable `error` for failures, and the registered `project` after completion. The clone uses the host's own Git credentials (SSH agent/key or credential helper). URLs and credentials are never returned or written to the record, and git error text has URLs removed, so a token in a path or query cannot leak. Only `http`, `https`, `ssh`, `git`, `file` and scp-style `user@host:path` addresses (or a local filesystem path) are accepted, and git runs with `GIT_ALLOW_PROTOCOL` restricted to the supported transports so a host or repository configuration cannot re-enable a command transport. Git only registers the project after it exits successfully; a failed or cancelled clone removes the folder it created and registers nothing. `POST .../cancel` stops the Git process and removes the incomplete folder. A destination that already exists is refused with 409. The optional `operationId` is the clone's durable identity: a retry with the same id and content returns the existing clone, and the same id with different content returns 409. A clone still marked `cloning` when a later process starts has no owner, so startup reports it as failed and removes its folder unless the catalog already references it. A record in `registering` is never deleted: startup checks the catalog, finishes a missing registration, or keeps the complete clone and reports why registration failed.

A conversation without a project is omitted from `GET /api/tasks`, while its persisted files remain intact. Explicitly created projects remain visible when empty.

The legacy global `POST /api/workspace/choose` still accepts `{ workspaceRoot }` (or opens the picker when omitted) and returns `{ cancelled, ...taskList }` for legacy data compatibility. Its task-scoped `{ taskId, workspaceRoot }` form returns 410: change the owning project's settings instead. Conversations inherit their project's folder and cannot independently reassign it.

`POST /api/model-settings/test { id?, baseUrl?, api?, apiKey?, model }` checks one model of a provider without saving. Omitted address, format and key come from the saved provider `id`; the saved model's image setting decides whether an image challenge is sent. `api` accepts `openai-completions`, `openai-responses` or `anthropic-messages`; unknown values are rejected before saving or requesting. A bare host address gets `/v1`, an address with a path is used as written, and an Anthropic address is never extended.

The service verifies a function call in the selected protocol and, when enabled, a synthetic image challenge. Success returns `{ ok: true, model, supportsImages, durationMs }`; errors contain only local diagnostics and never provider response bodies or credentials. Desktop and Web both call `POST /api/model-settings/test`. This is a connection check, not a general quality benchmark or a guarantee of arbitrary tool compatibility.

## Local sessions and management commands

Route implementations: [sessions](../src/dashboard/session-routes.ts), [local access](../src/dashboard/local-access.ts), [protocol](../src/dashboard/backend-protocol.ts) and [commands](../src/dashboard/management-commands.ts). This is the protocol seam every local client shares; the desktop host, the Web UI and future clients must use it instead of reading backend files.

A host credential authorizes once and names this client as a session. Every later request presents the session credential in the same headers the host credential uses. Sessions belong to the data root and survive a backend restart; only their hashes are written. Revoking one client never disturbs the owner's other clients, and the host credential itself keeps working for owned tools that never authorize.

| Endpoint                           | Behavior                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`                | `{ clientName?, protocolVersion }` → HTTP 201 `{ session: { sessionId, token, clientName?, protocolVersion, createdAt }, backend, protocol }`. |
| `GET /api/session`                 | `{ current: { kind, sessionId? }, sessions }`; the host sees every session, a session sees itself. Listing never repeats a secret.             |
| `DELETE /api/session/:sessionId`   | Revoke one session (a session may end itself, the host may end any) → `{ sessionId, revokedAt, revoked: true }`. Repeating is a success.       |
| `GET /api/operations/:operationId` | The saved receipt `{ operationId, command, status, body, completedAt }` of this identity's command, or HTTP 404 `operation_unknown`.           |

`protocolVersion` is `major.minor`. The major number is compatibility; a client minor newer than this backend is refused, an older one is accepted. A missing version returns HTTP 400 `protocol_required`; an incompatible one returns HTTP 409 `protocol_incompatible` naming both versions, so both sides can show an actionable upgrade message. Capabilities describe the protocol this backend serves; clients branch on capability names instead of route probing. `events.snapshot` and `events.stream` name the catalog reconciliation below: a client that requires them and does not find them reports the missing names instead of probing routes or half-loading a screen.

Change commands accept an optional `operationId`: `POST /api/projects`, `PATCH /api/projects/:projectId` and `POST /api/tasks`. Management clients send one on every change; omitting it keeps the legacy single-shot behavior the current Web UI uses.

- The same identity, `operationId` and command content returns the saved status and body, marked with the `x-cowork-replayed: 1` response header, instead of applying the change again. Two in-flight duplicates still produce one result.
- The same `operationId` with different content returns HTTP 409 `operation_conflict` and changes nothing.
- Receipts are per identity: one client never reads another client's command result. A receipt exists only for a command that succeeded; a failed command can be retried.
- A lost response is reconciled by reading the receipt, then retrying with the same identity, `operationId` and content. The receipt is written before the response, so a restart between them replays the saved result.

Object changes carry the expected revision their service checks under its own lock; a stale value returns HTTP 409 `revision_conflict` without changing state. An operation id is the command's identity, not a substitute for the revision check: a replay returns the saved result, while a new command with a stale revision is refused.

Stable error codes: `unauthorized`, `session_revoked`, `session_unknown`, `host_credential_required`, `protocol_required`, `protocol_incompatible`, `operation_id_invalid`, `operation_conflict`, `operation_unknown`, `operation_receipt_invalid`, `revision_conflict`, `cursor_required`, `cursor_expired`, `cursor_unknown`. Messages stay in the server's user-facing language; clients branch on the code. A damaged receipt is never treated as "no command": it returns 500 `operation_receipt_invalid` and leaves the file in place, because re-running the command could apply it twice.

## Snapshot and event recovery

Route implementation: [catalog events](../src/dashboard/catalog-events.ts) over the [durable event ledger](../src/dashboard/event-ledger.ts); the shared client is [management-events.js](../web/assets/controllers/management-events.js). A client that reconnects reconciles here instead of re-reading every Task: the snapshot is the same authoritative catalog `/api/tasks` serves, and the sequence it names is what a subscription resumes from.

`GET /api/events/snapshot` returns `{ backendId, cursor, revisions, ...taskList }` (the fields of `GET /api/tasks`, plus `backendId`, `cursor` and `revisions`). `revisions` maps `project:<projectId>` and `task:<taskId>` to the object revision the snapshot describes. `cursor` is the last event sequence included in the lists. The snapshot and the cursor are taken together, so a change that commits after the snapshot answers is replayed by the subscription rather than lost in the handoff.

`GET /api/events/stream?cursor=<seq>` is Server-Sent Events. Each `data:` frame is one event record:

```json
{
  "version": 1,
  "backendId": "backend_...",
  "seq": 42,
  "eventId": "backend_...:42",
  "scope": "task",
  "objectId": "task-1",
  "revision": 3,
  "type": "task.changed",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "payload": { "taskId": "task-1", "title": "...", "status": "running" }
}
```

- `seq` is the backend-wide order; `eventId` is the stable identity; `scope` and `objectId` name the object; `revision` counts that object's own published changes. The cursor is the last `seq` the client applied.
- `type` is `project.changed`, `task.changed` or `task.deleted`. `payload` is the whole object (`{}` for a deletion), so applying an event never depends on a delta the client did not have.
- A `task.deleted` tombstone is published for an object this backend already published and that then disappears from a complete catalog read. A workspace root that cannot be read is not treated as a deletion.
- A `stream.reset` frame reports that the subscriber fell behind the retained log; it names `code` and the current `cursor` and ends the connection. The client takes a new snapshot instead of continuing from a hole.

Cursor outcomes: a missing or non-integer `cursor` returns HTTP 400 `cursor_required`; a cursor older than the retained log returns HTTP 409 `cursor_expired`; a cursor above the current sequence (another backend's, or a lost history) returns HTTP 409 `cursor_unknown`. Both 409s name the retained range and require a new snapshot. The log keeps the newest 2000 records by default (`COWORK_EVENT_LEDGER_RECORDS`, 4–100000); compaction folds older records into a persisted index that keeps each object's revision.

Events are written and fsynced after the business change commits. Every change published by `POST /api/projects`, `PATCH /api/projects/:projectId`, `POST /api/tasks`, `PATCH /api/tasks/:taskId`, `POST /api/tasks/:taskId/action` and `DELETE /api/tasks/:taskId` appends its event immediately. A change made by another writer (a Run transition, an MCP edit) becomes an event when the catalog is next read: on any snapshot, including the first one after a restart, and about once a second while a subscription is open (`COWORK_EVENT_RECONCILE_MS`). Nothing reconciles in the background at backend startup: a restart heals a committed change whose event was never written when the next snapshot is taken or the next subscription opens. Reconciliation publishes such a change and never rolls a published object back.

A client must follow these rules; [management-events.js](../web/assets/controllers/management-events.js) implements them:

1. Bind to one backend identity. Drop any snapshot or record whose `backendId` is not the bound one; after switching backends, close the old connection, discard its cache and take a new snapshot.
2. Snapshot first, then subscribe from that snapshot's `cursor`.
3. Ignore a record at or below the applied cursor (duplicate); ignore a record whose object `revision` is not newer than the snapshot's (stale replay).
4. On a `seq` gap, reconnect from the applied cursor so the server replays the missing records in order; on `cursor_expired`/`cursor_unknown` or `stream.reset`, take a new snapshot.
5. Reconnecting replays events only. A command is never re-sent by a reconnect; use the `operationId` and receipt rules above when a command's response was lost.

`createManagementEventClient({ backendId, baseUrl, fetch, headers, onSnapshot, onEvent, onReset, onStatus })` exposes `start()`, `snapshot()`, `switchBackend({ backendId, baseUrl })`, `stop()` and `state()`. The Web UI and the desktop host consume the catalog through it rather than opening their own event channel.

### Shared browser client

[management-client.js](../web/assets/controllers/management-client.js) is the one module a browser page uses for the whole protocol: it authorizes a named session with `POST /api/session`, checks the returned protocol and capabilities, reads the catalog snapshot, follows the event stream, and sends change commands with an `operationId` and receipt reconciliation. It downloads backend files and uploads attachments through the same session, so a page never needs Electron IPC or a second transport.

- One bound `backendId` + `baseUrl`. Sessions are stored per backend origin, so a token minted by one backend is never presented to another.
- `switchBackend({ baseUrl })` aborts every in-flight request, stops the old event stream, and retires the old identity. A response that still resolves afterwards is rejected as `stale_client`; a late event is dropped because its `backendId` does not match. The page also swaps its draft namespace (`composer-session.js`), so drafts stay with the backend that owns them and a switch back restores them.
- `authorize()` is explicit. A revoked or unknown session puts the page in `unauthorized` with a reauthorize action; an incompatible version or missing capability (`incompatible`/`unsupported`) names both versions or the missing names. Nothing silently retries.
- `command(path, { method, body, operationId })` sends the command once. If the response is lost it reads `GET /api/operations/:operationId` and only re-sends content the backend never accepted.
- `snapshot()`, `blob(path)`, `download(path, name)`, `upload(file)`, and `openStream(path)` keep the session header and the bound origin, which is what lets one page manage another trusted local backend.

### Trusted local client origins

A page served by one local backend may manage another. Browsers send that request with the page's `Origin` and require CORS, and the serving page's own `Content-Security-Policy` must allow the other origin in `connect-src`. `COWORK_TRUSTED_CLIENT_ORIGINS` names those exact origins:

```text
COWORK_TRUSTED_CLIENT_ORIGINS=http://127.0.0.1:3880,http://localhost:3881
```

Only exact loopback `http://` origins are accepted. The value is never wildcarded and never opens the listener to a non-local host; every other origin keeps the single-origin rule and `sec-fetch-site: cross-site` stays refused. For each named origin the backend answers the preflight, adds `Access-Control-Allow-Origin` for that exact origin with credentials, and lists those origins in the page's `connect-src`. The credential policy (host credential or session) still applies to every real request, so naming an origin does not itself grant access.

The local host credential is a host-scoped cookie, so browsers sharing `127.0.0.1` present the same credential to every local backend served there. `POST /api/session` therefore succeeds against another local backend only when the host installed a credential that backend accepts in the same browser context. Cross-machine remote entry remains out of scope (P6).

## Project ledger

The ledger is the authoritative shared record of a project's long-lived features: how each behaves now, what each development changed, the other names users give it and where it came from. A requirement is one feature; many developments belong to it over time. Every project has one `misc` requirement, titled 杂项, for changes no feature owns; it can neither be renamed nor retired. A rule that is hard to reverse belongs in the repository's `docs/adr/`, not in the ledger. It is stored by the [project data service](configuration-reference.md#项目数据存储); the HTTP shape is identical on SQLite and PostgreSQL.

```text
GET  /api/project-data
GET  /api/project-data/projects
POST /api/project-data/bindings
GET  /api/projects/:projectId/ledger?q=<text>&status=active|retired&limit=1..200
GET  /api/projects/:projectId/ledger/:requirementId
POST /api/projects/:projectId/ledger
GET  /api/tasks/:taskId/ledger
POST /api/tasks/:taskId/ledger
```

`GET /api/project-data` returns `{ engine, target, serverVersion, schemaVersion, source }` and carries no credential. `GET /api/project-data/projects` lists shared project identities (no local directories). `POST /api/project-data/bindings` takes `{ projectId, projectName, projectDirectory }` and stores the caller backend's own directory binding; a remote backend uses it on first access so the authority never resolves its path through the authority's catalog. Project routes resolve the project through the local catalog; a request cannot choose a storage directory, and a shared project's directory is never used as a local execution directory.

POST bodies carry `action`:

- `lookup` (`request`, the user's own words, up to 2000 characters) finds the feature they are about. Every active requirement is scored in memory, with no index: English by words, Chinese by overlapping two-character pieces with single characters worth half, each piece weighted by BM25 so pieces most requirements share count little; title, description and aliases weigh 1, summary and history 0.6. It returns `lookup` `{ verdict, candidates, catalog? }`: `verdict` is `likely` (the top candidate holds at least half of the request's pieces the ledger knows, shares at least two of them and scores twice the next), `none` (no candidate, or the top holds under a fifth) or `several`; `candidates` are at most 5 `{ requirementId, title, score, matched }`; `catalog` lists every requirement, retired ones included, as `{ requirementId, kind, status, title, aliases, description }`, whenever the verdict is not `likely` or the ledger has at most 30 requirements.
- `context` (`requirementId`) returns `context` with the requirement (`description`, `summary`, `aliases`), its latest 10 `history` lines and `historyTotal`, its `developments` newest first (`goal` cut to 500 characters, `completionCriteria`, `status`, `merged` `{ commit, at }` once delivered), the `docs/adr/` paths its summary or history names with `present` checked against the project's local folder, and `directories`: the 5 directories its merged developments changed most, from `git diff` between each baseline and merged candidate in that folder.
- `query` (`q` matched in the title, summary and aliases; `status`; `limit`) browses, and `get` (`requirementId`) reads one.
- `count_since_tidy` returns `{ merged }` for development status and observation. It counts recorded deliveries since the last completed tidy without allocating a snapshot or loading the catalog.
- `tidy` returns `tidy` `{ merged, tidiedAt?, readAt, catalog, changes }` and reserves an ordered timestamp for that snapshot. It reports how many developments were recorded as merged since the last tidy (by when the delivery was recorded, so one replayed late still counts), the catalog as `lookup` gives it (every requirement's title and description for Main to compare), and `changes`, each `{ requirementId, title, history }` history line a development wrote since then. `finish_tidy` takes `readAt` (the opaque token from this project’s `tidy`, passed back verbatim; 400 for a missing token or a legacy v13 timestamp) and `documents`: `{ update: [{ path, reason }] }` (1–30 documents that fell behind the code) or `{ unchanged }` (why none did); without it 409 `documents_verdict_missing`. It moves the tidy mark to the timestamp covered by the token (409 `tidy_stale` when a later read has already finished a tidy) and returns `{ tidiedAt, documents, next? }`, where `tidiedAt` is an ISO timestamp and `next` asks for one development on the misc requirement that brings the listed documents up to date; reading leaves the completed tidy mark in place. A delivery or history entry recorded after the snapshot counts toward the next tidy even when the wall clock shows the same millisecond. Concurrent completions advance the mark in snapshot order.
- `merge_requirements` (`from`, `into`, `expectedRevision` of `into`, `fromRevision` of `from`, `summary`, `taskId`) folds `from` into `into` in one transaction: its developments, board cards, merges, deliveries, history, references and Main session links move to `into`, its title and aliases become aliases of `into` (skipping names already there), `into` gains a history line and the next revision with `summary`, and `from` is deleted with its revisions. The misc requirement cannot be `from` (409 `requirement_misc_fixed`); two requirements that both have an active development or both an open board card are refused with 409 `requirement_merge_busy`. A stale revision of either side is refused with 409 `revision_conflict`.
- `create` (`title`, optional `description` of up to 200 characters saying what the feature is — the summary's first sentence, else the title, when absent; the `project_ledger` tool requires it — `summary`, `aliases` up to 20, `source` `{ kind: internal|external|legacy, reference? }`, `references` `[{ kind: task|session|delivery, value }]`) records a new feature, `active`, and returns 201 with revision 1. An internal requirement stays ledger-only and creates no board entry.
- `update` (`requirementId`, `expectedRevision`, optional `title`, `description`, `summary`, `aliases` replacing the whole list, `history` one line dated today, `status`, `note`, `taskId`) appends the next revision. The misc requirement refuses a new title, a new description or `retired` with 409 `requirement_misc_fixed`.

A requirement returns `projectId`, `requirementId`, `kind` (`feature`/`misc`), `title`, `description`, `summary`, `aliases` (`[{ alias, developmentId?, createdAt }]`), `source`, `status` (`active`/`retired`), `revision`, timestamps, `references` and `developments` (how many developments it has had, merged or not); reading one requirement also returns its `history` (`[{ entryId, day, text, developmentId?, createdAt }]`, oldest first) and every `revisions` entry. A delivery does not change the status: it adds a `delivery` reference and a revision note. A stale `expectedRevision` returns 409 with `code:"revision_conflict"` and `currentRevision`, and never overwrites the newer revision. Unknown requirements return 404; invalid fields return 400.

The Task-scoped routes are the Main tool's boundary: the Dashboard resolves the Task's project from its local catalog, so a tool argument cannot select another project. On the project routes a request carrying `x-cowork-task-id` is refused with 403 `project_scope_denied` unless that Task belongs to the named project.

## Main sessions

A project's persistent Main sessions are shared records, while their Pi transcripts stay local. Each session names one Task as its history container (`<storage>/<taskId>/sessions/main/pi`) and one `backendId` that may run it. A session handles requirements one after another; finishing a requirement ends that Run, not the session.

```text
GET  /api/projects/:projectId/main-sessions
GET  /api/projects/:projectId/main-sessions/:sessionId
POST /api/projects/:projectId/main-sessions
```

A session returns `sessionId`, `projectId`, `title`, `entryKind` (`internal|external`), `kind` (`regular|continuation`), `backendId`, `taskId`, `currentRequirementId`, `currentRequirementTitle`, timestamps, `projectDirectory`, `local`, `activeRunId` and `runs` (`runId`, `requirementId`, `state`). `local` is true only when this backend owns the Task, so a session created on another backend is visible but cannot be continued here. These routes never move or copy a transcript.

POST bodies carry `action`:

- `create` (`title`, optional `entryKind`, `kind`, `requirementId`) creates the Task history container and the session, and makes the requirement current.
- `select_requirement` (`requirementId`, with the session in the path or as `sessionId`) changes the session's current requirement without starting work.

A session's Run uses the existing Task route with the session identity:

```text
POST /api/tasks/:taskId/run   { prompt, mainSessionId, requirementId? }
```

The session must belong to this backend and name that Task; a mismatch is refused before a process starts. The Run is recorded against the session before the process starts, `requirementId` also becomes the session's current requirement, and a settled or cancelled Run updates its state. A conversation that predates sessions is adopted on first list or run, keeping its original Pi history in place.

A secondary backend with `projectData.authority` reads and writes these same session records through its authenticated client, as business requests only: it never sends SQL or a transaction callback, and the authority keeps the token, the shared records and each backend's directory binding. Session records cross backends; the Task, Pi transcript and process ownership do not. A request recording or settling a Run for a session owned by another backend is refused with `session_backend_mismatch` instead of writing a second owner.

## Development records

A requirement's development record is the agreed goal, completion criteria, suggested route and code baseline, plus the isolated Git checkout a backend prepared for it. The record is shared project data and goes through the same unified gateway and HTTP surface on SQLite and PostgreSQL; the checkout directory is a per-backend execution fact, like a directory binding. A requirement has many developments over time and at most one `active`: `status` is `active` while the work goes on, `merged` once its merge is delivered, `withdrawn` when Main stops it. Fixed-candidate reviews, a delivery qualification and the project merge operations are recorded beside the development.

```text
GET  /api/projects/:projectId/merge-config
POST /api/projects/:projectId/merge-config
GET  /api/projects/:projectId/developments
GET  /api/projects/:projectId/developments/:developmentId
POST /api/projects/:projectId/developments
GET  /api/tasks/:taskId/developments
POST /api/tasks/:taskId/developments
GET  /api/projects/:projectId/reviews[?developmentId=]
GET  /api/projects/:projectId/reviews/:reviewId
POST /api/projects/:projectId/reviews
GET  /api/tasks/:taskId/reviews
POST /api/tasks/:taskId/reviews
GET  /api/projects/:projectId/deliveries[?developmentId=]
GET  /api/projects/:projectId/deliveries/:deliveryId
POST /api/projects/:projectId/deliveries
GET  /api/tasks/:taskId/deliveries
POST /api/tasks/:taskId/deliveries
```

The merge configuration is the project's single update entry and is reserved for the later shared merge queue:

```json
{ "repository": "/absolute/path/to/repository", "targetBranch": "main", "executionBackendId": "backend_…" }
```

`repository` must be a local, non-bare Git repository and `targetBranch` a local branch; the writer checks both when the configuration is written and again when a checkout or merge is prepared, and the data authority only stores the shared entry. `executionBackendId` defaults to the serving backend and names the one backend that claims merge operations and updates the target. Each backend that can see the configured repository prepares its own isolated requirement checkout; a secondary backend with `projectData.authority` validates the repository on its own host, writes the shared entry and development record through its authenticated client, and prepares the checkout itself; on the authority a declared `create`/merge-config request only records the shared fact, and `ensure_workspace` is refused with 403 `development_workspace_owner_only` instead of running Git against another host's repository. When no entry was written and the project's local folder is a Git repository whose checked-out branch has a commit, the first development or merge writes one for it: that folder, that branch and the serving backend. Otherwise a missing configuration returns 409 `project_git_missing`, whose message tells Main to stop and ask the person to make the folder a repository rather than work around it; an unusable repository, branch or bare repository returns 400 `project_git_invalid` naming the path or branch; a backend other than the execution owner returns 409 `project_git_owner_mismatch` when it tries to apply a merge.

A development returns `projectId`, `developmentId`, `requirementId`, `requirementTitle`, `goal`, `completionCriteria`, `route` (`quick`/`direct`/`full`), `status` (`active`/`merged`/`withdrawn`), `revision`, `baseline` (`{ branch, commit }`), optional `sessionId`/`taskId`, optional `workspace`, timestamps. `workspace` is `{ workspaceId, backendId, directory, branch, baseCommit, state, error? }`, where `state` is `ready` or `failed`; a failed attempt keeps the record, its directory, branch and baseline, so the requirement and workspace stay findable. The checkout is a real `git worktree` under `ATRIA_HOME/runtime/development-workspaces/<developmentId>` on branch `coworkos/development/<developmentId>` at the recorded commit; the user's own working copy, staged reservation and untracked files are never changed.

POST bodies carry `action`:

- `create` (`requirementId`, `goal`, `completionCriteria` 1–20 strings, `route`; optional `request`, the user's own words naming the feature, up to 100 characters; optional `sessionId` on the project route) records the baseline from the configured target branch and prepares the checkout. While the requirement has an active development a second create returns 409 `development_exists` with that `developmentId`; a retired requirement returns 409 `requirement_retired`. When `lookup` of `request` would not return this requirement as `likely`, `request` becomes one of its aliases, carrying the new `developmentId`; an alias already there, the title itself or a requirement with 20 aliases is left alone. The `project_development` tool requires `request` on `create`.
- `update` (`developmentId`, `expectedRevision`, optional `goal`, `completionCriteria`, `route`, `status:"withdrawn"`) appends the next revision; `withdrawn` is refused with 409 `development_merge_pending` while a merge is waiting, applying or merged. A stale `expectedRevision` returns 409 `revision_conflict` with `currentRevision`; a route the existing tickets no longer satisfy is refused with 400. A merged or withdrawn development refuses updates, tickets, reviews and new merges with 409 `development_closed`; a retried merge of its merged candidate still returns that merge.
- `ensure_workspace` (`developmentId`) returns the existing checkout when it is still the recorded worktree, otherwise prepares it again at the recorded baseline. A failure is written to `workspace.state:"failed"` with a locatable `error` instead of deleting the record.
- `get` (`developmentId`), `query` and `find_by_requirement` (`requirementId`, returning the active development or else the latest) read; an unknown record returns 404. A list (`GET` or `query`) also returns `tickets`, every listed development's tickets as `{ developmentId, ticketId, title, state, dependsOn }`, so a page that groups requirements by phase reads them in the same request.
- `tickets` (`developmentId`) reads the requirement's ticket set `{ projectId, developmentId, revision, tickets, updatedAt? }`; `revision` is 0 before the first proposal.
- `write_tickets` (`developmentId`, `op`) changes the set as a whole: `propose` (`tickets`) replaces every unconfirmed draft and leaves confirmed tickets alone; `confirm` (`expectedRevision`) freezes the drafts of that revision; `revise` (`ticketId`, `changes`, `reason`, `decision`, `expectedRevision`) changes one confirmed ticket and appends `{ revision, decision, reason, previous, at }` to its `changes`. `dryRun: true` on `propose` or `revise` returns the result without storing it. The execution progress (`start`, `review`, `verdict`, `integrate`) is written by the program itself; over HTTP only an authenticated backend relaying it to the authority may send those operations, and any other request is refused with 400. A stale `expectedRevision` returns 409 `ticket_revision_conflict`; a rule violation returns 400.
- `integrate_ticket` (`developmentId`, `ticketId`, optional `checks` `[{ name, command }]`) brings a `passed` ticket's reviewed commit into the integration checkout with a merge commit, then runs the given project checks and every acceptance command of the ticket there. The reviewed commit must still be the head of the ticket's checkout (`ticket_candidate_changed`) and the integration checkout must be clean; at least one check is needed (`merge_checks_missing`). A conflict is aborted and refused with `ticket_integration_conflict`; a failing check resets the checkout to where it was and returns `{ integrated: false, checks, detail }`. Success records `integration` `{ commit, tree, itemCommit, checks, at }` on the ticket, makes it `merged` and returns `{ integrated: true, tickets }`. Refused on the authority for another backend's checkout.
- `next` (`developmentId`) returns `{ next }`, one sentence worked out from the record, tickets, review, merge and delivery: what Main should do now.
- `record_workspace` records the authenticated backend's own checkout (`developmentId`, `workspace`); it is used by a secondary backend's client and refuses a workspace for another backend with 403 `development_workspace_backend_mismatch`.

Reads of developments, merges, deliveries and the delivery view that carry `x-cowork-read-only: 1` answer from the stored records only: they never replay this host's pending deliveries before answering, so the delivery outbox entry and the merged row stay for the next work read or the host's own periodic pass. The observation entry's data port attaches the marker to every request it sends a node; the work entry and the Main tool send none, so their reads still complete a pending delivery first. `1` is the only accepted value and anything else returns 400 `invalid_read_only`; the response shape and content are the same either way, including the delivery view's `diff`, which is still read from the checkout that owns it. A trusted cross-origin page may send the header, so the trusted-client preflight allows it.

The Task-scoped routes are the Main tool's boundary: the Dashboard resolves the Task's project and Main session, so a tool argument cannot select another project or session. On the project routes a request carrying `x-cowork-task-id` is refused with 403 `project_scope_denied` unless that Task belongs to the named project. The production tool is `project_development` with actions `create`, `get`, `query`, `find_by_requirement`, `update`, `ensure_workspace`, `tickets`, `propose_tickets`, `revise_ticket`, `integrate_ticket`, `review_plan`, `freeze_candidate`, `attach_reviewer`, `record_finding`, `rule_finding`, `record_rework`, `change_approach`, `complete_review`, `delivery_check`, `query_reviews`, `get_review`, `request_merge`, `apply_merge`, `merge_status` and `delivery_status`. `delivery_status` returns the same {projectId, development, stage, plan, reviews, qualification, merges, delivery, board?, diff?, roles, pendingSync?, reviewReport} view the Web controller reads; it accepts a `developmentId` or a `requirementId`. Every result that names a development also carries `next` from the `next` action. `propose_tickets` stores the drafts and shows them to the user as a ticket card (a human question with `proposal.kind: "tickets"`, options `确认这些票`/`拒绝`, recommended `拒绝`), then confirms them only when the user chose the first option; `revise_ticket` shows the changed ticket beside the current one with the reason and writes only on confirmation, recording the user's answer as `decision`. Any other answer, a timeout or a cancellation freezes and changes nothing, and the result says so.

A ticket is `{ ticketId, title, scope, criteria, preserve, outOfScope, dependsOn, state, revision, changes, confirmedAt?, work?, reviewIds, integration?, createdAt, updatedAt }`, where `work` is the Executor call `{ callId, agentId, workspace }` implementing it. `scope` lists project-relative paths and is required on the `direct` route; each criterion is `{ criterionId: "AC1"…, text, check }` where `check` is `{ command }` or `{ manual }` (why no command can check it). `state` is `draft`, `confirmed`, `in_progress`, `in_review`, `passed`, `merged` or `rework`. The `quick` route has no tickets and `direct` has exactly one; dependencies must name tickets of the same set and form no cycle; a merged ticket is not revised, a later defect gets a new ticket.

## Fixed-candidate reviews

A review freezes one integration commit and records what an independent Reviewer found and what Main ruled. Review facts are shared project data (schema v5, carried by the same backup/restore snapshot), so a restart or another backend reads the same plan, candidate, findings and rulings. Candidate and drift checks run on the execution backend that owns the checkout; the data authority only stores the validated facts.

```text
GET  /api/projects/:projectId/reviews?developmentId=:developmentId
GET  /api/projects/:projectId/reviews/:reviewId
POST /api/projects/:projectId/reviews
```

A review returns `reviewId`, `developmentId`, `kind` (`independent`/`combined`), `state` (`in_review`/`passed`/`failed`/`drifted`), `revision`, `candidate` (`{ commit, tree, branch, workspace }`), optional `author` (`{ callId, agentId, workspace }`), optional `previousReviewId`/`previousCandidateCommit`, `changedPaths`, optional `mapping` (a final review's `[{ rowId, requirement, evidence }]`), optional `reviewer` (`{ taskId, callId, agentId, workspace, conclusion? }`, where `conclusion` is `{ verdict, previousFindings?, at }` once imported), `findings`, `reworks`, optional `verdict` (`{ summary, checks, at, approach? }`, `approach` being `{ kind, basis, at }`), optional `drift`, timestamps. A finding carries `findingId`, `title`, `detail`, `location?`, `blocking`, `basis?` (the criterion id or floor class a blocking finding cites), `candidateCommit`, `state` (`open`/`suggestion`/`fix_claimed`/`fixed`/`reopened`/`dismissed`; `suggestion` is a non-blocking finding, `reopened` a claimed fix the re-review found not fixed), `checks`, `rawFailure?`, optional `source` (`{ role: "reviewer", callId, agentId }`, the session that produced it), optional `ruling` (`{ decision, category?, basis, candidateCommit, at }`), optional `fixedCommit` and optional `verifiedByReviewId` (the later review that verified the fix). A check is `{ name, command?, exitCode, output, at }`. A plan returns `developmentId`, `channel`, `basis`, `checks`, `candidate` (the integration version those checks ran on) and `revision`.

POST bodies carry `action`; actions that bind or verify a work item (`attach_reviewer`, `record_rework`, and `freeze_candidate` with `authorCallId`) require the Task-scoped route or `x-cowork-task-id`, because the role, agent and checkout come from that Task's durable queue rather than from the request:

- `plan` (`developmentId`, `channel` `self`/`independent`/`combined`, `basis`, `checks`) records Main's channel decision, the author's own verification and the integration commit/tree those checks ran on. `self` requires at least one check and a clean checkout; the program captures the version, so a later commit does not inherit the old checks (`self_check_stale` until Main records verification for the current version). A review already opened for the development cannot be replaced by a `self` plan (`review_channel_downgrade`).
- `start` with `ticketId` (`developmentId`, `ticketId`, optional `previousReviewId`) is the review of one ticket on the `direct` and `full` routes. `direct` refuses a review of the integration checkout (`ticket_required`); `full` takes one only as its final review, below. The ticket must be running or in rework and its Executor call finished (`ticket_work_running`); the program freezes that Executor's own clean checkout, records the call as `author`, and refuses with `ticket_scope_exceeded` when a file changed since the checkout forked from the integration checkout is outside the ticket's `scope` (a scope entry is a file or a directory). A re-review names a previous review of the same ticket. The ticket becomes `in_review`; a passed verdict makes it `passed`, a failed or drifted one `rework`.
- `start` without `ticketId` (`developmentId`, `mapping`, optional `previousReviewId`) on the `full` route is the final review of the whole requirement. Every ticket must be merged into the integration checkout (`final_review_early`), the checkout must be the last integration commit (`candidate_changed`) and no other final review may be open (`review_open`). `mapping` is Main's acceptance mapping for this candidate, required every round (`final_review_mapping_missing`): 1–50 rows of `{ requirement, evidence }`, numbered `M1`, `M2`… and stored on the review. The final Reviewer's brief lists the rows as claims to verify, and a blocking finding may cite a row id as its basis besides `CC<n>`. Any other review refuses a mapping (`review_mapping_unexpected`). Before that, as in Workloop, the freeze checks the document registry, the `## 文档` (or `## Documents`) table of `路径 | 类型 | 领域` rows in the requirement checkout's root `AGENTS.md` (types `instructions`, `standards`, `glossary`, `adr`, `history`, `pitfalls`, `product`, `generated`, `unsorted`; a row covers a file or the directory below it; the root `AGENTS.md`, `CLAUDE.md` and `docs/pitfalls/` count without a row): with no table, 409 `documents_registry_missing`; otherwise 409 `documents_unregistered` naming malformed rows, Markdown documents not covered, rows covering no document, and two rows of `instructions`, `standards`, `glossary` or `product` sharing a domain. When the base had no table every problem counts; otherwise only those not already at the base, so a row that went stale earlier does not hold this requirement. A fix ticket repairs it; `quick` and `direct` developments are not checked. It has no author: a defect it finds becomes a new fix ticket, and the re-review names the previous final review, whose pass settles the fix-ruled findings along the chain. Qualification on `full` then needs the latest final review passed on the current version (`final_review_missing`, `review_<state>`); the merge's acceptance records its `reviewId` and the execution backend checks it again.
- On every route a new review follows the latest review of its chain (the ticket's, the final reviews, or the development's on `quick`), read from the stored reviews: an open one refuses with `review_previous_open`, the same candidate as a failed one with `review_candidate_unchanged`, and a `previousReviewId` other than that review with `review_previous_mismatch`. Leaving it out does not start a new chain, except for another review of a version that passed. Bringing a ticket in and opening a review run one at a time per development.
- `start` (`developmentId`, `kind`, optional `previousReviewId`, optional `authorCallId`) on the `quick` route requires a recorded non-`self` plan (`review_plan_missing`/`review_channel_mismatch`), then freezes the clean integration checkout's current commit and tree. A `combined` kind needs a `combined` channel. A re-review needs a different candidate, every finding of the previous review ruled (`review_previous_unruled`, on every route), and records the previous review plus the paths changed since its candidate; fix-ruled findings must have a recorded rework when the candidate came from a delegated Executor.
- `attach_reviewer` (`reviewId`, `callId`) reads that call from the Task queue, requires a Reviewer, verifies the item's own `work-items/<callId>` checkout and refuses a session with the author's agent. A review belongs to the Reviewer bound first: the same call is an idempotent retry, another call is refused with `review_reviewer_bound` and must use its own review record. A Reviewer is bound only once its call has finished (`review_reviewer_running` before that), and binding imports its submitted conclusion: blocking findings become `open`, the rest `suggestion`, and on a re-review each claimed fix of the previous round becomes `fixed` or `reopened`, an unfixed one carried into this review under its id. A conclusion that breaks the review's rules is refused with `review_conclusion_invalid` and the Reviewer is not bound, so another Reviewer can take the review. An unreadable checkout is refused with `review_site_unavailable`; otherwise a HEAD, tree or tracked-file change marks the review `drifted` and returns 409 `review_drifted`.
- `record_finding` (`reviewId`, `title`, `detail`, `blocking`, `basis` when blocking, `checks`, optional `location`/`rawFailure`) is only for a custom Reviewer that answers in prose; a Reviewer with a submitted conclusion is refused with `review_conclusion_imported`. A blocking finding must cite a criterion of the review or a floor class (`review_finding_basis`).
- `rule_finding` (`reviewId`, `findingId`, `decision` `fix`/`dismiss`, `basis`, and `category` `false_positive`/`out_of_scope`/`deferred`/`other` for a dismissal) records Main's ruling; a dismissal keeps the finding and its reason. A suggestion can only be picked up to fix; a claimed fix on a failed review can still be dismissed. Findings stay rulable after the review becomes `failed` or `drifted` — those states close the verdict, not the finding lifecycle. A `passed` review refuses further rulings, and a closed review refuses new findings.
- `record_rework` (`reviewId`, `findingIds`, `fromCallId`, `continuationCallId`) verifies from the durable queue that the continuation reused the original agent, Pi session history and checkout, and is refused with `review_rework_not_continuation`, `review_rework_identity` or `review_rework_site` otherwise. It is allowed on `in_review`, `failed` and `drifted` reviews.
- `change_approach` (`reviewId`, `approach`, `basis`) is allowed on the latest failed review of a chain once it used its rounds: a ticket's reviews, or the requirement's own reviews (the `full` final reviews or a `quick` change's), share a budget of two failed rounds, and `start` refuses another one with `review_round_limit`. A ticket takes `fresh_executor` (the next round must come from another Executor agent) or `revised_ticket` (the ticket must be revised after the failure); the requirement's own review takes `new_plan` (on `full`, a new ticket must exist). Each grants two more rounds and is used once per chain; the next `start` refuses with `review_approach_not_applied` until it is carried out. `deliver_partial` needs every open or fix-claimed finding dismissed first and accepts the failed review as it is: its ticket becomes `passed`, and qualification counts it as approved.
- `complete` (`reviewId`, `verdict` `passed`/`failed`, `summary`, `checks`) re-checks the Reviewer's checkout against the candidate; a passed review needs a check receipt and no open or fix-ruled finding. A passed review settles fix-ruled findings along its explicit `previousReviewId` chain: each finding gets `fixedCommit` from the first linked review created after its rework (or ruling) evidence, and `verifiedByReviewId` from this pass. Findings outside that chain stay untouched, so an unrelated open finding still blocks delivery until Main rules it.
- `delivery` (`developmentId`) returns `{ developmentId, eligible, channel?, candidate?, approved?, reviewId?, kind?, independentReview, reasons }`. A `self` plan qualifies on its own only while its captured candidate still matches the current integration commit and tree, no review has been started (`review_started`), and the checks are present. Otherwise the latest review must have passed, its candidate must still be the current integration commit and tree, and every finding across the development must be dismissed or fixed. On the `direct` and `full` routes the requirement qualifies when every ticket is `merged` and the integration checkout is still the commit and tree the last `integrate_ticket` produced; the channel is `independent` and the merge acceptance carries `tickets: true`, so the execution backend re-checks the same facts and reruns, by default, the checks each ticket passed when it was brought in (`tickets_missing`, `tickets_pending`). `self_check_stale`, `candidate_changed`, `findings_open`, `review_drifted` and the other `reasons` explain a refusal. `query`/`get` read reviews back; the `GET` above also returns `plan` and `qualification` for a named development.

`continueCallId` on `call_subagent` is the original-context rework contract: it must name a finished Executor work item in this Run, reuses that item's agent id, Pi session history and checkout, and appends the rework instruction as the next turn of the same session instead of creating a fresh Agent or repeating completed work. A running item, a Reviewer, or an item that already has a continuation in flight is refused.

## Project merge entry

Each Main keeps its own requirement checkout, but the target branch has one writer: the execution backend named by the merge configuration. Merge operations are shared project data (introduced in schema v6, carried by the same backup/restore snapshot; the current schema adds the v7 delivery rows), so two backends apply through one project queue instead of a per-requirement or per-Main lock.

```text
GET  /api/projects/:projectId/merges[?developmentId=]
GET  /api/projects/:projectId/merges/:mergeId
POST /api/projects/:projectId/merges
GET  /api/tasks/:taskId/merges
POST /api/tasks/:taskId/merges
```

A merge returns `mergeId`, `developmentId`, `requirementId`, `state` (`waiting`/`applying`/`merged`/`conflict`/`check_failed`/`failed`), `revision`, `requestedBy`, `executionBackendId`, `targetBranch`, `candidate` (`{ commit, tree, branch, workspace }`), `acceptance` (`{ channel, approvedCommit, approvedTree, reviewId?, tickets?, retro?, ledger? }`, where `ledger` is `{ summary? | summaryUnchanged?, history, description? }` and `retro` is `{ outcome: "pitfalls" | "nothing", summary, signals: { reworkRounds, changedApproach, dismissedBlocking, failedMerges }, improvements?, auto?, at }` and `improvements` lists `{ requirementId, title }`), `checks`, `reasons`, optional `combinedBase`, `expectedTarget`, `mergeCommit`, `detail`, `ownerStartedAt`, timestamps, and — once merged — an idempotent `receipt` (`{ mergeId, developmentId, requirementId, candidateCommit, mergedCommit, targetBranch, mergedAt }`). A check is `{ name, command, exitCode?, output?, at? }`; before it runs, only the command is recorded.

POST bodies carry `action`:

- `request` (`developmentId`, optional `checks` of `{ name, command }`, optional `retro` of `{ pitfalls }` or `{ nothing }`, either with optional `improvements` of up to 5 `{ title, content }`) requires an eligible delivery qualification whose approved candidate is still the current integration commit and tree, or that commit plus a commit that changes only `docs/pitfalls/` (the requirement's retro). Every last merge carries the requirement's retro: with no rework round, change of approach, dismissed blocking finding or failed merge in the records the program records `nothing` itself (`auto`); otherwise the request is refused with 409 `retro_missing` until Main passes `retro`, and with 409 `retro_mismatch` when `retro` and the pitfalls commit disagree. The pages that commit changes are checked against the entry shape (five fields `Trigger`, `What happens`, `Confirm`, `Avoid`, `Sources` of at most two sentences each; no commit SHA, absolute path, record id or round/test count; `Sources` a title and a `YYYY-MM-DD` date without links; every entry in one row of `docs/pitfalls/README.md` and every row's anchor resolving), else 409 `pitfalls_malformed` naming the page, entry and field. A retro Main passed on an earlier attempt is reused. Each improvement is registered as a ledger requirement whose source is `{ kind: "internal", reference: "retro:<requirementId>" }` just before the merge operation is recorded, once per title per requirement; a requirement registered that way is refused 409 `retro_improvement_nested` when its own retro passes improvements. Every request also carries `ledger`: `summary` (the whole summary rewritten as the feature now is) or `summaryUnchanged` (why it stays), one `history` line, and `description` when what the feature does, whom it serves or its scope changed, else `descriptionUnchanged: true`; without it the request is refused with 409 `ledger_update_missing` (an earlier attempt's `ledger` is reused), a misc requirement's `description` with 409 `requirement_misc_fixed`. The ledger is written only when the delivery is recorded, in the same revision as the delivery note, and the history line names the development; a merge that never lands leaves it unchanged. After the merge, `next` names the registered requirements to develop. Once 10 or more developments merged since the ledger's last tidy, a merged development's `next` also tells Main to tidy the ledger. Without explicit checks it reuses the self plan's commands, else the passed review's. A retry for the same candidate returns the existing operation; a merged candidate returns the same receipt without creating another target commit; a new version needs its own operation. When the requesting backend is the execution owner it also applies the project queue.
- `apply` reconciles operations a previous process of this backend left `applying`, then processes waiting operations in creation order. It is refused with 409 `project_git_owner_mismatch` on any other backend.
- `create` records an operation an authenticated backend qualified on its own host; `claim` and `update` are accepted only from the configured execution backend. `query`/`get` read the shared rows.

The execution backend builds the combined version in a real detached worktree at the current target, merges the candidate, runs the checks there and records the combined base, the commit about to be published and the receipts before touching the ref. A real conflict leaves the target and the candidate branch alone and records `conflict` with the conflicted paths. A failing check records `check_failed` with its exit codes and output. The target moves by fast-forwarding the worktree that has the branch checked out — a dirty file the merge would touch refuses instead of being overwritten — or by compare-and-swap on the ref. If the target advanced during the attempt, the operation rebuilds on the new tip and re-runs the checks; after repeated movement it records `failed` for a retry.

A crash between the target update and its record leaves `applying` with the recorded `mergeCommit` and `expectedTarget`. A new process of that backend compares them with the actual branch: a tip equal to `mergeCommit` only needs the record completed; a tip still equal to `expectedTarget` means the compare-and-swap never ran, so the same commit is published; anything else requeues the operation on the current target. It never merges the same candidate twice. The merged operation's receipt is what the ledger and board ticket reconciles idempotently.

## Delivery records

A delivery exists only after the target branch actually contains a merge. It starts from the merged operation's `receipt` (`mergeId`, `developmentId`, `requirementId`, `candidateCommit`, `mergedCommit`, `targetBranch`, `mergedAt`) and is shared project data (schema v7, carried by the same backup/restore snapshot). A receipt that does not match a shared `merged` row is refused with 409 `delivery_not_merged`; the UI, a model report or a request body never creates a delivery on its own.

```text
GET  /api/projects/:projectId/deliveries[?developmentId=]
GET  /api/projects/:projectId/deliveries/:deliveryId
POST /api/projects/:projectId/deliveries
GET  /api/tasks/:taskId/deliveries
POST /api/tasks/:taskId/deliveries
```

A delivery returns `projectId`, `deliveryId`, `developmentId`, `requirementId`, `mergeId`, `candidateCommit`, `mergedCommit`, `targetBranch`, `mergedAt`, optional `boardId`, `state` (`pending`/`synced`), `attempts`, optional `lastError`, `syncedAt` and timestamps. One row exists per merge; repeating the same receipt updates that row instead of writing a second delivery.

Applying a delivery writes the ledger and board together with the `synced` state: the development becomes `merged`, the requirement gains a `delivery` reference carrying `mergedCommit` and a revision note naming the branch and merge, and the requirement's open board card — when the work came from the board — becomes `pending_release` with its owner, handling Main and the actual merge commit. An internal requirement stays ledger-only and creates no board item. A delivery failure leaves the `pending` row and its `lastError` readable; `pending_release` never advances to a published state in P4.

POST bodies carry `action`:

- `query` (optional `developmentId`), `get` (`deliveryId`) and `view` (`developmentId` or `requirementId`) read. The view returns `{ projectId, development, stage, plan?, reviews, qualification?, merges, delivery?, board?, diff?, roles, tickets, pendingSync? }`, where `tickets` is the requirement's ticket list, where `stage` is `developing`/`reviewing`/`merge_pending`/`merged`/`delivered`, `roles` are the recorded Executor/Reviewer work items with their durable status when this host still has them, `diff` is the committed baseline-to-candidate change read from the checkout that owns it, and `pendingSync` names a locally published merge whose shared delivery has not been accepted yet. The same view is reachable from the project route, the Task route and the `project_development` tool (`delivery_status`).
- `diff` (`developmentId` or `requirementId`, optional `path`) returns `{ base, head, candidateCommit, mergedCommit?, path?, patch, truncated, contents }`: the unified patch of the accepted change and each changed file's text at the same commit. Only a file the delivery diff already lists may be named; a patch past 200 KB is cut and marked `truncated`; a checkout this host does not own returns 409 `delivery_patch_unavailable`, and a declared remote backend gets 403 `delivery_owner_only` because it must ask its own execution host. The work panel's preview reads this instead of running Git in the page.
- `locate` (`developmentId` or `requirementId`, `path`) returns `{ absolutePath }` of one changed file in the checkout this backend owns, under the same rules as `diff`; a file the change deleted returns 409 `delivery_file_missing`. Only the desktop host calls it, for the preview's "Open" button.
- `retry` (`deliveryId` or `developmentId`) re-applies the persisted delivery or completes the latest merged operation of that development; a retry cannot create a second delivery or a second target commit.
- `sync` (`receipt`) is accepted only from the authenticated execution backend that owns the merge and is how a secondary backend records what it published. The authority verifies the receipt against its own merged row before writing anything.

A merge updates real Git before the shared record can be written. The execution backend keeps that fact in `ATRIA_HOME/runtime/delivery-sync/<project-hash>.json` (0600, atomic replace) with the merge identity, expected target, published commit and last error. Any later read, `apply_merge`, retry, process restart or the execution host's bounded in-process retry task retries from that outbox and from the merged row: a row left `applying` is completed from the real branch, the delivery is written once, and the entry is removed. The retry task starts with the host, never overlaps a tick, only looks at local pending facts, and stops when that service instance stops; a recovered shared service therefore completes the delivery without a UI read, a new merge or a manual retry. Another backend's read does not claim or complete an operation it did not publish. The local Run finishes independently of the shared service; an unreachable authority therefore leaves a visible pending state rather than failing the merge or asking Main to repeat it. Ledger/board writes are idempotent, so a retry after a crash or restart does not repeat development, merge or delivery.

## External Main capacity

External Main capacity is a per-backend execution fact, so it is configured and served by the host that runs the processes. The quotas live in that host's public configuration; the slots, the queue and the index of the host's external sessions live beside the backend identity (`ATRIA_HOME/runtime/main-capacity/state.json`), never in shared project data.

```json
{ "mainCapacity": { "resident": 2, "continuation": 1 } }
```

A host without `mainCapacity` keeps its previous internal-only behavior and refuses to create an external session. `resident` is a positive integer, `continuation` a non-negative integer; both cap at 32. An invalid value stops configuration reads with an error instead of guessing.

```text
GET  /api/main-capacity
POST /api/main-capacity   { action: "configure", resident?, continuation? }
POST /api/main-capacity   { action: "retry", requestId }
```

`GET` returns `configured`, `settings` (`resident`, `continuation` or null), `running` (`requestId`, `projectId`, `projectName?`, `sessionId`, `taskId`, `runId`, `kind`, `requirementId?`, `pid?`, `startedAt`), `queued` (`requestId`, project and session identity, `kind`, `requirementId?`, `position`, `origin` = `http|worker|cli|internal`, `enqueuedAt`, `state` = `queued|failed`, `attempts`, optional `lastError`; a demand already being dispatched is listed under `running` instead), per-project `projects` with the external `regular` and `continuation` session counts this backend owns, and `projectsComplete` (`false` plus `projectsError` when a shared session read failed — the counts are then unknown, never zero). `POST` validates and commits the quotas; a reduction below a running kind or below any project's saved regular sessions is refused with 409 `main_capacity_in_use` and a message naming the reason, which never ends running work.

A regular external Run occupies one `resident` slot and a continuation Run one `continuation` slot; a slot is never borrowed from the other kind. An internal Main spends no external capacity. The number of external regular sessions a project may save equals `resident`; saved sessions do not occupy a running slot, and continuation sessions do not count toward the project limit. Both limits are computed from the shared Main session rows, so every backend and every engine sees the same saved sessions.

A slot is occupied while its Main has a turn in flight or unfinished delegated work to wait for (a non-terminal work item, or a settled one whose callback has not reached Main). A resident Main releases its slot at the boundary where the turn settles with nothing left to run and keeps its process; the next message is admitted again before it is delivered, so an idle Main is never counted as running work and is never killed to free a place. A paused Main whose delegated work is still unfinished keeps its slot, so the resume reaches the same process without queueing for a place; the slot is released once that work is over. The slot is also released when the process exits (closed session, idle timeout, a model request that cannot continue, or backend shutdown), when the start fails, and by reconciliation when the recorded process is no longer alive or its turn is over. Releasing a slot starts the next eligible waiting demand in arrival order; continuation capacity is only ever used by continuation demands. A backend restart keeps a demand whose process is still alive, releases the place of one that settled its turn, and never starts the same request twice: a dispatch interrupted before a process existed is dropped rather than replayed. Reconciliation only ever inspects or affects this host's own processes.

```text
POST /api/tasks/:taskId/run   → 202 { status: "running" } | { status: "queued", queuePosition }
                              | { status: "duplicate", runId?, queuePosition? }
```

`POST /api/tasks/:taskId/run` admits an external session through this budget before recording anything. When no slot is free the response is `202` with `status:"queued"` and a position; no Run row is written, no process starts and the Task keeps its previous status. A demand for a Task or requirement that already owns a slot or a waiting position returns `status:"duplicate"` with the existing identity instead of running twice. `cancel` on a queued Task drops its waiting demand. The Main worker and the interactive CLI reserve from the same file and lock before starting a Main; when the budget is full the worker reports `main_capacity_queued` and leaves the demand to the program's queue, and an interactive launch refuses with the reason.

A submitted human answer or a timed wake is a durable demand too: when the budget is full it joins the same queue (`origin:"internal"`) instead of being lost, and the program resumes it when a slot frees. `POST /api/tasks/:taskId/human/resume` reports `status:"queued"` in that case.

A dispatch that fails for a recoverable reason (shared service unreachable or authentication unavailable at the session call) releases its unused slot but keeps the accepted demand: it stays `queued` with a `lastError` and is retried by the capacity loop with exponential backoff. A permanent refusal (an explicit connection gone, the session or Task removed, a shared 404/409 before the Run exists) does not delete the input either: it releases the unused slot and marks the demand `failed` immediately with its `lastError`, without spending retry attempts. Either way the input and its choices stay durable and visible in `queued`; `POST /api/main-capacity { action: "retry", requestId }` puts a failed demand back in line. A restart mid-dispatch checks the local Task: a recorded Run is never started twice, a demand whose Run never existed is re-queued.

A Main dispatched by the program registers its own pid in its slot before it does any work, so the interval between spawn and the parent recording the pid cannot hide a live Main. Reclaiming a slot judged stale is a single check-and-remove inside the capacity store: it is removed only when it still names the same request, Run, host and bound/pid-less state as the observation, so a Main that registered in between keeps its slot and is counted. A Main whose reservation has already been released refuses to start instead of running uncounted.

A resubmission is idempotent only when the input identity matches — text, body, attachments, explicit connection/model/thinking choice and resume/retry identity. A **different** message on a queued or running Task returns 409 `main_capacity_conflict` instead of a success, so the caller keeps the draft; the same task or requirement with the same input still returns `duplicate`.

A queued demand keeps the request's identity — Task, session, requirement, `retryRequestId`, explicit `profileId`/`model`/thinking level and attachment ids — but no resolved model default and no credential. The default connection, model and reasoning profile are resolved by the host role resolver at the moment the demand actually gets a slot, so a host or project default changed while it waited applies to that Run; an explicit choice stays the user's and a retry keeps its saved request snapshot. Saving two external sessions at the same time is serialized, so a project can never exceed its `resident` saved regular sessions.

## Demand board

A board card is one external piece of work on a ledger requirement, linked by `requirementId`, with its own `title`, `content` and `source`; a requirement has at most one card open (neither `cancelled` nor `pending_release`) at a time. An internal `create` on the ledger stays ledger-only and creates no board item; only a controlled external `publish` creates one. Entries keep the owning `backendId`, entry kind, state, revision, the handling Main (when claimed) and an append-only event history. The handler identity is `{ backendId, projectId, taskId }`; it names exactly one project Main session through the session's own `{ backendId, projectId, taskId }` triple, so a claim can be resolved to the conversation that handles it without a second claim model or a directory identity.

```text
GET  /api/projects/:projectId/board
GET  /api/projects/:projectId/board/:boardId
POST /api/projects/:projectId/board
GET  /api/tasks/:taskId/board
POST /api/tasks/:taskId/board
```

`GET` returns `{ projectId, entries }`; the single-item read returns `{ entry, events }`. An entry has `projectId`, `boardId`, `requirementId`, `title`, `content`, `entryKind:"external"`, `source`, `state` (`pending`, `claimed`, `in_progress`, `paused`, `cancelled`, `pending_release`), `revision`, `backendId`, optional `assignment` (`{ kind: "user"|"main", actorId, handler?, assignedAt }`), optional `delivery` (`{ mergeId, mergedCommit, mergedAt }`) and timestamps. `delivery.mergedAt` is the merged operation's own timestamp; the entry's `updatedAt` and the `delivered` event's `createdAt` are the later synchronization times.

POST bodies carry `action`:

- `publish` (`requestId`, `title`, `content`, `source` with `kind:"external"`, optional reference, optional `requirementId`) creates the card and returns 201: without `requirementId` it also creates its requirement in the same transaction, with `content` as the summary; with one it joins that active requirement, refused with 409 `requirement_retired` or, while another card is open, `board_requirement_open`. `source.kind` must be `external`.
- `claim` (`boardId`, `expectedRevision`, `requestId`, optional `handler`) moves `pending` to `claimed`. The Task-scoped route fills `handler` from the current Task, so a Main cannot name another backend or project.
- `pause` (`claimed`/`in_progress` → `paused`) keeps the owner; `release` clears ownership back to `pending`; `cancel` is terminal and stays visible. A stale `expectedRevision` returns 409 `revision_conflict` with `currentRevision`. `pending_release` is written only by a real delivery; it keeps the original owner and handling Main, attaches the actual merge commit and refuses release/pause/cancel. Publishing is a later phase, so P4 never advances beyond this state.

Every write carries a `requestId`: repeating the same request returns the committed entry and appends no second event. Two backends claiming at the same revision produce one winner; the other receives 409. Only the serving host or the current owner may pause, release or cancel (`403 board_assignee_required` otherwise). Handler mismatches return `board_handler_mismatch` or `board_project_mismatch`; reusing a request id for a different action returns `board_request_reused`.

A secondary backend with `projectData.authority` reads and writes this same surface through its authenticated client. Its `POST /api/project-data/bindings` stores that backend's own local folder binding, and an authenticated remote request never resolves a shared path as a local execution directory. An unreachable authority returns `503 storage_unavailable`; a revoked session returns `401 shared_auth_failed`. Neither reports a successful claim nor transfers ownership.

## Memory

Main's memory, one Markdown file per memory under `ATRIA_HOME/memory/user/` and `ATRIA_HOME/memory/projects/<projectId>/`. The index Main reads is derived from the files. Design: [记忆与上下文压缩设计](memory-and-compaction-design.md#四记忆).

- Settings: `GET /api/memory?scope=user|project[&projectId=]` lists memories (newest first) and, for a project, `enabled`; `GET /api/memory/read?…&name=` returns one; `POST /api/memory/save` takes `{ target: { scope, projectId? }, memory: { name, type, description, body }, previousName? }` and renames when `previousName` differs; `POST /api/memory/delete` takes `{ target, name }`; `POST /api/memory/enabled` takes `{ projectId, enabled }`.
- Main: `GET /api/tasks/:taskId/memory` returns the user memories, the project's when it is on, and the `index`; `POST` takes `{ action: "list" | "read" | "write" | "delete", scope, name?, memory? }`; a `read` without `scope` looks in the project, then the user scope, and the answer names the scope it found. The project always comes from the Task. A switched-off project answers `403 memory_project_disabled`; a Task without a project can use only `user`. Delegated processes carry no run credential, so Subagents have no memory.
- `type` is `user`, `feedback`, `project` or `reference`; `name` is lowercase letters, digits and hyphens (up to 64); `description` up to 150 characters; `body` up to 4,000; up to 80 memories per scope. Invalid input is `400` with a `memory_*` code.

## Node resources

`GET /api/node-resources` returns this machine's `{ system, cpu, memory, disk, memoryBytes, diskBytes }` for its card in Settings → Nodes: `system` is `macos`, `windows` or the Linux `ID` from `/etc/os-release`; `cpu`, `memory` and `disk` are used percentages (CPU since the previous read, memory without reclaimable cache, disk of the volume holding the user's home). The page reads it every 5 seconds while the Nodes page is open and visible.

## Link previews

Web link chips in messages show the linked page's icon and title. `GET /api/link-preview?url=` returns `{ url, title, icon }`, where `icon` is a `data:` URL or empty. The backend reads each public http(s) address once (6 s timeout, at most 512 KB of HTML and a 64 KB icon, up to three redirects) and keeps the result under `ATRIA_HOME/cache/link-previews/` for 7 days, or 1 day when nothing could be read. An address that names or resolves to this machine or a private network, carries credentials or uses another scheme is refused with `422 link_preview_refused`.

## Task APIs

```text
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks
PATCH /api/tasks/:taskId
POST /api/tasks/:taskId/run
POST /api/tasks/:taskId/interject
POST /api/tasks/:taskId/interject/:messageId/steer
POST /api/tasks/:taskId/interject/:messageId/cancel
POST /api/tasks/:taskId/action
GET  /api/tasks/:taskId/stream
GET  /api/tasks/:taskId/tool-call?callId=<toolCallId>[&runId=<runId>]
GET  /api/tasks/:taskId/agents/:agentId/trajectory
```

Create a Task:

```json
{ "taskId": "optional-id", "goal": "Analyze the repository", "projectId": "project_<uuid>" }
```

Start or continue Main:

```json
{ "prompt": "Read the current task and continue from its saved session" }
```

The response is accepted asynchronously:

```json
{ "taskId": "task-1", "runId": "main-...", "status": "running" }
```

If the input has been accepted and the Main process fails to start, the endpoint returns HTTP 202 with `taskId`, `runId`, `status: "failed"` and `error`. The client displays the failure for that Run.

The Runtime owns Task transitions. The UI may request `pause`, `interrupt`, `cancel`, `resume`, or `complete`, but it must render the returned state rather than assuming the action succeeded. `interrupt` stops the turn Main is producing and leaves the session, the Task and its Subagents running; `cancel` closes the session and stops it together with the Subagents it started.

`POST /api/tasks/:taskId/action` with `{ "action": "pause" }` records a durable pause request for the Task's running Main and returns the updated catalog entry. Main reads that request at the next step boundary — after the in-flight tool call or model reply, before another tool call or model request — then sets `task.status: "paused"` and writes `pause.pausedAt`. A pause is refused with `409` when the Task has no live Main process or no turn is running. Work already produced (files, candidates, development records) stays in place, and a Task that finished its step before the boundary is `completed` rather than `paused`. The resident Main process stays while paused: callbacks and other arriving work stay durable in its Inbox, and its idle timeout still runs when no Subagent is working. Continue with `POST /api/tasks/:taskId/run` and `{ "resume": true }`: it reuses the same Run, process and Pi session, delivers the work that waited, and starts from the next step instead of repeating finished work; when the paused Run has no slot left (its delegated work is over) the resume is admitted as a demand, so a full budget queues it. A paused Task keeps its external slot while delegated work is unfinished, and `cancel` from `paused` is the normal terminal cancellation. The catalog and Task detail expose the optional `pause` object (`requestedAt`, `pausedAt`) and the `paused` status; `runtime.active` stays false while no turn runs.

`POST /api/tasks/:taskId/action` with `{ "action": "interrupt" }` aborts the turn Main is producing at its next safe point and returns `202`. The session, the Task and any running Subagents stay, so the next message continues in the same process. With no running turn it returns `409`.

`POST /api/tasks/:taskId/action` with `{ "action": "compact" }` starts a new context window after one request for the model's summary of the window being left. It returns `202` when the command is queued in the resident Main’s Inbox, or `200` after updating an offline session. A new session without history returns `409`. Task detail includes `contextUsage` (`tokens`, `contextWindow`, `window`) when estimated usage is available and `contextWindows` listing each window change (`id`, `timestamp`); the handoffs themselves stay with Main's session.

`POST /api/tasks/:taskId/action` with `{ "action": "cancel" }` closes the session: it stops the Main process and cancels the Subagents that session started, and a running Task becomes `cancelled`. Closing a Task that already completed ends its idle process without rewriting the completed outcome.

`POST /api/tasks/:taskId/run` with `{ "resume": true }` and no prompt continues the saved Main turn without adding a user message or recovery instruction. It requires a prior run and retains saved tool results. The full accepted input is saved privately as `runs/<runId>/main-input.json` before process launch; an input missing from the Pi transcript after a startup failure is restored once. For a captured failed or interrupted Main request, continuation replays its exact serialized body and original model, ignoring a replacement `model` selection for that retry, as long as the snapshot records the running Pi version. A snapshot written by another Pi version, or one that records none, is not replayed: the retry continues the same turn with the context rebuilt from the session, and its new snapshot states why. The returned `model` identifies the model actually used. A completed request is never selected for replay; a new nonempty prompt invalidates the prior retry slot and uses current settings. Changed project/endpoint returns `409` with `code: "main_retry_context_changed"`; an invalid snapshot, including one without execution ownership, returns `400` with `code: "main_retry_snapshot_invalid"`, retaining the saved record and prior Run state. Legacy sessions with no request snapshot retain context-based continuation. An empty prompt without `resume: true` is rejected. Supplying a nonempty prompt remains a new user turn, including with `resume: true`.

`GET /api/tasks/:taskId` exposes optional `retryRequest: { requestId, model }` only for an idle failed/interrupted Main request. It never exposes the private request body. `retryRequestUnavailable: true` reports missing or damaged recovery data for a model failure; the UI preserves drafts and rejects manual retry rather than silently regenerating the request. `POST /api/tasks/:taskId/run` with `{ "resume": true, "retryRequestId": "<request UUID>" }` resends that original serialized request using its original model and protocol; omit `prompt` and new attachments. The service validates the Task/Run/request identity under the startup lock, rejects stale or concurrent retries and completed/cancelled requests, and requires the original service address. Current authentication is resolved normally and is never stored in the recovery record. A later tool-loop request serializes its new results normally. Startup failures that have no model request retain the accepted-input continuation described above. Legacy histories without a raw recovery record can continue their saved context but cannot reconstruct exact unsaved wire bytes.

Exact retries also require the original canonical working directory and Task storage root. A changed directory or storage root returns `409` with `code: "main_retry_context_changed"` before launch without replacing the archived request or history; restore the original scope to retry. Missing execution ownership on older readable snapshots reports `retryRequestUnavailable: true` and rejects replay with `400` / `main_retry_snapshot_invalid`.

`GET /api/tasks/:taskId` also returns optional `editableMessage: { messageId, versionId, runId, scopeToken, body, attachments }` for the latest accepted composer/Inbox user input present in the active Pi branch. Internal continuation controls, human answers and pending queue notifications are not editable. `editableMessageError` reports an invalid message/attachment reference while retaining readable history. `conversationVersion` identifies the selected branch so renderers discard cached events from a replaced version. `conversationVersions` contains metadata only (`versionId`, source `messageId`, `currentMessageId`, `groupId`, `replacedBy`, `preview`, `createdAt`, `activityCount`), without archived message/event bodies or private session/retry paths. Repeated edits of one user turn retain the same group and point to its newest active message.

`GET /api/tasks/:taskId/message-versions/:versionId` returns `{ messages, runtimeEvents }` for a version belonging to that Task. Version IDs are opaque safe identifiers (legacy Pi Run/session IDs remain supported). Malformed IDs return `400`; unknown or cross-Task IDs return `404`. The conversation UI shows only the current version; this endpoint retains access to archived records.

`POST /api/tasks/:taskId/messages/edit` accepts `{ messageId, versionId, runId, scopeToken, editId, body, attachmentIds, textAttachments?, model? }`. `editId` is a UUID retained for a lost-response retry; `scopeToken` is the SHA-256 scope identity supplied by task detail. The Task/project operation lock validates idle process state, active Run, latest accepted user, version and current canonical project ownership. A turn that is only parked on a pending durable question counts as editable: the Run service stops that parked process and relaunches it on the edited branch, retiring the question, while a reply that is still arriving is refused. Conflicts return `409 / main_message_edit_conflict`; they never queue the edit into an active run. Empty bodies require at least one attachment. Existing upload IDs are verified against this Task’s original files; new uploads are validated and attached to this Task. Legacy inline text attachments retain the existing 128 KiB / three-file limits.

An accepted edit creates a new Run and an explicit Pi session containing only entries preceding the replaced user input; subsequent runs select that same session. Pending and unanswered human questions created after that input in the replaced Run are cancelled with the old branch, so they cannot block the new request or accept late decisions. Questions outside that tail retain their state; ordinary continuation still requires pending questions to be answered. An explicit project-folder change forks the selected branch into the new canonical working directory and atomically updates the session pointer while preserving its version identity and old transcript. The old session, user input, replies, tool activity and private original retry snapshot remain archived. Editing retires the active exact-retry slot and uses current model settings; it does not replay an old failed request body. Repeating an identical `editId` returns the first Run without spawning another process; changing its body or target is rejected. Startup rejection before acquiring a process restores the prior version, retry state and retired questions. Recovery before launch readiness also restores those questions; recovery after readiness retains their cancellation with the accepted branch. File modifications and external actions are not rolled back or reported as newly executed evidence.

`POST /api/tasks/:taskId/fork` accepts `{ messageId, taskId?, title?, operationId? }` and creates a new Task beside the source: in the same project, or in the same temporary folder for a temporary conversation. `messageId` names an assistant reply on the source's current Pi branch; the new Task's Pi session holds the path from the first entry through that reply, and its saved Main context mirrors it, so the next message there continues from the reply. Only the transcript is copied — requirement records, Runs, queued messages and questions stay with the source. The new Task is settled (`completed`, no active Run) and returns `201` with its catalog row. A reply that is not on the current branch (for example one an edit replaced) returns `404` and leaves no Task behind. Retries with the same `operationId` return the first outcome.

While Main is live, `interject` accepts `{ "message": "Updated instructions", "delivery": "steer" }` (`delivery` is optional; default `steer`, or `followUp` to wait until the current tool/model loop finishes), durably enqueues a human command and returns `202 { taskId, runId, delivered: true }`. The response means accepted for delivery, not already acted on by the model. With no active run it returns 409; use `run` for a new request. A request captures the current Main process before reading its body; if that process ends or changes before serialized acceptance, it returns 409 without enqueuing the message, including when the resumed process reuses the same run ID. The UI defaults to `followUp`. Pending follow-ups stay unclaimed in the durable Inbox until the current work ends. `POST /api/tasks/:taskId/interject/:messageId/steer` sends one original queued message: while running it promotes that message under the Inbox lock; while stopped it resumes the same conversation with the queued text as the initial prompt. The message remains leased until its durable prompt identity is acknowledged, preventing duplicate delivery; failed startup releases the lease for retry. Task start, stop and queue actions are serialized. Repeated sends are idempotent. `POST /api/tasks/:taskId/interject/:messageId/cancel` cancels an unclaimed follow-up (also when stopped), returning `{ taskId, messageId, cancelled: true }`; repeated cancellation succeeds, while a claimed/promoted message returns 409. Cancellation emits `user.message_cancelled`, so refresh does not restore the queue item. Unknown/cancelled messages cannot be sent. Existing queued attachments and unrelated composer drafts are retained. `user.message_promoted` and consumed receipts retain the original message identity. The trajectory endpoint returns the bounded execution trace for Main or a member of the active run; it does not select arbitrary historical runs.

A follow-up in an existing Task continues that Task's Pi session, including after completion; `resume: false` does not clear the conversation. A completed request may start a new run, while its messages and title remain attached to the same Task. Create a new Task to start an independent conversation. The extension initializes an empty goal once and preserves an existing title across subsequent requests and context resets.

`POST /api/tasks` accepts `projectId` to inherit the saved project's directory; an unknown project is rejected. The browser's project `+` opens a draft and sends this field when its first message creates the Task. Creating a Task itself does not launch a model run. The optional `workspaceRoot` form selects the project whose folder is that root and opens an explicit project for the folder when none exists yet.

`POST /api/tasks` also accepts `{ taskId?, goal, projectId:null }` or `{ taskId?, goal, temporary:true }` to allocate an isolated durable managed workspace without a project. Its response includes `projectId:null`, `temporaryWorkspaceRoot`, effective `projectDirectory` and the original `storageRoot`. Optional `temporaryWorkspaceRoot` may reuse an already managed temporary root; arbitrary folders are rejected and temporary records are only for temporary conversations. Conflicting project/directory fields and invalid booleans are rejected. Temporary records are visible in the task list but never synthesized into projects.

Main's native file and command tools run in the owning project's directory (`projectDirectory` and `workspaceRoot` in Dashboard responses). The launcher loads its own configuration, extension, prompt, and bundled skills by absolute path so another project does not remove Cowork capabilities. Each Main turn receives explicit absolute paths for the project, Task workspace, private drafts and final deliverables. `browse_workspace` remains rooted in the Task directory rather than the project directory. Task metadata records `projectId`, `projectCatalogPath` and the project directory; a Task without a project is not listed as a conversation. Detail exposes `projectId`, `projectName`, `projectDirectory`, and `storageRoot` for the stable task storage root; HTTP, Run startup and Pi resolve the same real Task storage for state and artifacts. Project folder updates do not move Task storage or artifacts. Pi history is continued across a CWD change by forking its session header into the new CWD, retaining messages and leaving the original session file intact. Historical absolute paths are not rewritten; the current system context explicitly identifies the current directory.

Runtime SSE tails newly appended log bytes every 40 ms; durable Task events retain their 250 ms refresh cadence. The event schema and replay identities are unchanged. The browser batches rendering by animation frame and preserves existing DOM nodes; provider/network pacing still determines when model output becomes available.

For existing Task sessions recorded under the old harness working directory, the launcher copies the full Pi session into the selected project using Pi's session-fork API before continuing. The original session is retained, and later requests reuse the aligned session; this avoids Pi's CWD filter silently starting an empty conversation.

### Backend delegation

```text
POST /api/tasks/:taskId/subagents
```

Main's delegation tools reach the serving backend here; the host credential is the Run credential, so a delegated process never receives it. A dispatch request registers one work item in the Run's durable queue and returns the identity Main then uses:

```json
{
  "action": "dispatch",
  "task": "Implement the export entry and return evidence.",
  "role": "executor",
  "dependsOn": ["call-..."],
  "developmentId": "development_...",
  "continueCallId": "call-...",
  "reviewId": "review_...",
  "ticketId": "01",
  "attachments": ["upload-..."]
}
```

`ticketId` with `developmentId` binds an Executor to a confirmed ticket whose dependencies are merged: the program writes the ticket's brief (title, scope, acceptance criteria with their checks, what must keep working, what is out of scope) ahead of `task`, and records the call and its checkout on the ticket, which becomes `in_progress`. A continuation inherits the original's ticket without repeating the brief; continuing a ticket in `rework` starts it again. A draft, a ticket already running or done, an unmerged dependency or a Reviewer with a ticket is refused.

A Reviewer bound to a development examines the open review it names with `reviewId` (required when several are open, `review_ambiguous`), and the program writes what it examines ahead of `task` from the records: the ticket's brief for a ticket review, the requirement's goal, completion criteria and every ticket for the `full` route's final review, or the goal and criteria for a `quick` review.

The response is `{ accepted: true, callId, runId, agentId, name, role, developmentId?, ticketId?, workspace?, continuedFrom?, dependsOn? }`, returned as soon as the work item is durably visible; the result arrives later as a callback. Main's `wait_for_subagents`, `get_subagent_status` and `get_task_status` read the same durable queue, callback and result records; they never ask the backend for in-memory state.

Requests refused before a work item exists leave no record: an unknown dependency or continuation, a non-terminal or non-Executor continuation, a continuation with no earlier session file, a Reviewer whose requirement has no frozen candidate, a development whose checkout is not ready, an attachment outside the Task, or a Run that is no longer the Task's own. Once the item is queued, a start failure is that item's outcome, with its own callback.

Cancel through the same endpoint: `{ "action": "cancel", "callId": "call-...", "reason": "optional" }` returns `{ callId, agentId, status: "cancelled" | "already_terminal", previousStatus }`. A queued item with no process is settled in the queue; a running one has its process group stopped.

### Delegated work and completion

A `call_subagent` acceptance is returned only after durable queue registration. Completion callbacks are persisted in Main's Inbox and delivered with Pi steering before the next model inference. Queuing a message is not consumption: its Inbox lease remains pending until the message appears in Main's saved context. Delivery is serialized and deduplicated, including while a slow tool is running; a restored session can acknowledge an already saved callback without sending it again.

Failed delivery releases the lease for recovery and leaves Task state unchanged. Actual `agent_start` marks Main as running; accepting an Inbox message does not reopen a settled Task or take ownership from a newer Run. Background delivery and status notifications tolerate a disposed Main context, so outstanding Subagents can finish and persist their callbacks after a provider failure.

`wait_for_subagents` waits for execution, then returns so Main can receive queued callbacks. `finish_task` is optional completion-summary registration and rejects completion while calls, local dispatch/recovery, callbacks, or human answers remain outstanding. If Main stops before delegated work returns, its session waits and continues with the actual callbacks. A natural final answer completes the request once those dependencies are resolved, including conversations whose stored completion policy is `explicit`. Runtime never injects an instruction to continue solely because `finish_task` was omitted. Process exit without a complete final answer (including tool-budget stops and truncated responses) leaves the Task incomplete.

These checks enforce execution and delivery state. Main remains responsible for inspecting results and deciding whether the user's requested work is complete.

## Task detail shape

`GET /api/tasks/:taskId` returns:

```json
{
  "task": {},
  "coordination": {
    "calls": [],
    "pending": [],
    "callbackPending": []
  },
  "events": [],
  "runtimeEvents": [],
  "artifacts": [],
  "messages": [],
  "statistics": null,
  "humanRequests": [],
  "humanResumePending": false,
  "parked": { "wakeAt": "2026-01-01T00:10:00.000Z", "reason": "refresh the report" },
  "runtime": { "active": false, "mainRunning": false, "stopping": false }
}
```

`runtime.active` 表示当前有回合在跑；`runtime.mainRunning` 表示常驻 Main 进程是否存在（空闲时为 true）；两者在后端重启接管后仍由进程记录与心跳给出。

`parked` is present only while a durable sleep record waits for a timed wake; it carries `wakeAt` and `reason` from `agents/main/sleep.json` and is absent otherwise. Readers use it to tell a genuinely parked Task from an unfinished stop.

`coordination.calls` is the structured Agent Office state. A UI should use its `status`, `agentId`, `task`, `response`, and `error` fields to drive the agent card; it should not infer state from animation timers.

Calls, progress entries, delegation results, and callbacks also include `name`, a stable human-readable team name derived from the durable Agent identity. Use `name` on cards, activity records, and result attribution; retain `agentId` and `callId` for API routing.

A progress entry for a delegated work item also carries its execution facts: `role` (`executor` or `reviewer`), `model` and `connectionName` of the selection it started with, `workspace` (the project directory it runs against — its own checkout when bound to a development), `developmentId` when bound, `dependsOn` (the callIds it waits for), `blocked: true` while a prerequisite has not finished, and `error` when it ended without a result. A waiting entry reports status `queued` and has not started work yet; the item's own terminal state comes first, so a cancelled item is never reported as blocked by a prerequisite that is still running. These fields come from the durable work item and its non-sensitive selection snapshot; a key never appears here.

New delegations atomically reserve distinct private directories, including across completed requests in the same Task.

`messages` contains the conversation's user/assistant messages, including timestamps and the final reply saved when Main settles. `runtimeEvents` contains Main activity from all Task runs in creation order, wrapped as `runtime_event` records. Persisted run logs also restore messages missing from older snapshots. The UI groups thinking and tool activity by the user request that produced it and retains each group's expanded/collapsed state during updates and navigation.

Subagent results, progress, and callbacks may include `outputFiles` (Task-relative paths to private candidate files) and `diagnostics: { tracePath, resultPath }`. These are execution information, separate from the Task's formal `artifacts` list.

Main can inspect candidates through `browse_workspace`, then use `publish_artifact({sourcePath, name?})` to copy an accepted file into the canonical Task `artifacts/` directory. Relative source paths resolve from the selected project. The tool returns indexed metadata and `absolutePath` for final links, and fails for missing or non-file sources or unsafe destination paths. Ordinary writes into `artifacts/` remain discoverable; no recursive scan promotes unrelated drafts or logs.

### Current run statistics

`statistics` is `null` before a run starts. Otherwise it contains `scope: "conversation"`, `taskId`, the current `runId`, `runCount`, `startedAt`, `endedAt`, `elapsedMs`, `timingPartial`, `active`, `observedAt`, aggregate `usage`, and `agents: [{ agentId, callId?, name, current, usage }]`.

The single task panel contains artifacts, the agent team, 会话运行概览, and background processes in that order. Member selection opens a collapsible, bounded execution trace in the same panel; there are no workspace/team tabs.

`elapsedMs` sums Main process intervals across every durable run in the conversation, including tool execution and waits for delegated work. Idle gaps between runs or resumed invocations are excluded. The UI may advance the timer from `observedAt` only while `statistics.active` is true. Completion/failure/pause/waiting events freeze the duration; a resumed run opens a new interval. A historical run without an exit event freezes at its own last recorded activity, never at the current Task's update time. Unknown timing is `null`; `timingPartial` marks a sum with missing run timing. Follow-ups, page reloads and server restarts recover the same cumulative values from disk.

Each `usage` contains `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `responses`, `reportedResponses`, `coverage` (`complete`, `partial`, or `unavailable`), and `scanning`.

Pi's input excludes cache, so total input for display is `input + cacheRead + cacheWrite`; `output` already includes reasoning. `totalTokens` sums these four components, recovering older traces whose numeric total was redacted.

Only finalized assistant `message_end` records count: stream updates and repeated turn/session snapshots do not. All recorded attempts across all runs count, including consumption before failure or cancellation. Responses are deduplicated per agent across retries and replayed history.

Agent totals are grouped by their stable identity; historical members remain in the breakdown. Only current members link to the current execution trace, so historical rows cannot accidentally open another member or run. Exact Token counts are displayed without K/M rounding.

Missing/zero-filled provider usage is unavailable, not zero consumption. `totalTokens` is `null` when no response reported usage.

The UI displays accumulated numeric counts without qualifiers or reporting-status notes; missing totals render as `—`. Coverage metadata remains available in the API.

Large legacy traces are scanned incrementally with bounded memory and read budgets; `scanning` marks totals still being collected. Missing, malformed, or oversized records can leave coverage partial. There is no monetary estimate because configured model prices are placeholders.

### Activity metrics

Implementation: [activity metrics](../src/runtime/activity-metrics.ts); the catalog entry is assembled by [workspace-directory](../src/dashboard/workspace-directory.ts) and published through the [snapshot and event stream](#snapshot-and-event-recovery).

A Task that has run inside the retained window carries `task.activity`: sampled activity for its running Main and each of its Subagents. The same object appears in `GET /api/tasks`, in the snapshot, in `task.changed` payloads and in the task detail, so one reader can draw a lane from any of them. The samples are derived on the execution host from logs the Run already writes — Main's `runtime-output.log` and each Subagent's `sessions/<agentId>/<runId>.jsonl`. Nothing on the model request path changes, and no conversation text, tool arguments or credentials are carried.

```json
{
  "version": 1,
  "sliceMs": 60000,
  "windowMs": 7200000,
  "from": "2026-01-01T00:00:00.000Z",
  "active": true,
  "agents": [
    {
      "agentId": "main",
      "name": "CoworkOS",
      "role": "main",
      "state": "running",
      "stage": "working",
      "stageChangedAt": "2026-01-01T00:01:00.000Z",
      "lastProgressAt": "2026-01-01T00:03:12.000Z",
      "samples": [{ "toolCalls": 2, "outputBytes": 812 }]
    }
  ]
}
```

- `sliceMs` is the fixed slice and `windowMs` the retained window (2 hours). `samples[i]` covers `[from + i*sliceMs, from + (i+1)*sliceMs)`; a quiet slice is `0`/`0`, and the output rate is `outputBytes / (sliceMs / 1000)` bytes per second. `from` is a multiple of `sliceMs` and never earlier than the Run's start or the retained window.
- `toolCalls` counts tool executions that started in the slice; `outputBytes` counts the UTF-8 bytes of assistant text and tool result text recorded in it.
- Only finished slices are published, so a live Run's entry changes at most once per finished slice — a sample appears and `lastProgressAt` advances together — plus once when the stage itself changes (`working` to `idle`, or the Run ending). A subscriber therefore sees the sample cadence, not the agent's write rate. `active` is true while Main's Run still executes. A finished Run keeps its frozen samples until the window passes.
- `agents[]` holds `main` plus one entry per durable work item: `role` is `main` or `subagent`, `workRole` is the dispatched `executor`/`reviewer` role when it had one, and `callId` names that work item.
- `state` is the durable state (`queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `timed_out`). `stage` is what the execution host observed (`starting`, `working`, `idle`, `waiting`, `completed`, `failed`, `cancelled`, `timed_out`): a slice without records turns `working` into `idle`, and `stageChangedAt` is when the current stage began. `lastProgressAt` is the last record the agent wrote, reported no later than the end of the last published slice, or `null` before it wrote one.

The field is additive: nothing persisted gains a key (the metrics are derived, so no migration or backup rewrite), and a reader that does not know it keeps every field it already used. A Task with no Run in the window has no `activity`, and readers fall back instead of waiting for it.

### Human questions and continuation

`humanRequests` contains durable `askhuman` questions (`requestId`, `taskId`, `runId`, `question`, optional `label`, `context`, `options`, `multiple` and `recommended` option indexes, `expiresAt` when Main stops waiting, `status`, and answer timestamps). A request that asks several questions at once also lists all of them in `questions`, and gets one answer covering each. Pending questions take the composer's place: numbered options the keyboard can pick (single or multiple choice), a typed answer as the last row, a countdown to when Main proceeds on its recommendation, and for several questions one step per question, sent together. No option is preselected or submitted automatically. Drafts survive polling, Task navigation and page reload in the same browser tab. Separate pending requests are navigable and the paused run resumes once all of them are answered.

```text
POST /api/tasks/:taskId/human/:requestId/answer   { "answer": "User's selected or written answer" }
POST /api/tasks/:taskId/human/resume
```

Answer submission returns `{ request, resume: { status, error? } }`. It persists the first answer, enqueues a deterministic `human-answer-<requestId>` Inbox message and resumes Main in the same run/session.

Concurrent submissions and retries cannot replace an accepted answer, re-enqueue a consumed message or launch duplicate Main runs. An answer arriving during `askhuman` shutdown waits for process finalization; startup Inbox messages are appended before the existing Dashboard prompt rather than racing it with a second model turn. Answers to a cancelled Task or a different active run are rejected.

`humanResumePending` indicates a saved but undelivered answer with no active Main process or outstanding question.

The UI then offers 继续运行, including after restart or a failed launch. An error does not discard the answer or local draft.

Normal run/complete actions reject outstanding questions so an ordinary prompt cannot silently bypass them. The CLI's human-answer protocol remains compatible.

## Artifact files and previews

`artifacts` contains only regular files physically present under the selected Task's `artifacts/` directory, discovered automatically and ordered by descending `mtimeMs`. Entries include `relativePath`, `displayName`, `size` (bytes), `mimeType`, `sha256`, and `mtimeMs`.

Paths are relative to `artifacts/`, support Unicode and spaces, and retain subdirectories so duplicate basenames remain distinguishable. JSON, logs, and code are valid deliverables when deliberately placed there; the UI must not filter them by extension.

Conversation Markdown resolves absolute local links only against this index under `<storageRoot>/<taskId>/artifacts/`. `workspaceRoot` names the project directory and may differ; it is used only as a compatibility fallback when `storageRoot` is absent. Text, Markdown, JSON, Office documents, images and PDF open in the read-only preview drawer with a download action; other types download directly. The desktop build additionally offers an "Open" button whose arrow lists this Mac's applications for the file; see [Session files](#session-files). The Web build shows no such entry.

The Runtime keeps indexing metadata in Task `.runtime/artifacts.json`; no model-facing registration tool is required. Private Subagent `deliverables/`, Main `work/`, `sessions/`, and `runs/` are not scanned as final outputs. Ordinary discovery never promotes candidates.

```text
GET /api/tasks/:taskId/artifact?path=<URL-encoded relative path>
GET /api/tasks/:taskId/artifact?path=<URL-encoded relative path>&raw=1
GET /api/tasks/:taskId/artifact?path=<URL-encoded relative path>&download=1
GET /api/tasks/:taskId/artifact?path=<URL-encoded relative path>&page=<n>
```

The default response describes the preview:

```json
{
  "path": "reports/brief.md",
  "previewKind": "text",
  "mimeType": "text/markdown",
  "size": 8,
  "content": "# Brief\n",
  "truncated": false,
  "rawUrl": "/api/tasks/task-1/artifact?path=reports%2Fbrief.md&raw=1",
  "downloadUrl": "/api/tasks/task-1/artifact?path=reports%2Fbrief.md&download=1",
  "version": "opaque-file-revision"
}
```

`previewKind` is `text`, `office`, `pdf`, `image`, or `download`. Every file preview — artifacts, project files and uploads — is produced by the same reader with the same rules:

- `text` includes `content`, at most the first 1 MiB, with `truncated: true` when only a prefix is shown. A type the name does not identify is read as text when its bytes are UTF-8 without NUL bytes, otherwise it is `download`.
- `office` (`.docx`, `.pptx`, `.xlsx`) includes the text the local parser extracts, at most 20,000 characters, with `truncated` likewise. A damaged file, or a machine without the parser, returns `download` with a `notice` saying why.
- `pdf` carries no content by default. `page=<n>` (from 1) adds that page rendered as `image` (base64 PNG) with `page` and the total `pages`; it needs the local PDF parser and returns 400 with the reason when the page cannot be rendered.
- `image` is shown from `rawUrl`.

Every kind offers a download action; copying applies to `text` and `office` and must identify truncated previews.

`raw=1` serves complete bytes with their MIME type; `download=1` serves the same file as an attachment with a Unicode-compatible filename. Encode the entire path query value, and never resolve it against a different Task or outside `artifacts/`.

Invalidate cached previews when `sha256`, `mtimeMs`, size, or the returned `version` changes, and version media URLs too. Unchanged Task polling should preserve the active preview and reading position.

### Session files

A file a reply names may be any file of the session's project folder, not only an artifact. A session without a project reads its own temporary folder.

```text
GET /api/tasks/:taskId/project-file?path=<URL-encoded project-relative path>[&raw=1|&download=1|&page=<n>]
GET /api/tasks/:taskId/project-file/resolve?path=<reference as written>
GET /api/tasks/:taskId/file-location?source=artifact|project&path=<URL-encoded relative path>
```

- `project-file` serves the same preview, raw and download responses as an artifact. The path is relative to the project folder, reached without following links, and never inside `.git`; a malformed or escaping path returns 400 and a missing file 404 `file_missing`. `version` changes whenever the file is rewritten.
- `project-file/resolve` turns a reference as a reply wrote it — `./a`, `a/b.kt`, a bare `b.kt`, or an absolute path inside the folder — into `{ matches: string[] }`: the exact file when it exists, otherwise the listed files ending in that path, otherwise those with that file name (Git's view of the folder: tracked plus untracked, ignored files left out), shortest first, at most 20. A path outside the folder matches nothing.
- `file-location` returns `{ absolutePath }` of an indexed artifact or a project file, under the same checks. Only the desktop host calls it, to hand the file to an application; the page never receives or sends a host path.

The desktop "Open" button asks the host (`bookman:file-apps`) which applications on this Mac can open the file: the system default first, then the installed editors and IDEs the host knows (macOS registers many source extensions to other kinds of app), then the other applications LaunchServices lists, then installed terminals, which open the file's folder. `bookman:open-file` opens the file with the default application through the system, or with one of the applications the host listed for that file; anything else is refused. The page remembers the last choice per file type.

## SSE stream

`GET /api/tasks/:taskId/stream` returns Server-Sent Events. Each data message is a persisted run event:

```json
{
  "eventId": "event_xxx",
  "type": "main.run_completed",
  "taskId": "task-1",
  "runId": "main-...",
  "agentId": "main",
  "occurredAt": "2026-09-06T12:00:00.000Z",
  "payload": {}
}
```

The client should keep the latest `eventId` and refetch Task detail after receiving an event. The stream is an invalidation channel, not a replacement for the durable Task detail API. A low-frequency refresh is still appropriate after reconnecting.

Main streaming activity uses `type: "runtime_event"`, with the Pi event in `payload` and a stable `eventId` containing the run ID and record index. Detail and SSE use the same IDs; deduplicate by identity rather than payload, since identical deltas can be distinct events. The stream follows the active run selected when connecting, so reconnect when `task.activeRunId` changes. Merge detail refreshes with newer SSE records to avoid dropping in-flight updates.

The durable ledger initially replays its latest 500 complete records, then reads appended byte ranges; an appended burst is not capped at 500. Idle streams check metadata without rereading history. Truncation or file replacement resets the read cursor, with recent event identities suppressing duplicates. Detail tail reads are bounded by the requested record count. Incomplete streaming UTF-8/JSON lines remain buffered until completed.

## External events

```text
POST /api/tasks/:taskId/events
```

Example:

```json
{
  "watcherId": "repo-watch",
  "source": "github",
  "type": "pull_request.updated",
  "dedupeKey": "pr-42:head-sha-abc",
  "payload": { "number": 42, "action": "synchronize" },
  "wake": true
}
```

The Runtime writes the observation to the Event Log and Main Inbox. `watcherId + dedupeKey` is idempotent; sending the same observation twice does not create a second Inbox message. By default ingestion does not call the model. With `wake: true`, and only when no turn is running (an idle resident Main included), the local Runtime Host starts a continuation of the existing Main session through the external budget and asks it to inspect the Inbox. A production Worker/supervisor will own this wake decision when the Dashboard process is not running.

## UI implementation rules

- Never write Task, Event, Inbox, or Artifact files from the Renderer.
- Keep API payloads and UI state separate; the UI may maintain a view model but the Runtime is the source of truth.
- Work logs present named participants, actions, relevant files/results, and local times. Fold tool start/end updates into one entry, skip queue/lease bookkeeping, and allow users to expand a result or jump to the participant's trajectory. Preserve expanded entries during refreshes; filter activity to the current run.
- Treat `queued`, `running`, `waiting`, `succeeded`, `partial`, `failed`, `timed_out`, and `cancelled` as distinct states.
- Display the current request's final answer only when `runtime.active` is false, `task.status` is `completed`, and both `coordination.pending` and `coordination.callbackPending` are empty. Natural completion is sufficient; a stored policy value must not hide a completed answer. The last assistant message must contain a final response rather than a tool call, truncated output, or error. Until then, keep assistant text in the execution history; show an incomplete/waiting state if Main has stopped. Preserve completed replies and activity from earlier user requests during follow-ups. A settled turn writes its own terminal run event (`main.run_completed`, or `main.run_waiting` when work is outstanding) at the boundary, so the exchange can close while the resident Main process stays alive; the last one of these events is the exchange's outcome, and an earlier failure does not outlive a later successful turn.
- One-shot callbacks must be processed before final completion. Later external events may start a continuation; preserve the earlier conversation when they arrive.
- If progress marks a legacy large trace with `traceSampled: true`, label its turn/message counts as sampled rather than totals.
- Use fixture data with the same shapes for offline UI development on macOS.

## 交互与恢复契约

- `PATCH /api/tasks/:taskId` 接受 optional `title`（1–100 字符）、`pinned`、`archived`。原有 goal 与 Task 身份保持不变；旧记录缺省为未置顶、未归档。运行中的任务需先停止才能归档；搜索可重新打开已归档会话并恢复。
- `POST /api/tasks/:taskId/action` 的 pause 在 Task 记录写入持久暂停请求，Main 在当前工具调用或模型回复结束、下一次工具调用或模型请求之前读取并停下；状态变为 `paused`，`pause.pausedAt` 记录边界时间，已完成文件与需求记录保留。没有运行中的 Main 或没有进行中的回合时返回 409；该边界已完成 Task 时保持 `completed`。暂停**不结束进程**：常驻 Main 与它的 Pi 会话继续存活；有未结束的子代理工作项时继续占用外部名额，恢复请求直接送达同一进程，待办工作清空后才在回合结束的边界释放名额，之后的恢复重新准入（名额满时恢复请求进入队列）；暂停期间到达的回调与其他消息留在持久 Inbox，恢复后才送达；暂停中且没有子代理在跑时按空闲计时退出（见 `mainIdleTimeoutMs`）。暂停期间 `POST /run` 的消息进入 Inbox 并保持排队，响应状态仍为 `paused`。`/run` 携带 `{ "resume": true }` 从同一 Run、进程与 Pi 会话继续，先送达等待中的消息，再保留已完成的工具结果、不重复已完成步骤。目录与详情提供 optional `pause`（`requestedAt`、`pausedAt`）和 `paused` 状态；没有进行中的回合时 `runtime.active` 为 false。后端重启后暂停、关闭与插入消息都作用于已接管的同一进程。
- `POST /api/tasks/:taskId/action` 的 interrupt 中断 Main 当前正在输出的回合（模型输出或工具调用到此为止），返回 `202`；会话、Task 与在跑的子代理都保留，进程继续等待下一条消息。没有进行中的回合时返回 409。
- `POST /api/tasks/:taskId/action` 的 compact 请求一次模型总结后换窗。常驻 Main 经 Inbox 处理时返回 `202`，离线会话直接保存时返回 `200`，会话没有历史时返回 `409`。详情的 `contextUsage` 提供估算 token、容量和窗口序号，`contextWindows` 列出每次换窗（`id`、`timestamp`），交接页只留在 Main 的会话里。
- `POST /api/tasks/:taskId/action` 的 cancel 关闭会话：通过 Run 服务终止对应 Pi 进程组、取消该会话未完成的委派并等待输出落盘，再返回。其他任务和后续运行不受影响。Detail 的 `runtime.stopping` 为停止中的 optional 标志；`runtime.mainRunning` 表示常驻 Main 进程是否存在（空闲也为 true），`runtime.active` 只表示当前是否有回合在跑。后端重启后重新接管仍在运行的 Main，这两个字段来自进程记录与它写的心跳。
- Web 和桌面共用 `GET /api/model-settings` 与供应商、模型、角色接口（见上文 Global APIs）：模型按供应商配置，一个供应商保存地址、接口格式与密钥，下挂多个模型；角色绑定的 `profileId` 为 `<供应商 ID>#<模型 ID>`。状态不返回明文或加密密钥。配置写在 `modelProviders.version: 1`，密钥保存在所选执行主机的凭据文件中，保存设置不重启后端。`GET /api/model-settings` 额外返回 `modelRoles`：Main 的有效来源（主机默认、首个启用供应商的首个模型或启动环境）、名称、模型和推理强度；Executor、Reviewer 已接通委派，有绑定时给出该绑定的有效来源，未绑定时 `effective` 为 `null`（工作项沿用启动 Run 的模型）；Router 仍以 `wired: false` 列出。`POST /api/model-settings/roles` 以 `{ role, profileId }` 保存主机默认，`profileId: ""` 清除；引用的模型不存在或已停用时拒绝保存，已保存的失效引用在状态中给出可定位错误并拒绝下一次 Run，不会改用其他账号。角色绑定保存在执行主机本机配置中，不随项目进入共享数据或远端主机；不设按项目的覆盖，单个会话换模型在对话面板选择。角色变更对下一次 Run 生效，在途 Run 保持启动时的快照。
- `GET /api/models` 新增 `connectionProfileId`（Main 所用模型的 `profileId`），切换后前端清除旧服务的会话模型选择；已有会话历史保留，后续请求使用新的模型配置。响应还带 `reasoningEffort`：下一次 Main 运行将使用的推理强度，取自 Main 角色解析到的模型（主机默认或首个可用模型）；该连接尚不可用时省略。Composer 的推理强度选择以它为默认显示；用户未显式选择时不随请求发送 `thinkingLevel`，各角色运行使用其绑定连接保存的强度，显式选择只作用于该次运行。响应的 `levels` 按模型给出可选档位与来源（`endpoint` 服务商 `/models` 条目、`official` Pi 内置的官方地址表、`manual` 模型上勾选的 `reasoningLevels`，默认六档）；Composer 只显示当前模型的档位，切换模型时已选档位不受支持则移到最近一档。模型保存 `reasoningLevels`（至少一项，须包含模型默认强度，`null` 清除）；`POST /api/model-settings/levels` 供模型参数弹窗识别档位。
- `GET /api/models` 还带 `provider`（Main 所用供应商的 `name` 与 `preset`，Composer 的模型按钮据此显示供应商标志）、`mainProviderId` 和 `providers`：每个已启用且填了 API Key 的供应商及其模型（`id`、`profileId`、`reasoningEffort`、`levels`）。Composer 按供应商分组列出模型；选中 Main 所在供应商以外的模型时，随 `POST /api/tasks/:taskId/run` 发送该模型的 `profileId`，这次运行固定使用该供应商。常驻 Main 只把消息交给与请求相同连接的进程：换到另一供应商、或从指定供应商回到跟随 Main 的连接，都会结束旧进程并以新连接启动，会话历史保留。
- 本地附件通过下方 [Local input uploads](#local-input-uploads) 的上传、预览与引用接口读取；现有文本草稿附件的限制不代表上传接口的文件能力。`/run` 的消息不经过 stdin：后端把它写入该 Run 的持久 Inbox，由 Main 进程在回合边界读取（首条消息作为真实用户消息开始该回合），服务边界仍拒绝 NUL 和超限消息。
- interject 的 Inbox 投递不变；响应增加 `messageId`，事件保存完整消息用于跨 Run 的对话投影。`steer` 在界面显示为补充指令；`followUp` 排队时显示等待状态，消费后按新请求分组，保留前一请求的最终回复。

## Local input uploads

- `POST /api/uploads?name=<encoded filename>` accepts a raw file body, bounded while streaming to 25 MiB. It returns `{uploadId,name,size,mimeType,kind,sha256,createdAt,relativePath}`. Content signatures and UTF-8 are checked; interrupted or rejected writes are removed.
- `GET /api/uploads/:uploadId` returns original bytes with private/no-store headers. Images display inline; documents/text download with the original Unicode filename.
- `GET /api/uploads/:uploadId/preview[?page=<n>]` returns `{ file, ...preview }` with the same preview shape and rules as an artifact (see [Artifact files and previews](#artifact-files-and-previews)); `rawUrl` and `downloadUrl` both name the original bytes. Local parsing dependencies are required for PDF pages and Office text.
- `POST /api/tasks/:taskId/run` and `/interject` accept optional `attachmentIds: string[]`, at most 10 IDs / 100 MiB. Original files are validated and copied to Task `inputs/` before the message reaches Main. Prompt metadata references those files; the conversation renderer displays filenames and image thumbnails. Main uses `read_attachment({id,offset?,limit?,page?,render?})` to read them explicitly.

Uploads stay local until an agent reads them during the user's model run. Reading a document sends extracted content to the configured model; image reading sends pixels only when the connection accepts image input, and otherwise reports that the current model does not support images. Upload IDs are local references under the Dashboard's existing origin and desktop authentication boundary, not a public sharing mechanism.

## 联网搜索设置

`GET /api/web-search-settings` 返回 `{ enabled, provider, authenticated, managedByEnvironment }`，`provider` 为 `exa` 或 `off`，不返回凭据。`POST /api/web-search-settings` 接收 `{ provider: "exa" | "off", exaApiKey?: string, clearExaApiKey?: boolean }`，返回更新后的状态；密钥留空保留原值，显式清除回到匿名。有回合正在产出回答时、或由搜索环境变量管理时拒绝修改；空闲的常驻 Main 在下一回合开始前按保存后的配置工作。沿用本机 Host/Origin、认证、JSON 大小与错误边界。

桌面和 Web 使用同一接口，搜索密钥保存在所选执行主机；桌面客户端会话凭据由宿主管理。保存不重启后端，新运行/恢复使用新配置，常驻 Main 在回合边界重读。默认与兼容规则见 [联网搜索](configuration.md#联网搜索)。

### Web search settings (English)

`GET /api/web-search-settings` returns `{ enabled, provider, authenticated, managedByEnvironment }` without credentials; `provider` is `exa` or `off`. `POST` accepts `{ provider: "exa" | "off", exaApiKey?: string, clearExaApiKey?: boolean }` and returns updated status. A blank key retains the existing value; explicit clearing restores anonymous use. A turn that is producing an answer, and search environment management, reject writes; an idle resident Main applies the saved configuration before its next turn. Existing local authentication, Host/Origin, JSON-size and error boundaries apply.

Desktop and Web use the same interface, and the search key belongs to the selected execution host. Desktop client session credentials are host-managed. Saving does not restart the backend; new or resumed runs use the updated configuration, and a resident Main re-reads it at the turn boundary. See [web search](en/configuration.md#web-search).
