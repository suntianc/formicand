import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { windowsIcon } from "./windows-icon.mjs";

async function brandWindowsExecutable(file, icon, version) {
  // Modifying a staging copy invalidates the upstream Electron signature.
  const image = NtExecutable.from(await readFile(file), { ignoreCert: true });
  const resources = NtExecutableResource.from(image);
  const info = Resource.VersionInfo.fromEntries(resources.entries)[0] ?? Resource.VersionInfo.createEmpty();
  const language = info.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };
  info.setFileVersion(version);
  info.setProductVersion(version);
  info.setStringValues(language, {
    FileDescription: "Formicand",
    ProductName: "Formicand",
    OriginalFilename: "Formicand.exe",
    InternalName: "Formicand",
    FileVersion: version
  });
  info.outputToResourceEntries(resources.entries);
  const icons = Data.IconFile.from(await windowsIcon(icon)).icons.map((entry) => entry.data);
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, language.lang, icons);
  resources.outputResource(image);
  await writeFile(file, Buffer.from(image.generate()));
}

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
    .update(await readFile(new URL("./windows-icon.mjs", import.meta.url)))
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

  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, ".prepare-windows-"));
  try {
    await cp(dirname(electron), staging, { recursive: true });
    const file = join(staging, "Formicand.exe");
    await rename(join(staging, basename(electron)), file);
    await brandWindowsExecutable(file, icon, version);
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
