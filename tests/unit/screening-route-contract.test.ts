import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardPath = "src/app/projects/[projectId]/screening/page.tsx";
const detailPath = "src/app/projects/[projectId]/screening/[paperId]/page.tsx";
const fullTextDetailPath = "src/app/projects/[projectId]/screening/full-text/[paperId]/page.tsx";
const retrievalDetailPath = "src/app/projects/[projectId]/screening/full-text/retrieval/[paperId]/page.tsx";
const historyReaderPath = "src/application/screening-history-read-services.ts";
const queryReaderPath = "src/application/screening-history-read-queries.ts";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Slice 44 title/abstract screening routes", () => {
  it("keeps both routes off the legacy Project-wide screening list", () => {
    for (const path of [dashboardPath, detailPath]) {
      expect(source(path), path).not.toContain("listScreeningPapers");
    }
  });

  it("uses the bounded queue page for dashboard counts, rows, and Start screening", () => {
    const dashboard = source(dashboardPath);
    expect(dashboard).toContain("screeningReadServices.getScreeningQueuePage(projectId, { state: query.state, page: query.page })");
    expect(dashboard).toContain("queue.counts.all");
    expect(dashboard).toContain("queue.items.map");
    expect(dashboard).toContain("queue.startPaperId");
    expect(dashboard).toMatch(/function stateHref[\s\S]*?return state === "all" \? path : `\$\{path\}\?state=\$\{state\}`/);
    expect(dashboard).toMatch(/if \(state !== "all"\) queryParams\.set\("state", state\);[\s\S]*?queryParams\.set\("page", String\(pageNumber\)\)/);
    expect(dashboard).toContain('aria-label="Screening queue pagination"');
  });

  it("uses bounded detail history pages and exact ordinal navigation", () => {
    const detail = source(detailPath);
    expect(detail).toContain("screeningHistoryReadServices.getTitleAbstractScreeningDetail(projectId, paperId)");
    expect(detail).toContain("screening.history.items.map");
    expect(detail).toContain("screening.history.hasMore");
    expect(detail).toContain("screening.navigation.position");
    expect(detail).toContain("screening.navigation.totalCount");
    expect(detail).toContain("screening.navigation.previousPaperId");
    expect(detail).toContain("screening.navigation.nextPaperId");
    expect(detail).toContain('aria-label="Screening paper navigation"');
    expect(detail).toContain("recordScreeningDecisionAction");
  });

  it("keeps all normal screening detail routes off complete history and full-row current APIs", () => {
    for (const path of [detailPath, fullTextDetailPath, retrievalDetailPath, historyReaderPath, queryReaderPath]) {
      const text = source(path);
      for (const forbidden of [
        "getPaperScreening(", "getPaperFullTextScreening(", "getPaperFullTextRetrieval(",
        "listFullTextRetrievalHistory(", "listForPaperWithCriteria(", "listForPaper(", "currentForPaper(",
      ]) expect(text, `${path} should not call ${forbidden}`).not.toContain(forbidden);
    }
    expect(source(fullTextDetailPath)).toContain("screeningHistoryReadServices.getFullTextScreeningDetail(projectId, paperId)");
    expect(source(retrievalDetailPath)).toContain("screeningHistoryReadServices.getFullTextRetrievalDetail(projectId, paperId)");
  });

  it("keeps full-text decision and retrieval continuations on separate readers", () => {
    const services = source(historyReaderPath);
    expect(services).toContain("getFullTextScreeningDecisionHistoryPage");
    expect(services).toContain("getFullTextRetrievalAttemptHistoryPage");
    const queries = source(queryReaderPath);
    expect(queries).toContain("async function fullTextDecisionRows");
    expect(queries).toContain("async function retrievalRows");
    expect(queries).toContain("from full_text_screening_decisions decision");
    expect(queries).toContain("from full_text_retrieval_attempts attempt");
  });
});
