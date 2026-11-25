import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, symlink, rm, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { releaseMetadata } from "./release-metadata.mjs";
import {
  macPackagingArguments,
  macPackagingEnvironment,
  verifyDeveloperIdApplication,
  verifyMacApplication
} from "./mac-signing.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Mac packaging currently requires an Apple Silicon Mac");
const exec = promisify(execFile);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const { version } = pkg;
const tag = process.env.RELEASE_TAG ?? `v${version}`;
releaseMetadata(version, lock.version, tag);
if (lock.packages?.[""]?.version !== version)
  throw new Error("package-lock.json root version differs from package.json");
const packaging = macPackagingEnvironment();
const signingConfigured = packaging.mode === "developer-id";
const appPath = resolve(".tmp/release/mac-arm64/Formicand.app");
const signingReport = resolve(`release/Formicand-${version}-mac-arm64.signing.json`);
await rm(signingReport, { force: true });
console.log(signingConfigured ? "Building the Developer ID app" : "Building the ad-hoc beta app");
const { stdout } = await exec(process.execPath, macPackagingArguments(process.cwd(), packaging.mode), {
  maxBuffer: 4 * 1024 * 1024,
  env: packaging.env
});
const signature = await verifyMacApplication({ appPath, version, mode: packaging.mode });
if (signingConfigured) await verifyDeveloperIdApplication(appPath);
await mkdir(resolve("release"), { recursive: true });
await writeFile(signingReport, `${JSON.stringify(signature, null, 2)}\n`);
console.log(
  stdout
    .split("\n")
    .filter((line) => !line.includes("duplicate dependency references"))
    .join("\n")
);
const staging = await mkdtemp(join(tmpdir(), "formicand-dmg-staging-"));
const output = resolve(`release/Formicand-${version}-mac-arm64.dmg`);
await mkdir(resolve("release"), { recursive: true });
try {
  // Preserve framework symlinks when relocating a native app bundle.
  await cp(appPath, join(staging, "Formicand.app"), {
    recursive: true,
    verbatimSymlinks: true
  });
  await symlink("/Applications", join(staging, "Applications"));
  console.log("Creating and verifying DMG with macOS hdiutil");
  await exec(
    "/usr/bin/hdiutil",
    [
      "create",
      "-volname",
      signingConfigured ? "Formicand" : "Formicand Beta",
      "-srcfolder",
      staging,
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      "-ov",
      output
    ],
    { maxBuffer: 1024 * 1024 }
  );
  await exec("/usr/bin/hdiutil", ["verify", output]);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(output)) digest.update(chunk);
  await writeFile(`${output}.sha256`, `${digest.digest("hex")}  ${output.split("/").at(-1)}\n`);
  console.log(`Mac package ready: ${output}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
