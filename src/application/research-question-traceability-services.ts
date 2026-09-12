/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  claims,
  evidenceSets,
  extractionFields,
  projects,
  researchQuestions,
  synthesisStatements,
} from "@/db/schema";
import { DomainError } from "@/domain/errors";
import type {
  CurrentQuestionLinks,
  ResearchQuestionExtractionFieldEvent,
  ResearchQuestionEvidenceSetEvent,
  ResearchQuestionSynthesisStatementEvent,
  ResearchQuestionClaimEvent,
} from "@/domain/types";
import {
  linkExtractionFieldSchema,
  unlinkExtractionFieldSchema,
  linkEvidenceSetSchema,
  unlinkEvidenceSetSchema,
  linkSynthesisStatementSchema,
  unlinkSynthesisStatementSchema,
  linkClaimSchema,
  unlinkClaimSchema,
  idSchema,
  type LinkExtractionFieldInput,
  type UnlinkExtractionFieldInput,
  type LinkEvidenceSetInput,
  type UnlinkEvidenceSetInput,
  type LinkSynthesisStatementInput,
  type UnlinkSynthesisStatementInput,
  type LinkClaimInput,
  type UnlinkClaimInput,
} from "@/domain/validation";
import {
  ResearchQuestionTraceabilityRepository,
  type DbOrTx,
} from "./research-question-traceability-repository";

function validate<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError("VALIDATION_ERROR", "Input validation failed", result.error.issues);
  }
  return result.data;
}

function ensureId(id: string): string {
  const result = idSchema.safeParse(id);
  if (!result.success) {
    throw new DomainError("VALIDATION_ERROR", "Identifier must be a valid UUID", result.error.issues);
  }
  return result.data;
}

function handleDatabaseError(error: any): never {
  const msg = String(error?.message ?? error);
  if (
    msg.includes("archived") ||
    msg.includes("already linked") ||
    msg.includes("already unlinked") ||
    msg.includes("First event") ||
    msg.includes("append-only")
  ) {
    throw new DomainError("VALIDATION_ERROR", msg);
  }
  if (error?.code === "23503" || msg.includes("foreign key") || msg.includes("violates foreign key")) {
    throw new DomainError("CROSS_PROJECT_REFERENCE", "Cross-project or missing target reference");
  }
  if (error?.code === "23514" || msg.includes("check constraint")) {
    throw new DomainError("VALIDATION_ERROR", msg);
  }
  throw error;
}

export function createResearchQuestionTraceabilityServices(db: Database) {
  const repo = new ResearchQuestionTraceabilityRepository(db);

  async function requireProject(projectId: string, tx: DbOrTx = db) {
    ensureId(projectId);
    const [p] = await (tx as any)
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return p;
  }

  async function lockQuestion(projectId: string, questionId: string, tx: DbOrTx) {
    ensureId(projectId);
    ensureId(questionId);
    const [q] = await (tx as any)
      .select()
      .from(researchQuestions)
      .where(and(eq(researchQuestions.projectId, projectId), eq(researchQuestions.id, questionId)))
      .for("update")
      .limit(1);
    if (!q) throw new DomainError("NOT_FOUND", "Research question was not found");
    if (q.archivedAt != null) {
      throw new DomainError("VALIDATION_ERROR", "Cannot mutate traceability for an archived research question");
    }
    return q;
  }

  return {
    repo,

    async linkExtractionField(input: LinkExtractionFieldInput): Promise<ResearchQuestionExtractionFieldEvent> {
      const values = validate(linkExtractionFieldSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [field] = await tx
          .select()
          .from(extractionFields)
          .where(eq(extractionFields.id, values.fieldId))
          .limit(1);
        if (!field) throw new DomainError("NOT_FOUND", "Extraction field was not found");
        if (field.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field belongs to a different project");
        }

        const latest = await repo.getLatestExtractionFieldEvent(values.projectId, values.questionId, values.fieldId, tx);
        if (latest && latest.action === "linked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already linked to this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertExtractionFieldEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              extractionFieldId: values.fieldId,
              action: "linked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async unlinkExtractionField(input: UnlinkExtractionFieldInput): Promise<ResearchQuestionExtractionFieldEvent> {
      const values = validate(unlinkExtractionFieldSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [field] = await tx
          .select()
          .from(extractionFields)
          .where(eq(extractionFields.id, values.fieldId))
          .limit(1);
        if (!field) throw new DomainError("NOT_FOUND", "Extraction field was not found");
        if (field.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field belongs to a different project");
        }

        const latest = await repo.getLatestExtractionFieldEvent(values.projectId, values.questionId, values.fieldId, tx);
        if (!latest) {
          throw new DomainError("VALIDATION_ERROR", "First event for a target must have action = linked");
        }
        if (latest.action === "unlinked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already unlinked from this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertExtractionFieldEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              extractionFieldId: values.fieldId,
              action: "unlinked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async linkEvidenceSet(input: LinkEvidenceSetInput): Promise<ResearchQuestionEvidenceSetEvent> {
      const values = validate(linkEvidenceSetSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [set] = await tx
          .select()
          .from(evidenceSets)
          .where(eq(evidenceSets.id, values.evidenceSetId))
          .limit(1);
        if (!set) throw new DomainError("NOT_FOUND", "Evidence set was not found");
        if (set.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence set belongs to a different project");
        }

        const latest = await repo.getLatestEvidenceSetEvent(values.projectId, values.questionId, values.evidenceSetId, tx);
        if (latest && latest.action === "linked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already linked to this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertEvidenceSetEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              evidenceSetId: values.evidenceSetId,
              action: "linked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async unlinkEvidenceSet(input: UnlinkEvidenceSetInput): Promise<ResearchQuestionEvidenceSetEvent> {
      const values = validate(unlinkEvidenceSetSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [set] = await tx
          .select()
          .from(evidenceSets)
          .where(eq(evidenceSets.id, values.evidenceSetId))
          .limit(1);
        if (!set) throw new DomainError("NOT_FOUND", "Evidence set was not found");
        if (set.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence set belongs to a different project");
        }

        const latest = await repo.getLatestEvidenceSetEvent(values.projectId, values.questionId, values.evidenceSetId, tx);
        if (!latest) {
          throw new DomainError("VALIDATION_ERROR", "First event for a target must have action = linked");
        }
        if (latest.action === "unlinked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already unlinked from this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertEvidenceSetEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              evidenceSetId: values.evidenceSetId,
              action: "unlinked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async linkSynthesisStatement(input: LinkSynthesisStatementInput): Promise<ResearchQuestionSynthesisStatementEvent> {
      const values = validate(linkSynthesisStatementSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [stmt] = await tx
          .select()
          .from(synthesisStatements)
          .where(eq(synthesisStatements.id, values.statementId))
          .limit(1);
        if (!stmt) throw new DomainError("NOT_FOUND", "Synthesis statement was not found");
        if (stmt.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement belongs to a different project");
        }

        const latest = await repo.getLatestSynthesisStatementEvent(values.projectId, values.questionId, values.statementId, tx);
        if (latest && latest.action === "linked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already linked to this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertSynthesisStatementEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              synthesisStatementId: values.statementId,
              action: "linked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async unlinkSynthesisStatement(input: UnlinkSynthesisStatementInput): Promise<ResearchQuestionSynthesisStatementEvent> {
      const values = validate(unlinkSynthesisStatementSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [stmt] = await tx
          .select()
          .from(synthesisStatements)
          .where(eq(synthesisStatements.id, values.statementId))
          .limit(1);
        if (!stmt) throw new DomainError("NOT_FOUND", "Synthesis statement was not found");
        if (stmt.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement belongs to a different project");
        }

        const latest = await repo.getLatestSynthesisStatementEvent(values.projectId, values.questionId, values.statementId, tx);
        if (!latest) {
          throw new DomainError("VALIDATION_ERROR", "First event for a target must have action = linked");
        }
        if (latest.action === "unlinked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already unlinked from this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertSynthesisStatementEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              synthesisStatementId: values.statementId,
              action: "unlinked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async linkClaim(input: LinkClaimInput): Promise<ResearchQuestionClaimEvent> {
      const values = validate(linkClaimSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [claim] = await tx
          .select()
          .from(claims)
          .where(eq(claims.id, values.claimId))
          .limit(1);
        if (!claim) throw new DomainError("NOT_FOUND", "Claim was not found");
        if (claim.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim belongs to a different project");
        }

        const latest = await repo.getLatestClaimEvent(values.projectId, values.questionId, values.claimId, tx);
        if (latest && latest.action === "linked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already linked to this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertClaimEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              claimId: values.claimId,
              action: "linked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async unlinkClaim(input: UnlinkClaimInput): Promise<ResearchQuestionClaimEvent> {
      const values = validate(unlinkClaimSchema, input);
      return db.transaction(async (tx) => {
        await requireProject(values.projectId, tx);
        await lockQuestion(values.projectId, values.questionId, tx);

        const [claim] = await tx
          .select()
          .from(claims)
          .where(eq(claims.id, values.claimId))
          .limit(1);
        if (!claim) throw new DomainError("NOT_FOUND", "Claim was not found");
        if (claim.projectId !== values.projectId) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim belongs to a different project");
        }

        const latest = await repo.getLatestClaimEvent(values.projectId, values.questionId, values.claimId, tx);
        if (!latest) {
          throw new DomainError("VALIDATION_ERROR", "First event for a target must have action = linked");
        }
        if (latest.action === "unlinked") {
          throw new DomainError("VALIDATION_ERROR", "Target is already unlinked from this research question");
        }

        const note = values.note?.trim() ? values.note.trim() : null;
        try {
          return await repo.insertClaimEvent(
            {
              projectId: values.projectId,
              researchQuestionId: values.questionId,
              claimId: values.claimId,
              action: "unlinked",
              note,
            },
            tx,
          );
        } catch (error) {
          return handleDatabaseError(error);
        }
      });
    },

    async getCurrentLinksForQuestion(projectId: string, questionId: string): Promise<CurrentQuestionLinks> {
      await requireProject(projectId);
      ensureId(questionId);
      return repo.listCurrentLinksForQuestion(projectId, questionId);
    },

    async getCurrentLinksForProject(projectId: string, questionIds?: string[]): Promise<Map<string, CurrentQuestionLinks>> {
      await requireProject(projectId);
      return repo.listCurrentLinksForProject(projectId, questionIds);
    },

    async getQuestionTraceabilityHistories(projectId: string, questionId: string) {
      await requireProject(projectId);
      ensureId(questionId);
      const [fieldEvents, evidenceSetEvents, synthesisEvents, claimEvents] = await Promise.all([
        repo.listExtractionFieldEvents(projectId, questionId),
        repo.listEvidenceSetEvents(projectId, questionId),
        repo.listSynthesisStatementEvents(projectId, questionId),
        repo.listClaimEvents(projectId, questionId),
      ]);
      return {
        fieldEvents,
        evidenceSetEvents,
        synthesisEvents,
        claimEvents,
      };
    },
  };
}

export type ResearchQuestionTraceabilityServices = ReturnType<typeof createResearchQuestionTraceabilityServices>;
