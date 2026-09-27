import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardPath = "src/app/projects/[projectId]/screening/page.tsx";
const detailPath = "src/app/projects/[projectId]/screening/[paperId]/page.tsx";

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

  it("keeps detail screening/history reads and uses exact ordinal navigation", () => {
    const detail = source(detailPath);
    expect(detail).toContain("reviewServices.getPaperScreening(projectId, paperId)");
    expect(detail).toContain("screeningReadServices.getScreeningPaperNavigation(projectId, paperId)");
    expect(detail).toMatch(/if \(!navigation\) notFound\(\)/);
    expect(detail).toContain("navigation.position");
    expect(detail).toContain("navigation.totalCount");
    expect(detail).toContain("navigation.previousPaperId");
    expect(detail).toContain("navigation.nextPaperId");
    expect(detail).toContain('aria-label="Screening paper navigation"');
    expect(detail).toContain("screening.history.map");
    expect(detail).toContain("recordScreeningDecisionAction");
  });
});
