/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { SEARCH_SOURCE_DEFINITIONS } from "@/domain/search-normalization";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview";
const TEST_DB_NAME = `slice9_acquisition_test_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
let db!: ReturnType<typeof createDb>["db"];
let client!: postgres.Sql;
let appClient!: postgres.Sql;
let services!: ReturnType<typeof createReviewServices>;
let ready = false;
let projectId = "";

describe("Slice 9 acquisition protocol", () => {
  beforeAll(async () => { try { const admin = postgres(BASE_URL, { max: 1 }); await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`); await admin.end(); client = postgres(TEST_DB_URL, { max: 1 }); const created = createDb(TEST_DB_URL); db = created.db; appClient = created.client; services = createReviewServices(db); await migrate(db, { migrationsFolder: "./drizzle" }); ready = true; projectId = (await services.createProject({ title: `Acquisition ${crypto.randomUUID()}`, researchQuestion: "What is known?" })).id; } catch { ready = false; } });
  afterAll(async () => { if (appClient) await appClient.end(); if (client) await client.end(); const admin = postgres(BASE_URL, { max: 1 }); try { await admin.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`); } finally { await admin.end(); } });
  const skip = () => { if (!ready) return true; return false; };

  it("seeds built-in sources and the initial question transactionally", async () => {
    if (skip()) return;
    expect((await services.listSearchSources(projectId)).map((s: any) => s.sourceKey).sort()).toEqual(SEARCH_SOURCE_DEFINITIONS.map((s) => s.sourceKey).sort());
    expect(await services.listResearchQuestions(projectId)).toMatchObject([{ identifier: "RQ1", label: "What is known?" }]);
  });

  it("snapshots strategy and source identity, and preserves history", async () => {
    if (skip()) return;
    const source = (await services.listSearchSources(projectId))[0];
    const strategy = await services.createSearchStrategy(projectId, { searchSourceId: source.id, name: "Initial", queryText: "  climate AND health  ", filtersText: "year:2020-2024" });
    const run = await services.createSearchRun(projectId, { searchSourceId: source.id, sourceKeySnapshot: source.sourceKey, sourceDisplayNameSnapshot: source.displayName, strategyId: strategy.id, queryText: strategy.queryText, filtersTextSnapshot: strategy.filtersText, reportedResultCount: 4, executedAt: new Date("2026-01-01T00:00:00Z") });
    await services.updateSearchSource(projectId, source.id, { displayName: "Renamed source" });
    await services.updateSearchStrategy(projectId, strategy.id, { queryText: "changed" });
    expect(await services.getSearchRun(projectId, run.id)).toMatchObject({ sourceDisplayNameSnapshot: source.displayName, queryText: "  climate AND health  ", filtersTextSnapshot: "year:2020-2024", reportedResultCount: 4 });
  });

  it("rejects cross-project records and derives the current match from latest event", async () => {
    if (skip()) return;
    const other = await services.createProject({ title: `Other ${crypto.randomUUID()}` });
    const source = (await services.listSearchSources(projectId))[0];
    const strategy = (await services.listSearchStrategies(projectId))[0];
    const run = (await services.listSearchRuns(projectId)).find((r: any) => r.strategyId === strategy.id)!;
    const record = await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: source.id, sourceRecordId: `rec-${crypto.randomUUID()}`, title: "A retrieved title", publicationYear: 2024, doi: "doi:10.1234/example", retrievedAt: new Date() });
    const paper = await services.addPaper(projectId, { title: "A paper", publicationYear: 2024 });
    const otherPaper = await services.addPaper(other.id, { title: "Other paper" });
    await expect(services.linkRetrievedRecordToPaper(projectId, record.id, otherPaper.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await services.linkRetrievedRecordToPaper(projectId, record.id, paper.id);
    expect((await services.getCurrentRetrievedRecordMatch(projectId, record.id))?.paperId).toBe(paper.id);
    await services.unlinkRetrievedRecordFromPaper(projectId, record.id, paper.id);
    expect(await services.getCurrentRetrievedRecordMatch(projectId, record.id)).toBeNull();
    await expect(services.unlinkRetrievedRecordFromPaper(projectId, record.id, paper.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("relinks atomically and exposes conservative duplicate candidates", async () => {
    if (skip()) return;
    const source = (await services.listSearchSources(projectId))[0];
    const run = (await services.listSearchRuns(projectId))[0];
    const record = await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: source.id, title: "A duplicate title", publicationYear: 2024, doi: "https://doi.org/10.5678/test", retrievedAt: new Date() });
    const a = await services.addPaper(projectId, { title: "A", publicationYear: 2024 });
    const b = await services.addPaper(projectId, { title: "B", publicationYear: 2024 });
    await services.linkRetrievedRecordToPaper(projectId, record.id, a.id);
    const result = await services.relinkRetrievedRecord(projectId, record.id, a.id, b.id);
    expect(result.unlinked.action).toBe("unlinked"); expect(result.linked.action).toBe("linked");
    expect((await services.getCurrentRetrievedRecordMatch(projectId, record.id))?.paperId).toBe(b.id);
    expect(await services.findPaperDuplicateCandidates(projectId, { title: record.title, doi: record.doi, publicationYear: record.publicationYear })).toEqual([]);
    const duplicate = await services.addPaper(projectId, { title: " A duplicate   title ", publicationYear: 2024, doi: "10.5678/test" });
    expect((await services.findRetrievedRecordDuplicateCandidates(projectId, record.id)).some((p) => p.id === duplicate.id)).toBe(true);
    await expect(services.relinkRetrievedRecord(projectId, record.id, a.id, duplicate.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.deletePaper(projectId, b.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    const parallelRecord = await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: source.id, title: "Parallel candidate", publicationYear: 2023, retrievedAt: new Date() });
    const outcomes = await Promise.allSettled([services.linkRetrievedRecordToPaper(projectId, parallelRecord.id, a.id), services.linkRetrievedRecordToPaper(projectId, parallelRecord.id, b.id)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await services.listRetrievedRecordMatchHistory(projectId, parallelRecord.id))).toHaveLength(1);
  });

  it("uses SearchSource identity for source-record duplicate candidates", async () => {
    if (skip()) return;
    const source = (await services.listSearchSources(projectId))[0];
    const strategy = (await services.listSearchStrategies(projectId))[0];
    const runA = (await services.listSearchRuns(projectId)).find((run: any) => run.strategyId === strategy.id)!;
    const runB = await services.createSearchRun(projectId, { searchSourceId: source.id, sourceKeySnapshot: source.sourceKey, sourceDisplayNameSnapshot: source.displayName, strategyId: strategy.id, queryText: strategy.queryText, filtersTextSnapshot: strategy.filtersText, reportedResultCount: 1, executedAt: new Date("2026-01-02T00:00:00Z") });
    const sibling = await services.createRetrievedRecord(projectId, { searchRunId: runA.id, searchSourceId: source.id, sourceRecordId: "stable-42", title: "Source result", retrievedAt: new Date() });
    const canonical = await services.addPaper(projectId, { title: "Canonical source result" });
    await services.linkRetrievedRecordToPaper(projectId, sibling.id, canonical.id);
    const later = await services.createRetrievedRecord(projectId, { searchRunId: runB.id, searchSourceId: source.id, sourceRecordId: "stable-42", title: "Different metadata", retrievedAt: new Date() });
    expect((await services.findRetrievedRecordDuplicateCandidates(projectId, later.id)).map((paper) => paper.id)).toContain(canonical.id);
    const custom = await services.createSearchSource(projectId, { sourceKey: "same-name-custom", displayName: source.displayName });
    expect(custom.id).not.toBe(source.id);
  });
});
