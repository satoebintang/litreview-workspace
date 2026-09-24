import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { retrievedRecordMatches } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import { createPaperSchema, createProjectSchema, type CreatePaperInput, type CreateProjectInput } from "@/domain/validation";
import type { EvidenceRepository, PaperRepository, ProjectRepository, ScreeningDecisionRepository } from "../repositories";
import { findPaperCandidates, writePaper } from "../paper-writer";
import { validate } from "./shared";

export function createProjectPaperServices<TProject, TPaper>(deps: {
  db: Database;
  projectRepo: ProjectRepository;
  paperRepo: PaperRepository;
  decisionRepo: ScreeningDecisionRepository;
  evidenceRepo: EvidenceRepository;
  requireProject: (projectId: string) => Promise<TProject>;
  requirePaper: (projectId: string, paperId: string) => Promise<TPaper>;
}) {
  const { db, projectRepo, paperRepo, decisionRepo, evidenceRepo, requireProject, requirePaper } = deps;
  return {
    async createProject(input: CreateProjectInput) {
      const values = validate(createProjectSchema, input);
      return projectRepo.create({ title: values.title, description: values.description ?? null });
    },

    getProject(projectId: string) { return requireProject(projectId); },

    listPapers(projectId: string) { return requireProject(projectId).then(() => paperRepo.list(projectId)); },

    getPaper(projectId: string, paperId: string) { return requirePaper(projectId, paperId); },

    async addPaper(projectId: string, input: CreatePaperInput & { distinctPaperAcknowledged?: boolean; candidatePaperIds?: string[] }) {
      await requireProject(projectId);
      const values = validate(createPaperSchema, input);
      // Manual reviewed creation is the only workflow that uses the new
      // project intake lock. Acquisition and deduplication keep their own
      // RetrievedRecord/pair lock order and never enter this path.
      return db.transaction(async (tx) => {
        const lockedProject = await tx.execute(sql`select id from projects where id=${projectId} for update`);
        if (!(lockedProject as unknown as unknown[]).length) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        const candidateRows = await findPaperCandidates(tx, projectId, values);
        const candidateIds = candidateRows.map((row) => String(row.id));
        if (candidateIds.length > 0) {
          const submittedIds = [...new Set(input.candidatePaperIds ?? [])].sort();
          const expectedIds = [...candidateIds].sort();
          if (!input.distinctPaperAcknowledged || submittedIds.join(",") !== expectedIds.join(",")) {
            throw new DomainError("DUPLICATE_REVIEW_REQUIRED", "Review candidate Papers before creating a distinct Paper", { candidates: candidateRows });
          }
        }
        return writePaper(tx, projectId, {
          title: values.title,
          authors: values.authors,
          publicationYear: values.publicationYear ?? null,
          venue: values.venue ?? null,
          doi: values.doi ?? null,
          abstract: values.abstract ?? null,
          bibliographicNote: values.bibliographicNote ?? null,
        }, { source: "manual" });
      });
    },

    async findManualPaperCandidates(projectId: string, input: CreatePaperInput) {
      await requireProject(projectId);
      const values = validate(createPaperSchema, input);
      return (await findPaperCandidates(db, projectId, values)).map((row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        title: String(row.title),
        authors: Array.isArray(row.authors) ? row.authors.map(String) : [],
        publicationYear: row.publication_year == null ? null : Number(row.publication_year),
        venue: row.venue == null ? null : String(row.venue),
        doi: row.doi == null ? null : String(row.doi),
        abstract: row.abstract == null ? null : String(row.abstract),
        candidateReason: String(row.candidate_reason),
      }));
    },

    async deletePaper(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      if (await evidenceRepo.countForPaper(projectId, paperId)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted while evidence exists");
      if (await decisionRepo.countForPaper(projectId, paperId)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after screening decisions exist");
      const acquisitionLinks = await db.select({ id: retrievedRecordMatches.id }).from(retrievedRecordMatches).where(and(eq(retrievedRecordMatches.projectId, projectId), eq(retrievedRecordMatches.paperId, paperId))).limit(1);
      if (acquisitionLinks.length) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after acquisition history exists");
      try { return await paperRepo.delete(projectId, paperId); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after evidence or screening history exists"); throw error; }
    },
  };
}
