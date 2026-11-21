import { createProjectLedgerClient } from "./project-ledger-client.js";

export interface ProjectLedgerToolOptions {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}

const ID = { type: "string", minLength: 1, maxLength: 300 };

/**
 * The Main tool over the project ledger.
 *
 * Kept out of the Pi extension so the production path — this executor and its
 * real HTTP bridge — can be exercised without a model. The extension only
 * registers it.
 */
export function createProjectLedgerTool(options: ProjectLedgerToolOptions) {
  // The bridge is built on first call. Registration must not depend on this
  // run's credential: a delegated subprocess keeps the Dashboard URL while the
  // run credential is removed, and a missing credential must disable only this
  // tool rather than abort every later registration in the extension.
  let client: ReturnType<typeof createProjectLedgerClient> | undefined;
  const bridge = () => (client ??= createProjectLedgerClient(options));
  return {
    name: "project_ledger",
    label: "Project Ledger",
    description:
      "The current project's requirement ledger and board. A requirement is a long-lived feature: its summary says how the feature behaves now and the rules it keeps, its history lists what each development changed, and its aliases are other names users give it; many developments belong to one requirement over time. The project's misc requirement takes changes no feature owns. Query the ledger before recording anything, so one feature keeps one requirement. create records a new feature; it does not create a board item. update appends a revision and must carry the revision you last read: it rewrites the summary, replaces the aliases, appends one history line, or retires the feature. A rule that is hard to reverse belongs in the repository's docs/adr/, not the ledger. board lists published demands; claim_board claims one as this Task, while pause_board/release_board/cancel_board act only on what this conversation owns. The current project and Task come from this conversation, so no project id or path is accepted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "query",
            "get",
            "create",
            "update",
            "board",
            "claim_board",
            "pause_board",
            "release_board",
            "cancel_board"
          ]
        },
        q: { type: "string", description: "query: match requirement title, summary or aliases." },
        status: { type: "string", enum: ["active", "retired"] },
        requirementId: { ...ID, description: "get/update target." },
        boardId: { ...ID, description: "claim_board/pause_board/release_board/cancel_board target." },
        requestId: {
          type: "string",
          maxLength: 200,
          description: "Optional retry identity for a board write; a repeat returns the committed result."
        },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "The revision returned by the last read; a stale value is refused."
        },
        title: { type: "string", maxLength: 200 },
        summary: {
          type: "string",
          maxLength: 20000,
          description: "How the feature behaves now and the rules it keeps; update replaces it whole."
        },
        aliases: {
          type: "array",
          maxItems: 20,
          items: { type: "string", maxLength: 100 },
          description: "Other names for the feature; update replaces the whole list."
        },
        history: { type: "string", maxLength: 1000, description: "update: one history line, dated today." },
        note: { type: "string", maxLength: 2000, description: "Why this revision happened." },
        sourceKind: { type: "string", enum: ["internal", "external", "legacy"] },
        sourceReference: { type: "string", maxLength: 300, description: "Opaque external label." }
      },
      required: ["action"],
      additionalProperties: false
    },
    async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const action = typeof input.action === "string" ? input.action : "";
      const client = bridge();
      const request = client.request;
      const source =
        input.sourceKind === undefined && input.sourceReference === undefined
          ? undefined
          : {
              kind: input.sourceKind ?? "internal",
              ...(input.sourceReference ? { reference: input.sourceReference } : {})
            };
      if (action === "query")
        return request({
          action,
          ...(input.q === undefined ? {} : { q: input.q }),
          ...(input.status === undefined ? {} : { status: input.status })
        });
      if (action === "get") return request({ action, requirementId: input.requirementId });
      if (action === "create")
        return request({
          action,
          title: input.title,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
          ...(source ? { source } : {}),
          // The requirement remembers which conversation raised it.
          references: [{ kind: "task", value: options.taskId }]
        });
      if (action === "update")
        return request({
          action,
          requirementId: input.requirementId,
          expectedRevision: input.expectedRevision,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
          ...(input.history === undefined ? {} : { history: input.history }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.note === undefined ? {} : { note: input.note }),
          taskId: options.taskId
        });
      if (action === "board") return client.board(undefined, "GET");
      if (
        action === "claim_board" ||
        action === "pause_board" ||
        action === "release_board" ||
        action === "cancel_board"
      )
        return client.board({
          action: action.slice(0, -"_board".length),
          boardId: input.boardId,
          expectedRevision: input.expectedRevision,
          requestId:
            input.requestId ??
            `board_${String(action)}_${String(input.boardId)}_${String(input.expectedRevision)}`
        });
      throw new Error(`未知的台账操作：${String(action)}`);
    }
  };
}
