import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Data } from "resedit";
import { desktopPackagingArgs } from "../scripts/package-desktop.mjs";
import { windowsIcon } from "../scripts/windows-icon.mjs";

const require = createRequire(import.meta.url);
const { APPLICATION_ID } = require("../desktop/product-name.cjs");

test("native desktop builds select their target architecture and artifact format", () => {
  for (const [platform, os, arch, format] of [
    ["darwin", "mac", "arm64", "dmg"],
    ["win32", "win", "x64", "nsis"],
    ["linux", "linux", "x64", "AppImage"]
  ]) {
    const config = require(`../electron-builder.${os}.cjs`);
    assert.equal(config.appId, APPLICATION_ID);
    assert.deepEqual(config[os].target, [{ target: format, arch: [arch] }]);
    assert.equal(config.files.includes("dist/desktop/motion.node"), os === "mac");
    assert.equal(config.files.includes("!dist/src/gui/formicand-computer-use{,.*}"), os !== "mac");
    const args = desktopPackagingArgs("pack", platform, arch);
    assert.ok(args.includes(`electron-builder.${os}.cjs`));
    assert.ok(args.includes("--dir"));
    assert.ok(!desktopPackagingArgs("dist", platform, arch).includes("--dir"));
    assert.throws(() => desktopPackagingArgs("dist", platform, arch === "arm64" ? "x64" : "arm64"));
  }
  assert.throws(() => desktopPackagingArgs("deploy", "win32", "x64"));
});

test("the Windows application icon contains shell, taskbar and high-DPI sizes", async () => {
  const file = await windowsIcon("web/assets/brand/formicand-icon.png");
  const sizes = Data.IconFile.from(file).icons.map(({ data }) => data.width);
  for (const size of [16, 32, 48, 256]) assert.ok(sizes.includes(size));
});
