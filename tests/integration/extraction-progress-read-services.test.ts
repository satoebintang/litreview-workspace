import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createExtractionProgressReadServices } from "@/application/extraction-progress-read-services";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { fullTextRetrievalAttempts, fullTextScreeningDecisions, papers, screeningDecisions } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice37_progress_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 37 extraction progress read services", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let appDb: ReturnType<typeof createDb>["db"] | undefined;
  let services: ReturnType<typeof createReviewServices> | undefined;
  let progressReads: ReturnType<typeof createExtractionProgressReadServices> | undefined;

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    const created = createDb(databaseUrl.toString());
    appClient = created.client;
    appDb = created.db;
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    services = createReviewServices(created.db);
    progressReads = createExtractionProgressReadServices(created.db);
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function includedPaper(projectId: string, title: string) {
    const paper = await services!.addPaper(projectId, { title });
    await services!.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services!.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services!.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("matches released membership, review warnings, and every progress fact", async () => {
    const review = services!;
    const reads = progressReads!;
    const project = await review.createProject({ title: `Progress equivalence ${randomUUID()}` });
    const requiredText = await review.createExtractionField(project.id, { name: "Required text", fieldType: "short_text", required: true });
    const requiredNumber = await review.createExtractionField(project.id, { name: "Required number", fieldType: "number", required: true });
    const optionalBoolean = await review.createExtractionField(project.id, { name: "Optional boolean", fieldType: "boolean", required: false });
    const archivedRequired = await review.createExtractionField(project.id, { name: "Archived required", fieldType: "short_text", required: true });
    await review.archiveExtractionField(project.id, archivedRequired.id);

    const valuesByExpected = new Map<string, { completedRequired: number; status: string; percentage: number | null }>();
    const present = await includedPaper(project.id, "Required present");
    await review.reviseExtractionValue(project.id, present.id, requiredText.id, { state: "present", value: "reported" });
    valuesByExpected.set(present.id, { completedRequired: 1, status: "partial", percentage: 50 });

    const notReported = await includedPaper(project.id, "Required not reported");
    await review.reviseExtractionValue(project.id, notReported.id, requiredText.id, { state: "not_reported" });
    valuesByExpected.set(notReported.id, { completedRequired: 1, status: "partial", percentage: 50 });

    const notApplicable = await includedPaper(project.id, "Required not applicable");
    await review.reviseExtractionValue(project.id, notApplicable.id, requiredText.id, { state: "not_applicable" });
    valuesByExpected.set(notApplicable.id, { completedRequired: 1, status: "partial", percentage: 50 });

    const cleared = await includedPaper(project.id, "Required cleared");
    await review.reviseExtractionValue(project.id, cleared.id, requiredText.id, { state: "present", value: "temporary" });
    await review.clearExtractionValue(project.id, cleared.id, requiredText.id);
    valuesByExpected.set(cleared.id, { completedRequired: 0, status: "not_started", percentage: 0 });

    const optionalStarted = await includedPaper(project.id, "Optional field started");
    await review.reviseExtractionValue(project.id, optionalStarted.id, optionalBoolean.id, { value: true });
    valuesByExpected.set(optionalStarted.id, { completedRequired: 0, status: "partial", percentage: 0 });

    const complete = await includedPaper(project.id, "All required complete");
    await review.reviseExtractionValue(project.id, complete.id, requiredText.id, { value: "reported" });
    await review.reviseExtractionValue(project.id, complete.id, requiredNumber.id, { value: 12 });
    valuesByExpected.set(complete.id, { completedRequired: 2, status: "complete", percentage: 100 });

    const untouched = await includedPaper(project.id, "No active values");
    valuesByExpected.set(untouched.id, { completedRequired: 0, status: "not_started", percentage: 0 });

    const historical = await includedPaper(project.id, "Historical analytical Paper");
    await review.reviseExtractionValue(project.id, historical.id, requiredText.id, { value: "legacy value" });
    await appDb!.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = 'replica'`);
      await tx.execute(sql`delete from full_text_screening_decisions where project_id=${project.id}::uuid and paper_id=${historical.id}::uuid`);
    });

    const taExclusionCriterion = await review.createScreeningCriterion(project.id, { type: "exclusion", text: "Historical boundary fixture" });
    await review.recordScreeningDecision(project.id, historical.id, { decision: "exclude", exclusionCriterionId: taExclusionCriterion.id });
    const excludedWithoutHistory = await review.addPaper(project.id, { title: "Excluded without analytical history" });
    await review.recordScreeningDecision(project.id, excludedWithoutHistory.id, { decision: "exclude", exclusionCriterionId: taExclusionCriterion.id });

    const legacy = await review.getProjectExtractionProgress(project.id);
    const first = await reads.getExtractionProgressPage(project.id, { pageSize: 3 });
    const pages = [first];
    for (let page = 2; page <= first.pagination.totalPages; page += 1) {
      pages.push(await reads.getExtractionProgressPage(project.id, { page, pageSize: 3 }));
    }
    const newItems = pages.flatMap((result) => result.items);
    const legacyById = new Map(legacy.papers.map((item) => [item.paper.id, item]));
    const newById = new Map(newItems.map((item) => [item.paper.id, item]));

    expect(first.counts).toEqual({ includedPaperCount: 7, historicalPaperCount: 1, requiredFieldCount: 2 });
    expect(first.pagination.totalCount).toBe(8);
    expect([...newById.keys()].sort()).toEqual([...legacyById.keys()].sort());
    expect(newItems).toHaveLength(legacy.papers.length);
    for (const [paperId, oldItem] of legacyById) {
      const newItem = newById.get(paperId)!;
      expect({
        completedRequired: newItem.completedRequired,
        requiredCount: newItem.requiredCount,
        status: newItem.status,
        percentage: newItem.percentage,
        reviewStatus: newItem.reviewStatus,
        writeEligible: newItem.writeEligible,
      }).toEqual({
        completedRequired: oldItem.completedRequired,
        requiredCount: oldItem.requiredCount,
        status: oldItem.status,
        percentage: oldItem.percentage,
        reviewStatus: oldItem.reviewStatus,
        writeEligible: oldItem.writeEligible,
      });
    }
    for (const [paperId, expected] of valuesByExpected) {
      const item = newById.get(paperId)!;
      expect({ completedRequired: item.completedRequired, status: item.status, percentage: item.percentage }).toEqual(expected);
    }
    expect(newById.get(historical.id)?.reviewStatus.warnings).toContain("legacy_analysis_precedes_full_text_screening");
    expect(newById.get(historical.id)?.writeEligible).toBe(false);
    expect(newById.get(excludedWithoutHistory.id)).toBeUndefined();
  });

  it("handles empty, exact-boundary, invalid, and out-of-range pages with a stable tie-breaker", async () => {
    const review = services!;
    const reads = progressReads!;
    const emptyProject = await review.createProject({ title: `Empty extraction progress ${randomUUID()}` });
    const empty = await reads.getExtractionProgressPage(emptyProject.id);
    expect(empty.items).toEqual([]);
    expect(empty.pagination).toEqual({ page: 1, pageSize: 50, totalCount: 0, totalPages: 0, from: 0, to: 0 });

    const project = await review.createProject({ title: `Equal timestamp progress pages ${randomUUID()}` });
    const fixedCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const inserted = await appDb!.insert(papers).values(Array.from({ length: 51 }, (_, index) => ({
      projectId: project.id,
      title: `Progress paper ${index}`,
      createdAt: fixedCreatedAt,
    }))).returning({ id: papers.id });
    await appDb!.insert(screeningDecisions).values(inserted.map(({ id }) => ({ projectId: project.id, paperId: id, decision: "include" })));
    await appDb!.insert(fullTextRetrievalAttempts).values(inserted.map(({ id }) => ({ projectId: project.id, paperId: id, outcome: "retrieved", attemptedAt: fixedCreatedAt })));
    await appDb!.insert(fullTextScreeningDecisions).values(inserted.map(({ id }) => ({ projectId: project.id, paperId: id, decision: "include" })));

    const expectedIds = inserted.map(({ id }) => id).sort((left, right) => left === right ? 0 : left > right ? -1 : 1);
    const legacy = await review.getProjectExtractionProgress(project.id);
    const defaultFirst = await reads.getExtractionProgressPage(project.id);
    const defaultSecond = await reads.getExtractionProgressPage(project.id, { page: 2 });
    const size49 = await reads.getExtractionProgressPage(project.id, { pageSize: 49 });
    const size50 = await reads.getExtractionProgressPage(project.id, { pageSize: 50 });
    const size51 = await reads.getExtractionProgressPage(project.id, { pageSize: 51 });
    const page49 = await reads.getExtractionProgressPage(project.id, { page: 49, pageSize: 1 });
    const page50 = await reads.getExtractionProgressPage(project.id, { page: 50, pageSize: 1 });
    const page51 = await reads.getExtractionProgressPage(project.id, { page: 51, pageSize: 1 });
    const invalid = await reads.getExtractionProgressPage(project.id, { page: "invalid" });
    const zero = await reads.getExtractionProgressPage(project.id, { page: 0 });
    const outOfRange = await reads.getExtractionProgressPage(project.id, { page: 999 });
    const capped = await reads.getExtractionProgressPage(project.id, { pageSize: 500 });

    expect(defaultFirst.pagination).toEqual({ page: 1, pageSize: 50, totalCount: 51, totalPages: 2, from: 1, to: 50 });
    expect(defaultSecond.pagination).toEqual({ page: 2, pageSize: 50, totalCount: 51, totalPages: 2, from: 51, to: 51 });
    expect(size49.items).toHaveLength(49);
    expect(size50.items).toHaveLength(50);
    expect(size51.items).toHaveLength(51);
    expect(size49.pagination.totalPages).toBe(2);
    expect(size50.pagination.totalPages).toBe(2);
    expect(size51.pagination.totalPages).toBe(1);
    expect(defaultFirst.items.map(({ paper }) => paper.id)).toEqual(expectedIds.slice(0, 50));
    expect(defaultSecond.items.map(({ paper }) => paper.id)).toEqual(expectedIds.slice(50));
    expect(page49.items[0]?.paper.id).toBe(expectedIds[48]);
    expect(page50.items[0]?.paper.id).toBe(expectedIds[49]);
    expect(page51.items[0]?.paper.id).toBe(expectedIds[50]);
    expect(invalid.pagination.page).toBe(1);
    expect(zero.pagination.page).toBe(1);
    expect(outOfRange.pagination.page).toBe(2);
    expect(capped.pagination.pageSize).toBe(100);
    expect([...defaultFirst.items, ...defaultSecond.items].map((item) => item.paper.id).sort()).toEqual(legacy.papers.map((item) => item.paper.id).sort());
  });
});
