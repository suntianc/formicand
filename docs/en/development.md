# Development

[简体中文](../development.md) | English

Read [AGENTS](../../AGENTS.en.md) and [Architecture and code map](architecture.md) first. How to write and run tests is in [Testing](testing.md).

## Environment

- Node.js ≥22.19.0, npm and Git. Dependencies follow the lockfile; install with `npm ci`.
- The Mac App and window control need macOS 14+, Apple Silicon and the Xcode Command Line Tools.
- Attachment parsing tests need Python 3.11 with the libraries in [scripts/document-requirements.txt](../../scripts/document-requirements.txt); point `FORMICAND_PYTHON` at that Python.

| To work on | Prepare                                                       | Start                                         |
| ---------- | ------------------------------------------------------------- | --------------------------------------------- |
| CLI        | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, `npm run build:cli` | `npm run cli`, `npm start`                    |
| Web        | `npm ci`, `npm run build`                                     | `npm run ui`, default `http://127.0.0.1:3880` |
| Mac App    | `npm ci`                                                      | `npm run desktop`                             |

## Running and debugging

- **Use isolated data.** Keep development and tests away from real tasks, model settings and documents. Set `FORMICAND_HOME` for a whole separate data directory, or `FORMICAND_DESKTOP_DATA` for desktop data only.
- **Development App.** `npm run desktop` builds and starts `Formicand Dev`. `npm run desktop:install-dev` installs it as a fixed `~/Applications/Formicand Dev.app` that opens from Finder or the Dock and runs the current repository's code; reinstall it after moving the repository. The development and release Apps share the data directory and single-instance lock, so they cannot run at the same time.
- **System permissions.** When testing Screen Recording and Accessibility, open the App from Finder or with `npm run desktop`, never by running the binary in `Contents/MacOS/`, or the permission is recorded for your terminal. Each development runtime has its own identity, so grant the matching `Formicand Dev` entry in System Settings.
- **Page only.** After changing front-end modules or styles, run `npm run build:web-assets` and reload; for continuous work run `npm run watch:web-assets` in another terminal. TypeScript or Swift changes need a rebuild and restart.
- **Standalone backend.** `formicand backend start|status|stop` manages the backend directly. Its instance record is `~/.formicand/runtime/backend-instance.json`. One data directory has at most one backend; starting another reuses the existing one.
- **Updating the source.** `formicand update --check` and `formicand update` follow the current branch's Git upstream and rebuild the CLI. They refuse when there are uncommitted changes, local-only commits, a diverged branch or a merge in progress.

## Change workflow

1. Use the [code map](architecture.md#code-map) to find the module that owns the behavior, its consumers and tests; read the target directory's `AGENTS.md`; check the [pitfalls](../pitfalls/README.md) (Chinese) for the tools, paths or interfaces you touch.
2. Reproduce first, then run the existing related tests. Fix the owning module; entry files only assemble.
3. Add a test that covers the original failure. Asynchronous behavior must cover ownership, cancellation, late responses, conflicts and recovery after exit.
4. Verify by scope: related tests first, then `npm run verify`. Pure doc changes only need `npm run check:docs` and `npm run format:check`. Broad changes run `npm run verify:full`.
5. Update the related docs in the same change. The commit message states the problem and result, the modules involved, the checks run and what was not verified.

Conventions for delegation, rework, independent review and handoffs are in [Development handoffs](../development-handoffs.md) (Chinese).

## Checks

| Command                                      | Checks                                                                                                                         | When                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `npm run test:unit -- --file test/x.test.js` | The given Node tests, building first                                                                                           | Every related change              |
| `npm run verify`                             | CLI and page asset builds, source hygiene, lint, extension types, changed-file formatting, doc links, release runner self-test | After finishing a change          |
| `npm run verify:full`                        | Full build, static checks and all Node tests                                                                                   | Before a release, broad changes   |
| `npm run check:ci`                           | The light checks run on GitHub                                                                                                 | CI runs it                        |
| `npm run check:source`                       | Private configuration, keys, personal paths and files that must not be committed                                               | Before committing                 |
| `npm run check:docs`                         | Local links and heading anchors in the docs                                                                                    | After changing docs or code paths |
| `npm run test:browser`                       | Chromium and Electron user flows                                                                                               | Page and page/HTTP changes        |
| `npm run test:desktop`                       | The packaged App: settings, sessions, quit and restart, simulated upgrade. Run `npm run desktop:pack` first                    | Desktop host or packaging changes |
| `npm run test:release`                       | Every stage of release acceptance                                                                                              | Preparing a release               |

Before running lint on its own, run `npm run build:cli` so the types `.pi/` imports match the source; `verify` already does this in order.

## Lint rules

On top of the usual rules, the [ESLint configuration](../../eslint.config.mjs) flags swallowed errors (catch blocks that neither bind nor rethrow, empty catch blocks and the matching `.catch()` callbacks), unnecessary conditions and unnecessary type assertions.

The [suppression baseline](../../eslint-suppressions.json) is empty and stays an empty object. A justified exception gets its own `// eslint-disable-next-line <rule> -- <reason>` and goes through review. Do not grow the baseline or rewrite code to swallow errors in another form. After touching such code, run `npm run lint -- --prune-suppressions`.

`format:check` checks changed files only; to check the whole repository, run `npm run format:check:all` on a clean tree.

## Branches and merging

- `main` is the only long-lived branch. Work happens on temporary branches that are deleted after merging into `main`.
- Merge with `git merge --no-ff` and rebuild afterwards.
- Versions are defined by tags and GitHub Releases.

The [regular workflow](../../.github/workflows/test.yml) runs `npm run check:ci` on pull requests and pushes to `main`. CI only builds and runs static checks; full tests, browser, native and real-model checks happen locally, so a green CI is not a passed test run.

## Packaging and releases

Only Apple Silicon Mac installers are produced, with ad-hoc signing: no Developer ID signing, notarization or in-app updates.

| Command                | Output                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm run desktop:pack` | `.tmp/release/mac-arm64/Formicand.app`, used by `npm run test:desktop`         |
| `npm run desktop:dist` | `release/Formicand-<version>-mac-arm64.dmg` and its SHA-256                    |
| `npm run cli:pack`     | A CLI package in `release/`; change the directory with `FORMICAND_PACKAGE_DIR` |

Release steps:

1. Finish all acceptance locally; see [Testing](testing.md#release-acceptance).
2. Bump the version and commit: `npm version 0.1.4 --no-git-tag-version`, together with the source and docs for this release.
3. Tag and push: `git tag v0.1.4`, then push the commit and the tag.
4. From a clean checkout of the tag, run `npm run release:local -- v0.1.4`. It checks the tag and version, builds the DMG and CLI package, writes checksums and uploads them to a GitHub Release draft.
5. Review the draft's files, version and notes, then click Publish. Mark test builds as Pre-release and state that they are unsigned and not notarized.

If no local build machine is available, run the [Release Mac workflow](../../.github/workflows/release-mac.yml) manually to build in the cloud; for internal test packages use [Internal Mac package](../../.github/workflows/internal-mac.yml). Files of a published release cannot be replaced; ship fixes as a new version and never move a tag.

Packaging disables asar because Pi extensions and child processes need real file paths. Files are picked by an allowlist, but still inspect the final package for anything that should not ship; do not rely on `.gitignore`.

Formicand's own code is [MIT](../../LICENSE); third-party components keep their licenses, listed in the [third-party notices](../../THIRD_PARTY_NOTICES.md).

## Page conventions

- **Say things once.** Use layout for hierarchy instead of stacked subheadings and explanations. Show only real capabilities and real state.
- **Use tokens for color and motion.** Colors come from the tokens at the top of [formicand.css](../../web/assets/formicand.css); emphasis is black and white only, and color is reserved for meaning such as success, warning and danger. Overlays use the solid `--popover-*` tokens. Durations use the `--motion-*` tokens in [ui.css](../../web/assets/ui.css), never raw values.
- **Type sizes.** Body 15px, controls 14px, secondary text 12px, section titles 16px, panel and dialog titles 18px. The font is the bundled Inter, falling back to system fonts for Chinese.
- **Use the existing components.** Menus use [menu.js](../../web/assets/ui/menu.js), dialogs [modal.js](../../web/assets/ui/modal.js), selects [select-menu.js](../../web/assets/ui/select-menu.js), and short forms the `.app-dialog` in [dialogs.css](../../web/assets/dialogs.css). Icon buttons need an `aria-label`.
- **State belongs to controllers.** Keep UI state separate from the DOM; each controller owns its drafts and request ownership. Check that an async result still belongs to the original task and navigation before applying it, so it never overwrites a conversation the user has moved to. Do not add feature-specific state machines to `web/app.js`.
- **Streaming updates** keep DOM identity, expanded state, focus and reading position.
- **Screenshots for review** cover light and dark themes at 1440/1280 and 474/320 widths, checking contrast, menu placement, title truncation, keyboard focus and horizontal overflow.

## Documentation conventions

- Each fact lives in one document; others link to it. Current behavior goes into the usage and interface docs; planned scope and next steps live in the requirement ledger's development records, not in repository documents.
- Changing a command, setting, path or interface updates the docs in the same change. Commands must match `package.json`, the scripts and the CLI help.
- The usage docs (getting started, configuration, capabilities, architecture, development, testing) are bilingual, with English in `docs/en/`; update both together. Process records (retrospectives, pitfalls, handoffs, decision records and their history) are Chinese only.
- Adding, moving or deleting a document updates the registry in the root [AGENTS](../../AGENTS.md#文档) (Chinese); a choice still in force and hard to reverse becomes an [ADR](../adr/), a superseded decision or a deleted document goes into the [decision history](../adr-history.md), and open items live in the development record.
- Do not commit real keys, private services, personal configuration or user tasks. Examples use placeholders and generic paths.
- Use relative Markdown links. When deleting or moving a document, update every reference and run `npm run check:docs`.

Docs site: `cd docs/site && npm ci && npm run preview` previews locally, and `npm run build` writes a static site to `.tmp/docs-site/`. Navigation lives in [navigation.mjs](../site/navigation.mjs); register new docs there when they belong in the sidebar.

## Troubleshooting

| Symptom                                                       | Check first                                                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Save fails, 409                                               | Revision, outside edits and concurrent submits; keep the draft and reload, never overwrite automatically |
| An agent cannot see an attachment or tool                     | The upload record, whether the tool group is on, first-turn and later context assembly                   |
| A task hangs, does not stop cleanly or repeats after recovery | Task and run events, inbox consumption, questions, delegation, background jobs and process exit          |
| Drafts or attachments vanish after a restart                  | Data directory, global index and draft file; note the real paths first                                   |
| The model fails to start                                      | Address, format, model, parameters and environment overrides; never print the full configuration         |
| An async result overwrites a newer conversation               | The recorded task and draft identity, navigation token and late requests                                 |

Log and record locations are listed under [Data layout](architecture.md#data-layout).
