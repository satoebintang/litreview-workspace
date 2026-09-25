import { sql } from "drizzle-orm";
import { derivePaperReviewStatus } from "@/domain/paper-review";
import type { FullTextRetrievalState, PaperReviewStatus, ScreeningDecisionValue } from "@/domain/types";

export type PaperReviewFactsRow = {
  title_abstract_decision: unknown;
  full_text_decision: unknown;
  full_text_retrieval_state: unknown;
  has_retrieval_history: unknown;
  ever_retrieved: unknown;
  has_analytical_history: unknown;
};

function decisionValue(value: unknown): ScreeningDecisionValue | null {
  return value === "include" || value === "exclude" || value === "maybe" ? value : null;
}

/** Translate shared SQL review facts into the canonical domain review status. */
export function paperReviewStatusFromFacts(row: PaperReviewFactsRow): PaperReviewStatus {
  const retrievalState = row.full_text_retrieval_state;
  const fullTextRetrievalState: FullTextRetrievalState = retrievalState === "pending" || retrievalState === "unavailable" || retrievalState === "retrieved"
    ? retrievalState
    : "not_sought";
  return derivePaperReviewStatus({
    titleAbstractDecision: decisionValue(row.title_abstract_decision),
    fullTextDecision: decisionValue(row.full_text_decision),
    fullTextRetrievalState,
    everRetrieved: Boolean(row.ever_retrieved),
    hasFullTextRetrievalAttempts: Boolean(row.has_retrieval_history),
    hasAnalyticalHistory: Boolean(row.has_analytical_history),
  });
}

/**
 * Shared SQL facts used by read models that need canonical Paper review state.
 * Keep queue predicates and their aliases in the consuming query; this CTE is
 * the single set-based projection of the underlying decision/history rows.
 */
export function paperReviewFactsCtes(projectId: string) {
  return sql`
    with latest_title_abstract as (
      select distinct on (project_id, paper_id) project_id, paper_id, decision
      from screening_decisions
      where project_id=${projectId}::uuid and stage='title_abstract'
      order by project_id, paper_id, sequence desc, id desc
    ), latest_full_text as (
      select distinct on (project_id, paper_id) project_id, paper_id, decision
      from full_text_screening_decisions
      where project_id=${projectId}::uuid
      order by project_id, paper_id, sequence desc, id desc
    ), retrieval_facts as (
      select project_id, paper_id,
        (array_agg(outcome order by sequence desc, id desc))[1] as current_retrieval_outcome,
        true as has_retrieval_history,
        bool_or(outcome='retrieved') as ever_retrieved
      from full_text_retrieval_attempts
      where project_id=${projectId}::uuid
      group by project_id, paper_id
    ), analytical_history as (
      select distinct project_id, paper_id
      from extraction_value_revisions
      where project_id=${projectId}::uuid and finalized_at is not null
    ), review_facts as (
      select p.project_id, p.id as paper_id, p.created_at,
        ta.decision as title_abstract_decision,
        ft.decision as full_text_decision,
        rf.current_retrieval_outcome as current_retrieval_outcome,
        coalesce(rf.current_retrieval_outcome, 'not_sought') as full_text_retrieval_state,
        coalesce(rf.has_retrieval_history, false) as has_retrieval_history,
        coalesce(rf.ever_retrieved, false) as ever_retrieved,
        (ah.paper_id is not null) as has_analytical_history
      from papers p
      left join latest_title_abstract ta on ta.project_id=p.project_id and ta.paper_id=p.id
      left join latest_full_text ft on ft.project_id=p.project_id and ft.paper_id=p.id
      left join retrieval_facts rf on rf.project_id=p.project_id and rf.paper_id=p.id
      left join analytical_history ah on ah.project_id=p.project_id and ah.paper_id=p.id
      where p.project_id=${projectId}::uuid
    )
  `;
}
