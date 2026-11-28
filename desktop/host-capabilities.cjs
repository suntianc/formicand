/** The trusted window receives host facts; execution-node access is resolved by its backend. */
function desktopCapabilities({
  platform,
  arch,
  osVersion,
  version,
  policy,
  nativeMotion,
  notifications,
  tray,
  development
}) {
  const { titleBar, controlsSide, titlebarLayout, material } = policy;
  return {
    platform,
    arch,
    osVersion,
    version,
    titleBar,
    controlsSide,
    titlebarLayout,
    material,
    nativeMotion,
    notifications,
    tray,
    fileOpenWith: platform === "darwin" ? "full" : "default-only",
    credentialBackend: platform === "darwin" ? "keychain" : "safe-storage",
    updates: development ? "source" : "manual"
  };
}
module.exports = { desktopCapabilities };
