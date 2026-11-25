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

## Run from source

Requires Node.js ≥22.19.0; the Mac App needs macOS 14+ on Apple Silicon.

```sh
git clone https://github.com/suntianc/formicand.git
cd formicand
npm ci
npm run desktop   # Mac App (development mode)
npm run ui        # Web UI
npm run cli       # Terminal
```

On first launch, add a model service under Settings → Models; see the [Mac App quickstart](docs/en/getting-started.md).

## Documentation

| Guide                                                            | Description                                         |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| [User guide](docs/en/README.md)                                  | Install, connect a model, finish a first task       |
| [CLI quickstart](docs/en/cli-quickstart.md)                      | Install and use the `formicand` command             |
| [Model settings](docs/en/configuration.md)                       | Service URL, model ID and API format                |
| [Updates and troubleshooting](docs/en/installation-reference.md) | Data directory, backups, upgrades and common issues |
| [Development guide](docs/en/development.md)                      | Build Web/Desktop/CLI and run local checks          |
| [Contributing](CONTRIBUTING.en.md)                               | Workflow and verification requirements              |

Report bugs and ideas in [Issues](https://github.com/suntianc/formicand/issues).

## Credits and license

This project started as a fork of [RUC-NLPIR/CoworkOS](https://github.com/RUC-NLPIR/CoworkOS) and has since been substantially reworked. Thanks to the original CoworkOS contributors.

Original code is licensed under [MIT](LICENSE); third-party exceptions are listed in [Third-party software](THIRD_PARTY_NOTICES.md).
