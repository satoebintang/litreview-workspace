import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createAcquisitionReadServices } from "@/application/acquisition-read-services";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const TEST_DB_NAME = `slice46_acq_read_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const dbUrl = new URL(BASE_URL);
dbUrl.pathname = `/${TEST_DB_NAME}`;
let appClient: postgres.Sql | undefined;
let adminClient: postgres.Sql | undefined;
let services!: ReturnType<typeof createReviewServices>;
let acquisitionReads!: ReturnType<typeof createAcquisitionReadServices>;
let projectId = "";
let sourceId = "";
let strategyId = "";

async function createRun(reportedResultCount = 0) {
  const source = await services.getSearchSource(projectId, sourceId);
  const strategy = await services.getSearchStrategy(projectId, strategyId);
  return services.createSearchRun(projectId, {
    searchSourceId: source.id,
    sourceKeySnapshot: source.sourceKey,
    sourceDisplayNameSnapshot: source.displayName,
    strategyId: strategy.id,
    queryText: strategy.queryText,
    filtersTextSnapshot: strategy.filtersText,
    reportedResultCount,
    executedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

async function insertRetrievedRecord(input: { runId: string; title: string; retrievedAt: string; createdAt: string; doi?: string | null; publicationYear?: number | null }) {
  const rows = await appClient!.unsafe(`
    insert into retrieved_records(project_id, search_run_id, search_source_id, source_record_id, title, doi, publication_year, retrieved_at, created_at)
    values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
    returning id
  `, [projectId, input.runId, sourceId, `slice46-${randomUUID()}`, input.title, input.doi ?? null, input.publicationYear ?? null, input.retrievedAt, input.createdAt]);
  return String(rows[0]?.id);
}

async function insertPaper(input: { title: string; createdAt: string; doi?: string | null; publicationYear?: number | null }) {
  const rows = await appClient!.unsafe(`
    insert into papers(project_id, title, doi, publication_year, created_at)
    values ($1::uuid, $2, $3, $4, $5::timestamptz)
    returning id
  `, [projectId, input.title, input.doi ?? null, input.publicationYear ?? null, input.createdAt]);
  return String(rows[0]?.id);
}

function cursorPayload(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

function timestampMicros(value: string) {
  const fraction = /\.(\d{6})Z$/.exec(value)?.[1];
  if (!fraction) throw new Error(`Expected a UTC microsecond timestamp: ${value}`);
  return BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * BigInt(1000) + BigInt(fraction);
}

function timestampFromMicros(value: bigint) {
  const seconds = value / BigInt(1_000_000);
  const fraction = (value % BigInt(1_000_000)).toString().padStart(6, "0");
  return `${new Date(Number(seconds * BigInt(1000))).toISOString().slice(0, 19)}.${fraction}Z`;
}

describe("Slice 46 bounded acquisition reads", () => {
  beforeAll(async () => {
    adminClient = postgres(BASE_URL, { max: 1, prepare: false });
    await adminClient.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
    const created = createDb(dbUrl.toString());
    appClient = created.client;
    services = createReviewServices(created.db);
    acquisitionReads = createAcquisitionReadServices(created.db);
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    projectId = (await services.createProject({ title: `Slice 46 read service ${randomUUID()}` })).id;
    const source = (await services.listSearchSources(projectId))[0]!;
    sourceId = source.id;
    const strategy = await services.createSearchStrategy(projectId, { searchSourceId: sourceId, name: "Acquisition read", queryText: "acquisition exact query" });
    strategyId = strategy.id;
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (adminClient) {
      await adminClient.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
      await adminClient.end();
    }
  });

  it("preserves SearchRun order and RetrievedRecord ordering across 1, 49, 50, and 51 row boundaries", async () => {
    const at = new Date("2026-02-01T12:00:00.000Z");
    for (const count of [1, 49, 50, 51]) {
      const run = await createRun(count);
      for (let index = 0; index < count; index += 1) {
        await services.createRetrievedRecord(projectId, {
          searchRunId: run.id,
          searchSourceId: sourceId,
          sourceRecordId: `s46-${count}-${index}`,
          title: `Boundary ${count} record ${index}`,
          authors: ["A".repeat(81), "Second", "Third", "Fourth"],
          abstract: "Abstract preview",
          rawCitation: "Citation preview",
          retrievedAt: at,
        });
      }
      const legacy = await services.listRetrievedRecords(projectId, run.id);
      const first = await acquisitionReads.getRetrievedRecordPage(projectId, run.id);
      const secondItems = first.nextCursor
        ? (await acquisitionReads.getRetrievedRecordPage(projectId, run.id, { cursor: first.nextCursor })).items
        : [];
      expect(first.items.length).toBe(Math.min(50, count));
      expect(first.hasMore).toBe(count > 50);
      expect([...first.items, ...secondItems].map((item: { id: string }) => item.id)).toEqual(legacy.map((item: { id: string }) => item.id));
      expect(first.items.every((item: { title: string; authorsPreview: string[] }) => item.title.length <= 200 && item.authorsPreview.length <= 3 && item.authorsPreview.every((author) => Array.from(author).length <= 80))).toBe(true);
      expect(first.items.every((item) => item.abstractPreview === "Abstract preview" && item.rawCitationPreview === "Citation preview")).toBe(true);
    }
    const runPage = await acquisitionReads.getSearchRunPage(projectId);
    expect(runPage.items.length).toBe(4);
    expect(runPage.items.map((run) => run.reportedResultCount)).toEqual([51, 50, 49, 1]);
  });

  it("uses exact search state and rejects malformed or mismatched continuation cursors", async () => {
    const run = await createRun(2);
    const firstRecord = await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: sourceId, title: "  The   Climate RECORD ", doi: "https://doi.org/10.1000/AbC", sourceRecordId: "CaseSensitive-1", retrievedAt: new Date("2026-03-01T00:00:00Z") });
    await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: sourceId, title: "Another paper", doi: "10.2000/other", sourceRecordId: "casesensitive-1", retrievedAt: new Date("2026-02-28T00:00:00Z") });
    expect((await acquisitionReads.getRetrievedRecordPage(projectId, run.id, { searchField: "title", query: "the climate record" })).items).toHaveLength(1);
    expect((await acquisitionReads.getRetrievedRecordPage(projectId, run.id, { searchField: "doi", query: "DOI:10.1000/abc" })).items).toHaveLength(1);
    expect((await acquisitionReads.getRetrievedRecordPage(projectId, run.id, { searchField: "sourceRecordId", query: "CaseSensitive-1" })).items).toHaveLength(1);
    expect((await acquisitionReads.getRetrievedRecordPage(projectId, run.id, { searchField: "sourceRecordId", query: "casesensitive-1" })).items).toHaveLength(1);
    const page = await acquisitionReads.getRetrievedRecordPage(projectId, run.id, { pageSize: 1 });
    expect(page.nextCursor).toBeTruthy();
    await expect(acquisitionReads.getRetrievedRecordPage(projectId, run.id, { pageSize: 2, cursor: page.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Page link expired or invalid. Start from the first page." });
    await expect(acquisitionReads.getRetrievedRecordPage(projectId, run.id, { pageSize: 1, searchField: "doi", query: "10.1000/abc", cursor: page.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Page link expired or invalid. Start from the first page." });
    await expect(acquisitionReads.getRetrievedRecordPage(projectId, run.id, { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Page link expired or invalid. Start from the first page." });
    await expect(acquisitionReads.getSearchRunPage(projectId, { cursor: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Page link expired or invalid. Start from the first page." });
    await expect(acquisitionReads.getRetrievedRecordPage(projectId, run.id, { cursor: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Page link expired or invalid. Start from the first page." });
    await expect(acquisitionReads.getRetrievedRecordMatchHistoryPage(projectId, run.id, firstRecord.id, { cursor: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Page link expired or invalid. Start from the first page." });
    await expect(acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, run.id, firstRecord.id, { cursor: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Page link expired or invalid. Start from the first page." });
  });

  it("preserves PostgreSQL microseconds in RetrievedRecord and candidate cursors", async () => {
    const recordRun = await createRun(2);
    const newest = await insertRetrievedRecord({ runId: recordRun.id, title: "Newest sub-millisecond record", retrievedAt: "2020-04-01T00:00:00.000900Z", createdAt: "2020-04-01T00:00:00.000000Z" });
    const older = await insertRetrievedRecord({ runId: recordRun.id, title: "Older sub-millisecond record", retrievedAt: "2020-04-01T00:00:00.000400Z", createdAt: "2020-04-01T00:00:00.000000Z" });

    const recordFirst = await acquisitionReads.getRetrievedRecordPage(projectId, recordRun.id, { pageSize: 1 });
    const recordSecond = await acquisitionReads.getRetrievedRecordPage(projectId, recordRun.id, { pageSize: 1, cursor: recordFirst.nextCursor ?? undefined });
    expect(recordFirst.nextCursor).toBeTruthy();
    expect(recordFirst.items.map((item) => item.id)).toEqual([newest]);
    expect(recordSecond.items.map((item) => item.id)).toEqual([older]);

    const recordEpochRun = await createRun(1);
    await insertRetrievedRecord({ runId: recordEpochRun.id, title: "Record epoch first", retrievedAt: "2020-07-01T00:00:00.000000Z", createdAt: "2000-01-01T00:00:00.000000Z" });
    await insertRetrievedRecord({ runId: recordEpochRun.id, title: "Record epoch second", retrievedAt: "2019-07-01T00:00:00.000000Z", createdAt: "2000-01-01T00:00:00.000000Z" });
    let recordEpochFirst = await acquisitionReads.getRetrievedRecordPage(projectId, recordEpochRun.id, { pageSize: 1 });
    let recordSnapshotAt = String(cursorPayload(recordEpochFirst.nextCursor ?? "").snapshotAt ?? "");
    let recordSnapshotMicros = timestampMicros(recordSnapshotAt);
    let recordLegacyMillis = BigInt(Date.parse(recordSnapshotAt)) * BigInt(1000);
    for (let attempt = 0; attempt < 20 && recordSnapshotMicros - recordLegacyMillis <= BigInt(1); attempt += 1) {
      recordEpochFirst = await acquisitionReads.getRetrievedRecordPage(projectId, recordEpochRun.id, { pageSize: 1 });
      recordSnapshotAt = String(cursorPayload(recordEpochFirst.nextCursor ?? "").snapshotAt ?? "");
      recordSnapshotMicros = timestampMicros(recordSnapshotAt);
      recordLegacyMillis = BigInt(Date.parse(recordSnapshotAt)) * BigInt(1000);
    }
    expect(recordEpochFirst.nextCursor).toBeTruthy();
    expect(recordSnapshotMicros - recordLegacyMillis).toBeGreaterThan(BigInt(1));
    const recordEdgeMicros = (recordSnapshotMicros + recordLegacyMillis) / BigInt(2);
    const edgeRecord = await insertRetrievedRecord({
      runId: recordEpochRun.id,
      title: "Record created at timestamp precision edge",
      retrievedAt: "2018-07-01T00:00:00.000000Z",
      createdAt: timestampFromMicros(recordEdgeMicros),
    });
    const recordEpochIds = [...recordEpochFirst.items.map((item) => item.id)];
    let recordEpochCursor = recordEpochFirst.nextCursor ?? undefined;
    while (recordEpochCursor) {
      const page = await acquisitionReads.getRetrievedRecordPage(projectId, recordEpochRun.id, { pageSize: 1, cursor: recordEpochCursor });
      recordEpochIds.push(...page.items.map((item) => item.id));
      recordEpochCursor = page.nextCursor ?? undefined;
    }
    expect(recordEdgeMicros).toBeGreaterThan(recordLegacyMillis);
    expect(recordEdgeMicros).toBeLessThan(recordSnapshotMicros);
    expect(recordEpochIds).toContain(edgeRecord);

    const candidateRun = await createRun(1);
    const candidateRecord = await insertRetrievedRecord({ runId: candidateRun.id, title: "Microsecond candidate signal", doi: "10.4000/submillisecond", retrievedAt: "2020-04-01T00:00:00.000000Z", createdAt: "2020-04-01T00:00:00.000000Z" });
    const olderPaper = await insertPaper({ title: "Older microsecond candidate", doi: "10.4000/submillisecond", createdAt: "2020-06-01T00:00:00.000100Z" });
    const newerPaper = await insertPaper({ title: "Newer microsecond candidate", doi: "10.4000/submillisecond", createdAt: "2020-06-01T00:00:00.000900Z" });

    const candidateFirst = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, candidateRun.id, candidateRecord, { pageSize: 1 });
    const candidateSecond = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, candidateRun.id, candidateRecord, { pageSize: 1, cursor: candidateFirst.nextCursor ?? undefined });
    expect(candidateFirst.nextCursor).toBeTruthy();
    expect(candidateFirst.items.map((paper) => paper.id)).toEqual([olderPaper]);
    expect(candidateSecond.items.map((paper) => paper.id)).toEqual([newerPaper]);
  });

  it("keeps record, history, and candidate continuations bound to their captured epochs", async () => {
    const recordRun = await createRun(2);
    const firstRecord = await insertRetrievedRecord({ runId: recordRun.id, title: "Epoch first record", retrievedAt: "2020-07-01T00:00:00.000000Z", createdAt: "2020-07-01T00:00:00.000000Z" });
    const secondRecord = await insertRetrievedRecord({ runId: recordRun.id, title: "Epoch second record", retrievedAt: "2020-06-30T00:00:00.000000Z", createdAt: "2020-06-30T00:00:00.000000Z" });
    const recordFirst = await acquisitionReads.getRetrievedRecordPage(projectId, recordRun.id, { pageSize: 1 });
    const lateRecord = await insertRetrievedRecord({ runId: recordRun.id, title: "After the page epoch", retrievedAt: "2020-08-01T00:00:00.000000Z", createdAt: "2099-01-01T00:00:00.000000Z" });
    const recordSecond = await acquisitionReads.getRetrievedRecordPage(projectId, recordRun.id, { pageSize: 1, cursor: recordFirst.nextCursor ?? undefined });
    expect(recordFirst.nextCursor).toBeTruthy();
    expect(recordFirst.items.map((item) => item.id)).toEqual([firstRecord]);
    expect(recordSecond.items.map((item) => item.id)).toEqual([secondRecord]);
    expect([...recordFirst.items, ...recordSecond.items].some((item) => item.id === lateRecord)).toBe(false);

    const historyRun = await createRun(1);
    const historyRecord = await services.createRetrievedRecord(projectId, { searchRunId: historyRun.id, searchSourceId: sourceId, title: "History epoch record", retrievedAt: new Date() });
    const paper = await services.addPaper(projectId, { title: "History epoch paper" });
    await services.linkRetrievedRecordToPaper(projectId, historyRecord.id, paper.id);
    await services.unlinkRetrievedRecordFromPaper(projectId, historyRecord.id, paper.id);
    const historyFirst = await acquisitionReads.getRetrievedRecordMatchHistoryPage(projectId, historyRun.id, historyRecord.id, { pageSize: 1 });
    await services.linkRetrievedRecordToPaper(projectId, historyRecord.id, paper.id);
    const historySecond = await acquisitionReads.getRetrievedRecordMatchHistoryPage(projectId, historyRun.id, historyRecord.id, { pageSize: 1, cursor: historyFirst.nextCursor ?? undefined });
    expect(historyFirst.nextCursor).toBeTruthy();
    expect(historyFirst.items.map((event) => event.action)).toEqual(["linked"]);
    expect(historySecond.items.map((event) => event.action)).toEqual(["unlinked"]);

    const candidateRun = await createRun(1);
    const candidateRecord = await insertRetrievedRecord({ runId: candidateRun.id, title: "Candidate epoch record", doi: "10.4000/epoch", retrievedAt: "2020-05-01T00:00:00.000000Z", createdAt: "2020-05-01T00:00:00.000000Z" });
    const oldCandidate = await insertPaper({ title: "Candidate epoch old paper", doi: "10.4000/epoch", createdAt: "2020-05-02T00:00:00.000000Z" });
    const otherCandidate = await insertPaper({ title: "Candidate epoch second paper", doi: "10.4000/epoch", createdAt: "2020-05-03T00:00:00.000000Z" });
    const candidateFirst = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, candidateRun.id, candidateRecord, { pageSize: 1 });
    const afterEpoch = await insertPaper({ title: "Candidate added after epoch", doi: "10.4000/epoch", createdAt: "2099-01-01T00:00:00.000000Z" });
    const candidateSecond = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, candidateRun.id, candidateRecord, { pageSize: 1, cursor: candidateFirst.nextCursor ?? undefined });
    expect(candidateFirst.nextCursor).toBeTruthy();
    expect(candidateFirst.items.map((item) => item.id)).toEqual([oldCandidate]);
    expect(candidateSecond.items.map((item) => item.id)).toEqual([otherCandidate]);
    expect([...candidateFirst.items, ...candidateSecond.items].some((item) => item.id === afterEpoch)).toBe(false);
  });

  it("uses the exact microsecond candidate timestamp epoch and match-event high-water across pages", async () => {
    const precisionRun = await createRun(1);
    const precisionRecord = await insertRetrievedRecord({ runId: precisionRun.id, title: "Candidate timestamp precision", doi: "10.4000/snapshot-precision", retrievedAt: "2020-01-01T00:00:00.000000Z", createdAt: "2020-01-01T00:00:00.000000Z" });
    await insertPaper({ title: "Precision first candidate", doi: "10.4000/snapshot-precision", createdAt: "2000-01-01T00:00:00.000000Z" });
    await insertPaper({ title: "Precision second candidate", doi: "10.4000/snapshot-precision", createdAt: "2001-01-01T00:00:00.000000Z" });

    let precisionFirst = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, precisionRun.id, precisionRecord, { pageSize: 1 });
    let snapshotAt = String(cursorPayload(precisionFirst.nextCursor ?? "").snapshotAt ?? "");
    let snapshotMicros = timestampMicros(snapshotAt);
    let legacyDateMicros = BigInt(Date.parse(snapshotAt)) * BigInt(1000);
    for (let attempt = 0; attempt < 5 && snapshotMicros === legacyDateMicros; attempt += 1) {
      precisionFirst = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, precisionRun.id, precisionRecord, { pageSize: 1 });
      snapshotAt = String(cursorPayload(precisionFirst.nextCursor ?? "").snapshotAt ?? "");
      snapshotMicros = timestampMicros(snapshotAt);
      legacyDateMicros = BigInt(Date.parse(snapshotAt)) * BigInt(1000);
    }
    expect(precisionFirst.nextCursor).toBeTruthy();
    expect(snapshotMicros).not.toBe(legacyDateMicros);
    const edgeMicros = (snapshotMicros + legacyDateMicros) / BigInt(2);
    const edgePaper = await insertPaper({ title: "Candidate at the timestamp precision edge", doi: "10.4000/snapshot-precision", createdAt: timestampFromMicros(edgeMicros) });
    const precisionIds = [...precisionFirst.items.map((item) => item.id)];
    let cursor = precisionFirst.nextCursor ?? undefined;
    while (cursor) {
      const page = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, precisionRun.id, precisionRecord, { pageSize: 1, cursor });
      precisionIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(precisionIds.includes(edgePaper)).toBe(edgeMicros <= snapshotMicros);

    const matchRun = await createRun(2);
    const focal = await services.createRetrievedRecord(projectId, { searchRunId: matchRun.id, searchSourceId: sourceId, sourceRecordId: "stable-sibling-signal", title: "Focal record", doi: "10.4000/focal-candidate", retrievedAt: new Date("2020-01-01T00:00:00.000Z") });
    const siblingRun = await createRun(1);
    const sibling = await services.createRetrievedRecord(projectId, { searchRunId: siblingRun.id, searchSourceId: sourceId, sourceRecordId: "stable-sibling-signal", title: "Sibling record", retrievedAt: new Date("2020-01-02T00:00:00.000Z") });
    const doiPaper = await insertPaper({ title: "Earlier DOI candidate", doi: "10.4000/focal-candidate", createdAt: "2000-01-01T00:00:00.000000Z" });
    const siblingPaper = await insertPaper({ title: "Stable-source sibling candidate", createdAt: "2001-01-01T00:00:00.000000Z" });
    await services.linkRetrievedRecordToPaper(projectId, sibling.id, siblingPaper);

    const matchFirst = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, matchRun.id, focal.id, { pageSize: 1 });
    expect(matchFirst.items.map((paper) => paper.id)).toEqual([doiPaper]);
    expect(matchFirst.nextCursor).toBeTruthy();
    await services.unlinkRetrievedRecordFromPaper(projectId, sibling.id, siblingPaper);
    const matchSecond = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, matchRun.id, focal.id, { pageSize: 1, cursor: matchFirst.nextCursor ?? undefined });
    expect(matchSecond.items.map((paper) => paper.id)).toEqual([siblingPaper]);
  });

  it("pins SearchRun, match-history, candidate epochs and exposes the latest-unlinked compatibility edge", async () => {
    const run = await createRun(1);
    const record = await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: sourceId, sourceRecordId: "candidate-1", title: "Candidate title", publicationYear: 2024, doi: "10.3000/candidate", retrievedAt: new Date() });
    const candidatePaper = await services.addPaper(projectId, { title: "Candidate paper", publicationYear: 2024, doi: "10.3000/candidate" });
    await services.linkRetrievedRecordToPaper(projectId, record.id, candidatePaper.id);
    const linkedCandidates = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, run.id, record.id);
    expect(linkedCandidates.items.map((paper) => paper.id)).not.toContain(candidatePaper.id);
    await services.unlinkRetrievedRecordFromPaper(projectId, record.id, candidatePaper.id);
    const detail = await acquisitionReads.getRetrievedRecordDetail(projectId, run.id, record.id);
    expect(detail?.currentMatch).toBeNull();
    const history = await acquisitionReads.getRetrievedRecordMatchHistoryPage(projectId, run.id, record.id);
    expect(history.items.map((event) => event.action)).toEqual(["linked", "unlinked"]);
    expect(history.items[0]?.paperId).toBe(candidatePaper.id);
    const candidates = await acquisitionReads.getRetrievedRecordDuplicateCandidatePage(projectId, run.id, record.id);
    expect(candidates.items.map((paper) => paper.id)).toContain(candidatePaper.id);
    expect((await services.findRetrievedRecordDuplicateCandidates(projectId, record.id)).map((paper) => paper.id)).not.toContain(candidatePaper.id);

    const runPage = await acquisitionReads.getSearchRunPage(projectId, { pageSize: 1 });
    const epochRun = await createRun(99);
    expect(runPage.items.map((item) => item.id)).not.toContain(epochRun.id);
    if (runPage.nextCursor) {
      const next = await acquisitionReads.getSearchRunPage(projectId, { pageSize: 1, cursor: runPage.nextCursor });
      expect(next.items.map((item) => item.id)).not.toContain(epochRun.id);
    }
    await expect(acquisitionReads.getRetrievedRecordDetail(projectId, epochRun.id, record.id)).resolves.toBeNull();
  });
});
