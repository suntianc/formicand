import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
const { windowBackground, followNativeTheme } = createRequire(import.meta.url)("../desktop/system-theme.cjs");

test("Windows caption symbols follow appearance while the acrylic background stays clear", () => {
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true });
  const overlays = [];
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setTitleBarOverlay: (overlay) => overlays.push(overlay)
  });
  followNativeTheme(window, nativeTheme, { transparent: true, windowsOverlay: true });
  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit("updated");
  assert.deepEqual(overlays, [
    { height: 44, color: "#00000000", symbolColor: "#ffffff" },
    { height: 44, color: "#00000000", symbolColor: "#171717" }
  ]);
  window.emit("closed");
  assert.equal(nativeTheme.listenerCount("updated"), 0);
});

test("painted window background follows initial native appearance and updates until closed", () => {
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setBackgroundColor: (color) => colors.push(color)
  });
  const colors = [];
  assert.equal(windowBackground(nativeTheme, "linux"), "#f2f2f4");
  followNativeTheme(window, nativeTheme);
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit("updated");
  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit("updated");
  assert.deepEqual(colors, ["#f2f2f4", "#0b0b0c", "#f2f2f4"]);
  window.emit("closed");
  assert.equal(nativeTheme.listenerCount("updated"), 0);
  nativeTheme.emit("updated");
  assert.equal(colors.length, 3);
});
