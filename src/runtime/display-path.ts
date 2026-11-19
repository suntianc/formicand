import { relative, sep } from "node:path";

/** Inside `folder`, or the folder itself. */
const within = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

/**
 * How settings screens show a file: relative inside the project it belongs to,
 * `~/…` under the user's home, otherwise as is. The real path stays in the
 * response for anything that acts on the file.
 */
export function displayPath(path: string, places: { userHome: string; projectDirectory?: string }): string {
  if (places.projectDirectory && within(path, places.projectDirectory))
    return relative(places.projectDirectory, path) || ".";
  if (within(path, places.userHome)) return `~${path.slice(places.userHome.length)}`;
  return path;
}
