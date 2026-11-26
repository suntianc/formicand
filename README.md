<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/readme-hero.png">
    <img src="docs/assets/readme-hero.gif" alt="Formicand: five-node mark, wordmark and desktop workspace" width="100%">
  </picture>
</p>

<p align="center">
  <a href="docs/en/README.md"><img src="docs/assets/badges/docs.svg" alt="Documentation"></a>
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="License: MIT; third-party exceptions below"></a>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> | <b>English</b>
</p>

**Formicand is a multi-agent workbench that runs on your own computer.** You talk to the Main Agent; it plans, delegates and checks the results, while Subagents do the work in separate processes. Projects, conversation records and configuration stay on your machine, and you bring your own model service.

- **Delegation.** Main splits work, hands it to Subagents and reviews what comes back. Subagents can ask Main questions and message each other. After a quit or restart, work resumes where it stopped.
- **Software delivery.** A built-in requirement ledger and board. Requirements become tickets, built in separate Git worktrees, then independently reviewed, reworked and merged.
- **Memory and context.** Main keeps user-level and project-level conventions; long sessions are compacted and carry on. Settings → Memory lists and edits what it keeps.
- **Tools.** Shell, files, web search, MCP, custom Agents and skills; on macOS it can also operate desktop apps and the browser.
- **Three entry points.** The Mac App, a web UI and the `formicand` terminal command, sharing the same data in `~/.formicand/`.

[Getting started](#getting-started) · [Configuration](#configuration) · [Built-in capabilities](#built-in-capabilities) · [Development](#development) · [Documentation](#documentation)

## Getting started

### Install

Requires Node.js ≥22.19.0, npm and Git; the Mac App needs macOS 14+ on Apple Silicon, and the CLI runs on macOS or Linux.

```sh
git clone https://github.com/suntianc/formicand.git
cd formicand
npm ci
npm run desktop   # Mac App (development mode)
npm run ui        # Web UI
npm run cli       # Terminal
```

CLI-only setups can skip the Electron download with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`. `npm run desktop:dist` writes an installer under `release/`; open the DMG and drag the App into Applications. It is ad-hoc signed and not notarized, so the first launch is blocked until you allow it under System Settings → Privacy & Security, as [Apple describes](https://support.apple.com/102445).

### Connect a model

The first launch opens Settings → Models with an "Add provider" sheet:

1. Pick a preset provider and supply only an API key. For anything else choose "Custom", enter the API address and pick the format: Chat Completions, Responses or Anthropic Messages.
2. Click "Add and fetch models", tick the ones you use and add them. When a provider offers no model list, add model IDs manually.
3. Open the provider and click "Check" to confirm the connection and tool calls work. A check spends a little quota.

The service must support streaming and tool calls in the chosen format. Every setting is under [Configuration](#configuration).

### First task

1. Create an empty folder in Finder, for example `formicand-quickstart`.
2. Next to Projects in the sidebar click `+`, name it and choose that folder.
3. Next to the project title click `+` for a new conversation and send:

   > Create hello.txt in the current project, write "Hello, Formicand." into it, then read the file back and confirm the contents.

The folder should then contain `hello.txt`.

### Terminal

Build and register the command inside the source checkout:

```sh
npm run build:cli
npm link
formicand --version
```

The last command prints Formicand and the version; rerun `npm run build:cli` after changing the source. The CLI reads and writes project files in the folder it starts from, so create a test folder and configure the model first:

```sh
mkdir -p "$HOME/formicand-quickstart"
cd "$HOME/formicand-quickstart"
formicand init
formicand doctor --test-connection
formicand
```

`init` asks for the API address, model ID and API key in turn; the key is not echoed, and the result is written to `~/.formicand/config.json`. `--force` reads an existing file and asks only for what is missing; see `formicand init --help` for `--base-url`, `--model`, `--api-key-env` and the rest. `doctor --test-connection` requests the model and spends quota; the connection is ready when the check prints `OK  流式模型连接与工具调用` (streaming model connection and tool calls). Send the same request as in the App. During a reply `Esc` interrupts it; clear the input and press `Ctrl+D` to quit.

| Command                         | Effect                                  |
| ------------------------------- | --------------------------------------- |
| `formicand`                     | Start a new conversation                |
| `formicand --continue`          | Continue this project's most recent one |
| `formicand --resume`            | Pick one from the conversation history  |
| `formicand session export <ID>` | Export a conversation as JSON or HTML   |

`formicand --help` lists every command.

### Update

Quit the running App and CLI, then run this in the source checkout:

```sh
formicand update --check   # check only, install nothing
formicand update
```

`update` pulls from the Git upstream and rebuilds. Development-mode Apps start again with `npm run desktop`; installer users build a new DMG and install over the old one, keeping their data.

### Data and backup

| What                                 | Where                                                     |
| ------------------------------------ | --------------------------------------------------------- |
| Configuration, keys, tasks, sessions | `~/.formicand/`, moved with `FORMICAND_HOME`              |
| Project files                        | The project folder you chose; Formicand edits it in place |

`formicand data paths` prints the actual paths. Back up the data directory together with the project folders; the project ledger has its own `formicand data backup` command, see [Project data](#project-data). Do not delete the data directory to troubleshoot.

### Troubleshooting

| Symptom                                     | Fix                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node: command not found` or an old version | Install Node.js 22.19.0 or newer and reopen the terminal                                                                                         |
| `formicand: command not found`              | Add `$(npm prefix -g)/bin` to `PATH` and reopen the terminal                                                                                     |
| `npm link` reports a permission error       | Run `npm config set prefix "$HOME/.local"` and retry, then add `$HOME/.local/bin` to `PATH`; do not use `sudo`                                   |
| `配置已存在，未覆盖`                        | `init` never overwrites. Run `formicand doctor` to see the configuration path and edit that file, or use `formicand init --force`                |
| `FAIL 模型配置`                             | Fix the JSON at the path `doctor` prints; run `formicand init` when nothing is configured yet                                                    |
| `FAIL 流式模型连接与工具调用`               | Check the address, model ID, key and quota; a Chat Completions only service needs `api` changed, see [Connection failures](#connection-failures) |
| The App's save stays on "Saving"            | Answer the system keychain prompt; if it was dismissed, click Save again                                                                         |

When reporting a problem include the version, system, install method, reproduction steps and the error with secrets removed. Never send an API key or a full configuration file.

## Configuration

### Model connections

A connection has four parts:

| Item        | What goes in                                                                      |
| ----------- | --------------------------------------------------------------------------------- |
| API address | The service root or an address with `/v1`. No `/responses` or `/chat/completions` |
| Model       | A model ID the provider serves and this account may call                          |
| API key     | The key for that service                                                          |
| Format      | `openai-responses`, `openai-completions` or `anthropic-messages`                  |

Settings → Models manages providers and models; Settings → Agents decides which model each Agent uses.

- A bare domain gets `/v1` appended; an address with a path is used as written. `anthropic-messages` never gets a path appended.
- The parameter button on a model row adjusts context window, output limit, reasoning effort and image input. Values marked "auto" come from the provider API or the built-in catalogue.
- After changing a name, address, key or format, click Save.
- A model or provider in use by an Agent or as the utility model cannot be deleted or disabled; switch it under Settings → Agents or Settings → General first.

The "Built-in" group under Settings → Agents has three Agents: Main, Executor and Reviewer. Their duties, permissions and tools are fixed; models, reasoning effort, skills, MCP servers and extra prompts are yours to set. The Projects page overrides any of it per project, and anything unset follows the global value.

| Agent    | With no model chosen                          | Default skills                                                                                    | Default MCP          |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------- |
| Main     | The first model of the first enabled provider | Everything                                                                                        | Every enabled server |
| Executor | Same as Main                                  | `implement`, `tdd`, `diagnosing-bugs`, `code-review`, `domain-modeling`, `codebase-design`, `cua` | None                 |
| Reviewer | Same as Main                                  | `code-review`, `domain-modeling`, `codebase-design`, `cua`                                        | None                 |

When it applies: Main's settings take effect on its next turn; Executor and Reviewer skills, MCP and extra prompts are fixed when work is dispatched and read when the work item actually starts, so running items ignore later edits; switching a model keeps the session and sends its history to the new service on the next turn.

Settings → General → Utility model picks a cheaper model for the summary written when a context window changes and for new conversation titles. Without one, both use the session's own model, which also takes over when a utility request fails. A new conversation is titled once its first reply is done, and a conversation you renamed keeps its name. Changes apply from the next window change or new conversation; a running Main needs no restart.

### Configuration file

The CLI and a web UI run from source take the first configuration file that exists, without merging:

1. The file named by `FORMICAND_CONFIG`;
2. `.formicand/config.json` in the start directory;
3. `config.json` in the start directory;
4. `~/.formicand/config.json` (`FORMICAND_HOME/config.json` when `FORMICAND_HOME` is set).

Environment variables override the file's values and command-line arguments override those. A broken selected file fails loudly instead of falling through. `formicand doctor` shows which file is in use. App settings live in the same file on the host that runs the backend, with providers under `modelProviders`.

For one project only, run `FORMICAND_CONFIG="$PWD/.formicand/config.json" formicand init` in that folder; when developing from source you can copy [config.example.json](config.example.json) to `.formicand/config.json`.

A single connection for the CLI:

```json
{
  "baseUrl": "https://your-service.example/v1",
  "model": "your-model-id",
  "apiKey": "replace-with-your-api-key",
  "api": "openai-responses"
}
```

`formicand init` only creates; `--force` reads the existing file and asks only for what is missing. Scripts can read the key from the environment:

```sh
formicand init --base-url https://your-service.example/v1 --model your-model-id --api-key-env FORMICAND_API_KEY
```

It also takes `--images`, `--reasoning`, `--thinking high`, `--max-tokens 8192` and `--force`.

These fields work at the top level of a single connection and on every model under `modelProviders`:

| Field                                 | Meaning                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `api`                                 | Format. Defaults to `openai-completions`; `init` writes `openai-responses`         |
| `supportsImages`                      | Send images to the model. Default `false`                                          |
| `reasoningEffort`                     | `off`, `low`, `medium`, `high`, `xhigh` or `max`, if the service supports it       |
| `supportsReasoningEffort`             | Send the effort field. Default `false`                                             |
| `thinkingFormat`                      | `auto` (default), `openai` or `zai`; Chat Completions only. GLM gateways use `zai` |
| `supportsPromptCacheKey`              | Send `prompt_cache_key` to third-party services. Default `false`                   |
| `contextWindow`                       | Context budget, 256000 tokens by default, used for compaction and never sent       |
| `mainMaxTokens` / `subagentMaxTokens` | Output limit per turn; 8192 on new connections                                     |
| `workspaceRoot`                       | Task data directory; an absolute path is recommended                               |

On a connection without image support the image tools answer "the current model does not support images", and computer and browser tools are not offered.

Providers and models go under `modelProviders`; models are referenced as `<provider ID>#<model ID>`, and `preset` only picks the icon and preset address. When both `modelProviders` and top-level single-connection fields exist, `modelProviders` wins.

Settings → General writes the utility model to `utilityModel`, as `{ "profileId": "<provider ID>#<model ID>" }`. Settings → Agents writes `roleModels`. `host` holds this machine's defaults and `projects` overrides them by project folder; every entry is optional, and `skills` and `mcp` take name lists or `"all"`. A referenced model that cannot be found fails startup instead of silently falling back.

```json
{
  "roleModels": {
    "version": 1,
    "host": {
      "main": { "profileId": "<provider ID>#<model ID>", "thinkingLevel": "high", "mcp": "all" },
      "executor": {
        "skills": ["pg-migration"],
        "mcp": ["postgres"],
        "prompt": "Run the tests before editing."
      }
    },
    "projects": { "/path/to/project": { "executor": { "thinkingLevel": "medium" } } }
  }
}
```

### Key storage

| Key                    | Where                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Model and search keys  | `credentials.json` next to the configuration file (mode 0600); `FORMICAND_CREDENTIALS` moves it |
| App session credential | Encrypted with the system keychain in `client-sessions.json`                                    |

The UI and the API only report "configured" and never return a key. Deleting a provider deletes its key. A damaged credential file fails loudly and keeps the original instead of overwriting it.

### Web search

The default is the [official Exa MCP](https://exa.ai/docs/get-started/exa-mcp), with tools to search and read pages.

- Off: `"webSearch": { "provider": "off" }` in the configuration, or `FORMICAND_WEB_TOOLS=0`.
- Your own Exa key: `webSearch.exaApiKey`, or `FORMICAND_EXA_API_KEY` / `EXA_API_KEY`.

A resident Main picks the change up on its next turn.

### Network proxy

| Field        | Environment variable          |
| ------------ | ----------------------------- |
| `httpProxy`  | `HTTP_PROXY` / `http_proxy`   |
| `httpsProxy` | `HTTPS_PROXY` / `https_proxy` |
| `noProxy`    | `NO_PROXY` / `no_proxy`       |

Environment variables win. Only HTTP(S) addresses are accepted. `localhost`, `127.0.0.1` and `::1` always bypass the proxy.

### Project data

Projects, the requirement ledger, the board, development and merge records live in the project data service. The default engine is local SQLite, stored as `project-data.sqlite` under the data directory's `runtime/`. PostgreSQL works too:

```json
{
  "projectData": {
    "engine": "postgres",
    "postgres": { "connectionString": "postgresql://formicand@db.example:5432/formicand" }
  }
}
```

Another backend can share one dataset: leave the local database off and point at the service that owns it.

```json
{ "projectData": { "authority": { "url": "http://127.0.0.1:3880", "token": "<local credential>" } } }
```

The engine is fixed at startup. A bad configuration, unreachable server or failed authentication fails loudly instead of switching engines or carrying on with an empty database. Changing engines does not migrate data.

```sh
formicand data backup --to ~/backups/project-data.json
formicand data restore --from ~/backups/project-data.json
```

A backup holds only project database records, not conversation history or project files. Stop every backend writing that data directory before restoring, then start it again. A mismatched database version refuses to open and names the file and version.

### External Main capacity

Mains created through external entry points need capacity; without it no external session is accepted:

```json
{ "mainCapacity": { "resident": 2, "continuation": 1 } }
```

`resident` counts concurrent regular external Mains and `continuation` reserves room for continuation Mains; the two never borrow from each other and both cap at 32. Requests beyond the limit queue in order.

### Run limits

| Field                       | Environment variable                     | Default                                         |
| --------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `mainMaxTurns`              | `FORMICAND_MAIN_MAX_TURNS`               | 2000                                            |
| `subagentMaxTurns`          | `FORMICAND_MAX_TURNS`                    | 200                                             |
| `mainTimeoutMs`             | `FORMICAND_MAIN_TIMEOUT_MS`              | 0, no limit                                     |
| `mainIdleTimeoutMs`         | `FORMICAND_MAIN_IDLE_TIMEOUT_MS`         | 300000 (5 min); 0 never idles out               |
| `subagentTimeoutMs`         | `FORMICAND_SUBAGENT_TIMEOUT_MS`          | 0, no limit                                     |
| `commandTimeoutMs`          | `FORMICAND_COMMAND_TIMEOUT_MS`           | 1800000 (30 min); 0 no limit                    |
| `maxAttempts`               | `FORMICAND_MAX_ATTEMPTS`                 | 3 including the first dispatch; 1 never retries |
| `subagentQuestionTimeoutMs` | `FORMICAND_SUBAGENT_QUESTION_TIMEOUT_MS` | 180000 (3 min); 0 means Subagents cannot ask    |
| `subagentMaxQuestions`      | `FORMICAND_SUBAGENT_MAX_QUESTIONS`       | 3                                               |
| `humanAnswerTimeoutMs`      | `FORMICAND_HUMAN_ANSWER_TIMEOUT_MS`      | 60000 (1 min)                                   |

All times are milliseconds. `mainIdleTimeoutMs` is how long a resident Main keeps its process with no turn in flight and no Subagent running; it then exits, the session is kept and the next message starts it again.

### Environment variables

| Variable                                                            | Purpose                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `FORMICAND_CONFIG`                                                  | Configuration file                                               |
| `FORMICAND_HOME`                                                    | Data directory, `~/.formicand` by default                        |
| `FORMICAND_API_BASE` / `FORMICAND_MODEL` / `FORMICAND_API_KEY`      | Override address, model and key                                  |
| `FORMICAND_MODEL_API`                                               | Override the format; same values as `api`                        |
| `FORMICAND_SUPPORTS_IMAGES`                                         | `1` enables, `0` disables image input                            |
| `FORMICAND_REASONING_EFFORT`                                        | Reasoning effort                                                 |
| `FORMICAND_WORKSPACE`                                               | Task data directory, `~/.formicand/workspace` by default         |
| `FORMICAND_PROJECT_DIR`                                             | The project folder Main edits and runs commands in               |
| `FORMICAND_UI_PORT`                                                 | Web UI port when run from source, 3880 by default                |
| `FORMICAND_PROJECT_DATA_ENGINE`                                     | Project data engine: `sqlite` or `postgres`                      |
| `FORMICAND_PROJECT_DATA_SQLITE` / `FORMICAND_PROJECT_DATA_URL`      | SQLite file path / PostgreSQL address                            |
| `FORMICAND_PROJECT_DATA_AUTHORITY` / `FORMICAND_PROJECT_DATA_TOKEN` | Shared project data address / credential                         |
| `FORMICAND_TRUSTED_CLIENT_ORIGINS`                                  | Local page origins allowed to reach the backend, comma separated |

Other `FORMICAND_` variables pass values between processes and never need setting by hand.

### Other settings

- **Language.** Settings → General → Language offers 简体中文 or English; the page reloads to apply it.
- **Appearance.** The App keeps it in `appearance.json` in the data directory; the web UI keeps it in the browser.
- **App command search path.** An App opened from Finder or the Dock adds `~/.local/bin`, Homebrew and `/usr/local/bin` to `PATH`, so commands Main and Subagents run find them.

### Connection failures

| Situation                         | Fix                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 401 / 403                         | Check the API key, model ID and the account's model permissions                                                              |
| 404                               | Check the API address and model ID; drop a trailing `/responses` or `/chat/completions`                                      |
| Unsupported format or parameter   | Switch to a format the service supports; turn off image, reasoning or cache parameters it does not accept                    |
| The file changed but nothing else | Check `FORMICAND_API_BASE`, `FORMICAND_MODEL`, `FORMICAND_API_KEY` and `FORMICAND_MODEL_API`; environment wins over the file |

Check again afterwards: the App's "Check" on the provider, or `formicand doctor --test-connection`.

## Built-in capabilities

Tools Main always has:

| Kind            | Tools                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Files and shell | Pi's own read, write, edit and bash                                                                                              |
| Delegation      | `call_subagent`, `send_subagent_message`, `cancel_subagent`, `get_subagent_status`, `wait_for_subagents`                         |
| Tasks           | `get_task_status`, `finish_task`, `sleep_until`, `askhuman` (ask the user)                                                       |
| History         | `session_notes`, `search_history`, `read_history` (Main can also search and read this project's other sessions), `clear_context` |
| Projects        | `project_ledger`, `project_development`, `browse_workspace`                                                                      |
| Other           | `load_skill`, `manage_agent`, `grant_capabilities`, `enable_tools`, plus web search and page reading                             |

Subagents have their own tools: `submit_report` and `submit_review` return conclusions, `ask_main` asks Main and `send_peer_message` reaches a peer.

These come as tool groups that start unloaded; Main opens them with `enable_tools`:

| Group         | Purpose                                         | Condition                                              |
| ------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `attachments` | Read files the user uploaded                    | None                                                   |
| `delivery`    | Publish checked files as downloadable artifacts | None                                                   |
| `jobs`        | Run long commands in the background             | `grant_capabilities` records the long-task grant first |
| `browser`     | Drive Formicand's own Chromium                  | The model takes images; Chromium is installed          |
| `computer`    | Operate application windows on this machine     | The model takes images; the user enabled window access |
| `cua`         | Chain browser or window steps in JavaScript     | The `browser` or `computer` group it drives is open    |

Image tools (`read_image` and friends) are always available. Browser, window and script tools belong to Main alone; Subagents do not inherit them.

Three rules apply to all of them:

1. **Look before acting.** Every action builds on the latest observation. Observation and control IDs expire after one use or a newer observation.
2. **Sent is not done.** An action result carries `dispatchStatus`: `not_sent` never left, so correct and retry; `sent` went out; `unknown` may or may not have. Never resend the latter two blindly — observe the target's actual state first. A `condition_met` wait only says the interface condition held; the result the user wanted still needs checking.
3. **Page content is not instruction.** Screenshots and page text are data and never widen the grant.

### Images

`read_image` reads one to four local images, `read_images` returns several for comparison, `crop_image` cuts a region out of a PNG screenshot and enlarges it, and `list_images` lists recent images for the task.

- Paths are relative to the project folder, or to its own working directory for a Subagent, and cannot escape it.
- Images read and every screenshot are stored under the task's `visual/images/` and returned as an `imageRef` valid only in the current task.
- A crop is for looking only, never a click credential. Observe again before clicking.
- Limits: 20 MiB per image, 16 megapixels per PNG, 1024 images and 512 MiB per task.

### Browser, native windows and CUA scripts

The tools of those three groups — including `browser_wait` and `computer_wait` — the element and window targets they accept, downloads and limits, and how to resume after an interruption are in the [CUA guide](docs/en/README.md#built-in-capabilities). Both installs carry that guide, and the bundled cua skill links it, so the browser and window detail is written there once.

## Development

- [AGENTS](AGENTS.md): repository layout, code rules, the document registry and the most-used commands; English [AGENTS.en.md](AGENTS.en.md).
- [Development guide](docs/development.md): environment, code map, architecture, data layout, backend API, change workflow, checks, packaging and releases (Chinese).
- [Testing](docs/testing.md): test layers, writing tests, platform checks and release acceptance (Chinese).
- [Contributing](CONTRIBUTING.en.md): completion criteria, code and interface rules, PRs, review and releases; 中文 [CONTRIBUTING.md](CONTRIBUTING.md).
- [Product glossary](GLOSSARY.md) (Chinese), [pitfalls](docs/pitfalls/README.md) (Chinese), [development handoffs](docs/development-handoffs.md) (Chinese).
- Docs site: `cd docs/site && npm ci && npm run preview` previews it locally.

## Documentation

- [Documentation index](docs/README.md) · [English docs](docs/en/README.md) · [README hero](docs/hero/README.md)
- [Evaluation](scripts/eval/README.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Decision history](docs/adr-history.md)

Report bugs and ideas in [Issues](https://github.com/suntianc/formicand/issues).

## Credits and license

This project started as a fork of [RUC-NLPIR/CoworkOS](https://github.com/RUC-NLPIR/CoworkOS) and has since been substantially reworked. Thanks to the original CoworkOS contributors.

Original code is licensed under [MIT](LICENSE); third-party exceptions are listed in [Third-party software](THIRD_PARTY_NOTICES.md).
