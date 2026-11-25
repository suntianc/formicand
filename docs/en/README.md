# Formicand Docs

[简体中文](../README.md) | English

- [Product guide](../../README.md)
- [Development and architecture](../development.md)
- [Testing](../testing.md)

## Built-in capabilities

`browser`, `computer` and `cua` are tool groups that start unloaded; Main opens them with `enable_tools` and Subagents do not inherit them. The `browser` group drives Formicand's own Chromium when the model takes images and Chromium is installed; `computer` operates this machine's application windows when the user turned window access on in the App; `cua` chains either group's steps in JavaScript. Every action builds on the latest observation, an observation or control ID expires after use, and a `not_sent` result may be corrected and retried while `sent` and `unknown` are never repeated before the target's real state is observed. A `condition_met` wait only proves the interface condition, not the result the user wanted.

### Browser

Formicand opens a throwaway Chromium per task, fully separate from the user's browser: no bookmarks, cookies or logins are read. The tools are `browser_open`, `browser_observe`, `browser_act`, `browser_wait` and `browser_close`.

- **Find elements** semantically: role plus name, label, text or `testId`, matching exactly one element. Several matches raise `ambiguous_target`; narrow with a container `scope` or `nth`. CSS selectors and running arbitrary code in the page are not supported.
- **Coordinate actions** (click, drag, scroll) must carry the `observationId` of the current screenshot.
- **Observation cost** is `both` (default), `aria`, `screenshot` or `none`. Known consecutive steps can use `none` and observe at the next checkpoint.
- **Waits** are explicit conditions: `browser_wait` returns `condition_met` or `timeout`, so a step never rests on a guessed sleep.
- **Downloads** need `expectDownload: true` on the click. Files land in the task's `visual/downloads/` with path, size and SHA-256, up to 20 MiB each.
- **Logins** last only while that throwaway browser lives. Closing, cancelling or restarting means logging in again.
- At most 8 pages per task in a 1280×800 window.

Without Chromium installed the tools print the install command:

```sh
npx --yes --package=playwright-core@1.63.0 playwright-core install chromium
```

`FORMICAND_BROWSER_EXECUTABLE` points at another browser path.

### Native windows

Mac App only, macOS 14 or newer. Under Settings → Window access click three buttons in turn: **Enable Screen Recording**, **Enable Accessibility**, then **Enable window access**, which is offered once the first two are on and needs local confirmation. Once on, every conversation on that backend can observe and operate every visible application window; clicking again turns it off.

- While operating, the interface shows the task and window being controlled plus a "Pause · take over" button. Pressing it, or `Ctrl + Option + Esc`, immediately cancels running and queued actions. After a pause the user must click "Resume window access"; an Agent cannot resume it.
- One task controls the desktop at a time; others queue.
- Window access does not come back by itself after a backend restart; the user confirms again.
- A locked screen, secure keyboard entry or revoked system permission makes actions fail.

The tools are `computer_status`, `computer_discover`, `computer_select`, `computer_observe`, `computer_act`, `computer_wait` and `computer_release`; `computer_wait` waits for text or a control to appear or disappear, up to 30 seconds. Actions are `activate`, `click` (left or right), `type`, `key`, `press` and `set_value`.

- Prefer the control's `elementId` from an observation; coordinate clicks use pixels from the latest screenshot.
- Observations expire after 30 seconds. A moved, resized or refocused window, or a changed control, rejects the old observation.
- Whole-screen work, the Dock, the menu bar, drag and wheel are not supported yet.
- Input already sent cannot be taken back; cancelling only stops what has not been sent.

This grant covers window operations only. It is not a system sandbox for the product: Agent commands still run under their own permissions.

### CUA scripts

`cua_script({ code, timeoutMs? })` runs asynchronous JavaScript in an isolated QuickJS and turns a settled sequence of steps into one call. It can only reach the browser and window tools already open, and their checks still apply; a script cannot open a tool group or turn window access on or resume it. `cua_reset({})` clears its variables and objects.

```javascript
// First segment: open the page and keep the object in state for later segments.
state.tab = await cua.browser.open("https://example.com");
```

```javascript
// After looking at the page and confirming the button name.
await state.tab.getByLabel("File name").fill("report");
await state.tab.getByRole("button", { name: "Export CSV" }).click({ expectDownload: true });
```

| Object         | Main methods                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cua.browser`  | `open(url)`, `use(pageId)`                                                                                       |
| Page Tab       | `observe()`, `goto(url)`, `act(action)`, `wait(condition)`, `close()`, `clickAt`, `drag`, `scroll`, `frame(id)`  |
| Locator        | `getByRole`, `getByLabel`, `getByText`, `getByTestId`, then `click`, `fill`, `press`, `select`, `waitFor`, `nth` |
| `cua.computer` | `status()`, `discover()`, `select({pid, windowId, mode})`, `use(sessionId)`                                      |
| Window         | `observe()`, `act(action)`, `wait(condition)`, `release()`                                                       |

- Only what goes into `state` survives to the next segment; local variables do not. State lives in memory and never crosses processes.
- Await every action. A wait timeout throws by default, so a script does not type on blindly.
- Return text with `return` or `console.log`, and images with `cua.emitImage(imageRef)`.
- A script has no files, shell, network or module loading.
- A segment runs for 15 seconds by default and 60 at most, with 64 KiB of code, 64 MiB of memory, 64 tool calls and the last 4 images; timeouts, excess memory, uncaught exceptions and cancellation all reset the script environment.

### Resuming after an interruption

After a pause, a backend restart or a killed process, Main carries on in the same session with the actions and results already recorded. Before continuing, check whether the last state-changing action's result was verified. When the session shows something sent but unverified, look at the actual state read-only first (a status page, a saved file, a receipt) and then decide. A missing screenshot does not mean failure; when the outcome cannot be determined, say so instead of guessing.

## Records

Process records are Chinese only: [handoffs](../development-handoffs.md), [pitfalls](../pitfalls/README.md), [decision history](../adr-history.md), [retrospectives](../retrospectives.md).

[Product glossary](../../GLOSSARY.md) (Chinese) · [Contributing](../../CONTRIBUTING.en.md) · [中文](../../CONTRIBUTING.md) · [Third-party notices](../../THIRD_PARTY_NOTICES.md)
