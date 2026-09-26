import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Database } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createClaimReadServices, type ClaimHistorySummary } from "@/application/claim-read-services";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

type Executor = {
  execute: (...args: unknown[]) => Promise<unknown>;
  transaction: (callback: (tx: Executor) => Promise<unknown>, options?: unknown) => Promise<unknown>;
};

function instrumentDatabase(
  base: Database,
  afterExecute?: (statementNumber: number) => Promise<void>,
  beforeTransaction?: () => Promise<void>,
) {
  const executed: unknown[] = [];
  const wrap = (target: unknown): Executor => new Proxy(target as object, {
    get(value, property) {
      if (property === "execute") {
        const execute = Reflect.get(value, property, value) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(execute, value, args);
          executed.push(args[0]);
          if (afterExecute) await afterExecute(executed.length);
          return result;
        };
      }
      const member = Reflect.get(value, property, value);
      return typeof member === "function" ? member.bind(value) : member;
    },
  }) as unknown as Executor;
  const instrumented = new Proxy(db as unknown as Executor, {
    get(value, property) {
      if (property === "transaction") {
        return async (callback: (tx: Executor) => Promise<unknown>, options?: unknown) => {
          if (beforeTransaction) await beforeTransaction();
          return value.transaction((tx) => callback(wrap(tx)), options);
        };
      }
      if (property === "execute") return wrap(value).execute;
      const member = Reflect.get(value, property, value);
      return typeof member === "function" ? member.bind(value) : member;
    },
  }) as unknown as Database;
  return { db: instrumented, executed };
}

function expectSummaryMatchesLegacy(summary: ClaimHistorySummary, revision: Awaited<ReturnType<typeof services.getClaimRevision>>["revision"]) {
  expect(summary).toMatchObject({
    projectId: revision.projectId,
    claimId: revision.claimId,
    revisionId: revision.id,
    sequence: revision.sequence,
    lifecycle: revision.lifecycle,
    claimText: revision.claimText,
    researcherNote: revision.researcherNote,
    directEvidenceCount: revision.supports.evidence.length,
    extractionRevisionCount: revision.supports.extractionRevisions.length,
    synthesisRevisionCount: revision.supports.synthesisRevisions.length,
    totalSupportCount: revision.totalSupportCount,
    supportStatus: revision.supportStatus,
    citationCandidateCount: revision.citationCandidateCount,
    distinctPaperCount: revision.distinctPaperCount,
  });
  expect(summary.createdAt.getTime()).toBe(new Date(revision.createdAt).getTime());
  expect(summary.finalizedAt?.getTime() ?? null).toBe(revision.finalizedAt == null ? null : new Date(revision.finalizedAt).getTime());
}

describe("Claim ledger and history read models", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Claim reads ${crypto.randomUUID()}` })).id; });
  afterAll(async () => { await client.end(); });

  async function includedPaper(title: string) {
    const paper = await services.addPaper(projectId, { title, authors: ["Author"] });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("matches exact legacy support, structural-Paper, and citation metrics across current and historical snapshots", async () => {
    const read = createClaimReadServices(db);
    const paperA = await includedPaper("Paper A");
    const paperB = await includedPaper("Paper B");
    const paperC = await includedPaper("Paper C");
    const evidenceA = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Evidence on A", pageNumber: 1 });
    const evidenceC = await services.recordEvidence(projectId, { paperId: paperC.id, sourceText: "Evidence on C", pageNumber: 3 });
    const field = await services.createExtractionField(projectId, { name: "Finding", fieldType: "short_text" });
    const extractionA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "A finding", evidenceIds: [evidenceA.id] });
    const extractionB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "B finding", evidenceIds: [] });
    const synthesis1 = await services.createSynthesisStatement(projectId, { statementText: "A and B findings.", extractionRevisionIds: [extractionA.id, extractionB.id] });
    const extractionA2 = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "Updated A finding", evidenceIds: [] });
    await services.reviseSynthesisStatement(projectId, synthesis1.statement.id, { statementText: "Updated A and B findings.", extractionRevisionIds: [extractionA2.id, extractionB.id] });

    const claim = await services.createClaim(projectId, { claimText: "Combined evidence-backed claim", researcherNote: "Initial note" });
    const supported = await services.createClaimRevision(projectId, claim.id, {
      claimText: "Combined evidence-backed claim",
      researcherNote: "Snapshot note",
      expectedCurrentRevisionId: claim.revision.id,
      supports: [
        { kind: "evidence", evidenceId: evidenceA.id },
        { kind: "evidence", evidenceId: evidenceC.id },
        { kind: "extractionRevision", extractionRevisionId: extractionA.id },
        { kind: "extractionRevision", extractionRevisionId: extractionB.id },
        { kind: "synthesisRevision", synthesisRevisionId: synthesis1.revision.id },
      ],
    });
    const samePaperClaim1 = await services.createClaim(projectId, { claimText: "Another claim about A" });
    await services.createClaimRevision(projectId, samePaperClaim1.id, {
      claimText: "Another claim about A",
      expectedCurrentRevisionId: samePaperClaim1.revision.id,
      supports: [{ kind: "evidence", evidenceId: evidenceA.id }],
    });
    const samePaperClaim2 = await services.createClaim(projectId, { claimText: "A third claim about A" });
    await services.createClaimRevision(projectId, samePaperClaim2.id, {
      claimText: "A third claim about A",
      expectedCurrentRevisionId: samePaperClaim2.revision.id,
      supports: [{ kind: "evidence", evidenceId: evidenceA.id }],
    });
    const unsupported = await services.createClaim(projectId, { claimText: "Unsupported claim" });

    const legacy = await services.getClaimRevision(projectId, claim.id, supported.revision.id);
    const firstLedger = await read.getClaimLedgerPage(projectId);
    expect(firstLedger).not.toBeNull();
    const firstRow = firstLedger!.items.find((item) => item.claimId === claim.id)!;
    expect(firstRow).toMatchObject({
      projectId,
      claimId: claim.id,
      claimCreatedAt: new Date(claim.createdAt),
      revisionId: supported.revision.id,
      sequence: supported.revision.sequence,
      lifecycle: "active",
      claimText: "Combined evidence-backed claim",
      researcherNote: "Snapshot note",
      directEvidenceCount: 2,
      extractionRevisionCount: 2,
      synthesisRevisionCount: 1,
      totalSupportCount: 5,
      supportStatus: "supported",
      citationCandidateCount: 2,
      distinctPaperCount: 3,
    });
    expect(firstLedger!.citationCandidateTotal).toBe(4);
    expect(firstLedger!.citationCandidateTotal).not.toBe(2); // The same Paper contributes once for each Claim.
    expect(legacy.revision.citationCandidates.map((item) => [item.paper.id, item.pathCount]).sort()).toEqual([[paperA.id, 3], [paperC.id, 1]].sort());

    await services.appendEvidenceReviewDecision(projectId, evidenceA.id, { decision: "rejected", note: "Rejected after Claim snapshot" });
    const exclusionCriterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Excluded after Claim snapshot" });
    await services.recordScreeningDecision(projectId, paperA.id, { decision: "exclude", exclusionCriterionId: exclusionCriterion.id });
    const legacyAfterEligibilityChanges = await services.getClaimRevision(projectId, claim.id, supported.revision.id);
    const summariesBeforeWithdrawal = await read.getClaimHistorySummaries(projectId, claim.id);
    expectSummaryMatchesLegacy(summariesBeforeWithdrawal.find((item) => item.revisionId === supported.revision.id)!, legacyAfterEligibilityChanges.revision);
    expect(summariesBeforeWithdrawal.find((item) => item.revisionId === supported.revision.id)).toMatchObject({
      directEvidenceCount: 2,
      extractionRevisionCount: 2,
      synthesisRevisionCount: 1,
      totalSupportCount: 5,
      supportStatus: "supported",
      citationCandidateCount: 2,
      distinctPaperCount: 3,
    });

    const withdrawn = await services.withdrawClaim(projectId, claim.id, { expectedCurrentRevisionId: supported.revision.id });
    const legacyHistory = await services.getClaimHistory(projectId, claim.id);
    const historySummaries = await read.getClaimHistorySummaries(projectId, claim.id);
    expect(historySummaries.map((item) => item.revisionId)).toEqual(legacyHistory.revisions.slice().reverse().map((item) => item.id));
    for (const summary of historySummaries) {
      const legacyRevision = legacyHistory.revisions.find((item) => item.id === summary.revisionId);
      expect(legacyRevision).toBeDefined();
      expectSummaryMatchesLegacy(summary, legacyRevision!);
    }
    expect(await read.getLatestActiveClaimRevisionId(projectId, claim.id)).toBe(supported.revision.id);

    const finalLedger = await read.getClaimLedgerPage(projectId);
    expect(finalLedger).not.toBeNull();
    expect(finalLedger!.counts).toEqual({ all: 4, supported: 2, unsupported: 1, withdrawn: 1 });
    expect(finalLedger!.citationCandidateTotal).toBe(2);
    expect(finalLedger!.citationCandidateTotal).not.toBe(1); // Two current Claims point to the same Paper.
    expect(finalLedger!.items.find((item) => item.claimId === claim.id)).toMatchObject({
      revisionId: withdrawn.revision.id,
      lifecycle: "withdrawn",
      supportStatus: "unsupported",
      totalSupportCount: 0,
      citationCandidateCount: 0,
      distinctPaperCount: 0,
    });
    expect(finalLedger!.items.find((item) => item.claimId === unsupported.id)).toMatchObject({ supportStatus: "unsupported", totalSupportCount: 0 });
    expect(await read.getClaimLedgerPage(projectId, { filter: "supported" })).toMatchObject({ totalCount: 2, counts: finalLedger!.counts });
    expect(await read.getClaimLedgerPage(projectId, { filter: "unsupported" })).toMatchObject({ totalCount: 1 });
    expect(await read.getClaimLedgerPage(projectId, { filter: "withdrawn" })).toMatchObject({ totalCount: 1 });
  });

  it("returns anchored zeros for an existing empty Project and null for a missing Project", async () => {
    const read = createClaimReadServices(db);
    await expect(read.getClaimLedgerPage(projectId)).resolves.toMatchObject({
      page: 1,
      totalCount: 0,
      totalPages: 0,
      from: 0,
      to: 0,
      citationCandidateTotal: 0,
      counts: { all: 0, supported: 0, unsupported: 0, withdrawn: 0 },
      items: [],
    });
    await expect(read.getClaimLedgerPage(crypto.randomUUID())).resolves.toBeNull();
  });

  it("preserves 0/1/49/50/51 row boundaries, invalid defaults, clamping, and bounded ledger SELECTs", async () => {
    const read = createClaimReadServices(db);
    expect(await read.getClaimLedgerPage(projectId)).toMatchObject({ totalCount: 0, from: 0, to: 0, page: 1, totalPages: 0 });
    const observed = instrumentDatabase(db);
    const measured = createClaimReadServices(observed.db);

    async function seed(count: number) {
      const drafts = await client.unsafe(`
        with new_claims as (
          insert into claims (project_id)
          select $1::uuid from generate_series(1, $2::integer)
          returning project_id, id
        )
        insert into claim_revisions (project_id, claim_id, state, claim_text)
        select project_id, id, 'active', 'Boundary claim' from new_claims
        returning id
      `, [projectId, count]);
      expect(drafts).toHaveLength(count);
      await client.unsafe(`
        update claim_revisions set finalized_at=now()
        where project_id=$1::uuid and claim_text='Boundary claim' and finalized_at is null
      `, [projectId]);
    }

    await seed(1);
    expect(await read.getClaimLedgerPage(projectId)).toMatchObject({ totalCount: 1, totalPages: 1, from: 1, to: 1, page: 1 });
    await seed(48);
    expect(await read.getClaimLedgerPage(projectId)).toMatchObject({ totalCount: 49, totalPages: 1, from: 1, to: 49, page: 1 });
    await seed(1);
    expect(await read.getClaimLedgerPage(projectId)).toMatchObject({ totalCount: 50, totalPages: 1, from: 1, to: 50, page: 1 });
    await seed(1);
    observed.executed.length = 0;
    const second = await measured.getClaimLedgerPage(projectId, { filter: "unsupported", page: 999, pageSize: 500 });
    expect(second).toMatchObject({ filter: "unsupported", page: 1, pageSize: 100, totalCount: 51, totalPages: 1, from: 1, to: 51 });
    expect(second!.items).toHaveLength(51);
    expect(observed.executed).toHaveLength(2);
    observed.executed.length = 0;
    const invalidDefaults = await measured.getClaimLedgerPage(projectId, { filter: "bogus", page: 0, pageSize: 0 });
    expect(invalidDefaults).toMatchObject({ filter: "all", page: 1, pageSize: 50, totalCount: 51, totalPages: 2, from: 1, to: 50 });
    expect(observed.executed).toHaveLength(2);
    const pageTwo = await read.getClaimLedgerPage(projectId, { page: 2 });
    expect(pageTwo).toMatchObject({ page: 2, totalCount: 51, totalPages: 2, from: 51, to: 51, hasPrevious: true, hasNext: false });
    expect(pageTwo!.items).toHaveLength(1);
  });

  it("uses a single repeatable-read snapshot when a Claim is written between the aggregate and page SELECTs", async () => {
    let insertedClaimId = "";
    const observed = instrumentDatabase(db, async (statementNumber) => {
      if (statementNumber === 1) insertedClaimId = (await services.createClaim(projectId, { claimText: "Concurrent ledger write" })).id;
    });
    const read = createClaimReadServices(observed.db);
    const snapshot = await read.getClaimLedgerPage(projectId);
    expect(observed.executed).toHaveLength(2);
    expect(snapshot).toMatchObject({ counts: { all: 0 }, totalCount: 0, items: [] });
    expect(insertedClaimId).not.toBe("");
    await expect(createClaimReadServices(db).getClaimLedgerPage(projectId)).resolves.toMatchObject({ counts: { all: 1 }, totalCount: 1 });
  });

  it("keeps history query count constant at 1, 50, and 500 revisions and uses one direct latest-active lookup", async () => {
    const claim = await services.createClaim(projectId, { claimText: "History benchmark claim" });
    const observed = instrumentDatabase(db);
    const read = createClaimReadServices(observed.db);

    async function expectHistoryCount(total: number) {
      observed.executed.length = 0;
      const summaries = await read.getClaimHistorySummaries(projectId, claim.id);
      expect(summaries).toHaveLength(total);
      expect(observed.executed).toHaveLength(2);
      expect(summaries[0].sequence).toBeGreaterThanOrEqual(summaries[summaries.length - 1].sequence);
    }

    await expectHistoryCount(1);
    for (const additional of [49, 450]) {
      await client.unsafe(`
        insert into claim_revisions (project_id, claim_id, state, claim_text)
        select $1::uuid, $2::uuid, 'active', 'Historical revision ' || n::text
        from generate_series(1, $3::integer) as n
      `, [projectId, claim.id, additional]);
      await client.unsafe(`
        update claim_revisions set finalized_at=now()
        where project_id=$1::uuid and claim_id=$2::uuid and finalized_at is null
      `, [projectId, claim.id]);
      await expectHistoryCount(additional === 49 ? 50 : 500);
    }

    observed.executed.length = 0;
    await expect(read.getLatestActiveClaimRevisionId(projectId, claim.id)).resolves.toBeTruthy();
    expect(observed.executed).toHaveLength(1);
  });

  it("rejects foreign Claim identities in exact history and latest-active reads", async () => {
    const foreignProject = await services.createProject({ title: `Foreign claim ${crypto.randomUUID()}` });
    const foreignClaim = await services.createClaim(foreignProject.id, { claimText: "Foreign claim" });
    const read = createClaimReadServices(db);
    await expect(read.getClaimHistorySummaries(projectId, foreignClaim.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await expect(read.getLatestActiveClaimRevisionId(projectId, foreignClaim.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });

  it("preserves exact typed support IDs and rejects a concurrent revision after the targeted snapshot", async () => {
    const paper = await includedPaper("Direct shortcut Paper");
    const evidence1 = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "First passage", pageNumber: 1 });
    const evidence2 = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Second passage", pageNumber: 2 });
    const evidence3 = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Rejected passage", pageNumber: 3 });
    const field = await services.createExtractionField(projectId, { name: "Shortcut finding", fieldType: "short_text" });
    const extraction = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Exact finding", evidenceIds: [evidence1.id] });
    const synthesis = await services.createSynthesisStatement(projectId, { statementText: "Exact synthesis", extractionRevisionIds: [extraction.id] });
    const claim = await services.createClaim(projectId, { claimText: "Direct shortcut claim" });
    const starting = await services.createClaimRevision(projectId, claim.id, {
      claimText: "Direct shortcut claim",
      expectedCurrentRevisionId: claim.revision.id,
      supports: [
        { kind: "evidence", evidenceId: evidence1.id },
        { kind: "extractionRevision", extractionRevisionId: extraction.id },
        { kind: "synthesisRevision", synthesisRevisionId: synthesis.revision.id },
      ],
    });

    const linked = await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: evidence2.id });
    expect(linked.revision.supports.evidence.map((item) => item.evidenceId).sort()).toEqual([evidence1.id, evidence2.id].sort());
    expect(linked.revision.supports.extractionRevisions.map((item) => item.extractionRevisionId)).toEqual([extraction.id]);
    expect(linked.revision.supports.synthesisRevisions.map((item) => item.synthesisRevisionId)).toEqual([synthesis.revision.id]);
    await expect(services.createClaimRevision(projectId, claim.id, {
      claimText: "Stale direct write",
      expectedCurrentRevisionId: starting.revision.id,
      supports: [],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: evidence2.id })).rejects.toMatchObject({ code: "DUPLICATE_LINK" });
    await expect(services.unlinkEvidenceFromClaim(projectId, { claimId: claim.id, evidenceId: evidence3.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const unlinked = await services.unlinkEvidenceFromClaim(projectId, { claimId: claim.id, evidenceId: evidence2.id });
    expect(unlinked.revision.supports.evidence.map((item) => item.evidenceId)).toEqual([evidence1.id]);
    expect(unlinked.revision.supports.extractionRevisions.map((item) => item.extractionRevisionId)).toEqual([extraction.id]);
    expect(unlinked.revision.supports.synthesisRevisions.map((item) => item.synthesisRevisionId)).toEqual([synthesis.revision.id]);
    await services.appendEvidenceReviewDecision(projectId, evidence3.id, { decision: "rejected", note: "Rejected for the next snapshot" });
    await expect(services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: evidence3.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const racePaper = await includedPaper("Concurrent shortcut Paper");
    const raceEvidence = await services.recordEvidence(projectId, { paperId: racePaper.id, sourceText: "Race passage", pageNumber: 1 });
    const raceClaim = await services.createClaim(projectId, { claimText: "Race snapshot claim" });
    const concurrentDatabase = createDb(process.env.DATABASE_URL);
    const concurrentServices = createReviewServices(concurrentDatabase.db);
    let interveningRevisionId = "";
    let concurrentWrite: Promise<unknown> | null = null;
    const racedDb = instrumentDatabase(db, async (statementNumber) => {
      if (statementNumber === 1) {
        concurrentWrite = concurrentServices.createClaimRevision(projectId, raceClaim.id, {
          claimText: "Intervening revision",
          expectedCurrentRevisionId: raceClaim.revision.id,
          supports: [],
        }).then((result) => {
          interveningRevisionId = result.revision.id;
          return result;
        }).catch(() => {
          return undefined;
        });
      }
    }, async () => {
      if (concurrentWrite) await concurrentWrite;
    });
    const racedServices = createReviewServices(racedDb.db);
    try {
      await expect(racedServices.linkEvidenceToClaim(projectId, { claimId: raceClaim.id, evidenceId: raceEvidence.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(interveningRevisionId).not.toBe("");
      expect((await services.getCurrentClaim(projectId, raceClaim.id)).currentRevision.id).toBe(interveningRevisionId);
    } finally {
      await concurrentDatabase.client.end();
    }

    expect((await services.getCurrentClaim(projectId, claim.id)).currentRevision.id).not.toBe(starting.revision.id);
  });
});
