import { DomainError } from "@/domain/errors";
import type { ReviewReportMetricKey } from "@/domain/review-report";

const metricColumnByKey = {
  distinctSearchRuns: "distinct_search_runs",
  reportedResultsTotal: "reported_results_total",
  retrievedRecords: "retrieved_records",
  distinctSources: "distinct_sources",
  currentlyResolvedRecords: "currently_resolved_records",
  unresolvedRecords: "unresolved_records",
  unresolvedDuplicatePairs: "unresolved_duplicate_pairs",
  sameWorkDecisionPairs: "same_work_decision_pairs",
  differentWorkDecisionPairs: "different_work_decision_pairs",
  acquisitionDerivedPapers: "acquisition_derived_papers",
  duplicateRecordsCollapsed: "duplicate_records_collapsed",
  papersInScreeningPopulation: "papers_in_screening_population",
  unscreened: "unscreened",
  included: "included",
  excluded: "excluded",
  maybe: "maybe",
  fullTextEligible: "full_text_eligible",
  fullTextRetrievalEligible: "full_text_retrieval_eligible",
  fullTextAwaiting: "full_text_awaiting",
  fullTextAssessed: "full_text_assessed",
  fullTextIncluded: "full_text_included",
  fullTextExcluded: "full_text_excluded",
  fullTextMaybe: "full_text_maybe",
  fullTextConflicts: "full_text_conflicts",
  finallyIncluded: "finally_included",
  legacyAnalysisAwaitingFullText: "legacy_analysis_awaiting_full_text",
  fullTextNotSought: "full_text_not_sought",
  fullTextRetrievalPending: "full_text_retrieval_pending",
  fullTextRetrieved: "full_text_retrieved",
  fullTextUnavailable: "full_text_unavailable",
  fullTextSought: "full_text_sought",
  fullTextEverSought: "full_text_ever_sought",
  fullTextEverRetrieved: "full_text_ever_retrieved",
  legacyFullTextWithoutRetrieval: "legacy_full_text_without_retrieval",
  fullTextRetrievalConflicts: "full_text_retrieval_conflicts",
  historicalAcquisitionOnlyPapers: "historical_acquisition_only_papers",
  manualPapers: "manual_papers",
} as const satisfies Record<ReviewReportMetricKey, string>;

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function safeDatabaseInteger(value: unknown, label: string): number {
  let exact: bigint;
  if (typeof value === "bigint") exact = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("DATABASE_CONSTRAINT", `${label} is outside the safe integer range`);
    return value;
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) exact = BigInt(value);
  else if (value == null) return 0;
  else throw new DomainError("DATABASE_CONSTRAINT", `${label} is not an exact non-negative integer`);
  if (exact < BigInt(0) || exact > MAX_SAFE_INTEGER_BIGINT) throw new DomainError("DATABASE_CONSTRAINT", `${label} is outside the safe integer range`);
  return Number(exact);
}

/** Maps the canonical PostgreSQL Review Flow row into the released numeric DTO. */
export function mapReviewFlowSummaryRow(row: Record<string, unknown> | null | undefined): Record<ReviewReportMetricKey, number> {
  const mapped = {} as Record<ReviewReportMetricKey, number>;
  for (const key of Object.keys(metricColumnByKey) as ReviewReportMetricKey[]) {
    const column = metricColumnByKey[key];
    mapped[key] = safeDatabaseInteger(row?.[column], `Review Flow metric ${key}`);
  }
  return mapped;
}
