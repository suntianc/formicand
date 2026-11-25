import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProjectDevelopmentTool } from "../../../dist/src/runtime/project-development-tool.js";
import type { FormicandToolContext } from "../extension.ts";
import { askHumanAndWait } from "./coordination.ts";
import type { RuntimeToolResult } from "../helpers.ts";

/** The development tool acts on this conversation's project only; no project id is an argument. */
export function registerProjectDevelopmentTool(pi: ExtensionAPI, context: FormicandToolContext) {
  const dashboardUrl = process.env.FORMICAND_DASHBOARD_URL;
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
        // A repeated proposal for the same Run and revision must reopen the same card.
        const key = [context.mainRunId, proposal.developmentId, proposal.expectedRevision, proposal.action];
        const identity = JSON.stringify([
          key,
          proposal.reason,
          proposal.tickets.map(({ ticketId, title, scope, criteria, preserve, outOfScope, dependsOn }) => [
            ticketId,
            title,
            scope,
            criteria,
            preserve,
            outOfScope,
            dependsOn
          ])
        ]);
        const requestId = "human_" + createHash("sha256").update(identity).digest("hex");
        const { settled } = await askHumanAndWait(
          context,
          {
            question:
              proposal.action === "propose"
                ? `确认需求的票：${proposal.requirementTitle}`
                : `修改已确认的票 ${String(proposal.tickets[0]?.ticketId ?? "")}：${proposal.requirementTitle}`,
            options: [confirm, "拒绝"],
            // A timeout proceeds on the recommended option: nothing is frozen or changed.
            recommended: [1],
            proposal
          },
          signal,
          ctx,
          requestId
        );
        const answer = settled.status === "answered" ? (settled.request.answer ?? "").trim() : "";
        return {
          confirmed: answer === confirm,
          requestId,
          status: settled.status,
          ...(answer ? { answer } : {})
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });
}
