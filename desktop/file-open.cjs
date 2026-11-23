"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);

/**
 * Editors offered for any file even when the system does not register them
 * for its type: macOS maps many source extensions (`.ts` is a video stream to
 * it) to other kinds of app.
 */
const EDITORS = [
  "com.microsoft.VSCode",
  "com.todesktop.230313mzl4w4u92",
  "com.exafunction.windsurf",
  "dev.zed.Zed",
  "com.sublimetext.4",
  "com.apple.dt.Xcode",
  "com.jetbrains.intellij",
  "com.jetbrains.intellij.ce",
  "com.jetbrains.pycharm",
  "com.jetbrains.pycharm.ce",
  "com.jetbrains.WebStorm",
  "com.jetbrains.goland",
  "com.google.android.studio",
  "com.panic.Nova",
  "com.barebones.bbedit",
  "com.macromates.TextMate",
  "com.apple.TextEdit"
];
/** Terminals open the file's folder; a terminal cannot open one file. */
const TERMINALS = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "com.mitchellh.ghostty",
  "dev.warp.Warp-Stable"
];

/** Asks LaunchServices which applications can open the file, and which installed ones are named. */
const QUERY = `function run(argv) {
  ObjC.import("AppKit");
  const workspace = $.NSWorkspace.sharedWorkspace;
  const files = $.NSFileManager.defaultManager;
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const describe = (entry) => {
    if (!entry || entry.isNil()) return null;
    const location = ObjC.unwrap(entry.path);
    const bundle = $.NSBundle.bundleWithURL(entry);
    return {
      path: location,
      name: ObjC.unwrap(files.displayNameAtPath(location)).replace(/\\.app$/, ""),
      id: bundle.isNil() ? "" : ObjC.unwrap(bundle.bundleIdentifier) || ""
    };
  };
  const capable = [];
  const list = workspace.URLsForApplicationsToOpenURL(url);
  for (let index = 0; index < list.count; index++) capable.push(describe(list.objectAtIndex(index)));
  const named = (ids) =>
    JSON.parse(ids).map((id) => describe(workspace.URLForApplicationWithBundleIdentifier(id))).filter(Boolean);
  return JSON.stringify({
    preferred: describe(workspace.URLForApplicationToOpenURL(url)),
    capable,
    editors: named(argv[1]),
    terminals: named(argv[2])
  });
}`;

/** Sentinel appId for revealing the file directly in macOS Finder or system file manager. */
const FINDER_ID = "finder";
const FINDER_APP = "/System/Library/CoreServices/Finder.app";

/**
 * The desktop's "Open with" for one previewed file. The renderer never names
 * a path or a program: the file comes from the backend and the application
 * must be one this module listed for that file (or the built-in Finder reveal).
 */
function createFileOpener({ shell, nativeImage, platform = process.platform, execute = run }) {
  const iconCache = new Map();

  async function icon(appPath) {
    if (iconCache.has(appPath)) return iconCache.get(appPath);
    let value = "";
    try {
      // `app.getFileIcon` answers by extension on macOS, so every app came back as the generic one.
      const image = await nativeImage.createThumbnailFromPath(appPath, { width: 64, height: 64 });
      value = image.resize({ width: 36, height: 36, quality: "best" }).toDataURL();
      // eslint-disable-next-line no-restricted-syntax -- an app whose icon cannot be read is still listed, by name only
    } catch {
      value = "";
    }
    iconCache.set(appPath, value);
    return value;
  }

  /** Default first, then editors, then other capable apps, then terminals; each app once. */
  async function list(absolutePath) {
    if (platform !== "darwin") return { apps: [] };
    const { stdout } = await execute(
      "osascript",
      ["-l", "JavaScript", "-e", QUERY, absolutePath, JSON.stringify(EDITORS), JSON.stringify(TERMINALS)],
      { timeout: 10_000, maxBuffer: 1024 * 1024 }
    );
    const found = JSON.parse(stdout);
    const seen = new Set();
    const apps = [];
    const add = (entry, kind) => {
      if (!entry?.path || seen.has(entry.path)) return;
      seen.add(entry.path);
      apps.push({ id: entry.path, name: entry.name, kind });
    };
    add(found.preferred, "default");
    for (const entry of found.editors) add(entry, "editor");
    for (const entry of found.capable) add(entry, "app");
    for (const entry of found.terminals) add(entry, "terminal");
    return { apps: await Promise.all(apps.map(async (entry) => ({ ...entry, icon: await icon(entry.id) }))) };
  }

  /** Reveals in Finder for `finder`, opens with the default app when empty, else that listed app. */
  async function open(absolutePath, appId) {
    if (appId === FINDER_ID) {
      shell.showItemInFolder(absolutePath);
      return;
    }
    if (!appId) {
      const failure = await shell.openPath(absolutePath);
      if (failure) throw new Error(failure);
      return;
    }
    const chosen = (await list(absolutePath)).apps.find((entry) => entry.id === appId);
    if (!chosen) throw new Error("这个应用不能打开该文件");
    const target = chosen.kind === "terminal" ? path.dirname(absolutePath) : absolutePath;
    await execute("open", ["-a", chosen.id, target], { timeout: 15_000 });
  }

  /** Native Finder icon on macOS (cached once), empty on Windows/Linux where the UI shows a folder icon. */
  async function defaultIcon() {
    if (platform !== "darwin") return "";
    return icon(FINDER_APP);
  }

  return { list, open, defaultIcon };
}

module.exports = { createFileOpener, EDITORS, TERMINALS, FINDER_ID, FINDER_APP };
