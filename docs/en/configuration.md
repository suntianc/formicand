# Configuration

[简体中文](../configuration.md) | English

The first connection is walked through in [Getting started](getting-started.md). This page describes every setting.

## Model connections

A connection needs four things:

| Item    | Value                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Address | The service root or the `/v1` address. Do not include paths like `/responses` or `/chat/completions` |
| Model   | A model ID your account can call                                                                     |
| API key | The key for this service                                                                             |
| Format  | `openai-responses`, `openai-completions` or `anthropic-messages`                                     |

The service must support streaming and tool calls in the chosen format.

### Settings in the App

Settings → Models manages providers and models; Settings → Agents decides which model each agent uses.

- A bare domain gets `/v1` appended; an address with a path is used as is. `anthropic-messages` addresses are never changed.
- The parameter button on a model row sets the context window, output limit, reasoning level and image input. Values marked "Auto" come from the provider or the built-in catalog.
- After changing a name, address, key or format, click "Save".
- A model or provider in use by an agent cannot be removed or disabled; switch the agent first.

### Which model each agent uses

The "Built-in" group under Settings → Agents has three agents: Main (coordinates), Executor (implements) and Reviewer (reviews). Their roles, permissions and tools are fixed; you can change the model, reasoning level, skills, MCP servers and extra prompt. The "Projects" page can override these per project; anything not overridden follows the global setting.

| Agent    | Model when none is chosen                 | Default skills                                                                                    | Default MCP         |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| Main     | First model of the first enabled provider | All                                                                                               | All enabled servers |
| Executor | Same as Main                              | `implement`, `tdd`, `diagnosing-bugs`, `code-review`, `domain-modeling`, `codebase-design`, `cua` | None                |
| Reviewer | Same as Main                              | `code-review`, `domain-modeling`, `codebase-design`, `cua`                                        | None                |

When changes apply:

- Main's settings apply from its next turn.
- Executor and Reviewer skills, MCP and extra prompt are fixed when the work is delegated; the model is read when the work item actually starts. Work items already running are not affected.
- Switching models keeps the conversation; the next turn sends the history to the new service.

## Configuration file

The CLI and the source Web server use the first file that exists, without merging:

1. The file named by `FORMICAND_CONFIG`;
2. `.formicand/config.json` in the start directory;
3. `config.json` in the start directory;
4. `~/.formicand/config.json` (or `FORMICAND_HOME/config.json`).

Environment variables override the file, and command-line options override environment variables. A selected file with errors is reported, never skipped. `formicand doctor` shows which file is in use.

App settings are written to the same file on the execution host; providers live under `modelProviders`.

### Single CLI connection

```json
{
  "baseUrl": "https://your-service.example/v1",
  "model": "your-model-id",
  "apiKey": "replace-with-your-api-key",
  "api": "openai-responses"
}
```

`formicand init` only creates files; `formicand init --force` reads the existing file and asks only for missing values. Scripts can read the key from an environment variable:

```sh
formicand init --base-url https://your-service.example/v1 --model your-model-id --api-key-env FORMICAND_API_KEY
```

Optional flags: `--images`, `--reasoning`, `--thinking high`, `--max-tokens 8192`, `--force`.

For a project-only configuration, run `FORMICAND_CONFIG="$PWD/.formicand/config.json" formicand init` in the project. For source development you can copy `config.example.json` to `.formicand/config.json`.

When both `modelProviders` and the top-level fields exist, `modelProviders` wins.

### Model parameters

These fields can be set on a single connection or on each model under `modelProviders`.

| Field                                 | Meaning                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `api`                                 | Format. Defaults to `openai-completions`; `init` writes `openai-responses`             |
| `supportsImages`                      | Send images to the model. Default `false`                                              |
| `reasoningEffort`                     | `off`, `low`, `medium`, `high`, `xhigh`, `max`; the service must support it            |
| `supportsReasoningEffort`             | Send the reasoning effort field. Default `false`                                       |
| `thinkingFormat`                      | `auto` (default), `openai` or `zai`; Chat Completions only. Use `zai` for GLM gateways |
| `supportsPromptCacheKey`              | Send `prompt_cache_key` to third-party services. Default `false`                       |
| `contextWindow`                       | Context budget, default 256000 tokens; used for automatic compaction, not sent         |
| `mainMaxTokens` / `subagentMaxTokens` | Output limit per request; 8192 for new connections                                     |
| `workspaceRoot`                       | Task data directory; use an absolute path                                              |

On connections without image support, the image tools say so explicitly, and the browser and window tools are not offered.

### Providers

```json
{
  "modelProviders": {
    "version": 1,
    "providers": [
      {
        "id": "<provider id>",
        "name": "DeepSeek",
        "preset": "deepseek",
        "baseUrl": "https://api.deepseek.com",
        "api": "openai-completions",
        "enabled": true,
        "models": [{ "id": "deepseek-chat", "contextWindow": 256000, "mainMaxTokens": 8192 }]
      }
    ]
  }
}
```

Models are referenced as `<provider id>#<model id>`. `preset` only sets the icon and preset address in the UI.

### Agent settings

Settings → Agents writes `roleModels`:

```json
{
  "roleModels": {
    "version": 1,
    "host": {
      "main": { "profileId": "<provider id>#<model id>", "thinkingLevel": "high", "mcp": "all" },
      "executor": {
        "skills": ["pg-migration"],
        "mcp": ["postgres"],
        "prompt": "Run the tests before changing code."
      }
    },
    "projects": { "/path/to/project": { "executor": { "thinkingLevel": "medium" } } }
  }
}
```

`host` is the default for this machine; `projects` overrides by project directory. Every field is optional; `skills` and `mcp` take a list of names or `"all"`. A reference to a missing model is an error and the run is refused; it never silently switches to another model.

## Where keys are stored

| Key                                | Location                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Model and search keys              | `credentials.json` next to the configuration (mode 0600); move it with `FORMICAND_CREDENTIALS` |
| The App's session with the backend | Encrypted with the system Keychain in `client-sessions.json`                                   |

The UI and the API only report that a key is configured; they never return it. Removing a provider removes its key. A damaged credentials file is reported and kept, never overwritten.

## Web search

Search uses [Exa's hosted MCP](https://exa.ai/docs/get-started/exa-mcp) by default, with a search tool and a page reader.

- Turn it off: `"webSearch": { "provider": "off" }` in the configuration, or `FORMICAND_WEB_TOOLS=0`.
- Use your own Exa key: `webSearch.exaApiKey`, or `FORMICAND_EXA_API_KEY` / `EXA_API_KEY`.

A resident Main picks up changes at its next turn.

## Network proxy

| Field        | Environment variable          |
| ------------ | ----------------------------- |
| `httpProxy`  | `HTTP_PROXY` / `http_proxy`   |
| `httpsProxy` | `HTTPS_PROXY` / `https_proxy` |
| `noProxy`    | `NO_PROXY` / `no_proxy`       |

Environment variables win. Only HTTP(S) proxy addresses are accepted. `localhost`, `127.0.0.1` and `::1` always bypass the proxy.

## Project data

Projects, the requirement ledger, the board, development and merge records are kept in the project data service. It uses local SQLite by default, at `~/.formicand/runtime/project-data.sqlite`. PostgreSQL is also supported:

```json
{
  "projectData": {
    "engine": "postgres",
    "postgres": { "connectionString": "postgresql://formicand@db.example:5432/formicand" }
  }
}
```

Another backend can share the same data by connecting to that service instead of opening a local database:

```json
{ "projectData": { "authority": { "url": "http://127.0.0.1:3880", "token": "<host credential>" } } }
```

The engine is fixed at startup. A bad configuration, an unreachable database or failed authentication stops startup; it never switches engines or continues with an empty database. Changing engines does not move existing data.

Backup and restore:

```sh
formicand data backup --to ~/backups/project-data.json
formicand data restore --from ~/backups/project-data.json
```

A backup contains only the project database records, not session history or project files. Stop the backends that write this data directory before restoring, then start them again. A database from an unknown version is refused, with the file and version named.

## External Main capacity

Mains created through the external entry point are limited by slots; without this setting, external sessions are refused:

```json
{ "mainCapacity": { "resident": 2, "continuation": 1 } }
```

`resident` is the number of external regular Mains that can run at once; `continuation` is reserved for continuation Mains. They are not shared and each is at most 32. Requests over the limit queue in order.

## Run limits

| Field                       | Environment variable                     | Default                                              |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `mainMaxTurns`              | `FORMICAND_MAIN_MAX_TURNS`               | 2000                                                 |
| `subagentMaxTurns`          | `FORMICAND_MAX_TURNS`                    | 200                                                  |
| `mainTimeoutMs`             | `FORMICAND_MAIN_TIMEOUT_MS`              | 0, no limit                                          |
| `mainIdleTimeoutMs`         | `FORMICAND_MAIN_IDLE_TIMEOUT_MS`         | 300000 (5 minutes); 0 keeps an idle Main running     |
| `subagentTimeoutMs`         | `FORMICAND_SUBAGENT_TIMEOUT_MS`          | 0, no limit                                          |
| `commandTimeoutMs`          | `FORMICAND_COMMAND_TIMEOUT_MS`           | 1800000 (30 minutes); 0 no limit                     |
| `maxAttempts`               | `FORMICAND_MAX_ATTEMPTS`                 | 3 including the first delegation; 1 disables retries |
| `subagentQuestionTimeoutMs` | `FORMICAND_SUBAGENT_QUESTION_TIMEOUT_MS` | 180000 (3 minutes); 0 stops subagents asking Main    |
| `subagentMaxQuestions`      | `FORMICAND_SUBAGENT_MAX_QUESTIONS`       | 3                                                    |
| `humanAnswerTimeoutMs`      | `FORMICAND_HUMAN_ANSWER_TIMEOUT_MS`      | 60000 (1 minute)                                     |

Times are in milliseconds. `mainIdleTimeoutMs` is how long a resident Main stays alive with no turn in progress and no subagent running; it then exits, keeps the session, and the next message starts it again.

## Environment variables

| Variable                                                            | Purpose                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `FORMICAND_CONFIG`                                                  | Configuration file                                             |
| `FORMICAND_HOME`                                                    | Data directory, default `~/.formicand`                         |
| `FORMICAND_API_BASE` / `FORMICAND_MODEL` / `FORMICAND_API_KEY`      | Override address, model, key                                   |
| `FORMICAND_MODEL_API`                                               | Override the format; same values as `api`                      |
| `FORMICAND_SUPPORTS_IMAGES`                                         | `1` on, `0` off                                                |
| `FORMICAND_REASONING_EFFORT`                                        | Reasoning effort                                               |
| `FORMICAND_WORKSPACE`                                               | Task data directory, default `~/.formicand/workspace`          |
| `FORMICAND_PROJECT_DIR`                                             | Project directory for Main's files and commands                |
| `FORMICAND_UI_PORT`                                                 | Port of the source Web server, default 3880                    |
| `FORMICAND_PROJECT_DATA_ENGINE`                                     | Project data engine: `sqlite` or `postgres`                    |
| `FORMICAND_PROJECT_DATA_SQLITE` / `FORMICAND_PROJECT_DATA_URL`      | SQLite file / PostgreSQL connection string                     |
| `FORMICAND_PROJECT_DATA_AUTHORITY` / `FORMICAND_PROJECT_DATA_TOKEN` | Shared project data service address / credential               |
| `FORMICAND_TRUSTED_CLIENT_ORIGINS`                                  | Local page origins allowed to use the backend, comma separated |

Other `FORMICAND_` variables pass state between processes and are not meant to be set by hand.

## Other settings

- **Language**: Settings → General → Language, Simplified Chinese or English; reload the page to apply.
- **Appearance**: stored in `appearance.json` in the data directory for the App, and in the browser for the Web.
- **Command search path**: an App started from Finder or the Dock adds `~/.local/bin`, Homebrew and `/usr/local/bin` to `PATH`, so Main and subagents can use them.

## Connection failures

| Problem                               | Fix                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 401 / 403                             | Check the API key, model ID and the account's model access                                                           |
| 404                                   | Check the address and model ID; remove `/responses` or `/chat/completions` from the address                          |
| Format or parameter not supported     | Use a format the service supports; turn off image, reasoning or cache options it lacks                               |
| File edited but old values still used | Check `FORMICAND_API_BASE`, `FORMICAND_MODEL`, `FORMICAND_API_KEY`, `FORMICAND_MODEL_API`; environment variables win |

Check again afterwards: click "Check" in the App, or run `formicand doctor --test-connection`.

Implementation: [config reading](../../src/runtime/config.ts), [run settings](../../src/runtime/runtime-settings.ts), [connection parameters](../../src/runtime/model-profile.ts).
