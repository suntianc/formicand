const path = require("node:path");
const { formicandHome } = require("../scripts/data-home.cjs");

/** Resolve identity before Chromium's profile and the single-instance lock are initialized. */
function desktopProfile({ isPackaged, appRoot, env = process.env }) {
  const development = !isPackaged || env.FORMICAND_DESKTOP_DEV === "1";
  const name = development ? "Formicand Dev" : "Formicand";
  return {
    development,
    name,
    encryptionName: "Formicand",
    appRoot:
      development && env.FORMICAND_DESKTOP_SOURCE_ROOT
        ? path.resolve(env.FORMICAND_DESKTOP_SOURCE_ROOT)
        : appRoot,
    userData: path.resolve(env.FORMICAND_DESKTOP_DATA || formicandHome(env))
  };
}

module.exports = { desktopProfile };
