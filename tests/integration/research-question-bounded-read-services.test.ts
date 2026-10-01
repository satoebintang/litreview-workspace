import "dotenv/config";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createResearchQuestionBoundedReadServices } from "@/application/research-question-bounded-read-services";
import { createResearchQuestionTraceabilityServices } from "@/application/research-question-traceability-services";
import { createReviewServices } from "@/application/services";
import { resolveDatabaseUrl } from "@/db/config";
import { schema } from "@/db/schema";

const BASE_URL = resolveDatabaseUrl();
const DATABASE_NAME = `slice48_rq_reads_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function decodeCursor(token: string) {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
}

function encodeCursor(cursor: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function selectCount(log: string[]) {
  return log.filter((query) => /^\s*(select|with)\b/i.test(query)).length;
}

describe("Slice 48 bounded Research Question reads", () => {
  let admin: postgres.Sql | undefined;
  let client: postgres.Sql | undefined;
  let review: ReturnType<typeof createReviewServices>;
  let traceability: ReturnType<typeof createResearchQuestionTraceabilityServices>;
  let reads: ReturnType<typeof createResearchQuestionBoundedReadServices>;
  const selectLog: string[] = [];

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    client = postgres(databaseUrl.toString(), {
      max: 5,
      prepare: false,
      debug: (_connection, query) => { selectLog.push(query); },
    });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    review = createReviewServices(db);
    traceability = createResearchQuestionTraceabilityServices(db);
    reads = createResearchQuestionBoundedReadServices(db);
  });

  afterAll(async () => {
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("executes the bounded matrix SQL within budget and counts each drifted exact context once", async () => {
    const project = await review.createProject({ title: `Matrix ${randomUUID()}`, researchQuestion: "How does context drift behave?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const paper = await review.addPaper(project.id, { title: "Source paper" });
    const evidence = await review.recordEvidence(project.id, { paperId: paper.id, sourceText: "Supports each claim", pageNumber: 1 });

    const makeSupportedClaim = async (text: string) => {
      const claim = await review.createClaim(project.id, { claimText: text });
      const supported = await review.createClaimRevision(project.id, claim.id, {
        claimText: text,
        supports: [{ kind: "evidence", evidenceId: evidence.id }],
        expectedCurrentRevisionId: claim.revision.id,
      });
      await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: claim.id });
      return { claim, revision: supported.revision };
    };

    const first = await makeSupportedClaim("Repeated exact context");
    let exactAnswerId = "";
    for (const answerText of ["First answer", "Second answer"]) {
      const answer = await review.appendResearchQuestionAnswer(project.id, question.id, {
        answerText,
        claimRevisionIds: [first.revision.id],
        synthesisRevisionIds: [],
      });
      if (!exactAnswerId) exactAnswerId = answer.id;
    }
    await review.createClaimRevision(project.id, first.claim.id, {
      claimText: "Superseding supported claim",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: first.revision.id,
    });

    const second = await makeSupportedClaim("Withdrawn and unlinked context");
    await review.appendResearchQuestionAnswer(project.id, question.id, {
      answerText: "Third answer",
      claimRevisionIds: [second.revision.id],
      synthesisRevisionIds: [],
    });
    await review.withdrawClaim(project.id, second.claim.id, { expectedCurrentRevisionId: second.revision.id });
    await traceability.unlinkClaim({ projectId: project.id, questionId: question.id, claimId: second.claim.id });

    selectLog.length = 0;
    const page = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 1 });
    const selects = selectLog.filter((query) => /^\s*(select|with)\b/i.test(query));

    expect(selects).toHaveLength(6);
    expect(page.project.id).toBe(project.id);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.counts).toMatchObject({
      finalizedAnswers: 3,
      claimAnswerContexts: 3,
      synthesisAnswerContexts: 0,
      driftedAnswerContexts: 3,
      linkedClaims: 1,
      activeClaims: 1,
    });
    expect(page.rows[0]?.diagnostics.fullyCovered).toBe(false);
    expect(page.rows[0]?.diagnostics.claims.linked_claim_without_current_active_revision).toBeUndefined();
    expect(page.rows[0]?.diagnostics.claims.linked_current_claim_unsupported).toBeUndefined();
    expect(page.rows[0]?.diagnostics.claims.linked_current_claim_not_placed).toBe(1);

    const ineligible = await review.createClaim(project.id, { claimText: "Still a linked candidate when unsupported" });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: ineligible.id });
    selectLog.length = 0;
    const linkPage = await reads.listResearchQuestionLinkPage(project.id, question.id, "claim", { pageSize: 1 });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(linkPage.items).toHaveLength(1);
    expect(linkPage.hasMore).toBe(true);
    const continuation = await reads.listResearchQuestionLinkPage(project.id, question.id, "claim", { pageSize: 1, cursor: linkPage.nextCursor });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(4);
    expect(continuation.items).toHaveLength(1);
    expect([linkPage.items[0]?.id, continuation.items[0]?.id]).toContain(ineligible.id);
    const unsupportedRow = [linkPage.items[0], continuation.items[0]].find((row) => row?.id === ineligible.id)!;
    expect(unsupportedRow.diagnosticFlags).toEqual(["linked_current_claim_unsupported", "linked_current_claim_not_placed"]);

    selectLog.length = 0;
    const candidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { pageSize: 50 });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(candidates.items.find((item) => item.targetId === ineligible.id)).toMatchObject({ isCurrentlyLinked: true, isSelectable: false, reason: "unsupported" });

    selectLog.length = 0;
    const historicalDetail = await reads.getResearchQuestionTargetDetail(project.id, question.id, "claim", second.claim.id);
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(historicalDetail.currentlyLinked).toBe(false);
    expect(historicalDetail.target.diagnosticFlags).toEqual([]);
    expect(historicalDetail.history.items.map((event) => event.action)).toEqual(["linked", "unlinked"]);

    selectLog.length = 0;
    const exactSnapshot = await reads.getResearchQuestionAnswerBrowserSnapshot(project.id, question.id, exactAnswerId);
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(3);
    expect(exactSnapshot.snapshot.claimContexts[0]).toMatchObject({
      claimRevisionId: first.revision.id,
      isCurrentRevision: false,
      currentRevisionId: expect.not.stringMatching(first.revision.id),
      driftFlags: ["referenced_claim_revision_superseded"],
    });
    expect(exactSnapshot.snapshot.sequence).toMatch(/^\d+$/);

    const wildcardField = await review.createExtractionField(project.id, { name: "Literal 100%_\\ field", fieldType: "short_text" });
    selectLog.length = 0;
    const picker = await reads.getResearchQuestionTargetPickerPage(project.id, question.id, "extraction-field", { pageSize: 1, search: "%_" });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(picker.items.map((item) => item.id)).toEqual([wildcardField.id]);
    expect(picker.items[0]?.isCurrentlyLinked).toBe(false);
    const escapedPicker = await reads.getResearchQuestionTargetPickerPage(project.id, question.id, "extraction-field", { search: "%_\\" });
    expect(escapedPicker.items.map((item) => item.id)).toEqual([wildcardField.id]);
    await expect(reads.getResearchQuestionTargetPickerPage(project.id, question.id, "extraction-field", { search: "😀".repeat(201) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const field = await review.createExtractionField(project.id, { name: "Epoch change", fieldType: "short_text" });
    await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id });
    selectLog.length = 0;
    await expect(reads.listResearchQuestionLinkPage(project.id, question.id, "claim", { pageSize: 1, cursor: linkPage.nextCursor })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(1);

    selectLog.length = 0;
    const workspace = await reads.getResearchQuestionWorkspace(project.id, question.id);
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(11);
    expect(workspace.project.id).toBe(project.id);
    expect(workspace.traceabilityEpoch).toBeTruthy();
    expect(workspace.currentLinkCounts.claims).toBe(2);
    expect(workspace.answerSummary).toMatchObject({ finalizedAnswerCount: 3, claimContextCount: 3, driftedContextCount: 3 });
    expect(workspace.answerHistory.items).toHaveLength(3);

    selectLog.length = 0;
    const answerPage = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 2 });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(answerPage.items).toHaveLength(2);
    expect(answerPage.hasMore).toBe(true);
    expect(answerPage.items.reduce((sum, item) => sum + item.driftedContextCount, 0)).toBe(2);

    const includedPaper = await review.addPaper(project.id, { title: "Coverage paper with microsecond boundary A" });
    const tiedPaperB = await review.addPaper(project.id, { title: "Coverage paper with microsecond boundary B" });
    const tiedPaperC = await review.addPaper(project.id, { title: "Coverage paper with microsecond boundary C" });
    for (const coveragePaper of [includedPaper, tiedPaperB, tiedPaperC]) {
      await review.recordScreeningDecision(project.id, coveragePaper.id, { decision: "include" });
      await review.recordFullTextRetrievalAttempt(project.id, coveragePaper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await review.recordFullTextScreeningDecision(project.id, coveragePaper.id, { decision: "include" });
    }
    await review.reviseExtractionValue(project.id, includedPaper.id, field.id, { value: "Initially present", evidenceIds: [] });
    await review.clearExtractionValue(project.id, includedPaper.id, field.id);
    await client!.unsafe("update papers set created_at=$1::timestamptz where project_id=$2 and id=any($3::uuid[])", ["2026-01-01 00:00:00.123456+00", project.id, [includedPaper.id, tiedPaperB.id, tiedPaperC.id]]);
    selectLog.length = 0;
    const coverage = await reads.getResearchQuestionExtractionCoveragePage(project.id, question.id, field.id, { pageSize: 1 });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(1);
    expect(coverage.items).toHaveLength(1);
    expect(coverage.hasMore).toBe(true);
    const coveragePage2 = await reads.getResearchQuestionExtractionCoveragePage(project.id, question.id, field.id, { pageSize: 1, cursor: coverage.nextCursor });
    const coveragePage3 = await reads.getResearchQuestionExtractionCoveragePage(project.id, question.id, field.id, { pageSize: 1, cursor: coveragePage2.nextCursor });
    const pageIds = [coverage.items[0]?.paperId, coveragePage2.items[0]?.paperId, coveragePage3.items[0]?.paperId];
    expect(pageIds).toEqual(expect.arrayContaining([includedPaper.id, tiedPaperB.id, tiedPaperC.id]));
    expect(new Set(pageIds).size).toBe(3);
    expect([coverage.items[0], coveragePage2.items[0], coveragePage3.items[0]].find((row) => row?.paperId === includedPaper.id)).toMatchObject({ revisionId: expect.any(String), status: "cleared", displayValue: null });
    expect(workspace.links.extractionFields.items.find((item) => item.id === field.id)?.hasCurrentData).toBe(false);
  });

  it("advances epochs for every service and direct insert, while rejected or rolled-back mutations leave no epoch", async () => {
    const project = await review.createProject({ title: `Epoch ${randomUUID()}`, researchQuestion: "Does each typed insert advance the epoch?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const otherProject = await review.createProject({ title: `Epoch foreign ${randomUUID()}`, researchQuestion: "Can another Project mutate this epoch?" });
    const makeTargets = async (projectId: string, label: string) => ({
      field: await review.createExtractionField(projectId, { name: `${label} field`, fieldType: "short_text" }),
      evidenceSet: (await review.createEvidenceSet(projectId, { name: `${label} set` })).set,
      synthesis: (await review.createSynthesisStatement(projectId, { statementText: `${label} synthesis`, extractionRevisionIds: [] })).statement,
      claim: await review.createClaim(projectId, { claimText: `${label} claim` }),
    });
    const directTargets = await makeTargets(project.id, "Direct epoch");
    const serviceTargets = await makeTargets(project.id, "Service epoch");
    const foreignTargets = await makeTargets(otherProject.id, "Foreign epoch");
    const rollbackTargets = await makeTargets(project.id, "Rollback epoch");
    const specs = (targets: Awaited<ReturnType<typeof makeTargets>>, targetProjectId: string, targetQuestionId: string) => [
      {
        table: "research_question_extraction_field_events", column: "extraction_field_id", id: targets.field.id,
        link: () => traceability.linkExtractionField({ projectId: targetProjectId, questionId: targetQuestionId, fieldId: targets.field.id }),
        unlink: () => traceability.unlinkExtractionField({ projectId: targetProjectId, questionId: targetQuestionId, fieldId: targets.field.id }),
      },
      {
        table: "research_question_evidence_set_events", column: "evidence_set_id", id: targets.evidenceSet.id,
        link: () => traceability.linkEvidenceSet({ projectId: targetProjectId, questionId: targetQuestionId, evidenceSetId: targets.evidenceSet.id }),
        unlink: () => traceability.unlinkEvidenceSet({ projectId: targetProjectId, questionId: targetQuestionId, evidenceSetId: targets.evidenceSet.id }),
      },
      {
        table: "research_question_synthesis_statement_events", column: "synthesis_statement_id", id: targets.synthesis.id,
        link: () => traceability.linkSynthesisStatement({ projectId: targetProjectId, questionId: targetQuestionId, statementId: targets.synthesis.id }),
        unlink: () => traceability.unlinkSynthesisStatement({ projectId: targetProjectId, questionId: targetQuestionId, statementId: targets.synthesis.id }),
      },
      {
        table: "research_question_claim_events", column: "claim_id", id: targets.claim.id,
        link: () => traceability.linkClaim({ projectId: targetProjectId, questionId: targetQuestionId, claimId: targets.claim.id }),
        unlink: () => traceability.unlinkClaim({ projectId: targetProjectId, questionId: targetQuestionId, claimId: targets.claim.id }),
      },
    ] as const;
    const readEpoch = async () => {
      const [row] = await client!.unsafe(
        "select traceability_epoch::text as epoch,updated_at::text as updated_at from research_questions where project_id=$1 and id=$2",
        [project.id, question.id],
      ) as { epoch: string; updated_at: string }[];
      return row!;
    };
    const insertDirect = (tx: Pick<postgres.Sql, "unsafe">, spec: ReturnType<typeof specs>[number], action: "linked" | "unlinked" = "linked") =>
      tx.unsafe(`insert into ${spec.table} (project_id,research_question_id,${spec.column},action) values ($1,$2,$3,$4)`, [project.id, question.id, spec.id, action]);
    const [initial] = await client!.unsafe(
      "select traceability_epoch::text as epoch,updated_at::text as updated_at from research_questions where project_id=$1 and id=$2",
      [project.id, question.id],
    ) as { epoch: string; updated_at: string }[];
    expect(initial?.epoch).toBe("0");

    const directSpecs = specs(directTargets, project.id, question.id);
    for (const [index, spec] of directSpecs.entries()) {
      await insertDirect(client!, spec);
      expect((await readEpoch()).epoch).toBe(String(index + 1));
    }

    for (const spec of directSpecs) {
      const before = (await readEpoch()).epoch;
      await expect(insertDirect(client!, spec)).rejects.toThrow(/already linked/i);
      expect((await readEpoch()).epoch).toBe(before);
      const [count] = await client!.unsafe(`select count(*)::int as count from ${spec.table} where project_id=$1 and research_question_id=$2 and ${spec.column}=$3`, [project.id, question.id, spec.id]) as { count: number }[];
      expect(count?.count).toBe(1);
    }

    const foreignSpecs = specs(foreignTargets, project.id, question.id);
    for (const spec of foreignSpecs) {
      const before = (await readEpoch()).epoch;
      await expect(insertDirect(client!, spec)).rejects.toThrow();
      await expect(spec.link()).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
      expect((await readEpoch()).epoch).toBe(before);
    }

    const serviceSpecs = specs(serviceTargets, project.id, question.id);
    for (const [index, spec] of serviceSpecs.entries()) {
      await spec.link();
      expect((await readEpoch()).epoch).toBe(String(5 + index));
    }
    for (const spec of serviceSpecs) {
      const before = (await readEpoch()).epoch;
      await expect(spec.link()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect((await readEpoch()).epoch).toBe(before);
    }

    for (const spec of directSpecs) {
      const [event] = await client!.unsafe(`select id::text as id from ${spec.table} where project_id=$1 and research_question_id=$2 and ${spec.column}=$3`, [project.id, question.id, spec.id]) as { id: string }[];
      expect(event?.id).toBeTruthy();
      const before = (await readEpoch()).epoch;
      await expect(client!.unsafe(`update ${spec.table} set note='attempted mutation' where id=$1`, [event!.id])).rejects.toThrow(/append-only/i);
      expect((await readEpoch()).epoch).toBe(before);
      await expect(client!.unsafe(`delete from ${spec.table} where id=$1`, [event!.id])).rejects.toThrow(/append-only/i);
      expect((await readEpoch()).epoch).toBe(before);
    }

    for (const [index, spec] of serviceSpecs.entries()) {
      await spec.unlink();
      expect((await readEpoch()).epoch).toBe(String(9 + index));
    }

    const beforeRollback = (await readEpoch()).epoch;
    await expect(client!.begin(async (tx) => {
      for (const spec of specs(rollbackTargets, project.id, question.id)) await insertDirect(tx, spec);
      const [inside] = await tx.unsafe("select traceability_epoch::text as epoch from research_questions where project_id=$1 and id=$2", [project.id, question.id]) as { epoch: string }[];
      expect(BigInt(inside!.epoch)).toBe(BigInt(beforeRollback) + BigInt(4));
      throw new Error("rollback four typed epoch events");
    })).rejects.toThrow("rollback four typed epoch events");
    expect((await readEpoch()).epoch).toBe(beforeRollback);
    for (const spec of specs(rollbackTargets, project.id, question.id)) {
      const [count] = await client!.unsafe(`select count(*)::int as count from ${spec.table} where project_id=$1 and research_question_id=$2 and ${spec.column}=$3`, [project.id, question.id, spec.id]) as { count: number }[];
      expect(count?.count).toBe(0);
    }
    expect((await readEpoch()).updated_at).toBe(initial?.updated_at);
  }, 60_000);

  it("covers every typed bounded target reader and preserves linked but ineligible Answer candidates", async () => {
    const project = await review.createProject({ title: `Typed reads ${randomUUID()}`, researchQuestion: "Do all bounded target readers preserve exact typed membership?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const longQuestionLabel = "Exact workspace header ".repeat(35).trim();
    const longQuestion = await review.createResearchQuestion(project.id, { identifier: "RQ-long-header", label: longQuestionLabel });
    const matrix = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 20 });
    expect(matrix.rows.find((row) => row.question.id === longQuestion.id)?.question.label).toBe(longQuestionLabel.slice(0, 280));
    const longWorkspace = await reads.getResearchQuestionWorkspace(project.id, longQuestion.id);
    expect(longWorkspace.question.label).toBe(longQuestionLabel);
    const field = await review.createExtractionField(project.id, { name: "Typed field", fieldType: "short_text" });
    const setResult = await review.createEvidenceSet(project.id, { name: "Typed set" });
    const pickerField = await review.createExtractionField(project.id, { name: "Archived unlinked picker field", fieldType: "short_text" });
    await review.archiveExtractionField(project.id, pickerField.id);
    const pickerSet = await review.createEvidenceSet(project.id, { name: "Archived unlinked picker set" });
    await review.archiveEvidenceSet(project.id, pickerSet.set.id);
    const unsupportedSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Unsupported but interpreted", extractionRevisionIds: [] });
    const supportedClaim = await review.createClaim(project.id, { claimText: "Supported Claim" });
    const noRevisionClaimRows = await client!.unsafe("insert into claims(project_id) values($1) returning id", [project.id]) as { id: string }[];
    const noRevisionSynthesisRows = await client!.unsafe("insert into synthesis_statements(project_id) values($1) returning id", [project.id]) as { id: string }[];
    const unlinkedNoRevisionClaimRows = await client!.unsafe("insert into claims(project_id) values($1) returning id", [project.id]) as { id: string }[];
    const unlinkedNoRevisionSynthesisRows = await client!.unsafe("insert into synthesis_statements(project_id) values($1) returning id", [project.id]) as { id: string }[];
    const withdrawnClaim = await review.createClaim(project.id, { claimText: "Withdrawn Claim" });
    const withdrawnSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Withdrawn Synthesis", extractionRevisionIds: [] });
    const unsupportedClaim = await review.createClaim(project.id, { claimText: "Unsupported Claim" });

    await review.withdrawClaim(project.id, withdrawnClaim.id, { expectedCurrentRevisionId: withdrawnClaim.revision.id });
    await review.withdrawSynthesisStatement(project.id, withdrawnSynthesis.statement.id);
    await review.appendSynthesisInterpretation(project.id, unsupportedSynthesis.statement.id, unsupportedSynthesis.revision.id, {
      convergenceState: "convergent",
      summary: "Interpretation availability is annotation only.",
    });

    const paper = await review.addPaper(project.id, { title: "Typed target source" });
    const evidence = await review.recordEvidence(project.id, { paperId: paper.id, sourceText: "Supported source passage", pageNumber: 1 });
    await review.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const supportedClaimRevision = await review.createClaimRevision(project.id, supportedClaim.id, {
      claimText: "Supported Claim",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: supportedClaim.revision.id,
    });
    const extracted = await review.reviseExtractionValue(project.id, paper.id, field.id, { value: "A supported value", evidenceIds: [evidence.id] });
    const supportedSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Supported Synthesis", extractionRevisionIds: [extracted.id] });
    const literalClaim = await review.createClaim(project.id, { claimText: "Literal 100%_\\ Claim" });
    const literalClaimRevision = await review.createClaimRevision(project.id, literalClaim.id, {
      claimText: "Literal 100%_\\ Claim",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: literalClaim.revision.id,
    });
    const literalSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Literal 100%_\\ Synthesis", extractionRevisionIds: [extracted.id] });

    const linkedTargets = [
      ["extraction-field", field.id],
      ["evidence-set", setResult.set.id],
      ["synthesis-statement", unsupportedSynthesis.statement.id],
      ["claim", supportedClaim.id],
    ] as const;
    const pickerTargets = [
      ["extraction-field", pickerField.id],
      ["evidence-set", pickerSet.set.id],
      ["synthesis-statement", unlinkedNoRevisionSynthesisRows[0]!.id],
      ["claim", unlinkedNoRevisionClaimRows[0]!.id],
    ] as const;
    await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id });
    await traceability.linkEvidenceSet({ projectId: project.id, questionId: question.id, evidenceSetId: setResult.set.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: unsupportedSynthesis.statement.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: supportedClaim.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: literalClaim.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: noRevisionClaimRows[0]!.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: unsupportedClaim.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: withdrawnClaim.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: noRevisionSynthesisRows[0]!.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: withdrawnSynthesis.statement.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: supportedSynthesis.statement.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: literalSynthesis.statement.id });
    await review.archiveExtractionField(project.id, field.id);
    await review.archiveEvidenceSet(project.id, setResult.set.id);

    for (let index = 0; index < linkedTargets.length; index += 1) {
      const [targetType, targetId] = linkedTargets[index]!;
      const [, pickerTargetId] = pickerTargets[index]!;
      selectLog.length = 0;
      const page = await reads.listResearchQuestionLinkPage(project.id, question.id, targetType, { pageSize: 10 });
      expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
      expect(page.items.some((item) => item.id === targetId)).toBe(true);

      selectLog.length = 0;
      const detail = await reads.getResearchQuestionTargetDetail(project.id, question.id, targetType, targetId);
      expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
      expect(detail.currentlyLinked).toBe(true);

      selectLog.length = 0;
      const picker = await reads.getResearchQuestionTargetPickerPage(project.id, question.id, targetType, { pageSize: 20 });
      expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
      expect(picker.items.some((item) => item.id === targetId)).toBe(false);
      const pickerItem = picker.items.find((item) => item.id === pickerTargetId);
      expect(pickerItem?.isCurrentlyLinked).toBe(false);
      if (targetType === "extraction-field" || targetType === "evidence-set") expect(pickerItem?.archivedAt).toEqual(expect.any(Date));

      if (targetType === "extraction-field") await traceability.unlinkExtractionField({ projectId: project.id, questionId: question.id, fieldId: targetId });
      else if (targetType === "evidence-set") await traceability.unlinkEvidenceSet({ projectId: project.id, questionId: question.id, evidenceSetId: targetId });
      else if (targetType === "synthesis-statement") await traceability.unlinkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: targetId });
      else await traceability.unlinkClaim({ projectId: project.id, questionId: question.id, claimId: targetId });
      const returnedPicker = await reads.getResearchQuestionTargetPickerPage(project.id, question.id, targetType, { pageSize: 20 });
      expect(returnedPicker.items.find((item) => item.id === targetId)?.isCurrentlyLinked).toBe(false);
      const unlinkedLedger = await reads.listResearchQuestionLinkPage(project.id, question.id, targetType, { pageSize: 10 });
      expect(unlinkedLedger.items.some((item) => item.id === targetId)).toBe(false);
    }

    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: unsupportedSynthesis.statement.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: supportedClaim.id });
    const claimCandidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { pageSize: 50 });
    const claimReasons = new Map(claimCandidates.items.map((candidate) => [candidate.targetId, candidate.reason]));
    expect(claimReasons.get(noRevisionClaimRows[0]!.id)).toBe("no_finalized_revision");
    expect(claimReasons.get(unsupportedClaim.id)).toBe("unsupported");
    expect(claimReasons.get(withdrawnClaim.id)).toBe("withdrawn");
    expect(claimCandidates.items.find((candidate) => candidate.targetId === supportedClaim.id)).toMatchObject({
      isCurrentlyLinked: true,
      isSelectable: true,
      revisionId: supportedClaimRevision.revision.id,
    });

    const synthesisCandidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "synthesis", { pageSize: 50 });
    const synthesisRows = new Map(synthesisCandidates.items.map((candidate) => [candidate.targetId, candidate]));
    expect(synthesisRows.get(noRevisionSynthesisRows[0]!.id)?.reason).toBe("no_finalized_revision");
    expect(synthesisRows.get(withdrawnSynthesis.statement.id)?.reason).toBe("withdrawn");
    expect(synthesisRows.get(unsupportedSynthesis.statement.id)).toMatchObject({
      reason: "unsupported",
      interpretationAvailable: true,
    });
    expect(synthesisRows.get(supportedSynthesis.statement.id)).toMatchObject({ reason: null, isSelectable: true });
    expect(synthesisRows.get(literalSynthesis.statement.id)).toMatchObject({ reason: null, isSelectable: true });
    expect(claimReasons.get(literalClaim.id)).toBe(null);
    expect(claimCandidates.items.find((candidate) => candidate.targetId === literalClaim.id)?.revisionId).toBe(literalClaimRevision.revision.id);

    const literalClaimCandidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { search: "%_", pageSize: 10 });
    expect(literalClaimCandidates.items.map((item) => item.targetId)).toEqual([literalClaim.id]);
    const literalSynthesisCandidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "synthesis", { search: "%_", pageSize: 10 });
    expect(literalSynthesisCandidates.items.map((item) => item.targetId)).toEqual([literalSynthesis.statement.id]);
    const escapedLiteralClaimCandidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { search: "%_\\", pageSize: 10 });
    expect(escapedLiteralClaimCandidates.items.map((item) => item.targetId)).toEqual([literalClaim.id]);
    const escapedLiteralSynthesisCandidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "synthesis", { search: "%_\\", pageSize: 10 });
    expect(escapedLiteralSynthesisCandidates.items.map((item) => item.targetId)).toEqual([literalSynthesis.statement.id]);

    selectLog.length = 0;
    const claimCandidatePage1 = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { pageSize: 1 });
    const claimCandidatePage2 = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { pageSize: 1, cursor: claimCandidatePage1.nextCursor });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(4);
    expect(claimCandidatePage1.hasMore).toBe(true);
    expect(claimCandidatePage2.items).toHaveLength(1);
    expect(new Set([...claimCandidatePage1.items, ...claimCandidatePage2.items].map((item) => item.targetId)).size).toBe(2);

    selectLog.length = 0;
    const synthesisCandidatePage1 = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "synthesis", { pageSize: 1 });
    expect(selectCount(selectLog)).toBe(2);
    selectLog.length = 0;
    const synthesisCandidatePage2 = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "synthesis", { pageSize: 1, cursor: synthesisCandidatePage1.nextCursor });
    expect(selectCount(selectLog)).toBe(2);
    expect(synthesisCandidatePage1.hasMore).toBe(true);
    expect(synthesisCandidatePage2.items).toHaveLength(1);
    expect(new Set([...synthesisCandidatePage1.items, ...synthesisCandidatePage2.items].map((item) => item.targetId)).size).toBe(2);

    const unrelatedClaim = await review.createClaim(project.id, { claimText: "Not related to this Question" });
    await expect(reads.getResearchQuestionTargetDetail(project.id, question.id, "claim", unrelatedClaim.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const otherProject = await review.createProject({ title: `Other typed reads ${randomUUID()}`, researchQuestion: "Separate ownership" });
    const otherQuestion = (await review.listResearchQuestions(otherProject.id))[0]!;
    await expect(reads.getResearchQuestionTargetDetail(otherProject.id, otherQuestion.id, "claim", supportedClaim.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("handles an empty Project and traverses tied Question ordering with explicit status filters", async () => {
    const emptyProject = await review.createProject({ title: `Empty matrix ${randomUUID()}`, researchQuestion: "Temporary Question removed for empty matrix coverage" });
    await client!.unsafe("delete from research_questions where project_id=$1", [emptyProject.id]);
    selectLog.length = 0;
    const empty = await reads.getResearchQuestionMatrixPage(emptyProject.id, { pageSize: 1 });
    expect(selectCount(selectLog)).toBe(1);
    expect(empty.rows).toEqual([]);
    expect(empty).toMatchObject({ hasMore: false, nextCursor: null, questionCounts: { active: 0, archived: 0 } });

    const project = await review.createProject({ title: `Tied matrix ${randomUUID()}`, researchQuestion: "Stable tied Question order" });
    const initial = (await review.listResearchQuestions(project.id))[0]!;
    const second = await review.createResearchQuestion(project.id, { identifier: "RQ-tie-2", label: "Tied Question 2" });
    const third = await review.createResearchQuestion(project.id, { identifier: "RQ-tie-3", label: "Tied Question 3" });
    await client!.unsafe("update research_questions set sort_order=7 where project_id=$1", [project.id]);
    await client!.unsafe("update research_questions set archived_at=now() where project_id=$1 and id=$2", [project.id, third.id]);
    const expected = await client!.unsafe("select id::text as id from research_questions where project_id=$1 order by sort_order,id", [project.id]) as { id: string }[];

    const traverse = async (status: "active" | "archived") => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 1, status, cursor });
        ids.push(...page.rows.map((row) => row.question.id));
        cursor = page.nextCursor;
        expect(page.rows.every((row) => (status === "active") === (row.question.archivedAt === null))).toBe(true);
      } while (cursor);
      return ids;
    };
    expect(await traverse("active")).toEqual(expected.map((row) => row.id).filter((id) => id !== third.id));
    expect(await traverse("archived")).toEqual([third.id]);
    expect(new Set([initial.id, second.id, third.id]).size).toBe(3);
  });

  it("keeps every bounded read API isolated to its requested Project and Question", async () => {
    const sourceProject = await review.createProject({ title: `Source isolation ${randomUUID()}`, researchQuestion: "Source-only traceability and Answer" });
    const sourceQuestion = (await review.listResearchQuestions(sourceProject.id))[0]!;
    const otherQuestion = await review.createResearchQuestion(sourceProject.id, { identifier: "RQ-unlinked-isolation", label: "No links or Answers in this Question" });
    const foreignField = await review.createExtractionField(sourceProject.id, { name: "Project A private Field", fieldType: "short_text" });
    await traceability.linkExtractionField({ projectId: sourceProject.id, questionId: sourceQuestion.id, fieldId: foreignField.id });
    const foreignClaim = await review.createClaim(sourceProject.id, { claimText: "Project A private Claim" });
    const sourcePaper = await review.addPaper(sourceProject.id, { title: "Project A Answer support Paper" });
    const sourceEvidence = await review.recordEvidence(sourceProject.id, { paperId: sourcePaper.id, sourceText: "Project A Answer support", pageNumber: 1 });
    const foreignClaimRevision = await review.createClaimRevision(sourceProject.id, foreignClaim.id, { claimText: "Project A private Claim", supports: [{ kind: "evidence", evidenceId: sourceEvidence.id }], expectedCurrentRevisionId: foreignClaim.revision.id });
    await traceability.linkClaim({ projectId: sourceProject.id, questionId: sourceQuestion.id, claimId: foreignClaim.id });
    const answer = await review.appendResearchQuestionAnswer(sourceProject.id, sourceQuestion.id, { answerText: "Project A private Answer", claimRevisionIds: [foreignClaimRevision.revision.id], synthesisRevisionIds: [] });

    const sameProjectMatrix = await reads.getResearchQuestionMatrixPage(sourceProject.id, { pageSize: 10 });
    expect(new Set(sameProjectMatrix.rows.map((row) => row.question.id))).toEqual(new Set([sourceQuestion.id, otherQuestion.id]));
    const otherQuestionRow = sameProjectMatrix.rows.find((row) => row.question.id === otherQuestion.id)!;
    expect(otherQuestionRow.diagnostics.claims.no_linked_claims).toBe(1);
    const sameProjectWorkspace = await reads.getResearchQuestionWorkspace(sourceProject.id, otherQuestion.id);
    expect(sameProjectWorkspace.currentLinkCounts.extractionFields).toBe(0);
    expect(sameProjectWorkspace.currentLinkCounts.claims).toBe(0);
    expect(sameProjectWorkspace.answerSummary.finalizedAnswerCount).toBe(0);
    expect((await reads.listResearchQuestionLinkPage(sourceProject.id, otherQuestion.id, "extraction-field")).items).toEqual([]);
    expect((await reads.listResearchQuestionAnswerHistoryPage(sourceProject.id, otherQuestion.id)).items).toEqual([]);
    await expect(reads.getResearchQuestionTargetDetail(sourceProject.id, otherQuestion.id, "extraction-field", foreignField.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const sameProjectPicker = await reads.getResearchQuestionTargetPickerPage(sourceProject.id, otherQuestion.id, "extraction-field", { search: "Project A private Field" });
    expect(sameProjectPicker.items).toMatchObject([{ id: foreignField.id, isCurrentlyLinked: false }]);
    await expect(reads.getResearchQuestionExtractionCoveragePage(sourceProject.id, otherQuestion.id, foreignField.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const sameProjectCandidates = await reads.listResearchQuestionAnswerCandidatePage(sourceProject.id, otherQuestion.id, "claim");
    expect(sameProjectCandidates.items).toEqual([]);
    await expect(reads.getResearchQuestionAnswerBrowserSnapshot(sourceProject.id, otherQuestion.id, answer.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const isolatedProject = await review.createProject({ title: `Isolated reads ${randomUUID()}`, researchQuestion: "Only Project B data is visible" });
    const isolatedQuestion = (await review.listResearchQuestions(isolatedProject.id))[0]!;
    const matrix = await reads.getResearchQuestionMatrixPage(isolatedProject.id, { pageSize: 10 });
    expect(matrix.rows.map((row) => row.question.id)).toEqual([isolatedQuestion.id]);
    expect(matrix.rows.some((row) => row.question.id === sourceQuestion.id)).toBe(false);
    expect((await reads.listResearchQuestionLinkPage(isolatedProject.id, isolatedQuestion.id, "extraction-field")).items).toEqual([]);
    const workspace = await reads.getResearchQuestionWorkspace(isolatedProject.id, isolatedQuestion.id);
    expect(workspace.currentLinkCounts.extractionFields).toBe(0);
    expect(workspace.answerSummary.finalizedAnswerCount).toBe(0);
    expect((await reads.listResearchQuestionAnswerHistoryPage(isolatedProject.id, isolatedQuestion.id)).items).toEqual([]);
    await expect(reads.getResearchQuestionTargetDetail(isolatedProject.id, isolatedQuestion.id, "extraction-field", foreignField.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await reads.getResearchQuestionTargetPickerPage(isolatedProject.id, isolatedQuestion.id, "extraction-field")).items).toEqual([]);
    await expect(reads.getResearchQuestionExtractionCoveragePage(isolatedProject.id, isolatedQuestion.id, foreignField.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await reads.listResearchQuestionAnswerCandidatePage(isolatedProject.id, isolatedQuestion.id, "claim")).items).toEqual([]);
    await expect(reads.getResearchQuestionAnswerBrowserSnapshot(isolatedProject.id, isolatedQuestion.id, answer.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects malformed family cursors and forged history boundaries before issuing read SQL", async () => {
    const project = await review.createProject({ title: `Cursor validation ${randomUUID()}`, researchQuestion: "Do cursor families reject forged input before reading?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const foreignProject = await review.createProject({ title: `Cursor foreign ${randomUUID()}`, researchQuestion: "Cursor scope mismatch" });
    const foreignQuestion = (await review.listResearchQuestions(foreignProject.id))[0]!;
    const assertValidationWithoutRead = async (read: () => Promise<unknown>) => {
      selectLog.length = 0;
      await expect(read()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(selectCount(selectLog)).toBe(0);
    };

    await review.createResearchQuestion(project.id, { identifier: "RQ-cursor-2", label: "Second cursor Question" });
    const matrix = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 1 });
    const badMatrix = decodeCursor(matrix.nextCursor!);
    badMatrix.sortOrder = "not-an-integer";
    await assertValidationWithoutRead(() => reads.getResearchQuestionMatrixPage(project.id, { pageSize: 1, cursor: encodeCursor(badMatrix) }));

    const linkedFields = [
      await review.createExtractionField(project.id, { name: "Linked cursor Field A", fieldType: "short_text" }),
      await review.createExtractionField(project.id, { name: "Linked cursor Field B", fieldType: "short_text" }),
    ];
    for (const field of linkedFields) await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id });
    const link = await reads.listResearchQuestionLinkPage(project.id, question.id, "extraction-field", { pageSize: 1 });
    const badLink = decodeCursor(link.nextCursor!);
    badLink.id = "not-a-uuid";
    await assertValidationWithoutRead(() => reads.listResearchQuestionLinkPage(project.id, question.id, "extraction-field", { pageSize: 1, cursor: encodeCursor(badLink) }));

    const pickerFields = [
      await review.createExtractionField(project.id, { name: "Picker cursor Field A", fieldType: "short_text" }),
      await review.createExtractionField(project.id, { name: "Picker cursor Field B", fieldType: "short_text" }),
    ];
    const picker = await reads.getResearchQuestionTargetPickerPage(project.id, question.id, "extraction-field", { pageSize: 1 });
    expect(pickerFields).toHaveLength(2);
    const badPicker = decodeCursor(picker.nextCursor!);
    badPicker.search = "%_";
    await assertValidationWithoutRead(() => reads.getResearchQuestionTargetPickerPage(project.id, question.id, "extraction-field", { pageSize: 1, cursor: encodeCursor(badPicker) }));

    const paper = await review.addPaper(project.id, { title: "Cursor candidate evidence source" });
    const evidence = await review.recordEvidence(project.id, { paperId: paper.id, sourceText: "Supports cursor candidates", pageNumber: 1 });
    const candidateClaims = [];
    for (const label of ["Cursor candidate A", "Cursor candidate B"]) {
      const claim = await review.createClaim(project.id, { claimText: label });
      const revision = await review.createClaimRevision(project.id, claim.id, { claimText: label, supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: claim.revision.id });
      await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: claim.id });
      candidateClaims.push({ claim, revision });
    }
    const candidates = await reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { pageSize: 1 });
    const badCandidate = decodeCursor(candidates.nextCursor!);
    badCandidate.highWaterSequence = "01";
    await assertValidationWithoutRead(() => reads.listResearchQuestionAnswerCandidatePage(project.id, question.id, "claim", { pageSize: 1, cursor: encodeCursor(badCandidate) }));

    const coverageField = await review.createExtractionField(project.id, { name: "Coverage cursor Field", fieldType: "short_text" });
    await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: coverageField.id });
    for (let index = 0; index < 2; index += 1) {
      const coveragePaper = await review.addPaper(project.id, { title: `Coverage cursor Paper ${index}` });
      await review.recordScreeningDecision(project.id, coveragePaper.id, { decision: "include" });
      await review.recordFullTextRetrievalAttempt(project.id, coveragePaper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await review.recordFullTextScreeningDecision(project.id, coveragePaper.id, { decision: "include" });
    }
    const coverage = await reads.getResearchQuestionExtractionCoveragePage(project.id, question.id, coverageField.id, { pageSize: 1 });
    const badCoverage = decodeCursor(coverage.nextCursor!);
    badCoverage.fieldId = randomUUID();
    await assertValidationWithoutRead(() => reads.getResearchQuestionExtractionCoveragePage(project.id, question.id, coverageField.id, { pageSize: 1, cursor: encodeCursor(badCoverage) }));

    for (const answerText of ["Cursor history A", "Cursor history B"]) await review.appendResearchQuestionAnswer(project.id, question.id, { answerText, claimRevisionIds: [candidateClaims[0]!.revision.revision.id], synthesisRevisionIds: [] });
    const answerHistory = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1 });
    const badAnswerHistory = decodeCursor(answerHistory.nextCursor!);
    badAnswerHistory.sequence = (BigInt(String(badAnswerHistory.highWaterSequence)) + BigInt(1)).toString();
    await assertValidationWithoutRead(() => reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1, cursor: encodeCursor(badAnswerHistory) }));
    await assertValidationWithoutRead(() => reads.listResearchQuestionAnswerHistoryPage(foreignProject.id, foreignQuestion.id, { pageSize: 1, cursor: answerHistory.nextCursor }));

    const historyField = await review.createExtractionField(project.id, { name: "Target history cursor Field", fieldType: "short_text" });
    await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: historyField.id });
    await traceability.unlinkExtractionField({ projectId: project.id, questionId: question.id, fieldId: historyField.id });
    await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: historyField.id });
    const targetDetail = await reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", historyField.id, { pageSize: 1 });
    const badTargetHistory = decodeCursor(targetDetail.history.nextCursor!);
    badTargetHistory.sequence = (BigInt(String(badTargetHistory.highWaterSequence)) + BigInt(1)).toString();
    await assertValidationWithoutRead(() => reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", historyField.id, { pageSize: 1, cursor: encodeCursor(badTargetHistory) }));
  });

  it("matches the released per-target projection for all 13 matrix diagnostic codes", async () => {
    const project = await review.createProject({ title: `Diagnostic parity ${randomUUID()}`, researchQuestion: "Baseline no-link diagnostic question" });
    const baseline = (await review.listResearchQuestions(project.id))[0]!;
    const question = await review.createResearchQuestion(project.id, { identifier: "RQ-diagnostic-parity", label: "All linked diagnostic states" });
    const includedPaper = await review.addPaper(project.id, { title: "Finally included diagnostic paper" });
    await review.recordScreeningDecision(project.id, includedPaper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, includedPaper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, includedPaper.id, { decision: "include" });

    const fields = {
      noData: await review.createExtractionField(project.id, { name: "No current data", fieldType: "short_text" }),
      cleared: await review.createExtractionField(project.id, { name: "Cleared data", fieldType: "short_text" }),
      excluded: await review.createExtractionField(project.id, { name: "Excluded paper data", fieldType: "short_text" }),
      present: await review.createExtractionField(project.id, { name: "Present included data", fieldType: "short_text" }),
      titleAbstractExcluded: await review.createExtractionField(project.id, { name: "Title Abstract excluded data", fieldType: "short_text" }),
      noFinalTextDecision: await review.createExtractionField(project.id, { name: "No final Text decision data", fieldType: "short_text" }),
      notReported: await review.createExtractionField(project.id, { name: "Not reported state", fieldType: "short_text" }),
      notApplicable: await review.createExtractionField(project.id, { name: "Not applicable state", fieldType: "short_text" }),
    };
    const presentExtractionRevision = await review.reviseExtractionValue(project.id, includedPaper.id, fields.present.id, { value: "Current included observation", evidenceIds: [] });
    await review.reviseExtractionValue(project.id, includedPaper.id, fields.cleared.id, { value: "present then cleared", evidenceIds: [] });
    await review.clearExtractionValue(project.id, includedPaper.id, fields.cleared.id);
    await review.reviseExtractionValue(project.id, includedPaper.id, fields.notReported.id, { state: "not_reported", evidenceIds: [] });
    await review.reviseExtractionValue(project.id, includedPaper.id, fields.notApplicable.id, { state: "not_applicable", evidenceIds: [] });

    const excludedPaper = await review.addPaper(project.id, { title: "Later excluded paper" });
    await review.recordScreeningDecision(project.id, excludedPaper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, excludedPaper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, excludedPaper.id, { decision: "include" });
    await review.reviseExtractionValue(project.id, excludedPaper.id, fields.excluded.id, { value: "old included value", evidenceIds: [] });
    const exclusionCriterion = await review.createFullTextScreeningCriterion(project.id, { text: "Excluded after extraction" });
    await review.recordFullTextScreeningDecision(project.id, excludedPaper.id, { decision: "exclude", exclusionCriterionId: exclusionCriterion.id });
    const titleAbstractExcludedPaper = await review.addPaper(project.id, { title: "Title Abstract excluded paper" });
    const titleAbstractCriterion = await review.createScreeningCriterion(project.id, { type: "exclusion", text: "Outside scope at Title Abstract" });
    await review.recordScreeningDecision(project.id, titleAbstractExcludedPaper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, titleAbstractExcludedPaper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, titleAbstractExcludedPaper.id, { decision: "include" });
    await review.reviseExtractionValue(project.id, titleAbstractExcludedPaper.id, fields.titleAbstractExcluded.id, { value: "Must not count after Title Abstract exclusion", evidenceIds: [] });
    await review.recordScreeningDecision(project.id, titleAbstractExcludedPaper.id, { decision: "exclude", exclusionCriterionId: titleAbstractCriterion.id });
    const noFinalTextDecisionPaper = await review.addPaper(project.id, { title: "No final Text decision paper" });
    await review.recordScreeningDecision(project.id, noFinalTextDecisionPaper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, noFinalTextDecisionPaper.id, { outcome: "retrieved", attemptedAt: new Date() });
    for (const field of Object.values(fields)) await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id });

    const emptySet = await review.createEvidenceSet(project.id, { name: "Linked empty set" });
    const reviewedSet = await review.createEvidenceSet(project.id, { name: "Mixed review states" });
    for (const [index, decision] of (["accepted", "needs_review", "rejected", null] as const).entries()) {
      const evidence = await review.recordEvidence(project.id, { paperId: includedPaper.id, sourceText: `Review ${decision ?? "unreviewed"}`, pageNumber: index + 1 });
      if (decision) await review.appendEvidenceReviewDecision(project.id, evidence.id, { decision });
      const current = await review.getEvidenceSet(project.id, reviewedSet.set.id);
      await review.addEvidenceToSet(project.id, reviewedSet.set.id, { evidenceId: evidence.id, expectedRevisionId: current.currentRevision.id });
    }
    await traceability.linkEvidenceSet({ projectId: project.id, questionId: question.id, evidenceSetId: emptySet.set.id });
    await traceability.linkEvidenceSet({ projectId: project.id, questionId: question.id, evidenceSetId: reviewedSet.set.id });

    const inactiveSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Inactive linked synthesis", extractionRevisionIds: [] });
    await review.withdrawSynthesisStatement(project.id, inactiveSynthesis.statement.id);
    const unsupportedSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Active unsupported synthesis", extractionRevisionIds: [] });
    const unsupportedInterpretedSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Unsupported but interpreted synthesis", extractionRevisionIds: [] });
    await review.appendSynthesisInterpretation(project.id, unsupportedInterpretedSynthesis.statement.id, unsupportedInterpretedSynthesis.revision.id, { convergenceState: "convergent", summary: "Interpretation is independent of support." });
    const supportedUninterpretedSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Supported without interpretation", extractionRevisionIds: [presentExtractionRevision.id] });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: inactiveSynthesis.statement.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: unsupportedSynthesis.statement.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: unsupportedInterpretedSynthesis.statement.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: supportedUninterpretedSynthesis.statement.id });

    const inactiveClaim = await review.createClaim(project.id, { claimText: "Inactive linked Claim" });
    await review.withdrawClaim(project.id, inactiveClaim.id, { expectedCurrentRevisionId: inactiveClaim.revision.id });
    const unsupportedClaim = await review.createClaim(project.id, { claimText: "Active unsupported Claim" });
    const diagnosticEvidence = await review.recordEvidence(project.id, { paperId: includedPaper.id, sourceText: "Independent claim support state", pageNumber: 60 });
    const supportedUnplacedClaim = await review.createClaim(project.id, { claimText: "Supported but unplaced Claim" });
    await review.createClaimRevision(project.id, supportedUnplacedClaim.id, { claimText: "Supported but unplaced Claim", supports: [{ kind: "evidence", evidenceId: diagnosticEvidence.id }], expectedCurrentRevisionId: supportedUnplacedClaim.revision.id });
    const unsupportedPlacedClaim = await review.createClaim(project.id, { claimText: "Unsupported but placed Claim" });
    const noRevisionClaim = await client!.unsafe("insert into claims(project_id) values($1) returning id", [project.id]) as { id: string }[];
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: inactiveClaim.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: unsupportedClaim.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: supportedUnplacedClaim.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: unsupportedPlacedClaim.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: noRevisionClaim[0]!.id });
    const diagnosticManuscript = await review.getOrCreateDefaultManuscript(project.id);
    const diagnosticSection = await review.createSection(project.id, diagnosticManuscript.id, { title: "Independent placement states", sectionType: "results" });
    await review.placeClaimRevision(project.id, diagnosticManuscript.id, diagnosticSection!.id, unsupportedPlacedClaim.revision.id);

    const emptyProjection = await review.getQuestionTraceability(project.id, baseline.id);
    const legacy = await review.getQuestionTraceability(project.id, question.id);
    const matrix = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 20 });
    const baselineRow = matrix.rows.find((row) => row.question.id === baseline.id)!;
    const questionRow = matrix.rows.find((row) => row.question.id === question.id)!;
    const dimensions = ["extraction", "evidenceSets", "synthesis", "claims"] as const;
    const legacyCodes = (projection: typeof legacy) => dimensions.flatMap((dimension) => projection.flags[dimension].map((flag) => flag.code)).sort();
    const matrixCodes = (diagnostics: typeof questionRow.diagnostics) => dimensions.flatMap((dimension) =>
      Object.entries(diagnostics[dimension]).flatMap(([code, count]) => Array.from({ length: count ?? 0 }, () => code))).sort();
    expect(matrixCodes(baselineRow.diagnostics)).toEqual(legacyCodes(emptyProjection));
    expect(matrixCodes(questionRow.diagnostics)).toEqual(legacyCodes(legacy));
    expect(new Set([...matrixCodes(baselineRow.diagnostics), ...matrixCodes(questionRow.diagnostics)])).toEqual(new Set([
      "no_linked_extraction_fields", "linked_field_without_current_data", "no_linked_evidence_sets", "linked_set_empty",
      "linked_set_contains_rejected_evidence", "no_linked_synthesis_statements", "linked_statement_without_current_active_revision",
      "linked_current_synthesis_without_support", "linked_current_synthesis_without_interpretation", "no_linked_claims",
      "linked_claim_without_current_active_revision", "linked_current_claim_unsupported", "linked_current_claim_not_placed",
    ]));
    expect(questionRow.diagnostics.extraction.linked_field_without_current_data).toBe(5);
    expect(questionRow.diagnostics.evidenceSets.linked_set_empty).toBe(1);
    expect(questionRow.diagnostics.evidenceSets.linked_set_contains_rejected_evidence).toBe(1);
    expect(questionRow.diagnostics.synthesis.linked_statement_without_current_active_revision).toBe(1);
    expect(questionRow.diagnostics.synthesis.linked_current_synthesis_without_support).toBe(2);
    expect(questionRow.diagnostics.synthesis.linked_current_synthesis_without_interpretation).toBe(2);
    expect(questionRow.diagnostics.claims.linked_claim_without_current_active_revision).toBe(2);
    expect(questionRow.diagnostics.claims.linked_current_claim_unsupported).toBe(2);
    expect(questionRow.diagnostics.claims.linked_current_claim_not_placed).toBe(2);

    const extractionLinks = await reads.listResearchQuestionLinkPage(project.id, question.id, "extraction-field", { pageSize: 20 });
    expect(extractionLinks.items.find((item) => item.id === fields.notReported.id)?.diagnosticFlags).toEqual([]);
    expect(extractionLinks.items.find((item) => item.id === fields.notApplicable.id)?.diagnosticFlags).toEqual([]);
    expect(extractionLinks.items.find((item) => item.id === fields.excluded.id)?.diagnosticFlags).toEqual(["linked_field_without_current_data"]);
    expect(extractionLinks.items.find((item) => item.id === fields.cleared.id)?.diagnosticFlags).toEqual(["linked_field_without_current_data"]);
    expect(extractionLinks.items.find((item) => item.id === fields.present.id)?.diagnosticFlags).toEqual([]);
    expect(extractionLinks.items.find((item) => item.id === fields.titleAbstractExcluded.id)?.diagnosticFlags).toEqual(["linked_field_without_current_data"]);
    expect(extractionLinks.items.find((item) => item.id === fields.noFinalTextDecision.id)?.diagnosticFlags).toEqual(["linked_field_without_current_data"]);
    const includedCoverage = await reads.getResearchQuestionExtractionCoveragePage(project.id, question.id, fields.present.id, { pageSize: 10 });
    expect(includedCoverage.items).toMatchObject([{ paperId: includedPaper.id, status: "present", displayValue: "Current included observation" }]);

    const fullyCoveredQuestion = await review.createResearchQuestion(project.id, { identifier: "RQ-fully-covered", label: "Covered dimensions with one drifted Answer context" });
    await traceability.linkExtractionField({ projectId: project.id, questionId: fullyCoveredQuestion.id, fieldId: fields.present.id });
    const positiveSet = await review.createEvidenceSet(project.id, { name: "Fully covered accepted Evidence Set" });
    const acceptedEvidence = await review.recordEvidence(project.id, { paperId: includedPaper.id, sourceText: "Accepted support for complete coverage", pageNumber: 50 });
    await review.appendEvidenceReviewDecision(project.id, acceptedEvidence.id, { decision: "accepted" });
    const setState = await review.getEvidenceSet(project.id, positiveSet.set.id);
    await review.addEvidenceToSet(project.id, positiveSet.set.id, { evidenceId: acceptedEvidence.id, expectedRevisionId: setState.currentRevision.id });
    await traceability.linkEvidenceSet({ projectId: project.id, questionId: fullyCoveredQuestion.id, evidenceSetId: positiveSet.set.id });
    const positiveSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Supported and interpreted coverage", extractionRevisionIds: [presentExtractionRevision.id] });
    await review.appendSynthesisInterpretation(project.id, positiveSynthesis.statement.id, positiveSynthesis.revision.id, { convergenceState: "convergent", summary: "Interpretation closes the synthesis dimension." });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: fullyCoveredQuestion.id, statementId: positiveSynthesis.statement.id });
    const positiveClaim = await review.createClaim(project.id, { claimText: "Supported and placed coverage Claim" });
    const positiveClaimRevision = await review.createClaimRevision(project.id, positiveClaim.id, { claimText: "First supported revision", supports: [{ kind: "evidence", evidenceId: acceptedEvidence.id }], expectedCurrentRevisionId: positiveClaim.revision.id });
    await traceability.linkClaim({ projectId: project.id, questionId: fullyCoveredQuestion.id, claimId: positiveClaim.id });
    const driftedAnswer = await review.appendResearchQuestionAnswer(project.id, fullyCoveredQuestion.id, { answerText: "The old Claim revision remains pinned.", claimRevisionIds: [positiveClaimRevision.revision.id], synthesisRevisionIds: [positiveSynthesis.revision.id] });
    const currentClaimRevision = await review.createClaimRevision(project.id, positiveClaim.id, { claimText: "Current supported revision", supports: [{ kind: "evidence", evidenceId: acceptedEvidence.id }], expectedCurrentRevisionId: positiveClaimRevision.revision.id });
    const manuscript = await review.getOrCreateDefaultManuscript(project.id);
    const resultsSection = await review.createSection(project.id, manuscript.id, { title: "Coverage Results", sectionType: "results" });
    await review.placeClaimRevision(project.id, manuscript.id, resultsSection!.id, currentClaimRevision.revision.id);
    const coveredMatrix = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 20 });
    const coveredRow = coveredMatrix.rows.find((row) => row.question.id === fullyCoveredQuestion.id)!;
    expect(coveredRow.diagnostics.fullyCovered).toBe(true);
    expect(coveredRow.counts.driftedAnswerContexts).toBe(1);
    expect(driftedAnswer.id).toEqual(expect.any(String));
    const synthesisLinks = await reads.listResearchQuestionLinkPage(project.id, question.id, "synthesis-statement", { pageSize: 20 });
    expect(synthesisLinks.items.find((item) => item.id === unsupportedInterpretedSynthesis.statement.id)?.diagnosticFlags).toEqual(["linked_current_synthesis_without_support"]);
    expect(synthesisLinks.items.find((item) => item.id === supportedUninterpretedSynthesis.statement.id)?.diagnosticFlags).toEqual(["linked_current_synthesis_without_interpretation"]);
    const claimLinks = await reads.listResearchQuestionLinkPage(project.id, question.id, "claim", { pageSize: 20 });
    expect(claimLinks.items.find((item) => item.id === supportedUnplacedClaim.id)?.diagnosticFlags).toEqual(["linked_current_claim_not_placed"]);
    expect(claimLinks.items.find((item) => item.id === unsupportedPlacedClaim.id)?.diagnosticFlags).toEqual(["linked_current_claim_unsupported"]);
  });

  it("supports empty history, zero-Claim Synthesis-only Answers, bounded defaults, and a late lower-sequence commit", async () => {
    const project = await review.createProject({ title: `Answer limits ${randomUUID()}`, researchQuestion: "Are Answer history bounds and late commits deterministic?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const emptyHistory = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id);
    expect(emptyHistory).toMatchObject({ items: [], totalCount: 0, highWaterSequence: "0", latestAnswerSequence: null, hasMore: false, nextCursor: null });

    const paper = await review.addPaper(project.id, { title: "Answer limit support Paper" });
    await review.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const field = await review.createExtractionField(project.id, { name: "Answer limit Field", fieldType: "short_text" });
    const extraction = await review.reviseExtractionValue(project.id, paper.id, field.id, { value: "Synthesis context support", evidenceIds: [] });
    const synthesis = await review.createSynthesisStatement(project.id, { statementText: "Synthesis-only Answer target", extractionRevisionIds: [extraction.id] });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: synthesis.statement.id });
    const synthesisOnly = await review.appendResearchQuestionAnswer(project.id, question.id, { answerText: "No Claim context; one exact Synthesis context.", claimRevisionIds: [], synthesisRevisionIds: [synthesis.revision.id] });
    const firstHistory = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id);
    expect(firstHistory.items[0]).toMatchObject({ id: synthesisOnly.id, claimContextCount: 0, synthesisContextCount: 1 });

    for (let index = 1; index < 27; index += 1) {
      await review.appendResearchQuestionAnswer(project.id, question.id, { answerText: `Bounded Answer ${index}`, claimRevisionIds: [], synthesisRevisionIds: [synthesis.revision.id] });
    }
    const defaultPage = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id);
    expect(defaultPage.pageSize).toBe(10);
    expect(defaultPage.items).toHaveLength(10);
    expect(defaultPage.hasMore).toBe(true);
    const cappedPage = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 100 });
    expect(cappedPage.pageSize).toBe(25);
    expect(cappedPage.items).toHaveLength(25);
    expect(cappedPage.totalCount).toBe(27);
    expect(cappedPage.hasMore).toBe(true);

    const delayedSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Late commit Synthesis target", extractionRevisionIds: [extraction.id] });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: delayedSynthesis.statement.id });
    const reservedSequence = deferred<string>();
    const releaseInsert = deferred<void>();
    const lateAnswerId = randomUUID();
    const delayedInsert = client!.begin(async (tx) => {
      const reserved = await tx.unsafe("select nextval(pg_get_serial_sequence('public.research_question_answers','sequence'))::text as sequence") as { sequence: string }[];
      reservedSequence.resolve(reserved[0]!.sequence);
      await releaseInsert.promise;
      await tx.unsafe("insert into research_question_answers (id,sequence,project_id,research_question_id,answer_text,finalized_at) overriding system value values ($1,$2::bigint,$3,$4,'Late lower-sequence Answer',null)", [lateAnswerId, reserved[0]!.sequence, project.id, question.id]);
      await tx.unsafe("insert into research_question_answer_synthesis_contexts (project_id,research_question_id,answer_id,synthesis_statement_id,synthesis_revision_id,sort_order) values ($1,$2,$3,$4,$5,0)", [project.id, question.id, lateAnswerId, delayedSynthesis.statement.id, delayedSynthesis.revision.id]);
      await tx.unsafe("update research_question_answers set finalized_at=now() where project_id=$1 and research_question_id=$2 and id=$3", [project.id, question.id, lateAnswerId]);
    });
    const lowerSequence = await reservedSequence.promise;
    const laterAnswer = await review.appendResearchQuestionAnswer(project.id, question.id, { answerText: "Higher sequence committed first.", claimRevisionIds: [], synthesisRevisionIds: [synthesis.revision.id] });
    const [laterSequence] = await client!.unsafe("select sequence::text as sequence from research_question_answers where project_id=$1 and research_question_id=$2 and id=$3", [project.id, question.id, laterAnswer.id]) as { sequence: string }[];
    expect(BigInt(lowerSequence)).toBeLessThan(BigInt(laterSequence!.sequence));
    const firstLatePage = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1 });
    expect(firstLatePage.items[0]?.id).toBe(laterAnswer.id);
    expect(firstLatePage.highWaterSequence).toBe(laterSequence!.sequence);
    releaseInsert.resolve();
    await delayedInsert;
    const secondLatePage = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1, cursor: firstLatePage.nextCursor });
    expect(secondLatePage.items[0]).toMatchObject({ id: lateAnswerId, sequence: lowerSequence });
  }, 90_000);

  it("round-trips BIGINT epochs and event/Answer sequences above JavaScript safe integer precision", async () => {
    const project = await review.createProject({ title: `BIGINT roundtrip ${randomUUID()}`, researchQuestion: "Are large epoch and history values preserved as decimal strings?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const field = await review.createExtractionField(project.id, { name: "BIGINT history Field", fieldType: "short_text" });
    const paper = await review.addPaper(project.id, { title: "BIGINT support Paper" });
    await review.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const extraction = await review.reviseExtractionValue(project.id, paper.id, field.id, { value: "Supported revision", evidenceIds: [] });
    const synthesis = await review.createSynthesisStatement(project.id, { statementText: "BIGINT history synthesis", extractionRevisionIds: [extraction.id] });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: synthesis.statement.id });

    const epoch = "9007199254740993";
    const firstEvent = "9007199254740993";
    const secondEvent = "9007199254740994";
    await client!.begin(async (tx) => {
      await tx.unsafe("insert into research_question_extraction_field_events (id,sequence,project_id,research_question_id,extraction_field_id,action,note) overriding system value values ($1,$2::bigint,$3,$4,$5,'linked','Exact large linked event')", [randomUUID(), firstEvent, project.id, question.id, field.id]);
      await tx.unsafe("insert into research_question_extraction_field_events (id,sequence,project_id,research_question_id,extraction_field_id,action,note) overriding system value values ($1,$2::bigint,$3,$4,$5,'unlinked','Exact large unlinked event')", [randomUUID(), secondEvent, project.id, question.id, field.id]);
      await tx.unsafe("update research_questions set traceability_epoch=$1::bigint where project_id=$2 and id=$3", [epoch, project.id, question.id]);
    });

    const answerIds = [randomUUID(), randomUUID()];
    const answerSequences = ["9007199254740995", "9007199254740996"];
    await client!.begin(async (tx) => {
      for (let index = 0; index < answerIds.length; index += 1) {
        await tx.unsafe("insert into research_question_answers (id,sequence,project_id,research_question_id,answer_text,finalized_at) overriding system value values ($1,$2::bigint,$3,$4,$5,null)", [answerIds[index]!, answerSequences[index]!, project.id, question.id, `Large sequence snapshot ${index}`]);
        await tx.unsafe("insert into research_question_answer_synthesis_contexts (project_id,research_question_id,answer_id,synthesis_statement_id,synthesis_revision_id,sort_order) values ($1,$2,$3,$4,$5,0)", [project.id, question.id, answerIds[index]!, synthesis.statement.id, synthesis.revision.id]);
        await tx.unsafe("update research_question_answers set finalized_at=now() where project_id=$1 and research_question_id=$2 and id=$3", [project.id, question.id, answerIds[index]!]);
      }
    });

    const targetPage1 = await reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", field.id, { pageSize: 1 });
    expect(targetPage1.traceabilityEpoch).toBe(epoch);
    expect(targetPage1.history.items[0]?.sequence).toBe(firstEvent);
    const targetCursor = decodeCursor(targetPage1.history.nextCursor!);
    expect(targetCursor).toMatchObject({ epoch, highWaterSequence: secondEvent, sequence: firstEvent });
    const targetPage2 = await reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", field.id, { pageSize: 1, cursor: targetPage1.history.nextCursor });
    expect(targetPage2.history.items[0]?.sequence).toBe(secondEvent);
    expect(targetPage2.currentlyLinked).toBe(false);

    const answerPage1 = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1 });
    expect(answerPage1.highWaterSequence).toBe(answerSequences[1]);
    expect(answerPage1.items[0]).toMatchObject({ id: answerIds[1], sequence: answerSequences[1] });
    const answerCursor = decodeCursor(answerPage1.nextCursor!);
    expect(answerCursor).toMatchObject({ highWaterSequence: answerSequences[1], sequence: answerSequences[1] });
    const answerPage2 = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1, cursor: answerPage1.nextCursor });
    expect(answerPage2.items[0]).toMatchObject({ id: answerIds[0], sequence: answerSequences[0] });
    const snapshot = await reads.getResearchQuestionAnswerBrowserSnapshot(project.id, question.id, answerIds[1]!);
    expect(snapshot.snapshot.sequence).toBe(answerSequences[1]);
    const matrix = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 10 });
    expect(matrix.rows.find((row) => row.question.id === question.id)?.counts.latestAnswerSequence).toBe(answerSequences[1]);
  });

  it("keeps multi-page Answer drift counts aligned with exact Claim and Synthesis snapshots", async () => {
    const project = await review.createProject({ title: `Answer drift ${randomUUID()}`, researchQuestion: "Does bounded Answer history preserve exact context drift?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const paper = await review.addPaper(project.id, { title: "Answer context source" });
    await review.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const evidence = await review.recordEvidence(project.id, { paperId: paper.id, sourceText: "Pinned support passage", pageNumber: 1 });
    const field = await review.createExtractionField(project.id, { name: "Pinned support field", fieldType: "short_text" });
    const extractionRevision = await review.reviseExtractionValue(project.id, paper.id, field.id, { value: "Pinned extraction", evidenceIds: [evidence.id] });
    const synthesis = await review.createSynthesisStatement(project.id, { statementText: "Pinned synthesis", extractionRevisionIds: [extractionRevision.id] });
    const claim = await review.createClaim(project.id, { claimText: "Pinned Claim" });
    const supportedClaim = await review.createClaimRevision(project.id, claim.id, {
      claimText: "Pinned Claim",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: claim.revision.id,
    });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: synthesis.statement.id });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: claim.id });

    const answers = [];
    for (const answerText of ["First exact answer", "Second exact answer"]) {
      answers.push(await review.appendResearchQuestionAnswer(project.id, question.id, {
        answerText,
        claimRevisionIds: [supportedClaim.revision.id],
        synthesisRevisionIds: [synthesis.revision.id],
      }));
    }
    const stableClaim = await review.createClaim(project.id, { claimText: "Stable current Claim" });
    const stableClaimRevision = await review.createClaimRevision(project.id, stableClaim.id, {
      claimText: "Stable current Claim",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: stableClaim.revision.id,
    });
    const stableSynthesis = await review.createSynthesisStatement(project.id, { statementText: "Stable current synthesis", extractionRevisionIds: [extractionRevision.id] });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: stableClaim.id });
    await traceability.linkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: stableSynthesis.statement.id });
    answers.push(await review.appendResearchQuestionAnswer(project.id, question.id, {
      answerText: "Answer with current contexts",
      claimRevisionIds: [stableClaimRevision.revision.id],
      synthesisRevisionIds: [stableSynthesis.revision.id],
    }));

    const newerClaim = await review.createClaimRevision(project.id, claim.id, {
      claimText: "Superseding unsupported Claim",
      supports: [],
      expectedCurrentRevisionId: supportedClaim.revision.id,
    });
    await review.reviseSynthesisStatement(project.id, synthesis.statement.id, {
      statementText: "Superseding unsupported synthesis",
      extractionRevisionIds: [],
    });
    await review.withdrawClaim(project.id, claim.id, { expectedCurrentRevisionId: newerClaim.revision.id });
    await review.withdrawSynthesisStatement(project.id, synthesis.statement.id);
    await traceability.unlinkClaim({ projectId: project.id, questionId: question.id, claimId: claim.id });
    await traceability.unlinkSynthesisStatement({ projectId: project.id, questionId: question.id, statementId: synthesis.statement.id });

    selectLog.length = 0;
    const page1 = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1 });
    const page2 = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1, cursor: page1.nextCursor });
    const page3 = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1, cursor: page2.nextCursor });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(6);
    expect([page1, page2, page3].map((page) => page.totalCount)).toEqual([3, 3, 3]);
    expect(new Set([page1.highWaterSequence, page2.highWaterSequence, page3.highWaterSequence]).size).toBe(1);
    expect([page1.items[0]?.driftedContextCount, page2.items[0]?.driftedContextCount, page3.items[0]?.driftedContextCount]).toEqual([0, 2, 2]);
    expect([page1.items[0]?.id, page2.items[0]?.id, page3.items[0]?.id]).toEqual([answers[2]!.id, answers[1]!.id, answers[0]!.id]);
    expect(BigInt(page1.items[0]!.sequence)).toBeGreaterThan(BigInt(page2.items[0]!.sequence));
    expect(BigInt(page2.items[0]!.sequence)).toBeGreaterThan(BigInt(page3.items[0]!.sequence));

    selectLog.length = 0;
    const snapshot = await reads.getResearchQuestionAnswerBrowserSnapshot(project.id, question.id, answers[0]!.id);
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(3);
    expect(snapshot.snapshot.claimContexts[0]?.driftFlags).toEqual([
      "referenced_claim_revision_superseded",
      "referenced_claim_now_withdrawn",
      "referenced_claim_no_longer_linked_to_rq",
    ]);
    expect(snapshot.snapshot.synthesisContexts[0]?.driftFlags).toEqual([
      "referenced_synthesis_revision_superseded",
      "referenced_synthesis_now_withdrawn",
      "referenced_synthesis_no_longer_linked_to_rq",
    ]);
    expect(snapshot.snapshot.claimContexts[0]?.claimRevisionId).toBe(supportedClaim.revision.id);
    expect(snapshot.snapshot.synthesisContexts[0]?.synthesisRevisionId).toBe(synthesis.revision.id);

    const otherProject = await review.createProject({ title: `Unrelated Answer ${randomUUID()}`, researchQuestion: "Unrelated Answer scope" });
    const otherQuestion = (await review.listResearchQuestions(otherProject.id))[0]!;
    await expect(reads.getResearchQuestionAnswerBrowserSnapshot(otherProject.id, otherQuestion.id, answers[0]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads the maximum 100 Claim plus 100 Synthesis contexts within fixed query budgets", async () => {
    const project = await review.createProject({ title: `Maximum contexts ${randomUUID()}`, researchQuestion: "Can Answer reads bound the maximum context set?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const paper = await review.addPaper(project.id, { title: "Maximum context source" });
    await review.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await review.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await review.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const evidence = await review.recordEvidence(project.id, { paperId: paper.id, sourceText: "Maximum context support", pageNumber: 1 });
    const field = await review.createExtractionField(project.id, { name: "Maximum context field", fieldType: "short_text" });
    const extractionRevision = await review.reviseExtractionValue(project.id, paper.id, field.id, { value: "Shared synthesis support", evidenceIds: [evidence.id] });

    const claimIds = Array.from({ length: 100 }, () => randomUUID());
    const claimRevisionIds = Array.from({ length: 100 }, () => randomUUID());
    const synthesisIds = Array.from({ length: 100 }, () => randomUUID());
    const synthesisRevisionIds = Array.from({ length: 100 }, () => randomUUID());
    await client!.begin(async (tx) => {
      await tx.unsafe("insert into claims(id,project_id) select ids.id,$1 from unnest($2::uuid[]) as ids(id)", [project.id, claimIds]);
      await tx.unsafe("insert into claim_revisions(id,project_id,claim_id,state,claim_text) select pairs.revision_id,$1,pairs.target_id,'active','Maximum context Claim' from unnest($2::uuid[],$3::uuid[]) as pairs(target_id,revision_id)", [project.id, claimIds, claimRevisionIds]);
      await tx.unsafe("insert into claim_revision_evidence_supports(project_id,claim_revision_id,evidence_id) select $1,ids.id,$3 from unnest($2::uuid[]) as ids(id)", [project.id, claimRevisionIds, evidence.id]);
      await tx.unsafe("update claim_revisions set finalized_at=now() where project_id=$1 and id=any($2::uuid[])", [project.id, claimRevisionIds]);

      await tx.unsafe("insert into synthesis_statements(id,project_id) select ids.id,$1 from unnest($2::uuid[]) as ids(id)", [project.id, synthesisIds]);
      await tx.unsafe("insert into synthesis_revisions(id,project_id,synthesis_statement_id,state,statement_text) select pairs.revision_id,$1,pairs.target_id,'active','Maximum context synthesis' from unnest($2::uuid[],$3::uuid[]) as pairs(target_id,revision_id)", [project.id, synthesisIds, synthesisRevisionIds]);
      await tx.unsafe("insert into synthesis_revision_supports(project_id,synthesis_revision_id,extraction_revision_id) select $1,ids.id,$3 from unnest($2::uuid[]) as ids(id)", [project.id, synthesisRevisionIds, extractionRevision.id]);
      await tx.unsafe("update synthesis_revisions set finalized_at=now() where project_id=$1 and id=any($2::uuid[])", [project.id, synthesisRevisionIds]);

      await tx.unsafe("insert into research_question_claim_events(project_id,research_question_id,claim_id,action) select $1,$2,ids.id,'linked' from unnest($3::uuid[]) as ids(id)", [project.id, question.id, claimIds]);
      await tx.unsafe("insert into research_question_synthesis_statement_events(project_id,research_question_id,synthesis_statement_id,action) select $1,$2,ids.id,'linked' from unnest($3::uuid[]) as ids(id)", [project.id, question.id, synthesisIds]);
    });

    const answer = await review.appendResearchQuestionAnswer(project.id, question.id, {
      answerText: "Maximum supported Answer",
      claimRevisionIds,
      synthesisRevisionIds,
    });
    selectLog.length = 0;
    const snapshot = await reads.getResearchQuestionAnswerBrowserSnapshot(project.id, question.id, answer.id);
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(3);
    expect(snapshot.snapshot.claimContexts).toHaveLength(100);
    expect(snapshot.snapshot.synthesisContexts).toHaveLength(100);
    expect(snapshot.snapshot.claimContexts.every((context) => context.isCurrentRevision && context.isCurrentlyLinked)).toBe(true);
    expect(snapshot.snapshot.synthesisContexts.every((context) => context.isCurrentRevision && context.isCurrentlyLinked)).toBe(true);

    selectLog.length = 0;
    const history = await reads.listResearchQuestionAnswerHistoryPage(project.id, question.id, { pageSize: 1 });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(history.items[0]).toMatchObject({ id: answer.id, claimContextCount: 100, synthesisContextCount: 100, driftedContextCount: 0 });
    selectLog.length = 0;
    const matrix = await reads.getResearchQuestionMatrixPage(project.id, { pageSize: 20 });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(6);
    expect(matrix.rows[0]?.counts).toMatchObject({ claimAnswerContexts: 100, synthesisAnswerContexts: 100, driftedAnswerContexts: 0 });
  }, 60_000);

  it("rejects a continuation when a lower reserved event sequence commits after page one", async () => {
    const project = await review.createProject({ title: `Late commit ${randomUUID()}`, researchQuestion: "Does the epoch fence late commits?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const earlier = await review.createClaim(project.id, { claimText: "Already linked claim" });
    const delayed = await review.createClaim(project.id, { claimText: "Delayed lower-sequence claim" });
    const later = await review.createClaim(project.id, { claimText: "Committed higher-sequence claim" });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: earlier.id });

    const reservedSequence = deferred<string>();
    const releaseInsert = deferred<void>();
    const delayedInsert = client!.begin(async (tx) => {
      const reserved = await tx.unsafe("select nextval(pg_get_serial_sequence('public.research_question_claim_events','sequence'))::text as sequence") as { sequence: string }[];
      reservedSequence.resolve(reserved[0]!.sequence);
      await releaseInsert.promise;
      await tx.unsafe("insert into research_question_claim_events (sequence,project_id,research_question_id,claim_id,action) overriding system value values ($1::bigint,$2,$3,$4,'linked')", [reserved[0]!.sequence, project.id, question.id, delayed.id]);
    });
    const lowerSequence = await reservedSequence.promise;
    await client!.unsafe("insert into research_question_claim_events (project_id,research_question_id,claim_id,action) values ($1,$2,$3,'linked')", [project.id, question.id, later.id]);
    const [laterSequence] = await client!.unsafe("select sequence::text as sequence from research_question_claim_events where project_id=$1 and research_question_id=$2 and claim_id=$3 order by sequence desc limit 1", [project.id, question.id, later.id]) as { sequence: string }[];
    expect(BigInt(lowerSequence)).toBeLessThan(BigInt(laterSequence!.sequence));

    const firstPage = await reads.listResearchQuestionLinkPage(project.id, question.id, "claim", { pageSize: 1 });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();
    releaseInsert.resolve();
    await delayedInsert;
    await expect(reads.listResearchQuestionLinkPage(project.id, question.id, "claim", { pageSize: 1, cursor: firstPage.nextCursor })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("pages target history in chronological order with full notes and invalidates it on any typed ledger change", async () => {
    const project = await review.createProject({ title: `Target history ${randomUUID()}`, researchQuestion: "Can exact target history page chronologically?" });
    const question = (await review.listResearchQuestions(project.id))[0]!;
    const field = await review.createExtractionField(project.id, { name: "Long history field", fieldType: "short_text" });
    const fullNote = "N".repeat(2000);
    await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id, note: fullNote });
    for (let index = 0; index < 20; index += 1) {
      if (index % 2 === 0) await traceability.unlinkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id, note: `event-${index}` });
      else await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id, note: `event-${index}` });
    }
    for (let index = 20; index < 25; index += 1) {
      if (index % 2 === 0) await traceability.unlinkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id, note: `event-${index}` });
      else await traceability.linkExtractionField({ projectId: project.id, questionId: question.id, fieldId: field.id, note: `event-${index}` });
    }

    selectLog.length = 0;
    const firstPage = await reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", field.id, { pageSize: 20 });
    expect(selectLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(firstPage.history.items).toHaveLength(20);
    expect(firstPage.history.hasMore).toBe(true);
    expect(firstPage.history.items[0]?.note).toBe(fullNote);
    expect(firstPage.history.items.every((event, index, events) => index === 0 || BigInt(events[index - 1]!.sequence) < BigInt(event.sequence))).toBe(true);
    const secondPage = await reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", field.id, { pageSize: 20, cursor: firstPage.history.nextCursor });
    expect(secondPage.history.items).toHaveLength(6);
    expect(BigInt(secondPage.history.items[0]!.sequence)).toBeGreaterThan(BigInt(firstPage.history.items.at(-1)!.sequence));

    const defaultPage = await reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", field.id);
    expect(defaultPage.history.pageSize).toBe(20);
    expect(defaultPage.history.items).toHaveLength(20);
    const clampedPage = await reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", field.id, { pageSize: 100 });
    expect(clampedPage.history.pageSize).toBe(25);
    expect(clampedPage.history.items).toHaveLength(25);
    expect(clampedPage.history.hasMore).toBe(true);

    const claim = await review.createClaim(project.id, { claimText: "Other dimension event" });
    await traceability.linkClaim({ projectId: project.id, questionId: question.id, claimId: claim.id });
    await expect(reads.getResearchQuestionTargetDetail(project.id, question.id, "extraction-field", field.id, { pageSize: 20, cursor: firstPage.history.nextCursor })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });
});
