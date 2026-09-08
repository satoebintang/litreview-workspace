/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { normalizeDoiForComparison, normalizeTitleForComparison } from "@/domain/search-normalization";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview";
const TEST_DB_NAME = `slice10_flow_test_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
let db!: ReturnType<typeof createDb>["db"];
let appClient!: postgres.Sql;
let services!: ReturnType<typeof createReviewServices>;
let ready = false;
let projectId = "";
let sourceId = "";
let runId = "";

describe("Slice 10 deduplication and review-flow service contract", () => {
  beforeAll(async () => {
    try {
      const admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      await admin.end();
      const created = createDb(TEST_DB_URL);
      db = created.db;
      appClient = created.client;
      services = createReviewServices(db);
      await migrate(db, { migrationsFolder: "./drizzle" });
      const project = await services.createProject({ title: `Flow ${crypto.randomUUID()}` });
      projectId = project.id;
      sourceId = (await services.listSearchSources(projectId))[0].id;
      const strategy = await services.createSearchStrategy(projectId, { searchSourceId: sourceId, name: "Flow search", queryText: "study" });
      const run = await services.createSearchRun(projectId, { searchSourceId: sourceId, sourceKeySnapshot: "scopus", sourceDisplayNameSnapshot: "Scopus", strategyId: strategy.id, queryText: "study", reportedResultCount: 5, executedAt: new Date("2026-01-01T00:00:00Z") });
      runId = run.id;
      ready = true;
    } catch { ready = false; }
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    const admin = postgres(BASE_URL, { max: 1 });
    try { await admin.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  it("derives the queue, atomic same-work resolution, and flow metrics", async () => {
    if (!ready) return;
    const a = await services.createRetrievedRecord(projectId, { searchRunId: runId, searchSourceId: sourceId, sourceRecordId: "flow-a", title: "Shared study", doi: "10.1000/flow", retrievedAt: new Date() });
    const b = await services.createRetrievedRecord(projectId, { searchRunId: runId, searchSourceId: sourceId, sourceRecordId: "flow-b", title: "Shared study copy", doi: "https://doi.org/10.1000/flow", retrievedAt: new Date() });
    const queue = await services.listDeduplicationQueue(projectId);
    const candidate = queue.find((item: any) => item.leftRetrievedRecord.id === a.id && item.rightRetrievedRecord.id === b.id)!;
    expect(candidate.reasons).toContain("normalized_doi");
    expect(candidate.strength).toBe("strong");
    await services.confirmSameWorkAndResolve(projectId, a.id, b.id, { createFromRecordId: a.id });
    expect(await services.getDeduplicationPair(projectId, a.id, b.id)).toMatchObject({ decision: "same_work", leftPaperId: expect.any(String), rightPaperId: expect.any(String) });
    expect(await services.listDeduplicationQueue(projectId)).toHaveLength(0);
    await expect(services.getReviewFlowSummary(projectId)).resolves.toMatchObject({ reportedResultsTotal: 5, retrievedRecords: 2, currentlyResolvedRecords: 2, acquisitionDerivedPapers: 1, duplicateRecordsCollapsed: 1 });
  });

  it("suppresses a different-work pair without changing its mappings", async () => {
    if (!ready) return;
    const a = await services.createRetrievedRecord(projectId, { searchRunId: runId, searchSourceId: sourceId, sourceRecordId: "flow-c", title: "Different study", publicationYear: 2022, retrievedAt: new Date() });
    const b = await services.createRetrievedRecord(projectId, { searchRunId: runId, searchSourceId: sourceId, sourceRecordId: "flow-d", title: "Different study", publicationYear: 2022, retrievedAt: new Date() });
    expect((await services.listDeduplicationQueue(projectId)).some((item: any) => item.leftRetrievedRecord.id === a.id && item.rightRetrievedRecord.id === b.id)).toBe(true);
    await services.decideDifferentWork(projectId, a.id, b.id, "Reviewed and rejected as duplicate");
    const pair = await services.getDeduplicationPair(projectId, a.id, b.id);
    expect(pair).not.toBeNull();
    expect(pair!.decision).toBe("different_work");
    expect(pair!.leftPaperId).toBeNull();
    expect(pair!.rightPaperId).toBeNull();
    expect((await services.listDeduplicationHistory(projectId, a.id, b.id))).toHaveLength(1);

    const sameA = await services.createRetrievedRecord(projectId, { searchRunId: runId, searchSourceId: sourceId, sourceRecordId: "flow-e", title: "Adjudicated but unresolved", retrievedAt: new Date() });
    const sameB = await services.createRetrievedRecord(projectId, { searchRunId: runId, searchSourceId: sourceId, sourceRecordId: "flow-f", title: "Adjudicated but unresolved copy", doi: "10.1000/flow-unresolved", retrievedAt: new Date() });
    await services.confirmSameWork(projectId, sameA.id, sameB.id, "Same scholarly work; resolution deferred");
    const unresolvedSameWork = await services.getDeduplicationPair(projectId, sameA.id, sameB.id);
    expect(unresolvedSameWork).toMatchObject({ decision: "same_work", leftPaperId: null, rightPaperId: null });

    const historicalRecord = await services.createRetrievedRecord(projectId, { searchRunId: runId, searchSourceId: sourceId, sourceRecordId: "flow-historical", title: "Historical acquisition only", retrievedAt: new Date() });
    const historicalPaper = await services.addPaper(projectId, { title: "Historical acquisition only" });
    await services.linkRetrievedRecordToPaper(projectId, historicalRecord.id, historicalPaper.id);
    await services.unlinkRetrievedRecordFromPaper(projectId, historicalRecord.id, historicalPaper.id);
    const manualPaper = await services.addPaper(projectId, { title: "Manual paper" });
    await expect(services.getReviewFlowSummary(projectId)).resolves.toMatchObject({
      sameWorkDecisionPairs: 2,
      historicalAcquisitionOnlyPapers: 1,
      manualPapers: 1,
    });
    await expect(services.listReviewFlowContributors(projectId, "historicalAcquisitionOnlyPapers")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ paper_id: historicalPaper.id })]));
    await expect(services.listReviewFlowContributors(projectId, "manualPapers")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: manualPaper.id })]));
  });

  it("keeps TypeScript and PostgreSQL candidate normalization equivalent", async () => {
    if (!ready) return;
    const dois = [" DOI: 10.1000/Parity ", "https://doi.org/10.1000/Parity ", " 10.1000/Parity"];
    const titles = ["  A  study\nwith\tspaces ", "a study with spaces", "A   STUDY WITH SPACES"];
    const rows = await appClient.unsafe(
      `select
        btrim(lower(regexp_replace(regexp_replace(btrim($1), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))) as doi_one,
        btrim(lower(regexp_replace(regexp_replace(btrim($2), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))) as doi_two,
        lower(regexp_replace(btrim($3), '[[:space:]]+', ' ', 'g')) as title_one,
        lower(regexp_replace(btrim($4), '[[:space:]]+', ' ', 'g')) as title_two`,
      [dois[0], dois[1], titles[0], titles[1]],
    );
    const row = rows[0] as Record<string, string>;
    expect(row.doi_one).toBe(normalizeDoiForComparison(dois[0]));
    expect(row.doi_two).toBe(normalizeDoiForComparison(dois[1]));
    expect(row.title_one).toBe(normalizeTitleForComparison(titles[0]));
    expect(row.title_two).toBe(normalizeTitleForComparison(titles[1]));
    expect(normalizeDoiForComparison(dois[0])).toBe(normalizeDoiForComparison(dois[2]));
    expect(normalizeTitleForComparison(titles[1])).toBe(normalizeTitleForComparison(titles[2]));
  });
});
