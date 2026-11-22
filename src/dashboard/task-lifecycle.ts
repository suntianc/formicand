import type { CoordinatorRuntime } from "../runtime/coordinator-runtime.js";
import { HumanRequestStore } from "../runtime/human.js";
import { SubagentQuestionStore } from "../runtime/subagent-questions.js";
import type { TaskPatch } from "../workspace/workspace-store.js";
import type { TaskLocation } from "./workspace-directory.js";

interface TaskLifecyclePorts {
  locateTask(taskId: string): Promise<TaskLocation>;
  serialize<T>(taskId: string, action: () => Promise<T>): Promise<T>;
  coordinator: Pick<CoordinatorRuntime, "waitForSubagents">;
  ensureMainProcess(taskId: string): Promise<boolean>;
  taskTurnActive(taskId: string): Promise<boolean>;
  closeIdleMain(taskId: string): Promise<boolean>;
}

export function createTaskLifecycle({
  locateTask,
  serialize,
  coordinator,
  ensureMainProcess,
  taskTurnActive,
  closeIdleMain
}: TaskLifecyclePorts) {
  function completeTask(taskId: string) {
    return serialize(taskId, async () => {
      const { workspaceRoot, store, task } = await locateTask(taskId);
      if ((await new HumanRequestStore(workspaceRoot).list(taskId, "pending")).length)
        return { error: "任务仍有待回答的问题" };
      if ((await new SubagentQuestionStore(workspaceRoot).list(taskId, "pending")).length)
        return { error: "仍有协作者在等待回答" };
      if (task.activeRunId) {
        const coordination = await coordinator.waitForSubagents({
          taskId,
          runId: task.activeRunId,
          workspaceRoot,
          timeoutMs: 0
        });
        if (coordination.pending.length || coordination.callbackPending.length)
          return { error: "Task still has pending Subagent work", coordination };
      }
      return { task: await store.transitionTask(taskId, "completed", { reason: "ui_complete" }) };
    });
  }

  function resumeTask(taskId: string) {
    return serialize(taskId, async () => {
      const { store } = await locateTask(taskId);
      return store.transitionTask(taskId, "running", { reason: "ui_resume" });
    });
  }

  /** Subagents and active or paused Main sessions keep their Task open. */
  async function hasIdleMainToClose(
    { task, workspaceRoot }: TaskLocation,
    refusal: string
  ): Promise<boolean> {
    const { taskId, activeRunId } = task;
    if (activeRunId) {
      const work = await coordinator.waitForSubagents({
        taskId,
        runId: activeRunId,
        workspaceRoot,
        timeoutMs: 0
      });
      if (work.pending.length) throw new Error(refusal);
    }
    if (!(await ensureMainProcess(taskId))) return false;
    if (task.status === "paused" || (await taskTurnActive(taskId))) throw new Error(refusal);
    return true;
  }

  function updateTask(taskId: string, patch: TaskPatch) {
    return serialize(taskId, async () => {
      const location = await locateTask(taskId);
      const close = patch.archived && (await hasIdleMainToClose(location, "请先停止任务，再归档会话"));
      const task = await location.store.updateTask(taskId, patch);
      // Return after saving the archive flag. The queued close can also write
      // the Task, so it runs after the flag is saved and rechecks the Main.
      if (close)
        void serialize(taskId, () => closeIdleMain(taskId)).catch((error) =>
          console.error(
            `[cowork] closing the Main of archived ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      return { ...location, task };
    });
  }

  function deleteTask(taskId: string) {
    return serialize(taskId, async () => {
      const location = await locateTask(taskId);
      const refusal = "请先停止任务，再删除会话";
      if ((await hasIdleMainToClose(location, refusal)) && !(await closeIdleMain(taskId)))
        throw new Error(refusal);
      await location.store.deleteTask(taskId);
    });
  }

  return { completeTask, resumeTask, updateTask, deleteTask };
}
