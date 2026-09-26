import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPaperCollectionReadServices } from "@/application/paper-collection-read-services";
import { createReviewServices } from "@/application/services";
import type { Database } from "@/db/client";
import { papers, schema } from "@/db/schema";
import { LocalDocumentStorage } from "@/infrastructure/document-storage";
import type { ReviewTransaction } from "@/application/review-services/shared";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const queryLog: string[] = [];
const client = postgres(databaseUrl, {
  max: 5,
  prepare: false,
  debug: (_connection, query) => { queryLog.push(query); },
});
const db = drizzle(client, { schema }) as Database;
let services!: ReturnType<typeof createReviewServices>;
const paperCollectionReadServices = createPaperCollectionReadServices(db);
let storageRoot = "";

function coreSelects() {
  return queryLog.filter((query) => /^(with|select)\b/i.test(query.trim()));
}

function paperFixture(projectId: string, index: number, createdAt = new Date()) {
  return {
    projectId,
    title: `Slice 42 Paper ${index}`,
    authors: [`Author ${index}`],
    publicationYear: 2024,
    venue: "Slice 42 Journal",
    doi: `10.5555/slice-42-${projectId}-${index}`,
    abstract: `private abstract ${index}`,
    bibliographicNote: `private note ${index}`,
    createdAt,
    updatedAt: createdAt,
  };
}

async function insertPapers(projectId: string, count: number, createdAt?: Date) {
  if (count === 0) return [];
  return db.insert(papers).values(Array.from({ length: count }, (_, index) => paperFixture(projectId, index + 1, createdAt))).returning({
    id: papers.id,
    title: papers.title,
  });
}

async function createProject(label = "collection") {
  return services.createProject({ title: `Slice 42 ${label} ${randomUUID()}` });
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

function databaseObservingTransactions(recordOptions: (options: Parameters<Database["transaction"]>[1] | undefined) => void): Database {
  return {
    transaction<T>(callback: (tx: ReviewTransaction) => Promise<T>, options?: Parameters<Database["transaction"]>[1]): Promise<T> {
      recordOptions(options);
      return db.transaction(callback, options);
    },
  } as unknown as Database;
}

describe("Slice 42 scalable Paper collection reads", () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "litreview_slice42_documents_"));
    services = createReviewServices(db, { documentStorage: new LocalDocumentStorage(storageRoot) });
    await migrate(db, { migrationsFolder: "./drizzle" });
  }, 120_000);

  afterAll(async () => {
    await client.end();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 120_000);

  it("distinguishes a missing Project from an existing empty Project", async () => {
    const project = await createProject("empty");
    queryLog.length = 0;
    const empty = await paperCollectionReadServices.getPaperCollectionPage(project.id);
    expect(empty).toMatchObject({ items: [], page: 1, pageSize: 50, totalCount: 0, totalPages: 0, from: 0, to: 0, hasPrevious: false, hasNext: false });
    expect(coreSelects()).toHaveLength(2);

    queryLog.length = 0;
    const missing = await paperCollectionReadServices.getPaperCollectionPage(randomUUID());
    expect(missing).toBeNull();
    expect(coreSelects()).toHaveLength(1);
  });

  it("counts and bounds Paper collections at 1, 49, 50, 51, 100, and 101 rows", async () => {
    for (const count of [1, 49, 50, 51, 100, 101]) {
      const project = await createProject(`count-${count}`);
      await insertPapers(project.id, count);
      const result = await paperCollectionReadServices.getPaperCollectionPage(project.id);
      expect(result?.totalCount).toBe(count);
      expect(result?.items).toHaveLength(Math.min(50, count));
      expect(result?.pageSize).toBe(50);
      expect(result?.totalPages).toBe(Math.ceil(count / 50));
      expect(result?.from).toBe(1);
      expect(result?.to).toBe(Math.min(count, 50));
      expect(result?.hasNext).toBe(count > 50);
      expect(result?.hasPrevious).toBe(false);
      if (count > 50) {
        const secondPage = await paperCollectionReadServices.getPaperCollectionPage(project.id, { page: 2 });
        expect(secondPage?.items).toHaveLength(Math.min(50, count - 50));
        expect(secondPage?.from).toBe(51);
        expect(secondPage?.hasPrevious).toBe(true);
        expect(secondPage?.hasNext).toBe(count > 100);
        if (count > 100) {
          const lastPage = await paperCollectionReadServices.getPaperCollectionPage(project.id, { page: 3 });
          expect(lastPage?.items).toHaveLength(count - 100);
          expect(lastPage?.from).toBe(101);
          expect(lastPage?.to).toBe(count);
          expect(lastPage?.hasPrevious).toBe(true);
          expect(lastPage?.hasNext).toBe(false);
        } else {
          expect(secondPage?.to).toBe(count);
          expect(secondPage?.hasNext).toBe(false);
        }
      }
    }
  });

  it("normalizes pages and page sizes with the shared scalable-read contract", async () => {
    const project = await createProject("normalization");
    await insertPapers(project.id, 101);

    for (const page of [undefined, "0", "-4", "2.5", "not-a-number", "9007199254740992", Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await paperCollectionReadServices.getPaperCollectionPage(project.id, { page });
      expect(result?.page).toBe(1);
    }
    const outOfRange = await paperCollectionReadServices.getPaperCollectionPage(project.id, { page: "999" });
    expect(outOfRange).toMatchObject({ page: 3, totalPages: 3, from: 101, to: 101, hasPrevious: true, hasNext: false });

    for (const pageSize of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await paperCollectionReadServices.getPaperCollectionPage(project.id, { pageSize });
      expect(result?.pageSize).toBe(50);
    }
    expect((await paperCollectionReadServices.getPaperCollectionPage(project.id, { pageSize: 100 }))?.pageSize).toBe(100);
    expect((await paperCollectionReadServices.getPaperCollectionPage(project.id, { pageSize: 101 }))?.pageSize).toBe(100);
    expect((await paperCollectionReadServices.getPaperCollectionPage(project.id, { pageSize: Number.MAX_SAFE_INTEGER }))?.pageSize).toBe(100);
  });

  it("uses created_at DESC and id DESC consistently across equal timestamps and repeated reads", async () => {
    const project = await createProject("equal-timestamp");
    const instant = new Date("2026-01-01T00:00:00.000Z");
    const inserted = await insertPapers(project.id, 51, instant);
    const first = await paperCollectionReadServices.getPaperCollectionPage(project.id);
    const second = await paperCollectionReadServices.getPaperCollectionPage(project.id, { page: 2 });
    const repeated = await paperCollectionReadServices.getPaperCollectionPage(project.id);
    const expectedIds = inserted.map((paper) => paper.id).sort((left, right) => left === right ? 0 : left > right ? -1 : 1);

    expect(first?.items.map((paper) => paper.id)).toEqual(expectedIds.slice(0, 50));
    expect(second?.items.map((paper) => paper.id)).toEqual(expectedIds.slice(50));
    expect(repeated?.items.map((paper) => paper.id)).toEqual(first?.items.map((paper) => paper.id));
    expect(new Set([...(first?.items ?? []), ...(second?.items ?? [])].map((paper) => paper.id)).size).toBe(51);
  });

  it("matches the legacy Paper metadata and latest title/abstract badges without exposing notes", async () => {
    const project = await createProject("equivalence");
    const inserted = await insertPapers(project.id, 4);
    const exclusion = await services.createScreeningCriterion(project.id, { type: "exclusion", text: "Not relevant" });
    await services.recordScreeningDecision(project.id, inserted[1].id, { decision: "include" });
    await services.recordScreeningDecision(project.id, inserted[1].id, { decision: "maybe" });
    await services.recordScreeningDecision(project.id, inserted[2].id, { decision: "maybe" });
    await services.recordScreeningDecision(project.id, inserted[2].id, { decision: "exclude", exclusionCriterionId: exclusion.id });
    await services.recordScreeningDecision(project.id, inserted[3].id, { decision: "exclude", exclusionCriterionId: exclusion.id });
    await services.recordScreeningDecision(project.id, inserted[3].id, { decision: "include" });

    const legacyPapers = await services.listPapers(project.id);
    const legacyScreening = await services.listScreeningPapers(project.id);
    const legacyById = new Map(legacyScreening.map((paper) => [paper.id, paper]));
    const actual = await paperCollectionReadServices.getPaperCollectionPage(project.id, { pageSize: 100 });
    const actualRows = (actual?.items ?? []).map((paper) => ({ ...paper })).sort((left, right) => left.id.localeCompare(right.id));
    const expectedRows = legacyPapers.map((paper) => {
      const screeningState = legacyById.get(paper.id)?.screeningState ?? "unscreened";
      return {
        id: paper.id,
        projectId: paper.projectId,
        title: paper.title,
        authors: paper.authors,
        publicationYear: paper.publicationYear,
        venue: paper.venue,
        doi: paper.doi,
        createdAt: paper.createdAt,
        updatedAt: paper.updatedAt,
        screeningState,
      };
    }).sort((left, right) => left.id.localeCompare(right.id));

    expect(actualRows).toEqual(expectedRows);
    expect(actualRows.map((paper) => paper.screeningState).sort()).toEqual(["excluded", "included", "maybe", "unscreened"].sort());
    expect(Object.keys(actualRows[0]).sort()).toEqual([
      "authors", "createdAt", "doi", "id", "projectId", "publicationYear", "screeningState", "title", "updatedAt", "venue",
    ]);
    expect(JSON.stringify(actualRows)).not.toContain("private abstract");
    expect(JSON.stringify(actualRows)).not.toContain("private note");

    const includedPaper = await services.addPaper(project.id, { title: "Downstream history badge fixture" });
    await services.recordScreeningDecision(project.id, includedPaper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, includedPaper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(project.id, includedPaper.id, { decision: "include" });
    const document = await services.uploadFullTextDocument(project.id, includedPaper.id, {
      originalFilename: "study.pdf",
      mediaType: "application/pdf",
    }, Readable.from([Buffer.from("%PDF-1.7\nSlice 42 fixture\n")]));
    expect(document.kind).toBe("created");
    const evidence = await services.recordEvidence(project.id, {
      paperId: includedPaper.id,
      fullTextDocumentId: document.document.id,
      sourceText: "The selected study reports a measured result.",
      pageNumber: 1,
    });
    const field = await services.createExtractionField(project.id, { name: "Slice 42 downstream fixture", fieldType: "short_text" });
    await services.reviseExtractionValue(project.id, includedPaper.id, field.id, {
      value: "Measured result",
      evidenceIds: [evidence.id],
    });

    const afterDownstreamHistory = await paperCollectionReadServices.getPaperCollectionPage(project.id, { pageSize: 100 });
    expect(afterDownstreamHistory?.items.find((paper) => paper.id === includedPaper.id)?.screeningState).toBe("included");
  });

  it("uses two core SELECTs for every successful Project page and none per Paper", async () => {
    const project = await createProject("query-budget");
    await insertPapers(project.id, 101);
    const transactionOptions: Array<Parameters<Database["transaction"]>[1] | undefined> = [];
    const observedReads = createPaperCollectionReadServices(databaseObservingTransactions((options) => transactionOptions.push(options)));

    for (const pageSize of [1, 25, 50, 100]) {
      queryLog.length = 0;
      const result = await observedReads.getPaperCollectionPage(project.id, { pageSize });
      expect(result?.items).toHaveLength(pageSize);
      expect(coreSelects()).toHaveLength(2);
      expect(transactionOptions.at(-1)).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    }

    queryLog.length = 0;
    await paperCollectionReadServices.getPaperCollectionPage(randomUUID());
    expect(coreSelects()).toHaveLength(1);
  });

  it("limits Paper rows before the lateral latest-decision lookup", async () => {
    const project = await createProject("query-shape");
    await insertPapers(project.id, 1);
    queryLog.length = 0;
    await paperCollectionReadServices.getPaperCollectionPage(project.id);
    const pageQuery = coreSelects().find((query) => /with selected_papers/i.test(query));
    expect(pageQuery).toBeTruthy();
    expect(pageQuery!.indexOf("limit")).toBeLessThan(pageQuery!.indexOf("left join lateral"));
    expect(pageQuery).toMatch(/order by decision\.sequence desc, decision\.id desc\s+limit 1/i);
    expect(pageQuery).toMatch(/order by paper\.created_at desc, paper\.id desc/i);
    expect(pageQuery).not.toMatch(/\babstract\b|bibliographic_note|decision\.note/i);
  });

  it("keeps the aggregate and Paper rows on one repeatable-read snapshot", async () => {
    const insertionProject = await createProject("paper-snapshot");
    await insertPapers(insertionProject.id, 1);
    const afterCount = deferred();
    const continuePage = deferred();
    const gatedDb = databasePausedAfterFirstSelect(afterCount.resolve, continuePage.promise);
    const gatedReads = createPaperCollectionReadServices(gatedDb);
    const readPromise = gatedReads.getPaperCollectionPage(insertionProject.id);
    let insertionRead;
    try {
      await afterCount.promise;
      await insertPapers(insertionProject.id, 1);
    } finally {
      continuePage.resolve();
      insertionRead = await readPromise;
    }
    expect(insertionRead?.totalCount).toBe(1);
    expect(insertionRead?.items).toHaveLength(1);
    expect((await paperCollectionReadServices.getPaperCollectionPage(insertionProject.id))?.totalCount).toBe(2);

    const decisionProject = await createProject("decision-snapshot");
    const [paper] = await insertPapers(decisionProject.id, 1);
    const decisionAfterCount = deferred();
    const continueDecisionPage = deferred();
    const decisionReads = createPaperCollectionReadServices(databasePausedAfterFirstSelect(decisionAfterCount.resolve, continueDecisionPage.promise));
    const decisionReadPromise = decisionReads.getPaperCollectionPage(decisionProject.id);
    let decisionRead;
    try {
      await decisionAfterCount.promise;
      await services.recordScreeningDecision(decisionProject.id, paper.id, { decision: "include" });
    } finally {
      continueDecisionPage.resolve();
      decisionRead = await decisionReadPromise;
    }
    expect(decisionRead?.items[0].screeningState).toBe("unscreened");
    expect((await paperCollectionReadServices.getPaperCollectionPage(decisionProject.id))?.items[0].screeningState).toBe("included");
  });
});
