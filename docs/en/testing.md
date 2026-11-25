# Testing

[简体中文](../testing.md) | English

Choose tests by the scope of the change: test what you changed, and rerun only what failed. Full runs are for releases and broad changes. What each command does is listed under [Development](development.md#checks).

## Test layers

| Layer         | Where                              | Proves                                                                    | Does not prove                                 |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Node tests    | `test/`                            | Functions, services, protocols, real Pi process lifecycles                | Page interaction, real model ability           |
| Browser tests | `e2e/`                             | User flows across the page and the backend                                | Installing on a clean machine                  |
| Desktop tests | `npm run test:desktop`             | The packaged App: settings, sessions, quit and restart, simulated upgrade | Signing, notarization, real system permissions |
| Native tests  | `npm run test:release -- --native` | Real windows, input and system permissions                                | A full task in commercial software             |
| Real model    | Configured and run by hand         | Requests and representative tasks on a real service                       | Other services and models                      |
| Install check | Final DMG on another Mac           | First launch, connection, recovery, backup and upgrade                    | —                                              |

Passing one layer never replaces the next. A local fake model proves protocol and lifecycle correctness, not model ability.

## Running tests day to day

```sh
npm run test:unit -- --file test/artifact-store.test.js   # given file; repeat --file for more
npm run test:unit -- --match artifact                     # files whose path contains "artifact"
npm run test:unit -- --list --match artifact              # list without running
npm run test:unit -- --skip-build --file test/x.test.js   # skip the build when it matches the source
node --test test/repository-checks.test.js                # script tests that need no build
```

- `--file` is an exact path and `--match` a case-sensitive path substring; they cannot be combined. A typo or an empty match fails immediately.
- `.test.js`, `.test.mjs` and `.test.ts` files under `test/` are discovered automatically; `.ts` files run from their compiled output.
- Use `--skip-build` only when the build matches the current source; a pass on a stale `dist/` does not count.
- Test and skip counts come from this run only; never quote earlier pass counts. Exit code 0 does not mean the skipped parts were verified.

Browser tests:

```sh
npx playwright install chromium      # first time only
npm run test:browser                 # build, then run all
npx playwright test e2e/conversation-menu.spec.js --output=.tmp/playwright-menu
```

Give each parallel Playwright process its own `--output`, or they delete each other's results.

## Rules for writing tests

- **Isolate data.** Use temporary directories and a fake model service; never read personal configuration, touch real tasks or call a real model.
- **Temporary directories are cleaned up.** Each `test:unit` and Playwright run creates its own temporary root (`formicand-run-*`) and points `TMPDIR` at it ([test-run-root](../../scripts/test-run-root.mjs)). A backend still running from that root at the end is stopped and fails the run.
- **Clean up after starting the App.** The backend keeps running after its window closes, so tests that start the App must call [`stopNativeBackend(<desktop data directory>)`](../../test/native-backend-fixture.mjs) at the end.
- **Use the real path.** Lifecycle tests must cover the real Pi hook order and child process exit, not just test doubles.
- **Cover async edges.** Ownership, cancellation, late responses, conflicts, exit and recovery. Protocol tests verify both ends.

## Special suites

**Project data on both engines.** SQLite and PostgreSQL run the same scenarios:

```sh
docker pull postgres:18.6-alpine3.24
node scripts/test.mjs --skip-build --file test/p3-foundation-integration.test.js
```

Without Docker or PostgreSQL this test fails rather than skipping. Set `FORMICAND_TEST_ENGINES=sqlite` to run SQLite only, but run both before merging. UI flow: `npx playwright test e2e/p3-foundation-flow.spec.js --workers=1`.

**Performance.** Check read counts, concurrent requests and DOM reuse before measuring time:

```sh
node --test test/workspace-directory-performance.test.js test/refresh-performance.test.js test/event-stream-ledger-performance.test.js
npx playwright test e2e/dashboard-polling.spec.js e2e/composer-visibility.spec.js --workers=1
```

Compare timings only with the same data, window count, cold or warm state and load.

**Packaged App.** After `npm run desktop:pack`, run `npm run test:desktop`. With an existing candidate:

```sh
FORMICAND_DESKTOP_APP=.tmp/release/mac-arm64/Formicand.app node scripts/desktop-smoke.mjs
FORMICAND_DESKTOP_APP=.tmp/release/mac-arm64/Formicand.app node scripts/desktop-smoke.mjs --settings-only
```

**Native windows and input.** These need an unlocked Mac with the system permissions already granted: `npm run test:release -- --native --stage app`. The normal test entry points skip them.

**Attachment parsing.** Needs Python 3.11 with the libraries in [document-requirements.txt](../../scripts/document-requirements.txt), pointed to by `FORMICAND_PYTHON`. Missing libraries are an environment problem; a skip is not a pass.

## Release acceptance

`npm run test:release` runs the existing automated tests in four stages and saves logs and a report. It never calls paid models and never requests system permissions.

```sh
npm run test:release -- --list              # show the plan without building or running
npm run test:release                        # build once and run every stage
npm run test:release -- --stage cli         # one stage only
npm run test:release -- --native            # add real window and Electron tests (Mac)
npm run test:release -- --native --packages # also build the CLI package and DMG for manual install checks
npm run test:release:runner                 # tests for the release runner itself
```

| Stage      | Covers                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| Basics     | Core mechanisms without the terminal or the UI                           |
| CLI        | The terminal entry, configuration, install, commands and interaction     |
| App        | The desktop host, conversation UI, input and navigation                  |
| User cases | A complete user goal, combining capabilities to deliver a correct result |

Reports are saved to `.tmp/release-tests/<time and random ID>/`: `report.json` records the source commit, environment, commands, step results and case mapping; `summary.md` is the summary and the manual checklist; each step has a log.

Results are `passed`, `passed_with_skips`, `failed`, `interrupted` or `incomplete`. Exit code 0 means the selected steps passed, 1 failed or incomplete, 130 interrupted; with `--strict`, incomplete evidence returns 2. Release acceptance currently always shows INCOMPLETE, because real models, final installers and the hands-on experience are not verified automatically and must be recorded separately.

Before a release, also check by hand:

| Area         | Check                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Final DMG    | Verify the SHA-256 and install on another Mac without a dev environment: first launch, model connection, failure recovery, backup and upgrade |
| Native       | Window access per system permission; record real runs and skips separately                                                                    |
| Real model   | Representative tasks on your own service and budget                                                                                           |
| Distribution | Version, tag, artifacts, supported platforms, signing state, known limits and licenses                                                        |

Record the system, chip, version and installer checksums.

### Maintaining the case list

[catalog.json](../../test/release/catalog.json) holds the stage rules, the mapping from cases to test files, and the manual checks. The release runner reads case IDs from the tables in the appendix of the [Chinese testing guide](../testing.md#附录用例清单): top-level IDs like `BASE-01` and sub-items like `GUI-01/permissions`; every sub-item needs its top-level ID.

- A new Node test file that matches no rule goes to the basics stage, and a browser test to the App stage. Add rules for new areas.
- For a new feature, first add the user actions and pass criteria to the case list, then the tests and the mapping.
- A passing mapped test only counts as `partial_mapping`; a case without tests is `planned`. Full coverage means reviewing the assertions by hand.

The case list itself is maintained in Chinese.
