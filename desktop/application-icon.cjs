const { existsSync } = require("node:fs");
const { join } = require("node:path");

function selectApplicationIcon(appRoot, platform = process.platform) {
  if (platform !== "darwin") {
    const icon = join(appRoot, "web/assets/brand/formicand-icon.png");
    if (existsSync(icon)) return icon;
  }
  return [
    join(appRoot, "dist/src/desktop/formicand-icon.png"),
    join(appRoot, "build/formicand-icon.png")
  ].find((candidate) => existsSync(candidate));
}

function refreshDockIcon(appRoot, dock) {
  const icon = selectApplicationIcon(appRoot, "darwin");
  // No override leaves Electron/macOS using the bundle's normal app icon.
  if (icon) dock?.setIcon(icon);
}

module.exports = { selectApplicationIcon, refreshDockIcon };
