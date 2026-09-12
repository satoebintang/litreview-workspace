import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "@/db/client";
import {
  createResearchQuestionAnswerWriteServices,
  type AnswerClaimRevisionResolution,
} from "@/application/research-question-answer-write-services";
import type { DbOrTx } from "@/application/research-question-traceability-repository";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(databaseUrl);
const sql = postgres(databaseUrl, { prepare: false });

type Fixture = {
  projectId: string;
  questionId: string;
  paperId: string;
  evidenceId: string;
  claimId: string;
  revisionId: string;
};

const uuid = () => crypto.randomUUID();

function rows(result: unknown): Record<string, unknown>[] {
  return result as Record<string, unknown>[];
}

/**
 * Test-only adapter for the released Claim support contract.  Production
 * composition injects the canonical resolver; this fixture calculates the
 * same three typed support counts only to exercise the write boundary.
 */
async function resolveClaimRevision(
  projectId: string,
  revisionId: string,
  tx: DbOrTx,
): Promise<AnswerClaimRevisionResolution | null> {
  const revisionRows = rows(await tx.execute(drizzleSql`
    select id, sequence, project_id, claim_id, state, finalized_at
    from claim_revisions
    where project_id = ${projectId}
      and id = ${revisionId}
  `));
  const revision = revisionRows[0];
  if (!revision) return null;

  const currentRows = rows(await tx.execute(drizzleSql`
    select id, sequence, state
    from claim_revisions
    where project_id = ${projectId}
      and claim_id = ${revision.claim_id}
      and finalized_at is not null
    order by sequence desc
    limit 1
  `));
  const supportRows = rows(await tx.execute(drizzleSql`
    select (
      (select count(*) from claim_revision_evidence_supports
       where project_id = ${projectId} and claim_revision_id = ${revisionId})
      + (select count(*) from claim_revision_extraction_supports
       where project_id = ${projectId} and claim_revision_id = ${revisionId})
      + (select count(*) from claim_revision_synthesis_supports
       where project_id = ${projectId} and claim_revision_id = ${revisionId})
    )::integer as support_count
  `));
  const current = currentRows[0];
  const supportCount = Number(supportRows[0]?.support_count ?? 0);
  return {
    projectId: String(revision.project_id),
    claimId: String(revision.claim_id),
    revisionId: String(revision.id),
    sequence: Number(revision.sequence),
    state: String(revision.state),
    finalizedAt: revision.finalized_at as Date | null,
    currentRevisionId: current ? String(current.id) : null,
    currentRevisionSequence: current ? Number(current.sequence) : null,
    currentRevisionState: current ? String(current.state) : null,
    supportStatus: supportCount > 0 && String(revision.state) === "active" ? "supported" : "unsupported",
    supportCount,
  };
}

async function createFixture({ supported = true } = {}): Promise<Fixture> {
  const fixture: Fixture = {
    projectId: uuid(),
    questionId: uuid(),
    paperId: uuid(),
    evidenceId: uuid(),
    claimId: uuid(),
    revisionId: uuid(),
  };
  await sql`insert into projects (id, title) values (${fixture.projectId}, 'Slice 21 write test')`;
  await sql`insert into research_questions (id, project_id, identifier, label) values (${fixture.questionId}, ${fixture.projectId}, 'RQ1', 'Question')`;
  await sql`insert into papers (id, project_id, title) values (${fixture.paperId}, ${fixture.projectId}, 'Paper')`;
  await sql`insert into evidence (id, project_id, paper_id, source_text, page_number) values (${fixture.evidenceId}, ${fixture.projectId}, ${fixture.paperId}, 'Quoted source', 1)`;
  await sql`insert into claims (id, project_id) values (${fixture.claimId}, ${fixture.projectId})`;
  await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${fixture.revisionId}, ${fixture.projectId}, ${fixture.claimId}, 'active', 'A supported claim')`;
  if (supported) {
    await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${fixture.projectId}, ${fixture.revisionId}, ${fixture.evidenceId})`;
  }
  await sql`update claim_revisions set finalized_at = now() where project_id = ${fixture.projectId} and id = ${fixture.revisionId}`;
  await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'linked')`;
  return fixture;
}

async function append(fixture: Fixture, claimRevisionIds = [fixture.revisionId]) {
  const services = createResearchQuestionAnswerWriteServices(db, { claimRevisionResolver: resolveClaimRevision });
  return services.appendResearchQuestionAnswer(fixture.projectId, fixture.questionId, {
    answerText: "The researcher-authored answer",
    researcherNote: "Reviewed",
    claimRevisionIds,
    synthesisRevisionIds: [],
  });
}

async function truncate() {
  await sql.unsafe("TRUNCATE TABLE research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_claim_events, claim_revision_evidence_supports, claim_revision_extraction_supports, claim_revision_synthesis_supports, claim_revisions, claims, evidence, papers, research_questions, projects CASCADE");
}

describe("Slice 21 Answer write boundary", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    await truncate();
  });

  afterAll(async () => {
    await truncate();
    await sql.end();
    await client.end();
  });

  it("uses latest-event-first links and leaves formal support unchanged", async () => {
    const fixture = await createFixture();
    const [before] = await sql`select count(*)::integer as count from claim_revision_evidence_supports where project_id = ${fixture.projectId} and claim_revision_id = ${fixture.revisionId}`;

    const answer = await append(fixture);
    expect(answer.finalizedAt).not.toBeNull();
    const [context] = await sql`select claim_revision_id from research_question_answer_claim_contexts where project_id = ${fixture.projectId} and answer_id = ${answer.id}`;
    expect(String(context.claim_revision_id)).toBe(fixture.revisionId);

    const [after] = await sql`select count(*)::integer as count from claim_revision_evidence_supports where project_id = ${fixture.projectId} and claim_revision_id = ${fixture.revisionId}`;
    expect(Number(after.count)).toBe(Number(before.count));

    await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'unlinked')`;
    await expect(append(fixture)).rejects.toMatchObject({ code: "INELIGIBLE_REFERENCE" });
    await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'linked')`;
    await expect(append(fixture)).resolves.toMatchObject({ finalizedAt: expect.any(Date) });
  });

  it("rejects unsupported current Claims and exact revisions that lost the current race", async () => {
    const unsupported = await createFixture({ supported: false });
    await expect(append(unsupported)).rejects.toMatchObject({ code: "INELIGIBLE_REFERENCE" });

    await truncate();
    const fixture = await createFixture();
    const newerRevisionId = uuid();
    await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${newerRevisionId}, ${fixture.projectId}, ${fixture.claimId}, 'active', 'Newer claim')`;
    await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${fixture.projectId}, ${newerRevisionId}, ${fixture.evidenceId})`;
    await sql`update claim_revisions set finalized_at = now() where project_id = ${fixture.projectId} and id = ${newerRevisionId}`;

    await expect(append(fixture)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const [answers] = await sql`select count(*)::integer as count from research_question_answers where project_id = ${fixture.projectId}`;
    expect(Number(answers.count)).toBe(0);
  });

  it("rejects zero contexts, archived questions, and cross-project exact IDs", async () => {
    const fixture = await createFixture();
    const services = createResearchQuestionAnswerWriteServices(db, { claimRevisionResolver: resolveClaimRevision });
    await expect(services.appendResearchQuestionAnswer(fixture.projectId, fixture.questionId, {
      answerText: "No context",
      claimRevisionIds: [],
      synthesisRevisionIds: [],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const foreign = await createFixture();
    await expect(services.appendResearchQuestionAnswer(fixture.projectId, fixture.questionId, {
      answerText: "Foreign context",
      claimRevisionIds: [foreign.revisionId],
      synthesisRevisionIds: [],
    })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });

    await sql`update research_questions set archived_at = now() where project_id = ${fixture.projectId} and id = ${fixture.questionId}`;
    await expect(append(fixture)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps the finalized Answer and exact typed contexts immutable", async () => {
    const fixture = await createFixture();
    const answer = await append(fixture);
    await expect(sql`update research_question_answers set answer_text = 'changed' where project_id = ${fixture.projectId} and id = ${answer.id}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from research_question_answer_claim_contexts where project_id = ${fixture.projectId} and answer_id = ${answer.id}`).rejects.toThrow(/immutable/);
  });
});
