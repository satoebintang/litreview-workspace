import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) { return readFileSync(resolve(process.cwd(), path), "utf8"); }

const protocol = "src/app/projects/[projectId]/protocol/page.tsx";
const run = "src/app/projects/[projectId]/protocol/runs/[runId]/page.tsx";
const detail = "src/app/projects/[projectId]/protocol/runs/[runId]/records/[recordId]/page.tsx";

describe("Slice 46 interactive acquisition route contracts", () => {
  it("uses a cursor SearchRun ledger and no Project-wide run list or manual record selector", () => {
    const text = source(protocol);
    expect(text).toContain("getSearchRunPage(projectId");
    expect(text).not.toContain("listSearchRuns(");
    expect(text).not.toContain("createRetrievedRecordAction");
    expect(text).not.toContain('name="record-run"');
    expect(text).not.toContain('name="record-source"');
  });

  it("keeps the SearchRun page to one compact RetrievedRecord page", () => {
    const text = source(run);
    expect(text).toContain("getRetrievedRecordPage(projectId, runId");
    expect(text).not.toContain("listRetrievedRecordProjections");
    expect(text).not.toContain("listRetrievedRecordMatchHistory");
    expect(text).not.toContain("Duplicate candidates");
    expect(text).not.toContain("<PaperPicker");
    expect(text).toContain("createRetrievedRecordForRunAction");
  });

  it("isolates full metadata, history, candidates, and one record's PaperPicker workflow on exact detail", () => {
    const text = source(detail);
    expect(text).toContain("getRetrievedRecordDetail(projectId, runId, recordId)");
    expect(text).toContain("getRetrievedRecordMatchHistoryPage(projectId, runId, recordId");
    expect(text).toContain("getRetrievedRecordDuplicateCandidatePage(projectId, runId, recordId");
    expect(text.match(/<PaperPicker/g)).toHaveLength(2); // The branch renders exactly one picker for the current match state.
    expect(text).toContain("detail.currentMatch ?");
    expect(text).toContain("detail.currentMatch.paperTitle");
    expect(text).not.toContain("paperSelectionReadServices");
  });

  it("derives manual record source from its run and checks nested mutations against run ownership", () => {
    const actions = source("src/app/actions/protocol-search.ts");
    expect(actions).toContain("searchSourceId: run.searchSourceId");
    expect(actions).toContain("record.searchRunId !== run.id");
    expect(actions).toContain("requireRecordForRun(projectId, runId, recordId)");
  });

  it("uses bounded summary and redirects legacy drilldowns before reading it while export stays complete", () => {
    const page = source("src/app/projects/[projectId]/review-report/page.tsx");
    const exportRoute = source("src/app/projects/[projectId]/review-report/export/route.ts");
    expect(page).toContain("getInteractiveReviewReportSummary(projectId)");
    expect(page).not.toContain("getInteractiveReviewReport(projectId)");
    expect(page).not.toContain("getReviewReport(projectId)");
    expect(page).not.toContain("identification.runs.map");
    expect(page.indexOf("redirect(`/projects/${projectId}/review-report/contributors/metric/${metric}`)")).toBeLessThan(page.indexOf("getInteractiveReviewReportSummary(projectId)"));
    expect(page.indexOf("if (metric && metricKeys.has(metric))")).toBeLessThan(page.indexOf("if (sourceId && sourceMetric"));
    expect(page.indexOf("if (sourceId && sourceMetric")).toBeLessThan(page.indexOf("if (criterionId)"));
    expect(page.indexOf("if (criterionId)")).toBeLessThan(page.indexOf("if (fullTextCriterionId)"));
    expect(page.indexOf("if (fullTextCriterionId)")).toBeLessThan(page.indexOf("if (overlap === \"1\")"));
    expect(page).toContain("context/questions");
    expect(page).toContain("context/screening-criteria");
    expect(page).toContain("context/full-text-criteria");
    expect(page).toContain("context/sources");
    expect(page).toContain('kind="exclusion-reasons"');
    expect(page).toContain('kind="full-text-exclusion-reasons"');
    expect(exportRoute).toContain("getReviewReport(projectId)");
    expect(exportRoute).toContain("serializeReviewFlowMarkdown(projection)");
  });
});
