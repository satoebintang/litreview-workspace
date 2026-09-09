/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { serializeReviewFlowMarkdown } from "@/application/review-reporting";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview";
const TEST_DB_NAME = `slice11_report_test_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
let services!: ReturnType<typeof createReviewServices>;
let appClient!: postgres.Sql;
let projectId = "";
let ready = false;

describe("Slice 11 review report projection", () => {
  beforeAll(async () => {
    try {
      const admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      await admin.end();
      const created = createDb(TEST_DB_URL);
      services = createReviewServices(created.db);
      appClient = created.client;
      await migrate(created.db, { migrationsFolder: "./drizzle" });
      projectId = (await services.createProject({ title: "Report projection" })).id;
      ready = true;
    } catch { ready = false; }
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    const admin = postgres(BASE_URL, { max: 1 });
    try { await admin.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  it("derives source snapshots, overlap, current screening, and deterministic Markdown", async () => {
    if (!ready) return;
    const sources = await services.listSearchSources(projectId);
    const first = sources[0];
    const second = sources[1];
    const strategyA = await services.createSearchStrategy(projectId, { searchSourceId: first.id, name: "A", queryText: "alpha" });
    const strategyB = await services.createSearchStrategy(projectId, { searchSourceId: second.id, name: "B", queryText: "beta" });
    const runA = await services.createSearchRun(projectId, { searchSourceId: first.id, sourceKeySnapshot: first.sourceKey, sourceDisplayNameSnapshot: first.displayName, strategyId: strategyA.id, queryText: "alpha", reportedResultCount: 10, executedAt: new Date("2026-01-01T00:00:00Z") });
    const runB = await services.createSearchRun(projectId, { searchSourceId: second.id, sourceKeySnapshot: second.sourceKey, sourceDisplayNameSnapshot: second.displayName, strategyId: strategyB.id, queryText: "beta", reportedResultCount: 1, executedAt: new Date("2026-01-02T00:00:00Z") });
    const recordA = await services.createRetrievedRecord(projectId, { searchRunId: runA.id, searchSourceId: first.id, title: "Shared paper", retrievedAt: new Date("2026-01-01T01:00:00Z") });
    const recordA2 = await services.createRetrievedRecord(projectId, { searchRunId: runA.id, searchSourceId: first.id, title: "Shared paper second result", retrievedAt: new Date("2026-01-01T01:01:00Z") });
    const recordB = await services.createRetrievedRecord(projectId, { searchRunId: runB.id, searchSourceId: second.id, title: "Shared paper copy", retrievedAt: new Date("2026-01-02T01:00:00Z") });
    const paper = await services.addPaper(projectId, { title: "Shared paper" });
    await services.linkRetrievedRecordToPaper(projectId, recordA.id, paper.id);
    await services.linkRetrievedRecordToPaper(projectId, recordA2.id, paper.id);
    await services.linkRetrievedRecordToPaper(projectId, recordB.id, paper.id);
    const criterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Wrong population" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });

    const report = await services.getReviewReport(projectId);
    expect(report.identification.metrics.find((item: any) => item.key === "reportedResultsTotal")).toMatchObject({ value: 11, support: "supported" });
    expect(report.identification.metrics.find((item: any) => item.key === "retrievedRecords")).toMatchObject({ value: 3 });
    const firstSource = report.identification.bySource.find((source: any) => source.source.id === first.id);
    expect(firstSource).toMatchObject({ reportedResults: 10, retrievedRecords: 2 });
    expect(report.identification.overlappingPaperCount).toBe(1);
    expect(report.limitations.some((item: any) => item.code === "reported_results_exceed_entered_records")).toBe(true);
    expect(report.limitations.some((item: any) => item.code === "cross_source_paper_overlap")).toBe(true);
    expect(report.screening.exclusionReasons).toMatchObject([{ text: "Wrong population", count: 1 }]);
    const runContributor = await services.listReviewReportContributors(projectId, { scope: "metric", metric: "reportedResultsTotal" });
    expect(runContributor.total).toBe(11);
    const overlapContributor = await services.listReviewReportContributors(projectId, { scope: "overlap" });
    expect(overlapContributor.total).toBe(1);
    const markdown = serializeReviewFlowMarkdown(report);
    expect(markdown).toContain("Results reported by recorded searches: 11");
    expect(markdown).toContain("Full-text eligibility");
    expect(markdown).not.toContain("generatedAt");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown).toBe(serializeReviewFlowMarkdown(report));
    await services.updateSearchSource(projectId, first.id, { displayName: "Renamed current source" });
    const afterRename = await services.getReviewReport(projectId);
    const renamedMarkdown = serializeReviewFlowMarkdown(afterRename);
    expect(renamedMarkdown).toContain(`#### ${first.displayName} (${first.sourceKey})`);
    expect(renamedMarkdown).toContain("Current SearchSource configuration: Renamed current source");
  });
});
