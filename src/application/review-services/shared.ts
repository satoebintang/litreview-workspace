import { DomainError } from "@/domain/errors";
import { idSchema } from "@/domain/validation";
import type { Database } from "@/db/client";
import type { ExtractionFieldType } from "@/domain/types";
import type { ReviseExtractionValueInput } from "@/domain/validation";

export function validate<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Input failed validation", result.error.issues);
  return result.data;
}

export function ensureId(id: string): string {
  const result = idSchema.safeParse(id);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID", result.error.issues);
  return result.data;
}

export function isMissingRelationError(error: unknown, relation: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; relation?: unknown; cause?: unknown; message?: unknown };
    if (String(candidate.code ?? "") === "42P01" && (!candidate.relation || String(candidate.relation) === relation)) return true;
    if (typeof candidate.message === "string" && candidate.message.includes(`relation \"${relation}\" does not exist`)) return true;
    current = candidate.cause;
  }
  return false;
}

export type EvidenceCurationWarning = "never_reviewed" | "needs_review" | "currently_rejected" | null;

export function evidenceReviewState(value: string | undefined): "unreviewed" | "needs_review" | "accepted" | "rejected" {
  return value === "needs_review" || value === "accepted" || value === "rejected" ? value : "unreviewed";
}

export function evidenceCurationWarning(state: "unreviewed" | "needs_review" | "accepted" | "rejected"): EvidenceCurationWarning {
  return state === "unreviewed" ? "never_reviewed" : state === "needs_review" ? "needs_review" : state === "rejected" ? "currently_rejected" : null;
}

export type SqlExecutor = Pick<Database, "execute">;
export type ReviewTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ClaimSupportSnapshot = {
  kind: "evidence" | "extractionRevision" | "synthesisRevision";
  evidenceId?: string;
  extractionRevisionId?: string;
  synthesisRevisionId?: string;
};

export function createRequireProject<TProject>(projectRepo: {
  findById(projectId: string): Promise<TProject | null>;
}) {
  return async function requireProject(projectId: string) {
    ensureId(projectId);
    const project = await projectRepo.findById(projectId);
    if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return project;
  };
}

export function createRequirePaper<TPaper>(
  requireProject: (projectId: string) => Promise<unknown>,
  paperRepo: { findById(projectId: string, paperId: string): Promise<TPaper | null> },
) {
  return async function requirePaper(projectId: string, paperId: string) {
    await requireProject(projectId);
    ensureId(paperId);
    const paper = await paperRepo.findById(projectId, paperId);
    if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    return paper;
  };
}

export function createRequireEvidence<TEvidence>(
  requireProject: (projectId: string) => Promise<unknown>,
  evidenceRepo: { findById(projectId: string, evidenceId: string): Promise<TEvidence | null> },
) {
  return async function requireEvidence(projectId: string, evidenceId: string) {
    await requireProject(projectId);
    ensureId(evidenceId);
    const item = await evidenceRepo.findById(projectId, evidenceId);
    if (!item) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
    return item;
  };
}

export function createRequireClaim<TClaim>(
  requireProject: (projectId: string) => Promise<unknown>,
  claimRepo: { findById(projectId: string, claimId: string): Promise<TClaim | null> },
) {
  return async function requireClaim(projectId: string, claimId: string) {
    await requireProject(projectId);
    ensureId(claimId);
    const claim = await claimRepo.findById(projectId, claimId);
    if (!claim) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
    return claim;
  };
}

export function createRequireCriterion<TCriterion>(
  requireProject: (projectId: string) => Promise<unknown>,
  criterionRepo: { findById(projectId: string, criterionId: string): Promise<TCriterion | null> },
) {
  return async function requireCriterion(projectId: string, criterionId: string) {
    await requireProject(projectId);
    ensureId(criterionId);
    const criterion = await criterionRepo.findById(projectId, criterionId);
    if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Criterion does not belong to this project");
    return criterion;
  };
}

export function createRequireExtractionField<TField extends { archivedAt: Date | null }>(
  requireProject: (projectId: string) => Promise<unknown>,
  extractionFieldRepo: { findById(projectId: string, fieldId: string): Promise<TField | null> },
) {
  return async function requireExtractionField(projectId: string, fieldId: string, includeArchived = true) {
    await requireProject(projectId);
    ensureId(fieldId);
    const field = await extractionFieldRepo.findById(projectId, fieldId);
    if (!field) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project");
    if (!includeArchived && field.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived extraction fields cannot be used");
    return field;
  };
}

export function typedRevisionPayload(fieldType: ExtractionFieldType, input: ReviseExtractionValueInput) {
  const state = input.state ?? "present";
  const note = input.researcherNote ?? null;
  if (state !== "present") return { valueState: state, textValue: null, numberValue: null, booleanValue: null, optionId: null, researcherNote: note };
  if (fieldType === "short_text" || fieldType === "long_text") {
    if (typeof input.value !== "string" || !input.value.trim()) throw new DomainError("VALIDATION_ERROR", "Text extraction values must be nonblank");
    const max = fieldType === "short_text" ? 500 : 10000;
    if (input.value.length > max) throw new DomainError("VALIDATION_ERROR", `Text extraction values cannot exceed ${max} characters`);
    return { valueState: state, textValue: input.value, numberValue: null, booleanValue: null, optionId: null, researcherNote: note };
  }
  if (fieldType === "number") {
    if ((typeof input.value !== "number" && typeof input.value !== "string") || input.value === "" || !Number.isFinite(Number(input.value))) throw new DomainError("VALIDATION_ERROR", "Number extraction values must be finite numbers");
    return { valueState: state, textValue: null, numberValue: String(input.value), booleanValue: null, optionId: null, researcherNote: note };
  }
  if (fieldType === "boolean") {
    if (typeof input.value !== "boolean") throw new DomainError("VALIDATION_ERROR", "Boolean extraction values must be true or false");
    return { valueState: state, textValue: null, numberValue: null, booleanValue: input.value, optionId: null, researcherNote: note };
  }
  if (typeof input.value !== "string") throw new DomainError("VALIDATION_ERROR", "Single-select extraction values must reference an option");
  return { valueState: state, textValue: null, numberValue: null, booleanValue: null, optionId: input.value, researcherNote: note };
}
