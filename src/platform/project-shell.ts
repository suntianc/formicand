import { existsSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";

/** Older Git for Windows installs may only put cmd/git.exe on PATH. */
function gitBash(env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!win32.isAbsolute(directory) || !existsSync(join(directory, "git.exe"))) continue;
    for (const base of [directory, join(directory, "..", "bin"), join(directory, "..", "..", "bin")]) {
      const bash = join(base, "bash.exe");
      if (existsSync(bash)) return bash;
    }
  }
  return undefined;
}

export function projectCheckShell(): string {
  return process.platform === "win32" ? (gitBash(process.env) ?? "sh.exe") : "/bin/sh";
}

/** Pi's fallback otherwise finds the legacy System32 WSL launcher before Git Bash. */
export function piShellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return env;
  const bash = gitBash(env);
  if (!bash) return env;
  const key = Object.hasOwn(env, "PATH")
    ? "PATH"
    : (Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH");
  const directories = (env[key] ?? "").split(delimiter);
  const bin = dirname(bash);
  return {
    ...env,
    [key]: [bin, ...directories.filter((entry) => entry.toLowerCase() !== bin.toLowerCase())].join(delimiter)
  };
}
