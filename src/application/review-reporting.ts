import type { Database } from "@/db/client";
import type {
  ReviewReportContributorSelector,
  ReviewReportContributorResult,
  ReviewReportInputs,
  ReviewReportLimitation,
  ReviewReportMetric,
  ReviewReportMetricKey,
  ReviewReportProjection,
  ReviewReportSupportMapping,
} from "@/domain/review-report";
import { ReviewReportingRepository } from "./review-reporting-repositories";

const n = (summary: Record<string, unknown>, key: string) => Number(summary[key] ?? 0);

const labels: Record<ReviewReportMetricKey, string> = {
  distinctSearchRuns: "Recorded search runs",
  reportedResultsTotal: "Results reported by recorded searches",
  retrievedRecords: "RetrievedRecords entered into the workspace",
  distinctSources: "SearchSources represented by recorded runs",
  currentlyResolvedRecords: "RetrievedRecords currently linked to canonical Papers",
  unresolvedRecords: "RetrievedRecords without a current Paper match",
  unresolvedDuplicatePairs: "Unadjudicated duplicate candidate pairs",
  sameWorkDecisionPairs: "Current same-work pair decisions",
  differentWorkDecisionPairs: "Current different-work pair decisions",
  acquisitionDerivedPapers: "Canonical Papers with a current acquisition link",
  duplicateRecordsCollapsed: "Currently collapsed acquisition records",
  papersInScreeningPopulation: "Canonical Papers in title/abstract screening",
  unscreened: "Not screened at title/abstract stage",
  included: "Currently included at title/abstract screening",
  excluded: "Currently excluded at title/abstract screening",
  maybe: "Currently marked maybe at title/abstract screening",
  fullTextEligible: "Currently eligible for full-text screening",
  fullTextAwaiting: "Awaiting full-text screening",
  fullTextAssessed: "Currently assessed at full-text screening",
  fullTextIncluded: "Included after current full-text screening",
  fullTextExcluded: "Excluded after current full-text screening",
  fullTextMaybe: "Currently maybe at full-text screening",
  fullTextConflicts: "Cross-stage full-text conflicts",
  finallyIncluded: "Finally currently included Papers",
  legacyAnalysisAwaitingFullText: "Papers with analysis predating full-text screening",
  historicalAcquisitionOnlyPapers: "Papers with historical but no current acquisition link",
  manualPapers: "Papers never linked to a RetrievedRecord",
};

const explanations: Record<ReviewReportMetricKey, string> = {
  distinctSearchRuns: "Count of immutable SearchRun rows recorded for this project.",
  reportedResultsTotal: "Sum of provider/run-reported result counts; this is not a unique-record count.",
  retrievedRecords: "Count of RetrievedRecord rows actually entered into the workspace.",
  distinctSources: "Distinct SearchSource identities represented by recorded SearchRuns.",
  currentlyResolvedRecords: "RetrievedRecords whose latest match event is linked to a Paper.",
  unresolvedRecords: "RetrievedRecords with no current Paper link; this can include intentionally unmatched records.",
  unresolvedDuplicatePairs: "Candidate pairs that have no current adjudication.",
  sameWorkDecisionPairs: "Latest same_work adjudications, not a duplicate-removal event count.",
  differentWorkDecisionPairs: "Latest different_work adjudications, not a duplicate-removal event count.",
  acquisitionDerivedPapers: "Distinct Papers with at least one current linked RetrievedRecord.",
  duplicateRecordsCollapsed: "Resolved record count minus distinct acquisition-derived Papers; not formal duplicates removed.",
  papersInScreeningPopulation: "All extant project Papers, including manual and historical-acquisition-only Papers.",
  unscreened: "Papers with no current title/abstract screening decision.",
  included: "Papers with a current title/abstract include decision.",
  excluded: "Papers with a current title/abstract exclude decision.",
  maybe: "Papers with a current title/abstract maybe decision.",
  fullTextEligible: "Papers whose current title/abstract state is included; only these contribute to current full-text outcomes.",
  fullTextAwaiting: "Title/abstract-included Papers with no full-text decision.",
  fullTextAssessed: "Title/abstract-included Papers with a current full-text include, exclude, or maybe decision.",
  fullTextIncluded: "Title/abstract-included Papers whose latest full-text decision is include.",
  fullTextExcluded: "Title/abstract-included Papers whose latest full-text decision is exclude.",
  fullTextMaybe: "Title/abstract-included Papers whose latest full-text decision is maybe.",
  fullTextConflicts: "Papers with full-text history whose current title/abstract state is not included.",
  finallyIncluded: "Papers with current include decisions at both title/abstract and full-text stages.",
  legacyAnalysisAwaitingFullText: "Papers with finalized extraction history and no full-text decision; this is informational and does not alter history.",
  historicalAcquisitionOnlyPapers: "Papers with a historical linked event but no current linked record.",
  manualPapers: "Papers with no historical linked RetrievedRecord; distinct from the Manual SearchSource.",
};

function metric(summary: Record<string, unknown>, key: ReviewReportMetricKey): ReviewReportMetric {
  return { key, label: labels[key], support: "supported", value: n(summary, key), explanation: explanations[key], contributor: { scope: "metric", metric: key } };
}

function limitation(code: ReviewReportLimitation["code"], kind: ReviewReportLimitation["kind"], message: string): ReviewReportLimitation {
  return { code, kind, message };
}

export function buildReviewReportProjection(input: ReviewReportInputs): ReviewReportProjection {
  const { summary, context, exclusionReasons, fullTextExclusionReasons } = input;
  const identificationKeys: ReviewReportMetricKey[] = ["distinctSearchRuns", "reportedResultsTotal", "retrievedRecords", "distinctSources"];
  const deduplicationKeys: ReviewReportMetricKey[] = ["currentlyResolvedRecords", "unresolvedRecords", "unresolvedDuplicatePairs", "sameWorkDecisionPairs", "differentWorkDecisionPairs", "acquisitionDerivedPapers", "duplicateRecordsCollapsed", "historicalAcquisitionOnlyPapers", "manualPapers"];
  const screeningKeys: ReviewReportMetricKey[] = ["papersInScreeningPopulation", "included", "excluded", "maybe", "unscreened"];
  const limitations: ReviewReportLimitation[] = [
    limitation("reports_sought_retrieved_not_modeled", "model_capability", "Reports sought or retrieved after title/abstract screening are not modeled."),
    limitation("automation_exclusion_stage_not_modeled", "model_capability", "Automation-tool exclusion counts are not modeled."),
    limitation("source_category_mapping_unavailable", "model_capability", "No database/register/other-source taxonomy is persisted; actual SearchSource labels are reported instead."),
    limitation("formal_prisma_compliance_not_claimed", "model_capability", "This is a derived review-flow report and does not claim formal PRISMA 2020 compliance."),
  ];
  const add = (item: ReviewReportLimitation) => { if (!limitations.some((existing) => existing.code === item.code)) limitations.push(item); };
  if (n(summary, "reportedResultsTotal") > n(summary, "retrievedRecords")) add(limitation("reported_results_exceed_entered_records", "current_data", "Recorded searches report more results than have been entered as RetrievedRecords; ingestion may be partial or intentional."));
  if (n(summary, "unresolvedRecords") > 0) add(limitation("records_without_current_paper_match", "current_data", "Some RetrievedRecords have no current Paper match."));
  if (n(summary, "unresolvedDuplicatePairs") > 0) add(limitation("unresolved_duplicate_candidates", "current_data", "Some duplicate candidate pairs remain unadjudicated."));
  if (n(summary, "unscreened") > 0) add(limitation("screening_incomplete_unscreened", "current_data", "Some Papers remain unscreened at the title/abstract stage."));
  if (n(summary, "maybe") > 0) add(limitation("screening_incomplete_maybe", "current_data", "Some Papers remain in the application-specific maybe state."));
  if (n(summary, "manualPapers") > 0) add(limitation("manual_papers_present", "current_data", "Some Papers have no historical acquisition link."));
  if (n(summary, "historicalAcquisitionOnlyPapers") > 0) add(limitation("historical_acquisition_only_papers_present", "current_data", "Some Papers retain historical acquisition provenance but no current record link."));
  if (context.overlappingPaperCount > 0) add(limitation("cross_source_paper_overlap", "current_data", "Some Papers are linked through more than one SearchSource; per-source Paper counts are non-additive."));

  const supportMatrix: ReviewReportSupportMapping[] = [
    { key: "records_identified_from_recorded_searches", label: "Records identified from recorded searches", support: "partially_supported", explanation: "Recorded provider totals and entered records are available, but they are not guaranteed unique records and source categories are not modeled." },
    { key: "records_screened", label: "Records screened", support: "partially_supported", explanation: "The application reports current canonical Papers at title/abstract screening, not a complete formal screening flow over reports." },
    { key: "duplicates_removed", label: "Duplicates removed", support: "partially_supported", explanation: "Slice 10 exposes current canonical resolution and a derived collapsed-record surplus, not a formal persisted duplicate-removal event count." },
    { key: "reports_sought_or_retrieved", label: "Reports sought or retrieved", support: "unsupported", explanation: "No later reports-sought/retrieved stage exists." },
    { key: "reports_assessed_for_eligibility", label: "Reports assessed for eligibility", support: "partially_supported", explanation: "Current full-text decisions are recorded for canonical Papers, but reports sought/retrieved and historical PRISMA event flow are not modeled." },
    { key: "reports_excluded_full_text", label: "Reports excluded after full-text review", support: "partially_supported", explanation: "Current full-text exclusions and structured reasons are recorded for canonical Papers, not a separate report entity." },
    { key: "studies_included_final", label: "Studies included after eligibility", support: "partially_supported", explanation: "Current final inclusion is derived from both screening stages on canonical Papers; distinct study/report identity is not modeled." },
    { key: "automation_exclusions", label: "Automation-tool exclusions", support: "unsupported", explanation: "Automation exclusion stages are not modeled." },
    { key: "source_category_taxonomy", label: "Database/register/other source categories", support: "unsupported", explanation: "No persisted reporting taxonomy exists; actual SearchSource labels are retained." },
  ];

  return {
    project: context.project,
    activeResearchQuestions: context.activeResearchQuestions,
    activeCriteria: context.activeCriteria,
    activeFullTextCriteria: context.activeFullTextCriteria,
    identification: { metrics: identificationKeys.map((key) => metric(summary, key)), bySource: context.sources, runs: context.runs, overlappingPaperCount: context.overlappingPaperCount },
    deduplication: { metrics: deduplicationKeys.map((key) => metric(summary, key)) },
    screening: { metrics: screeningKeys.map((key) => metric(summary, key)), exclusionReasons: exclusionReasons.map((reason) => ({ ...reason, contributor: { scope: "exclusionReason", criterionId: reason.criterionId } })) },
    fullTextEligibility: { metrics: ["fullTextEligible", "fullTextAwaiting", "fullTextAssessed", "fullTextIncluded", "fullTextExcluded", "fullTextMaybe", "fullTextConflicts"].map((key) => metric(summary, key as ReviewReportMetricKey)), exclusionReasons: fullTextExclusionReasons.map((reason) => ({ ...reason, contributor: { scope: "fullTextExclusionReason", criterionId: reason.criterionId } })) },
    finalEligibility: { metrics: ["finallyIncluded", "legacyAnalysisAwaitingFullText"].map((key) => metric(summary, key as ReviewReportMetricKey)) },
    supportMatrix,
    limitations,
  };
}

function md(value: string | null | undefined): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "<br>").replace(/\|/g, "\\|");
}

export function serializeReviewFlowMarkdown(projection: ReviewReportProjection): string {
  const lines: string[] = ["# Review Flow Report", "", "This report is a deterministic projection of recorded review facts. It is PRISMA-oriented and does not claim formal PRISMA 2020 compliance.", "", "## Research Questions"];
  if (projection.activeResearchQuestions.length === 0) lines.push("", "- None recorded.");
  for (const question of projection.activeResearchQuestions) lines.push("", `- ${md(question.identifier)}: ${md(question.label)}`);
  lines.push("", "## Current Screening Criteria");
  if (projection.activeCriteria.length === 0) lines.push("", "- None active.");
  for (const criterion of projection.activeCriteria) lines.push("", `- ${md(criterion.type)}: ${md(criterion.text)}`);
  lines.push("", "## Search Identification");
  for (const item of projection.identification.metrics) lines.push("", `- ${item.label}: ${item.value}`);
  lines.push("", `- Papers linked through more than one SearchSource: ${projection.identification.overlappingPaperCount}`);
  lines.push("", "### By SearchSource");
  for (const source of projection.identification.bySource) {
    const historical = source.observedSnapshots[0] ?? { sourceKey: source.source.sourceKey, displayName: source.source.displayName };
    lines.push("", `#### ${md(historical.displayName)} (${md(historical.sourceKey)})`);
    lines.push(`- Recorded search runs: ${source.runCount}`);
    lines.push(`- Results reported by recorded searches: ${source.reportedResults}`);
    lines.push(`- RetrievedRecords entered: ${source.retrievedRecords}`);
    lines.push(`- RetrievedRecords currently resolved: ${source.currentlyResolvedRecords}`);
    lines.push(`- Papers currently linked to records from this source: ${source.acquisitionDerivedPapers} (non-additive across sources)`);
    if (source.observedSnapshots.length > 0) lines.push(`- Historical run labels: ${source.observedSnapshots.map((snapshot) => `${md(snapshot.displayName)} [${md(snapshot.sourceKey)}]`).join("; ")}`);
    if (source.source.displayName !== historical.displayName || source.source.sourceKey !== historical.sourceKey) lines.push(`- Current SearchSource configuration: ${md(source.source.displayName)} [${md(source.source.sourceKey)}]`);
  }
  lines.push("", "## Deduplication and Paper Resolution");
  for (const item of projection.deduplication.metrics) lines.push("", `- ${item.label}: ${item.value}`);
  lines.push("", "## Title/Abstract Screening");
  for (const item of projection.screening.metrics) lines.push("", `- ${item.label}: ${item.value}`);
  lines.push("", "### Current Exclusion Reasons");
  if (projection.screening.exclusionReasons.length === 0) lines.push("", "- None recorded.");
  for (const reason of projection.screening.exclusionReasons) lines.push("", `- ${md(reason.text)}: ${reason.count}${reason.archived ? " (criterion archived)" : ""}`);
  lines.push("", "## Full-text eligibility");
  for (const item of projection.fullTextEligibility.metrics) lines.push("", `- ${item.label}: ${item.value}`);
  lines.push("", "### Active Full-Text Criteria");
  if (projection.activeFullTextCriteria.length === 0) lines.push("", "- None active.");
  for (const criterion of projection.activeFullTextCriteria) lines.push("", `- ${md(criterion.text)}`);
  lines.push("", "### Current Full-Text Exclusion Reasons");
  if (projection.fullTextEligibility.exclusionReasons.length === 0) lines.push("", "- None recorded.");
  for (const reason of projection.fullTextEligibility.exclusionReasons) lines.push("", `- ${md(reason.text)}: ${reason.count}${reason.archived ? " (criterion archived)" : ""}`);
  lines.push("", "## Final Eligibility");
  for (const item of projection.finalEligibility.metrics) lines.push("", `- ${item.label}: ${item.value}`);
  lines.push("", "## Reporting Support");
  for (const mapping of projection.supportMatrix) lines.push("", `- ${mapping.label}: ${mapping.support} — ${mapping.explanation}`);
  lines.push("", "## Reporting Limitations");
  for (const item of projection.limitations) lines.push("", `- ${item.message}`);
  lines.push("", "## Immutable SearchRun Appendix");
  if (projection.identification.runs.length === 0) lines.push("", "- No SearchRuns recorded.");
  for (const run of projection.identification.runs) {
    lines.push("", `### Run ${run.sequence} · ${md(run.sourceDisplayNameSnapshot)}`);
    lines.push(`- Source key snapshot: ${md(run.sourceKeySnapshot)}`);
    lines.push(`- Executed at: ${new Date(run.executedAt).toISOString()}`);
    lines.push(`- Reported results: ${run.reportedResultCount}`);
    lines.push(`- RetrievedRecords entered: ${run.enteredRecordCount}`);
    lines.push(`- Query: ${md(run.queryText)}`);
    if (run.filtersTextSnapshot) lines.push(`- Filters snapshot: ${md(run.filtersTextSnapshot)}`);
    if (run.notes) lines.push(`- Notes: ${md(run.notes)}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function createReviewReportingServices(db: Database, flowServices: { getReviewFlowSummary(projectId: string): Promise<Record<string, unknown>> }) {
  const repository = new ReviewReportingRepository(db);
  return {
    async getReviewReport(projectId: string) {
      const [summary, context, exclusionReasons, fullTextExclusionReasons] = await Promise.all([flowServices.getReviewFlowSummary(projectId), repository.context(projectId), repository.exclusionReasons(projectId), repository.fullTextExclusionReasons(projectId)]);
      return buildReviewReportProjection({ summary, context, exclusionReasons, fullTextExclusionReasons });
    },
    async listReviewReportContributors(projectId: string, selector: ReviewReportContributorSelector): Promise<ReviewReportContributorResult> {
      return repository.contributors(projectId, selector);
    },
  };
}
