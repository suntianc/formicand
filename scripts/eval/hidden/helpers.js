import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The repository under check; the runner sets it. */
export const repo = process.env.EVAL_REPO;

/** A fresh data file holding `items`, and a runner for the CLI against it. */
export function todo(items = [], env = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "todo-hidden-")), "todo.json");
  writeFileSync(file, JSON.stringify(items));
  return (...args) => {
    try {
      const out = execFileSync("node", [join(repo, "src/cli.js"), ...args], {
        env: { ...process.env, ...env, TODO_FILE: file },
        encoding: "utf8"
      });
      return { code: 0, out };
    } catch (error) {
      return { code: error.status, out: error.stdout, err: error.stderr };
    }
  };
}
