import { firstMainExchange } from "../runtime/main-message-edit.js";
import { roleCompletion } from "../runtime/model-connection.js";
import type { ResolvedModelRole } from "../runtime/role-models.js";
import { withFallbackModel } from "../runtime/session-summary.js";
import { writeSessionTitle } from "../runtime/session-title.js";
import type { TaskLocation } from "./workspace-directory.js";

/**
 * Name a conversation once its first turn has a reply.
 *
 * Only a conversation without a title is named: a title the user gave, a
 * fork's or an edit's is kept, and a later rename replaces this one. Each
 * conversation is tried once per backend, so a model that cannot write a
 * title costs one request, not one per turn.
 */
export function createSessionTitles(ports: {
  /** The utility model, or undefined to use the conversation's own. */
  utilityModel(): ResolvedModelRole | undefined;
  mainModel(location: TaskLocation): ResolvedModelRole;
  /** Save the title unless the conversation got one meanwhile. */
  saveTitle(taskId: string, title: string): Promise<void>;
}) {
  const tried = new Set<string>();
  const model = (selection: ResolvedModelRole) => ({
    complete: roleCompletion(selection),
    contextWindow: selection.profile.contextWindow
  });

  async function nameConversation(location: TaskLocation): Promise<void> {
    const { task, workspaceRoot } = location;
    if (task.title || tried.has(task.taskId)) return;
    // Claimed before the read: a turn's settlement and its Run's finalization
    // arrive together, and only one of them may ask.
    tried.add(task.taskId);
    const exchange = await firstMainExchange(workspaceRoot, task.taskId);
    if (!exchange) {
      tried.delete(task.taskId);
      return;
    }
    let utility: ResolvedModelRole | undefined;
    try {
      utility = ports.utilityModel();
    } catch (error) {
      console.warn(
        "[Formicand] The utility model is unusable; using the conversation's model:",
        error instanceof Error ? error.message : String(error)
      );
    }
    const { complete } = withFallbackModel(utility && model(utility), model(ports.mainModel(location)));
    const title = await writeSessionTitle(exchange, complete);
    if (title) await ports.saveTitle(task.taskId, title);
  }

  return {
    /** Called when a Run settles; never throws into the settlement. */
    afterRun(location: TaskLocation): void {
      void nameConversation(location).catch((error) =>
        console.error(
          `[formicand] naming ${location.task.taskId} failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  };
}
