import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { synthesisStatements, synthesisRevisions } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import {
  idSchema,
  synthesisRevisionInputSchema,
  type SynthesisRevisionInput,
} from "@/domain/validation";
import type {
  PaperRepository,
  SynthesisStatementRepository,
  SynthesisRevisionRepository,
  SynthesisRevisionSupportRepository,
} from "./repositories";

export type ReviewTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type SqlExecutor = Pick<Database, "execute">;

function validate<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Input failed validation", result.error.issues);
  return result.data;
}

function ensureId(id: string): string {
  const result = idSchema.safeParse(id);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID", result.error.issues);
  return result.data;
}

export async function lockExtractionRevisionPapers(
  tx: ReviewTransaction,
  projectId: string,
  extractionRevisionIds: string[],
  paperRepo: PaperRepository,
): Promise<string[]> {
  if (!extractionRevisionIds.length) return [];
  const rows = (await tx.execute(sql`
    select distinct paper_id from extraction_value_revisions
    where project_id=${projectId} and id in (${sql.join(extractionRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
    order by paper_id
  `)) as unknown as Array<Record<string, unknown>>;
  const paperIds = rows.map((row) => String(row.paper_id)).sort();
  await paperRepo.lockManyForUpdate(tx, projectId, paperIds);
  return paperIds;
}

export async function validateSynthesisSupports(
  projectId: string,
  extractionRevisionIds: string[],
  executor: SqlExecutor = txExecutorFallback,
): Promise<Record<string, unknown>[]> {
  extractionRevisionIds.forEach(ensureId);
  if (!extractionRevisionIds.length) return [];
  const rows = (await executor.execute(sql`
    select r.id, r.project_id, r.paper_id, r.field_id, r.extraction_value_id, r.field_type, r.value_state,
      r.text_value, r.number_value, r.boolean_value, r.option_id, r.researcher_note, r.created_at, r.finalized_at,
      p.id as paper_id_value,
      coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened') as screening_state,
      (select fd.decision from full_text_screening_decisions fd where fd.project_id=r.project_id and fd.paper_id=r.paper_id order by fd.sequence desc limit 1) as full_text_state
    from extraction_value_revisions r join papers p on p.project_id=r.project_id and p.id=r.paper_id
    where r.project_id=${projectId} and r.id in (${sql.join(extractionRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `)) as unknown as Record<string, unknown>[];
  if (rows.length !== extractionRevisionIds.length) {
    throw new DomainError("CROSS_PROJECT_REFERENCE", "One or more extraction revisions do not belong to this project");
  }
  for (const row of rows) {
    if (row.finalized_at == null) throw new DomainError("VALIDATION_ERROR", "Synthesis support must use finalized extraction revisions");
    if (String(row.value_state) === "cleared") throw new DomainError("VALIDATION_ERROR", "Cleared extraction revisions cannot support new synthesis");
    if (String(row.screening_state) !== "include" || String(row.full_text_state) !== "include") {
      throw new DomainError("VALIDATION_ERROR", "New synthesis support is limited to currently finally included papers");
    }
  }
  return rows;
}

const txExecutorFallback: SqlExecutor = {
  execute() {
    throw new Error("SqlExecutor required");
  },
};

export type SynthesisTarget =
  | { kind: "new" }
  | { kind: "existing"; statementId: string };

export interface SynthesisWriterDependencies {
  paperRepo: PaperRepository;
  synthesisStatementRepo: SynthesisStatementRepository;
  synthesisRevisionRepo: SynthesisRevisionRepository;
  synthesisSupportRepo: SynthesisRevisionSupportRepository;
}

/**
 * Shared single authority for writing active synthesis revisions.
 * Canonical lock order: supporting Papers (in UUID order) -> SynthesisStatement.
 * (If called by finalizeSynthesisPreparation, Preparation is already locked prior).
 */
export async function writeActiveSynthesisRevision(
  tx: ReviewTransaction,
  projectId: string,
  target: SynthesisTarget,
  input: SynthesisRevisionInput,
  deps: SynthesisWriterDependencies,
): Promise<{
  statement: typeof synthesisStatements.$inferSelect;
  revision: typeof synthesisRevisions.$inferSelect;
  supportExtractionRevisionIds: string[];
}> {
  const values = validate(synthesisRevisionInputSchema, input);
  const ids = values.extractionRevisionIds ?? [];

  // 1. Lock supporting Papers in UUID order
  await lockExtractionRevisionPapers(tx, projectId, ids, deps.paperRepo);

  // 2. Validate Slice 4 support eligibility
  await validateSynthesisSupports(projectId, ids, tx);

  // 3. Resolve target statement
  let statement: typeof synthesisStatements.$inferSelect;
  if (target.kind === "new") {
    const statementRows = await tx.insert(synthesisStatements).values({ projectId }).returning();
    statement = statementRows[0];
    await deps.synthesisStatementRepo.findForUpdate(tx, projectId, statement.id);
  } else {
    ensureId(target.statementId);
    const found = await deps.synthesisStatementRepo.findForUpdate(tx, projectId, target.statementId);
    if (!found) {
      throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
    }
    statement = found;
  }

  // 4. Create active draft revision
  const draft = await deps.synthesisRevisionRepo.createDraft(tx, {
    projectId,
    synthesisStatementId: statement.id,
    state: "active",
    title: values.title ?? null,
    statementText: values.statementText,
    researcherNote: values.researcherNote ?? null,
  });

  // 5. Insert supports
  await deps.synthesisSupportRepo.createMany(tx, projectId, draft.id, ids);

  // 6. Finalize revision
  const finalized = await deps.synthesisRevisionRepo.finalize(tx, projectId, draft.id);
  if (!finalized) {
    throw new DomainError("DATABASE_CONSTRAINT", "Synthesis revision could not be finalized");
  }

  return {
    statement,
    revision: finalized,
    supportExtractionRevisionIds: ids,
  };
}