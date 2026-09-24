import type { Database } from "@/db/client";
import { derivePaperReviewStatus, isFinallyIncluded } from "@/domain/paper-review";
import type { PaperReviewStatus, ScreeningDecisionValue } from "@/domain/types";
import { DomainError } from "@/domain/errors";
import type { PaperRepository, PaperReviewRepository } from "../repositories";
import type { ReviewTransaction } from "./shared";

export function createPaperReviewHelpers(
  db: Database,
  paperRepo: Pick<PaperRepository, "findForUpdate">,
  paperReviewRepo: Pick<PaperReviewRepository, "find" | "list">,
) {
  function rowDecision(row: Record<string, unknown> | null | undefined, key: string): ScreeningDecisionValue | null {
    const value = row?.[key];
    return value === "include" || value === "exclude" || value === "maybe" ? value : null;
  }

  function statusFromRow(row: Record<string, unknown> | null | undefined): PaperReviewStatus {
    const retrievalState = row?.full_text_retrieval_state;
    return derivePaperReviewStatus({
      titleAbstractDecision: rowDecision(row, "title_abstract_decision"),
      fullTextDecision: rowDecision(row, "full_text_decision"),
      fullTextRetrievalState: retrievalState === "pending" || retrievalState === "unavailable" || retrievalState === "retrieved" ? retrievalState : "not_sought",
      everRetrieved: Boolean(row?.ever_retrieved),
      hasFullTextRetrievalAttempts: Boolean(row?.has_full_text_retrieval_attempts),
      hasAnalyticalHistory: Boolean(row?.has_analytical_history),
    });
  }

  async function requireFinallyIncludedPaperLocked(tx: ReviewTransaction, projectId: string, paperId: string) {
    const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
    if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    const status = statusFromRow(await paperReviewRepo.find(projectId, paperId, tx) as Record<string, unknown>);
    if (!isFinallyIncluded(status)) throw new DomainError("VALIDATION_ERROR", "New analytical work is available only for finally included papers");
    return { paper, status };
  }

  async function getPaperReviewStatusFor(projectId: string, paperId: string, tx: ReviewTransaction | Database = db) {
    const row = await paperReviewRepo.find(projectId, paperId, tx);
    if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    return statusFromRow(row as unknown as Record<string, unknown>);
  }

  async function listPaperReviewStatusesFor(projectId: string, tx: ReviewTransaction | Database = db) {
    const rows = await paperReviewRepo.list(projectId, tx);
    return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({ paperId: String(row.paper_id), status: statusFromRow(row) }));
  }

  return { rowDecision, statusFromRow, requireFinallyIncludedPaperLocked, getPaperReviewStatusFor, listPaperReviewStatusesFor };
}
