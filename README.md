<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/readme-hero.png">
    <img src="docs/assets/readme-hero.gif" alt="Formicand: geometric wordmark, fixed OS frame and illustrated desktop workspace" width="100%">
  </picture>
</p>

<p align="center">
  <a href="docs/en/README.md"><img src="docs/assets/badges/docs.svg" alt="Documentation"></a>
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="License: MIT; third-party exceptions below"></a>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> | <b>English</b>
</p>

**Formicand is a personal agent client that runs on your own machine.** It keeps the Main Agent, Coordinator Runtime, Subagents, durable tasks and recovery, and keeps project workspaces, execution records and configurable model services local.

- **Delegated work.** The Main Agent plans, delegates and evaluates; the Coordinator Runtime dispatches subtasks and tracks their lifecycles; Subagents run as separate processes on scoped assignments.
- **Development delivery.** The first built-in kind of work is software development: requirement ledger and board, scoped tickets, independent review, rework and merge.
- **Memory and context.** Main keeps user-level and project-level memory with the `memory` tool, and long sessions are compacted so work can continue. Settings → Memory lists, edits and deletes it.
- **Tools.** CLI, files, search, MCP, custom Agents and skills, and Computer Use on macOS.

What is included and what was removed is listed in [capabilities and migration](docs/en/builtin-capabilities.md).

## Run from source

Requires Node.js ≥22.19.0.

```sh
npm ci
npm run build
npm run ui
# Desktop: npm run desktop
# CLI: npm run cli
```

## Documentation and contributing

| Guide                                                            | Description                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| [User guide](docs/en/README.md)                                  | Install, configure models, and explore workflows             |
| [Model settings](docs/en/configuration.md)                       | Configure provider routes, model IDs, and connection formats |
| [Updates and troubleshooting](docs/en/installation-reference.md) | Updates, backup, recovery, and installation troubleshooting  |
| [Development](docs/en/development.md)                            | Build Web/Desktop/CLI and run local checks                   |
| [Contributing](CONTRIBUTING.en.md)                               | Contribution workflow and validation                         |
| [Report an issue](https://github.com/suntianc/formicand/issues)   | Report bugs or request changes                               |

## Acknowledgments and license

This project started as a fork of [RUC-NLPIR/CoworkOS](https://github.com/RUC-NLPIR/CoworkOS) and has since been substantially reworked. Thanks to the original CoworkOS contributors.

The project's own code is licensed under [MIT](LICENSE); third-party exceptions are listed in [third-party notices](THIRD_PARTY_NOTICES.md).
