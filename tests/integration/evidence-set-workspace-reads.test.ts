import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createEvidenceSetWorkspaceReadServices } from "@/application/evidence-set-workspace-read-services";
import { createReviewServices } from "@/application/services";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(DATABASE_URL);
const reviewServices = createReviewServices(db);
const reads = createEvidenceSetWorkspaceReadServices(db);
let projectId = "";

describe("Slice 45 bounded Evidence Set workspace reads", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => {
    projectId = (await reviewServices.createProject({ title: `Evidence Set read project ${crypto.randomUUID()}` })).id;
  });
  afterAll(async () => {
    // The integration runner uses a disposable database; temporal composition history is append-only.
    await client.end();
  });

  it("pages current members and candidates with revision-bound cursors and SQL-bounded projections", async () => {
    const paper = await reviewServices.addPaper(projectId, { title: `Unique Study ${"T".repeat(260)}`, authors: ["Author"] });
    const evidenceIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const evidence = await reviewServices.recordEvidence(projectId, {
        paperId: paper.id,
        sourceText: index < 4 ? `Member ${index + 1}: ${"😀".repeat(301)}` : `Candidate ${index - 3}: ${"📚".repeat(120)}`,
        pageNumber: index + 1,
      });
      evidenceIds.push(evidence.id);
    }
    const { set } = (await reviewServices.createEvidenceSet(projectId, { name: "Bounded reads" }));
    await reviewServices.createEvidenceSet(projectId, { name: "Bounded second option" });
    await reviewServices.createEvidenceSet(projectId, { name: "Other active option" });
    let revisionId = (await reads.getEvidenceSetWorkspace(projectId, set.id)).currentRevision.id;
    for (const evidenceId of evidenceIds.slice(0, 4)) {
      revisionId = (await reviewServices.addEvidenceToSet(projectId, set.id, { evidenceId, expectedRevisionId: revisionId })).revision.id;
    }

    const first = await reads.listCurrentMembersPage(projectId, set.id, { expectedRevisionId: revisionId, pageSize: 2 });
    expect(first.items.map((item) => item.evidenceId)).toEqual(evidenceIds.slice(0, 2));
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect([...first.items[0].sourcePreview].length).toBeLessThanOrEqual(300);
    expect([...first.items[0].paperTitle].length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(512 * 1024);

    const second = await reads.listCurrentMembersPage(projectId, set.id, { expectedRevisionId: revisionId, cursor: first.nextCursor, pageSize: 2 });
    expect(second.items.map((item) => item.evidenceId)).toEqual(evidenceIds.slice(2, 4));
    expect(second.hasMore).toBe(false);
    expect((await reads.listCurrentMembersPage(projectId, set.id, { expectedRevisionId: revisionId, pageSize: 200 })).pageSize).toBe(100);

    const selectorPage = await reads.listActiveEvidenceSetOptions(projectId, { query: "Bounded", pageSize: 1 });
    expect(selectorPage.items).toHaveLength(1);
    expect(selectorPage.hasMore).toBe(true);
    expect(selectorPage.totals.active).toBe(3);

    const candidates = await reads.searchEvidenceSetCandidates(projectId, set.id, { expectedRevisionId: revisionId, query: "unique study", pageSize: 1 });
    expect(candidates.items).toHaveLength(1);
    const firstCandidateId = candidates.items[0].evidenceId;
    expect(evidenceIds.slice(4)).toContain(firstCandidateId);
    expect([...candidates.items[0].excerpt].length).toBeLessThanOrEqual(80);
    expect([...candidates.items[0].paperTitle].length).toBeLessThanOrEqual(200);
    expect(candidates.hasMore).toBe(true);
    expect(JSON.parse(Buffer.from(candidates.nextCursor!, "base64url").toString("utf8"))).toMatchObject({
      v: 1, scope: "candidates", projectId, evidenceSetId: set.id, revisionId, query: "unique study",
    });
    const nextCandidate = await reads.searchEvidenceSetCandidates(projectId, set.id, { expectedRevisionId: revisionId, query: "unique study", cursor: candidates.nextCursor, pageSize: 1 });
    expect([...candidates.items, ...nextCandidate.items].map((item) => item.evidenceId).sort()).toEqual(evidenceIds.slice(4).sort());
    expect(nextCandidate.hasMore).toBe(false);
    await expect(reads.searchEvidenceSetCandidates(projectId, set.id, { expectedRevisionId: revisionId, query: "😀".repeat(201) }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const added = await reviewServices.addEvidenceToSet(projectId, set.id, { evidenceId: evidenceIds[4], expectedRevisionId: revisionId });
    await expect(reads.listCurrentMembersPage(projectId, set.id, { expectedRevisionId: added.revision.id, cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps history pagination at a numeric high-water and resolves exact historical member order", async () => {
    const paper = await reviewServices.addPaper(projectId, { title: "History Study", authors: ["Author"] });
    const evidenceIds: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      evidenceIds.push((await reviewServices.recordEvidence(projectId, { paperId: paper.id, sourceText: `Historical passage ${index + 1}`, pageNumber: index + 1 })).id);
    }
    const { set, revision: emptyRevision } = await reviewServices.createEvidenceSet(projectId, { name: "History reads" });
    let revisionId = emptyRevision.id;
    let pinnedRevisionId = emptyRevision.id;
    for (const [index, evidenceId] of evidenceIds.entries()) {
      revisionId = (await reviewServices.addEvidenceToSet(projectId, set.id, { evidenceId, expectedRevisionId: revisionId })).revision.id;
      if (index === 3) pinnedRevisionId = revisionId;
    }

    const first = await reads.listCompositionHistoryPage(projectId, set.id, { pageSize: 3 });
    expect(first.items.map((item) => Number(item.setOrdinal))).toEqual([14, 13, 12]);
    expect(first.highWaterOrdinal).toBe("14");
    expect(first.nextCursor).toBeTruthy();
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"))).toMatchObject({
      v: 1, scope: "history", projectId, evidenceSetId: set.id, highWaterOrdinal: "14", beforeOrdinal: "12",
    });

    const extra = await reviewServices.recordEvidence(projectId, { paperId: paper.id, sourceText: "Later than history high-water", pageNumber: 99 });
    const afterHighWater = await reviewServices.addEvidenceToSet(projectId, set.id, { evidenceId: extra.id, expectedRevisionId: revisionId });
    const second = await reads.listCompositionHistoryPage(projectId, set.id, { pageSize: 3, cursor: first.nextCursor });
    expect(second.highWaterOrdinal).toBe(first.highWaterOrdinal);
    expect(second.items.map((item) => Number(item.setOrdinal))).toEqual([11, 10, 9]);
    expect(second.items.some((item) => item.revisionId === afterHighWater.revision.id)).toBe(false);

    const pinnedFirst = await reads.listRevisionMembersPage(projectId, set.id, pinnedRevisionId, { pageSize: 2 });
    expect(pinnedFirst.items.map((item) => item.evidenceId)).toEqual(evidenceIds.slice(0, 2));
    expect(pinnedFirst.nextCursor).toBeTruthy();
    const pinnedSecond = await reads.listRevisionMembersPage(projectId, set.id, pinnedRevisionId, { pageSize: 2, cursor: pinnedFirst.nextCursor });
    expect(pinnedSecond.items.map((item) => item.evidenceId)).toEqual(evidenceIds.slice(2, 4));
    expect(pinnedSecond.hasMore).toBe(false);
  });

  it("continues candidate pages exactly across equal sub-millisecond timestamps", async () => {
    const paper = await reviewServices.addPaper(projectId, { title: "Timestamp Cursor Study" });
    const evidenceIds = [randomUUID(), randomUUID(), randomUUID()].sort();
    await client.unsafe(`
      insert into evidence (id, project_id, paper_id, source_text, page_number, created_at)
      select evidence_id, $2, $3, 'Timestamp cursor candidate', ord::integer, '2026-09-27T03:04:05.123456Z'::timestamptz
      from unnest($1::uuid[]) with ordinality as seeded(evidence_id, ord)
    `, [evidenceIds, projectId, paper.id]);
    const { set } = await reviewServices.createEvidenceSet(projectId, { name: "Timestamp cursor set" });
    const revisionId = (await reads.getEvidenceSetWorkspace(projectId, set.id)).currentRevision.id;

    const pageIds: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < evidenceIds.length; pageNumber += 1) {
      const page = await reads.searchEvidenceSetCandidates(projectId, set.id, {
        expectedRevisionId: revisionId,
        query: "Timestamp Cursor Study",
        pageSize: 1,
        cursor,
      });
      if (pageNumber === 0) {
        expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8")).createdAt)
          .toBe("2026-09-27T03:04:05.123456Z");
      }
      pageIds.push(...page.items.map((item) => item.evidenceId));
      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(pageNumber < evidenceIds.length - 1);
      cursor = page.nextCursor;
    }

    expect(pageIds).toEqual(evidenceIds);
    expect(new Set(pageIds).size).toBe(evidenceIds.length);
  });
});
