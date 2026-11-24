/** macOS keeps a background job and its descendants at utility CPU and disk priority. */
export function utilityCommand(command: string, args: string[]): [string, string[]] {
  return process.platform === "darwin"
    ? ["/usr/sbin/taskpolicy", ["-c", "utility", "-d", "utility", command, ...args]]
    : [command, args];
}
