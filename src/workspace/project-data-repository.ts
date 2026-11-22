import { ProjectBoardRepository } from "./project-board.js";
import { ProjectDeliveryRepository } from "./project-delivery.js";
import { ProjectMainSessionRepository } from "./project-main-session.js";

import type { SqlTransaction } from "../storage/project-data/database.js";
import { ProjectLedgerRepository } from "./project-ledger-repository.js";
import { LedgerMaintenanceRepository } from "./ledger-maintenance-repository.js";
import { DevelopmentRepository } from "./development-repository.js";
import { DevelopmentReviewRepository } from "./development-review-repository.js";
import { DevelopmentMergeRepository } from "./development-merge-repository.js";
/** Transaction-scoped project data. Every repository shares the same SQL connection and locks. */
export class ProjectDataRepository extends ProjectLedgerRepository {
  constructor(transaction: SqlTransaction, lockRows = false) {
    super(transaction, lockRows);
  }

  private readonly maintenance = new LedgerMaintenanceRepository(this.transaction, {
    requireProject: this.requireProject.bind(this),
    requireRequirement: this.requireRequirement.bind(this),
    aliases: this.aliases.bind(this),
    insertAlias: this.insertAlias.bind(this),
    insertHistory: this.insertHistory.bind(this),
    insertRevision: this.insertRevision.bind(this),
    requirement: this.requirement.bind(this),
    nextLedgerTime: this.nextLedgerTime.bind(this)
  });
  private readonly developments = new DevelopmentRepository(this.transaction, this.lockRows, {
    requireProject: this.requireProject.bind(this),
    requireRequirement: this.requireRequirement.bind(this),
    lookupEntries: this.maintenance.lookupEntries.bind(this.maintenance),
    insertAlias: this.insertAlias.bind(this)
  });
  private readonly reviews = new DevelopmentReviewRepository(
    this.transaction,
    this.lockRows,
    this.requireProject.bind(this),
    this.developments
  );
  private readonly merges = new DevelopmentMergeRepository(
    this.transaction,
    this.lockRows,
    this.requireProject.bind(this),
    this.developments
  );

  // Bind the domain operations to this transaction while retaining the repository API.
  lookup = this.maintenance.lookup.bind(this.maintenance);
  mergedSinceTidy = this.maintenance.mergedSinceTidy.bind(this.maintenance);
  tidy = this.maintenance.tidy.bind(this.maintenance);
  finishTidy = this.maintenance.finishTidy.bind(this.maintenance);
  mergeRequirements = this.maintenance.mergeRequirements.bind(this.maintenance);

  createDevelopment = this.developments.createDevelopment.bind(this.developments);
  updateDevelopment = this.developments.updateDevelopment.bind(this.developments);
  getDevelopment = this.developments.getDevelopment.bind(this.developments);
  queryDevelopments = this.developments.queryDevelopments.bind(this.developments);
  findDevelopmentByRequirement = this.developments.findDevelopmentByRequirement.bind(this.developments);
  recordDevelopmentWorkspace = this.developments.recordDevelopmentWorkspace.bind(this.developments);
  tickets = this.developments.tickets.bind(this.developments);
  writeTickets = this.developments.writeTickets.bind(this.developments);

  reviewPlan = this.reviews.reviewPlan.bind(this.reviews);
  setReviewPlan = this.reviews.setReviewPlan.bind(this.reviews);
  createReview = this.reviews.createReview.bind(this.reviews);
  getReview = this.reviews.getReview.bind(this.reviews);
  queryReviews = this.reviews.queryReviews.bind(this.reviews);
  updateReview = this.reviews.updateReview.bind(this.reviews);

  mergeConfig = this.merges.mergeConfig.bind(this.merges);
  setMergeConfig = this.merges.setMergeConfig.bind(this.merges);
  createMerge = this.merges.createMerge.bind(this.merges);
  getMerge = this.merges.getMerge.bind(this.merges);
  queryMerges = this.merges.queryMerges.bind(this.merges);
  claimMerge = this.merges.claimMerge.bind(this.merges);
  updateMerge = this.merges.updateMerge.bind(this.merges);

  /** Main session updates and their ledger references commit together. */
  sessions(): ProjectMainSessionRepository {
    return new ProjectMainSessionRepository(this.transaction, {
      requireProject: async (projectId) => {
        await this.requireProject(projectId);
      },
      requireRequirement: (projectId, requirementId) => this.requireRequirement(projectId, requirementId),
      insertReferences: (projectId, requirementId, references) =>
        this.insertReferences(projectId, requirementId, references)
    });
  }

  /** Board writes share this transaction, so a published entry commits with its requirement. */
  board(): ProjectBoardRepository {
    return new ProjectBoardRepository(this.transaction, this, this.lockRows);
  }

  /** Delivery rows use this same transaction, so the ledger, board and receipt commit together. */
  delivery(): ProjectDeliveryRepository {
    return new ProjectDeliveryRepository(this.transaction, this, this.lockRows);
  }
}
