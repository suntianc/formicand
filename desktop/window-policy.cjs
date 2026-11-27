const os = require("node:os");
const { titleBarOverlay, windowBackground } = require("./system-theme.cjs");

function windowPolicy(platform = process.platform, release = os.release()) {
  switch (platform) {
    case "darwin":
      return { titleBar: "inset", material: "under-window", hideMenuBar: false };
    case "win32":
      return {
        titleBar: "overlay",
        material: Number(release.split(".")[2]) >= 22621 ? "acrylic" : "none",
        hideMenuBar: true
      };
    default:
      return { titleBar: "native", material: "none", hideMenuBar: false };
  }
}

function windowOptions(policy, nativeTheme) {
  const options = { backgroundColor: windowBackground(nativeTheme, policy) };
  if (policy.titleBar === "inset") {
    options.titleBarStyle = "hiddenInset";
    options.trafficLightPosition = { x: 18, y: 16 };
  } else if (policy.titleBar === "overlay") {
    options.titleBarStyle = "hidden";
    options.titleBarOverlay = titleBarOverlay(nativeTheme);
  }
  if (policy.material === "under-window") {
    options.vibrancy = policy.material;
    options.visualEffectState = "active";
    options.transparent = true;
  } else if (policy.material === "acrylic") options.backgroundMaterial = policy.material;
  return options;
}

module.exports = { windowPolicy, windowOptions };
