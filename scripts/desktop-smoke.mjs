// The extended Mac acceptance suite additionally exercises the Dock, signing and Computer Use.
if (process.platform === "darwin" && !process.argv.includes("--basic")) {
  await import("./desktop-smoke-mac.mjs");
} else {
  if (process.argv.slice(2).some((arg) => arg !== "--basic"))
    throw new Error("Use --basic for the native directory-package smoke");
  const { runPackagedSmoke } = await import("./packaged-smoke.mjs");
  await runPackagedSmoke();
}
