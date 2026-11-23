import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createOpenWith } from "../web/assets/controllers/open-with.js";

const require = createRequire(import.meta.url);
const { createFileOpener, FINDER_APP, FINDER_ID } = require("../desktop/file-open.cjs");

test("desktop file opener exposes native Finder icon on macOS, empty on Windows, reveals in Finder, and rejects unlisted apps", async () => {
  const revealed = [];
  const opened = [];
  const launched = [];
  const thumbPaths = [];
  let queries = 0;

  const opener = createFileOpener({
    platform: "darwin",
    shell: {
      showItemInFolder: (target) => revealed.push(target),
      openPath: async (target) => {
        opened.push(target);
        return "";
      }
    },
    nativeImage: {
      createThumbnailFromPath: async (target) => {
        thumbPaths.push(target);
        return {
          resize: () => ({ toDataURL: () => `data:image/png;base64,${target}` })
        };
      }
    },
    execute: async (cmd, args) => {
      if (cmd === "osascript") {
        queries += 1;
        return {
          stdout: JSON.stringify({
            preferred: { path: "/Applications/TextEdit.app", name: "TextEdit", id: "com.apple.TextEdit" },
            capable: [],
            editors: [{ path: "/Applications/Cursor.app", name: "Cursor", id: "com.todesktop.230313" }],
            terminals: [{ path: "/System/Applications/Utilities/Terminal.app", name: "Terminal", id: "term" }]
          })
        };
      }
      launched.push([cmd, args]);
      return { stdout: "" };
    }
  });

  // Native Finder icon is fetched once and cached.
  const firstIcon = await opener.defaultIcon();
  const secondIcon = await opener.defaultIcon();
  assert.equal(firstIcon, `data:image/png;base64,${FINDER_APP}`);
  assert.equal(secondIcon, firstIcon);
  assert.deepEqual(thumbPaths, [FINDER_APP]);

  // Windows/Linux returns empty so the UI shows the folder icon.
  const winOpener = createFileOpener({
    platform: "win32",
    shell: { showItemInFolder: (target) => revealed.push(target), openPath: async () => "" },
    nativeImage: {
      createThumbnailFromPath: async () => {
        throw new Error("should not query macOS Finder on win32");
      }
    }
  });
  assert.equal(await winOpener.defaultIcon(), "");

  // Finder/Folder reveal skips LaunchServices queries completely.
  await opener.open("/tmp/project/README.md", FINDER_ID);
  assert.deepEqual(revealed, ["/tmp/project/README.md"]);
  assert.equal(queries, 0);

  // Empty appId uses the system default app.
  await opener.open("/tmp/project/README.md");
  assert.deepEqual(opened, ["/tmp/project/README.md"]);

  // Listed editor opens the file; terminal opens its parent directory.
  await opener.open("/tmp/project/README.md", "/Applications/Cursor.app");
  await opener.open("/tmp/project/README.md", "/System/Applications/Utilities/Terminal.app");
  assert.deepEqual(launched, [
    ["open", ["-a", "/Applications/Cursor.app", "/tmp/project/README.md"]],
    ["open", ["-a", "/System/Applications/Utilities/Terminal.app", "/tmp/project"]]
  ]);

  // Unlisted apps are refused.
  await assert.rejects(
    opener.open("/tmp/project/README.md", "/System/Applications/Calculator.app"),
    /不能打开/
  );
});

test("open-with uses cached native Finder icon on macOS, folder icon on Windows, and avoids repaints across file switches", async (t) => {
  const dom = parseHTML("<!doctype html><html><body><div id='host'></div></body></html>");
  const prevDoc = globalThis.document;
  const prevInnerWidth = globalThis.innerWidth;
  const prevInnerHeight = globalThis.innerHeight;
  globalThis.document = dom.document;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.innerWidth = prevInnerWidth;
    globalThis.innerHeight = prevInnerHeight;
  });

  let resolveApps;
  let repaints = 0;
  const calls = [];
  const bridge = {
    defaultIcon: async () => ({ icon: "data:image/png;base64,finder", platform: "darwin" }),
    apps: () =>
      new Promise((resolve) => {
        resolveApps = resolve;
      }),
    open: async (taskId, target, appId) => {
      calls.push([taskId, target.path, appId]);
    }
  };

  const openWith = createOpenWith({
    bridge,
    showToast: () => {},
    onChange: () => {
      repaints += 1;
    }
  });
  // Startup defaultIcon resolves once before any preview opens.
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(repaints, 0);

  const targetA = { source: "project", path: "src/a.ts" };
  const targetB = { source: "project", path: "README.md" };

  // Signature and native Finder icon markup stay stable before and after background apps resolve.
  const sigBefore = openWith.signature("t1", targetA);
  const htmlA = openWith.markup("t1", targetA);
  assert.match(htmlA, /src="data:image\/png;base64,finder"/);
  assert.match(htmlA, /在访达中显示/);
  assert.doesNotMatch(htmlA, /data-open-more[^>]*disabled/);

  const host = dom.document.getElementById("host");
  host.innerHTML = htmlA;
  openWith.bind(host, "t1", targetA);

  host.querySelector("[data-open-main]").click();
  assert.deepEqual(calls, [["t1", "src/a.ts", "finder"]]);

  // Clicking the arrow while apps are still in-flight awaits and opens once ready.
  const more = host.querySelector("[data-open-more]");
  more.getBoundingClientRect = () => ({ right: 300, bottom: 40 });
  more.click();
  resolveApps({
    apps: [
      {
        id: "/Applications/TextEdit.app",
        name: "TextEdit",
        kind: "default",
        icon: "data:image/png;base64,a"
      },
      { id: "/Applications/Cursor.app", name: "Cursor", kind: "editor", icon: "data:image/png;base64,b" }
    ]
  });
  await new Promise((done) => setTimeout(done, 0));

  assert.equal(repaints, 0, "background app loading must not repaint the drawer");
  assert.equal(openWith.signature("t1", targetA), sigBefore);
  assert.equal(openWith.signature("t1", targetB), sigBefore);

  const menu = dom.document.querySelector(".open-with-menu");
  assert.ok(menu && !menu.hidden);
  const cursorItem = menu.querySelector('[data-open-app="/Applications/Cursor.app"]');
  assert.ok(cursorItem);
  cursorItem.click();
  assert.deepEqual(calls, [
    ["t1", "src/a.ts", "finder"],
    ["t1", "src/a.ts", "/Applications/Cursor.app"]
  ]);
  // Main button stays fixed to Finder after picking another app.
  assert.equal(openWith.markup("t1", targetB), htmlA);

  // Windows bridge falls back to the folder icon and folder tooltip.
  const winOpenWith = createOpenWith({
    bridge: {
      defaultIcon: async () => ({ icon: "", platform: "win32" }),
      apps: async () => ({ apps: [] }),
      open: async () => {}
    },
    showToast: () => {},
    onChange: () => {}
  });
  await new Promise((done) => setTimeout(done, 0));
  const winHtml = winOpenWith.markup("t1", targetA);
  assert.match(winHtml, /open-with-folder/);
  assert.match(winHtml, /#i-folder/);
  assert.match(winHtml, /在文件夹中显示/);
});
