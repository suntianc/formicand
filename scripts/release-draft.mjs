import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { releaseRepository, validateRelease } from "./release-metadata.mjs";
import { releaseFiles, verifyReleaseArtifacts } from "./release-artifacts.mjs";

const execute = promisify(execFile);

export async function readReleaseDraft({ repository, tag, commandRunner = execute }) {
  repository = releaseRepository(repository);
  let response;
  try {
    response = await commandRunner("gh", [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "isDraft,isPrerelease,tagName,assets"
    ]);
  } catch (error) {
    if (error.code === 1 && /^release not found\s*$/i.test(String(error.stderr ?? "").trim()))
      return undefined;
    throw new Error("Unable to verify the remote release state; no release files were changed");
  }
  let release;
  try {
    release = JSON.parse(response.stdout);
  } catch {
    throw new Error("GitHub returned invalid release metadata; no release files were changed");
  }
  if (
    release.tagName !== tag ||
    typeof release.isDraft !== "boolean" ||
    typeof release.isPrerelease !== "boolean" ||
    !Array.isArray(release.assets) ||
    release.assets.some((asset) => typeof asset?.name !== "string")
  )
    throw new Error("GitHub returned incomplete release metadata; no release files were changed");
  if (!release.isDraft)
    throw new Error(
      "Release is already published. Use a new version tag; published assets are not replaced."
    );
  return release;
}

function checkExistingPlatformAssets(release, manifest) {
  const prefix = `Formicand-${manifest.version}-`;
  for (const { name } of release.assets) {
    if (
      name.startsWith(prefix) &&
      /^(win-x64\.exe|linux-x64\.AppImage)(?:\.sha256|\.build\.json)?$/.test(name.slice(prefix.length)) &&
      !manifest.files.includes(name)
    )
      throw new Error("This manifest would omit an existing desktop asset: " + name);
  }
}

/** Prepare only a draft. Maintainer-edited notes survive retries unless replacement is explicit. */
export async function uploadReleaseDraft({
  root = process.cwd(),
  tag = process.env.RELEASE_TAG,
  repository = process.env.GITHUB_REPOSITORY,
  replaceNotes = false,
  requireSigningReport = false,
  commandRunner = execute
} = {}) {
  const manifest = await verifyReleaseArtifacts({ root, tag, repository, requireSigningReport });
  repository = manifest.source.repository;
  let draft = await readReleaseDraft({ repository, tag, commandRunner });
  if (draft) checkExistingPlatformAssets(draft, manifest);
  const notes = resolve(root, "release", releaseFiles(manifest.version).notes);
  if (!draft) {
    await commandRunner("gh", [
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--prerelease=" + manifest.prerelease,
      "--latest=false",
      "--title",
      "Formicand " + tag,
      "--notes-file",
      notes
    ]);
  } else if (replaceNotes || draft.isPrerelease !== manifest.prerelease) {
    const args = [
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--prerelease=" + manifest.prerelease,
      "--latest=false"
    ];
    if (replaceNotes) args.push("--notes-file", notes);
    await commandRunner("gh", args);
  }
  // A human may have published the draft while packaging or reviewing it.
  draft = await readReleaseDraft({ repository, tag, commandRunner });
  if (!draft || draft.isPrerelease !== manifest.prerelease)
    throw new Error(
      "The prepared release is missing or has the wrong release channel; no assets were uploaded"
    );
  checkExistingPlatformAssets(draft, manifest);
  await commandRunner("gh", [
    "release",
    "upload",
    tag,
    ...manifest.files.map((name) => join(root, "release", name)),
    "--repo",
    repository,
    "--clobber"
  ]);
  return { tag, repository, prerelease: manifest.prerelease, uploaded: manifest.files.length, draft: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (
      !["check", "upload"].includes(action) ||
      args.some((value) => value !== "--replace-notes") ||
      args.length > 1
    )
      throw new Error("Usage: node scripts/release-draft.mjs check|upload [--replace-notes]");
    if (action === "check") {
      if (args.length) throw new Error("--replace-notes requires upload");
      const metadata = await validateRelease(process.cwd(), process.env.RELEASE_TAG);
      const repository = releaseRepository(process.env.GITHUB_REPOSITORY);
      const draft = await readReleaseDraft({ repository, tag: metadata.tag });
      console.log(
        draft
          ? "Existing release is a draft; packaging may proceed."
          : "No existing release; a draft may be prepared."
      );
    } else {
      const result = await uploadReleaseDraft({
        replaceNotes: args.includes("--replace-notes"),
        requireSigningReport: true
      });
      console.log(
        "Draft " + result.tag + " prepared with " + result.uploaded + " assets; review before publishing."
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
