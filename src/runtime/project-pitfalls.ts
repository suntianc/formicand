import { stat } from "node:fs/promises";
import { join } from "node:path";

/** Where a project keeps its pitfalls index, relative to the project directory. */
export const PITFALLS_INDEX = "docs/pitfalls/README.md";

/**
 * One line telling an agent to read the project's pitfalls index, or
 * undefined when the checkout keeps none. Given once, when the work starts:
 * Main when it opens a requirement's checkout, a delegated role in its task.
 */
export async function pitfallsHint(directory: string): Promise<string | undefined> {
  try {
    if (!(await stat(join(directory, PITFALLS_INDEX))).isFile()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return `This project records its past traps in ${PITFALLS_INDEX}, indexed by trigger. Read the index before you start, and open the entries whose trigger matches your work. They are experience, not requirements; where one disagrees with the code, the code is right.`;
}
