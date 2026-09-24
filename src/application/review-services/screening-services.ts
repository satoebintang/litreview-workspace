import type { Database } from "@/db/client";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  createFullTextScreeningCriterionSchema,
  createScreeningCriterionSchema,
  recordFullTextRetrievalAttemptSchema,
  recordFullTextScreeningDecisionSchema,
  recordScreeningDecisionSchema,
  type CreateFullTextScreeningCriterionInput,
  type CreateScreeningCriterionInput,
  type RecordFullTextRetrievalAttemptInput,
  type RecordFullTextScreeningDecisionInput,
  type RecordScreeningDecisionInput,
} from "@/domain/validation";
import type {
  FullTextRetrievalAttemptRepository,
  FullTextScreeningCriterionRepository,
  FullTextScreeningDecisionRepository,
  PaperRepository,
  PaperReviewRepository,
  ScreeningCriterionRepository,
  ScreeningDecisionRepository,
} from "../repositories";
import { createPaperReviewHelpers } from "./paper-review-helpers";
import { ensureId, validate } from "./shared";

export function createScreeningServices<TProject, TPaper, TCriterion extends { archivedAt: Date | null }>(deps: {
  db: Database;
  criterionRepo: ScreeningCriterionRepository;
  decisionRepo: ScreeningDecisionRepository;
  paperRepo: PaperRepository;
  paperReviewRepo: PaperReviewRepository;
  fullTextCriterionRepo: FullTextScreeningCriterionRepository;
  fullTextDecisionRepo: FullTextScreeningDecisionRepository;
  fullTextRetrievalRepo: FullTextRetrievalAttemptRepository;
  requireProject: (projectId: string) => Promise<TProject>;
  requirePaper: (projectId: string, paperId: string) => Promise<TPaper>;
  requireCriterion: (projectId: string, criterionId: string) => Promise<TCriterion>;
}) {
  const { db, criterionRepo, decisionRepo, paperRepo, paperReviewRepo, fullTextCriterionRepo, fullTextDecisionRepo, fullTextRetrievalRepo, requireProject, requirePaper, requireCriterion } = deps;
  const { getPaperReviewStatusFor, listPaperReviewStatusesFor } = createPaperReviewHelpers(db, paperRepo, paperReviewRepo);
  return {
    async listScreeningCriteria(projectId: string, includeArchived = false) {
      await requireProject(projectId);
      return criterionRepo.list(projectId, includeArchived);
    },

    async createScreeningCriterion(projectId: string, input: CreateScreeningCriterionInput) {
      await requireProject(projectId);
      const values = validate(createScreeningCriterionSchema, input);
      return criterionRepo.create({ projectId, type: values.type, text: values.text });
    },

    async archiveScreeningCriterion(projectId: string, criterionId: string) {
      const criterion = await requireCriterion(projectId, criterionId);
      if (criterion.archivedAt) return criterion;
      const archived = await criterionRepo.archive(projectId, criterionId);
      if (archived.length === 0) throw new DomainError("NOT_FOUND", "Criterion was not found");
      return archived[0];
    },

    async getPaperScreening(projectId: string, paperId: string) {
      const paper = await requirePaper(projectId, paperId);
      const [criteria, currentDecision, decisions] = await Promise.all([
        criterionRepo.list(projectId), decisionRepo.currentForPaper(projectId, paperId), decisionRepo.listForPaper(projectId, paperId),
      ]);
      const history = await Promise.all(decisions.map(async (decision) => ({
        ...decision,
        exclusionCriterion: decision.exclusionCriterionId ? await criterionRepo.findById(projectId, decision.exclusionCriterionId) : null,
      })));
      return {
        paper,
        criteria,
        currentState: currentDecision ? ({ include: "included", exclude: "excluded", maybe: "maybe" }[currentDecision.decision]) : "unscreened" as const,
        currentDecision,
        history,
        reviewStatus: await getPaperReviewStatusFor(projectId, paperId),
      };
    },

    async listScreeningPapers(projectId: string, state?: "unscreened" | "included" | "excluded" | "maybe") {
      await requireProject(projectId);
      const papersWithState = await decisionRepo.listPapersWithCurrentState(projectId);
      return state ? papersWithState.filter((paper) => paper.screeningState === state) : papersWithState;
    },

    async recordScreeningDecision(projectId: string, paperId: string, input: RecordScreeningDecisionInput) {
      await requireProject(projectId);
      const values = validate(recordScreeningDecisionSchema, input);
      return db.transaction(async (tx) => {
        const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
        if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        let exclusionCriterionId: string | null = null;
        let exclusionCriterionType: "exclusion" | null = null;
        if (values.decision === "exclude") {
          const criterion = await criterionRepo.findById(projectId, values.exclusionCriterionId, tx);
          if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Criterion does not belong to this project");
          if (criterion.type !== "exclusion") throw new DomainError("VALIDATION_ERROR", "Exclude decisions require an exclusion criterion");
          if (criterion.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived criteria cannot be used for new decisions");
          exclusionCriterionId = criterion.id;
          exclusionCriterionType = "exclusion";
        }
        try {
          return await decisionRepo.create({
            projectId, paperId, stage: "title_abstract", decision: values.decision,
            exclusionCriterionId, exclusionCriterionType, note: values.note ?? null,
          }, tx);
        } catch (error) {
          if (isConstraintError(error)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Screening references an invalid project record");
          throw error;
        }
      });
    },

    async listFullTextScreeningCriteria(projectId: string, includeArchived = false) {
      await requireProject(projectId);
      return fullTextCriterionRepo.list(projectId, includeArchived);
    },

    async createFullTextScreeningCriterion(projectId: string, input: CreateFullTextScreeningCriterionInput) {
      await requireProject(projectId);
      const values = validate(createFullTextScreeningCriterionSchema, input);
      return fullTextCriterionRepo.create({ projectId, text: values.text });
    },

    async archiveFullTextScreeningCriterion(projectId: string, criterionId: string) {
      await requireProject(projectId);
      ensureId(criterionId);
      const criterion = await fullTextCriterionRepo.findById(projectId, criterionId);
      if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text criterion does not belong to this project");
      if (criterion.archivedAt) return criterion;
      const archived = await fullTextCriterionRepo.archive(projectId, criterionId);
      return archived[0] ?? criterion;
    },

    async getPaperReviewStatus(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      return getPaperReviewStatusFor(projectId, paperId);
    },

    async listPaperReviewStatuses(projectId: string) {
      await requireProject(projectId);
      return listPaperReviewStatusesFor(projectId);
    },

    async getPaperFullTextRetrieval(projectId: string, paperId: string) {
      const paper = await requirePaper(projectId, paperId);
      const [currentAttempt, history, reviewStatus] = await Promise.all([
        fullTextRetrievalRepo.currentForPaper(projectId, paperId),
        fullTextRetrievalRepo.listForPaper(projectId, paperId),
        getPaperReviewStatusFor(projectId, paperId),
      ]);
      return { paper, currentState: reviewStatus.fullTextRetrievalState, everRetrieved: reviewStatus.everRetrieved, currentAttempt, history, reviewStatus };
    },

    async listFullTextRetrievalHistory(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      return fullTextRetrievalRepo.listForPaper(projectId, paperId);
    },

    async listFullTextRetrievalQueue(projectId: string, state?: "not_sought" | "pending" | "unavailable" | "retrieved" | "conflict") {
      await requireProject(projectId);
      const [papers, statuses] = await Promise.all([paperRepo.list(projectId), listPaperReviewStatusesFor(projectId)]);
      const statusByPaperId = new Map(statuses.map((item) => [item.paperId, item.status]));
      return papers.map((paper) => ({ paper, reviewStatus: statusByPaperId.get(paper.id)! })).filter(({ reviewStatus }) => {
        if (state === "conflict") return reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion");
        if (reviewStatus.titleAbstractState !== "included") return false;
        return state ? reviewStatus.fullTextRetrievalState === state : true;
      });
    },

    async recordFullTextRetrievalAttempt(projectId: string, paperId: string, input: RecordFullTextRetrievalAttemptInput) {
      await requireProject(projectId);
      const values = validate(recordFullTextRetrievalAttemptSchema, input);
      return db.transaction(async (tx) => {
        const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
        if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        const currentTa = await decisionRepo.currentForPaper(projectId, paperId, tx);
        if (!currentTa || currentTa.decision !== "include") throw new DomainError("VALIDATION_ERROR", "Full-text retrieval requires a current title/abstract include decision");
        try {
          return await fullTextRetrievalRepo.create({
            projectId,
            paperId,
            outcome: values.outcome,
            method: values.method ?? null,
            sourceReference: values.sourceReference ?? null,
            note: values.note ?? null,
            attemptedAt: values.attemptedAt,
          }, tx);
        } catch (error) {
          if (isConstraintError(error)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text retrieval references an invalid project record");
          throw error;
        }
      });
    },

    async getPaperFullTextScreening(projectId: string, paperId: string) {
      const paper = await requirePaper(projectId, paperId);
      const [criteria, currentDecision, decisions, reviewStatus, retrievalCurrent, retrievalHistory] = await Promise.all([
        fullTextCriterionRepo.list(projectId), fullTextDecisionRepo.currentForPaper(projectId, paperId), fullTextDecisionRepo.listForPaper(projectId, paperId), getPaperReviewStatusFor(projectId, paperId), fullTextRetrievalRepo.currentForPaper(projectId, paperId), fullTextRetrievalRepo.listForPaper(projectId, paperId),
      ]);
      const history = await Promise.all(decisions.map(async (decision) => ({
        ...decision,
        exclusionCriterion: decision.exclusionCriterionId ? await fullTextCriterionRepo.findById(projectId, decision.exclusionCriterionId) : null,
      })));
      return { paper, criteria, currentState: reviewStatus.fullTextState, currentDecision, history, reviewStatus, retrievalCurrent, retrievalHistory };
    },

    async listFullTextScreeningQueue(projectId: string, state?: "awaiting" | "included" | "excluded" | "maybe" | "conflict") {
      await requireProject(projectId);
      const [papers, statuses] = await Promise.all([paperRepo.list(projectId), listPaperReviewStatusesFor(projectId)]);
      const statusByPaperId = new Map(statuses.map((item) => [item.paperId, item.status]));
      const queue = papers.map((paper) => ({ paper, reviewStatus: statusByPaperId.get(paper.id)! })).filter((item) => {
        const { reviewStatus } = item;
        const retrievalHistoryConflict = reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion");
        if (state === "conflict") return reviewStatus.crossStageConflict || retrievalHistoryConflict;
        if (state === "awaiting") return reviewStatus.finalEligibility === "pending_full_text";
        if (state === "included") return reviewStatus.finalEligibility === "included";
        if (state === "excluded") return reviewStatus.finalEligibility === "excluded";
        if (state === "maybe") return reviewStatus.finalEligibility === "unresolved_full_text";
        return reviewStatus.titleAbstractState === "included" || reviewStatus.crossStageConflict || retrievalHistoryConflict;
      });
      return queue;
    },

    async recordFullTextScreeningDecision(projectId: string, paperId: string, input: RecordFullTextScreeningDecisionInput) {
      await requireProject(projectId);
      const values = validate(recordFullTextScreeningDecisionSchema, input);
      return db.transaction(async (tx) => {
        const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
        if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        const currentTa = await decisionRepo.currentForPaper(projectId, paperId, tx);
        if (!currentTa || currentTa.decision !== "include") throw new DomainError("VALIDATION_ERROR", "Full-text screening requires a current title/abstract include decision");
        const currentRetrieval = await fullTextRetrievalRepo.currentForPaper(projectId, paperId, tx);
        if (!currentRetrieval || currentRetrieval.outcome !== "retrieved") throw new DomainError("VALIDATION_ERROR", "Full-text screening requires a current retrieved full-text retrieval attempt");
        let exclusionCriterionId: string | null = null;
        if (values.decision === "exclude") {
          const criterion = await fullTextCriterionRepo.findById(projectId, values.exclusionCriterionId, tx);
          if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text criterion does not belong to this project");
          if (criterion.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived full-text criteria cannot be used for new decisions");
          exclusionCriterionId = criterion.id;
        }
        try {
          return await fullTextDecisionRepo.create({ projectId, paperId, decision: values.decision, exclusionCriterionId, note: values.note ?? null }, tx);
        } catch (error) {
          if (isConstraintError(error)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text screening references an invalid project record");
          throw error;
        }
      });
    },
  };
}
