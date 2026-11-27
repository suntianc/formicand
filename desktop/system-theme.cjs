// Appearance owns Electron's selected theme; keep the window's first paint in sync.
const DARK_BACKGROUND = "#0b0b0c";
const LIGHT_BACKGROUND = "#f2f2f4";

function windowBackground(nativeTheme, platform = process.platform) {
  // macOS renders the window material itself, so the window canvas stays clear.
  if (platform === "darwin") return "#00000000";
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}
function titleBarOverlay(nativeTheme) {
  return {
    height: 44,
    color: "#00000000",
    symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#171717"
  };
}
function followNativeTheme(window, nativeTheme, { transparent = false, windowsOverlay = false } = {}) {
  if (transparent && !windowsOverlay) return;
  const update = () => {
    if (window.isDestroyed()) return;
    if (windowsOverlay) window.setTitleBarOverlay(titleBarOverlay(nativeTheme));
    if (!transparent)
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND);
  };
  nativeTheme.on("updated", update);
  window.once("closed", () => nativeTheme.removeListener("updated", update));
  update();
}
module.exports = { DARK_BACKGROUND, LIGHT_BACKGROUND, windowBackground, titleBarOverlay, followNativeTheme };
