import "dotenv/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "@/db/client";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(databaseUrl);
const sql = postgres(databaseUrl, { prepare: false });

type ClaimFixture = {
  projectId: string;
  questionId: string;
  paperId: string;
  evidenceId: string;
  claimId: string;
  revisionId: string;
};

const uuid = () => crypto.randomUUID();

async function createClaimFixture({ supported = true } = {}): Promise<ClaimFixture> {
  const fixture: ClaimFixture = {
    projectId: uuid(),
    questionId: uuid(),
    paperId: uuid(),
    evidenceId: uuid(),
    claimId: uuid(),
    revisionId: uuid(),
  };
  await sql`insert into projects (id, title) values (${fixture.projectId}, 'Slice 21 DB test')`;
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

async function finalizeClaimAnswer(fixture: ClaimFixture, answerId = uuid(), revisionId = fixture.revisionId) {
  await sql.begin(async (tx) => {
    await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${answerId}, ${fixture.projectId}, ${fixture.questionId}, 'The answer')`;
    await tx`insert into research_question_answer_claim_contexts (project_id, research_question_id, answer_id, claim_id, claim_revision_id, sort_order) values (${fixture.projectId}, ${fixture.questionId}, ${answerId}, ${fixture.claimId}, ${revisionId}, 0)`;
    await tx`update research_question_answers set finalized_at = now() where project_id = ${fixture.projectId} and id = ${answerId}`;
  });
  return answerId;
}

async function cleanupFixture(fixture: ClaimFixture) {
  // These are append-only histories, so row DELETEs intentionally fail.  The
  // integration database is disposable and file-parallelism is disabled;
  // truncate the fixture graph between cases to exercise each invariant from
  // a clean migration state without weakening production triggers.
  void fixture;
  await sql.unsafe("TRUNCATE TABLE research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_claim_events, claim_revision_evidence_supports, claim_revision_extraction_supports, claim_revision_synthesis_supports, claim_revisions, claims, evidence, papers, research_questions, projects CASCADE");
}

let fixture: ClaimFixture;

describe("Slice 21 Research Question Answer database invariants", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    fixture = await createClaimFixture();
  });

  afterEach(async () => {
    await cleanupFixture(fixture);
  });

  afterAll(async () => {
    await sql.end();
    await client.end();
  });

  it("finalizes a supported exact current ClaimRevision and preserves the snapshot", async () => {
    const answerId = await finalizeClaimAnswer(fixture);
    const [row] = await sql`select answer_text, finalized_at from research_question_answers where project_id = ${fixture.projectId} and id = ${answerId}`;
    expect(row.answer_text).toBe("The answer");
    expect(row.finalized_at).not.toBeNull();
  });

  it("uses latest-event-first link semantics for unlink and relink", async () => {
    await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'unlinked')`;
    await expect(finalizeClaimAnswer(fixture)).rejects.toThrow(/not currently linked/);

    await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${fixture.projectId}, ${fixture.questionId}, ${fixture.claimId}, 'linked')`;
    await expect(finalizeClaimAnswer(fixture)).resolves.toBeDefined();
  });

  it("rejects zero-context finalization and unsupported current Claims", async () => {
    const draftAnswerId = uuid();
    await expect(sql`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${draftAnswerId}, ${fixture.projectId}, ${fixture.questionId}, 'Draft only')`).rejects.toThrow(/Draft Research Question Answers cannot survive/);

    const answerId = uuid();
    await expect(sql.begin(async (tx) => {
      await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text) values (${answerId}, ${fixture.projectId}, ${fixture.questionId}, 'No context')`;
      await tx`update research_question_answers set finalized_at = now() where project_id = ${fixture.projectId} and id = ${answerId}`;
    })).rejects.toThrow(/at least one context/);

    const unsupported = await createClaimFixture({ supported: false });
    try {
      await expect(finalizeClaimAnswer(unsupported)).rejects.toThrow(/not currently linked/);
    } finally {
      await cleanupFixture(unsupported);
    }
  });

  it("rejects a submitted ClaimRevision after a newer finalized revision wins", async () => {
    const newerRevisionId = uuid();
    await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${newerRevisionId}, ${fixture.projectId}, ${fixture.claimId}, 'active', 'Newer claim')`;
    await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${fixture.projectId}, ${newerRevisionId}, ${fixture.evidenceId})`;
    await sql`update claim_revisions set finalized_at = now() where project_id = ${fixture.projectId} and id = ${newerRevisionId}`;

    await expect(finalizeClaimAnswer(fixture)).rejects.toThrow(/not currently linked/);
  });

  it("keeps finalized Answer and contexts immutable", async () => {
    const answerId = await finalizeClaimAnswer(fixture);
    await expect(sql`update research_question_answers set answer_text = 'retargeted' where project_id = ${fixture.projectId} and id = ${answerId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from research_question_answers where project_id = ${fixture.projectId} and id = ${answerId}`).rejects.toThrow(/append-only|immutable/);
    await expect(sql`update research_question_answer_claim_contexts set sort_order = 1 where project_id = ${fixture.projectId} and answer_id = ${answerId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from research_question_answer_claim_contexts where project_id = ${fixture.projectId} and answer_id = ${answerId}`).rejects.toThrow(/immutable/);
  });
});
