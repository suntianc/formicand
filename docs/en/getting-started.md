# Mac App quickstart

[简体中文](../getting-started.md) | English

<a id="installation-and-first-task"></a>

macOS 14+ · Apple Silicon

<a id="mac-app"></a>
<a id="before-installing"></a>

## Install

In a source checkout, run `npm ci` and `npm run desktop:dist` to get `Formicand-<version>-mac-arm64.dmg` in `release/`; open it and drag the App into Applications. You can also run it in development mode with `npm run desktop`, see the [development guide](development.md#environment). If macOS blocks the first launch, follow [Apple's guidance](https://support.apple.com/en-us/102445) in System Settings → Privacy & Security.

The App has no in-app updater; upgrade manually with a local DMG. Back up user data and external projects, finish tasks and stop the standalone backend, then quit the App. Retain the old App, copy the new one into the installation directory and verify your data after launch. See [installation and upgrades](installation-reference.md#updates). This build has not been notarized by Apple.

## Connect a model

On first launch the App opens Settings → Models with the Add provider dialog. Pick your provider (a preset only needs the API key), or choose Custom, enter the API address and pick the format (Chat Completions, Responses or Anthropic Messages). Select Add and fetch models, then tick the models you want. The service must support streaming and tool calls in the selected format.

Select Check in the provider's detail to confirm the connection; a check uses a little quota. See [model settings](configuration.md) for more options.

## Create a project

In Finder, create an empty folder named `formicand-quickstart` in Documents.

In Formicand's sidebar, select `+` beside Projects. Enter a project name and choose that folder. Then select `+` beside the project title to open a new conversation.

## Complete your first task

Send:

> Create hello.txt in the current project, write “Hello, Formicand.”, then read the file and confirm its contents.

When the task finishes, open the selected `formicand-quickstart` folder in Finder. It should contain `hello.txt` with the text `Hello, Formicand.`.

<a id="cli-archive"></a>

<a id="cli-from-source"></a>

<a id="updates"></a>
<a id="data-exit-and-upgrades"></a>
<a id="troubleshooting"></a>

[CLI](cli-quickstart.md) · [From source](development.md#environment) · [Updates & troubleshooting](installation-reference.md)
