import { join } from "node:path";
import { conflict } from "./development-errors.js";
import { chainOf, checkRound } from "./development-review-rounds.js";
import { mergeCheckCommands } from "../domain/development-merge.js";
import {
  ticketBrief,
  ticketIdentifier,
  type DevelopmentTicket,
  type TicketCheckResult,
  type TicketSet,
  type TicketWork
} from "../domain/development-ticket.js";
import { type DevelopmentRecord } from "../domain/project-development.js";
import { now } from "../domain/types.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";
import { git, gitPaths, gitProbe, onlyTargetMergedSince } from "../workspace/development-workspace.js";
import { runMergeChecks } from "../workspace/project-merge.js";
import { prepareWorkItemSite } from "../workspace/work-item-workspace.js";
import type { ProjectDevelopmentPorts } from "./project-development-service.js";
import type { createDevelopmentWorkspaceService } from "./development-workspace-service.js";

/** What a ticket integration ended with. */
export type TicketIntegrationResult = Record<string, unknown> & { integrated: boolean; ticketId?: string };

export function createDevelopmentTicketService({
  gateway,
  inDevelopment,
  integrating,
  inspectWorkspace,
  taskProject,
  requiredMergeConfig,
  ports
}: {
  gateway: () => Promise<ProjectDataGateway>;
  inDevelopment: ReturnType<typeof createDevelopmentWorkspaceService>["inDevelopment"];
  integrating: ReturnType<typeof createDevelopmentWorkspaceService>["integrating"];
  inspectWorkspace: ReturnType<typeof createDevelopmentWorkspaceService>["inspectWorkspace"];
  taskProject: ReturnType<typeof createDevelopmentWorkspaceService>["taskProject"];
  requiredMergeConfig: ReturnType<typeof createDevelopmentWorkspaceService>["requiredMergeConfig"];
  ports: Pick<ProjectDevelopmentPorts, "backendId">;
}) {
  /** Whether a development is split into tickets: the full route. */
  function ticketRoute(record: DevelopmentRecord): boolean {
    return record.route !== "quick";
  }

  async function requireTicket(
    projectId: string,
    developmentId: string,
    ticketIdValue: unknown
  ): Promise<{ set: TicketSet; ticket: DevelopmentTicket }> {
    const ticketId = ticketIdentifier(ticketIdValue);
    const set = await (await gateway()).tickets(projectId, developmentId);
    const ticket = set.tickets.find((entry) => entry.ticketId === ticketId);
    if (!ticket) throw conflict(`需求没有票 ${ticketId}`, "ticket_missing");
    return { set, ticket };
  }

  /** A checkout's committed state, read from Git. */
  async function inspectDirectory(directory: string) {
    try {
      const [commit, tree, branch, changes] = await Promise.all([
        git(directory, ["rev-parse", "HEAD"]),
        git(directory, ["rev-parse", "HEAD^{tree}"]),
        git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(directory, ["status", "--porcelain"])
      ]);
      return { commit, tree, branch, workspace: directory, changes };
    } catch (error) {
      throw conflict(
        `无法读取现场 ${directory}：${error instanceof Error ? error.message : String(error)}`,
        "review_site_unavailable"
      );
    }
  }

  /** The version the program last produced by bringing a ticket in. */
  function lastIntegration(tickets: DevelopmentTicket[]) {
    return tickets
      .flatMap((ticket) => (ticket.integration ? [ticket.integration] : []))
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1);
  }

  /** The target branch's tip as `repository` sees it, or undefined when it has no such branch. */
  async function targetTip(projectId: string, repository: string) {
    const { targetBranch } = await requiredMergeConfig(projectId);
    return gitProbe(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}`]);
  }

  /**
   * Whether `commit` is the version the program last integrated, or that
   * version with only the target branch merged in by sync_target.
   */
  async function fromIntegration(projectId: string, repository: string, integration: string, commit: string) {
    if (integration === commit) return true;
    const target = await targetTip(projectId, repository);
    return target !== undefined && (await onlyTargetMergedSince(repository, integration, commit, target));
  }

  /**
   * Merge the target branch's new commits into a ticketed requirement's
   * checkout, so the tickets after it and the final review build on them
   * without a ticket of their own. Git must merge it cleanly; a conflict needs
   * a person's judgment, so it goes back to Main as a fix ticket.
   */
  function syncTarget(projectId: string, input: Record<string, unknown>) {
    return inDevelopment(projectId, input, async (record) => {
      if (!ticketRoute(record))
        throw conflict("quick 路线在需求现场里自己合并目标分支，再重新自查或送审", "sync_target_unneeded");
      const directory = record.workspace!.directory;
      const before = await inspectWorkspace(record);
      if (before.changes) throw conflict("需求现场有未提交改动；先提交或清理", "review_candidate_dirty");
      const { targetBranch } = await requiredMergeConfig(projectId);
      const target = await targetTip(projectId, directory);
      if (target === undefined)
        throw conflict(`需求现场看不到目标分支 ${targetBranch}`, "sync_target_unavailable");
      if ((await gitProbe(directory, ["merge-base", "--is-ancestor", target, before.commit])) !== undefined)
        return {
          synced: false,
          developmentId: record.developmentId,
          detail: `已包含 ${targetBranch} 的最新提交`
        };
      try {
        await git(directory, [
          "merge",
          "--no-ff",
          "-m",
          `Merge ${targetBranch} into the requirement`,
          target
        ]);
      } catch (error) {
        const paths = await gitPaths(directory, ["diff", "--name-only", "--diff-filter=U"])
          // eslint-disable-next-line no-restricted-syntax -- 冲突文件列表读不到时仍按合并失败处理，原始 git 错误随后报告
          .catch(() => [] as string[]);
        // eslint-disable-next-line no-restricted-syntax -- 合并已失败，可能没有可中止的合并；中止失败不改变下面的拒绝结果
        await git(directory, ["merge", "--abort"]).catch(() => undefined);
        throw conflict(
          paths.length
            ? `需求现场与 ${targetBranch} 冲突：${paths.join("、")}。提一张修复票，让 Executor 在它的现场合并 ${targetBranch} 并解决冲突`
            : `无法把 ${targetBranch} 合并进需求现场：${error instanceof Error ? error.message : String(error)}`,
          "sync_target_conflict"
        );
      }
      const after = await inspectWorkspace(record);
      return { synced: true, developmentId: record.developmentId, commit: after.commit, target };
    });
  }

  /**
   * The files a ticket's checkout changed since it forked. A file outside the
   * ticket's scope is the Reviewer's question, not a refusal: the ticket may
   * have needed it, and asking the user to widen the scope costs a card.
   */
  function ticketChangedPaths(directory: string, integration: string, candidate: string) {
    // A rename changes both paths. Ask Git for the deletion and addition separately.
    return gitPaths(directory, ["diff", "--name-only", "--no-renames", `${integration}...${candidate}`]);
  }

  /**
   * Bring a ticket's reviewed commit into the requirement checkout.
   *
   * The program merges it, then runs the project's checks and the ticket's
   * acceptance commands there. A conflict or a failing check leaves the
   * checkout as it was, so a later ticket never builds on a broken version.
   */
  function integrateTicket(projectId: string, input: Record<string, unknown>) {
    return inDevelopment(projectId, input, (record) => integrateTicketNow(projectId, record, input));
  }

  /**
   * The same integration for a caller that cannot wait for the checks: it
   * answers once the ticket is merged and its checks have started, and
   * `settled` receives the outcome. The checkout stays locked until then.
   */
  function integrateTicketInBackground(
    projectId: string,
    input: Record<string, unknown>,
    settled: (result: TicketIntegrationResult) => Promise<void>
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let started: { developmentId: string; ticketId: string } | undefined;
      const work = inDevelopment(projectId, input, (record) =>
        integrateTicketNow(projectId, record, input, (ticketId, checks) => {
          started = { developmentId: record.developmentId, ticketId };
          integrating.set(record.developmentId, ticketId);
          resolve({ pending: true, developmentId: record.developmentId, ticketId, checks });
        })
      );
      void work
        .then(
          (result) => result,
          (error: unknown): TicketIntegrationResult => {
            if (!started) throw error;
            return {
              integrated: false,
              ticketId: started.ticketId,
              developmentId: started.developmentId,
              detail: error instanceof Error ? error.message : String(error)
            };
          }
        )
        .then(
          async (result) => {
            if (!started) return resolve(result);
            integrating.delete(started.developmentId);
            // The outcome is already in the checkout and the tickets; a lost notice
            // costs only Main's prompt wake, and next still reports it.
            await settled(result).catch((error: unknown) =>
              console.error("通知 Main 票的并入结果失败", error)
            );
          },
          (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)))
        );
    });
  }

  async function integrateTicketNow(
    projectId: string,
    record: DevelopmentRecord,
    input: Record<string, unknown>,
    checksStarted?: (ticketId: string, checks: string[]) => void
  ): Promise<TicketIntegrationResult> {
    const developmentId = record.developmentId;
    const service = await gateway();
    const { set, ticket } = await requireTicket(projectId, developmentId, input.ticketId);
    if (ticket.state !== "passed")
      throw conflict(`票 ${ticket.ticketId} 还没有通过审查`, "ticket_state_conflict");
    const review = await service.getReview(projectId, ticket.reviewIds.at(-1)!);
    const item = await inspectDirectory(ticket.work!.workspace);
    if (item.commit !== review.candidate.commit || item.tree !== review.candidate.tree)
      throw conflict(
        `票 ${ticket.ticketId} 的现场在审查后又有变化；须对新提交重新审查`,
        "ticket_candidate_changed"
      );
    const directory = record.workspace!.directory;
    let before = await inspectWorkspace(record);
    if (before.changes) throw conflict("需求现场有未提交改动；先提交或清理", "review_candidate_dirty");
    // The ledger's baseline and recorded ticket merges are already published.
    // An unrecorded two-parent merge of a passed ticket was interrupted, no
    // matter which ticket is next or how its Git commit message was written.
    const recorded =
      before.commit === record.workspace!.baseCommit ||
      set.tickets.some((entry) => entry.integration?.commit === before.commit);
    if (!recorded) {
      const parents = (await git(directory, ["rev-list", "--parents", "-n", "1", before.commit])).split(" ");
      if (parents.length === 3) {
        const passedReviews = new Set(
          set.tickets.filter((entry) => entry.state === "passed").map((entry) => entry.reviewIds.at(-1))
        );
        const reviews = await service.queryReviews(projectId, developmentId);
        if (
          reviews.some((entry) => passedReviews.has(entry.reviewId) && entry.candidate.commit === parents[2])
        ) {
          await git(directory, ["reset", "--hard", parents[1]]);
          before = await inspectWorkspace(record);
        }
      }
    }
    const checks = [
      ...(input.checks === undefined ? [] : mergeCheckCommands(input.checks)),
      ...ticket.criteria.flatMap((criterion) =>
        "command" in criterion.check
          ? [{ name: `${ticket.ticketId} ${criterion.criterionId}`, command: criterion.check.command }]
          : []
      )
    ];
    if (!checks.length)
      throw conflict("并进需求现场须至少有一项检查：传入项目检查命令", "merge_checks_missing");
    try {
      await git(directory, [
        "merge",
        "--no-ff",
        "-m",
        `Merge ticket ${ticket.ticketId}: ${ticket.title}`,
        item.commit
      ]);
    } catch (error) {
      const paths = await gitPaths(directory, ["diff", "--name-only", "--diff-filter=U"])
        // eslint-disable-next-line no-restricted-syntax -- 冲突文件列表读不到时仍按合并失败处理，原始 git 错误随后报告
        .catch(() => [] as string[]);
      // eslint-disable-next-line no-restricted-syntax -- 合并已失败，可能没有可中止的合并；中止失败不改变下面的拒绝结果
      await git(directory, ["merge", "--abort"]).catch(() => undefined);
      throw conflict(
        paths.length
          ? `票 ${ticket.ticketId} 与需求现场冲突：${paths.join("、")}。让原 Executor 在它的现场合并需求现场的最新提交后重新审查`
          : `票 ${ticket.ticketId} 无法并进需求现场：${error instanceof Error ? error.message : String(error)}`,
        "ticket_integration_conflict"
      );
    }
    checksStarted?.(
      ticket.ticketId,
      checks.map((check) => check.name)
    );
    const results = await runMergeChecks(directory, checks);
    const failed = results.filter((check) => check.exitCode !== 0);
    if (failed.length) {
      // Only the merge just made is undone; the checkout was clean before it.
      await git(directory, ["reset", "--hard", before.commit]);
      return {
        integrated: false,
        ticketId: ticket.ticketId,
        developmentId,
        checks: results,
        detail: `检查未通过：${failed.map((check) => check.name).join("、")}；需求现场已回到并入前`
      };
    }
    const after = await inspectWorkspace(record);
    const tickets = await service.writeTickets(projectId, developmentId, {
      op: "integrate",
      ticketId: ticket.ticketId,
      integration: {
        commit: after.commit,
        tree: after.tree,
        itemCommit: item.commit,
        checks: results.map((check): TicketCheckResult => ({
          name: check.name,
          command: check.command,
          exitCode: check.exitCode ?? 0,
          output: check.output ?? "",
          at: check.at ?? now()
        })),
        at: now()
      }
    });
    return { integrated: true, ticketId: ticket.ticketId, developmentId, tickets };
  }

  /** The tickets a delegation implements: the brief the Executor reads, after its rules are checked. */
  async function ticketForDispatch(
    taskId: string,
    developmentId: string,
    ticketIdValue: unknown,
    continuation = false
  ) {
    const found = await taskProject(taskId);
    const record = await (await gateway()).getDevelopment(found.projectId, developmentId, ports.backendId);
    if (!ticketRoute(record)) throw conflict("quick 路线没有票", "ticket_missing");
    const { set, ticket } = await requireTicket(found.projectId, developmentId, ticketIdValue);
    const criteria = ticket.criteria.map((criterion) => criterion.criterionId);
    // A continuation keeps the session that already read the brief: a rework
    // restarts the ticket, a follow-up while it is still running leaves it alone.
    if (continuation) {
      if (ticket.state === "rework") {
        // Starting the round marks the ticket in progress, so a round its
        // review could never take is refused here, before the ticket is held
        // by work that cannot be reviewed and a fresh Executor cannot replace.
        const reviews = await (await gateway()).queryReviews(found.projectId, developmentId);
        checkRound(chainOf(set.tickets, reviews, ticket), set.tickets, ticket);
        return { ticketId: ticket.ticketId, criteria, start: true };
      }
      if (ticket.state === "in_progress") return { ticketId: ticket.ticketId, criteria, start: false };
      throw conflict(`票 ${ticket.ticketId} 现在不需要返修`, "ticket_state_conflict");
    }
    if (ticket.state !== "confirmed" && ticket.state !== "rework")
      throw conflict(
        ticket.state === "draft"
          ? `票 ${ticket.ticketId} 还没有经用户确认`
          : `票 ${ticket.ticketId} 已经在执行或已完成，返修用 continueCallId`,
        "ticket_state_conflict"
      );
    const blocking = ticket.dependsOn.filter(
      (id) => set.tickets.find((other) => other.ticketId === id)?.state !== "merged"
    );
    if (ticket.state === "confirmed" && blocking.length)
      throw conflict(
        `票 ${ticket.ticketId} 依赖的票 ${blocking.join("、")} 还没有合入`,
        "ticket_dependency_pending"
      );
    return { ticketId: ticket.ticketId, brief: ticketBrief(ticket), criteria, start: true };
  }

  async function ticketStarted(taskId: string, developmentId: string, ticketId: string, work: TicketWork) {
    const found = await taskProject(taskId);
    await (await gateway()).writeTickets(found.projectId, developmentId, { op: "start", ticketId, work });
  }

  /**
   * Main writes a ticket itself. The program opens the ticket's own checkout,
   * forked from the requirement checkout as an Executor's is, so review,
   * rework and integration take it the same way; starting it again after a
   * failed review reopens the same checkout with its commits.
   */
  async function startTicket(taskId: string, input: Record<string, unknown>) {
    const found = await taskProject(taskId);
    return inDevelopment(found.projectId, input, async (record) => {
      const checked = await ticketForDispatch(taskId, record.developmentId, input.ticketId);
      const name = `main-${record.developmentId}-${checked.ticketId}`;
      const site = {
        developmentDirectory: record.workspace!.directory,
        directory: join(record.workspace!.directory, "..", "work-items", name),
        branch: `formicand/work/${name}`
      };
      await prepareWorkItemSite(site);
      await ticketStarted(taskId, record.developmentId, checked.ticketId, { workspace: site.directory });
      return {
        developmentId: record.developmentId,
        ticketId: checked.ticketId,
        workspace: site.directory,
        branch: site.branch,
        ...(checked.brief ? { brief: checked.brief } : {})
      };
    });
  }

  return {
    ticketRoute,
    fromIntegration,
    syncTarget,
    requireTicket,
    inspectDirectory,
    lastIntegration,
    ticketChangedPaths,
    integrateTicket,
    integrateTicketInBackground,
    ticketForDispatch,
    ticketStarted,
    startTicket
  };
}
