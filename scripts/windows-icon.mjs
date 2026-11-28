import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import png2icons from "png2icons";

/** Both the NSIS package and the branded development executable use this ICO. */
export async function windowsIcon(source) {
  const data = png2icons.createICO(await readFile(source), png2icons.BICUBIC, 0, true, true);
  if (!data) throw new Error("Could not convert the Formicand brand PNG to a Windows icon");
  return data;
}

export async function buildWindowsIcon(root) {
  const file = resolve(root, "build/formicand.ico");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await windowsIcon(resolve(root, "web/assets/brand/formicand-icon.png")));
}
