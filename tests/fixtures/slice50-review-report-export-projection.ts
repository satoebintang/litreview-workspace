import { REVIEW_REPORT_METRIC_KEYS } from "@/domain/review-report";
import { buildReviewReportProjection } from "@/application/review-reporting";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

export function slice49BaselineProjectionBeyondInteractiveLimits() {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const summary = Object.fromEntries(REVIEW_REPORT_METRIC_KEYS.map((key, index) => [key, index + 1]));
  summary.reportedResultsTotal = 4_321;
  summary.duplicateRecordsCollapsed = 27;
  const context = {
    project: { id: projectId, title: "Slice 50 export golden" },
    activeResearchQuestions: Array.from({ length: 27 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      projectId,
      identifier: `RQ${String(index + 1).padStart(2, "0")}`,
      label: `Question label ${String(index + 1).padStart(2, "0")}`,
      sortOrder: index,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
      archivedAt: null,
    })),
    activeCriteria: Array.from({ length: 27 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      projectId,
      type: index % 2 === 0 ? "inclusion" as const : "exclusion" as const,
      text: `Screening criterion ${String(index + 1).padStart(2, "0")}`,
      sortOrder: index,
      createdAt: FIXED_DATE,
      archivedAt: null,
    })),
    activeFullTextCriteria: Array.from({ length: 27 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      projectId,
      text: `Full-text criterion ${String(index + 1).padStart(2, "0")}`,
      sortOrder: index,
      createdAt: FIXED_DATE,
      archivedAt: null,
    })),
    sources: Array.from({ length: 27 }, (_, index) => {
      const sourceId = `30000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      const sourceKey = `source-${String(index + 1).padStart(2, "0")}`;
      const displayName = index === 0 ? "Source 01 after rename" : `Source ${String(index + 1).padStart(2, "0")}`;
      const oldDisplayName = index === 0 ? "Source 01 before rename" : `${displayName} old`;
      return {
        source: { id: sourceId, projectId, sourceKey, displayName, baseUrl: null, notes: null, createdAt: FIXED_DATE, updatedAt: FIXED_DATE, archivedAt: null },
        observedSnapshots: [{ sourceKey: `${sourceKey}-old`, displayName: oldDisplayName }, { sourceKey, displayName }],
        historicalSnapshotCount: 2,
        runCount: index === 0 ? 2 : 1,
        reportedResults: index === 0 ? 27 : index + 1,
        retrievedRecords: index + 2,
        currentlyResolvedRecords: index + 1,
        acquisitionDerivedPapers: index + 1,
      };
    }),
    runs: Array.from({ length: 28 }, (_, index) => {
      const sourceIndex = index === 0 ? 0 : index - 1;
      const sourceNumber = sourceIndex + 1;
      const sourceDisplayNameSnapshot = sourceIndex === 0
        ? index === 0 ? "Source 01 before rename" : "Source 01 renamed snapshot"
        : `Source ${String(sourceNumber).padStart(2, "0")}`;
      return {
        id: `40000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        sequence: index + 1,
        projectId,
        searchSourceId: `30000000-0000-4000-8000-${String(sourceIndex + 10).padStart(12, "0")}`,
        sourceKeySnapshot: `source-${String(sourceNumber).padStart(2, "0")}`,
        sourceDisplayNameSnapshot,
        strategyId: `50000000-0000-4000-8000-${String(sourceIndex + 10).padStart(12, "0")}`,
        queryText: index === 0 ? 'query | with \\ escaping' : `query ${index + 1}`,
        filtersTextSnapshot: index === 0 ? "year:2020" : null,
        reportedResultCount: index + 3,
        executedAt: FIXED_DATE,
        notes: index === 0 ? "complete appendix note" : null,
        createdAt: FIXED_DATE,
        enteredRecordCount: index,
      };
    }),
    overlappingPaperCount: 4,
  };
  const exclusionReasons = Array.from({ length: 15 }, (_, index) => ({
    criterionId: `60000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    text: `Title/abstract reason ${String(index + 1).padStart(2, "0")}`,
    archived: index === 0,
    count: index + 1,
  }));
  const fullTextExclusionReasons = Array.from({ length: 15 }, (_, index) => ({
    criterionId: `70000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    text: `Full-text reason ${String(index + 1).padStart(2, "0")}`,
    archived: index === 1,
    count: index + 2,
  }));
  return buildReviewReportProjection({ summary, context, exclusionReasons, fullTextExclusionReasons });
}
