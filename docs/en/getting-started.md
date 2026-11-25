# Getting started

[简体中文](../getting-started.md) | English

Formicand has two entry points: the Mac App and the `formicand` command in a terminal. Both share one runtime and one data directory, `~/.formicand/`.

## Requirements

- Mac App: macOS 14 or later on Apple Silicon.
- CLI: macOS or Linux.
- Both need [Node.js ≥22.19.0](https://nodejs.org/en/download) (with npm) and Git.

Get the source:

```sh
git clone https://github.com/suntianc/formicand.git
cd formicand
npm ci
```

For the CLI only, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` skips the Electron download.

## Mac App

Two ways to run it:

| Way         | Command                | Notes                                                                                              |
| ----------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| Development | `npm run desktop`      | Builds and starts `Formicand Dev` from source; rerun after changing code                           |
| Installer   | `npm run desktop:dist` | Writes `Formicand-<version>-mac-arm64.dmg` to `release/`; open it and drag the App to Applications |

The installer is not notarized by Apple. If macOS blocks the first launch, allow it under System Settings → Privacy & Security, following [Apple's instructions](https://support.apple.com/102445).

### Connect a model

On first launch the App opens Settings → Models and shows "Add provider":

1. Pick a preset provider and enter only the API key. For any other service choose "Custom", enter the API address and pick the format: Chat Completions, Responses or Anthropic Messages.
2. Click "Add and fetch models", tick the models you want and add them. If the provider has no model list, use "Add manually" to enter a model ID.
3. In the provider details click "Check" to confirm the connection and tool calls work. The check uses a little quota.

The service must support streaming and tool calls in the chosen format. More options are in [Configuration](configuration.md).

### First task

1. Create an empty folder in Finder, for example `formicand-quickstart`.
2. Click `+` next to "Projects" in the sidebar, give it a name and choose the folder.
3. Click `+` next to the project title to start a conversation, and send:

   > Create hello.txt in the current project with the text "Hello, Formicand.", then read the file back and confirm its content.

When it finishes, the folder contains `hello.txt` with `Hello, Formicand.`.

## CLI

Build and register the command from the source directory:

```sh
npm run build:cli
npm link
formicand --version
```

The last command prints Formicand and its version. Rerun `npm run build:cli` after changing the source.

### Connect a model

The CLI reads and writes project files in the folder it starts in. Create a test folder, then configure a model:

```sh
mkdir -p "$HOME/formicand-quickstart"
cd "$HOME/formicand-quickstart"
formicand init
```

Enter the API address, model ID and API key when asked; the key is not echoed. The configuration is saved to `~/.formicand/config.json` by default.

Connections created by `init` use the Responses format. If the service only supports Chat Completions, add `"api": "openai-completions"` to the configuration file; see [Configuration file](configuration.md#configuration-file).

Test the connection (this calls the model and uses quota):

```sh
formicand doctor --test-connection
```

Once you see `OK` on the streaming connection and tool call line, you are ready.

### First task

```sh
formicand
```

Send the same request as in the App section. Press `Esc` to interrupt a reply; clear the input and press `Ctrl+D` to exit. Then `cat hello.txt` should print `Hello, Formicand.`.

### Continue a conversation

| Command                         | Effect                                           |
| ------------------------------- | ------------------------------------------------ |
| `formicand`                     | Start a new conversation                         |
| `formicand --continue`          | Continue the latest conversation in this project |
| `formicand --resume`            | Pick one from the history                        |
| `formicand session export <ID>` | Export a conversation as JSON or HTML            |

`formicand --help` lists all commands.

## Updating

For a source checkout, quit the running App and CLI first, then run:

```sh
formicand update --check   # check only
formicand update
```

`update` pulls from the branch's Git upstream and rebuilds the CLI. If you run the App in development mode, run `npm run desktop` again afterwards; if you use the installer, build a new DMG and install it over the old one. Your data is not affected.

## Data and backups

| What                                 | Where                                                     |
| ------------------------------------ | --------------------------------------------------------- |
| Configuration, keys, tasks, sessions | `~/.formicand/`; move it with `FORMICAND_HOME`            |
| Project files                        | The project folder you chose; Formicand edits it in place |

`formicand data paths` prints the actual paths. Back up the data directory together with your project folders. The project ledger has its own `formicand data backup` command; see [Configuration](configuration.md#project-data). Do not delete the data directory to troubleshoot.

## Troubleshooting

| Symptom                                            | Fix                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node: command not found` or old version           | Install Node.js 22.19.0 or later and reopen the terminal                                                                                                         |
| `formicand: command not found`                     | Add `$(npm prefix -g)/bin` to `PATH` and reopen the terminal                                                                                                     |
| `npm link` permission error                        | Run `npm config set prefix "$HOME/.local"`, retry, and add `$HOME/.local/bin` to `PATH`; do not use `sudo`                                                       |
| Configuration already exists, not overwritten      | `init` never overwrites. Run `formicand doctor` to see which file is used and edit it, or use `formicand init --force`                                           |
| `FAIL` on the model configuration                  | Fix the JSON at the path `doctor` prints; run `formicand init` if there is none yet                                                                              |
| `FAIL` on the streaming connection                 | Check the address, model ID, key and quota; a Chat Completions only service needs `api` changed, see [Connection failures](configuration.md#connection-failures) |
| The App stays on "Saving" when saving a connection | Answer the Keychain prompt; if you declined it, click save again                                                                                                 |

When reporting a problem, include the version, system, install method, steps to reproduce and the error with secrets removed. Never send your API key or full configuration file.
