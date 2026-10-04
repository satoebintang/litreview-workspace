import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { ensureId } from "@/application/review-services/shared";

export type ExactInterpretationSupportSummary = {
  id: string;
  sequence: string;
  valueState: string;
  textValue: string | null;
  numberValue: string | null;
  booleanValue: boolean | null;
  optionId: string | null;
  optionLabel: string | null;
  paperTitle: string;
  fieldName: string;
  isCurrentExtractionRevision: boolean;
};

export type ExactInterpretationSnapshot = {
  id: string;
  sequence: string;
  projectId: string;
  statementId: string;
  revisionId: string;
  convergenceState: "convergent" | "mixed" | "contradictory" | "inconclusive";
  summary: string;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date;
  isCurrent: boolean;
  limitations: Array<{ id: string; sortOrder: number; category: string; body: string; createdAt: Date }>;
  questions: Array<{ id: string; sortOrder: number; body: string; createdAt: Date }>;
  contradictions: Array<{
    id: string;
    sortOrder: number;
    leftExtractionRevisionId: string;
    rightExtractionRevisionId: string;
    note: string | null;
    createdAt: Date;
    leftSupport: ExactInterpretationSupportSummary | null;
    rightSupport: ExactInterpretationSupportSummary | null;
  }>;
};

type RawRow = Record<string, unknown>;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function exactSupportQuery(projectId: string, statementId: string, revisionId: string, extractionRevisionIds: string[]) {
  const ids = sql.join(extractionRevisionIds.map((id) => sql`${id}::uuid`), sql`, `);
  return sql`
    select x.id, x.sequence::text as sequence, x.value_state, x.text_value, x.number_value,
      x.boolean_value, x.option_id, o.label as option_label, p.title as paper_title,
      f.name as field_name,
      not exists (
        select 1 from extraction_value_revisions newer
        where newer.project_id=x.project_id and newer.extraction_value_id=x.extraction_value_id
          and newer.finalized_at is not null and newer.sequence > x.sequence
      ) as is_current_extraction_revision
    from synthesis_revision_supports support
    join extraction_value_revisions x on x.project_id=support.project_id and x.id=support.extraction_revision_id
    join papers p on p.project_id=x.project_id and p.id=x.paper_id
    join extraction_fields f on f.project_id=x.project_id and f.id=x.field_id
    left join extraction_options o on o.project_id=x.project_id and o.field_id=x.field_id and o.id=x.option_id
    where support.project_id=${projectId}::uuid
      and support.synthesis_revision_id=${revisionId}::uuid
      and support.extraction_revision_id in (${ids})
      and exists (
        select 1 from synthesis_statements s
        join synthesis_revisions r on r.project_id=s.project_id and r.synthesis_statement_id=s.id
          and r.id=support.synthesis_revision_id and r.finalized_at is not null
        where s.project_id=${projectId}::uuid and s.id=${statementId}::uuid
      )
    order by support.created_at asc, x.id asc
  `;
}

export function createSynthesisInterpretationExactReadServices(db: Database) {
  return {
    async getExactSynthesisInterpretation(
      projectId: string,
      statementId: string,
      revisionId: string,
      interpretationId: string,
    ): Promise<ExactInterpretationSnapshot> {
      const scope = {
        projectId: ensureId(projectId).toLowerCase(),
        statementId: ensureId(statementId).toLowerCase(),
        revisionId: ensureId(revisionId).toLowerCase(),
        interpretationId: ensureId(interpretationId).toLowerCase(),
      };
      const headerRows = rows(await db.execute(sql`
        select i.id, i.sequence::text as sequence, i.project_id, i.synthesis_statement_id,
          i.synthesis_revision_id, i.convergence_state, i.summary, i.researcher_note,
          i.created_at, i.finalized_at, latest.id as current_interpretation_id
        from projects p
        join synthesis_statements s on s.project_id=p.id and s.id=${scope.statementId}::uuid
        join synthesis_revisions r on r.project_id=s.project_id and r.synthesis_statement_id=s.id
          and r.id=${scope.revisionId}::uuid and r.finalized_at is not null
        join synthesis_interpretations i on i.project_id=r.project_id
          and i.synthesis_statement_id=r.synthesis_statement_id and i.synthesis_revision_id=r.id
          and i.id=${scope.interpretationId}::uuid and i.finalized_at is not null
        left join lateral (
          select current_i.id
          from synthesis_interpretations current_i
          where current_i.project_id=r.project_id
            and current_i.synthesis_statement_id=r.synthesis_statement_id
            and current_i.synthesis_revision_id=r.id
            and current_i.finalized_at is not null
          order by current_i.sequence desc
          limit 1
        ) latest on true
        where p.id=${scope.projectId}::uuid
        limit 1
      `));
      const header = headerRows[0];
      if (!header) throw new DomainError("NOT_FOUND", "Synthesis interpretation snapshot was not found");
      const [limitationRows, questionRows, contradictionRows] = await Promise.all([
        db.execute(sql`select id, sort_order, category, body, created_at
          from synthesis_interpretation_limitations
          where project_id=${scope.projectId}::uuid and interpretation_id=${scope.interpretationId}::uuid
          order by sort_order asc`),
        db.execute(sql`select id, sort_order, body, created_at
          from synthesis_interpretation_questions
          where project_id=${scope.projectId}::uuid and interpretation_id=${scope.interpretationId}::uuid
          order by sort_order asc`),
        db.execute(sql`select id, sort_order, left_extraction_revision_id, right_extraction_revision_id,
            note, created_at
          from synthesis_interpretation_contradictions
          where project_id=${scope.projectId}::uuid and interpretation_id=${scope.interpretationId}::uuid
          order by sort_order asc`),
      ]);
      const limitations = rows(limitationRows);
      const questions = rows(questionRows);
      const contradictions = rows(contradictionRows);
      const supportIds = [...new Set(contradictions.flatMap((row) => [
        String(row.left_extraction_revision_id), String(row.right_extraction_revision_id),
      ]))];
      const supportRows = supportIds.length > 0
        ? rows(await db.execute(exactSupportQuery(scope.projectId, scope.statementId, scope.revisionId, supportIds)))
        : [];
      const supports = new Map<string, ExactInterpretationSupportSummary>(supportRows.map((row) => [String(row.id), {
        id: String(row.id), sequence: String(row.sequence), valueState: String(row.value_state),
        textValue: row.text_value == null ? null : String(row.text_value),
        numberValue: row.number_value == null ? null : String(row.number_value),
        booleanValue: row.boolean_value == null ? null : Boolean(row.boolean_value),
        optionId: row.option_id == null ? null : String(row.option_id),
        optionLabel: row.option_label == null ? null : String(row.option_label),
        paperTitle: String(row.paper_title), fieldName: String(row.field_name),
        isCurrentExtractionRevision: row.is_current_extraction_revision === true || row.is_current_extraction_revision === "t",
      }]));
      return {
        id: String(header.id), sequence: String(header.sequence), projectId: scope.projectId,
        statementId: scope.statementId, revisionId: scope.revisionId,
        convergenceState: String(header.convergence_state) as ExactInterpretationSnapshot["convergenceState"],
        summary: String(header.summary), researcherNote: header.researcher_note == null ? null : String(header.researcher_note),
        createdAt: date(header.created_at), finalizedAt: date(header.finalized_at),
        isCurrent: String(header.current_interpretation_id) === String(header.id),
        limitations: limitations.map((row) => ({
          id: String(row.id), sortOrder: Number(row.sort_order), category: String(row.category),
          body: String(row.body), createdAt: date(row.created_at),
        })),
        questions: questions.map((row) => ({
          id: String(row.id), sortOrder: Number(row.sort_order), body: String(row.body), createdAt: date(row.created_at),
        })),
        contradictions: contradictions.map((row) => ({
          id: String(row.id), sortOrder: Number(row.sort_order),
          leftExtractionRevisionId: String(row.left_extraction_revision_id),
          rightExtractionRevisionId: String(row.right_extraction_revision_id),
          note: row.note == null ? null : String(row.note), createdAt: date(row.created_at),
          leftSupport: supports.get(String(row.left_extraction_revision_id)) ?? null,
          rightSupport: supports.get(String(row.right_extraction_revision_id)) ?? null,
        })),
      };
    },
  };
}

export type SynthesisInterpretationExactReadServices = ReturnType<typeof createSynthesisInterpretationExactReadServices>;
