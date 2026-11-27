import { existsSync } from "node:fs";
import { basename, dirname, delimiter, join } from "node:path";

/** Launch npm without passing arguments through the Windows command shell. */
export function npmCommand(args, { nodeExecutable = process.execPath, npmCli, env = process.env } = {}) {
  if (npmCli) return { command: nodeExecutable, args: [npmCli, ...args] };
  if (process.platform !== "win32") return { command: "npm", args };
  const inherited = env.npm_execpath;
  if (inherited && basename(inherited).toLowerCase() === "npm-cli.js" && existsSync(inherited))
    return { command: nodeExecutable, args: [inherited, ...args] };
  const directories = [
    dirname(nodeExecutable),
    ...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
  ];
  for (const directory of directories) {
    const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) return { command: nodeExecutable, args: [cli, ...args] };
  }
  throw new Error("Cannot locate npm-cli.js in the Windows Node.js installation or PATH");
}
