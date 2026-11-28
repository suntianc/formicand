import { mkdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";

/** Replace the fixture's draft file with a directory so the real atomic write fails on every host. */
export async function blockDraftSave(profile) {
  const path = join(profile, "composer-drafts.json");
  const saved = path + ".fixture-original";
  await rename(path, saved);
  try {
    await mkdir(path);
  } catch (error) {
    await rename(saved, path);
    throw error;
  }
  return async () => {
    await rmdir(path);
    await rename(saved, path);
  };
}
