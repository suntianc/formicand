import type { ChildProcess } from "node:child_process";
import {
  MainSupervisor,
  SUPERVISOR_WAKE_TURN,
  type MainSupervisorCycleResult
} from "../runtime/main-supervisor.js";
import { type RunServicePorts, type LaunchMainRun } from "./run-service-contracts.js";
import type { createResidentMainRegistry } from "./resident-main-registry.js";

export function createMainRunGuardian({
  isStopping,
  mainGuardian,
  residentMain,
  activeRuns,
  startMainRun
}: {
  isStopping: () => boolean;
  mainGuardian: RunServicePorts["mainGuardian"];
  residentMain: ReturnType<typeof createResidentMainRegistry>["residentMain"];
  activeRuns: Map<string, ChildProcess>;
  startMainRun: LaunchMainRun;
}) {
  /**
   * Main recovery owned by this service.
   *
   * A Task whose Main died while callbacks remained addressed to it is started
   * again through the ordinary Main entry, so a full external budget queues the
   * wake instead of dropping it.
   */
  const mainGuardianDisabled = () => process.env.FORMICAND_DISABLE_MAIN_GUARDIAN === "1";

  const mainGuardianIntervalMs = () =>
    Math.max(1000, Number(process.env.FORMICAND_MAIN_GUARDIAN_INTERVAL_MS) || 60_000);

  let mainGuardianTimer: ReturnType<typeof setTimeout> | undefined;

  let mainGuardianPending: Promise<void> | undefined;

  let mainGuardianStopped = false;

  async function runMainGuardianCycle(): Promise<MainSupervisorCycleResult[]> {
    if (
      isStopping() ||
      mainGuardianStopped ||
      mainGuardianDisabled() ||
      !mainGuardian ||
      !mainGuardian.modelConfigured()
    )
      return [];
    const results: MainSupervisorCycleResult[] = [];
    for (const workspaceRoot of await mainGuardian.workspaceRoots()) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() 可在读取工作区期间置位，此时不能再启动新周期
      if (isStopping() || mainGuardianStopped) break;
      const supervisor = new MainSupervisor({
        workspaceRoot,
        // A Run this host owns is alive even before its heartbeat is written.
        isRunning: (taskId) => residentMain(taskId) !== undefined || activeRuns.has(taskId),
        launch: async ({ taskId, runId }) => {
          const launch = await startMainRun(taskId, SUPERVISOR_WAKE_TURN, runId, true, undefined, undefined, {
            origin: "internal",
            queueWhenFull: true
          });
          if (launch.status === "failed") throw new Error(launch.error);
        }
      });
      results.push(await supervisor.runCycle());
    }
    return results;
  }

  function tickMainGuardian() {
    if (isStopping() || mainGuardianStopped || mainGuardianPending) return;
    mainGuardianPending = runMainGuardianCycle()
      .then(() => undefined)
      .catch((error) => {
        console.error(
          `[formicand] main guardian cycle failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        mainGuardianPending = undefined;
        if (!isStopping() && !mainGuardianStopped)
          mainGuardianTimer = setTimeout(tickMainGuardian, mainGuardianIntervalMs());
      });
  }

  function startMainGuardian() {
    if (mainGuardianTimer || isStopping() || mainGuardianStopped || mainGuardianDisabled() || !mainGuardian)
      return;
    tickMainGuardian();
  }

  async function stopMainGuardian() {
    mainGuardianStopped = true;
    clearTimeout(mainGuardianTimer);
    mainGuardianTimer = undefined;
    await mainGuardianPending;
  }

  return { runMainGuardianCycle, startMainGuardian, stopMainGuardian };
}
