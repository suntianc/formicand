import { join } from "node:path";

/** Select the ZIP extractor provided by the operating system. */
export function archiveCommand(file: string, destination: string, unzip?: string): [string, string[]] {
  if (!unzip && process.platform === "win32") {
    const system = process.env.SystemRoot;
    if (!system) throw new Error("SystemRoot is required to extract ZIP archives");
    return [join(system, "System32", "tar.exe"), ["-xf", file, "-C", destination]];
  }
  return [unzip ?? "unzip", ["-q", file, "-d", destination]];
}
