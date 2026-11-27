import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { windowPolicy, windowOptions } = require("../desktop/window-policy.cjs");
const { DARK_BACKGROUND, LIGHT_BACKGROUND, followNativeTheme } = require("../desktop/system-theme.cjs");
const { PRODUCT_NAME } = require("../desktop/product-name.cjs");

test("macOS uses inset traffic lights over the native material", () => {
  assert.equal(PRODUCT_NAME, "Formicand");
  const policy = windowPolicy("darwin");
  assert.deepEqual(policy, { titleBar: "inset", material: "under-window", hideMenuBar: false });
  assert.deepEqual(windowOptions(policy, { shouldUseDarkColors: false }), {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 16 },
    vibrancy: "under-window",
    transparent: true,
    visualEffectState: "active",
    backgroundColor: "#00000000"
  });
});

test("Windows keeps the caption overlay and hidden menu with or without acrylic", () => {
  for (const [release, material] of [
    ["10.0.22621", "acrylic"],
    ["10.0.22000", "none"],
    ["10.0.19045", "none"]
  ]) {
    const policy = windowPolicy("win32", release);
    assert.deepEqual(policy, { titleBar: "overlay", material, closeToTray: true, hideMenuBar: true });
    const options = windowOptions(policy, { shouldUseDarkColors: true });
    assert.equal(options.titleBarStyle, "hidden");
    assert.equal(options.titleBarOverlay.symbolColor, "#ffffff");
    assert.equal(options.backgroundColor, material === "none" ? DARK_BACKGROUND : "#00000000");
    assert.equal(options.backgroundMaterial, material === "none" ? undefined : "acrylic");
  }
});

test("Linux keeps native chrome and follows the theme on its painted background", () => {
  const linux = windowPolicy("linux");
  assert.deepEqual(linux, { titleBar: "native", material: "none", hideMenuBar: false });
  assert.deepEqual(windowOptions(linux, { shouldUseDarkColors: false }), {
    backgroundColor: LIGHT_BACKGROUND
  });
  const listeners = new Map();
  const colors = [];
  const nativeTheme = {
    shouldUseDarkColors: false,
    on: (event, listener) => listeners.set(event, listener),
    removeListener: (event) => listeners.delete(event)
  };
  const window = {
    isDestroyed: () => false,
    setBackgroundColor: (value) => colors.push(value),
    once: () => {}
  };
  followNativeTheme(window, nativeTheme, windowPolicy("darwin"));
  assert.equal(listeners.size, 0, "a native material is not repainted");
  assert.deepEqual(colors, []);

  followNativeTheme(window, nativeTheme, linux);
  assert.deepEqual(colors, [LIGHT_BACKGROUND]);
  nativeTheme.shouldUseDarkColors = true;
  listeners.get("updated")();
  assert.deepEqual(colors, [LIGHT_BACKGROUND, DARK_BACKGROUND]);
});
