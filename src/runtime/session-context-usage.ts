import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export interface SessionContextUsage extends Pick<ContextUsage, "tokens" | "contextWindow"> {
  sessionFile: string;
  window: number;
}

export function mainContextUsagePath(workspaceRoot: string, taskId: string): string {
  return join(workspaceRoot, taskId, "agents", "main", "context", "usage.json");
}
