const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** Source checkouts follow their branch's Git upstream; packaged builds have no in-app updater. */
function createDesktopUpdates(options) {
  const { root, toolchain, commandRunner, beforeApply, onStatus } = options;
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw new Error("Desktop updates require an absolute application root");
  let disposed = false;
  let active = false;
  let checked;
  let sourceModule;
  let pending;
  let state = {
    mode: "source",
    currentVersion: options.currentVersion,
    phase: "idle",
    busy: false,
    available: false,
    installMethod: "source",
    needsRelaunch: false,
    updated: false,
    rebuildRequired: false,
    progress: null
  };

  const status = () => ({ ...state, progress: state.progress ? { ...state.progress } : null });
  function publish(patch) {
    state = { ...state, ...patch };
    if (!disposed && typeof onStatus === "function") {
      try {
        const observed = onStatus(status());
        // eslint-disable-next-line no-restricted-syntax -- the status listener is a fire-and-forget notification, so its rejection must not surface as an unhandled rejection of the update run
        observed?.catch?.(() => {});
        // eslint-disable-next-line no-restricted-syntax -- onStatus forwards to webContents.send, which throws once the trusted window is gone, and a closing window must not abort the running update
      } catch {
        // A closing renderer cannot interrupt installation or source promotion.
      }
    }
  }
  function progress(value) {
    if (disposed) return;
    const entry = typeof value === "string" ? { message: value } : value;
    if (!entry || typeof entry !== "object") return;
    const current = {};
    for (const key of ["phase", "message"])
      if (typeof entry[key] === "string") current[key] = entry[key].slice(0, 1000);
    for (const key of ["downloaded", "total"])
      if (Number.isFinite(entry[key]) && entry[key] >= 0) current[key] = entry[key];
    if (current.total > 0 && Number.isFinite(current.downloaded))
      current.percent = Math.min(100, (current.downloaded / current.total) * 100);
    publish({ progress: current, ...(current.message ? { message: current.message } : {}) });
  }
  async function sourceUpdater() {
    const configured = options.sourceUpdater;
    return typeof configured === "function"
      ? configured()
      : configured || import(pathToFileURL(path.join(root, "scripts/update-source.mjs")).href);
  }
  async function exclusive(operation) {
    if (disposed) throw new Error("Desktop updater has been disposed");
    if (active) throw new Error("An update operation is already running");
    active = true;
    publish({ busy: true, error: undefined });
    pending = Promise.resolve().then(() => {
      if (disposed) throw new Error("Desktop updater has been disposed");
      return operation();
    });
    try {
      await pending;
    } catch (error) {
      publish({
        phase: "error",
        error: error?.message || "Desktop update failed",
        message: error?.message || "Desktop update failed",
        needsRelaunch: false
      });
      throw error;
    } finally {
      active = false;
      pending = undefined;
      publish({ busy: false });
    }
    return status();
  }
  function applyCheck(result) {
    checked = result;
    const fields = {};
    for (const key of ["currentVersion", "version", "currentCommit", "remoteCommit", "branch"])
      fields[key] = typeof result[key] === "string" ? result[key] : undefined;
    publish({
      ...fields,
      phase: result.available === true ? "available" : "up-to-date",
      available: result.available === true,
      rebuildRequired: result.rebuildRequired === true,
      progress: null,
      error: undefined,
      message: typeof result.message === "string" ? result.message : undefined,
      needsRelaunch: false,
      updated: false
    });
  }
  async function performCheck() {
    publish({
      phase: "checking",
      available: false,
      rebuildRequired: false,
      version: undefined,
      remoteCommit: undefined,
      needsRelaunch: false,
      updated: false,
      progress: null
    });
    sourceModule ||= await sourceUpdater();
    applyCheck(
      await sourceModule.checkSourceUpdate({
        root,
        target: "desktop",
        onProgress: progress,
        toolchain,
        commandRunner
      })
    );
  }
  async function prepare() {
    if (typeof beforeApply !== "function")
      throw new Error("The desktop host must prepare documents, tasks and the backend before installation");
    await beforeApply(status());
  }
  return {
    status,
    check(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        return Promise.reject(new Error("Invalid update check options"));
      if (Object.keys(input).length)
        return Promise.reject(new Error("Update checks do not accept renderer configuration"));
      return exclusive(async () => {
        checked = undefined;
        await performCheck();
      });
    },
    apply() {
      return exclusive(async () => {
        if (state.updated) {
          await prepare();
          publish({ phase: "ready", needsRelaunch: true, available: false, progress: null });
          return;
        }
        if (!checked) await performCheck();
        if (disposed) throw new Error("Desktop updater has been disposed");
        if (checked.available !== true) return;
        await prepare();
        publish({ phase: "updating", progress: null });
        const result = await sourceModule.updateSource({
          root,
          target: "desktop",
          onProgress: progress,
          toolchain,
          commandRunner
        });
        applyCheck(result);
        publish({
          phase: result.updated === true ? "ready" : "up-to-date",
          available: false,
          updated: result.updated === true,
          rebuildRequired: false,
          needsRelaunch: result.updated === true,
          progress: null
        });
      });
    },
    async dispose() {
      disposed = true;
      // eslint-disable-next-line no-restricted-syntax -- the in-flight operation already published its own error phase, and dispose only has to wait for it to settle
      await pending?.catch(() => {});
    }
  };
}

module.exports = { createDesktopUpdates };
