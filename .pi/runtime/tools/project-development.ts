import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProjectDevelopmentTool } from "../../../dist/src/runtime/project-development-tool.js";
import type { CoworkToolContext } from "../extension.ts";
import { askHumanAndWait } from "./coordination.ts";
import type { RuntimeToolResult } from "../helpers.ts";

/** The development tool acts on this conversation's project only; no project id is an argument. */
export function registerProjectDevelopmentTool(pi: ExtensionAPI, context: CoworkToolContext) {
  const dashboardUrl = process.env.COWORK_DASHBOARD_URL;
  if (!dashboardUrl) return;
  const tool = createProjectDevelopmentTool({ dashboardUrl, taskId: context.taskId });
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters as Parameters<typeof Type.Unsafe>[0]),
    async execute(_callId, params, signal, _onUpdate, ctx): Promise<RuntimeToolResult> {
      // The card waits inside this call, so the user's answer is its result.
      const result = await tool.execute(params as Record<string, unknown>, async (proposal) => {
        const confirm = proposal.action === "propose" ? "确认这些票" : "确认修改";
        const { settled } = await askHumanAndWait(
          context,
          {
            question:
              proposal.action === "propose"
                ? `确认需求的票：${proposal.requirementTitle}`
                : `修改已确认的票 ${String(proposal.tickets[0]?.ticketId ?? "")}：${proposal.requirementTitle}`,
            options: [confirm, "拒绝"],
            // A timeout proceeds on the recommended option: nothing is frozen or changed.
            recommended: 1,
            proposal
          },
          signal,
          ctx
        );
        const answer = settled.status === "answered" ? (settled.request.answer ?? "").trim() : "";
        return {
          confirmed: answer.startsWith(confirm),
          status: settled.status,
          ...(answer ? { answer } : {})
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });
}
