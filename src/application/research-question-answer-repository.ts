import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import type {
  ResearchQuestionAnswer,
  ResearchQuestionAnswerClaimContext,
  ResearchQuestionAnswerSynthesisContext,
} from "@/domain/types";
import type { DbTransaction } from "./research-question-traceability-repository";

/** A row returned by postgres-js for the Answer tables. */
export type AnswerDbRow = Record<string, unknown>;

/**
 * The stable-parent/revision metadata required by the write service.  Support
 * status is deliberately absent: the canonical Claim/Synthesis resolvers own
 * those definitions and are injected by the composition root.
 */
export interface AnswerClaimRevisionMetadata {
  id: string;
  projectId: string;
  claimId: string;
  sequence: number;
  state: string;
  finalizedAt: Date | null;
}

export interface AnswerSynthesisRevisionMetadata {
  id: string;
  projectId: string;
  synthesisStatementId: string;
  sequence: number;
  state: string;
  finalizedAt: Date | null;
}

export interface LockedResearchQuestion {
  id: string;
  projectId: string;
  archivedAt: Date | null;
}

function rows(result: unknown): AnswerDbRow[] {
  return result as AnswerDbRow[];
}

function date(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return new Date(value.getTime());
  return new Date(value as string | number);
}

function requiredDate(value: unknown): Date {
  const parsed = date(value);
  if (!parsed) throw new Error("Answer persistence returned a null timestamp");
  return parsed;
}

function mapAnswer(row: AnswerDbRow): ResearchQuestionAnswer {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    researchQuestionId: String(row.research_question_id),
    answerText: String(row.answer_text),
    researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
    createdAt: requiredDate(row.created_at),
    finalizedAt: date(row.finalized_at),
  };
}

function mapClaimRevision(row: AnswerDbRow): AnswerClaimRevisionMetadata {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    claimId: String(row.claim_id),
    sequence: Number(row.sequence),
    state: String(row.state),
    finalizedAt: date(row.finalized_at),
  };
}

function mapSynthesisRevision(row: AnswerDbRow): AnswerSynthesisRevisionMetadata {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    synthesisStatementId: String(row.synthesis_statement_id),
    sequence: Number(row.sequence),
    state: String(row.state),
    finalizedAt: date(row.finalized_at),
  };
}

function mapClaimContext(row: AnswerDbRow): ResearchQuestionAnswerClaimContext {
  return {
    projectId: String(row.project_id),
    researchQuestionId: String(row.research_question_id),
    answerId: String(row.answer_id),
    claimId: String(row.claim_id),
    claimRevisionId: String(row.claim_revision_id),
    sortOrder: Number(row.sort_order),
    createdAt: requiredDate(row.created_at),
  };
}

function mapSynthesisContext(row: AnswerDbRow): ResearchQuestionAnswerSynthesisContext {
  return {
    projectId: String(row.project_id),
    researchQuestionId: String(row.research_question_id),
    answerId: String(row.answer_id),
    synthesisStatementId: String(row.synthesis_statement_id),
    synthesisRevisionId: String(row.synthesis_revision_id),
    sortOrder: Number(row.sort_order),
    createdAt: requiredDate(row.created_at),
  };
}

/**
 * Persistence for the append-only Research Question Answer snapshot.
 *
 * This repository intentionally does not expose update/delete operations.
 * Construction uses a database-only draft row, typed child rows, and one
 * finalization update; the migration's triggers enforce the same boundary for
 * direct SQL callers.
 */
export class ResearchQuestionAnswerRepository {
  constructor(private readonly db: Database) {}

  async lockResearchQuestion(
    tx: DbTransaction,
    projectId: string,
    researchQuestionId: string,
  ): Promise<LockedResearchQuestion | null> {
    const result = await tx.execute(sql`
      select id, project_id, archived_at
      from research_questions
      where project_id = ${projectId}
        and id = ${researchQuestionId}
      for update
    `);
    const row = rows(result)[0];
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      archivedAt: date(row.archived_at),
    };
  }

  /**
   * Read exact submitted ClaimRevision identities before stable-parent locks.
   * The query is project-scoped; a missing row is intentionally reported to
   * the service as a cross-project/missing reference rather than floated to a
   * different revision.
   */
  async findClaimRevisionMetadata(
    tx: DbTransaction,
    projectId: string,
    revisionIds: string[],
  ): Promise<AnswerClaimRevisionMetadata[]> {
    if (!revisionIds.length) return [];
    const result = await tx.execute(sql`
      select id, project_id, claim_id, sequence, state, finalized_at
      from claim_revisions
      where project_id = ${projectId}
        and id in (${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by claim_id, id
    `);
    return rows(result).map(mapClaimRevision);
  }

  async findSynthesisRevisionMetadata(
    tx: DbTransaction,
    projectId: string,
    revisionIds: string[],
  ): Promise<AnswerSynthesisRevisionMetadata[]> {
    if (!revisionIds.length) return [];
    const result = await tx.execute(sql`
      select id, project_id, synthesis_statement_id, sequence, state, finalized_at
      from synthesis_revisions
      where project_id = ${projectId}
        and id in (${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by synthesis_statement_id, id
    `);
    return rows(result).map(mapSynthesisRevision);
  }

  /** Lock selected stable Claim parents in deterministic UUID order. */
  async lockClaimsForUpdate(
    tx: DbTransaction,
    projectId: string,
    claimIds: string[],
  ): Promise<string[]> {
    const ids = [...new Set(claimIds)].sort();
    if (!ids.length) return [];
    const result = await tx.execute(sql`
      select id
      from claims
      where project_id = ${projectId}
        and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      order by id
      for update
    `);
    return rows(result).map((row) => String(row.id));
  }

  /** Lock selected stable SynthesisStatement parents in deterministic UUID order. */
  async lockSynthesisStatementsForUpdate(
    tx: DbTransaction,
    projectId: string,
    statementIds: string[],
  ): Promise<string[]> {
    const ids = [...new Set(statementIds)].sort();
    if (!ids.length) return [];
    const result = await tx.execute(sql`
      select id
      from synthesis_statements
      where project_id = ${projectId}
        and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      order by id
      for update
    `);
    return rows(result).map((row) => String(row.id));
  }

  async insertDraft(
    tx: DbTransaction,
    values: {
      projectId: string;
      researchQuestionId: string;
      answerText: string;
      researcherNote: string | null;
    },
  ): Promise<ResearchQuestionAnswer | null> {
    const result = await tx.execute(sql`
      insert into research_question_answers
        (project_id, research_question_id, answer_text, researcher_note)
      values
        (${values.projectId}, ${values.researchQuestionId}, ${values.answerText}, ${values.researcherNote})
      returning id, sequence, project_id, research_question_id, answer_text,
        researcher_note, created_at, finalized_at
    `);
    const row = rows(result)[0];
    return row ? mapAnswer(row) : null;
  }

  async insertClaimContexts(
    tx: DbTransaction,
    values: Array<{
      projectId: string;
      researchQuestionId: string;
      answerId: string;
      claimId: string;
      claimRevisionId: string;
      sortOrder: number;
    }>,
  ): Promise<ResearchQuestionAnswerClaimContext[]> {
    if (!values.length) return [];
    const result = await tx.execute(sql`
      insert into research_question_answer_claim_contexts
        (project_id, research_question_id, answer_id, claim_id, claim_revision_id, sort_order)
      values ${sql.join(values.map((value) => sql`(
        ${value.projectId}, ${value.researchQuestionId}, ${value.answerId},
        ${value.claimId}, ${value.claimRevisionId}, ${value.sortOrder}
      )`), sql`, `)}
      returning project_id, research_question_id, answer_id, claim_id,
        claim_revision_id, sort_order, created_at
    `);
    return rows(result).map(mapClaimContext);
  }

  async insertSynthesisContexts(
    tx: DbTransaction,
    values: Array<{
      projectId: string;
      researchQuestionId: string;
      answerId: string;
      synthesisStatementId: string;
      synthesisRevisionId: string;
      sortOrder: number;
    }>,
  ): Promise<ResearchQuestionAnswerSynthesisContext[]> {
    if (!values.length) return [];
    const result = await tx.execute(sql`
      insert into research_question_answer_synthesis_contexts
        (project_id, research_question_id, answer_id, synthesis_statement_id,
         synthesis_revision_id, sort_order)
      values ${sql.join(values.map((value) => sql`(
        ${value.projectId}, ${value.researchQuestionId}, ${value.answerId},
        ${value.synthesisStatementId}, ${value.synthesisRevisionId}, ${value.sortOrder}
      )`), sql`, `)}
      returning project_id, research_question_id, answer_id, synthesis_statement_id,
        synthesis_revision_id, sort_order, created_at
    `);
    return rows(result).map(mapSynthesisContext);
  }

  async finalize(
    tx: DbTransaction,
    projectId: string,
    answerId: string,
  ): Promise<ResearchQuestionAnswer | null> {
    const result = await tx.execute(sql`
      update research_question_answers
      set finalized_at = coalesce(finalized_at, now())
      where project_id = ${projectId}
        and id = ${answerId}
        and finalized_at is null
      returning id, sequence, project_id, research_question_id, answer_text,
        researcher_note, created_at, finalized_at
    `);
    const row = rows(result)[0];
    return row ? mapAnswer(row) : null;
  }
}
