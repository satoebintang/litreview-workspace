import type { FullTextScreeningCriterion, Paper, ResearchQuestion, ScreeningCriterion, SearchRun, SearchSource } from "./types";

export type ReportMetricSupport = "supported" | "partially_supported" | "unsupported";

export type ReviewReportMetricKey =
  | "distinctSearchRuns"
  | "reportedResultsTotal"
  | "retrievedRecords"
  | "distinctSources"
  | "currentlyResolvedRecords"
  | "unresolvedRecords"
  | "unresolvedDuplicatePairs"
  | "sameWorkDecisionPairs"
  | "differentWorkDecisionPairs"
  | "acquisitionDerivedPapers"
  | "duplicateRecordsCollapsed"
  | "papersInScreeningPopulation"
  | "unscreened"
  | "included"
  | "excluded"
  | "maybe"
  | "fullTextEligible"
  | "fullTextAwaiting"
  | "fullTextAssessed"
  | "fullTextIncluded"
  | "fullTextExcluded"
  | "fullTextMaybe"
  | "fullTextConflicts"
  | "finallyIncluded"
  | "legacyAnalysisAwaitingFullText"
  | "historicalAcquisitionOnlyPapers"
  | "manualPapers";

export type ReviewReportSupportKey =
  | "records_identified_from_recorded_searches"
  | "records_screened"
  | "duplicates_removed"
  | "reports_sought_or_retrieved"
  | "reports_assessed_for_eligibility"
  | "reports_excluded_full_text"
  | "studies_included_final"
  | "automation_exclusions"
  | "source_category_taxonomy";

export type ReviewReportLimitationCode =
  | "full_text_stage_not_modeled"
  | "reports_sought_retrieved_not_modeled"
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
