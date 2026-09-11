import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  synthesisInterpretations,
  synthesisInterpretationLimitations,
  synthesisInterpretationQuestions,
  synthesisInterpretationContradictions,
  synthesisRevisions,
} from "@/db/schema";
import { DomainError } from "@/domain/errors";
import type {
  AppendSynthesisInterpretationInput,
  SynthesisInterpretationSnapshot,
  SynthesisInterpretationProjection,
  SynthesisInterpretationSnapshotView,
  SynthesisInterpretationContradictionView,
  SynthesisInterpretationLimitation,
  SynthesisInterpretationQuestion,
  SynthesisInterpretationContradiction,
  ConvergenceState,
  EvidenceCurationWarning,
  SynthesisRevisionView,
  SynthesisSupport,
  LimitationCategory,
} from "@/domain/types";
import { appendSynthesisInterpretationSchema, idSchema } from "@/domain/validation";

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

function mapLimitation(row: typeof synthesisInterpretationLimitations.$inferSelect): SynthesisInterpretationLimitation {
  return {
    id: row.id,
    projectId: row.projectId,
    interpretationId: row.interpretationId,
    sortOrder: row.sortOrder,
    category: row.category as LimitationCategory,
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

function mapContradiction(row: typeof synthesisInterpretationContradictions.$inferSelect): SynthesisInterpretationContradiction {
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
  };
}

export interface SynthesisInterpretationServiceDependencies {
  requireProject: (projectId: string) => Promise<unknown>;
  getSynthesisProvenance: (projectId: string, statementId: string, revisionId?: string) => Promise<SynthesisRevisionView>;
}

export function createSynthesisInterpretationServices(
  db: Database,
  deps: SynthesisInterpretationServiceDependencies,
) {
  return {
    async appendSynthesisInterpretation(
      projectId: string,
      synthesisStatementId: string,
      synthesisRevisionId: string,
      input: AppendSynthesisInterpretationInput,
    ): Promise<SynthesisInterpretationSnapshot> {
      await deps.requireProject(projectId);
      ensureId(synthesisStatementId);
      ensureId(synthesisRevisionId);

      // Zod validation occurs strictly BEFORE opening the write transaction
      const values = validate(appendSynthesisInterpretationSchema, input);

      const result = await db.transaction(async (tx) => {
        // 1. Lock exact SynthesisRevision
        const [revRow] = await tx
          .select({
            id: synthesisRevisions.id,
            state: synthesisRevisions.state,
            finalizedAt: synthesisRevisions.finalizedAt,
          })
          .from(synthesisRevisions)
          .where(
            and(
              eq(synthesisRevisions.projectId, projectId),
              eq(synthesisRevisions.synthesisStatementId, synthesisStatementId),
              eq(synthesisRevisions.id, synthesisRevisionId),
            ),
          )
          .for("update");

        if (!revRow) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis revision does not belong to this statement and project");
        }
        if (!revRow.finalizedAt) {
          throw new DomainError("VALIDATION_ERROR", "Interpretations can only be authored for finalized synthesis revisions");
        }

        // 2. Insert draft snapshot (finalized_at = null)
        const [draft] = await tx
          .insert(synthesisInterpretations)
          .values({
            projectId,
            synthesisStatementId,
            synthesisRevisionId,
            convergenceState: values.convergenceState,
            summary: values.summary,
            researcherNote: values.researcherNote ?? null,
            finalizedAt: null,
          })
          .returning();

        // 3. Insert complete children
        const limitations = values.limitations && values.limitations.length > 0
          ? await tx
              .insert(synthesisInterpretationLimitations)
              .values(
                values.limitations.map((lim, index) => ({
                  projectId,
                  interpretationId: draft.id,
                  sortOrder: index,
                  category: lim.category,
                  body: lim.body,
                })),
              )
              .returning()
          : [];

        const questions = values.questions && values.questions.length > 0
          ? await tx
              .insert(synthesisInterpretationQuestions)
              .values(
                values.questions.map((q, index) => ({
                  projectId,
                  interpretationId: draft.id,
                  sortOrder: index,
                  body: q.body,
                })),
              )
              .returning()
          : [];

        const contradictions = values.contradictions && values.contradictions.length > 0
          ? await tx
              .insert(synthesisInterpretationContradictions)
              .values(
                values.contradictions.map((c, index) => ({
                  projectId,
                  interpretationId: draft.id,
                  synthesisRevisionId,
                  sortOrder: index,
                  leftExtractionRevisionId: c.leftExtractionRevisionId,
                  rightExtractionRevisionId: c.rightExtractionRevisionId,
                  note: c.note ?? null,
                })),
              )
              .returning()
          : [];

        // 4. Finalize snapshot
        const [finalized] = await tx
          .update(synthesisInterpretations)
          .set({ finalizedAt: new Date() })
          .where(
            and(
              eq(synthesisInterpretations.projectId, projectId),
              eq(synthesisInterpretations.id, draft.id),
            ),
          )
          .returning();

        return {
          finalized,
          limitations,
          questions,
          contradictions,
        };
      });

      return {
        id: result.finalized.id,
        sequence: Number(result.finalized.sequence),
        projectId: result.finalized.projectId,
        synthesisStatementId: result.finalized.synthesisStatementId,
        synthesisRevisionId: result.finalized.synthesisRevisionId,
        convergenceState: result.finalized.convergenceState as ConvergenceState,
        summary: result.finalized.summary,
        researcherNote: result.finalized.researcherNote,
        createdAt: result.finalized.createdAt,
        finalizedAt: result.finalized.finalizedAt!,
        limitations: result.limitations.map(mapLimitation),
        questions: result.questions.map(mapQuestion),
        contradictions: result.contradictions.map(mapContradiction),
      };
    },

    async getSynthesisInterpretationSnapshot(
      projectId: string,
      interpretationId: string,
    ): Promise<SynthesisInterpretationSnapshot> {
      await deps.requireProject(projectId);
      ensureId(interpretationId);

      const [interpRow] = await db
        .select()
        .from(synthesisInterpretations)
        .where(
          and(
            eq(synthesisInterpretations.projectId, projectId),
            eq(synthesisInterpretations.id, interpretationId),
            sql`${synthesisInterpretations.finalizedAt} is not null`,
          ),
        );

      if (!interpRow) {
        throw new DomainError("NOT_FOUND", "Synthesis interpretation snapshot was not found");
      }

      const [limRows, qRows, contRows] = await Promise.all([
        db
          .select()
          .from(synthesisInterpretationLimitations)
          .where(
            and(
              eq(synthesisInterpretationLimitations.projectId, projectId),
              eq(synthesisInterpretationLimitations.interpretationId, interpretationId),
            ),
          )
          .orderBy(synthesisInterpretationLimitations.sortOrder),
        db
          .select()
          .from(synthesisInterpretationQuestions)
          .where(
            and(
              eq(synthesisInterpretationQuestions.projectId, projectId),
              eq(synthesisInterpretationQuestions.interpretationId, interpretationId),
            ),
          )
          .orderBy(synthesisInterpretationQuestions.sortOrder),
        db
          .select()
          .from(synthesisInterpretationContradictions)
          .where(
            and(
              eq(synthesisInterpretationContradictions.projectId, projectId),
              eq(synthesisInterpretationContradictions.interpretationId, interpretationId),
            ),
          )
          .orderBy(synthesisInterpretationContradictions.sortOrder),
      ]);

      return {
        id: interpRow.id,
        sequence: Number(interpRow.sequence),
        projectId: interpRow.projectId,
        synthesisStatementId: interpRow.synthesisStatementId,
        synthesisRevisionId: interpRow.synthesisRevisionId,
        convergenceState: interpRow.convergenceState as ConvergenceState,
        summary: interpRow.summary,
        researcherNote: interpRow.researcherNote,
        createdAt: interpRow.createdAt,
        finalizedAt: interpRow.finalizedAt!,
        limitations: limRows.map(mapLimitation),
        questions: qRows.map(mapQuestion),
        contradictions: contRows.map(mapContradiction),
      };
    },

    async getSynthesisInterpretationProjection(
      projectId: string,
      synthesisStatementId: string,
      synthesisRevisionId: string,
    ): Promise<SynthesisInterpretationProjection> {
      await deps.requireProject(projectId);
      ensureId(synthesisStatementId);
      ensureId(synthesisRevisionId);

      const revision = await deps.getSynthesisProvenance(projectId, synthesisStatementId, synthesisRevisionId);

      // Support lookup for resolving pair members
      const supportsLookup: Record<string, SynthesisSupport> = {};
      for (const sup of revision.supports) {
        supportsLookup[sup.extractionRevisionId] = sup;
      }

      // Query all finalized interpretations for this exact revision, newest first
      const interpRows = await db
        .select()
        .from(synthesisInterpretations)
        .where(
          and(
            eq(synthesisInterpretations.projectId, projectId),
            eq(synthesisInterpretations.synthesisStatementId, synthesisStatementId),
            eq(synthesisInterpretations.synthesisRevisionId, synthesisRevisionId),
            sql`${synthesisInterpretations.finalizedAt} is not null`,
          ),
        )
        .orderBy(desc(synthesisInterpretations.sequence));

      const interpIds = interpRows.map((r) => r.id);

      const [allLimitations, allQuestions, allContradictions] = interpIds.length > 0
        ? await Promise.all([
            db
              .select()
              .from(synthesisInterpretationLimitations)
              .where(
                and(
                  eq(synthesisInterpretationLimitations.projectId, projectId),
                  inArray(synthesisInterpretationLimitations.interpretationId, interpIds),
                ),
              )
              .orderBy(synthesisInterpretationLimitations.sortOrder),
            db
              .select()
              .from(synthesisInterpretationQuestions)
              .where(
                and(
                  eq(synthesisInterpretationQuestions.projectId, projectId),
                  inArray(synthesisInterpretationQuestions.interpretationId, interpIds),
                ),
              )
              .orderBy(synthesisInterpretationQuestions.sortOrder),
            db
              .select()
              .from(synthesisInterpretationContradictions)
              .where(
                and(
                  eq(synthesisInterpretationContradictions.projectId, projectId),
                  inArray(synthesisInterpretationContradictions.interpretationId, interpIds),
                ),
              )
              .orderBy(synthesisInterpretationContradictions.sortOrder),
          ])
        : [[], [], []];

      const limitationsByInterpId = new Map<string, SynthesisInterpretationLimitation[]>();
      for (const lim of allLimitations) {
        const list = limitationsByInterpId.get(lim.interpretationId) ?? [];
        list.push(mapLimitation(lim));
        limitationsByInterpId.set(lim.interpretationId, list);
      }

      const questionsByInterpId = new Map<string, SynthesisInterpretationQuestion[]>();
      for (const q of allQuestions) {
        const list = questionsByInterpId.get(q.interpretationId) ?? [];
        list.push(mapQuestion(q));
        questionsByInterpId.set(q.interpretationId, list);
      }

      const contradictionsByInterpId = new Map<string, SynthesisInterpretationContradictionView[]>();
      for (const c of allContradictions) {
        const list = contradictionsByInterpId.get(c.interpretationId) ?? [];
        list.push({
          ...mapContradiction(c),
          leftSupport: supportsLookup[c.leftExtractionRevisionId] ?? null,
          rightSupport: supportsLookup[c.rightExtractionRevisionId] ?? null,
        });
        contradictionsByInterpId.set(c.interpretationId, list);
      }

      const history: SynthesisInterpretationSnapshotView[] = interpRows.map((row) => ({
        id: row.id,
        sequence: Number(row.sequence),
        projectId: row.projectId,
        synthesisStatementId: row.synthesisStatementId,
        synthesisRevisionId: row.synthesisRevisionId,
        convergenceState: row.convergenceState as ConvergenceState,
        summary: row.summary,
        researcherNote: row.researcherNote,
        createdAt: row.createdAt,
        finalizedAt: row.finalizedAt!,
        limitations: limitationsByInterpId.get(row.id) ?? [],
        questions: questionsByInterpId.get(row.id) ?? [],
        contradictions: contradictionsByInterpId.get(row.id) ?? [],
      }));

      const currentInterpretation = history[0] ?? null;

      // Live Evidence curation warnings across supporting extractions
      const evidenceIds = Array.from(
        new Set(
          revision.supports.flatMap((sup) =>
            sup.extractionRevision.evidence.map((ev) => ev.id),
          ),
        ),
      );

      const reviewRows = evidenceIds.length > 0
        ? (await db.execute(sql`
            select distinct on (evidence_id) evidence_id, decision
            from evidence_review_decisions
            where project_id = ${projectId} and evidence_id in (${sql.join(evidenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
            order by evidence_id, sequence desc
          `)) as unknown as Record<string, unknown>[]
        : [];

      const decisionByEvidenceId = new Map(
        reviewRows.map((r) => [String(r.evidence_id), String(r.decision)]),
      );

      const evidenceWarnings = evidenceIds.map((id) => {
        const dec = decisionByEvidenceId.get(id);
        const warning: EvidenceCurationWarning =
          !dec || dec === "unreviewed"
            ? "never_reviewed"
            : dec === "needs_review"
            ? "needs_review"
            : dec === "rejected"
            ? "currently_rejected"
            : null;
        return { evidenceId: id, warning };
      });

      return {
        revision,
        currentInterpretation,
        history,
        supportsLookup,
        evidenceWarnings,
      };
    },
  };
}
