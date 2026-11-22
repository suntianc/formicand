import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { InboxStore } from "../../dist/src/runtime/scheduler.js";
import { listJobs } from "../../dist/src/tools/jobs.js";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";
import type { RuntimeToolResult } from "./helpers.ts";

/** Local job tools and their durable completion notifications for one Main Run. */
export function createMainJobs(
  workspaceRoot: string,
  taskId: string,
  mainRunId: string,
  taskWorkspace: string,
  projectDirectory: string
) {
  // Main's own jobs, kept beside its Run rather than in the Subagent tree so
  // one Task's long commands stay separable from its delegations'.
  const jobsDirectory = join(taskWorkspace, "runs", mainRunId, "agents", "main", "jobs");
  const currentCapabilities = async () =>
    new LocalWorkspaceStore(workspaceRoot)
      .readTask(taskId)
      .then((task) => task.capabilities)
      // eslint-disable-next-line no-restricted-syntax -- 任务记录缺失时按没有能力授予处理，长任务工具因此保持禁用
      .catch(() => undefined);
  // Read per call for the same reason as the guard: a grant made mid-session
  // has to work on the next call, not the next process.
  const refuseWithoutLongRunning = async (tool: string): Promise<RuntimeToolResult | undefined> => {
    if ((await currentCapabilities())?.longRunning === true) return undefined;
    const payload = {
      ok: false,
      reason: "capability_required",
      note: `${tool} needs the longRunning capability. Ask the user with askhuman whether this work runs for minutes or hours, then record it with grant_capabilities. Short commands do not need it — use bash.`
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload, isError: true };
  };
  // spawn reports a missing cwd as ENOENT on the shell itself, which reads as
  // "no /bin/sh" and sends the model looking in the wrong place. Main's work
  // directory may not exist yet on the first job of a fresh Task.
  const jobCwd = async () => {
    const directory =
      (await currentCapabilities())?.projectWrite === true
        ? projectDirectory
        : join(taskWorkspace, "agents", "main", "work");
    // eslint-disable-next-line no-restricted-syntax -- 创建 work 目录是尽力而为，失败时由 spawn 返回真实错误，不在这里中断工具调用
    await mkdir(directory, { recursive: true }).catch(() => {});
    return directory;
  };
  /**
   * Jobs whose exit Main has already been told about.
   *
   * A finished job is Main's cue to decide what comes next, so it arrives the
   * same way a Subagent's result does — through the Inbox, which wakes Main —
   * rather than being something Main has to remember to poll for. The set only
   * suppresses duplicate wakes within a process; the Inbox message id is what
   * makes the delivery itself idempotent across a restart.
   */
  const observedJobs = new Set<string>();
  const mainInbox = new InboxStore(
    join(taskWorkspace, "runs", mainRunId, "agents", "main", "inbox-store.json")
  );

  /** Count running jobs and queue a wake for any that finished since the last check. */
  const pollJobs = async (): Promise<number> => {
    // eslint-disable-next-line no-restricted-syntax -- 作业目录首次运行时还不存在，读取失败等价于当前没有作业
    const jobs = await listJobs({ directory: jobsDirectory }).catch(() => []);
    let running = 0;
    for (const job of jobs) {
      if (job.state === "running") {
        running += 1;
        observedJobs.add(job.jobId);
        continue;
      }
      if (!observedJobs.has(job.jobId)) continue;
      // Liveness comes from the pid, but the exit code is written by the
      // spawning process's exit handler, so a job reads as exited a tick
      // before its outcome lands. Waking Main with "finished, code unknown"
      // would report a success and a crash identically. An orphan carries a
      // note instead of a code and is reported as it is, since no later pass
      // will fill one in.
      if (job.exitCode === undefined && job.signal === undefined && !job.note) {
        running += 1;
        continue;
      }
      observedJobs.delete(job.jobId);
      await mainInbox
        .enqueue({
          messageId: `job-finished-${job.jobId}`,
          recipientAgentId: "main",
          kind: "external_event",
          eventId: `event-job-${job.jobId}`,
          // Below a Subagent question, above an ordinary callback: a finished job
          // is usually what Main's next decision depends on.
          priority: 10,
          state: "ready",
          payload: {
            type: "job.finished",
            jobId: job.jobId,
            command: job.command,
            exitCode: job.exitCode,
            signal: job.signal,
            elapsedMs: job.elapsedMs,
            logPath: job.logPath,
            tail: job.tail,
            ...(job.note ? { note: job.note } : {})
          },
          createdAt: new Date().toISOString()
        })
        // eslint-disable-next-line no-restricted-syntax -- 入队失败只丢失这次唤醒通知，作业与日志仍在磁盘上，轮询继续
        .catch(() => undefined);
    }
    return running;
  };
  return { jobsDirectory, jobCwd, pollJobs, observedJobs, refuseWithoutLongRunning };
}
