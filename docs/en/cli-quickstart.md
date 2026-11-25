# CLI quickstart

[简体中文](../cli-quickstart.md) | English

macOS / Linux · Node.js >=22.19.0 · npm · Git

## Install from source

Requires [Node.js ≥22.19.0](https://nodejs.org/en/download) (including npm) and Git. In a terminal, run:

```sh
git clone https://github.com/suntianc/formicand.git
cd formicand
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:cli
npm link
formicand --version
```

The last command should print `Formicand` and the version. Afterwards, run `formicand update` in this checkout to follow its upstream branch; see the [development guide](development.md#updating-a-source-checkout).

## Connect a model

Create a test folder and enter it first. The CLI reads and writes project files in the folder from which you start it; the installation directory does not need to be inside the project.

```sh
mkdir -p "$HOME/formicand-quickstart"
cd "$HOME/formicand-quickstart"
formicand init
```

Enter your provider's API URL, model ID and API key in that order. The URL and model ID below are placeholders: enter your own values. Key input does not display characters.

```text
API 地址（根地址或 /v1）: https://your-service.example/v1
模型 ID: YOUR_MODEL_ID
API Key（输入隐藏）:
```

Successful setup prints `连接配置已保存：` followed by the file path, normally `~/.formicand/config.json`. If it reports `配置已存在，未覆盖` (configuration exists; not overwritten), check the saved connection using [troubleshooting](installation-reference.md#troubleshooting).

New connections default to Responses. The service must support streaming and tool calls. If it only supports Chat Completions, run this in the same terminal first:

```sh
export FORMICAND_MODEL_API=openai-completions
```

This setting applies only to this terminal and the CLI processes it starts. To keep the format for future terminals, save it using [CLI files and environment variables](configuration.md#cli-files-and-environment-variables).

Then test the connection. This sends a model request and uses quota.

```sh
formicand doctor --test-connection
```

Continue after all checks pass. A successful model connection prints:

```text
OK  流式模型连接与工具调用
```

If a line starts with `FAIL`, resolve the error on that line using [troubleshooting](installation-reference.md#troubleshooting), then run the same test command again.

## Complete your first task

Start from the terminal that is still in `~/formicand-quickstart`:

```sh
formicand
```

When the interactive interface appears, enter this request in its input area and press Enter:

> Create hello.txt in the current project, write “Hello, Formicand.”, then read the file and confirm its contents.

Press `Esc` to interrupt an active reply. Otherwise, wait for the task to finish and display a reply. Clear the input area, then press `Ctrl+D` to exit; this shortcut only exits when the input is empty. Back at the terminal's command prompt, run:

```sh
cat hello.txt
```

Expect:

```text
Hello, Formicand.
```

The file is at `~/formicand-quickstart/hello.txt`.

## Continue using the CLI

In a new terminal, return to the same project folder and continue the latest conversation:

```sh
cd "$HOME/formicand-quickstart"
formicand --continue
```

Run `formicand --resume` to choose a saved conversation. Running `formicand` directly starts a new conversation.

[Updates & troubleshooting](installation-reference.md) · [From source](development.md#environment)
