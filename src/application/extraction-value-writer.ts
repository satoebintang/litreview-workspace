import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { extractionValueRevisions } from "@/db/schema";

type SqlExecutor = Pick<Database, "execute">;

export type CanonicalExtractionRevisionInput = {
  projectId: string;
  paperId: string;
  fieldId: string;
  fieldType: "short_text" | "long_text" | "number" | "boolean" | "single_select";
  valueState: "present" | "not_reported" | "not_applicable" | "cleared";
  textValue?: string | null;
  numberValue?: string | null;
  booleanValue?: boolean | null;
  optionId?: string | null;
  researcherNote?: string | null;
  evidenceIds: string[];
};

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return value as Row[];
}

/**
 * The shared append-only canonical extraction writer. Callers own validation,
 * Paper locking, and direct-support review gates; this function only writes
 * ordinary ExtractionValue/ExtractionValueRevision provenance.
 */
export async function writeExtractedExtractionRevision(
  tx: SqlExecutor,
  input: CanonicalExtractionRevisionInput,
) {
  const slotRows = rows(await tx.execute(sql`
    insert into extraction_values (project_id, paper_id, field_id)
    values (${input.projectId}::uuid, ${input.paperId}::uuid, ${input.fieldId}::uuid)
    on conflict (project_id, paper_id, field_id) do update set updated_at=now()
    returning *
  `));
  const slot = slotRows[0];
  if (!slot) throw new Error("Extraction value slot could not be created");

  const revisionRows = rows(await tx.execute(sql`
    insert into extraction_value_revisions (
      project_id, paper_id, field_id, extraction_value_id, field_type,
      value_state, text_value, number_value, boolean_value, option_id,
      researcher_note
    ) values (
      ${input.projectId}::uuid, ${input.paperId}::uuid, ${input.fieldId}::uuid,
      ${String(slot.id)}::uuid, ${input.fieldType}, ${input.valueState},
      ${input.textValue ?? null}, ${input.numberValue ?? null},
      ${input.booleanValue ?? null}, ${input.optionId ?? null}::uuid,
      ${input.researcherNote ?? null}
    ) returning *
  `));
  const revision = revisionRows[0];
  if (!revision) throw new Error("Extraction revision could not be created");

  for (const evidenceId of input.evidenceIds) {
    await tx.execute(sql`
      insert into extraction_revision_evidence
        (project_id, paper_id, revision_id, evidence_id)
      values (${input.projectId}::uuid, ${input.paperId}::uuid,
        ${String(revision.id)}::uuid, ${evidenceId}::uuid)
    `);
  }

  const finalizedRows = rows(await tx.execute(sql`
    update extraction_value_revisions
    set finalized_at=now()
    where project_id=${input.projectId}::uuid and id=${String(revision.id)}::uuid
    returning *
  `));
  await tx.execute(sql`
    update extraction_values set updated_at=now()
    where project_id=${input.projectId}::uuid and id=${String(slot.id)}::uuid
  `);
  return (finalizedRows[0] ?? revision) as unknown as typeof extractionValueRevisions.$inferSelect;
}
