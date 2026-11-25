# Formicand Docs

- [Product guide](../../README.md)
- [Development and architecture](../development.md)
- [Testing](../testing.md)

## CUA scripts

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

Opening a tool group, the browser and window tools themselves, and recovering after an interruption are described in the [product guide](../../README.md#built-in-capabilities).
