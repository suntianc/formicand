import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DevelopmentStatus } from "../domain/project-development.js";
import type {
  RequirementAlias,
  RequirementHistoryEntry,
  RequirementKind,
  RequirementStatus
} from "../domain/project-ledger.js";
import { git } from "../workspace/development-workspace.js";
import type { ProjectDataGateway } from "../workspace/project-data-service.js";

/**
 * Everything Main reads about one feature before it clarifies or designs a
 * change: how the feature behaves now, what recent developments changed, the
 * architecture decisions the ledger names and where the code usually moves.
 */
export interface RequirementContext {
  requirement: {
    requirementId: string;
    kind: RequirementKind;
    status: RequirementStatus;
    title: string;
    revision: number;
    summary: string;
    aliases: RequirementAlias[];
  };
  /** The latest lines, oldest first. */
  history: RequirementHistoryEntry[];
  historyTotal: number;
  /** Newest first. */
  developments: ContextDevelopment[];
  /**
   * Architecture decisions the summary or history names, and whether each file
   * is still in the local checkout; without one, presence is unknown.
   */
  decisions: Array<{ path: string; present?: boolean }>;
  /** The directories merged developments changed most; absent when no local checkout can tell. */
  directories?: Array<{ directory: string; files: number }>;
}

export interface ContextDevelopment {
  developmentId: string;
  status: DevelopmentStatus;
  goal: string;
  completionCriteria: string[];
  createdAt: string;
  merged?: { commit: string; at: string };
}

const HISTORY_LINES = 10;
const GOAL_LENGTH = 500;
const DIRECTORIES = 5;
const DECISION = /docs\/adr\/[\p{L}\p{N}._/-]+/gu;

function shortGoal(goal: string): string {
  const characters = [...goal];
  return characters.length <= GOAL_LENGTH
    ? goal
    : `${characters.slice(0, GOAL_LENGTH).join("")}…（共 ${characters.length} 字，全文用 project_development get）`;
}

/** Paths under docs/adr/ the text names; a trailing full stop is punctuation, not part of the name. */
function decisionPaths(texts: string[]): string[] {
  const paths = new Set<string>();
  for (const text of texts)
    for (const [match] of text.matchAll(DECISION)) {
      const path = match.replace(/[.]+$/, "");
      if (!path.split("/").includes("..")) paths.add(path);
    }
  return [...paths];
}

/** An architecture decision whose file is gone is stale; a failed stat means it is not there. */
async function present(directory: string, path: string): Promise<boolean> {
  return stat(join(directory, path)).then(
    (info) => info.isFile(),
    () => false
  );
}

/** Files a merged development changed, from its baseline to the candidate that merged. */
async function changedFiles(directory: string, from: string, to: string): Promise<string[]> {
  const range = `${from}..${to}`;
  const output = await git(directory, ["diff", "--name-only", "--no-renames", range]).catch(
    // eslint-disable-next-line no-restricted-syntax -- 本机检出可能没有这次开发的提交（另一台机器合入、仓库被重建），读不到就不计这次，代码位置只是提示
    () => ""
  );
  return output ? output.split("\n") : [];
}

export async function requirementContext(
  service: ProjectDataGateway,
  projectId: string,
  projectDirectory: string,
  requirementId: string
): Promise<RequirementContext> {
  const requirement = await service.getRequirement(projectId, requirementId);
  const developments = (await service.queryDevelopments(projectId))
    .filter((development) => development.requirementId === requirementId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const deliveries = new Map(
    (await service.queryDeliveries(projectId))
      .filter((delivery) => delivery.requirementId === requirementId)
      .map((delivery) => [delivery.developmentId, delivery])
  );
  const history = requirement.history.slice(-HISTORY_LINES);
  const paths = decisionPaths([requirement.summary, ...requirement.history.map((entry) => entry.text)]);

  let directories: RequirementContext["directories"];
  if (projectDirectory) {
    const counts = new Map<string, number>();
    for (const development of developments) {
      const delivery = deliveries.get(development.developmentId);
      if (!delivery) continue;
      for (const file of await changedFiles(
        projectDirectory,
        development.baseline.commit,
        delivery.candidateCommit
      )) {
        const cut = file.lastIndexOf("/");
        const directory = cut < 0 ? "." : file.slice(0, cut);
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
      }
    }
    directories = [...counts]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, DIRECTORIES)
      .map(([directory, files]) => ({ directory, files }));
  }

  return {
    requirement: {
      requirementId: requirement.requirementId,
      kind: requirement.kind,
      status: requirement.status,
      title: requirement.title,
      revision: requirement.revision,
      summary: requirement.summary,
      aliases: requirement.aliases
    },
    history,
    historyTotal: requirement.history.length,
    developments: developments.map((development) => {
      const delivery = deliveries.get(development.developmentId);
      return {
        developmentId: development.developmentId,
        status: development.status,
        goal: shortGoal(development.goal),
        completionCriteria: development.completionCriteria,
        createdAt: development.createdAt,
        ...(delivery ? { merged: { commit: delivery.mergedCommit, at: delivery.mergedAt } } : {})
      };
    }),
    decisions: await Promise.all(
      paths.map(async (path) =>
        projectDirectory ? { path, present: await present(projectDirectory, path) } : { path }
      )
    ),
    ...(directories ? { directories } : {})
  };
}
