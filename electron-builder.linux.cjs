const base = require("./electron-builder.base.cjs");
module.exports = {
  ...base,
  files: [...base.files, "!dist/src/gui/formicand-computer-use{,.*}"],
  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }],
    executableName: "formicand",
    icon: "web/assets/brand/formicand-icon.png",
    category: "Development"
  },
  artifactName: "Formicand-${version}-linux-${arch}.${ext}"
};
