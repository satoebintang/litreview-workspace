import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { claimEvidence, claims } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  claimEvidenceInputSchema,
  createClaimSchema,
  createPaperSchema,
  createProjectSchema,
  idSchema,
  recordEvidenceSchema,
  type CreateClaimInput,
  type CreatePaperInput,
  type CreateProjectInput,
  type RecordEvidenceInput,
} from "@/domain/validation";
import {
  ClaimEvidenceRepository,
  ClaimRepository,
  EvidenceRepository,
  PaperRepository,
  ProjectRepository,
} from "./repositories";

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

export function createReviewServices(db: Database) {
  const projectRepo = new ProjectRepository(db);
  const paperRepo = new PaperRepository(db);
  const evidenceRepo = new EvidenceRepository(db);
  const claimRepo = new ClaimRepository(db);
  const linkRepo = new ClaimEvidenceRepository(db);

  async function requireProject(projectId: string) {
    ensureId(projectId);
    const project = await projectRepo.findById(projectId);
    if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return project;
  }

  async function requirePaper(projectId: string, paperId: string) {
    await requireProject(projectId);
    ensureId(paperId);
    const paper = await paperRepo.findById(projectId, paperId);
    if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    return paper;
  }

  async function requireEvidence(projectId: string, evidenceId: string) {
    await requireProject(projectId);
    ensureId(evidenceId);
    const item = await evidenceRepo.findById(projectId, evidenceId);
    if (!item) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
    return item;
  }

  async function requireClaim(projectId: string, claimId: string) {
    await requireProject(projectId);
    ensureId(claimId);
    const claim = await claimRepo.findById(projectId, claimId);
    if (!claim) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
    return claim;
  }

  return {
    async createProject(input: CreateProjectInput) {
      const values = validate(createProjectSchema, input);
      return projectRepo.create({ title: values.title, description: values.description ?? null, researchQuestion: values.researchQuestion ?? null });
    },

    getProject(projectId: string) { return requireProject(projectId); },
    listPapers(projectId: string) { return requireProject(projectId).then(() => paperRepo.list(projectId)); },
    listEvidence(projectId: string) { return requireProject(projectId).then(() => evidenceRepo.list(projectId)); },
    listClaims(projectId: string) { return requireProject(projectId).then(() => claimRepo.list(projectId)); },

    async addPaper(projectId: string, input: CreatePaperInput) {
      await requireProject(projectId);
      const values = validate(createPaperSchema, input);
      return paperRepo.create({ projectId, ...values, publicationYear: values.publicationYear ?? null, venue: values.venue ?? null, doi: values.doi ?? null, abstract: values.abstract ?? null, bibliographicNote: values.bibliographicNote ?? null });
    },

    async recordEvidence(projectId: string, input: RecordEvidenceInput) {
      const values = validate(recordEvidenceSchema, input);
      await requirePaper(projectId, values.paperId);
      return evidenceRepo.create({ projectId, ...values, note: values.note ?? null });
    },

    async createClaim(projectId: string, input: CreateClaimInput) {
      await requireProject(projectId);
      const values = validate(createClaimSchema, input);
      return claimRepo.create({ projectId, claimText: values.claimText });
    },

    async linkEvidenceToClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireClaim(projectId, values.claimId);
      await requireEvidence(projectId, values.evidenceId);
      try {
        return await linkRepo.create({ projectId, claimId: values.claimId, evidenceId: values.evidenceId });
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DUPLICATE_LINK", "Evidence is already linked to this claim");
        throw error;
      }
    },

    async unlinkEvidenceFromClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireClaim(projectId, values.claimId);
      await requireEvidence(projectId, values.evidenceId);
      const deleted = await linkRepo.delete(projectId, values.claimId, values.evidenceId);
      if (deleted.length === 0) throw new DomainError("NOT_FOUND", "Evidence link was not found");
      return deleted[0];
    },

    async deletePaper(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      if (await evidenceRepo.countForPaper(projectId, paperId)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted while evidence exists");
      try { return await paperRepo.delete(projectId, paperId); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted while evidence exists"); throw error; }
    },

    async deleteEvidence(projectId: string, evidenceId: string) {
      await requireEvidence(projectId, evidenceId);
      if (await linkRepo.countForEvidence(projectId, evidenceId)) throw new DomainError("PROTECTED_DELETE", "Evidence cannot be deleted while linked to a claim");
      try { return await evidenceRepo.delete(projectId, evidenceId); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("PROTECTED_DELETE", "Evidence cannot be deleted while linked to a claim"); throw error; }
    },

    async deleteClaim(projectId: string, claimId: string) {
      await requireClaim(projectId, claimId);
      return db.transaction(async (tx) => {
        await tx.delete(claimEvidence).where(and(eq(claimEvidence.projectId, projectId), eq(claimEvidence.claimId, claimId)));
        const deleted = await tx.delete(claims).where(and(eq(claims.projectId, projectId), eq(claims.id, claimId))).returning({ id: claims.id });
        return deleted[0];
      });
    },

    async getClaimProvenance(projectId: string, claimId: string) {
      const claim = await requireClaim(projectId, claimId);
      const links = await linkRepo.listForClaim(projectId, claimId);
      const linked = await Promise.all(links.map(async (link) => {
        const item = await evidenceRepo.findById(projectId, link.evidenceId);
        if (!item) throw new DomainError("DATABASE_CONSTRAINT", "Evidence provenance is inconsistent");
        const paper = await paperRepo.findById(projectId, item.paperId);
        if (!paper) throw new DomainError("DATABASE_CONSTRAINT", "Paper provenance is inconsistent");
        return { evidence: item, paper };
      }));
      return { claim, supportStatus: linked.length > 0 ? "supported" as const : "unsupported" as const, evidence: linked };
    },
  };
}
