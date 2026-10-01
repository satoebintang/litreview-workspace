import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) { return readFileSync(resolve(process.cwd(), path), "utf8"); }

describe("Slice 49 Deduplication route contracts", () => {
  it("uses the bounded queue API without full queue or Review Flow summary reads", () => {
    const page = source("src/app/projects/[projectId]/deduplication/page.tsx");
    expect(page.indexOf("!idSchema.safeParse(projectId).success")).toBeLessThan(page.indexOf("listDeduplicationQueuePage(projectId"));
    expect(page).toContain("listDeduplicationQueuePage(projectId");
    expect(page).not.toContain("listDeduplicationQueue(");
    expect(page).not.toContain("getReviewFlowSummary(");
  });

  it("uses paged history and exact event reads without complete decision histories", () => {
    const page = source("src/app/projects/[projectId]/deduplication/[leftRecordId]/[rightRecordId]/page.tsx");
    expect(page.indexOf("idSchema.safeParse(value).success")).toBeLessThan(page.indexOf("listDeduplicationHistoryPage(projectId"));
    expect(page).toContain("leftRecordId.toLowerCase() === rightRecordId.toLowerCase()");
    expect(page).toContain("listDeduplicationHistoryPage(projectId");
    expect(page).toContain("getDeduplicationDecisionEvent(projectId");
    expect(page).not.toContain("listDeduplicationHistory(");
  });

  it("hydrates only page-visible matches and selects sequence losslessly for history", () => {
    const reader = source("src/application/deduplication-read-services.ts");
    expect(reader).toContain("visible_record_ids");
    expect(reader).toContain("join visible_record_ids v on v.record_id = m.retrieved_record_id");
    expect(reader).toContain("sequence::text as sequence");
    expect(reader).toContain("sequence > ${cursor.s}::bigint");
    expect(reader).not.toContain("Number(row.sequence)");
  });
});
