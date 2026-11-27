// Appearance owns Electron's selected theme; keep the window's first paint in sync.
const DARK_BACKGROUND = "#0b0b0c";
const LIGHT_BACKGROUND = "#f2f2f4";

function windowBackground(nativeTheme, policy) {
  if (policy.material !== "none") return "#00000000";
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}
function titleBarOverlay(nativeTheme) {
  return {
    height: 44,
    color: "#00000000",
    symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#171717"
  };
}
function followNativeTheme(window, nativeTheme, policy) {
  if (policy.material !== "none" && policy.titleBar !== "overlay") return;
  const update = () => {
    if (window.isDestroyed()) return;
    if (policy.titleBar === "overlay") window.setTitleBarOverlay(titleBarOverlay(nativeTheme));
    if (policy.material === "none") window.setBackgroundColor(windowBackground(nativeTheme, policy));
  };
  nativeTheme.on("updated", update);
  window.once("closed", () => nativeTheme.removeListener("updated", update));
  update();
}
module.exports = { DARK_BACKGROUND, LIGHT_BACKGROUND, windowBackground, titleBarOverlay, followNativeTheme };
