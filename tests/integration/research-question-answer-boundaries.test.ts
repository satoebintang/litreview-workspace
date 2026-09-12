import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { ResearchQuestionTraceabilityRepository } from "@/application/research-question-traceability-repository";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(databaseUrl);
const sql = postgres(databaseUrl, { prepare: false, max: 1 });
const concurrentSql = postgres(databaseUrl, { prepare: false, max: 1 });

type BaseFixture = {
  projectId: string;
  questionId: string;
  paperId: string;
  evidenceId: string;
};

type ClaimFixture = BaseFixture & {
  claimId: string;
  revisionId: string;
};

type SynthesisFixture = BaseFixture & {
  statementId: string;
  revisionId: string;
  extractionRevisionId: string;
};

const uuid = () => crypto.randomUUID();

async function truncate() {
  await sql.unsafe(
    "TRUNCATE TABLE research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_claim_events, research_question_synthesis_statement_events, claim_revision_evidence_supports, claim_revision_extraction_supports, claim_revision_synthesis_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, evidence, claims, papers, research_questions, projects CASCADE",
  );
}

async function createBase(): Promise<BaseFixture> {
  const fixture = {
    projectId: uuid(),
    questionId: uuid(),
    paperId: uuid(),
    evidenceId: uuid(),
  };
  await sql`insert into projects (id, title) values (${fixture.projectId}, 'Slice 21 boundary test')`;
  await sql`insert into research_questions (id, project_id, identifier, label) values (${fixture.questionId}, ${fixture.projectId}, 'RQ1', 'Boundary question')`;
  await sql`insert into papers (id, project_id, title) values (${fixture.paperId}, ${fixture.projectId}, 'Boundary paper')`;
  await sql`insert into evidence (id, project_id, paper_id, source_text, page_number) values (${fixture.evidenceId}, ${fixture.projectId}, ${fixture.paperId}, 'Quoted source', 1)`;
  return fixture;
}

async function addClaimWithSupport(
  base: BaseFixture,
  support?: { kind: "evidence" | "extraction" | "synthesis"; extractionRevisionId?: string; synthesisRevisionId?: string },
): Promise<ClaimFixture> {
  const claimId = uuid();
  const revisionId = uuid();
  await sql`insert into claims (id, project_id) values (${claimId}, ${base.projectId})`;
  await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${revisionId}, ${base.projectId}, ${claimId}, 'active', 'A current claim')`;
  if (support?.kind === "evidence") {
    await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${base.projectId}, ${revisionId}, ${base.evidenceId})`;
  } else if (support?.kind === "extraction" && support.extractionRevisionId) {
    await sql`insert into claim_revision_extraction_supports (project_id, claim_revision_id, extraction_revision_id) values (${base.projectId}, ${revisionId}, ${support.extractionRevisionId})`;
  } else if (support?.kind === "synthesis" && support.synthesisRevisionId) {
    await sql`insert into claim_revision_synthesis_supports (project_id, claim_revision_id, synthesis_revision_id) values (${base.projectId}, ${revisionId}, ${support.synthesisRevisionId})`;
  }
  await sql`update claim_revisions set finalized_at = now() where project_id = ${base.projectId} and id = ${revisionId}`;
  return { ...base, claimId, revisionId };
}

async function addClaim(base: BaseFixture, supported = true): Promise<ClaimFixture> {
  return addClaimWithSupport(base, supported ? { kind: "evidence" } : undefined);
}

async function addWithdrawnClaim(base: BaseFixture): Promise<ClaimFixture> {
  const claimId = uuid();
  const revisionId = uuid();
  await sql`insert into claims (id, project_id) values (${claimId}, ${base.projectId})`;
  await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${revisionId}, ${base.projectId}, ${claimId}, 'withdrawn', null)`;
  await sql`update claim_revisions set finalized_at = now() where project_id = ${base.projectId} and id = ${revisionId}`;
  return { ...base, claimId, revisionId };
}

async function addSynthesis(base: BaseFixture, supported = true): Promise<SynthesisFixture> {
  const fieldId = uuid();
  const extractionValueId = uuid();
  const extractionRevisionId = uuid();
  const statementId = uuid();
  const revisionId = uuid();
  await sql`insert into extraction_fields (id, project_id, name, field_type) values (${fieldId}, ${base.projectId}, 'Observation', 'short_text')`;
  await sql`insert into extraction_values (id, project_id, paper_id, field_id) values (${extractionValueId}, ${base.projectId}, ${base.paperId}, ${fieldId})`;
  await sql`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) values (${extractionRevisionId}, ${base.projectId}, ${base.paperId}, ${fieldId}, ${extractionValueId}, 'short_text', 'present', 'Observed', now())`;
  await sql`insert into synthesis_statements (id, project_id) values (${statementId}, ${base.projectId})`;
  await sql`insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text) values (${revisionId}, ${base.projectId}, ${statementId}, 'active', 'Synthesis', 'A supported synthesis')`;
  if (supported) {
    await sql`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${base.projectId}, ${revisionId}, ${extractionRevisionId})`;
  }
  await sql`update synthesis_revisions set finalized_at = now() where project_id = ${base.projectId} and id = ${revisionId}`;
  return { ...base, statementId, revisionId, extractionRevisionId };
}

async function addWithdrawnSynthesis(base: BaseFixture): Promise<SynthesisFixture> {
  const statementId = uuid();
  const revisionId = uuid();
  const extractionRevisionId = uuid();
  await sql`insert into synthesis_statements (id, project_id) values (${statementId}, ${base.projectId})`;
  await sql`insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text) values (${revisionId}, ${base.projectId}, ${statementId}, 'withdrawn', null, null)`;
  await sql`update synthesis_revisions set finalized_at = now() where project_id = ${base.projectId} and id = ${revisionId}`;
  return { ...base, statementId, revisionId, extractionRevisionId };
}

async function insertClaimEvent(fixture: ClaimFixture, action: "linked" | "unlinked") {
  await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, ${action})`;
}

async function insertSynthesisEvent(fixture: SynthesisFixture, action: "linked" | "unlinked") {
  await sql`insert into research_question_synthesis_statement_events (project_id, research_question_id, synthesis_statement_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.statementId}, ${action})`;
}

async function helperClaim(fixture: ClaimFixture) {
  const [row] = await sql`
    select research_question_answer_claim_context_eligible(
      ${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, ${fixture.revisionId}
    ) as eligible
  `;
  return Boolean(row.eligible);
}

async function helperSynthesis(fixture: SynthesisFixture) {
  const [row] = await sql`
    select research_question_answer_synthesis_context_eligible(
      ${fixture.projectId}, ${fixture.questionId}, ${fixture.statementId}, ${fixture.revisionId}
    ) as eligible
  `;
  return Boolean(row.eligible);
}

async function directClaimAnswer(fixture: ClaimFixture, answerId = uuid()) {
  await sql.begin(async (tx) => {
    await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${answerId}, ${fixture.projectId}, ${fixture.questionId}, 'The answer')`;
    await tx`insert into research_question_answer_claim_contexts (project_id, research_question_id, answer_id, claim_id, claim_revision_id, sort_order) values (${fixture.projectId}, ${fixture.questionId}, ${answerId}, ${fixture.claimId}, ${fixture.revisionId}, 0)`;
    await tx`update research_question_answers set finalized_at = now() where project_id = ${fixture.projectId} and id = ${answerId}`;
  });
  return answerId;
}

async function directSynthesisAnswer(fixture: SynthesisFixture, answerId = uuid()) {
  await sql.begin(async (tx) => {
    await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${answerId}, ${fixture.projectId}, ${fixture.questionId}, 'The synthesis answer')`;
    await tx`insert into research_question_answer_synthesis_contexts (project_id, research_question_id, answer_id, synthesis_statement_id, synthesis_revision_id, sort_order) values (${fixture.projectId}, ${fixture.questionId}, ${answerId}, ${fixture.statementId}, ${fixture.revisionId}, 0)`;
    await tx`update research_question_answers set finalized_at = now() where project_id = ${fixture.projectId} and id = ${answerId}`;
  });
  return answerId;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function lockClaimAndHold(fixture: ClaimFixture, release: Promise<void>, writeNewRevision: boolean) {
  return concurrentSql.begin(async (tx) => {
    await tx`select id from claims where project_id = ${fixture.projectId} and id = ${fixture.claimId} for update`;
    if (writeNewRevision) {
      const newerRevisionId = uuid();
      await tx`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${newerRevisionId}, ${fixture.projectId}, ${fixture.claimId}, 'active', 'A newer claim')`;
      await tx`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${fixture.projectId}, ${newerRevisionId}, ${fixture.evidenceId})`;
      await tx`update claim_revisions set finalized_at = now() where project_id = ${fixture.projectId} and id = ${newerRevisionId}`;
    }
    await release;
  });
}

async function lockSynthesisAndHold(fixture: SynthesisFixture, release: Promise<void>, writeNewRevision: boolean) {
  return concurrentSql.begin(async (tx) => {
    await tx`select id from synthesis_statements where project_id = ${fixture.projectId} and id = ${fixture.statementId} for update`;
    if (writeNewRevision) {
      const newerRevisionId = uuid();
      await tx`insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text) values (${newerRevisionId}, ${fixture.projectId}, ${fixture.statementId}, 'active', 'Newer synthesis', 'A newer synthesis')`;
      await tx`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${fixture.projectId}, ${newerRevisionId}, ${fixture.extractionRevisionId})`;
      await tx`update synthesis_revisions set finalized_at = now() where project_id = ${fixture.projectId} and id = ${newerRevisionId}`;
    }
    await release;
  });
}

describe("Slice 21 Answer database parity and races", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    await truncate();
  });

  afterAll(async () => {
    await truncate();
    await sql.end();
    await concurrentSql.end();
    await client.end();
  });

  it("matches the Slice 20 reducer by selecting latest event before action, including unrelated global sequences", async () => {
    const base = await createBase();
    const first = await addClaim(base);
    const second = await addClaim(base);
    const unrelated = await addClaim(base);
    const synthesisFirst = await addSynthesis(base, true);
    const synthesisSecond = await addSynthesis(base, true);
    const synthesisUnrelated = await addSynthesis(base, true);

    await insertClaimEvent(first, "linked");
    await insertClaimEvent(second, "linked");
    await insertClaimEvent(first, "unlinked");

    const repo = new ResearchQuestionTraceabilityRepository(db);
    let links = await repo.listCurrentLinksForQuestion(base.projectId, base.questionId);
    expect(links.claimIds).toEqual([second.claimId]);
    expect(await helperClaim(first)).toBe(false);
    expect(await helperClaim(second)).toBe(true);

    // Events for a different target consume global sequence values but cannot
    // change the latest state of either selected pair.
    await insertClaimEvent(unrelated, "linked");
    await insertClaimEvent(unrelated, "unlinked");
    await insertClaimEvent(first, "linked");
    links = await repo.listCurrentLinksForQuestion(base.projectId, base.questionId);
    expect(new Set(links.claimIds)).toEqual(new Set([first.claimId, second.claimId]));
    expect(await helperClaim(first)).toBe(true);
    expect(await helperClaim(second)).toBe(true);

    await insertSynthesisEvent(synthesisFirst, "linked");
    await insertSynthesisEvent(synthesisSecond, "linked");
    await insertSynthesisEvent(synthesisFirst, "unlinked");
    expect(await helperSynthesis(synthesisFirst)).toBe(false);
    expect(await helperSynthesis(synthesisSecond)).toBe(true);
    await insertSynthesisEvent(synthesisUnrelated, "linked");
    await insertSynthesisEvent(synthesisUnrelated, "unlinked");
    await insertSynthesisEvent(synthesisFirst, "linked");
    expect(await helperSynthesis(synthesisFirst)).toBe(true);
    expect(await helperSynthesis(synthesisSecond)).toBe(true);
  });

  it("requires formal SynthesisRevision support and current traceability for finalization", async () => {
    const base = await createBase();
    const supported = await addSynthesis(base, true);
    const unsupported = await addSynthesis(base, false);
    await insertSynthesisEvent(supported, "linked");
    await insertSynthesisEvent(unsupported, "linked");

    expect(await helperSynthesis(supported)).toBe(true);
    expect(await helperSynthesis(unsupported)).toBe(false);
    const services = createReviewServices(db);
    const candidates = await services.listResearchQuestionAnswerCandidates(base.projectId, base.questionId);
    expect(candidates.syntheses.find((candidate) => candidate.targetId === supported.statementId)).toMatchObject({
      revisionId: supported.revisionId,
      isSelectable: true,
      supportStatus: "supported",
    });
    expect(candidates.syntheses.find((candidate) => candidate.targetId === unsupported.statementId)).toMatchObject({
      revisionId: unsupported.revisionId,
      isSelectable: false,
      supportStatus: "unsupported",
    });
    await expect(services.appendResearchQuestionAnswer(base.projectId, base.questionId, {
      answerText: "Unsupported synthesis",
      claimRevisionIds: [],
      synthesisRevisionIds: [unsupported.revisionId],
    })).rejects.toMatchObject({ code: "INELIGIBLE_REFERENCE" });
    await expect(directSynthesisAnswer(unsupported)).rejects.toThrow(/not currently linked|supported/);
    await expect(directSynthesisAnswer(supported)).resolves.toBeDefined();

    await insertSynthesisEvent(supported, "unlinked");
    expect(await helperSynthesis(supported)).toBe(false);
  });

  it("matches the released Claim support resolver for direct, extraction, synthesis, and unsupported revisions", async () => {
    const base = await createBase();
    const synthesisSupport = await addSynthesis(base, true);
    await sql`insert into screening_decisions (project_id, paper_id, stage, decision) values (${base.projectId}, ${base.paperId}, 'title_abstract', 'include')`;
    await createReviewServices(db).recordFullTextRetrievalAttempt(base.projectId, base.paperId, {
      outcome: "retrieved",
      attemptedAt: new Date(),
    });
    await sql`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${base.projectId}, ${base.paperId}, 'include')`;
    const direct = await addClaimWithSupport(base, { kind: "evidence" });
    const extraction = await addClaimWithSupport(base, { kind: "extraction", extractionRevisionId: synthesisSupport.extractionRevisionId });
    const synthesis = await addClaimWithSupport(base, { kind: "synthesis", synthesisRevisionId: synthesisSupport.revisionId });
    const unsupported = await addClaim(base, false);

    for (const fixture of [direct, extraction, synthesis, unsupported]) await insertClaimEvent(fixture, "linked");

    expect(await helperClaim(direct)).toBe(true);
    expect(await helperClaim(extraction)).toBe(true);
    expect(await helperClaim(synthesis)).toBe(true);
    expect(await helperClaim(unsupported)).toBe(false);

    const services = createReviewServices(db);
    const candidates = await services.listResearchQuestionAnswerCandidates(base.projectId, base.questionId);
    const [supportCountsBefore] = await sql`
      select
        (select count(*)::integer from claim_revision_evidence_supports where project_id = ${base.projectId}) as claim_evidence,
        (select count(*)::integer from claim_revision_extraction_supports where project_id = ${base.projectId}) as claim_extraction,
        (select count(*)::integer from claim_revision_synthesis_supports where project_id = ${base.projectId}) as claim_synthesis,
        (select count(*)::integer from synthesis_revision_supports where project_id = ${base.projectId}) as synthesis
    `;
    for (const fixture of [direct, extraction, synthesis]) {
      expect(candidates.claims.find((candidate) => candidate.targetId === fixture.claimId)).toMatchObject({
        revisionId: fixture.revisionId,
        isSelectable: true,
        supportStatus: "supported",
      });
      await expect(services.appendResearchQuestionAnswer(base.projectId, base.questionId, {
        answerText: `Supported ${fixture.claimId}`,
        claimRevisionIds: [fixture.revisionId],
        synthesisRevisionIds: [],
      })).resolves.toMatchObject({ finalizedAt: expect.any(Date) });
      await expect(directClaimAnswer(fixture)).resolves.toBeDefined();
    }
    expect(candidates.claims.find((candidate) => candidate.targetId === unsupported.claimId)).toMatchObject({
      revisionId: unsupported.revisionId,
      isSelectable: false,
      supportStatus: "unsupported",
    });
    await expect(services.appendResearchQuestionAnswer(base.projectId, base.questionId, {
      answerText: "Unsupported claim",
      claimRevisionIds: [unsupported.revisionId],
      synthesisRevisionIds: [],
    })).rejects.toMatchObject({ code: "INELIGIBLE_REFERENCE" });
    await expect(directClaimAnswer(unsupported)).rejects.toThrow(/supported/);
    const [supportCountsAfter] = await sql`
      select
        (select count(*)::integer from claim_revision_evidence_supports where project_id = ${base.projectId}) as claim_evidence,
        (select count(*)::integer from claim_revision_extraction_supports where project_id = ${base.projectId}) as claim_extraction,
        (select count(*)::integer from claim_revision_synthesis_supports where project_id = ${base.projectId}) as claim_synthesis,
        (select count(*)::integer from synthesis_revision_supports where project_id = ${base.projectId}) as synthesis
    `;
    expect(supportCountsAfter).toEqual(supportCountsBefore);
  });

  it("uses the released Claim and Synthesis resolvers through the composition root", async () => {
    const base = await createBase();
    const claim = await addClaim(base, true);
    await insertClaimEvent(claim, "linked");
    const synthesis = await addSynthesis(base, true);
    await insertSynthesisEvent(synthesis, "linked");
    const services = createReviewServices(db);

    const claimAnswer = await services.appendResearchQuestionAnswer(base.projectId, base.questionId, {
      answerText: "Canonical Claim answer",
      claimRevisionIds: [claim.revisionId],
      synthesisRevisionIds: [],
    });
    expect(claimAnswer.finalizedAt).not.toBeNull();

    const synthesisAnswer = await services.appendResearchQuestionAnswer(base.projectId, base.questionId, {
      answerText: "Canonical Synthesis answer",
      claimRevisionIds: [],
      synthesisRevisionIds: [synthesis.revisionId],
    });
    expect(synthesisAnswer.finalizedAt).not.toBeNull();
    const projection = await services.getResearchQuestionAnswerProjection(base.projectId, base.questionId);
    expect(projection.finalizedAnswerCount).toBe(2);
    expect(projection.history.some((answer) => answer.synthesisContexts.some((context) => context.synthesisRevisionId === synthesis.revisionId && context.supportStatus === "supported"))).toBe(true);
  });

  it("serializes Answer finalization against unlink in both commit orders", async () => {
    const base = await createBase();
    const fixture = await addClaim(base);
    await insertClaimEvent(fixture, "linked");

    // Answer acquires RQ first; unlink waits and commits second.
    const answerEntered = deferred<void>();
    const releaseAnswer = deferred<void>();
    const answerWins = sql.begin(async (tx) => {
      await tx`select id from research_questions where project_id = ${fixture.projectId} and id = ${fixture.questionId} for update`;
      await tx`select id from claims where project_id = ${fixture.projectId} and id = ${fixture.claimId} for update`;
      answerEntered.resolve();
      await releaseAnswer.promise;
      const answerId = uuid();
      await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${answerId}, ${fixture.projectId}, ${fixture.questionId}, 'Answer wins')`;
      await tx`insert into research_question_answer_claim_contexts (project_id, research_question_id, answer_id, claim_id, claim_revision_id, sort_order) values (${fixture.projectId}, ${fixture.questionId}, ${answerId}, ${fixture.claimId}, ${fixture.revisionId}, 0)`;
      await tx`update research_question_answers set finalized_at = now() where project_id = ${fixture.projectId} and id = ${answerId}`;
      return answerId;
    });
    await answerEntered.promise;
    const unlinkAfterAnswer = concurrentSql.begin(async (tx) => {
      await tx`select id from research_questions where project_id = ${fixture.projectId} and id = ${fixture.questionId} for update`;
      await tx`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'unlinked')`;
    });
    releaseAnswer.resolve();
    const answerId = await answerWins;
    await unlinkAfterAnswer;
    expect(answerId).toBeDefined();
    expect(await helperClaim(fixture)).toBe(false);

    // Unlink acquires RQ first; Answer waits and then observes the unlink.
    await truncate();
    const secondBase = await createBase();
    const secondFixture = await addClaim(secondBase);
    await insertClaimEvent(secondFixture, "linked");
    const unlinkEntered = deferred<void>();
    const releaseUnlink = deferred<void>();
    const unlinkWins = concurrentSql.begin(async (tx) => {
      await tx`select id from research_questions where project_id = ${secondFixture.projectId} and id = ${secondFixture.questionId} for update`;
      unlinkEntered.resolve();
      await releaseUnlink.promise;
      await tx`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${secondFixture.projectId}, ${secondFixture.questionId}, ${secondFixture.claimId}, 'unlinked')`;
    });
    await unlinkEntered.promise;
    const answerAfterUnlink = directClaimAnswer(secondFixture);
    // The Answer transaction cannot pass its first lock until unlink commits.
    releaseUnlink.resolve();
    await unlinkWins;
    await expect(answerAfterUnlink).rejects.toThrow(/not currently linked/);
  });

  it("serializes Answer finalization against a newer ClaimRevision in both commit orders", async () => {
    const base = await createBase();
    const fixture = await addClaim(base);
    await insertClaimEvent(fixture, "linked");

    // Answer wins: the revision writer waits on the Claim parent lock.
    const answerEntered = deferred<void>();
    const releaseAnswer = deferred<void>();
    const answerWins = sql.begin(async (tx) => {
      await tx`select id from research_questions where project_id = ${fixture.projectId} and id = ${fixture.questionId} for update`;
      await tx`select id from claims where project_id = ${fixture.projectId} and id = ${fixture.claimId} for update`;
      answerEntered.resolve();
      await releaseAnswer.promise;
      const answerId = uuid();
      await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${answerId}, ${fixture.projectId}, ${fixture.questionId}, 'Answer wins')`;
      await tx`insert into research_question_answer_claim_contexts (project_id, research_question_id, answer_id, claim_id, claim_revision_id, sort_order) values (${fixture.projectId}, ${fixture.questionId}, ${answerId}, ${fixture.claimId}, ${fixture.revisionId}, 0)`;
      await tx`update research_question_answers set finalized_at = now() where project_id = ${fixture.projectId} and id = ${answerId}`;
      return answerId;
    });
    await answerEntered.promise;
    const releaseWriter = deferred<void>();
    const revisionAfterAnswer = lockClaimAndHold(fixture, releaseWriter.promise, true);
    releaseAnswer.resolve();
    const answerId = await answerWins;
    releaseWriter.resolve();
    await revisionAfterAnswer;
    expect(answerId).toBeDefined();
    const [answerCount] = await sql`select count(*)::integer as count from research_question_answers where project_id = ${fixture.projectId}`;
    expect(Number(answerCount.count)).toBe(1);

    // New revision wins: Answer waits on Claim, then the deferred validator
    // rejects the exact old revision instead of floating to the new one.
    await truncate();
    const secondBase = await createBase();
    const secondFixture = await addClaim(secondBase);
    await insertClaimEvent(secondFixture, "linked");
    const releaseWriterFirst = deferred<void>();
    const revisionBeforeAnswer = lockClaimAndHold(secondFixture, releaseWriterFirst.promise, true);
    // Give the writer a turn to acquire its lock before starting Answer.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const answerAfterRevision = directClaimAnswer(secondFixture);
    releaseWriterFirst.resolve();
    await revisionBeforeAnswer;
    await expect(answerAfterRevision).rejects.toThrow(/current|not currently linked/);
    const [answerCountAfter] = await sql`select count(*)::integer as count from research_question_answers where project_id = ${secondFixture.projectId}`;
    expect(Number(answerCountAfter.count)).toBe(0);
  });

  it("serializes Answer finalization against a newer SynthesisRevision in both commit orders", async () => {
    const base = await createBase();
    const fixture = await addSynthesis(base, true);
    await insertSynthesisEvent(fixture, "linked");

    // Answer wins: the competing Synthesis writer waits on the stable parent.
    const answerEntered = deferred<void>();
    const releaseAnswer = deferred<void>();
    const answerWins = sql.begin(async (tx) => {
      await tx`select id from research_questions where project_id = ${fixture.projectId} and id = ${fixture.questionId} for update`;
      await tx`select id from synthesis_statements where project_id = ${fixture.projectId} and id = ${fixture.statementId} for update`;
      answerEntered.resolve();
      await releaseAnswer.promise;
      const answerId = uuid();
      await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${answerId}, ${fixture.projectId}, ${fixture.questionId}, 'Synthesis answer wins')`;
      await tx`insert into research_question_answer_synthesis_contexts (project_id, research_question_id, answer_id, synthesis_statement_id, synthesis_revision_id, sort_order) values (${fixture.projectId}, ${fixture.questionId}, ${answerId}, ${fixture.statementId}, ${fixture.revisionId}, 0)`;
      await tx`update research_question_answers set finalized_at = now() where project_id = ${fixture.projectId} and id = ${answerId}`;
      return answerId;
    });
    await answerEntered.promise;
    const releaseWriter = deferred<void>();
    const revisionAfterAnswer = lockSynthesisAndHold(fixture, releaseWriter.promise, true);
    releaseAnswer.resolve();
    const answerId = await answerWins;
    releaseWriter.resolve();
    await revisionAfterAnswer;
    expect(answerId).toBeDefined();
    const services = createReviewServices(db);
    const snapshot = await services.getResearchQuestionAnswerSnapshot(base.projectId, base.questionId, answerId);
    expect(snapshot.synthesisContexts[0]).toMatchObject({
      synthesisRevisionId: fixture.revisionId,
      isCurrentRevision: false,
      driftFlags: ["referenced_synthesis_revision_superseded"],
    });

    // New revision wins: the exact old submission is rejected, never floated.
    await truncate();
    const secondBase = await createBase();
    const secondFixture = await addSynthesis(secondBase, true);
    await insertSynthesisEvent(secondFixture, "linked");
    const releaseWriterFirst = deferred<void>();
    const revisionBeforeAnswer = lockSynthesisAndHold(secondFixture, releaseWriterFirst.promise, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const answerAfterRevision = directSynthesisAnswer(secondFixture);
    releaseWriterFirst.resolve();
    await revisionBeforeAnswer;
    await expect(answerAfterRevision).rejects.toThrow(/current|not currently linked/);
    const [answerCountAfter] = await sql`select count(*)::integer as count from research_question_answers where project_id = ${secondFixture.projectId}`;
    expect(Number(answerCountAfter.count)).toBe(0);
  });

  it("accepts a relinked target only when relink is the latest committed event", async () => {
    const base = await createBase();
    const fixture = await addClaim(base);
    await insertClaimEvent(fixture, "linked");
    await sql.begin(async (tx) => {
      await tx`select id from research_questions where project_id = ${fixture.projectId} and id = ${fixture.questionId} for update`;
      await tx`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'unlinked')`;
    });
    await sql.begin(async (tx) => {
      await tx`select id from research_questions where project_id = ${fixture.projectId} and id = ${fixture.questionId} for update`;
      await tx`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'linked')`;
    });
    await expect(directClaimAnswer(fixture)).resolves.toBeDefined();
    const repo = new ResearchQuestionTraceabilityRepository(db);
    expect((await repo.listCurrentLinksForQuestion(base.projectId, base.questionId)).claimIds).toContain(fixture.claimId);
  });

  it("rejects direct SQL cross-project and withdrawn contexts at deferred finalization", async () => {
    const base = await createBase();
    const foreign = await createBase();
    const foreignClaim = await addClaim(foreign);
    await insertClaimEvent(foreignClaim, "linked");

    const crossProjectAnswerId = uuid();
    await expect(sql.begin(async (tx) => {
      await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${crossProjectAnswerId}, ${base.projectId}, ${base.questionId}, 'Cross-project')`;
      await tx`insert into research_question_answer_claim_contexts (project_id, research_question_id, answer_id, claim_id, claim_revision_id, sort_order) values (${base.projectId}, ${base.questionId}, ${crossProjectAnswerId}, ${foreignClaim.claimId}, ${foreignClaim.revisionId}, 0)`;
      await tx`update research_question_answers set finalized_at = now() where project_id = ${base.projectId} and id = ${crossProjectAnswerId}`;
    })).rejects.toThrow(/foreign key|violates/);

    const withdrawn = await addWithdrawnClaim(base);
    await insertClaimEvent(withdrawn, "linked");
    await expect(directClaimAnswer(withdrawn)).rejects.toThrow(/supported|eligible|current/);

    const withdrawnSynthesis = await addWithdrawnSynthesis(base);
    await insertSynthesisEvent(withdrawnSynthesis, "linked");
    await expect(directSynthesisAnswer(withdrawnSynthesis)).rejects.toThrow(/supported|eligible|current/);
  });
});
