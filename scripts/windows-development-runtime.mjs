import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

export async function windowsDevelopmentExecutable(root, electron) {
  const require = createRequire(join(root, "package.json"));
  const { version } = require("./package.json");
  const icon = join(root, "web/assets/brand/formicand-icon.png");
  const binary = await stat(electron);
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        electron,
        binary.size,
        binary.mtimeMs,
        version,
        require("electron/package.json").version
      ])
    )
    .update(await readFile(icon))
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex")
    .slice(0, 24);
  const cache = join(root, ".tmp/desktop-runtime");
  const destination = join(cache, `windows-${hash}`);
  const executable = join(destination, "Formicand.exe");
  try {
    await access(executable);
    return executable;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const { convertIcon } = require("app-builder-lib/out/util/iconConverter");
  const { editWindowsResources } = require("app-builder-lib/out/util/resEdit");
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, ".prepare-windows-"));
  try {
    await cp(dirname(electron), staging, { recursive: true });
    const file = join(staging, "Formicand.exe");
    await rename(join(staging, basename(electron)), file);
    const { icons } = await convertIcon({
      sources: [icon],
      fallbackSources: [],
      roots: [root],
      format: "ico",
      outDir: staging
    });
    if (!icons.length) throw new Error(`Cannot build Windows application icon from ${icon}`);
    await editWindowsResources({
      file,
      iconPath: icons[0].file,
      versionStrings: {
        FileDescription: "Formicand",
        ProductName: "Formicand",
        OriginalFilename: "Formicand.exe",
        InternalName: "Formicand"
      },
      fileVersion: version,
      productVersion: version
    });
    try {
      await rename(staging, destination);
    } catch (error) {
      // Concurrent launches may publish the same completed runtime first.
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      await access(executable);
    }
    return executable;
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}
