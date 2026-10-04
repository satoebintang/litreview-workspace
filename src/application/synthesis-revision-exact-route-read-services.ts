import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { ensureId } from "@/application/review-services/shared";

export type SynthesisRevisionExactRouteSequences = {
  sequence: string;
  extractionRevisionSequences: Record<string, string>;
};

type RawRow = Record<string, unknown>;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function parseSequenceMap(value: unknown): Record<string, string> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new DomainError("DATABASE_CONSTRAINT", "Synthesis support sequence map is invalid");
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("DATABASE_CONSTRAINT", "Synthesis support sequence map is missing");
  }
  return Object.fromEntries(Object.entries(parsed).map(([id, sequence]) => [id, String(sequence)]));
}

export function createSynthesisRevisionExactRouteReadServices(db: Database) {
  return {
    async getSynthesisRevisionExactRouteSequences(
      projectId: string,
      statementId: string,
      revisionId: string,
    ): Promise<SynthesisRevisionExactRouteSequences> {
      const project = ensureId(projectId).toLowerCase();
      const statement = ensureId(statementId).toLowerCase();
      const revision = ensureId(revisionId).toLowerCase();
      const result = rows(await db.execute(sql`
        with scope as materialized (
          select p.id as project_id, s.id as statement_id, r.id as revision_id,
            r.sequence::text as sequence
          from projects p
          join synthesis_statements s on s.project_id=p.id and s.id=${statement}::uuid
          join synthesis_revisions r on r.project_id=s.project_id and r.synthesis_statement_id=s.id
            and r.id=${revision}::uuid and r.finalized_at is not null
          where p.id=${project}::uuid
        )
        select scope.sequence,
          coalesce((
            select jsonb_object_agg(x.id::text, x.sequence::text)
            from synthesis_revision_supports support
            join extraction_value_revisions x
              on x.project_id=support.project_id and x.id=support.extraction_revision_id
            where support.project_id=scope.project_id and support.synthesis_revision_id=scope.revision_id
          ), '{}'::jsonb) as extraction_revision_sequences
        from scope
        limit 1
      `));
      const row = result[0];
      if (!row) throw new DomainError("NOT_FOUND", "Synthesis revision was not found");
      return {
        sequence: String(row.sequence),
        extractionRevisionSequences: parseSequenceMap(row.extraction_revision_sequences),
      };
    },
  };
}
