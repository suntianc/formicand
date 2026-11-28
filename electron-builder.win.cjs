const base = require("./electron-builder.base.cjs");
module.exports = {
  ...base,
  files: [...base.files, "!dist/src/gui/formicand-computer-use{,.*}"],
  win: { icon: "build/formicand.ico", target: [{ target: "nsis", arch: ["x64"] }] },
  nsis: { oneClick: true, perMachine: false },
  artifactName: "Formicand-${version}-win-${arch}.${ext}"
};
