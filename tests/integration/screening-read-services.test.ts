import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createReviewServices } from "@/application/services";
import { createScreeningReadServices } from "@/application/screening-read-services";
import type { Database } from "@/db/client";
import { papers, schema } from "@/db/schema";
import type { ReviewTransaction } from "@/application/review-services/shared";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const queryLog: string[] = [];
const client = postgres(databaseUrl, {
  max: 5,
  prepare: false,
  debug: (_connection, query) => { queryLog.push(query); },
});
const db = drizzle(client, { schema }) as Database;
const reviewServices = createReviewServices(db);
const screeningReads = createScreeningReadServices(db);

function coreSelects() {
  return queryLog.filter((query) => /^(with|select)\b/i.test(query.trim()));
}

function paperFixture(projectId: string, title: string, createdAt: Date) {
  return {
    projectId,
    title,
    authors: [`Author for ${title}`],
    publicationYear: 2024,
    venue: "Private venue",
    doi: `10.5555/${randomUUID()}`,
    abstract: `Private abstract for ${title}`,
    bibliographicNote: `Private note for ${title}`,
    createdAt,
    updatedAt: createdAt,
  };
}

async function insertPaper(projectId: string, title: string, createdAt = new Date()) {
  const [paper] = await db.insert(papers).values(paperFixture(projectId, title, createdAt)).returning({
    id: papers.id,
    title: papers.title,
  });
  return paper;
}

async function insertPapers(projectId: string, count: number) {
  if (count === 0) return [];
  const createdAt = new Date("2020-01-01T00:00:00.000Z");
  return db.insert(papers).values(Array.from({ length: count }, (_, index) => paperFixture(projectId, `Boundary Paper ${index + 1}`, createdAt))).returning({
    id: papers.id,
    title: papers.title,
  });
}

async function createProject(label: string) {
  return reviewServices.createProject({ title: `Slice 44 ${label} ${randomUUID()}` });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function databasePausedAfterFirstSelect(afterFirstSelect: () => void, continueTransaction: Promise<void>): Database {
  return {
    transaction<T>(callback: (tx: ReviewTransaction) => Promise<T>, options?: Parameters<Database["transaction"]>[1]): Promise<T> {
      return db.transaction(async (tx) => {
        let paused = false;
        const gatedTransaction = {
          execute: async (...args: Parameters<typeof tx.execute>) => {
            const result = await tx.execute(...args);
            if (!paused) {
              paused = true;
              afterFirstSelect();
              await continueTransaction;
            }
            return result;
          },
        } as unknown as ReviewTransaction;
        return callback(gatedTransaction);
      }, options);
    },
  } as unknown as Database;
}

function databaseObservingResults(
  recordOptions: (options: Parameters<Database["transaction"]>[1] | undefined) => void,
  recordRowCount: (count: number) => void,
): Database {
  return {
    async execute(...args: Parameters<Database["execute"]>) {
      const result = await db.execute(...args);
      if (Array.isArray(result)) recordRowCount(result.length);
      return result;
    },
    transaction<T>(callback: (tx: ReviewTransaction) => Promise<T>, options?: Parameters<Database["transaction"]>[1]): Promise<T> {
      recordOptions(options);
      return db.transaction(async (tx) => callback({
        execute: async (...args: Parameters<typeof tx.execute>) => {
          const result = await tx.execute(...args);
          if (Array.isArray(result)) recordRowCount(result.length);
          return result;
        },
      } as unknown as ReviewTransaction), options);
    },
  } as unknown as Database;
}

describe("Slice 44 title/abstract screening read services", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    await Promise.all(Array.from({ length: 5 }, () => client.unsafe("select 1")));
  }, 120_000);

  afterAll(async () => { await client.end(); }, 120_000);

  it("matches the released screening list across all states, repeated decisions, pages, and timestamp ties", async () => {
    const project = await createProject("equivalence");
    const sameTimestamp = new Date("2021-04-05T06:07:08.000Z");
    const fixture = new Map<string, string>();
    for (const title of ["A unscreened", "B included", "C excluded", "D maybe", "E included latest", "F excluded latest", "G maybe latest", "H unscreened", "I unscreened"]) {
      fixture.set(title, (await insertPaper(project.id, title, sameTimestamp)).id);
    }
    const otherProject = await createProject("equivalence-foreign");
    await insertPaper(otherProject.id, "Foreign included Paper", sameTimestamp);
    await reviewServices.recordScreeningDecision(otherProject.id, (await insertPaper(otherProject.id, "Foreign screened Paper", sameTimestamp)).id, { decision: "include" });
    const excludedCriterion = await reviewServices.createScreeningCriterion(project.id, { type: "exclusion", text: "Outside population" });
    const decision = async (title: string, value: "include" | "exclude" | "maybe") => {
      const paperId = fixture.get(title)!;
      if (value === "exclude") return reviewServices.recordScreeningDecision(project.id, paperId, { decision: "exclude", exclusionCriterionId: excludedCriterion.id });
      return reviewServices.recordScreeningDecision(project.id, paperId, { decision: value });
    };

    await decision("B included", "maybe");
    await decision("B included", "include");
    await decision("C excluded", "include");
    await decision("C excluded", "exclude");
    await decision("D maybe", "include");
    await decision("D maybe", "maybe");
    await decision("E included latest", "exclude");
    await decision("E included latest", "include");
    await decision("F excluded latest", "maybe");
    await decision("F excluded latest", "exclude");
    await decision("G maybe latest", "exclude");
    await decision("G maybe latest", "maybe");

    const beforeFullText = await screeningReads.getScreeningQueuePage(project.id, { pageSize: 100 });
    await reviewServices.recordFullTextRetrievalAttempt(project.id, fixture.get("B included")!, { outcome: "retrieved", attemptedAt: sameTimestamp });
    await reviewServices.recordFullTextScreeningDecision(project.id, fixture.get("B included")!, { decision: "include" });

    const legacy = await reviewServices.listScreeningPapers(project.id);
    expect((await screeningReads.getScreeningQueuePage(project.id, { pageSize: 100 })).items).toEqual(beforeFullText.items);
    const expectedCounts = {
      all: legacy.length,
      unscreened: legacy.filter((paper) => paper.screeningState === "unscreened").length,
      included: legacy.filter((paper) => paper.screeningState === "included").length,
      excluded: legacy.filter((paper) => paper.screeningState === "excluded").length,
      maybe: legacy.filter((paper) => paper.screeningState === "maybe").length,
    };
    const expectedStart = legacy.find((paper) => paper.screeningState === "unscreened")?.id ?? legacy[0]?.id ?? null;

    for (const state of ["all", "unscreened", "included", "excluded", "maybe"] as const) {
      const expected = state === "all" ? legacy : legacy.filter((paper) => paper.screeningState === state);
      const first = await screeningReads.getScreeningQueuePage(project.id, { state, page: 1, pageSize: 2 });
      expect(first.state).toBe(state);
      expect(first.totalCount).toBe(expected.length);
      expect(first.totalPages).toBe(Math.ceil(expected.length / 2));
      expect(first.counts).toEqual(expectedCounts);
      expect(first.startPaperId).toBe(expectedStart);

      const pagedItems = [];
      for (let page = 1; page <= first.totalPages; page += 1) {
        const result = await screeningReads.getScreeningQueuePage(project.id, { state, page, pageSize: 2 });
        const expectedPage = expected.slice((page - 1) * 2, page * 2);
        expect(result.page).toBe(page);
        expect(result.from).toBe(expected.length === 0 ? 0 : (page - 1) * 2 + 1);
        expect(result.to).toBe(expected.length === 0 ? 0 : Math.min(page * 2, expected.length));
        expect(result.hasPrevious).toBe(page > 1);
        expect(result.hasNext).toBe(page < first.totalPages);
        expect(result.items).toEqual(expectedPage.map((paper) => ({
          id: paper.id,
          title: paper.title,
          authors: paper.authors,
          publicationYear: paper.publicationYear,
          screeningState: paper.screeningState,
        })));
        pagedItems.push(...result.items);
      }
      expect(pagedItems.map((paper) => paper.id)).toEqual(expected.map((paper) => paper.id));
      if (first.items.length > 0) {
        expect(Object.keys(first.items[0]).sort()).toEqual(["authors", "id", "publicationYear", "screeningState", "title"]);
      }
    }
    expect(JSON.stringify(await screeningReads.getScreeningQueuePage(project.id, { pageSize: 100 }))).not.toMatch(/Private abstract|Private note|Private venue/);
  });

  it("returns global ordinal and adjacent Papers with one query, including equal timestamps", async () => {
    const project = await createProject("navigation");
    const timestamp = new Date("2022-02-02T02:02:02.000Z");
    for (let index = 0; index < 5; index += 1) await insertPaper(project.id, `Navigation Paper ${index + 1}`, timestamp);
    const legacy = await reviewServices.listScreeningPapers(project.id);

    for (const index of [0, 2, 4]) {
      queryLog.length = 0;
      const actual = await screeningReads.getScreeningPaperNavigation(project.id, legacy[index].id);
      expect(actual).toEqual({
        paperId: legacy[index].id,
        position: index + 1,
        totalCount: legacy.length,
        previousPaperId: legacy[index - 1]?.id ?? null,
        nextPaperId: legacy[index + 1]?.id ?? null,
      });
      expect(coreSelects()).toHaveLength(1);
      expect(coreSelects()[0]).not.toMatch(/row_number|rank\s*\(/i);
    }

    const foreignProject = await createProject("navigation-foreign");
    const foreignPaper = await insertPaper(foreignProject.id, "Foreign navigation Paper", timestamp);
    expect(await screeningReads.getScreeningPaperNavigation(project.id, foreignPaper.id)).toBeNull();
    expect(await screeningReads.getScreeningPaperNavigation(project.id, randomUUID())).toBeNull();
  });

  it("validates both navigation IDs before SQL and preserves missing Project versus Paper behavior", async () => {
    const project = await createProject("navigation-errors");
    const invalidInputs = [
      ["not-a-uuid", randomUUID()],
      [project.id, "not-a-uuid"],
      ["not-a-uuid", "also-not-a-uuid"],
    ];
    for (const [projectId, paperId] of invalidInputs) {
      queryLog.length = 0;
      await expect(screeningReads.getScreeningPaperNavigation(projectId, paperId)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(coreSelects()).toHaveLength(0);
    }

    queryLog.length = 0;
    await expect(screeningReads.getScreeningPaperNavigation(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(coreSelects()).toHaveLength(1);
    queryLog.length = 0;
    await expect(screeningReads.getScreeningQueuePage(randomUUID())).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(coreSelects()).toHaveLength(1);
  });

  it("reports exact empty and boundary counts and normalizes invalid pagination", async () => {
    for (const count of [0, 1, 49, 50, 51]) {
      const project = await createProject(`boundary-${count}`);
      await insertPapers(project.id, count);
      queryLog.length = 0;
      const first = await screeningReads.getScreeningQueuePage(project.id, { pageSize: 50 });
      expect(first.totalCount).toBe(count);
      expect(first.counts).toEqual({ all: count, unscreened: count, included: 0, excluded: 0, maybe: 0 });
      expect(first.items).toHaveLength(Math.min(count, 50));
      expect(first.totalPages).toBe(Math.ceil(count / 50));
      expect(first.from).toBe(count === 0 ? 0 : 1);
      expect(first.to).toBe(Math.min(count, 50));
      expect(first.startPaperId).toBe(count === 0 ? null : first.items[0].id);
      expect(coreSelects()).toHaveLength(2);
      if (count === 51) {
        const last = await screeningReads.getScreeningQueuePage(project.id, { page: 2, pageSize: 50 });
        expect(last.items).toHaveLength(1);
        expect(last.from).toBe(51);
        expect(last.to).toBe(51);
        expect(last.hasPrevious).toBe(true);
        expect(last.hasNext).toBe(false);
      }
    }

    const project = await createProject("pagination-normalization");
    await insertPapers(project.id, 51);
    expect(await screeningReads.getScreeningQueuePage(project.id, { page: 0, pageSize: 0 })).toMatchObject({ page: 1, pageSize: 50 });
    expect(await screeningReads.getScreeningQueuePage(project.id, { page: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({ page: 1 });
    expect(await screeningReads.getScreeningQueuePage(project.id, { pageSize: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({ pageSize: 50 });
    expect(await screeningReads.getScreeningQueuePage(project.id, { page: -1 })).toMatchObject({ page: 1 });
    expect(await screeningReads.getScreeningQueuePage(project.id, { page: "not-a-page" })).toMatchObject({ page: 1 });
    expect(await screeningReads.getScreeningQueuePage(project.id, { state: "unknown", page: 2 })).toMatchObject({ state: "all", page: 1 });
    expect(await screeningReads.getScreeningQueuePage(project.id, { pageSize: 101 })).toMatchObject({ pageSize: 100 });
    expect(await screeningReads.getScreeningQueuePage(project.id, { page: 100, pageSize: 50 })).toMatchObject({ page: 2, totalPages: 2 });
  });

  it("uses two read-only repeatable-read SELECTs for queue pages and one SELECT for navigation", async () => {
    const project = await createProject("query-budget");
    const [paper] = await insertPapers(project.id, 1);
    const transactionOptions: Array<Parameters<Database["transaction"]>[1] | undefined> = [];
    const returnedRows: number[] = [];
    const observedReads = createScreeningReadServices(databaseObservingResults((options) => transactionOptions.push(options), (count) => returnedRows.push(count)));

    queryLog.length = 0;
    returnedRows.length = 0;
    const nonempty = await observedReads.getScreeningQueuePage(project.id, { state: "all", pageSize: 1 });
    expect(nonempty.items).toHaveLength(1);
    expect(returnedRows).toEqual([1, 1]);
    expect(coreSelects()).toHaveLength(2);
    expect(transactionOptions.at(-1)).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });

    queryLog.length = 0;
    returnedRows.length = 0;
    const emptySelection = await observedReads.getScreeningQueuePage(project.id, { state: "included", pageSize: 1 });
    expect(emptySelection.items).toHaveLength(0);
    expect(returnedRows).toEqual([1, 0]);
    expect(coreSelects()).toHaveLength(2);
    expect(transactionOptions.at(-1)).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });

    const emptyProject = await createProject("query-budget-empty");
    queryLog.length = 0;
    returnedRows.length = 0;
    const empty = await observedReads.getScreeningQueuePage(emptyProject.id);
    expect(empty.items).toHaveLength(0);
    expect(returnedRows).toEqual([1, 0]);
    expect(coreSelects()).toHaveLength(2);

    queryLog.length = 0;
    returnedRows.length = 0;
    await expect(observedReads.getScreeningQueuePage(randomUUID())).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(returnedRows).toEqual([0]);
    expect(coreSelects()).toHaveLength(1);

    queryLog.length = 0;
    returnedRows.length = 0;
    const navigation = await observedReads.getScreeningPaperNavigation(project.id, paper.id);
    expect(navigation).toMatchObject({ paperId: paper.id, position: 1, totalCount: 1 });
    expect(returnedRows).toEqual([1]);
    expect(coreSelects()).toHaveLength(1);
  });

  it("keeps aggregate and page rows on one repeatable-read snapshot", async () => {
    const project = await createProject("snapshot");
    const paper = await insertPaper(project.id, "Snapshot Paper");
    const afterAggregate = deferred();
    const continuePage = deferred();
    const gatedReads = createScreeningReadServices(databasePausedAfterFirstSelect(afterAggregate.resolve, continuePage.promise));
    const readPromise = gatedReads.getScreeningQueuePage(project.id);
    let beforeWrite;
    try {
      await afterAggregate.promise;
      await reviewServices.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    } finally {
      continuePage.resolve();
      beforeWrite = await readPromise;
    }

    expect(beforeWrite.counts).toEqual({ all: 1, unscreened: 1, included: 0, excluded: 0, maybe: 0 });
    expect(beforeWrite.items[0].screeningState).toBe("unscreened");
    expect(beforeWrite.startPaperId).toBe(paper.id);
    const afterWrite = await screeningReads.getScreeningQueuePage(project.id);
    expect(afterWrite.counts).toEqual({ all: 1, unscreened: 0, included: 1, excluded: 0, maybe: 0 });
    expect(afterWrite.items[0].screeningState).toBe("included");
  });
});
