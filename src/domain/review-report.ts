import type { FullTextScreeningCriterion, Paper, ResearchQuestion, ScreeningCriterion, SearchRun, SearchSource } from "./types";

export type ReportMetricSupport = "supported" | "partially_supported" | "unsupported";

export const REVIEW_REPORT_METRIC_KEYS = [
  "distinctSearchRuns", "reportedResultsTotal", "retrievedRecords", "distinctSources",
  "currentlyResolvedRecords", "unresolvedRecords", "unresolvedDuplicatePairs",
  "sameWorkDecisionPairs", "differentWorkDecisionPairs", "acquisitionDerivedPapers",
  "duplicateRecordsCollapsed", "papersInScreeningPopulation", "unscreened", "included",
  "excluded", "maybe", "fullTextEligible", "fullTextAwaiting", "fullTextAssessed",
  "fullTextIncluded", "fullTextExcluded", "fullTextMaybe", "fullTextConflicts",
  "fullTextRetrievalEligible", "fullTextNotSought", "fullTextRetrievalPending",
  "fullTextRetrieved", "fullTextUnavailable", "fullTextSought", "fullTextEverSought",
  "fullTextEverRetrieved", "legacyFullTextWithoutRetrieval", "fullTextRetrievalConflicts",
  "finallyIncluded", "legacyAnalysisAwaitingFullText", "historicalAcquisitionOnlyPapers",
  "manualPapers",
] as const;

export type ReviewReportMetricKey = (typeof REVIEW_REPORT_METRIC_KEYS)[number];

export type ReviewReportSupportKey =
  | "records_identified_from_recorded_searches"
  | "records_screened"
  | "duplicates_removed"
  | "reports_sought_or_retrieved"
  | "reports_sought"
  | "reports_retrieved"
  | "reports_not_retrieved"
  | "reports_assessed_for_eligibility"
  | "reports_excluded_full_text"
  | "studies_included_final"
  | "automation_exclusions"
  | "source_category_taxonomy";

export type ReviewReportLimitationCode =
  | "full_text_stage_not_modeled"
  | "reports_sought_retrieved_not_modeled"
  | "retrieval_pending_or_unavailable"
  | "legacy_full_text_decisions_without_retrieval"
  | "retrieval_history_conflicts"
  | "automation_exclusion_stage_not_modeled"
  | "source_category_mapping_unavailable"
  | "formal_prisma_compliance_not_claimed"
  | "reported_results_exceed_entered_records"
  | "screening_incomplete_unscreened"
  | "screening_incomplete_maybe"
  | "unresolved_duplicate_candidates"
  | "records_without_current_paper_match"
  | "manual_papers_present"
  | "historical_acquisition_only_papers_present"
  | "cross_source_paper_overlap";

export type ReviewReportContributorSelector =
  | { scope: "metric"; metric: ReviewReportMetricKey }
  | { scope: "source"; sourceId: string; metric: "runs" | "reportedResults" | "retrievedRecords" | "resolvedRecords" | "acquisitionPapers" }
  | { scope: "exclusionReason"; criterionId: string }
  | { scope: "fullTextExclusionReason"; criterionId: string }
  | { scope: "overlap" };

export type ReviewReportContributor =
  | { kind: "searchRun"; id: string; label: string; contribution: number; sourceId: string }
  | { kind: "retrievedRecord"; id: string; label: string; contribution: number; searchRunId: string; sourceId: string }
  | { kind: "paper"; id: string; label: string; contribution: number; recordCount?: number; sourceIds?: string[] }
  | { kind: "deduplicationPair"; id: string; label: string; contribution: number; leftRecordId: string; rightRecordId: string }
  | { kind: "screeningDecision"; id: string; label: string; contribution: number; paperId: string; decision: string }
  | { kind: "fullTextScreeningDecision"; id: string; label: string; contribution: number; paperId: string; decision: string }
  | { kind: "searchSource"; id: string; label: string; contribution: number };

export type ReviewReportMetric =
  | { key: ReviewReportMetricKey; label: string; value: number; support: "supported" | "partially_supported"; explanation: string; contributor: ReviewReportContributorSelector }
  | { key: ReviewReportMetricKey; label: string; value: null; support: "unsupported"; explanation: string; contributor: null };

export type ReviewReportLimitation = {
  code: ReviewReportLimitationCode;
  kind: "model_capability" | "current_data";
  message: string;
};

export type ReviewReportSupportMapping = {
  key: ReviewReportSupportKey;
  label: string;
  support: ReportMetricSupport;
  explanation: string;
};

export type ReviewReportRun = SearchRun & {
  enteredRecordCount: number;
};

export type ReviewReportSource = {
  source: SearchSource;
  observedSnapshots: Array<{ sourceKey: string; displayName: string }>;
  historicalSnapshotCount: number;
  runCount: number;
  reportedResults: number;
  retrievedRecords: number;
  currentlyResolvedRecords: number;
  acquisitionDerivedPapers: number;
};

export type ReviewReportProjection = {
  project: { id: string; title: string };
  activeResearchQuestions: ResearchQuestion[];
  activeCriteria: ScreeningCriterion[];
  activeFullTextCriteria: FullTextScreeningCriterion[];
  identification: {
    metrics: ReviewReportMetric[];
    bySource: ReviewReportSource[];
    runs: ReviewReportRun[];
    overlappingPaperCount: number;
  };
  deduplication: { metrics: ReviewReportMetric[] };
  screening: {
    metrics: ReviewReportMetric[];
    exclusionReasons: Array<{ criterionId: string; text: string; archived: boolean; count: number; contributor: ReviewReportContributorSelector }>;
  };
  fullTextEligibility: {
    metrics: ReviewReportMetric[];
    exclusionReasons: Array<{ criterionId: string; text: string; archived: boolean; count: number; contributor: ReviewReportContributorSelector }>;
  };
  fullTextRetrieval: { metrics: ReviewReportMetric[] };
  finalEligibility: { metrics: ReviewReportMetric[] };
  supportMatrix: ReviewReportSupportMapping[];
  limitations: ReviewReportLimitation[];
};

export type ReviewReportContext = {
  project: { id: string; title: string };
  activeResearchQuestions: ResearchQuestion[];
  activeCriteria: ScreeningCriterion[];
  activeFullTextCriteria: FullTextScreeningCriterion[];
  sources: ReviewReportSource[];
  runs: ReviewReportRun[];
  overlappingPaperCount: number;
};

export type ReviewReportContributorResult = {
  total: number;
  items: ReviewReportContributor[];
};

export type ReviewReportInputs = {
  summary: Record<string, unknown>;
  context: ReviewReportContext;
  exclusionReasons: Array<{ criterionId: string; text: string; archived: boolean; count: number }>;
  fullTextExclusionReasons: Array<{ criterionId: string; text: string; archived: boolean; count: number }>;
};

export type ReviewReportPaper = Pick<Paper, "id" | "title">;

export type ReviewReportContextKind =
  | "questions"
  | "screening-criteria"
  | "full-text-criteria"
  | "sources"
  | "exclusion-reasons"
  | "full-text-exclusion-reasons";

export type ReviewReportReasonAggregate = {
  criterionId: string;
  text: string;
  textTruncated: boolean;
  archived: boolean;
  count: number;
  contributor: ReviewReportContributorSelector;
};

export type ReviewReportContextPageItem =
  | { kind: "question"; id: string; identifier: string; identifierTruncated: boolean; label: string; labelTruncated: boolean }
  | { kind: "screeningCriterion"; id: string; criterionType: "inclusion" | "exclusion"; text: string; textTruncated: boolean }
  | { kind: "fullTextCriterion"; id: string; text: string; textTruncated: boolean }
  | { kind: "searchSource"; id: string; sourceKey: string; sourceKeyTruncated: boolean; displayName: string; displayNameTruncated: boolean; archived: boolean }
  | { kind: "exclusionReason"; criterionId: string; text: string; textTruncated: boolean; archived: boolean; count: number; contributor: ReviewReportContributorSelector }
  | { kind: "fullTextExclusionReason"; criterionId: string; text: string; textTruncated: boolean; archived: boolean; count: number; contributor: ReviewReportContributorSelector };

export type ReviewReportContextPage = {
  kind: ReviewReportContextKind;
  items: ReviewReportContextPageItem[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type BoundedReviewReportContributor =
  | { kind: "searchRun"; id: string; label: string; labelTruncated: boolean; contribution: number; sourceId: string }
  | { kind: "retrievedRecord"; id: string; label: string; labelTruncated: boolean; contribution: number; searchRunId: string; sourceId: string }
  | { kind: "paper"; id: string; label: string; labelTruncated: boolean; contribution: number; paperId?: string; recordCount?: number }
  | { kind: "deduplicationPair"; id: string; label: string; labelTruncated: boolean; contribution: number; leftRecordId: string; rightRecordId: string; strength?: "strong" | "possible" }
  | { kind: "screeningDecision"; id: string; label: string; labelTruncated: boolean; contribution: number; paperId: string; decision: string }
  | { kind: "fullTextScreeningDecision"; id: string; label: string; labelTruncated: boolean; contribution: number; paperId: string; decision: string }
  | { kind: "searchSource"; id: string; label: string; labelTruncated: boolean; contribution: number };

export type ReviewReportContributorPage = {
  contributionTotal: number;
  items: BoundedReviewReportContributor[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type ReviewReportReasonAggregatePage = {
  items: ReviewReportReasonAggregate[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type InteractiveReviewReportSummary = {
  project: { id: string; title: string };
  identification: { metrics: ReviewReportMetric[]; overlappingPaperCount: number };
  deduplication: { metrics: ReviewReportMetric[] };
  screening: { metrics: ReviewReportMetric[]; exclusionReasons: ReviewReportReasonAggregatePage };
  fullTextEligibility: { metrics: ReviewReportMetric[]; exclusionReasons: ReviewReportReasonAggregatePage };
  fullTextRetrieval: { metrics: ReviewReportMetric[] };
  finalEligibility: { metrics: ReviewReportMetric[] };
  supportMatrix: ReviewReportSupportMapping[];
  limitations: ReviewReportLimitation[];
  contextCounts: {
    activeResearchQuestions: number;
    activeScreeningCriteria: number;
    activeFullTextCriteria: number;
    representedSearchSources: number;
  };
};
