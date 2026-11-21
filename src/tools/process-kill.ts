/**
 * A delegated process stops only the processes it started. Killing by name
 * (`pkill`, `killall`, or `kill` fed by `pgrep`) also reaches the user's own
 * app and services, so the shell call is refused before it runs; stopping a
 * process by the PID it started stays allowed.
 */

export interface ProcessKillRefusal {
  path: string;
  pattern: string;
  reason: string;
}

const BY_NAME = [
  /(?:^|[;&|(`]|\$\()\s*(?:(?:sudo|exec|nohup|command)\s+(?:-\S+\s+)*)?(pkill|killall)(?=\s|$)/,
  /(pgrep)\b[^;&]*\|\s*xargs\s+(?:-\S+\s+)*kill\b/,
  /\bkill\b[^;&|]*\$\(\s*(pgrep|pidof)\b/,
  /\bkill\b[^;&|]*`\s*(pgrep|pidof)\b/
];

/** The refusal for one shell call that kills processes by name, or undefined. */
export function processKillRefusal(toolName: string, input: unknown): ProcessKillRefusal | undefined {
  if (toolName !== "bash" || !input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  for (const pattern of BY_NAME) {
    const match = pattern.exec(command);
    if (match)
      return {
        path: match[1],
        pattern: "kill by name",
        reason: `${match[1]} stops every process with that name, including the user's own app and services. Stop only the processes you started, by the PID you kept when you started them.`
      };
  }
  return undefined;
}
