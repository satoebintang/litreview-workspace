import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createClaimSynthesisHistoryReadServices } from "@/application/claim-synthesis-history-read-services";
import { createSynthesisInterpretationExactReadServices } from "@/application/synthesis-interpretation-exact-read-services";
import { createSynthesisInterpretationCurrentReadServices } from "@/application/synthesis-interpretation-current-read-services";
import { createClaimRevisionExactAuditReadServices } from "@/application/claim-revision-exact-audit-read-services";
import { createSynthesisRevisionExactRouteReadServices } from "@/application/synthesis-revision-exact-route-read-services";
import { encodeClaimSynthesisHistoryCursor } from "@/application/claim-synthesis-history-cursor";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview");
const services = createReviewServices(db);
const history = createClaimSynthesisHistoryReadServices(db);
const exactInterpretations = createSynthesisInterpretationExactReadServices(db);
const currentInterpretations = createSynthesisInterpretationCurrentReadServices(db, { getSynthesisProvenance: services.getSynthesisProvenance });
const exactClaims = createClaimRevisionExactAuditReadServices(db, (projectId, claimId, revisionId) => services.getClaimRevision(projectId, claimId, revisionId));
const exactSynthesisRoutes = createSynthesisRevisionExactRouteReadServices(db);
let projectId = "";

type HistoryExecutor = NonNullable<Parameters<typeof history.getClaimRevisionHistoryPage>[3]>;
const sqlDialect = new PgDialect();

async function captureHistoryRead<T>(read: (executor: HistoryExecutor) => Promise<T>) {
  const statements: SQL[] = [];
  const value = await db.transaction(async (tx) => {
    const executor = {
      execute: (query: SQL) => {
        statements.push(query);
        return tx.execute(query);
      },
    } as unknown as HistoryExecutor;
    return read(executor);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const compiled = statements.map((statement) => sqlDialect.sqlToQuery(statement));
  return { value, statements: compiled.map((statement) => statement.sql), parameters: compiled.map((statement) => statement.params) };
}

function pageKeySelector(statement: string, nextCte = "visible_page"): string {
  const match = new RegExp(`page_keys as materialized\\s*\\(([\\s\\S]*?)\\),\\s*${nextCte} as`, "i").exec(statement);
  expect(match, "history query must begin with a materialized page-key selector").not.toBeNull();
  return match?.[1] ?? "";
}

describe("Slice 52 Claim and Synthesis history readers", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Slice 52 histories ${crypto.randomUUID()}` })).id; });
  afterAll(async () => { await client.end(); });

  it("keeps ordered page-key selection separate from scope checks and visible-row hydration", async () => {
    const claim = await services.createClaim(projectId, { claimText: "Captured Claim revision 1" });
    await services.createClaimRevision(projectId, claim.id, {
      claimText: "Captured Claim revision 2", expectedCurrentRevisionId: claim.revision.id, supports: [],
    });

    const evidenceSet = (await services.createEvidenceSet(projectId, { name: "Captured preparation" })).set;
    const field = await services.createExtractionField(projectId, { name: "Captured field", fieldType: "short_text" });
    const preparation = await services.createSynthesisPreparation(projectId, { evidenceSetId: evidenceSet.id, extractionFieldId: field.id });
    const synthesis = await services.finalizeSynthesisPreparation(projectId, preparation.id, {
      title: "Captured synthesis 1", statementText: "Captured statement 1",
    });
    await services.reviseSynthesisStatement(projectId, synthesis.statement.id, {
      title: "Captured synthesis 2", statementText: "Captured statement 2", extractionRevisionIds: [],
    });
    const firstInterpretation = await services.appendSynthesisInterpretation(projectId, synthesis.statement.id, synthesis.revision.id, {
      convergenceState: "mixed", summary: "Captured interpretation 1", limitations: [], questions: [], contradictions: [],
    });
    await services.appendSynthesisInterpretation(projectId, synthesis.statement.id, synthesis.revision.id, {
      convergenceState: "convergent", summary: "Captured interpretation 2", limitations: [], questions: [], contradictions: [],
    });

    const claimFirst = await captureHistoryRead((executor) =>
      history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1 }, executor));
    expect(claimFirst.statements).toHaveLength(2);
    expect(claimFirst.statements[0].toLowerCase()).not.toContain("page_keys");
    const claimFirstKeys = pageKeySelector(claimFirst.statements[1]);
    expect(claimFirstKeys).toMatch(/select r\.id,\s*r\.sequence::text as sequence/i);
    expect(claimFirstKeys).toMatch(/order by r\.sequence desc, r\.id desc\s+limit \$\d+/i);
    expect(claimFirstKeys).not.toMatch(/\(r\.sequence,\s*r\.id\)\s*[<>]/i);
    expect(claimFirst.statements[1]).toMatch(/visible_page as materialized\s*\([\s\S]*?limit \$\d+\s*\)/i);

    const claimContinuation = await captureHistoryRead((executor) =>
      history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1, cursor: claimFirst.value.nextCursor }, executor));
    expect(claimContinuation.statements).toHaveLength(2);
    expect(pageKeySelector(claimContinuation.statements[1])).toMatch(/\(r\.sequence,\s*r\.id\)\s*<\s*\(\$\d+::bigint,\s*\$\d+::uuid\)/i);

    const synthesisFirst = await captureHistoryRead((executor) =>
      history.getSynthesisRevisionHistoryPage(projectId, synthesis.statement.id, { pageSize: 1 }, executor));
    expect(synthesisFirst.statements).toHaveLength(3);
    const synthesisFirstKeys = pageKeySelector(synthesisFirst.statements[1]);
    expect(synthesisFirstKeys).toMatch(/select r\.id,\s*r\.sequence::text as sequence/i);
    expect(synthesisFirstKeys).toMatch(/order by r\.sequence asc, r\.id asc\s+limit \$\d+/i);
    expect(synthesisFirstKeys).not.toMatch(/\(r\.sequence,\s*r\.id\)\s*[<>]/i);
    expect(synthesisFirst.statements[1]).toMatch(/cross join lateral\s*\(\s*select count\(distinct s\.extraction_revision_id\)::text as supporting_revision_count[\s\S]*?from synthesis_revision_supports s[\s\S]*?where s\.project_id=\$\d+::uuid and s\.synthesis_revision_id=v\.id\s*\) counts/i);
    expect(synthesisFirst.statements[2]).toContain("finalized_synthesis_revision_id in");

    const synthesisContinuation = await captureHistoryRead((executor) =>
      history.getSynthesisRevisionHistoryPage(projectId, synthesis.statement.id, { pageSize: 1, cursor: synthesisFirst.value.nextCursor }, executor));
    expect(synthesisContinuation.statements).toHaveLength(3);
    expect(pageKeySelector(synthesisContinuation.statements[1])).toMatch(/\(r\.sequence,\s*r\.id\)\s*>\s*\(\$\d+::bigint,\s*\$\d+::uuid\)/i);

    const interpretationFirst = await captureHistoryRead((executor) =>
      history.getSynthesisInterpretationHistoryPage(projectId, synthesis.statement.id, synthesis.revision.id, { pageSize: 1 }, executor));
    expect(interpretationFirst.value.items[0].id).not.toBe(firstInterpretation.id);
    expect(interpretationFirst.statements).toHaveLength(2);
    const interpretationFirstKeys = pageKeySelector(interpretationFirst.statements[0], "page_state");
    expect(interpretationFirstKeys).toMatch(/select i\.id,\s*i\.sequence::text as sequence/i);
    expect(interpretationFirstKeys).toMatch(/order by i\.sequence desc, i\.id desc\s+limit \$\d+/i);
    expect(interpretationFirstKeys).not.toMatch(/\(i\.sequence,\s*i\.id\)\s*[<>]/i);
    expect(interpretationFirst.statements[0]).toMatch(/anchor_status as\s*\(select true as anchor_valid\)/i);
    expect(interpretationFirst.statements[1]).toMatch(/visible_page as materialized/i);
    for (const [table, alias] of [
      ["synthesis_interpretation_limitations", "l"],
      ["synthesis_interpretation_questions", "q"],
      ["synthesis_interpretation_contradictions", "c"],
    ]) {
      expect(interpretationFirst.statements[1]).toMatch(new RegExp(
        `from ${table} ${alias}\\s+where ${alias}\\.project_id=\\$\\d+::uuid and ${alias}\\.interpretation_id=any\\(\\(?\\$\\d+\\)?::uuid\\[\\]\\)\\s+group by ${alias}\\.interpretation_id`,
        "i",
      ));
    }
    const firstVisibleIds = interpretationFirst.parameters[1].filter(Array.isArray);
    expect(firstVisibleIds).toHaveLength(4);
    expect(firstVisibleIds).toEqual(Array.from({ length: 4 }, () => [interpretationFirst.value.items[0].id]));
    expect(interpretationFirst.statements[1]).not.toMatch(/visible_page_ids|any\(\(select/i);

    const interpretationContinuation = await captureHistoryRead((executor) =>
      history.getSynthesisInterpretationHistoryPage(projectId, synthesis.statement.id, synthesis.revision.id, {
        pageSize: 1, cursor: interpretationFirst.value.nextCursor,
      }, executor));
    expect(interpretationContinuation.statements).toHaveLength(2);
    expect(pageKeySelector(interpretationContinuation.statements[0], "page_state")).toMatch(/\(i\.sequence,\s*i\.id\)\s*<\s*\(\$\d+::bigint,\s*\$\d+::uuid\)/i);
    expect(interpretationContinuation.statements[0]).toMatch(/anchor_status as\s*\(select exists\s*\([\s\S]*?anchor\.sequence=\$\d+::bigint[\s\S]*?anchor\.finalized_at is not null[\s\S]*?as anchor_valid\)/i);
    const continuationVisibleIds = interpretationContinuation.parameters[1].filter(Array.isArray);
    expect(continuationVisibleIds).toHaveLength(4);
    expect(continuationVisibleIds).toEqual(Array.from({ length: 4 }, () => [interpretationContinuation.value.items[0].id]));
  });

  it("pages Claim history newest-first, keeps BIGINT cursors lossless, and verifies anchor membership", async () => {
    const claim = await services.createClaim(projectId, { claimText: "Claim revision zero" });
    const expectedIds = [claim.revision.id];
    for (let index = 1; index < 22; index += 1) {
      const revision = await services.createClaimRevision(projectId, claim.id, {
        claimText: `Claim revision ${index}`,
        expectedCurrentRevisionId: expectedIds[expectedIds.length - 1],
        supports: [],
      });
      expectedIds.push(revision.revision.id);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 10, cursor });
      pages += 1;
      collected.push(...page.items.map((item) => item.id));
      expect(page.current?.id).toBe(expectedIds[expectedIds.length - 1]);
      expect(page.items.every((item) => !("supports" in item))).toBe(true);
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toBe(3);
    expect(collected).toEqual([...expectedIds].reverse());

    const forged = encodeClaimSynthesisHistoryCursor({
      v: 1,
      projectId,
      claimId: claim.id,
      historyType: "claim-revision",
      pageSize: 10,
      lastSequence: "1",
      lastEventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    await expect(history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 10, cursor: forged }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("compares sequences beyond JavaScript's safe integer range using BIGINT", async () => {
    const claim = await services.createClaim(projectId, { claimText: "Initial claim" });
    const highRows = await db.execute(sql`
      insert into claim_revisions (project_id, claim_id, sequence, state, claim_text)
      overriding system value
      values (${projectId}::uuid, ${claim.id}::uuid, 9223372036854775807, 'active', 'Maximum sequence claim')
      returning id
    `) as unknown as Array<Record<string, unknown>>;
    const highId = String(highRows[0].id);
    await db.execute(sql`update claim_revisions set finalized_at=now() where project_id=${projectId}::uuid and id=${highId}::uuid`);
    const lowRows = await db.execute(sql`
      insert into claim_revisions (project_id, claim_id, sequence, state, claim_text)
      overriding system value
      values (${projectId}::uuid, ${claim.id}::uuid, '-9223372036854775808'::bigint, 'active', 'Minimum sequence claim')
      returning id
    `) as unknown as Array<Record<string, unknown>>;
    const lowId = String(lowRows[0].id);
    await db.execute(sql`update claim_revisions set finalized_at=now() where project_id=${projectId}::uuid and id=${lowId}::uuid`);
    const first = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1 });
    expect(first.items[0].id).toBe(highId);
    expect(first.items[0].sequence).toBe("9223372036854775807");
    expect(first.current?.sequence).toBe("9223372036854775807");
    const exactClaim = await exactClaims.getClaimRevisionForExactAudit(projectId, claim.id, highId, { selectedCurrentRevisionId: first.current!.id });
    expect(exactClaim.revision.sequence).toBe("9223372036854775807");
    expect(typeof exactClaim.revision.sequence).toBe("string");
    expect(exactClaim.isCurrentRevision).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1, cursor: first.nextCursor });
    expect(second.items.map((item) => item.sequence)).toEqual([String(claim.revision.sequence)]);
    expect(second.hasMore).toBe(true);
    const third = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1, cursor: second.nextCursor });
    expect(third.items.map((item) => [item.id, item.sequence])).toEqual([[lowId, "-9223372036854775808"]]);
    expect(third.hasMore).toBe(false);
  });

  it("traverses tied Claim sequences by the approved event-ID key without defining a current UUID winner", async () => {
    const claim = await services.createClaim(projectId, { claimText: "Tie sequence claim" });
    const tiedRows = await db.execute(sql`
      insert into claim_revisions (project_id, claim_id, sequence, state, claim_text)
      overriding system value
      values (${projectId}::uuid, ${claim.id}::uuid, ${String(claim.revision.sequence)}::bigint, 'active', 'Tied sequence claim')
      returning id
    `) as unknown as Array<Record<string, unknown>>;
    const tiedId = String(tiedRows[0].id);
    await db.execute(sql`update claim_revisions set finalized_at=now() where project_id=${projectId}::uuid and id=${tiedId}::uuid`);

    const first = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1 });
    expect([claim.revision.id, tiedId]).toContain(first.current?.id);
    expect(first.hasMore).toBe(true);
    const second = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1, cursor: first.nextCursor });
    expect([first.items[0].id, second.items[0].id]).toEqual([claim.revision.id, tiedId].sort().reverse());
  });

  it("handles empty history and deterministically randomized exact page boundaries against the legacy oracle", async () => {
    const emptyClaimRows = await db.execute(sql`insert into claims (project_id) values (${projectId}::uuid) returning id`) as unknown as Array<Record<string, unknown>>;
    const emptyPage = await history.getClaimRevisionHistoryPage(projectId, String(emptyClaimRows[0].id));
    expect(emptyPage).toMatchObject({ items: [], current: null, hasMore: false, nextCursor: null });
    const emptySynthesisRows = await db.execute(sql`insert into synthesis_statements (project_id) values (${projectId}::uuid) returning id`) as unknown as Array<Record<string, unknown>>;
    const emptySynthesisPage = await history.getSynthesisRevisionHistoryPage(projectId, String(emptySynthesisRows[0].id));
    expect(emptySynthesisPage).toMatchObject({ items: [], current: null, hasMore: false, nextCursor: null });
    const interpretationStatement = await services.createSynthesisStatement(projectId, { statementText: "No interpretations yet", extractionRevisionIds: [] });
    const emptyInterpretationPage = await history.getSynthesisInterpretationHistoryPage(projectId, interpretationStatement.statement.id, interpretationStatement.revision.id);
    expect(emptyInterpretationPage).toMatchObject({ items: [], current: null, hasMore: false, nextCursor: null });

    const claim = await services.createClaim(projectId, { claimText: "Deterministic randomized revision zero" });
    const generatedIds = [claim.revision.id];
    const generatedStates: Array<"active" | "withdrawn"> = ["active"];
    let randomState = 0x52a91;
    for (let index = 1; index < 20; index += 1) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      const lifecycle = randomState % 5 === 0 ? "withdrawn" as const : "active" as const;
      const result = await services.createClaimRevision(projectId, claim.id, {
        lifecycle,
        claimText: lifecycle === "active" ? `Randomized active revision ${index} · ${randomState}` : null,
        researcherNote: `Seeded note ${randomState}`,
        expectedCurrentRevisionId: generatedIds[generatedIds.length - 1],
        supports: [],
      });
      generatedIds.push(result.revision.id);
      generatedStates.push(lifecycle);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    let lastHasMore = false;
    do {
      const page = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 5, cursor });
      pageCount += 1;
      collected.push(...page.items.map((item) => item.id));
      lastHasMore = page.hasMore;
      cursor = page.nextCursor;
    } while (cursor);
    const legacy = await services.getClaimHistory(projectId, claim.id);
    expect(collected).toEqual(legacy.revisions.map((revision) => revision.id).reverse());
    expect(collected).toEqual([...generatedIds].reverse());
    expect(pageCount).toBe(4);
    expect(lastHasMore).toBe(false);
    const pageOne = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 5 });
    expect(pageOne.items.map((item) => item.lifecycle)).toEqual(generatedStates.slice(15).reverse());
  });

  it("keeps Synthesis history oldest-first and interpretation history newest-first with exact scoped snapshots", async () => {
    const statement = await services.createSynthesisStatement(projectId, { statementText: "Synthesis revision zero", extractionRevisionIds: [] });
    const revisionIds = [statement.revision.id];
    let currentId = statement.revision.id;
    for (let index = 1; index < 4; index += 1) {
      const revision = await services.reviseSynthesisStatement(projectId, statement.statement.id, {
        statementText: `Synthesis revision ${index}`,
        extractionRevisionIds: [],
      });
      currentId = revision.revision.id;
      revisionIds.push(revision.revision.id);
    }

    const synthesisPageOne = await history.getSynthesisRevisionHistoryPage(projectId, statement.statement.id, { pageSize: 2 });
    expect(synthesisPageOne.items.map((item) => item.id)).toEqual(revisionIds.slice(0, 2));
    expect(synthesisPageOne.current?.id).toBe(currentId);
    expect(synthesisPageOne.hasMore).toBe(true);
    expect(synthesisPageOne.items.every((item) => !("supports" in item))).toBe(true);
    const synthesisPageTwo = await history.getSynthesisRevisionHistoryPage(projectId, statement.statement.id, { pageSize: 2, cursor: synthesisPageOne.nextCursor });
    expect(synthesisPageTwo.items.map((item) => item.id)).toEqual(revisionIds.slice(2));
    const synthesisItems = [...synthesisPageOne.items, ...synthesisPageTwo.items];
    const legacySynthesis = await services.getSynthesisHistory(projectId, statement.statement.id);
    expect(synthesisItems.map((item) => item.id)).toEqual(legacySynthesis.map((item) => item.id));
    expect(synthesisItems.map((item) => [
      item.sequence,
      item.supportStatus,
      item.supportingRevisionCount,
      item.supportingPaperCount,
      item.supportingFieldCount,
    ])).toEqual(legacySynthesis.map((item) => [
      String(item.sequence),
      item.supportStatus,
      item.supportingRevisionCount,
      item.supportingPaperCount,
      item.supportingFieldCount,
    ]));

    const interpretationOne = await services.appendSynthesisInterpretation(projectId, statement.statement.id, currentId, {
      convergenceState: "mixed",
      summary: "First complete interpretation summary",
      researcherNote: "First full researcher note",
      limitations: [{ category: "methodological", body: "Limitation zero" }, { category: "reporting", body: "Limitation one" }],
      questions: [{ body: "Question zero" }, { body: "Question one" }],
      contradictions: [],
    });
    const interpretationTwo = await services.appendSynthesisInterpretation(projectId, statement.statement.id, currentId, {
      convergenceState: "convergent",
      summary: "Current interpretation summary",
      researcherNote: null,
      limitations: [],
      questions: [{ body: "Current question" }],
      contradictions: [],
    });

    const interpretationPage = await history.getSynthesisInterpretationHistoryPage(projectId, statement.statement.id, currentId, { pageSize: 1 });
    expect(interpretationPage.items).toMatchObject([{
      id: interpretationTwo.id,
      sequence: String(interpretationTwo.sequence),
      limitationCount: 0,
      questionCount: 1,
      contradictionCount: 0,
      isCurrent: true,
    }]);
    expect(interpretationPage.current?.id).toBe(interpretationTwo.id);
    expect("limitations" in interpretationPage.items[0]).toBe(false);
    const exact = await exactInterpretations.getExactSynthesisInterpretation(projectId, statement.statement.id, currentId, interpretationOne.id);
    expect(exact.summary).toBe("First complete interpretation summary");
    expect(exact.limitations.map((item) => item.sortOrder)).toEqual([0, 1]);
    expect(exact.questions.map((item) => item.sortOrder)).toEqual([0, 1]);
    expect(exact.isCurrent).toBe(false);
    await expect(exactInterpretations.getExactSynthesisInterpretation(projectId, statement.statement.id, revisionIds[0], interpretationOne.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const interpretationPageTwo = await history.getSynthesisInterpretationHistoryPage(projectId, statement.statement.id, currentId, { pageSize: 1, cursor: interpretationPage.nextCursor });
    expect(interpretationPageTwo.items.map((item) => item.id)).toEqual([interpretationOne.id]);
    const interpretationItems = [...interpretationPage.items, ...interpretationPageTwo.items];
    const legacyInterpretation = await services.getSynthesisInterpretationProjection(projectId, statement.statement.id, currentId);
    expect(interpretationItems.map((item) => item.id)).toEqual(legacyInterpretation.history.map((item) => item.id));
    expect(interpretationItems.map((item) => [
      item.sequence,
      item.limitationCount,
      item.questionCount,
      item.contradictionCount,
    ])).toEqual(legacyInterpretation.history.map((item) => [
      String(item.sequence),
      item.limitations.length,
      item.questions.length,
      item.contradictions.length,
    ]));
  });

  it("traverses tied Synthesis ASC and Interpretation DESC boundaries without a current-winner assertion", async () => {
    const statement = await services.createSynthesisStatement(projectId, { statementText: "Tie-boundary synthesis", extractionRevisionIds: [] });
    const tiedSynthesisIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of tiedSynthesisIds) {
      await db.execute(sql`
        insert into synthesis_revisions (id, sequence, project_id, synthesis_statement_id, state, title, statement_text)
        overriding system value
        values (${id}::uuid, ${String(statement.revision.sequence)}::bigint, ${projectId}::uuid,
          ${statement.statement.id}::uuid, 'active', 'Tied synthesis revision', 'Tied synthesis wording')
      `);
      await db.execute(sql`update synthesis_revisions set finalized_at=now() where project_id=${projectId}::uuid and id=${id}::uuid`);
    }
    const expectedSynthesisOrder = (await db.execute(sql`
      select id::text as id from synthesis_revisions
      where project_id=${projectId}::uuid and synthesis_statement_id=${statement.statement.id}::uuid and finalized_at is not null
      order by sequence asc, id asc
    `) as unknown as Array<{ id: string }>).map((row) => row.id);
    const synthesisIds: string[] = [];
    let synthesisCursor: string | null = null;
    do {
      const page = await history.getSynthesisRevisionHistoryPage(projectId, statement.statement.id, { pageSize: 1, cursor: synthesisCursor });
      synthesisIds.push(...page.items.map((item) => item.id));
      synthesisCursor = page.nextCursor;
    } while (synthesisCursor);
    expect(synthesisIds).toEqual(expectedSynthesisOrder);
    expect(synthesisIds.filter((id) => tiedSynthesisIds.includes(id))).toEqual([...tiedSynthesisIds].sort());

    const originalInterpretation = await services.appendSynthesisInterpretation(projectId, statement.statement.id, statement.revision.id, {
      convergenceState: "convergent", summary: "Original tied-boundary interpretation", limitations: [], questions: [], contradictions: [],
    });
    const tiedInterpretationIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of tiedInterpretationIds) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into synthesis_interpretations (id, sequence, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary)
          overriding system value
          values (${id}::uuid, ${String(originalInterpretation.sequence)}::bigint, ${projectId}::uuid,
            ${statement.statement.id}::uuid, ${statement.revision.id}::uuid, 'convergent', 'Tied interpretation summary')
        `);
        await tx.execute(sql`update synthesis_interpretations set finalized_at=now() where project_id=${projectId}::uuid and id=${id}::uuid`);
      });
    }
    const expectedInterpretationOrder = (await db.execute(sql`
      select id::text as id from synthesis_interpretations
      where project_id=${projectId}::uuid and synthesis_statement_id=${statement.statement.id}::uuid
        and synthesis_revision_id=${statement.revision.id}::uuid and finalized_at is not null
      order by sequence desc, id desc
    `) as unknown as Array<{ id: string }>).map((row) => row.id);
    const interpretationIds: string[] = [];
    let interpretationCursor: string | null = null;
    do {
      const page = await history.getSynthesisInterpretationHistoryPage(projectId, statement.statement.id, statement.revision.id, {
        pageSize: 1,
        cursor: interpretationCursor,
      });
      interpretationIds.push(...page.items.map((item) => item.id));
      interpretationCursor = page.nextCursor;
    } while (interpretationCursor);
    expect(interpretationIds).toEqual(expectedInterpretationOrder);
    expect(interpretationIds.filter((id) => tiedInterpretationIds.includes(id))).toEqual([...tiedInterpretationIds].sort().reverse());
  });

  it("keeps exact Claim, Synthesis, and Interpretation sequence DTOs lossless beyond MAX_SAFE_INTEGER", async () => {
    const field = await services.createExtractionField(projectId, { name: "Exact route sequence field", fieldType: "short_text" });
    const extractionIds: string[] = [];
    const extractionSequences: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const paper = await services.addPaper(projectId, { title: `Exact sequence paper ${index}` });
      await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
      const extraction = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: `Value ${index}`, evidenceIds: [] });
      extractionIds.push(extraction.id);
      extractionSequences.push(String(extraction.sequence));
    }

    const statement = await services.createSynthesisStatement(projectId, { statementText: "Base exact sequence synthesis", extractionRevisionIds: [] });
    const highSynthesisRows = await db.execute(sql`
      insert into synthesis_revisions (sequence, project_id, synthesis_statement_id, state, title, statement_text)
      overriding system value
      values (9223372036854775807, ${projectId}::uuid, ${statement.statement.id}::uuid,
        'active', 'High exact synthesis', 'High exact synthesis wording')
      returning id
    `) as unknown as Array<{ id: string }>;
    const highSynthesisId = String(highSynthesisRows[0].id);
    for (const extractionId of extractionIds) {
      await db.execute(sql`
        insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id)
        values (${projectId}::uuid, ${highSynthesisId}::uuid, ${extractionId}::uuid)
      `);
    }
    await db.execute(sql`update synthesis_revisions set finalized_at=now() where project_id=${projectId}::uuid and id=${highSynthesisId}::uuid`);

    const synthesisRouteSequences = await exactSynthesisRoutes.getSynthesisRevisionExactRouteSequences(projectId, statement.statement.id, highSynthesisId);
    expect(synthesisRouteSequences.sequence).toBe("9223372036854775807");
    expect(synthesisRouteSequences.extractionRevisionSequences).toEqual(Object.fromEntries(extractionIds.map((id, index) => [id, extractionSequences[index]])));

    const claim = await services.createClaim(projectId, { claimText: "Claim supporting the high-sequence synthesis" });
    const exactClaim = await services.createClaimRevision(projectId, claim.id, {
      claimText: "Claim supporting the high-sequence synthesis",
      expectedCurrentRevisionId: claim.revision.id,
      supports: [{ kind: "synthesisRevision", synthesisRevisionId: highSynthesisId }],
    });
    const exactClaimRoute = await exactClaims.getClaimRevisionForExactAudit(projectId, claim.id, exactClaim.revision.id);
    expect(exactClaimRoute.revision.supports.synthesisRevisions[0].synthesisRevision.sequence).toBe("9223372036854775807");
    const expectedExtractionSequences = Object.fromEntries(extractionIds.map((id, index) => [id, extractionSequences[index]]));
    expect(Object.fromEntries(exactClaimRoute.revision.supports.synthesisRevisions[0].synthesisRevision.supports.map((support) => [
      support.extractionRevisionId,
      support.extractionRevision.sequence,
    ]))).toEqual(expectedExtractionSequences);

    const [leftExtractionId, rightExtractionId] = [...extractionIds].sort();
    const highInterpretationRows = await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        insert into synthesis_interpretations (sequence, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary)
        overriding system value
        values (9007199254740993, ${projectId}::uuid, ${statement.statement.id}::uuid, ${highSynthesisId}::uuid,
          'contradictory', 'High exact interpretation summary')
        returning id
      `) as unknown as Array<{ id: string }>;
      const interpretationId = String(inserted[0].id);
      await tx.execute(sql`
        insert into synthesis_interpretation_contradictions
          (project_id, interpretation_id, synthesis_revision_id, sort_order, left_extraction_revision_id, right_extraction_revision_id)
        values (${projectId}::uuid, ${interpretationId}::uuid, ${highSynthesisId}::uuid, 0,
          ${leftExtractionId}::uuid, ${rightExtractionId}::uuid)
      `);
      await tx.execute(sql`update synthesis_interpretations set finalized_at=now() where project_id=${projectId}::uuid and id=${interpretationId}::uuid`);
      return inserted;
    });
    const highInterpretationId = String(highInterpretationRows[0].id);
    const exactInterpretation = await exactInterpretations.getExactSynthesisInterpretation(projectId, statement.statement.id, highSynthesisId, highInterpretationId);
    expect(exactInterpretation.sequence).toBe("9007199254740993");
    expect(exactInterpretation.contradictions[0].leftSupport?.sequence).toBe(expectedExtractionSequences[leftExtractionId]);
    expect(exactInterpretation.contradictions[0].rightSupport?.sequence).toBe(expectedExtractionSequences[rightExtractionId]);
    expect(typeof exactInterpretation.sequence).toBe("string");
  });

  it("keeps Claim provenance sequences distinct when UUIDs collide across revision tables", async () => {
    const field = await services.createExtractionField(projectId, { name: "Colliding identity field", fieldType: "short_text" });
    const extractionRevisions = [];
    for (const title of ["Shared extraction identity", "Nested extraction identity"]) {
      const paper = await services.addPaper(projectId, { title });
      await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
      extractionRevisions.push(await services.reviseExtractionValue(projectId, paper.id, field.id, { value: title, evidenceIds: [] }));
    }

    const [sharedExtraction, nestedExtraction] = extractionRevisions;
    const statement = await services.createSynthesisStatement(projectId, { statementText: "Shared table-local UUID synthesis", extractionRevisionIds: [] });
    await db.execute(sql`
      insert into synthesis_revisions (id, sequence, project_id, synthesis_statement_id, state, title, statement_text)
      overriding system value
      values (${sharedExtraction.id}::uuid, 9007199254740993, ${projectId}::uuid, ${statement.statement.id}::uuid,
        'active', 'Shared table-local UUID', 'Synthesis support with a table-local identity')
    `);
    await db.execute(sql`
      insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id)
      values (${projectId}::uuid, ${sharedExtraction.id}::uuid, ${nestedExtraction.id}::uuid)
    `);
    await db.execute(sql`update synthesis_revisions set finalized_at=now() where project_id=${projectId}::uuid and id=${sharedExtraction.id}::uuid`);

    const claim = await services.createClaim(projectId, { claimText: "Mixed provenance retains table-local sequences" });
    const claimRevision = await services.createClaimRevision(projectId, claim.id, {
      claimText: claim.claimText,
      expectedCurrentRevisionId: claim.revision.id,
      supports: [
        { kind: "extractionRevision", extractionRevisionId: sharedExtraction.id },
        { kind: "synthesisRevision", synthesisRevisionId: sharedExtraction.id },
      ],
    });
    const exact = await exactClaims.getClaimRevisionForExactAudit(projectId, claim.id, claimRevision.revision.id, {
      selectedCurrentRevisionId: claimRevision.revision.id,
    });

    expect(exact.revision.supports.extractionRevisions[0].extractionRevision.sequence).toBe(String(sharedExtraction.sequence));
    const synthesis = exact.revision.supports.synthesisRevisions[0].synthesisRevision;
    expect(synthesis.sequence).toBe("9007199254740993");
    expect(synthesis.supports[0].extractionRevision.sequence).toBe(String(nestedExtraction.sequence));
    expect(exact.revision.sequence).toBe(String(claimRevision.revision.sequence));
  });

  it("retains archived-field and superseded extraction provenance in the exact Claim read", async () => {
    const paper = await services.addPaper(projectId, { title: "Archived field provenance paper" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    const field = await services.createExtractionField(projectId, { name: "Archived rate field", fieldType: "short_text" });
    const supportedRevision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "84.2%", evidenceIds: [] });
    const claim = await services.createClaim(projectId, { claimText: "The earlier reported rate was 84.2%" });
    const supportedClaim = await services.createClaimRevision(projectId, claim.id, {
      claimText: claim.claimText,
      supports: [{ kind: "extractionRevision", extractionRevisionId: supportedRevision.id }],
      expectedCurrentRevisionId: claim.revision.id,
    });
    await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "82.1%", evidenceIds: [] });
    await services.archiveExtractionField(projectId, field.id);

    const exact = await exactClaims.getClaimRevisionForExactAudit(projectId, claim.id, supportedClaim.revision.id);
    const support = exact.revision.supports.extractionRevisions[0];
    expect(support.extractionRevisionId).toBe(supportedRevision.id);
    expect(support.extractionRevision.textValue).toBe("84.2%");
    expect(support.isCurrentExtractionRevision).toBe(false);
    expect(support.field.name).toBe("Archived rate field");
    expect(support.field.archivedAt).not.toBeNull();
  });

  it("keeps max-50 preview DTO pages with JSON-escaped control characters under 256 KiB", async () => {
    const cappedControl = (previewLength: number) => "\u0001".repeat(previewLength + 3);
    const claimText = cappedControl(448);
    const claimNote = cappedControl(256);
    const claim = await services.createClaim(projectId, { claimText });
    let currentClaimRevisionId = claim.revision.id;
    for (let index = 1; index <= 50; index += 1) {
      const revision = await services.createClaimRevision(projectId, claim.id, {
        claimText,
        researcherNote: index === 1 ? null : claimNote,
        expectedCurrentRevisionId: currentClaimRevisionId,
        supports: [],
      });
      currentClaimRevisionId = revision.revision.id;
    }
    const claimPage = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 50 });
    expect(claimPage.items).toHaveLength(50);
    expect(claimPage.hasMore).toBe(true);
    expect(claimPage.nextCursor).toBeTruthy();
    expect(claimPage.items.every((item) => item.claimTextPreview?.length === 448 && item.claimTextTruncated)).toBe(true);
    expect(claimPage.items.some((item) => item.researcherNotePreview?.length === 256 && item.researcherNoteTruncated)).toBe(true);
    expect(claimPage.items.some((item) => item.researcherNotePreview === null && !item.researcherNoteTruncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(claimPage), "utf8")).toBeLessThanOrEqual(256 * 1024);

    const set = (await services.createEvidenceSet(projectId, { name: cappedControl(64) })).set;
    const field = await services.createExtractionField(projectId, { name: "Payload cap field", fieldType: "short_text" });
    const preparation = await services.createSynthesisPreparation(projectId, { evidenceSetId: set.id, extractionFieldId: field.id });
    const firstSynthesis = await services.finalizeSynthesisPreparation(projectId, preparation.id, {
      title: cappedControl(96),
      statementText: cappedControl(320),
      researcherNote: cappedControl(160),
    });
    const synthesisTitle = cappedControl(96);
    const synthesisStatement = cappedControl(320);
    const synthesisNote = cappedControl(160);
    let currentSynthesisRevisionId = firstSynthesis.revision.id;
    for (let index = 1; index <= 50; index += 1) {
      const revision = await services.reviseSynthesisStatement(projectId, firstSynthesis.statement.id, {
        title: synthesisTitle,
        statementText: synthesisStatement,
        researcherNote: index === 1 ? null : synthesisNote,
        extractionRevisionIds: [],
      });
      currentSynthesisRevisionId = revision.revision.id;
    }
    const synthesisPage = await history.getSynthesisRevisionHistoryPage(projectId, firstSynthesis.statement.id, { pageSize: 50 });
    expect(synthesisPage.items).toHaveLength(50);
    expect(synthesisPage.hasMore).toBe(true);
    expect(synthesisPage.nextCursor).toBeTruthy();
    expect(synthesisPage.items.every((item) => item.titlePreview?.length === 96 && item.titleTruncated)).toBe(true);
    expect(synthesisPage.items.every((item) => item.statementPreview?.length === 320 && item.statementTruncated)).toBe(true);
    expect(synthesisPage.items.some((item) => item.researcherNotePreview?.length === 160 && item.researcherNoteTruncated)).toBe(true);
    expect(synthesisPage.items.some((item) => item.researcherNotePreview === null && !item.researcherNoteTruncated)).toBe(true);
    expect(synthesisPage.items.find((item) => item.preparation)?.preparation).toMatchObject({
      evidenceSetNamePreview: cappedControl(64).slice(0, 64),
      evidenceSetNameTruncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(synthesisPage), "utf8")).toBeLessThanOrEqual(256 * 1024);

    const interpretationSummary = cappedControl(448);
    const interpretationNote = cappedControl(256);
    const maximumInterpretationSummary = "\u0001".repeat(20_000);
    const maximumInterpretationNote = "\u0001".repeat(10_000);
    const initialInterpretation = await services.appendSynthesisInterpretation(projectId, firstSynthesis.statement.id, currentSynthesisRevisionId, {
      convergenceState: "mixed",
      summary: interpretationSummary,
      researcherNote: interpretationNote,
      limitations: [], questions: [], contradictions: [],
    });
    for (let index = 1; index <= 50; index += 1) {
      await services.appendSynthesisInterpretation(projectId, firstSynthesis.statement.id, currentSynthesisRevisionId, {
        convergenceState: "mixed",
        summary: index === 50 ? maximumInterpretationSummary : interpretationSummary,
        researcherNote: index === 1 ? null : index === 50 ? maximumInterpretationNote : interpretationNote,
        limitations: [], questions: [], contradictions: [],
      });
    }
    const interpretationPage = await history.getSynthesisInterpretationHistoryPage(projectId, firstSynthesis.statement.id, currentSynthesisRevisionId, { pageSize: 50 });
    expect(interpretationPage.items).toHaveLength(50);
    expect(interpretationPage.hasMore).toBe(true);
    expect(interpretationPage.nextCursor).toBeTruthy();
    expect(interpretationPage.items.every((item) => item.summaryPreview.length === 448 && item.summaryTruncated)).toBe(true);
    expect(interpretationPage.items.some((item) => item.researcherNotePreview?.length === 256 && item.researcherNoteTruncated)).toBe(true);
    expect(interpretationPage.items.some((item) => item.researcherNotePreview === null && !item.researcherNoteTruncated)).toBe(true);
    expect(interpretationPage.items).not.toContainEqual(expect.objectContaining({ id: initialInterpretation.id }));
    expect(interpretationPage.current).not.toHaveProperty("summary");
    expect(interpretationPage.current).not.toHaveProperty("researcherNote");
    expect(Buffer.byteLength(JSON.stringify(interpretationPage), "utf8")).toBeLessThanOrEqual(256 * 1024);
    const currentInterpretation = await currentInterpretations.getCurrentSynthesisInterpretationSummary(projectId, firstSynthesis.statement.id, currentSynthesisRevisionId);
    expect(currentInterpretation?.id).toBeTruthy();
    expect(currentInterpretation?.summary).toBe(maximumInterpretationSummary);
    expect(currentInterpretation?.researcherNote).toBe(maximumInterpretationNote);
  });

  it("bounds summaries for a mixed large Claim support graph and maximum-size interpretation children", async () => {
    const field = await services.createExtractionField(projectId, { name: "Large fixture finding", fieldType: "short_text" });
    const extractionIds: string[] = [];
    const evidenceIds: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const paper = await services.addPaper(projectId, { title: `Large support Paper ${index}` });
      await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
      evidenceIds.push((await services.recordEvidence(projectId, { paperId: paper.id, sourceText: `Large fixture passage ${index}`, pageNumber: 1 })).id);
      extractionIds.push((await services.reviseExtractionValue(projectId, paper.id, field.id, { value: `Finding ${index}`, evidenceIds: [] })).id);
    }
    const synthesis = await services.createSynthesisStatement(projectId, { statementText: "Large exact support synthesis", extractionRevisionIds: extractionIds });
    const claim = await services.createClaim(projectId, { claimText: "Claim with a mixed, high-cardinality support graph" });
    const largeClaim = await services.createClaimRevision(projectId, claim.id, {
      claimText: "Claim with a mixed, high-cardinality support graph",
      expectedCurrentRevisionId: claim.revision.id,
      supports: [
        ...evidenceIds.map((evidenceId) => ({ kind: "evidence" as const, evidenceId })),
        ...extractionIds.map((extractionRevisionId) => ({ kind: "extractionRevision" as const, extractionRevisionId })),
        { kind: "synthesisRevision" as const, synthesisRevisionId: synthesis.revision.id },
      ],
    });
    const claimPage = await history.getClaimRevisionHistoryPage(projectId, claim.id, { pageSize: 1 });
    expect(claimPage.items[0]).toMatchObject({
      id: largeClaim.revision.id,
      directEvidenceCount: 33,
      extractionRevisionCount: 33,
      synthesisRevisionCount: 1,
      totalSupportCount: 67,
      distinctPaperCount: 33,
      citationCandidateCount: 33,
    });
    expect(claimPage.items[0]).not.toHaveProperty("supports");

    const orderedExtractionIds = [...extractionIds].sort();
    const contradictionPairs: Array<{ leftExtractionRevisionId: string; rightExtractionRevisionId: string }> = [];
    for (let left = 0; left < orderedExtractionIds.length && contradictionPairs.length < 500; left += 1) {
      for (let right = left + 1; right < orderedExtractionIds.length && contradictionPairs.length < 500; right += 1) {
        contradictionPairs.push({ leftExtractionRevisionId: orderedExtractionIds[left], rightExtractionRevisionId: orderedExtractionIds[right] });
      }
    }
    const interpretation = await services.appendSynthesisInterpretation(projectId, synthesis.statement.id, synthesis.revision.id, {
      convergenceState: "contradictory",
      summary: "Large interpretation parent summary",
      limitations: Array.from({ length: 100 }, (_, index) => ({ category: "other" as const, body: `Large child limitation ${index}` })),
      questions: Array.from({ length: 100 }, (_, index) => ({ body: `Large child question ${index}` })),
      contradictions: contradictionPairs,
    });
    const interpretationPage = await history.getSynthesisInterpretationHistoryPage(projectId, synthesis.statement.id, synthesis.revision.id, { pageSize: 1 });
    expect(interpretationPage.items[0]).toMatchObject({
      id: interpretation.id,
      limitationCount: 100,
      questionCount: 100,
      contradictionCount: 500,
    });
    expect(interpretationPage.items[0]).not.toHaveProperty("limitations");
    expect(interpretationPage.items[0]).not.toHaveProperty("questions");
    expect(interpretationPage.items[0]).not.toHaveProperty("contradictions");
    expect(Buffer.byteLength(JSON.stringify(interpretationPage), "utf8")).toBeLessThan(8_192);

    const exact = await exactInterpretations.getExactSynthesisInterpretation(projectId, synthesis.statement.id, synthesis.revision.id, interpretation.id);
    expect(exact.limitations).toHaveLength(100);
    expect(exact.questions).toHaveLength(100);
    expect(exact.contradictions).toHaveLength(500);
    expect(exact.contradictions[0].leftExtractionRevisionId < exact.contradictions[0].rightExtractionRevisionId).toBe(true);
    expect(exact.contradictions[499].sortOrder).toBe(499);
  });
});
