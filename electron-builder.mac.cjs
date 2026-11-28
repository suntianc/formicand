const base = require("./electron-builder.base.cjs");
const signingConfigured = Boolean(process.env.CSC_NAME?.trim());
module.exports = {
  ...base,
  files: [...base.files, "dist/desktop/motion.node"],
  forceCodeSigning: signingConfigured,
  mac: {
    icon: "build/formicand.icns",
    minimumSystemVersion: "14.0",
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.productivity",
    entitlements: "desktop/entitlements.mac.plist",
    entitlementsInherit: "desktop/entitlements.mac.plist",
    extendInfo: {
      // Electron ships a microphone description by default; remove it from the packaged App.
      NSMicrophoneUsageDescription: null,
      NSSpeechRecognitionUsageDescription: null
    },
    ...(signingConfigured ? {} : { identity: null })
  },
  dmg: {
    title: "Formicand 内测版",
    contents: [
      { x: 150, y: 180 },
      { x: 430, y: 180, type: "link", path: "/Applications" }
    ]
  },
  artifactName: "Formicand-${version}-mac-${arch}.${ext}"
};
