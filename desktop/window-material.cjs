const os = require("node:os");
const NATIVE_MATERIAL = "under-window";

function windowMaterial(platform = process.platform, release = os.release()) {
  if (platform === "win32" && Number(release.split(".")[2]) >= 22621) {
    return { material: "acrylic", options: { backgroundMaterial: "acrylic", backgroundColor: "#00000000" } };
  }
  if (platform !== "darwin") return { material: "none", options: {} };
  return {
    material: NATIVE_MATERIAL,
    options: {
      vibrancy: NATIVE_MATERIAL,
      visualEffectState: "active",
      transparent: true,
      backgroundColor: "#00000000"
    }
  };
}

module.exports = { NATIVE_MATERIAL, windowMaterial };
