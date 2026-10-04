import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  synthesisInterpretationLimitations,
  synthesisInterpretationQuestions,
  synthesisInterpretationContradictions,
} from "@/db/schema";
import { DomainError } from "@/domain/errors";
import type {
  ConvergenceState,
  SynthesisInterpretationContradictionView,
  SynthesisInterpretationLimitation,
  SynthesisInterpretationQuestion,
  SynthesisInterpretationSnapshotView,
  SynthesisRevisionView,
  SynthesisSupport,
} from "@/domain/types";
import { ensureId } from "@/application/review-services/shared";
import type { CurrentSynthesisInterpretationSummary } from "./claim-synthesis-history-read-types";

type DecimalSequence<T extends { sequence: number }> = Omit<T, "sequence"> & { sequence: string };
type RouteSupport = Omit<SynthesisSupport, "extractionRevision"> & {
  extractionRevision: DecimalSequence<SynthesisSupport["extractionRevision"]>;
};
type RouteContradiction = Omit<SynthesisInterpretationContradictionView, "leftSupport" | "rightSupport"> & {
  leftSupport: RouteSupport | null;
  rightSupport: RouteSupport | null;
};

export type SynthesisInterpretationCurrentRouteSnapshot = Omit<SynthesisInterpretationSnapshotView, "sequence" | "contradictions"> & {
  sequence: string;
  contradictions: RouteContradiction[];
};

export interface SynthesisInterpretationCurrentReadDependencies {
  getSynthesisProvenance: (projectId: string, statementId: string, revisionId?: string) => Promise<SynthesisRevisionView>;
}

type RawRow = Record<string, unknown>;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function mapLimitation(row: typeof synthesisInterpretationLimitations.$inferSelect): SynthesisInterpretationLimitation {
  return {
    id: row.id,
    projectId: row.projectId,
    interpretationId: row.interpretationId,
    sortOrder: row.sortOrder,
    category: row.category as SynthesisInterpretationLimitation["category"],
    body: row.body,
    createdAt: row.createdAt,
  };
}

function mapQuestion(row: typeof synthesisInterpretationQuestions.$inferSelect): SynthesisInterpretationQuestion {
  return {
    id: row.id,
    projectId: row.projectId,
    interpretationId: row.interpretationId,
    sortOrder: row.sortOrder,
    body: row.body,
    createdAt: row.createdAt,
  };
}

function mapContradiction(row: typeof synthesisInterpretationContradictions.$inferSelect): SynthesisInterpretationContradictionView {
  return {
    id: row.id,
    projectId: row.projectId,
    interpretationId: row.interpretationId,
    synthesisRevisionId: row.synthesisRevisionId,
    sortOrder: row.sortOrder,
    leftExtractionRevisionId: row.leftExtractionRevisionId,
    rightExtractionRevisionId: row.rightExtractionRevisionId,
    note: row.note,
    createdAt: row.createdAt,
    leftSupport: null,
    rightSupport: null,
  };
}

function routeSupport(support: SynthesisSupport, sequences: Record<string, string>): RouteSupport {
  const sequence = sequences[support.extractionRevisionId];
  if (sequence === undefined) throw new DomainError("DATABASE_CONSTRAINT", "Exact interpretation support sequence is missing");
  return {
    ...support,
    extractionRevision: { ...support.extractionRevision, sequence },
  };
}

export function createSynthesisInterpretationCurrentReadServices(
  db: Database,
  dependencies: SynthesisInterpretationCurrentReadDependencies,
) {
  return {
    async getCurrentSynthesisInterpretationSummary(
      projectId: string,
      statementId: string,
      revisionId: string,
    ): Promise<CurrentSynthesisInterpretationSummary | null> {
      const project = ensureId(projectId).toLowerCase();
      const statement = ensureId(statementId).toLowerCase();
      const revision = ensureId(revisionId).toLowerCase();
      const result = rows(await db.execute(sql`
        select i.id, i.sequence::text as sequence, i.convergence_state,
          i.summary, i.researcher_note, i.finalized_at
        from projects p
        join synthesis_statements s on s.project_id=p.id and s.id=${statement}::uuid
        join synthesis_revisions r on r.project_id=s.project_id and r.synthesis_statement_id=s.id
          and r.id=${revision}::uuid and r.finalized_at is not null
        join synthesis_interpretations i on i.project_id=r.project_id
          and i.synthesis_statement_id=r.synthesis_statement_id and i.synthesis_revision_id=r.id
          and i.finalized_at is not null
        where p.id=${project}::uuid
        order by i.sequence desc
        limit 1
      `));
      const row = result[0];
      return row ? {
        id: String(row.id),
        sequence: String(row.sequence),
        convergenceState: String(row.convergence_state) as CurrentSynthesisInterpretationSummary["convergenceState"],
        summary: String(row.summary),
        researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
        finalizedAt: date(row.finalized_at),
      } : null;
    },

    async getCurrentSynthesisInterpretationSnapshot(
      projectId: string,
      statementId: string,
      revisionId: string,
      revisionSnapshot: SynthesisRevisionView | undefined,
      requestedInterpretationId: string | undefined,
      extractionRevisionSequences: Record<string, string>,
    ): Promise<SynthesisInterpretationCurrentRouteSnapshot | null> {
      const project = ensureId(projectId).toLowerCase();
      const statement = ensureId(statementId).toLowerCase();
      const revisionIdValue = ensureId(revisionId).toLowerCase();
      const requestedId = requestedInterpretationId === undefined ? undefined : ensureId(requestedInterpretationId).toLowerCase();
      const revision = revisionSnapshot ?? await dependencies.getSynthesisProvenance(project, statement, revisionIdValue);
      if (revision.id !== revisionIdValue || revision.synthesisStatementId !== statement || revision.projectId !== project) {
        throw new DomainError("NOT_FOUND", "Synthesis revision was not found");
      }
      const result = rows(await db.execute(sql`
        select i.id, i.sequence::text as sequence, i.project_id, i.synthesis_statement_id,
          i.synthesis_revision_id, i.convergence_state, i.summary, i.researcher_note,
          i.created_at, i.finalized_at
        from synthesis_interpretations i
        join synthesis_revisions r on r.project_id=i.project_id
          and r.synthesis_statement_id=i.synthesis_statement_id and r.id=i.synthesis_revision_id
          and r.finalized_at is not null
        where i.project_id=${project}::uuid and i.synthesis_statement_id=${statement}::uuid
          and i.synthesis_revision_id=${revisionIdValue}::uuid and i.finalized_at is not null
          ${requestedId === undefined ? sql`` : sql`and i.id=${requestedId}::uuid`}
        order by i.sequence desc
        limit 1
      `));
      const row = result[0];
      if (!row) return null;
      const interpretationId = String(row.id);
      const [limitations, questions, contradictions] = await Promise.all([
        db.select().from(synthesisInterpretationLimitations)
          .where(and(eq(synthesisInterpretationLimitations.projectId, project), eq(synthesisInterpretationLimitations.interpretationId, interpretationId)))
          .orderBy(synthesisInterpretationLimitations.sortOrder),
        db.select().from(synthesisInterpretationQuestions)
          .where(and(eq(synthesisInterpretationQuestions.projectId, project), eq(synthesisInterpretationQuestions.interpretationId, interpretationId)))
          .orderBy(synthesisInterpretationQuestions.sortOrder),
        db.select().from(synthesisInterpretationContradictions)
          .where(and(eq(synthesisInterpretationContradictions.projectId, project), eq(synthesisInterpretationContradictions.interpretationId, interpretationId)))
          .orderBy(synthesisInterpretationContradictions.sortOrder),
      ]);
      const supports = Object.fromEntries(revision.supports.map((support) => [support.extractionRevisionId, routeSupport(support, extractionRevisionSequences)]));
      return {
        id: interpretationId,
        sequence: String(row.sequence),
        projectId: String(row.project_id),
        synthesisStatementId: String(row.synthesis_statement_id),
        synthesisRevisionId: String(row.synthesis_revision_id),
        convergenceState: String(row.convergence_state) as ConvergenceState,
        summary: String(row.summary),
        researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
        createdAt: date(row.created_at),
        finalizedAt: date(row.finalized_at),
        limitations: limitations.map(mapLimitation),
        questions: questions.map(mapQuestion),
        contradictions: contradictions.map((row) => {
          const pair = mapContradiction(row);
          return {
            ...pair,
            leftSupport: supports[pair.leftExtractionRevisionId] ?? null,
            rightSupport: supports[pair.rightExtractionRevisionId] ?? null,
          };
        }),
      };
    },
  };
}
