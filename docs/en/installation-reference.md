# Installation, updates and troubleshooting

[简体中文](../installation-reference.md) | English

For first installation, see the [Mac App](getting-started.md) or [CLI quickstart](cli-quickstart.md).

## Name and data directory

The product, command, packages and data directory are all named Formicand: the command is `formicand`, configuration and tasks live in `~/.formicand/` (move it with `FORMICAND_HOME`), environment variables start with `FORMICAND_`, and the desktop bundle ID is `io.github.suntianc.formicand`.

Starting the CLI or running `formicand doctor` refreshes search adapters to the current runtime path. Only product-owned scripts are replaced; user-installed tools and symbolic links are preserved.

Installed Apps have no in-app updater and are upgraded manually with a local DMG; existing user data stays in its data directory.

## Updates

Save documents and finish running tasks before updating.

Upgrade the Mac App manually from a local DMG:

1. Back up `~/.formicand/` (or the actual `FORMICAND_HOME`) and external projects, then finish running tasks. For each running data root, use a matching CLI to run `formicand backend stop` and confirm `stopped` or `absent`; then quit the App.
2. Verify the DMG SHA-256 and open it. Rename the old App to retain it, then drag the new App to the original installation directory. App resources and user data are separate.
3. Open the new App and check connections, conversations, attachments and settings. If startup or data validation fails, quit the new App, restore the retained old App and any needed data backup, and retry.

See [development](development.md#standalone-backend) for standalone backend start, status and stop.

For a source installation, exit the interactive interface first, then run these commands in your system terminal:

```sh
formicand update --check
formicand update
formicand --version
```

`--check` only checks; it does not install. After `update` completes, the next launch uses the new version. For source checkout requirements, see [development](development.md#updating-a-source-checkout). A CLI archive you packaged yourself has no updater; install the newer archive instead.

## Data and backups

Configuration and tasks default to `~/.formicand/`. Project files stay in the project folder from which you start the CLI. Inspect the actual paths in your terminal:

```sh
formicand data paths
```

Back up important user data and external project files together. See [workspace persistence](../task-workspace-layout.md) (Chinese) for the layout. Updates preserve existing data; do not delete the user directory to troubleshoot. After reopening the App, continue in the original conversation. See [CLI quickstart](cli-quickstart.md) for CLI exit and recovery.

## Troubleshooting

### `node: command not found` or an old Node.js version

Install Node.js 22.19.0 or newer from [Node.js](https://nodejs.org/en/download), then reopen your terminal and run:

```sh
node --version
npm --version
```

Continue with CLI installation after both commands print version numbers.

### `formicand: command not found`

`npm link` puts the command in npm's global `bin` directory. Show that directory:

```sh
echo "$(npm prefix -g)/bin"
```

Add it to PATH once, choosing the line for your shell (check with `echo "$SHELL"`):

```sh
# zsh (macOS default)
printf '%s\n' "export PATH=\"$(npm prefix -g)/bin:\$PATH\"" >> "$HOME/.zshrc"
# bash (common on Linux)
printf '%s\n' "export PATH=\"$(npm prefix -g)/bin:\$PATH\"" >> "$HOME/.bashrc"
```

Open a new terminal and run `formicand --version` to confirm.

### `npm link` reports a permission error

When npm's global directory is not writable, move it to your home directory and run the link again in the source checkout:

```sh
npm config set prefix "$HOME/.local"
npm link
```

Then add `$HOME/.local/bin` to PATH as above. Do not install with `sudo`.

### `配置已存在，未覆盖` (configuration exists; not overwritten)

`formicand init` creates a new configuration without overwriting an existing file. First run this in your project folder:

```sh
formicand doctor
```

Read the path printed after `配置路径：`. If the saved configuration is valid, run `formicand` directly. To change it, open that file and edit `baseUrl`, `model`, `apiKey` or `api` using [CLI files and environment variables](configuration.md#cli-files-and-environment-variables). `formicand init --force` retains populated fields rather than asking for every connection value again.

### `FAIL 模型配置` or `FAIL 流式模型连接与工具调用`

Read the error on that line and the printed configuration path:

- Missing configuration: run `formicand init` in your project folder and enter your provider's API URL, model ID and API key.
- Invalid JSON or model fields: open the printed configuration file and fix it using [CLI configuration](configuration.md#cli-files-and-environment-variables). Do not post the full file or key in issue reports.
- A service that only supports Chat Completions: run the commands below in the current terminal, then test again.
- Authentication, access or quota errors: check the provider's API key, model access and balance, then test again.

```sh
export FORMICAND_MODEL_API=openai-completions
formicand doctor --test-connection
```

The format switch above is only for Chat Completions services and only applies in the current terminal. See [CLI configuration](configuration.md#cli-files-and-environment-variables) to save it. For a Responses service, fix its configuration and rerun `formicand doctor --test-connection` directly. Start a task only after all checks pass.

### The Mac App cannot open or save a connection

If macOS blocks the first launch, follow the system prompt using the [Mac installation guide](getting-started.md#mac-app). If saving a connection stays on Saving, respond to the Keychain prompt. If access was denied, select Save again to retry.

When reporting problems, include the version, OS and chip, installation method, reproduction steps and a redacted error. Do not send API keys, complete private configuration or unfiltered task logs.
