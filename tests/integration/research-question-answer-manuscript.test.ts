/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(databaseUrl);
const sql = postgres(databaseUrl, { prepare: false, max: 1 });
const concurrentSql = postgres(databaseUrl, { prepare: false, max: 1 });
const services = createReviewServices(db) as any;
const uuid = () => crypto.randomUUID();

type ClaimFixture = { claimId: string; revisionId: string; evidenceId: string };
type SynthesisFixture = { statementId: string; revisionId: string; extractionRevisionId: string };
type Fixture = { projectId: string; questionId: string; paperId: string; claims: ClaimFixture[] };

async function truncate() {
  await sql.unsafe("TRUNCATE TABLE ai_extraction_decision_evidence, ai_extraction_decisions, ai_extraction_result_groundings, ai_extraction_results, ai_extraction_dispatches, ai_extraction_request_pages, ai_extraction_requests, manuscript_snapshot_warnings, manuscript_snapshot_claim_bibliography_members, manuscript_snapshot_bibliography_entries, manuscript_snapshot_claim_items, manuscript_snapshot_prose_items, manuscript_snapshot_items, manuscript_snapshot_sections, manuscript_snapshots, research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_claim_events, research_question_synthesis_statement_events, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_revisions, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_evidence_supports, claim_revision_extraction_supports, claim_revision_synthesis_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, evidence, claims, papers, research_questions, projects CASCADE");
}

async function addClaim(projectId: string, paperId: string, index: number): Promise<ClaimFixture> {
  const claimId = uuid();
  const revisionId = uuid();
  const evidenceId = uuid();
  await sql`insert into evidence (id, project_id, paper_id, source_text, page_number) values (${evidenceId}, ${projectId}, ${paperId}, ${`Source ${index}`}, ${index})`;
  await sql`insert into claims (id, project_id) values (${claimId}, ${projectId})`;
  await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${revisionId}, ${projectId}, ${claimId}, 'active', ${`Claim ${index}`})`;
  await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${revisionId}, ${evidenceId})`;
  await sql`update claim_revisions set finalized_at = now() where project_id=${projectId} and id=${revisionId}`;
  return { claimId, revisionId, evidenceId };
}

async function createFixture(count = 3): Promise<Fixture> {
  const projectId = uuid();
  const questionId = uuid();
  const paperId = uuid();
  await sql`insert into projects (id, title) values (${projectId}, 'Slice 22 manuscript application')`;
  await sql`insert into research_questions (id, project_id, identifier, label) values (${questionId}, ${projectId}, 'RQ1', 'Which finding answers the question?')`;
  await sql`insert into papers (id, project_id, title) values (${paperId}, ${projectId}, 'Slice 22 paper')`;
  const claims: ClaimFixture[] = [];
  for (let index = 1; index <= count; index += 1) claims.push(await addClaim(projectId, paperId, index));
  for (const claim of claims) {
    await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${projectId}, ${questionId}, ${claim.claimId}, 'linked')`;
  }
  return { projectId, questionId, paperId, claims };
}

async function addSynthesis(fixture: Fixture): Promise<SynthesisFixture> {
  const fieldId = uuid();
  const extractionValueId = uuid();
  const extractionRevisionId = uuid();
  const statementId = uuid();
  const revisionId = uuid();
  await sql`insert into extraction_fields (id, project_id, name, field_type) values (${fieldId}, ${fixture.projectId}, 'Observation', 'short_text')`;
  await sql`insert into extraction_values (id, project_id, paper_id, field_id) values (${extractionValueId}, ${fixture.projectId}, ${fixture.paperId}, ${fieldId})`;
  await sql`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) values (${extractionRevisionId}, ${fixture.projectId}, ${fixture.paperId}, ${fieldId}, ${extractionValueId}, 'short_text', 'present', 'Observed', now())`;
  await sql`insert into synthesis_statements (id, project_id) values (${statementId}, ${fixture.projectId})`;
  await sql`insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text) values (${revisionId}, ${fixture.projectId}, ${statementId}, 'active', 'Synthesis context', 'Exact synthesis context')`;
  await sql`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${fixture.projectId}, ${revisionId}, ${extractionRevisionId})`;
  await sql`update synthesis_revisions set finalized_at=now() where project_id=${fixture.projectId} and id=${revisionId}`;
  await sql`insert into research_question_synthesis_statement_events (project_id, research_question_id, synthesis_statement_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${statementId}, 'linked')`;
  return { statementId, revisionId, extractionRevisionId };
}

async function answerFor(fixture: Fixture, revisionIds = fixture.claims.map((claim) => claim.revisionId)) {
  return services.appendResearchQuestionAnswer(fixture.projectId, fixture.questionId, {
    answerText: "Exact answer text for drafting",
    researcherNote: "Do not prefill this note",
    claimRevisionIds: revisionIds,
    synthesisRevisionIds: [],
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function holdSection(projectId: string, manuscriptId: string, sectionId: string, release: Promise<void>) {
  return concurrentSql.begin(async (tx) => {
    await tx`select id from manuscript_sections where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${sectionId} for update`;
    await release;
  });
}

async function lockClaimAndWriteNewRevision(fixture: Fixture, claim: ClaimFixture, release: Promise<void>) {
  return concurrentSql.begin(async (tx) => {
    await tx`select id from claims where project_id=${fixture.projectId} and id=${claim.claimId} for update`;
    const newerRevisionId = uuid();
    await tx`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${newerRevisionId}, ${fixture.projectId}, ${claim.claimId}, 'active', 'Newer Claim')`;
    await tx`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${fixture.projectId}, ${newerRevisionId}, ${claim.evidenceId})`;
    await tx`update claim_revisions set finalized_at=now() where project_id=${fixture.projectId} and id=${newerRevisionId}`;
    await release;
    return newerRevisionId;
  });
}

function sectionItems(view: any, sectionId: string) {
  const section = (view.sections ?? []).find((item: any) => item.id === sectionId);
  return section?.items ?? [];
}

describe("Slice 22 Answer manuscript projection and application", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { await truncate(); });
  afterAll(async () => { await truncate(); await sql.end(); await concurrentSql.end(); await client.end(); });

  it("applies prose plus Claims as one ordered contiguous block and derives placement facts", async () => {
    const fixture = await createFixture();
    const answer = await answerFor(fixture, [fixture.claims[0].revisionId, fixture.claims[1].revisionId]);
    const answerBefore = await services.getResearchQuestionAnswerSnapshot(fixture.projectId, fixture.questionId, answer.id);
    const manuscript = await services.getOrCreateDefaultManuscript(fixture.projectId);
    const section = await services.createSection(fixture.projectId, manuscript.id, { title: "Draft" });
    const existing = await services.createProseBlock(fixture.projectId, manuscript.id, section.id, { text: "Existing" });

    const result = await services.applyResearchQuestionAnswerToSection(
      fixture.projectId,
      fixture.questionId,
      answer.id,
      {
        manuscriptId: manuscript.id,
        sectionId: section.id,
        proseText: "  Researcher prose  ",
        claimRevisionIds: [fixture.claims[1].revisionId, fixture.claims[0].revisionId],
        insertion: { kind: "before", sectionItemId: existing.id },
      },
    );
    expect(result.proseSectionItemId).toBeTruthy();
    expect(result.claimPlacements.map((item: any) => item.claimRevisionId)).toEqual([fixture.claims[1].revisionId, fixture.claims[0].revisionId]);

    const view = await services.getManuscript(fixture.projectId, manuscript.id);
    const items = sectionItems(view, section.id);
    expect(items.map((item: any) => item.itemType ?? item.type)).toEqual(["prose", "claim", "claim", "prose"]);
    expect(items[0].text ?? items[0].proseBlock?.text).toBe("  Researcher prose  ");
    expect(items[1].placement.claimRevisionId).toBe(fixture.claims[1].revisionId);
    expect(items[2].placement.claimRevisionId).toBe(fixture.claims[0].revisionId);
    expect(items[3].id).toBe(existing.id);

    const projection = await services.getResearchQuestionAnswerManuscriptProjection(
      fixture.projectId,
      fixture.questionId,
      answer.id,
      { manuscriptId: manuscript.id, sectionId: section.id },
    );
    expect(projection.researchQuestion.archivedAt).toBeNull();
    expect(projection.answer.answerText).toBe("Exact answer text for drafting");
    expect((projection.answer as any).researcherNote).toBe("Do not prefill this note");
    expect(projection.claimContexts.every((context: any) => context.selectable === false)).toBe(true);
    expect(projection.claimContexts.every((context: any) => context.selectionBlockReason === "already_in_target_section")).toBe(true);
    expect(projection.claimContexts[0].exactActivePlacements).toHaveLength(1);
    expect(projection.claimContexts[0].citationCandidateCount).toBe(1);
    expect(projection.claimContexts[0].supportStatus).toBe("supported");
    await expect(services.getResearchQuestionAnswerSnapshot(fixture.projectId, fixture.questionId, answer.id)).resolves.toEqual(answerBefore);
  });

  it("preserves per-Section duplicate semantics, permits archived RQ drafting, and rejects archived Sections", async () => {
    const fixture = await createFixture(1);
    const answer = await answerFor(fixture);
    const manuscript = await services.getOrCreateDefaultManuscript(fixture.projectId);
    const first = await services.createSection(fixture.projectId, manuscript.id, { title: "First" });
    const second = await services.createSection(fixture.projectId, manuscript.id, { title: "Second" });
    const firstResult = await services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: first.id,
      claimRevisionIds: [fixture.claims[0].revisionId],
      insertion: { kind: "append" },
    });
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: first.id,
      claimRevisionIds: [fixture.claims[0].revisionId],
      insertion: { kind: "append" },
    })).rejects.toMatchObject({ code: "DUPLICATE_LINK" });

    await sql`update research_questions set archived_at = now() where project_id=${fixture.projectId} and id=${fixture.questionId}`;
    const secondResult = await services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: second.id,
      claimRevisionIds: [fixture.claims[0].revisionId],
      insertion: { kind: "append" },
    });
    expect(secondResult.claimPlacements[0].claimRevisionId).toBe(fixture.claims[0].revisionId);

    await services.removeClaimPlacement(fixture.projectId, manuscript.id, firstResult.claimPlacements[0].placementId);
    const projection = await services.getResearchQuestionAnswerManuscriptProjection(fixture.projectId, fixture.questionId, answer.id, { manuscriptId: manuscript.id, sectionId: first.id });
    expect(projection.researchQuestion.archivedAt).not.toBeNull();
    expect(projection.claimContexts[0].historicalPlacements.length).toBeGreaterThanOrEqual(1);

    await services.removeClaimPlacement(fixture.projectId, manuscript.id, secondResult.claimPlacements[0].placementId);
    await services.archiveSection(fixture.projectId, manuscript.id, second.id);
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: second.id,
      claimRevisionIds: [fixture.claims[0].revisionId],
      insertion: { kind: "append" },
    })).rejects.toMatchObject({ code: "INELIGIBLE_REFERENCE" });
  });

  it("rejects superseded exact contexts and validates the whole batch before any Section write", async () => {
    const fixture = await createFixture(2);
    const answer = await answerFor(fixture);
    const manuscript = await services.getOrCreateDefaultManuscript(fixture.projectId);
    const section = await services.createSection(fixture.projectId, manuscript.id, { title: "Atomic" });
    const newerRevisionId = uuid();
    await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${newerRevisionId}, ${fixture.projectId}, ${fixture.claims[1].claimId}, 'active', 'Newer Claim 2')`;
    await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${fixture.projectId}, ${newerRevisionId}, ${fixture.claims[1].evidenceId})`;
    await sql`update claim_revisions set finalized_at=now() where project_id=${fixture.projectId} and id=${newerRevisionId}`;

    const before = await sql`select count(*)::integer as count from manuscript_section_items where project_id=${fixture.projectId} and section_id=${section.id} and removed_at is null`;
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: section.id,
      proseText: "Should not be written",
      claimRevisionIds: [fixture.claims[0].revisionId, fixture.claims[1].revisionId],
      insertion: { kind: "append" },
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const after = await sql`select count(*)::integer as count from manuscript_section_items where project_id=${fixture.projectId} and section_id=${section.id} and removed_at is null`;
    expect(Number(after[0].count)).toBe(Number(before[0].count));
    const projection = await services.getResearchQuestionAnswerManuscriptProjection(fixture.projectId, fixture.questionId, answer.id, { manuscriptId: manuscript.id, sectionId: section.id });
    expect(projection.claimContexts.find((context: any) => context.claimRevisionId === fixture.claims[1].revisionId).selectionBlockReason).toBe("superseded_context");
  });

  it("rejects no-op, duplicate, and non-member inputs without changing the Answer", async () => {
    const fixture = await createFixture(1);
    const answer = await answerFor(fixture);
    const manuscript = await services.getOrCreateDefaultManuscript(fixture.projectId);
    const section = await services.createSection(fixture.projectId, manuscript.id, { title: "Validation" });
    const input = { manuscriptId: manuscript.id, sectionId: section.id, claimRevisionIds: [], insertion: { kind: "append" as const } };
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, { ...input, proseText: " " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, { ...input, claimRevisionIds: [fixture.claims[0].revisionId, fixture.claims[0].revisionId] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, { ...input, claimRevisionIds: [uuid()], proseText: "Invalid" })).rejects.toMatchObject({ code: "INELIGIBLE_REFERENCE" });
    const [stored] = await sql`select answer_text, researcher_note, finalized_at from research_question_answers where project_id=${fixture.projectId} and id=${answer.id}`;
    expect(stored.answer_text).toBe("Exact answer text for drafting");
    expect(stored.researcher_note).toBe("Do not prefill this note");
    expect(stored.finalized_at).not.toBeNull();
  });

  it("observes the Claim currentness race in either commit order and never floats the submitted revision", async () => {
    const fixture = await createFixture(1);
    const answer = await answerFor(fixture);
    const manuscript = await services.getOrCreateDefaultManuscript(fixture.projectId);
    const section = await services.createSection(fixture.projectId, manuscript.id, { title: "Race" });

    // The Section lock holds the application after it has acquired its Claim
    // lock. The revision writer therefore waits, then commits after R1.
    const releaseSection = deferred<void>();
    const sectionHolder = holdSection(fixture.projectId, manuscript.id, section.id, releaseSection.promise);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const answerWins = services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: section.id,
      claimRevisionIds: [fixture.claims[0].revisionId],
      insertion: { kind: "append" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const releaseWriter = deferred<void>();
    const writerAfterAnswer = lockClaimAndWriteNewRevision(fixture, fixture.claims[0], releaseWriter.promise);
    releaseSection.resolve();
    await expect(answerWins).resolves.toMatchObject({ claimPlacements: [{ claimRevisionId: fixture.claims[0].revisionId }] });
    releaseWriter.resolve();
    await writerAfterAnswer;
    await sectionHolder;

    // The revision writer commits first while the application waits for the
    // Claim lock; validation then rejects R1 rather than substituting R2.
    await truncate();
    const secondFixture = await createFixture(1);
    const secondAnswer = await answerFor(secondFixture);
    const secondManuscript = await services.getOrCreateDefaultManuscript(secondFixture.projectId);
    const secondSection = await services.createSection(secondFixture.projectId, secondManuscript.id, { title: "Race rejection" });
    const releaseWriterFirst = deferred<void>();
    const writerBeforeAnswer = lockClaimAndWriteNewRevision(secondFixture, secondFixture.claims[0], releaseWriterFirst.promise);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const answerAfterWriter = services.applyResearchQuestionAnswerToSection(secondFixture.projectId, secondFixture.questionId, secondAnswer.id, {
      manuscriptId: secondManuscript.id,
      sectionId: secondSection.id,
      proseText: "Must not be written",
      claimRevisionIds: [secondFixture.claims[0].revisionId],
      insertion: { kind: "append" },
    });
    releaseWriterFirst.resolve();
    await writerBeforeAnswer;
    await expect(answerAfterWriter).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const [itemCount] = await sql`select count(*)::integer as count from manuscript_section_items where project_id=${secondFixture.projectId} and section_id=${secondSection.id} and removed_at is null`;
    expect(Number(itemCount.count)).toBe(0);
  });

  it("serializes concurrent Section insertions without colliding sort orders", async () => {
    const fixture = await createFixture(2);
    const answer = await answerFor(fixture);
    const manuscript = await services.getOrCreateDefaultManuscript(fixture.projectId);
    const section = await services.createSection(fixture.projectId, manuscript.id, { title: "Concurrent" });
    const first = services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: section.id,
      claimRevisionIds: [fixture.claims[0].revisionId],
      insertion: { kind: "append" },
    });
    const second = services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: section.id,
      claimRevisionIds: [fixture.claims[1].revisionId],
      insertion: { kind: "append" },
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    const itemRows = await sql`select sort_order from manuscript_section_items where project_id=${fixture.projectId} and section_id=${section.id} and removed_at is null order by sort_order, id`;
    expect(itemRows.map((row) => Number(row.sort_order))).toEqual([0, 1]);
  });

  it("allows a Synthesis-only Answer to produce ordinary Prose without support or citation rows", async () => {
    const fixture = await createFixture(0);
    const synthesis = await addSynthesis(fixture);
    const answer = await services.appendResearchQuestionAnswer(fixture.projectId, fixture.questionId, {
      answerText: "Exact synthesis answer text",
      researcherNote: "Never prefill this note",
      claimRevisionIds: [],
      synthesisRevisionIds: [synthesis.revisionId],
    });
    const manuscript = await services.getOrCreateDefaultManuscript(fixture.projectId);
    const section = await services.createSection(fixture.projectId, manuscript.id, { title: "Synthesis prose" });
    const before = await sql`
      select
        (select count(*)::integer from manuscript_claim_placements where project_id=${fixture.projectId}) as placements,
        (select count(*)::integer from claim_revision_evidence_supports where project_id=${fixture.projectId}) as evidence_supports,
        (select count(*)::integer from claim_revision_extraction_supports where project_id=${fixture.projectId}) as extraction_supports,
        (select count(*)::integer from claim_revision_synthesis_supports where project_id=${fixture.projectId}) as synthesis_supports
    `;
    const projection = await services.getResearchQuestionAnswerManuscriptProjection(fixture.projectId, fixture.questionId, answer.id, { manuscriptId: manuscript.id, sectionId: section.id });
    expect(projection.claimContexts).toEqual([]);
    expect(projection.synthesisContexts[0]).toMatchObject({
      synthesisRevisionId: synthesis.revisionId,
      statementText: "Exact synthesis context",
      supportStatus: "supported",
      supportCount: 1,
      interpretation: null,
    });
    await expect(services.applyResearchQuestionAnswerToSection(fixture.projectId, fixture.questionId, answer.id, {
      manuscriptId: manuscript.id,
      sectionId: section.id,
      proseText: "Researcher-edited prose from synthesis context",
      claimRevisionIds: [],
      insertion: { kind: "append" },
    })).resolves.toMatchObject({ claimPlacements: [], proseSectionItemId: expect.any(String) });
    const view = await services.getManuscript(fixture.projectId, manuscript.id);
    expect(sectionItems(view, section.id).map((item: any) => item.itemType ?? item.type)).toEqual(["prose"]);
    const after = await sql`
      select
        (select count(*)::integer from manuscript_claim_placements where project_id=${fixture.projectId}) as placements,
        (select count(*)::integer from claim_revision_evidence_supports where project_id=${fixture.projectId}) as evidence_supports,
        (select count(*)::integer from claim_revision_extraction_supports where project_id=${fixture.projectId}) as extraction_supports,
        (select count(*)::integer from claim_revision_synthesis_supports where project_id=${fixture.projectId}) as synthesis_supports
    `;
    expect(after).toEqual(before);
  });
});
