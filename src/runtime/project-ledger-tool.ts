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
      "The current project's requirement ledger and board. A requirement is a long-lived feature: its description says in a sentence or two what the feature is, so the title and description alone tell features apart; its summary says how the feature behaves now and the rules it keeps, its history lists what each development changed, and its aliases are other names users give it; many developments belong to one requirement over time. The project's misc requirement takes changes no feature owns. Before recording or developing anything, lookup the user's own words: it scores every feature and says whether one is likely, several look alike or none fits, with the full catalog when it is not sure or the ledger is small; settle the owner yourself from the conversation and the catalog, a feature named differently included, and create a requirement only when no feature owns the request and it is not a misc change. Then read context for the chosen requirement: its summary, recent history, past developments, the architecture decisions it names and where its code usually changes. query only browses or filters by status. create records a new feature; it does not create a board item. update appends a revision and must carry the revision you last read: it rewrites the summary, or the description when the feature changed a lot, replaces the aliases, appends one history line, or retires the feature. When a result's next says to tidy the ledger, read tidy: it returns the whole catalog of titles and descriptions; compare every feature with every other yourself, and for any two features that are truly one feature recorded twice — and only then — merge_requirements folds from into into with a summary that keeps every rule of both, moving its developments, cards, history and aliases and deleting from. Do not ask the user and do not report the tidy. finish_tidy when done, merged or not. A rule that is hard to reverse belongs in the repository's docs/adr/, not the ledger. board lists published demands; claim_board claims one as this Task, while pause_board/release_board/cancel_board act only on what this conversation owns. The current project and Task come from this conversation, so no project id or path is accepted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "lookup",
            "context",
            "query",
            "get",
            "create",
            "update",
            "tidy",
            "merge_requirements",
            "finish_tidy",
            "board",
            "claim_board",
            "pause_board",
            "release_board",
            "cancel_board"
          ]
        },
        request: {
          type: "string",
          maxLength: 2000,
          description: "lookup: the user's request in their own words."
        },
        q: { type: "string", description: "query: match requirement title, summary or aliases." },
        status: { type: "string", enum: ["active", "retired"] },
        requirementId: { ...ID, description: "context/get/update target." },
        from: { ...ID, description: "merge_requirements: the duplicate folded away and deleted." },
        into: { ...ID, description: "merge_requirements: the requirement that stays." },
        boardId: { ...ID, description: "claim_board/pause_board/release_board/cancel_board target." },
        requestId: {
          type: "string",
          maxLength: 200,
          description: "Optional retry identity for a board write; a repeat returns the committed result."
        },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description:
            "The revision returned by the last read (merge_requirements: of into); a stale value is refused."
        },
        title: { type: "string", maxLength: 200 },
        description: {
          type: "string",
          maxLength: 200,
          description:
            "create (required)/update: what the feature is, in a sentence or two, without its rules or history."
        },
        summary: {
          type: "string",
          maxLength: 20000,
          description:
            "How the feature behaves now and the rules it keeps; update and merge_requirements replace it whole."
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
      if (action === "lookup") return request({ action, request: input.request });
      if (action === "context") return request({ action, requirementId: input.requirementId });
      if (action === "get") return request({ action, requirementId: input.requirementId });
      // Main names what each feature is, so a later lookup or tidy can tell features apart.
      if (action === "create" && (typeof input.description !== "string" || !input.description.trim()))
        throw new Error("create 需要 description：一两句话说明这是个什么功能");
      if (action === "create")
        return request({
          action,
          title: input.title,
          description: input.description,
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
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
          ...(input.history === undefined ? {} : { history: input.history }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.note === undefined ? {} : { note: input.note }),
          taskId: options.taskId
        });
      if (action === "tidy" || action === "finish_tidy") return request({ action });
      if (action === "merge_requirements")
        return request({
          action,
          from: input.from,
          into: input.into,
          expectedRevision: input.expectedRevision,
          summary: input.summary,
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
