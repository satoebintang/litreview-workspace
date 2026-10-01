import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Database } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createDeduplicationReadServices } from "@/application/deduplication-read-services";
import { DeduplicationDecisionRepository } from "@/application/deduplication-repositories";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const TEST_DB_NAME = `slice49_dedup_read_${process.pid}_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
const FIRST_UNSAFE_SEQUENCE = "9007199254740992";
let db!: ReturnType<typeof createDb>["db"];
let appClient!: postgres.Sql;
let services!: ReturnType<typeof createReviewServices>;

type FixtureContext = { projectId: string; sourceId: string; runIds: [string, string] };
type RecordInput = {
  id: string;
  runId: string;
  sourceRecordId: string | null;
  title: string;
  doi: string | null;
  publicationYear: number | null;
  authors?: string[];
};
type SeedPair = { left: RecordInput; right: RecordInput; mask: number };
type LegacyQueueItem = {
  leftRetrievedRecord: { id: string };
  rightRetrievedRecord: { id: string };
  reasons: string[];
  strength: "strong" | "possible";
  leftPaperId: string | null;
  rightPaperId: string | null;
};

function legacyProjection(items: LegacyQueueItem[]) {
  return items.map((item) => ({
    leftId: item.leftRetrievedRecord.id,
    rightId: item.rightRetrievedRecord.id,
    reasons: item.reasons,
    strength: item.strength,
    leftPaperId: item.leftPaperId,
    rightPaperId: item.rightPaperId,
  }));
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

async function createFixtureContext(name: string): Promise<FixtureContext> {
  const project = await services.createProject({ title: `Slice 49 ${name}` });
  const source = (await services.listSearchSources(project.id))[0];
  if (!source) throw new Error("Project did not receive a default SearchSource");
  const strategy = await services.createSearchStrategy(project.id, {
    searchSourceId: source.id,
    name: `Slice 49 ${name}`,
    queryText: "slice 49 bounded deduplication",
  });
  const createRun = async (suffix: string) => services.createSearchRun(project.id, {
    searchSourceId: source.id,
    sourceKeySnapshot: source.sourceKey,
    sourceDisplayNameSnapshot: source.displayName,
    strategyId: strategy.id,
    queryText: strategy.queryText,
    reportedResultCount: 100,
    executedAt: new Date(`2026-01-01T00:00:${suffix}.000Z`),
  });
  const first = await createRun("00");
  const second = await createRun("01");
  return { projectId: project.id, sourceId: source.id, runIds: [first.id, second.id] };
}

async function insertRecord(context: FixtureContext, record: RecordInput): Promise<void> {
  await appClient.unsafe(
    `insert into retrieved_records
      (id, project_id, search_run_id, search_source_id, source_record_id, title, authors, doi, publication_year, retrieved_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text[], $8::text, $9::integer, '2026-01-01T00:00:00Z'::timestamptz)`,
    [record.id, context.projectId, record.runId, context.sourceId, record.sourceRecordId, record.title, record.authors ?? [], record.doi, record.publicationYear],
  );
}

async function seedPair(context: FixtureContext, base: number, mask: number, titleSuffix = String(base)): Promise<SeedPair> {
  const sharedSource = `source-${base}`;
  const sharedDoi = `10.3900/slice49-${base}`;
  const sharedTitle = `Normalized title boundary ${titleSuffix}`;
  const left: RecordInput = {
    id: uuid(base), runId: context.runIds[0],
    sourceRecordId: mask & 2 ? sharedSource : `source-${base}-left`,
    title: mask & 4 ? `  ${sharedTitle.toUpperCase().replace(" TITLE", "\nTITLE")} ` : `Unique left title ${base}`,
    doi: mask & 1 ? ` DOI: ${sharedDoi.toUpperCase()} ` : null,
    publicationYear: mask & 4 ? 2021 : null,
    authors: [`First author ${base}`, `Second author ${base}`, `Third author ${base}`, `Ignored author ${base}`],
  };
  const right: RecordInput = {
    id: uuid(base + 1), runId: context.runIds[1],
    sourceRecordId: mask & 2 ? sharedSource : `source-${base}-right`,
    title: mask & 4 ? `normalized   title boundary ${titleSuffix}` : `Unique right title ${base}`,
    doi: mask & 1 ? `https://dx.doi.org/${sharedDoi}` : null,
    publicationYear: mask & 4 ? 2021 : null,
    authors: [`First coauthor ${base}`, `Second coauthor ${base}`, `Third coauthor ${base}`],
  };
  await insertRecord(context, left);
  await insertRecord(context, right);
  return { left, right, mask };
}

function projection(items: Array<{
  leftRetrievedRecord: { id: string; currentPaperId: string | null };
  rightRetrievedRecord: { id: string; currentPaperId: string | null };
  reasons: string[];
  strength: string;
}>) {
  return items.map((item) => ({
    leftId: item.leftRetrievedRecord.id,
    rightId: item.rightRetrievedRecord.id,
    reasons: item.reasons,
    strength: item.strength,
    leftPaperId: item.leftRetrievedRecord.currentPaperId,
    rightPaperId: item.rightRetrievedRecord.currentPaperId,
  }));
}

async function readAllPages(projectId: string, pageSize: number) {
  const pages: Awaited<ReturnType<typeof services.listDeduplicationQueuePage>>[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < 500; index += 1) {
    const page = await services.listDeduplicationQueuePage(projectId, { pageSize, cursor });
    pages.push(page);
    if (!page.hasMore) return pages;
    if (!page.nextCursor) throw new Error("A non-final bounded page did not provide a cursor");
    cursor = page.nextCursor;
  }
  throw new Error("Bounded queue exceeded the pagination safety limit");
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function cursorToken(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("Slice 49 bounded Deduplication reads", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, prepare: false });
    try {
      await admin.unsafe(`create database "${TEST_DB_NAME}"`);
    } finally {
      await admin.end();
    }
    const created = createDb(TEST_DB_URL);
    db = created.db;
    appClient = created.client;
    services = createReviewServices(db);
    await migrate(db, { migrationsFolder: "./drizzle" });
  }, 120_000);

  afterAll(async () => {
    if (appClient) await appClient.end();
    const admin = postgres(BASE_URL, { max: 1, prepare: false });
    try { await admin.unsafe(`drop database if exists "${TEST_DB_NAME}" with (force)`); } finally { await admin.end(); }
  });

  it("matches every released signal combination and preserves the strong-to-possible boundary", async () => {
    const context = await createFixtureContext("signal combinations");
    const pairs: SeedPair[] = [];
    for (let mask = 1; mask <= 7; mask += 1) {
      const base = mask === 4 ? 100 : 1_000 + mask * 10;
      pairs.push(await seedPair(context, base, mask));
    }

    const allLegacy = await services.listDeduplicationQueue(context.projectId) as LegacyQueueItem[];
    const allLegacyProjection = legacyProjection(allLegacy);
    expect(allLegacyProjection).toHaveLength(7);
    for (const pair of pairs) {
      const found = allLegacyProjection.find((item) => item.leftId === pair.left.id && item.rightId === pair.right.id);
      const expected = [1, 2, 4].flatMap((bit, index) => pair.mask & bit ? [["normalized_doi", "same_source_record_id", "normalized_title_year"][index]] : []);
      expect(found?.reasons).toEqual(expected);
      expect(found?.strength).toBe(pair.mask & 3 ? "strong" : "possible");
    }

    const reviewed = pairs.find((pair) => pair.mask === 7)!;
    await services.decideDifferentWork(context.projectId, reviewed.left.id, reviewed.right.id, "all three signals, reviewed");
    const mappedPair = pairs.find((pair) => pair.mask === 1)!;
    const paper = await services.addPaper(context.projectId, { title: "Latest mapping fixture" });
    await services.linkRetrievedRecordToPaper(context.projectId, mappedPair.left.id, paper.id);
    await services.unlinkRetrievedRecordFromPaper(context.projectId, mappedPair.left.id, paper.id);

    const pageOne = await services.listDeduplicationQueuePage(context.projectId, { pageSize: 3 });
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toBeTruthy();
    const pageTwo = await services.listDeduplicationQueuePage(context.projectId, { pageSize: 3, cursor: pageOne.nextCursor });
    expect(pageTwo.items.map((item) => item.strength)).toEqual(["strong", "strong", "possible"]);
    expect(pageTwo.hasMore).toBe(false);
    const pages = [pageOne, pageTwo];
    const legacy = await services.listDeduplicationQueue(context.projectId) as LegacyQueueItem[];
    const compatibility = await new DeduplicationDecisionRepository(db).listCandidates(context.projectId, true) as Array<Record<string, unknown>>;
    const reviewedCompatibility = compatibility.find((item) => String(item.left_record_id) === reviewed.left.id && String(item.right_record_id) === reviewed.right.id);
    expect(compatibility).toHaveLength(7);
    expect(reviewedCompatibility).toMatchObject({
      reasons: ["normalized_doi", "same_source_record_id", "normalized_title_year"],
      strength: "strong",
      decision: "different_work",
    });
    expect(await new DeduplicationDecisionRepository(db).listCandidates(context.projectId, false)).toHaveLength(6);
    expect(projection(pages.flatMap((page) => page.items))).toEqual(legacyProjection(legacy));
    expect(pages.flatMap((page) => page.items).some((item) => item.leftRetrievedRecord.id === reviewed.left.id || item.rightRetrievedRecord.id === reviewed.right.id)).toBe(false);
    const mappedItem = pages.flatMap((page) => page.items).find((item) => item.leftRetrievedRecord.id === mappedPair.left.id || item.rightRetrievedRecord.id === mappedPair.left.id)!;
    const mappedSide = mappedItem.leftRetrievedRecord.id === mappedPair.left.id ? mappedItem.leftRetrievedRecord : mappedItem.rightRetrievedRecord;
    expect(mappedSide).toMatchObject({ mappingStatus: "unlinked", currentPaperId: null });
    await expect(services.getDeduplicationPairForPage(context.projectId, reviewed.left.id, reviewed.right.id)).resolves.toMatchObject({
      decision: "different_work",
      decisionId: expect.any(String),
    });

    const [summary, overview] = await Promise.all([
      services.getReviewFlowSummary(context.projectId),
      services.getProjectOverview(context.projectId),
    ]);
    expect(summary.unresolvedDuplicatePairs).toBe(legacy.length);
    expect(overview.screening.unresolvedDuplicatePairCount).toBe(legacy.length);

    const otherProject = await createFixtureContext("Project isolation");
    await seedPair(otherProject, 70_000, 1, "other Project");
    expect(await services.listDeduplicationQueue(otherProject.projectId)).toHaveLength(1);
    expect((await services.listDeduplicationQueuePage(context.projectId)).items).toHaveLength(6);

    const nonCandidateLeft = { ...pairs[0]!.left, id: uuid(2_000), title: "Never a candidate", doi: null, sourceRecordId: "never-candidate-left", publicationYear: null };
    const nonCandidateRight = { ...pairs[0]!.right, id: uuid(2_001), title: "Different record", doi: null, sourceRecordId: "never-candidate-right", publicationYear: 2022 };
    await insertRecord(context, nonCandidateLeft);
    await insertRecord(context, nonCandidateRight);
    await expect(services.getDeduplicationPairForPage(context.projectId, nonCandidateLeft.id, nonCandidateRight.id)).resolves.toMatchObject({
      leftRetrievedRecord: { id: nonCandidateLeft.id },
      rightRetrievedRecord: { id: nonCandidateRight.id },
    });
  }, 60_000);

  it("traverses fixed-seed randomized queues with exact reasons, strength, decisions and mappings", async () => {
    for (const seed of [0x49a11, 0x51ce]) {
      const context = await createFixtureContext(`random seed ${seed}`);
      const next = random(seed);
      const pairs: SeedPair[] = [];
      for (let index = 0; index < 28; index += 1) {
        const mask = next() % 8;
        pairs.push(await seedPair(context, 10_000 + seed * 100 + index * 2, mask, `randomized ${index}`));
      }

      const decisions = new Map<string, "same_work" | "different_work">();
      for (const pair of pairs) {
        if (pair.mask === 0 || next() % 5 !== 0) continue;
        if (next() % 2 === 0) {
          decisions.set(pair.left.id, "same_work");
          await services.confirmSameWork(context.projectId, pair.left.id, pair.right.id, `same work ${seed}-${pair.left.id}`);
        } else {
          decisions.set(pair.left.id, "different_work");
          await services.decideDifferentWork(context.projectId, pair.left.id, pair.right.id, `different work ${seed}-${pair.left.id}`);
        }
      }

      for (const pair of pairs) {
        if (next() % 4 === 0) continue;
        const leftPaper = await services.addPaper(context.projectId, { title: `Randomized Paper ${seed}-${pair.left.id}` });
        await services.linkRetrievedRecordToPaper(context.projectId, pair.left.id, leftPaper.id);
        const decision = decisions.get(pair.left.id);
        if (next() % 3 === 0) {
          await services.unlinkRetrievedRecordFromPaper(context.projectId, pair.left.id, leftPaper.id);
        }
        if (next() % 2 === 0 && pair.mask !== 0) {
          if (decision === "same_work") {
            await services.linkRetrievedRecordToPaper(context.projectId, pair.right.id, leftPaper.id);
          } else {
            const rightPaper = await services.addPaper(context.projectId, { title: `Randomized right Paper ${seed}-${pair.right.id}` });
            await services.linkRetrievedRecordToPaper(context.projectId, pair.right.id, rightPaper.id);
          }
        }
      }

      const legacy = await services.listDeduplicationQueue(context.projectId) as LegacyQueueItem[];
      const pages = await readAllPages(context.projectId, 4);
      expect(projection(pages.flatMap((page) => page.items))).toEqual(legacyProjection(legacy));
      const ids = pages.flatMap((page) => page.items).map((item) => `${item.leftRetrievedRecord.id}/${item.rightRetrievedRecord.id}`);
      expect(new Set(ids).size).toBe(ids.length);
      expect(pages.every((page) => page.items.length <= 4)).toBe(true);
    }
  }, 120_000);

  it("returns exactly N*(N-1)/2 pairs for a manageable dense fixture", async () => {
    const context = await createFixtureContext("dense 30");
    const count = 30;
    for (let index = 0; index < count; index += 1) {
      const noisyField = `${"\u{1F9EA}\n\t\"\\ ".repeat(index === 0 ? 180 : 0)}Dense paper ${index}`;
      await insertRecord(context, {
        id: uuid(30_000 + index), runId: context.runIds[index % 2], sourceRecordId: index === 0 ? `${"S".repeat(200)}-${index}` : `dense-${index}`,
        title: noisyField, authors: index === 0 ? [noisyField, noisyField, noisyField, "fourth author is omitted"] : [`Author ${index}`],
        doi: `10.3900/${"d".repeat(280)}`, publicationYear: null,
      });
    }
    const legacy = await services.listDeduplicationQueue(context.projectId) as LegacyQueueItem[];
    expect(legacy).toHaveLength(count * (count - 1) / 2);
    const pages = await readAllPages(context.projectId, 50);
    const paged = pages.flatMap((page) => page.items);
    expect(projection(paged)).toEqual(legacyProjection(legacy));
    expect(new Set(paged.map((item) => `${item.leftRetrievedRecord.id}/${item.rightRetrievedRecord.id}`)).size).toBe(count * (count - 1) / 2);
    expect(paged.every((item) => item.reasons.join(",") === "normalized_doi" && item.strength === "strong")).toBe(true);
    for (const item of paged.slice(0, 50)) {
      for (const record of [item.leftRetrievedRecord, item.rightRetrievedRecord]) {
        expect(Array.from(record.title)).toHaveLength(Math.min(230, Array.from(record.title).length));
        expect(Array.from(record.authors)).toHaveLength(Math.min(230, Array.from(record.authors).length));
        expect(Array.from(record.doi ?? "").length).toBeLessThanOrEqual(200);
        expect(Array.from(record.sourceRecordId ?? "").length).toBeLessThanOrEqual(160);
      }
    }
    const maximum = await services.listDeduplicationQueuePage(context.projectId, { pageSize: 999 });
    expect(maximum.pageSize).toBe(50);
    expect(Buffer.byteLength(JSON.stringify(maximum), "utf8")).toBeLessThanOrEqual(512 * 1024);
  }, 60_000);

  it("binds cursors before reads and treats queue membership as live across requests", async () => {
    const context = await createFixtureContext("live cursor");
    const firstPair = await seedPair(context, 40_000, 1, "first");
    const secondPair = await seedPair(context, 41_000, 1, "second");
    const pageOne = await services.listDeduplicationQueuePage(context.projectId, { pageSize: 1 });
    expect(pageOne.items[0]?.leftRetrievedRecord.id).toBe(firstPair.left.id);
    expect(pageOne.hasMore).toBe(true);
    const cursor = pageOne.nextCursor!;
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    const otherProject = await createFixtureContext("wrong cursor project");
    const noRead = createDeduplicationReadServices({
      transaction: () => { throw new Error("database read occurred before cursor validation"); },
    } as unknown as Database);
    const malformed = ["", "not-base64!", "A".repeat(257), cursorToken({ ...decoded, v: 2 }), cursorToken({ ...decoded, f: "strong" }), cursorToken({ ...decoded, s: 2 })];
    for (const value of malformed) {
      await expect(noRead.listDeduplicationQueuePage(context.projectId, { pageSize: 1, cursor: value })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(noRead.listDeduplicationQueuePage(otherProject.projectId, { pageSize: 1, cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(noRead.listDeduplicationQueuePage(context.projectId, { pageSize: 2, cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const before = await seedPair(context, 39_000, 1, "inserted before cursor");
    const after = await seedPair(context, 40_500, 1, "inserted after cursor");
    const paper = await services.addPaper(context.projectId, { title: "Live cursor mapping" });
    await services.linkRetrievedRecordToPaper(context.projectId, after.left.id, paper.id);
    await services.decideDifferentWork(context.projectId, secondPair.left.id, secondPair.right.id, "adjudicated between pages");

    const pageTwo = await services.listDeduplicationQueuePage(context.projectId, { pageSize: 1, cursor });
    expect(pageTwo.items).toHaveLength(1);
    expect(pageTwo.items[0]?.leftRetrievedRecord.id).toBe(after.left.id);
    expect(pageTwo.items[0]?.leftRetrievedRecord.currentPaperId ?? pageTwo.items[0]?.rightRetrievedRecord.currentPaperId).toBe(paper.id);
    expect(pageTwo.hasMore).toBe(false);
    const restarted = await services.listDeduplicationQueuePage(context.projectId, { pageSize: 1 });
    expect(restarted.items[0]?.leftRetrievedRecord.id).toBe(before.left.id);
    expect(restarted.items.some((item) => item.leftRetrievedRecord.id === secondPair.left.id || item.rightRetrievedRecord.id === secondPair.right.id)).toBe(false);

    const possibleContext = await createFixtureContext("possible-only cursor");
    const p1 = await seedPair(possibleContext, 50_000, 4, "possible first");
    const p2 = await seedPair(possibleContext, 50_100, 4, "possible second");
    const possiblePageOne = await services.listDeduplicationQueuePage(possibleContext.projectId, { pageSize: 1 });
    expect(possiblePageOne.items[0]?.leftRetrievedRecord.id).toBe(p1.left.id);
    const possiblePageTwo = await services.listDeduplicationQueuePage(possibleContext.projectId, { pageSize: 1, cursor: possiblePageOne.nextCursor });
    expect(possiblePageTwo.items[0]?.leftRetrievedRecord.id).toBe(p2.left.id);
    expect(possiblePageTwo.hasMore).toBe(false);
  }, 60_000);

  it("pages exact history with lossless BIGINT cursors and scopes complete notes to the exact event", async () => {
    const context = await createFixtureContext("history and bigint");
    const pair = await seedPair(context, 60_000, 0, "never candidate");
    const longNote = `legacy note ${"\u{1F9EA}".repeat(700)}`;
    const firstEvent = await services.confirmSameWork(context.projectId, pair.left.id, pair.right.id, longNote);
    if (!firstEvent) throw new Error("The same-work audit event was not returned");
    const initialSequence = String(firstEvent.sequence);
    const sequenceRows = await appClient`select pg_get_serial_sequence('retrieved_record_deduplication_decisions', 'sequence') as sequence_name`;
    await appClient.unsafe(
      "select setval($1::regclass, $2::bigint, true)",
      [String(sequenceRows[0]?.sequence_name), (BigInt(FIRST_UNSAFE_SEQUENCE) - BigInt(1)).toString()],
    );
    const secondEvent = await services.decideDifferentWork(context.projectId, pair.left.id, pair.right.id, "correction one");
    const thirdEvent = await services.confirmSameWork(context.projectId, pair.left.id, pair.right.id, "correction two");
    if (!secondEvent || !thirdEvent) throw new Error("A correction event was not returned");
    const ids = [firstEvent.id, secondEvent.id, thirdEvent.id].map(String);

    const historyOne = await services.listDeduplicationHistoryPage(context.projectId, pair.left.id, pair.right.id, { pageSize: 2 });
    expect(historyOne.items.map((item) => item.sequence)).toEqual([initialSequence, FIRST_UNSAFE_SEQUENCE]);
    expect(historyOne.items[0]).toMatchObject({ noteTruncated: true });
    expect(Array.from(historyOne.items[0]!.notePreview ?? "")).toHaveLength(600);
    expect(historyOne.hasMore).toBe(true);
    const boundary = JSON.parse(Buffer.from(historyOne.nextCursor!, "base64url").toString("utf8")) as { s: string };
    expect(boundary.s).toBe(FIRST_UNSAFE_SEQUENCE);
    const historyTwo = await services.listDeduplicationHistoryPage(context.projectId, pair.left.id, pair.right.id, { pageSize: 2, cursor: historyOne.nextCursor });
    expect(historyTwo.items.map((item) => item.sequence)).toEqual([(BigInt(FIRST_UNSAFE_SEQUENCE) + BigInt(1)).toString()]);
    expect(historyTwo.hasMore).toBe(false);

    const exact = await services.getDeduplicationDecisionEvent(context.projectId, pair.left.id, pair.right.id, ids[0]!);
    expect(exact.note).toBe(longNote);
    expect(exact.sequence).toBe(initialSequence);
    const other = await createFixtureContext("wrong exact event scope");
    await expect(services.getDeduplicationDecisionEvent(other.projectId, pair.left.id, pair.right.id, ids[0]!)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await expect(services.getDeduplicationDecisionEvent(context.projectId, uuid(61_000), uuid(61_001), ids[0]!)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });

    const noRead = createDeduplicationReadServices({
      transaction: () => { throw new Error("database read occurred before history cursor validation"); },
    } as unknown as Database);
    await expect(noRead.listDeduplicationHistoryPage(context.projectId, pair.left.id, pair.right.id, { cursor: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(noRead.listDeduplicationHistoryPage(context.projectId, pair.left.id, pair.right.id, { cursor: "A".repeat(513) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(noRead.listDeduplicationHistoryPage(other.projectId, pair.left.id, pair.right.id, { cursor: historyOne.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(noRead.listDeduplicationHistoryPage(context.projectId, uuid(61_000), uuid(61_001), { cursor: historyOne.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(noRead.listDeduplicationHistoryPage(context.projectId, pair.left.id, pair.right.id, { pageSize: 3, cursor: historyOne.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  }, 60_000);
});
