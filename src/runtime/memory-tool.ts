import { createProjectLedgerClient } from "./project-ledger-client.js";
import { MEMORY_LIMITS, MEMORY_TYPES } from "./memory-store.js";

export interface MemoryToolOptions {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}

/**
 * Main's `memory` tool and the index it reads each turn.
 *
 * Main names a scope, never a project: the Dashboard resolves the project from
 * this Task. A delegated subprocess has no run credential, so Subagents cannot
 * use it; Main passes on what a collaborator needs.
 */
export function createMemoryTool(options: MemoryToolOptions) {
  let client: ReturnType<typeof createProjectLedgerClient> | undefined;
  const bridge = () => (client ??= createProjectLedgerClient({ ...options, label: "记忆工具" }));
  return {
    name: "memory",
    label: "Memory",
    description: `Your memory across sessions. Scope user follows the user across projects; scope project is this project only. Save, without asking, what will still help in a later session: the user's role and habits (type user); a correction they gave or an approach they confirmed, with the reason (feedback); work, decisions or deadlines the code, ledger and development records do not show (project); where outside information lives (reference). Do not save what the code, AGENTS.md, the ledger or a development record already holds, or what only matters to this conversation. Update an existing memory instead of adding a near-duplicate, and delete one that proved wrong. Your system prompt lists the index; read a memory before relying on it.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "write", "delete"] },
        scope: { type: "string", enum: ["user", "project"] },
        name: {
          type: "string",
          maxLength: 64,
          description: "Lowercase letters, digits and hyphens. write replaces a memory of the same name."
        },
        type: { type: "string", enum: [...MEMORY_TYPES] },
        description: {
          type: "string",
          maxLength: MEMORY_LIMITS.description,
          description: "One line for the index."
        },
        body: {
          type: "string",
          maxLength: MEMORY_LIMITS.body,
          description: "The fact; for feedback and project add why it holds and how to apply it."
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const action = input.action;
      const memory = bridge().memory;
      if (action === "list") return memory({ action });
      if (action === "read" || action === "delete")
        return memory({ action, scope: input.scope, name: input.name });
      if (action === "write")
        return memory({
          action,
          scope: input.scope,
          memory: { name: input.name, type: input.type, description: input.description, body: input.body }
        });
      throw new Error(`未知的记忆操作：${String(action)}`);
    },
    /** The index for this turn's system prompt; empty when nothing is saved. */
    async index(): Promise<string> {
      const result = await bridge().memory(undefined, "GET");
      return typeof result.index === "string" ? result.index : "";
    }
  };
}
