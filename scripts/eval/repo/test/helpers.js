import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../src/cli.js", import.meta.url).pathname;

/** A fresh data file holding `items`, and a runner for the CLI against it. */
export function todo(items = []) {
  const file = join(mkdtempSync(join(tmpdir(), "todo-")), "todo.json");
  writeFileSync(file, JSON.stringify(items));
  return (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [cli, ...args], {
          env: { ...process.env, TODO_FILE: file },
          encoding: "utf8"
        })
      };
    } catch (error) {
      return { code: error.status, out: error.stdout, err: error.stderr };
    }
  };
}
