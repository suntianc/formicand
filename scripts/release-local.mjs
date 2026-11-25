import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execute = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

export async function runLocalRelease({
  tag = process.env.RELEASE_TAG,
  repository = process.env.GITHUB_REPOSITORY || "suntianc/coworkos",
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  commandRunner = execute
} = {}) {
  if (platform !== "darwin" || arch !== "arm64")
    throw new Error("Local release packaging requires an Apple Silicon Mac");
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
    throw new Error("Usage: npm run release:local -- v<version>");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  root = resolve(root);
  const releaseEnv = { ...process.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository };
  const run = async (command, args, extra = {}) => {
    const { env = {}, ...options } = extra;
    return commandRunner(command, args, {
      ...options,
      cwd: root,
      env: { ...releaseEnv, ...env }
    });
  };

  await run("node", ["scripts/release-metadata.mjs"]);
  await run("npm", ["run", "desktop:dist"]);
  await run("npm", ["run", "cli:pack"]);
  await run("node", ["scripts/release-artifacts.mjs"]);
  await run("node", ["scripts/release-draft.mjs", "upload"]);
  console.log(
    `Draft assets for ${tag} are uploaded. Review the draft files, then publish the GitHub Release.`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runLocalRelease({ tag: process.argv[2] || process.env.RELEASE_TAG });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
