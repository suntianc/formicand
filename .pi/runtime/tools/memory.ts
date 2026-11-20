import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemoryTool } from "../../../dist/src/runtime/memory-tool.js";
import type { CoworkToolContext } from "../extension.ts";
import type { RuntimeToolResult } from "../helpers.ts";

/** Main's memory; the project comes from this conversation, so no project id is an argument. */
export function registerMemoryTool(pi: ExtensionAPI, context: CoworkToolContext) {
  const dashboardUrl = process.env.COWORK_DASHBOARD_URL;
  if (!dashboardUrl) return undefined;
  const tool = createMemoryTool({ dashboardUrl, taskId: context.taskId });
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters as Parameters<typeof Type.Unsafe>[0]),
    async execute(_callId, params): Promise<RuntimeToolResult> {
      const result = await tool.execute(params as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });
  return tool;
}
