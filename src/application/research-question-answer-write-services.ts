import type { Database } from "@/db/client";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  appendResearchQuestionAnswerSchema,
  idSchema,
  type ValidatedResearchQuestionAnswerInput,
} from "@/domain/validation";
import type {
  AppendResearchQuestionAnswerInput,
  ClaimRevisionSupportStatus,
  CurrentQuestionLinks,
  ResearchQuestionAnswer,
  SynthesisSupportStatus,
} from "@/domain/types";
import {
  ResearchQuestionTraceabilityRepository,
  type DbOrTx,
} from "./research-question-traceability-repository";
import {
  ResearchQuestionAnswerRepository,
  type AnswerClaimRevisionMetadata,
  type AnswerSynthesisRevisionMetadata,
} from "./research-question-answer-repository";

/**
 * Canonical ClaimRevision result required by Answer construction.  The
 * resolver is supplied by the integration composition root so this service
 * never redefines Claim support semantics.  It must resolve the exact
 * submitted revision and report the latest finalized revision for its stable
 * Claim in the same transaction/executor.
 */
export interface AnswerClaimRevisionResolution {
  projectId?: string;
  claimId: string;
  revisionId: string;
  sequence: number;
  state: string;
  finalizedAt: Date | null;
  currentRevisionId?: string | null;
  currentRevisionSequence?: number | null;
  currentRevisionState?: string | null;
  isCurrentRevision?: boolean;
  supportStatus: ClaimRevisionSupportStatus;
  supportCount?: number;
}

/**
 * Canonical SynthesisRevision result required by Answer construction.  As
 * with Claims, the injected resolver owns the released support-status rules;
 * this service only enforces the Answer eligibility boundary.
 */
export interface AnswerSynthesisRevisionResolution {
  projectId?: string;
  synthesisStatementId: string;
  revisionId: string;
  sequence: number;
  state: string;
  finalizedAt: Date | null;
  currentRevisionId?: string | null;
  currentRevisionSequence?: number | null;
  currentRevisionState?: string | null;
  isCurrentRevision?: boolean;
  supportStatus: SynthesisSupportStatus;
  supportCount?: number;
}

export type AnswerClaimRevisionResolver = (
  projectId: string,
  revisionId: string,
  tx: DbOrTx,
) => Promise<AnswerClaimRevisionResolution | null>;

export type AnswerSynthesisRevisionResolver = (
  projectId: string,
  revisionId: string,
  tx: DbOrTx,
) => Promise<AnswerSynthesisRevisionResolution | null>;

export interface ResearchQuestionAnswerTraceabilityRepository {
  listCurrentLinksForQuestion(
    projectId: string,
    questionId: string,
    tx?: DbOrTx,
  ): Promise<CurrentQuestionLinks>;
}

export interface ResearchQuestionAnswerWriteDependencies {
  /** Slice 20's authoritative latest-event-first reducer. */
  traceabilityRepository?: ResearchQuestionAnswerTraceabilityRepository;
  /** Preferred names for the injected released canonical resolvers. */
  claimRevisionResolver?: AnswerClaimRevisionResolver;
  synthesisRevisionResolver?: AnswerSynthesisRevisionResolver;
  /** Backwards-compatible aliases useful to composition roots. */
  resolveClaimRevision?: AnswerClaimRevisionResolver;
  resolveSynthesisRevision?: AnswerSynthesisRevisionResolver;
}

export interface ResearchQuestionAnswerWriteServices {
  appendResearchQuestionAnswer(
    projectId: string,
    researchQuestionId: string,
    input: AppendResearchQuestionAnswerInput,
  ): Promise<ResearchQuestionAnswer>;
}

function validate<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError("VALIDATION_ERROR", "Input failed validation", result.error.issues);
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

function rowCountMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String((error as { message?: unknown } | null)?.message ?? error);
}

/** Map trigger/FK failures to the service's stable domain boundary. */
function mapDatabaseError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const message = rowCountMessage(error);
  if (isConstraintError(error)) {
    if (/foreign key|does not belong|project|cross-project/i.test(message) && !/context.*not currently linked/i.test(message)) {
      throw new DomainError("CROSS_PROJECT_REFERENCE", message);
    }
    if (/not currently linked|current|active|supported|archived|context|at least one|Answer/i.test(message)) {
      throw new DomainError("INELIGIBLE_REFERENCE", message);
    }
    throw new DomainError("DATABASE_CONSTRAINT", message);
  }
  throw error;
}

function metadataById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function requireResolver<T>(resolver: T | undefined, label: string): T {
  if (!resolver) {
    throw new DomainError(
      "DATABASE_CONSTRAINT",
      `${label} resolver is required to preserve canonical support semantics`,
    );
  }
  return resolver;
}

function isCurrentResolution(
  resolution: { revisionId: string; currentRevisionId?: string | null; isCurrentRevision?: boolean },
  revisionId: string,
): boolean {
  if (resolution.currentRevisionId != null) return resolution.currentRevisionId === revisionId;
  return resolution.isCurrentRevision === true;
}

function ensureClaimResolution(
  metadata: AnswerClaimRevisionMetadata,
  resolution: AnswerClaimRevisionResolution | null,
  projectId: string,
  currentlyLinked: boolean,
): void {
  if (!currentlyLinked) {
    throw new DomainError(
      "INELIGIBLE_REFERENCE",
      `Claim ${metadata.claimId} is not currently linked to this research question`,
    );
  }
  if (!resolution || resolution.projectId != null && resolution.projectId !== projectId) {
    throw new DomainError(
      "CROSS_PROJECT_REFERENCE",
      `ClaimRevision ${metadata.id} does not belong to this project`,
    );
  }
  if (resolution.claimId !== metadata.claimId || resolution.revisionId !== metadata.id) {
    throw new DomainError(
      "DATABASE_CONSTRAINT",
      `Canonical Claim resolver returned inconsistent identity for ClaimRevision ${metadata.id}`,
    );
  }
  if (!isCurrentResolution(resolution, metadata.id)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `ClaimRevision ${metadata.id} is no longer the current finalized revision; refresh Answer candidates`,
    );
  }
  if (resolution.finalizedAt == null || resolution.state !== "active") {
    throw new DomainError(
      "INELIGIBLE_REFERENCE",
      `ClaimRevision ${metadata.id} must be a finalized active revision`,
    );
  }
  if (resolution.supportStatus !== "supported") {
    throw new DomainError(
      "INELIGIBLE_REFERENCE",
      `ClaimRevision ${metadata.id} is not supported according to the canonical Claim support resolver`,
    );
  }
}

function ensureSynthesisResolution(
  metadata: AnswerSynthesisRevisionMetadata,
  resolution: AnswerSynthesisRevisionResolution | null,
  projectId: string,
  currentlyLinked: boolean,
): void {
  if (!currentlyLinked) {
    throw new DomainError(
      "INELIGIBLE_REFERENCE",
      `SynthesisStatement ${metadata.synthesisStatementId} is not currently linked to this research question`,
    );
  }
  if (!resolution || resolution.projectId != null && resolution.projectId !== projectId) {
    throw new DomainError(
      "CROSS_PROJECT_REFERENCE",
      `SynthesisRevision ${metadata.id} does not belong to this project`,
    );
  }
  if (resolution.synthesisStatementId !== metadata.synthesisStatementId || resolution.revisionId !== metadata.id) {
    throw new DomainError(
      "DATABASE_CONSTRAINT",
      `Canonical Synthesis resolver returned inconsistent identity for SynthesisRevision ${metadata.id}`,
    );
  }
  if (!isCurrentResolution(resolution, metadata.id)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `SynthesisRevision ${metadata.id} is no longer the current finalized revision; refresh Answer candidates`,
    );
  }
  if (resolution.finalizedAt == null || resolution.state !== "active") {
    throw new DomainError(
      "INELIGIBLE_REFERENCE",
      `SynthesisRevision ${metadata.id} must be a finalized active revision`,
    );
  }
  if (resolution.supportStatus !== "supported") {
    throw new DomainError(
      "INELIGIBLE_REFERENCE",
      `SynthesisRevision ${metadata.id} is not supported according to the canonical Synthesis support resolver`,
    );
  }
}

function assertMetadataSet<T extends { id: string }>(
  submittedIds: string[],
  metadata: T[],
  label: string,
): void {
  const found = new Set(metadata.map((item) => item.id));
  if (submittedIds.some((id) => !found.has(id))) {
    throw new DomainError(
      "CROSS_PROJECT_REFERENCE",
      `One or more submitted ${label} IDs do not belong to this project`,
    );
  }
}

export function createResearchQuestionAnswerWriteServices(
  db: Database,
  dependencies: ResearchQuestionAnswerWriteDependencies = {},
): ResearchQuestionAnswerWriteServices {
  const repository = new ResearchQuestionAnswerRepository(db);
  const traceabilityRepository = dependencies.traceabilityRepository ?? new ResearchQuestionTraceabilityRepository(db);
  const claimResolver = dependencies.claimRevisionResolver ?? dependencies.resolveClaimRevision;
  const synthesisResolver = dependencies.synthesisRevisionResolver ?? dependencies.resolveSynthesisRevision;

  async function appendResearchQuestionAnswer(
    projectId: string,
    researchQuestionId: string,
    input: AppendResearchQuestionAnswerInput,
  ): Promise<ResearchQuestionAnswer> {
    const validated = validate<ValidatedResearchQuestionAnswerInput>(appendResearchQuestionAnswerSchema, input);
    const project = ensureId(projectId);
    const question = ensureId(researchQuestionId);
    // Only a resolver for a submitted context type is required.  This keeps
    // the write path composable for Answers containing exclusively Claims or
    // exclusively Syntheses while still refusing to invent support semantics.
    const resolveClaim = validated.claimRevisionIds.length
      ? requireResolver(claimResolver, "ClaimRevision")
      : null;
    const resolveSynthesis = validated.synthesisRevisionIds.length
      ? requireResolver(synthesisResolver, "SynthesisRevision")
      : null;

    try {
      return await db.transaction(async (tx) => {
        // 1. ResearchQuestion is always the first lock.  This serializes
        // Answer construction with Slice 20 link/unlink/relink and archival.
        const lockedQuestion = await repository.lockResearchQuestion(tx, project, question);
        if (!lockedQuestion) throw new DomainError("NOT_FOUND", "Research question was not found");
        if (lockedQuestion.archivedAt != null) {
          throw new DomainError("VALIDATION_ERROR", "Archived research questions cannot receive new Answers");
        }

        // Resolve submitted exact revisions only far enough to learn their
        // stable parents.  No stable target is accepted as an input and no
        // submitted revision is ever replaced by a newer one.
        const claimMetadata = await repository.findClaimRevisionMetadata(
          tx,
          project,
          validated.claimRevisionIds,
        );
        const synthesisMetadata = await repository.findSynthesisRevisionMetadata(
          tx,
          project,
          validated.synthesisRevisionIds,
        );
        assertMetadataSet(validated.claimRevisionIds, claimMetadata, "ClaimRevision");
        assertMetadataSet(validated.synthesisRevisionIds, synthesisMetadata, "SynthesisRevision");

        // 2. Lock stable analytical parents in deterministic UUID order.  No
        // resolver called below may acquire ResearchQuestion after this point.
        const claimIds = sortedUnique(claimMetadata.map((item) => item.claimId));
        const statementIds = sortedUnique(synthesisMetadata.map((item) => item.synthesisStatementId));
        const lockedClaimIds = await repository.lockClaimsForUpdate(tx, project, claimIds);
        if (lockedClaimIds.length !== claimIds.length) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "One or more Claims do not belong to this project");
        }
        const lockedStatementIds = await repository.lockSynthesisStatementsForUpdate(tx, project, statementIds);
        if (lockedStatementIds.length !== statementIds.length) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "One or more SynthesisStatements do not belong to this project");
        }

        // 3. Re-read the authoritative latest-event-first reducer after the
        // RQ lock.  Its implementation selects greatest sequence first and
        // inspects action second; never filter action before that reduction.
        const currentLinks = await traceabilityRepository.listCurrentLinksForQuestion(project, question, tx);
        const currentClaimIds = new Set(currentLinks.claimIds);
        const currentStatementIds = new Set(currentLinks.synthesisStatementIds);

        const claimMetadataById = metadataById(claimMetadata);
        for (const revisionId of validated.claimRevisionIds) {
          const metadata = claimMetadataById.get(revisionId);
          if (!metadata) {
            throw new DomainError("CROSS_PROJECT_REFERENCE", `ClaimRevision ${revisionId} does not belong to this project`);
          }
          const resolution = await resolveClaim!(project, revisionId, tx);
          ensureClaimResolution(metadata, resolution, project, currentClaimIds.has(metadata.claimId));
        }

        const synthesisMetadataById = metadataById(synthesisMetadata);
        for (const revisionId of validated.synthesisRevisionIds) {
          const metadata = synthesisMetadataById.get(revisionId);
          if (!metadata) {
            throw new DomainError("CROSS_PROJECT_REFERENCE", `SynthesisRevision ${revisionId} does not belong to this project`);
          }
          const resolution = await resolveSynthesis!(project, revisionId, tx);
          ensureSynthesisResolution(metadata, resolution, project, currentStatementIds.has(metadata.synthesisStatementId));
        }

        // 4. Construct one database-only draft, append typed exact-context
        // rows, and perform the sole permitted parent mutation (finalization).
        const draft = await repository.insertDraft(tx, {
          projectId: project,
          researchQuestionId: question,
          answerText: validated.answerText,
          researcherNote: validated.researcherNote ?? null,
        });
        if (!draft) throw new DomainError("DATABASE_CONSTRAINT", "Research Question Answer could not be created");

        await repository.insertClaimContexts(
          tx,
          validated.claimRevisionIds.map((revisionId, sortOrder) => {
            const metadata = claimMetadataById.get(revisionId);
            if (!metadata) throw new DomainError("DATABASE_CONSTRAINT", `Missing ClaimRevision metadata for ${revisionId}`);
            return {
              projectId: project,
              researchQuestionId: question,
              answerId: draft.id,
              claimId: metadata.claimId,
              claimRevisionId: revisionId,
              sortOrder,
            };
          }),
        );

        await repository.insertSynthesisContexts(
          tx,
          validated.synthesisRevisionIds.map((revisionId, sortOrder) => {
            const metadata = synthesisMetadataById.get(revisionId);
            if (!metadata) throw new DomainError("DATABASE_CONSTRAINT", `Missing SynthesisRevision metadata for ${revisionId}`);
            return {
              projectId: project,
              researchQuestionId: question,
              answerId: draft.id,
              synthesisStatementId: metadata.synthesisStatementId,
              synthesisRevisionId: revisionId,
              sortOrder,
            };
          }),
        );

        const finalized = await repository.finalize(tx, project, draft.id);
        if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Research Question Answer could not be finalized");
        return finalized;
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  return { appendResearchQuestionAnswer };
}

/** Alias for composition roots that use "create" terminology. */
export const createResearchQuestionAnswerServices = createResearchQuestionAnswerWriteServices;
export const createResearchQuestionAnswerWriteService = createResearchQuestionAnswerWriteServices;
