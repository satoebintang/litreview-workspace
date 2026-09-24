import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createFullTextQueueReadServices } from "@/application/full-text-queue-read-services";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { fullTextRetrievalAttempts, fullTextScreeningDecisions, papers, screeningDecisions } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice36_queue_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 36 full-text queue read services", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let appDb: ReturnType<typeof createDb>["db"] | undefined;
  let reviewServices: ReturnType<typeof createReviewServices> | undefined;
  let queueServices: ReturnType<typeof createFullTextQueueReadServices> | undefined;

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    const created = createDb(databaseUrl.toString());
    appClient = created.client;
    appDb = created.db;
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    reviewServices = createReviewServices(created.db);
    queueServices = createFullTextQueueReadServices(created.db);
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("includes historical retrieval conflicts in both all and conflict counts", async () => {
    const services = reviewServices!;
    const queues = queueServices!;
    const client = appClient!;
    const project = await services.createProject({ title: `Historical queue conflicts ${randomUUID()}` });
    const excluded = await services.addPaper(project.id, { title: "Historical conflict with excluded TA" });
    const maybe = await services.addPaper(project.id, { title: "Historical conflict with maybe TA" });
    const unscreened = await services.addPaper(project.id, { title: "Historical conflict with no TA decision" });
    const exclusionCriterion = await services.createScreeningCriterion(project.id, { type: "exclusion", text: "Historical conflict fixture" });

    for (const [paper, decision] of [[excluded, "exclude"], [maybe, "maybe"]] as const) {
      await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "pending", attemptedAt: new Date() });
      if (decision === "exclude") await services.recordScreeningDecision(project.id, paper.id, { decision, exclusionCriterionId: exclusionCriterion.id });
      else await services.recordScreeningDecision(project.id, paper.id, { decision });
    }
    await client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at)
        values (${project.id}::uuid, ${unscreened.id}::uuid, 'pending', now())`;
    });

    const all = await queues.listFullTextRetrievalQueuePage(project.id);
    const conflicts = await queues.listFullTextRetrievalQueuePage(project.id, { state: "conflict" });
    const expectedIds = [excluded.id, maybe.id, unscreened.id].sort();

    expect(all.state).toBe("all");
    expect(all.totalCount).toBe(3);
    expect(all.counts.all).toBe(3);
    expect(all.counts.conflict).toBe(3);
    expect(all.counts.not_sought).toBe(0);
    expect(all.items.map(({ paper }) => paper.id).sort()).toEqual(expectedIds);
    expect(all.items.every(({ reviewStatus }) => reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion"))).toBe(true);

    expect(conflicts.state).toBe("conflict");
    expect(conflicts.totalCount).toBe(3);
    expect(conflicts.counts.conflict).toBe(3);
    expect(conflicts.items.map(({ paper }) => paper.id).sort()).toEqual(expectedIds);
  });

  it("counts a full-text decision without retrieval history as legacy, matching the domain reducer", async () => {
    const services = reviewServices!;
    const queues = queueServices!;
    const client = appClient!;
    const project = await services.createProject({ title: `Legacy queue classification ${randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Legacy full-text decision" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into full_text_screening_decisions (project_id, paper_id, decision)
        values (${project.id}::uuid, ${paper.id}::uuid, 'include')`;
    });

    const legacy = await queues.listFullTextScreeningQueuePage(project.id, { state: "legacy" });
    expect(legacy.totalCount).toBe(1);
    expect(legacy.counts.legacy).toBe(1);
    expect(legacy.counts.all).toBe(1);
    expect(legacy.items).toHaveLength(1);
    expect(legacy.items[0].reviewStatus.warnings).toContain("legacy_full_text_decision_without_retrieval_record");
  });

  it("clamps bounded pages and orders equal creation timestamps by descending Paper ID", async () => {
    const services = reviewServices!;
    const queues = queueServices!;
    const db = appDb!;
    const project = await services.createProject({ title: `Stable queue pages ${randomUUID()}` });
    const fixedCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const inserted = await db.insert(papers).values(Array.from({ length: 101 }, (_, index) => ({
      projectId: project.id,
      title: `Queue paper ${index}`,
      createdAt: fixedCreatedAt,
    }))).returning({ id: papers.id });
    await db.insert(screeningDecisions).values(inserted.map(({ id }) => ({ projectId: project.id, paperId: id, decision: "include" })));
    const expectedIds = inserted.map(({ id }) => id).sort((left, right) => left === right ? 0 : left > right ? -1 : 1);

    const first = await queues.listFullTextRetrievalQueuePage(project.id);
    const second = await queues.listFullTextRetrievalQueuePage(project.id, { page: "2" });
    const last = await queues.listFullTextRetrievalQueuePage(project.id, { page: "999" });
    const maximum = await queues.listFullTextRetrievalQueuePage(project.id, { pageSize: 500 });
    const invalidState = await queues.listFullTextRetrievalQueuePage(project.id, { state: "invalid", page: "2" });
    const invalidPage = await queues.listFullTextScreeningQueuePage(project.id, { state: "awaiting", page: "invalid" });

    expect(first.pageSize).toBe(50);
    expect(first.totalCount).toBe(101);
    expect(first.totalPages).toBe(3);
    expect(first.from).toBe(1);
    expect(first.to).toBe(50);
    expect(first.items.map(({ paper }) => paper.id)).toEqual(expectedIds.slice(0, 50));
    expect(second.items.map(({ paper }) => paper.id)).toEqual(expectedIds.slice(50, 100));
    expect(last.page).toBe(3);
    expect(last.from).toBe(101);
    expect(last.to).toBe(101);
    expect(last.items.map(({ paper }) => paper.id)).toEqual(expectedIds.slice(100));
    expect(maximum.pageSize).toBe(100);
    expect(maximum.items).toHaveLength(100);
    expect(invalidState.state).toBe("all");
    expect(invalidState.page).toBe(1);
    expect(invalidPage.state).toBe("awaiting");
    expect(invalidPage.page).toBe(1);
    expect(invalidPage.counts.awaiting).toBe(101);

    const emptyProject = await services.createProject({ title: `Empty queue ${randomUUID()}` });
    const empty = await queues.listFullTextScreeningQueuePage(emptyProject.id);
    expect(empty.page).toBe(1);
    expect(empty.totalPages).toBe(0);
    expect(empty.totalCount).toBe(0);
    expect(empty.from).toBe(0);
    expect(empty.to).toBe(0);
    expect(empty.items).toEqual([]);
  });

  it("matches every TA/retrieval/FT state combination except the approved retrieval-all correction", async () => {
    const services = reviewServices!;
    const queues = queueServices!;
    const db = appDb!;
    const project = await services.createProject({ title: `Queue classification matrix ${randomUUID()}` });
    const taExclusion = await services.createScreeningCriterion(project.id, { type: "exclusion", text: "Matrix TA exclusion" });
    const ftExclusion = await services.createFullTextScreeningCriterion(project.id, { text: "Matrix FT exclusion" });
    const taDecisions = [null, "include", "exclude", "maybe"] as const;
    const retrievalOutcomes = [null, "pending", "unavailable", "retrieved"] as const;
    const ftDecisions = [null, "include", "exclude", "maybe"] as const;
    const fixtures = taDecisions.flatMap((taDecision) => retrievalOutcomes.flatMap((retrievalOutcome) => ftDecisions.map((ftDecision) => ({
      id: randomUUID(),
      taDecision,
      retrievalOutcome,
      ftDecision,
    }))));

    await db.insert(papers).values(fixtures.map((fixture, index) => ({
      id: fixture.id,
      projectId: project.id,
      title: `Matrix paper ${index}`,
    })));
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = 'replica'`);
      const taRows = fixtures.filter((fixture) => fixture.taDecision !== null).map((fixture) => ({
        projectId: project.id,
        paperId: fixture.id,
        decision: fixture.taDecision!,
        exclusionCriterionId: fixture.taDecision === "exclude" ? taExclusion.id : null,
        exclusionCriterionType: fixture.taDecision === "exclude" ? "exclusion" : null,
      }));
      if (taRows.length > 0) await tx.insert(screeningDecisions).values(taRows);

      const retrievalRows = fixtures.filter((fixture) => fixture.retrievalOutcome !== null).map((fixture) => ({
        projectId: project.id,
        paperId: fixture.id,
        outcome: fixture.retrievalOutcome!,
        attemptedAt: new Date("2026-01-01T00:00:00.000Z"),
      }));
      if (retrievalRows.length > 0) await tx.insert(fullTextRetrievalAttempts).values(retrievalRows);

      const ftRows = fixtures.filter((fixture) => fixture.ftDecision !== null).map((fixture) => ({
        projectId: project.id,
        paperId: fixture.id,
        decision: fixture.ftDecision!,
        exclusionCriterionId: fixture.ftDecision === "exclude" ? ftExclusion.id : null,
      }));
      if (ftRows.length > 0) await tx.insert(fullTextScreeningDecisions).values(ftRows);
    });

    const oldRetrievalAll = await services.listFullTextRetrievalQueue(project.id);
    const oldRetrievalConflict = await services.listFullTextRetrievalQueue(project.id, "conflict");
    const retrievalStates = ["all", "not_sought", "pending", "unavailable", "retrieved", "conflict"] as const;
    const retrievalExpected = new Map<string, Array<{ paper: { id: string } }>>([
      ["all", [...oldRetrievalAll, ...oldRetrievalConflict]],
      ...retrievalStates.slice(1).map((state) => [state, state === "conflict" ? oldRetrievalConflict : []] as const),
    ]);
    for (const state of ["not_sought", "pending", "unavailable", "retrieved", "conflict"] as const) {
      if (state !== "conflict") retrievalExpected.set(state, await services.listFullTextRetrievalQueue(project.id, state));
    }

    const oldFullTextAll = await services.listFullTextScreeningQueue(project.id);
    const fullTextStates = ["all", "ready", "awaiting", "included", "excluded", "maybe", "legacy", "conflict"] as const;
    const fullTextExpected = new Map(fullTextStates.map((state) => [state, state === "all" ? oldFullTextAll : oldFullTextAll.filter(({ reviewStatus }) => {
      if (state === "ready") return reviewStatus.titleAbstractState === "included" && reviewStatus.fullTextRetrievalState === "retrieved" && reviewStatus.fullTextState === "not_started";
      if (state === "awaiting") return reviewStatus.finalEligibility === "pending_full_text";
      if (state === "included") return reviewStatus.finalEligibility === "included";
      if (state === "excluded") return reviewStatus.finalEligibility === "excluded";
      if (state === "maybe") return reviewStatus.finalEligibility === "unresolved_full_text";
      if (state === "legacy") return reviewStatus.warnings.includes("legacy_full_text_decision_without_retrieval_record");
      return reviewStatus.crossStageConflict || reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion");
    })] as const));

    const oldRetrievalIds = new Set(oldRetrievalAll.map(({ paper }) => paper.id));
    const oldConflictIds = new Set(oldRetrievalConflict.map(({ paper }) => paper.id));
    const expectedDelta = new Set(fixtures.filter((fixture) => fixture.taDecision !== "include" && fixture.retrievalOutcome !== null).map((fixture) => fixture.id));
    expect([...expectedDelta].sort()).toEqual([...oldConflictIds].sort());

    const statusRows = await services.listPaperReviewStatuses(project.id);
    const expectedStatusByPaperId = new Map(statusRows.map((row) => [row.paperId, row.status]));

    const retrievalAll = await queues.listFullTextRetrievalQueuePage(project.id, { pageSize: 100 });
    expect(retrievalAll.counts.all).toBe(oldRetrievalIds.size + oldConflictIds.size);
    expect(new Set(retrievalAll.items.map(({ paper }) => paper.id))).toEqual(new Set([...oldRetrievalIds, ...oldConflictIds]));
    const actualDelta = [...new Set(retrievalAll.items.map(({ paper }) => paper.id).filter((id) => !oldRetrievalIds.has(id)))].sort();
    expect(actualDelta).toEqual([...expectedDelta].sort());
    for (const state of retrievalStates) {
      const expected = retrievalExpected.get(state)!;
      const page = state === "all" ? retrievalAll : await queues.listFullTextRetrievalQueuePage(project.id, { state, pageSize: 100 });
      const expectedIds = expected.map(({ paper }) => paper.id).sort();
      expect(page.counts[state]).toBe(expected.length);
      expect(page.totalCount).toBe(expected.length);
      expect(page.items.map(({ paper }) => paper.id).sort()).toEqual(expectedIds);
      for (const item of page.items) expect(item.reviewStatus).toEqual(expectedStatusByPaperId.get(item.paper.id));
    }

    const fullTextAll = await queues.listFullTextScreeningQueuePage(project.id, { pageSize: 100 });
    expect(fullTextAll.counts.all).toBe(oldFullTextAll.length);
    for (const state of fullTextStates) {
      const expected = fullTextExpected.get(state)!;
      const page = state === "all" ? fullTextAll : await queues.listFullTextScreeningQueuePage(project.id, { state, pageSize: 100 });
      expect(page.counts[state]).toBe(expected.length);
      expect(page.totalCount).toBe(expected.length);
      expect(page.items.map(({ paper }) => paper.id).sort()).toEqual(expected.map(({ paper }) => paper.id).sort());
      for (const item of page.items) expect(item.reviewStatus).toEqual(expectedStatusByPaperId.get(item.paper.id));
    }
    expect(fullTextAll.counts.ready).toBeLessThanOrEqual(fullTextAll.counts.awaiting);
  });
});
