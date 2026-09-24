import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { synthesisRevisions } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import { synthesisWithdrawalSchema, type SynthesisRevisionInput, type SynthesisWithdrawalInput } from "@/domain/validation";
import type { PaperRepository, SynthesisRevisionRepository, SynthesisRevisionSupportRepository, SynthesisStatementRepository } from "../repositories";
import { writeActiveSynthesisRevision } from "../synthesis-writer";
import { createEvidenceReviewHelpers } from "./evidence-helpers";
import { mapSynthesisRow } from "./mappers";
import { createSynthesisProjectionHelpers } from "./synthesis-projection-helpers";
import { ensureId, validate } from "./shared";

export function createSynthesisServices<TProject>(deps: {
  db: Database;
  paperRepo: PaperRepository;
  synthesisStatementRepo: SynthesisStatementRepository;
  synthesisRevisionRepo: SynthesisRevisionRepository;
  synthesisSupportRepo: SynthesisRevisionSupportRepository;
  requireProject: (projectId: string) => Promise<TProject>;
}) {
  const { db, paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo, requireProject } = deps;
  const { enrichEvidenceDocuments } = createEvidenceReviewHelpers(db);
  const { synthesisView, synthesisViewsForRevisions } = createSynthesisProjectionHelpers(synthesisSupportRepo, enrichEvidenceDocuments);
  return {
    async createSynthesisStatement(projectId: string, input: SynthesisRevisionInput) {
      await requireProject(projectId);
      return db.transaction(async (tx) => {
        const { statement, revision } = await writeActiveSynthesisRevision(
          tx,
          projectId,
          { kind: "new" },
          input,
          { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
        );
        return { statement, revision };
      });
    },

    async reviseSynthesisStatement(projectId: string, statementId: string, input: SynthesisRevisionInput) {
      await requireProject(projectId);
      ensureId(statementId);
      return db.transaction(async (tx) => {
        const { statement, revision } = await writeActiveSynthesisRevision(
          tx,
          projectId,
          { kind: "existing", statementId },
          input,
          { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
        );
        return { statement, revision };
      });
    },

    async withdrawSynthesisStatement(projectId: string, statementId: string, input?: SynthesisWithdrawalInput) {
      await requireProject(projectId); ensureId(statementId);
      const values = validate(synthesisWithdrawalSchema, input ?? {});
      const result = await db.transaction(async (tx) => {
        const statement = await synthesisStatementRepo.findForUpdate(tx, projectId, statementId);
        if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
        const currentRows = await tx.select().from(synthesisRevisions).where(and(eq(synthesisRevisions.projectId, projectId), eq(synthesisRevisions.synthesisStatementId, statementId), sql`${synthesisRevisions.finalizedAt} is not null`)).orderBy(sql`${synthesisRevisions.sequence} desc`).limit(1);
        const current = currentRows[0];
        if (current?.state === "withdrawn") return { statement, revision: current, idempotent: true };
        const draft = await synthesisRevisionRepo.createDraft(tx, {
          projectId, synthesisStatementId: statementId, state: "withdrawn", title: current?.title ?? null,
          statementText: null, researcherNote: values.researcherNote ?? null,
        });
        const finalized = await synthesisRevisionRepo.finalize(tx, projectId, draft.id);
        if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Synthesis withdrawal could not be finalized");
        return { statement, revision: finalized, idempotent: false };
      });
      return result;
    },

    async getCurrentSynthesis(projectId: string, statementId: string) {
      await requireProject(projectId); ensureId(statementId);
      const statement = await synthesisStatementRepo.findById(projectId, statementId);
      if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
      const revision = await synthesisRevisionRepo.current(projectId, statementId);
      return revision ? synthesisView(projectId, statement, revision) : null;
    },

    async getSynthesisHistory(projectId: string, statementId: string) {
      await requireProject(projectId); ensureId(statementId);
      const statement = await synthesisStatementRepo.findById(projectId, statementId);
      if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
      const revisions = await synthesisRevisionRepo.history(projectId, statementId);
      return synthesisViewsForRevisions(projectId, new Map([[statement.id, statement]]), revisions);
    },

    async getSynthesisProvenance(projectId: string, statementId: string, revisionId?: string) {
      await requireProject(projectId); ensureId(statementId);
      const statement = await synthesisStatementRepo.findById(projectId, statementId);
      if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
      const revision = revisionId ? (ensureId(revisionId), (await synthesisRevisionRepo.history(projectId, statementId)).find((item) => item.id === revisionId) ?? null) : await synthesisRevisionRepo.current(projectId, statementId);
      if (!revision) throw new DomainError("NOT_FOUND", "Synthesis revision was not found");
      return synthesisView(projectId, statement, revision);
    },

    async listProjectSynthesis(projectId: string) {
      await requireProject(projectId);
      const rows = (await synthesisRevisionRepo.listCurrentWithStatements(projectId)) as unknown as Record<string, unknown>[];
      const mapped = rows.map(mapSynthesisRow);
      const statements = new Map(mapped.map(({ statement }) => [statement.id, statement]));
      return synthesisViewsForRevisions(projectId, statements, mapped.map(({ revision }) => revision));
    },
  };
}
