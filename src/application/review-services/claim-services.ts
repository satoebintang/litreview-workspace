import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { synthesisStatements } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  claimEvidenceInputSchema,
  createClaimFromInterpretationSchema,
  createClaimSchema,
  createClaimWithSynthesisSupportSchema,
  createClaimRevisionSchema,
  withdrawClaimSchema,
  type CreateClaimFromInterpretationInput,
  type CreateClaimInput,
  type CreateClaimRevisionInput,
  type CreateClaimWithSynthesisSupportInput,
  type WithdrawClaimInput,
} from "@/domain/validation";
import type {
  ClaimRevisionRepository,
  ClaimRevisionSupportRepository,
  EvidenceRepository,
  PaperRepository,
  SynthesisRevisionRepository,
  SynthesisRevisionSupportRepository,
} from "../repositories";
import { requireEvidenceUsableForNewDirectSupport } from "../evidence-curation-services";
import { lockExtractionRevisionPapers } from "../synthesis-writer";
import { createEvidenceReviewHelpers } from "./evidence-helpers";
import { mapEvidence, mapExtractionRevision, mapField, mapPaper, mapScreeningState } from "./mappers";
import { createSynthesisProjectionHelpers } from "./synthesis-projection-helpers";
import { ClaimSupportSnapshot, ReviewTransaction, SqlExecutor, evidenceCurationWarning, evidenceReviewState, ensureId, validate } from "./shared";

export function createClaimServices<TProject, TClaim, TEvidence, TInterpretationServices extends {
  getSynthesisInterpretationSnapshot(projectId: string, interpretationId: string): Promise<{ synthesisRevisionId: string }>;
}>(deps: {
  db: Database;
  paperRepo: PaperRepository;
  evidenceRepo: EvidenceRepository;
  claimRevisionRepo: ClaimRevisionRepository;
  claimRevisionSupportRepo: ClaimRevisionSupportRepository;
  synthesisRevisionRepo: SynthesisRevisionRepository;
  synthesisSupportRepo: SynthesisRevisionSupportRepository;
  requireProject: (projectId: string) => Promise<TProject>;
  requireClaim: (projectId: string, claimId: string) => Promise<TClaim>;
  requireEvidence: (projectId: string, evidenceId: string) => Promise<TEvidence>;
  getSynthesisInterpretationServices: () => TInterpretationServices;
}) {
  const { db, paperRepo, evidenceRepo, claimRevisionRepo, claimRevisionSupportRepo, synthesisRevisionRepo, synthesisSupportRepo, requireProject, requireClaim, requireEvidence, getSynthesisInterpretationServices } = deps;
  const { currentEvidenceReviewRows, enrichEvidenceDocuments } = createEvidenceReviewHelpers(db);
  const { synthesisViewsForRevisions } = createSynthesisProjectionHelpers(synthesisSupportRepo, enrichEvidenceDocuments);
  async function currentClaimRevision(executor: SqlExecutor | ReviewTransaction, projectId: string, claimId: string) {
    const rows = await executor.execute(sql`select id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at from claim_revisions where project_id=${projectId} and claim_id=${claimId} and finalized_at is not null order by sequence desc limit 1`);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  function mapClaimRevision(row: Record<string, unknown>) {
    return { id: String(row.id ?? row.revision_id), sequence: Number(row.sequence), projectId: String(row.project_id), claimId: String(row.claim_id), lifecycle: String(row.state) as "active" | "withdrawn", claimText: row.claim_text == null ? null : String(row.claim_text), researcherNote: row.researcher_note == null ? null : String(row.researcher_note), createdAt: row.created_at as Date, finalizedAt: row.finalized_at as Date | null };
  }

  async function validateClaimSupports(projectId: string, supports: ClaimSupportSnapshot[], executor: SqlExecutor | ReviewTransaction) {
    const directEvidenceIds = supports
      .filter((support) => support.kind === "evidence")
      .map((support) => String(support.evidenceId))
      .sort();
    for (const evidenceId of directEvidenceIds) {
      await requireEvidenceUsableForNewDirectSupport(executor, projectId, evidenceId);
    }
    for (const support of supports) {
      const id = support.kind === "evidence" ? support.evidenceId : support.kind === "extractionRevision" ? support.extractionRevisionId : support.synthesisRevisionId;
      if (!id) throw new DomainError("VALIDATION_ERROR", "A support target is required");
      ensureId(id);
      if (support.kind === "evidence") {
        const rows = await executor.execute(sql`select id from evidence where project_id=${projectId} and id=${id}`);
        if (!(rows as unknown[]).length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
      } else if (support.kind === "extractionRevision") {
        const rows = await executor.execute(sql`select r.finalized_at, r.value_state,
          coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened') as screening_state,
          (select fd.decision from full_text_screening_decisions fd where fd.project_id=r.project_id and fd.paper_id=r.paper_id order by fd.sequence desc limit 1) as full_text_state
          from extraction_value_revisions r where r.project_id=${projectId} and r.id=${id}`) as unknown as Record<string, unknown>[];
        if (!rows.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction revision does not belong to this project");
        if (!rows[0].finalized_at) throw new DomainError("VALIDATION_ERROR", "Claim support must use a finalized extraction revision");
        if (String(rows[0].value_state) === "cleared") throw new DomainError("VALIDATION_ERROR", "Cleared extraction revisions cannot support a new claim");
        if (String(rows[0].screening_state) !== "include" || String(rows[0].full_text_state) !== "include") throw new DomainError("VALIDATION_ERROR", "New extraction support is limited to currently finally included papers");
      } else {
        const rows = await executor.execute(sql`select r.finalized_at, r.state, (select current_r.state from synthesis_revisions current_r where current_r.project_id=r.project_id and current_r.synthesis_statement_id=r.synthesis_statement_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) as current_statement_state from synthesis_revisions r where r.project_id=${projectId} and r.id=${id}`) as unknown as Record<string, unknown>[];
        if (!rows.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis revision does not belong to this project");
        if (!rows[0].finalized_at || String(rows[0].state) !== "active") throw new DomainError("VALIDATION_ERROR", "New synthesis support must use a finalized active revision");
        if (String(rows[0].current_statement_state) !== "active") throw new DomainError("VALIDATION_ERROR", "Withdrawn synthesis statements cannot support a new claim");
      }
    }
  }

  async function createClaimRevisionSnapshot(projectId: string, claimId: string, input: CreateClaimRevisionInput, tx: ReviewTransaction) {
    const values = validate(createClaimRevisionSchema, input);
    const supports = (values.supports ?? []) as ClaimSupportSnapshot[];
    await lockExtractionRevisionPapers(tx, projectId, supports.filter((support) => support.kind === "extractionRevision").map((support) => String(support.extractionRevisionId)), paperRepo);
    const locked = await claimRevisionRepo.findForUpdate(tx, projectId, claimId);
    if (!locked) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
    const current = await currentClaimRevision(tx, projectId, claimId);
    if (values.expectedCurrentRevisionId !== undefined && (values.expectedCurrentRevisionId ?? null) !== (current ? String(current.id) : null)) throw new DomainError("VALIDATION_ERROR", "Claim changed while this revision was being prepared");
    await validateClaimSupports(projectId, supports, tx);
    const draft = await claimRevisionRepo.createDraft(tx, { projectId, claimId, state: values.lifecycle ?? "active", claimText: values.claimText ?? null, researcherNote: values.researcherNote ?? null });
    if (!draft) throw new DomainError("DATABASE_CONSTRAINT", "Claim revision could not be created");
    for (const support of supports) {
      if (support.kind === "evidence") await claimRevisionSupportRepo.createEvidence(tx, { projectId, claimRevisionId: String(draft.id), evidenceId: String(support.evidenceId) });
      else if (support.kind === "extractionRevision") await claimRevisionSupportRepo.createExtraction(tx, { projectId, claimRevisionId: String(draft.id), extractionRevisionId: String(support.extractionRevisionId) });
      else await claimRevisionSupportRepo.createSynthesis(tx, { projectId, claimRevisionId: String(draft.id), synthesisRevisionId: String(support.synthesisRevisionId) });
    }
    const finalized = await claimRevisionRepo.finalize(tx, projectId, String(draft.id));
    if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Claim revision could not be finalized");
    return mapClaimRevision(finalized);
  }

  async function claimRevisionView(projectId: string, revisionRow: Record<string, unknown>) {
    const revision = mapClaimRevision(revisionRow);
    const raw = await claimRevisionSupportRepo.listForRevision(projectId, revision.id);
    const directEvidence = await enrichEvidenceDocuments(raw.evidence.map((row) => mapEvidence(row)));
    const direct = raw.evidence.map((row, index) => ({
      projectId, claimRevisionId: revision.id, evidenceId: String(row.evidence_id), createdAt: row.support_created_at as Date,
      evidence: { evidence: directEvidence[index], paper: mapPaper(row) },
    }));
    const extractionIds = raw.extraction.map((row) => String(row.revision_id));
    const extractionEvidenceRows = extractionIds.length ? await db.execute(sql`
      select x.revision_id, e.*
      from extraction_revision_evidence x join evidence e on e.project_id=x.project_id and e.paper_id=x.paper_id and e.id=x.evidence_id
      where x.project_id=${projectId} and x.revision_id in (${sql.join(extractionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by x.revision_id, e.page_number, e.created_at
    `) as unknown as Record<string, unknown>[] : [];
    const mappedExtractionEvidence = await enrichEvidenceDocuments(extractionEvidenceRows.map(mapEvidence));
    const evidenceByRevision = new Map<string, ReturnType<typeof mapEvidence>[]>();
    for (let i = 0; i < extractionEvidenceRows.length; i += 1) {
      const row = extractionEvidenceRows[i];
      evidenceByRevision.set(String(row.revision_id), [...(evidenceByRevision.get(String(row.revision_id)) ?? []), mappedExtractionEvidence[i]]);
    }
    const extraction = raw.extraction.map((row) => ({
      projectId, claimRevisionId: revision.id, extractionRevisionId: String(row.revision_id), createdAt: row.support_created_at as Date,
      extractionRevision: mapExtractionRevision(row, evidenceByRevision.get(String(row.revision_id)) ?? []), paper: mapPaper(row), field: mapField(row),
      isCurrentExtractionRevision: Boolean(row.is_current_extraction_revision), paperScreeningState: mapScreeningState(row.screening_state) as "unscreened" | "included" | "excluded" | "maybe",
    }));
    const synthesisIds = raw.synthesis.map((row) => String(row.revision_id));
    const synthesisRows = synthesisIds.length ? await db.execute(sql`
      select r.id, r.sequence, r.project_id, r.synthesis_statement_id, r.state, r.title, r.statement_text, r.researcher_note, r.created_at, r.finalized_at,
        s.created_at as statement_created_at,
        (select current_r.state from synthesis_revisions current_r where current_r.project_id=r.project_id and current_r.synthesis_statement_id=r.synthesis_statement_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) as current_statement_state
      from synthesis_revisions r join synthesis_statements s on s.project_id=r.project_id and s.id=r.synthesis_statement_id
      where r.project_id=${projectId} and r.id in (${sql.join(synthesisIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `) as unknown as Record<string, unknown>[] : [];
    const synthesisById = new Map(synthesisRows.map((row) => [String(row.id), row]));
    const statementMap = new Map(synthesisRows.map((row) => [String(row.synthesis_statement_id), { id: String(row.synthesis_statement_id), projectId, createdAt: row.statement_created_at as Date } as typeof synthesisStatements.$inferSelect]));
    const synthesisViews = await synthesisViewsForRevisions(projectId, statementMap, synthesisRows.map((row) => ({ id: String(row.id), sequence: Number(row.sequence), projectId, synthesisStatementId: String(row.synthesis_statement_id), state: String(row.state) as "active" | "withdrawn", title: row.title as string | null, statementText: row.statement_text as string | null, researcherNote: row.researcher_note as string | null, createdAt: row.created_at as Date, finalizedAt: row.finalized_at as Date | null })));
    const synthesisViewById = new Map(synthesisViews.map((view) => [view.id, view]));
    const synthesis = raw.synthesis.map((row) => {
      const item = synthesisById.get(String(row.revision_id));
      const view = synthesisViewById.get(String(row.revision_id));
      if (!item || !view) throw new DomainError("DATABASE_CONSTRAINT", "Synthesis provenance is inconsistent");
      return { projectId, claimRevisionId: revision.id, synthesisRevisionId: String(row.revision_id), createdAt: row.support_created_at as Date, synthesisRevision: view, statement: statementMap.get(String(item.synthesis_statement_id)), isCurrentSynthesisRevision: Boolean(row.is_current_synthesis_revision), statementLifecycle: String(row.current_statement_state ?? item.state) as "active" | "withdrawn" };
    });
    const paperPaths = new Map<string, { paper: ReturnType<typeof mapPaper>; pathCount: number; kinds: Set<"evidence" | "extractionRevision" | "synthesisRevision">; paths: string[] }>();
    const addPath = (paper: ReturnType<typeof mapPaper>, kind: "evidence" | "extractionRevision" | "synthesisRevision", targetId: string) => {
      const existing = paperPaths.get(paper.id);
      if (existing) { existing.pathCount += 1; existing.kinds.add(kind); existing.paths.push(`${kind}:${targetId}`); } else paperPaths.set(paper.id, { paper, pathCount: 1, kinds: new Set([kind]), paths: [`${kind}:${targetId}`] });
    };
    for (const item of direct) addPath(item.evidence.paper, "evidence", item.evidenceId);
    for (const item of extraction) {
      const paper = item.paper;
      for (let i = 0; i < item.extractionRevision.evidence.length; i += 1) addPath(paper, "extractionRevision", item.extractionRevisionId);
    }
    for (const item of synthesis) {
      for (const support of item.synthesisRevision.supports) {
        for (let i = 0; i < support.extractionRevision.evidence.length; i += 1) addPath(support.paper, "synthesisRevision", item.synthesisRevisionId);
      }
    }
    const citationCandidates = [...paperPaths.values()].map((item) => ({ paper: item.paper, pathCount: item.pathCount, supportKinds: [...item.kinds], paths: item.paths }));
    return {
      ...revision, supportStatus: revision.lifecycle === "active" && (direct.length + extraction.length + synthesis.length) > 0 ? "supported" as const : "unsupported" as const,
      supports: { evidence: direct, extractionRevisions: extraction, synthesisRevisions: synthesis },
      totalSupportCount: direct.length + extraction.length + synthesis.length, directEvidenceCount: direct.length,
      extractionRevisionCount: extraction.length, synthesisRevisionCount: synthesis.length,
      distinctPaperCount: new Set([...direct.map((item) => item.evidence.paper.id), ...extraction.map((item) => item.paper.id), ...synthesis.flatMap((item) => item.synthesisRevision.supports.map((support) => support.paper.id))]).size,
      citationCandidateCount: citationCandidates.length, citationCandidates,
    };
  }
  return {
    async listClaims(projectId: string) {
      await requireProject(projectId);
      const rows = await claimRevisionRepo.listCurrent(projectId);
      return Promise.all(rows.map(async (row) => {
        const revision = await claimRevisionView(projectId, { id: row.revision_id, sequence: row.sequence, project_id: row.project_id, claim_id: row.claim_id, state: row.state, claim_text: row.claim_text, researcher_note: row.researcher_note, created_at: row.created_at, finalized_at: row.finalized_at });
        const claim = { id: String(row.claim_id), projectId, claimText: revision.claimText ?? "", createdAt: row.claim_created_at as Date, updatedAt: row.claim_created_at as Date };
        return { ...claim, claim, currentRevision: revision, lifecycle: revision.lifecycle, supportStatus: revision.supportStatus, citationCandidateCount: revision.citationCandidateCount, distinctPaperCount: revision.distinctPaperCount };
      }));
    },

    async listClaimSupportOptions(projectId: string) {
      await requireProject(projectId);
      const [papers, evidence, extractionRows, synthesisRows] = await Promise.all([
        paperRepo.list(projectId), evidenceRepo.list(projectId),
        db.execute(sql`
          select r.id as revision_id, r.sequence as revision_sequence, r.project_id, r.paper_id, r.field_id, r.extraction_value_id,
            r.field_type, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id, r.researcher_note as revision_note,
            r.created_at as revision_created_at, r.finalized_at as revision_finalized_at,
            p.id as paper_id_value, p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note,
            p.created_at as paper_created_at, p.updated_at as paper_updated_at,
            f.id as field_id_value, f.name as field_name, f.description as field_description, f.field_type as field_type_value,
            f.required, f.sort_order, f.created_at as field_created_at, f.updated_at as field_updated_at, f.archived_at as field_archived_at,
            coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened') as screening_state,
            (select fd.decision from full_text_screening_decisions fd where fd.project_id=r.project_id and fd.paper_id=r.paper_id order by fd.sequence desc limit 1) as full_text_state
          from extraction_value_revisions r join papers p on p.project_id=r.project_id and p.id=r.paper_id
          join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
          where r.project_id=${projectId} and r.finalized_at is not null and r.value_state <> 'cleared'
            and coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened')='include'
            and (select fd.decision from full_text_screening_decisions fd where fd.project_id=r.project_id and fd.paper_id=r.paper_id order by fd.sequence desc limit 1)='include'
          order by r.sequence desc
        `) as unknown as Record<string, unknown>[],
        synthesisRevisionRepo.list(projectId),
      ]);
      const paperById = new Map(papers.map((paper) => [paper.id, paper]));
      const currentReviewRows = await currentEvidenceReviewRows(projectId);
      const currentReviewByEvidenceId = new Map(currentReviewRows.map((row) => [String(row.evidence_id), String(row.decision)]));
      const evidenceOptions = evidence
        .filter((item) => currentReviewByEvidenceId.get(item.id) !== "rejected")
        .map((item) => ({
          ...item,
          paper: paperById.get(item.paperId) ?? null,
          reviewState: evidenceReviewState(currentReviewByEvidenceId.get(item.id)),
          curationWarning: evidenceCurationWarning(evidenceReviewState(currentReviewByEvidenceId.get(item.id))),
        }));
      const extractionIds = extractionRows.map((row) => String(row.revision_id));
      const extractionEvidenceRows = extractionIds.length ? await db.execute(sql`select l.revision_id, e.*
        from extraction_revision_evidence l join evidence e on e.project_id=l.project_id and e.id=l.evidence_id
        where l.project_id=${projectId} and l.revision_id in (${sql.join(extractionIds.map((id) => sql`${id}::uuid`), sql`, `)}) order by l.revision_id, e.page_number`) as unknown as Record<string, unknown>[] : [];
      const mappedExtractionEvidence = await enrichEvidenceDocuments(extractionEvidenceRows.map(mapEvidence));
      const extractionEvidenceById = new Map<string, ReturnType<typeof mapEvidence>[]>();
      for (let i = 0; i < extractionEvidenceRows.length; i += 1) {
        const row = extractionEvidenceRows[i];
        extractionEvidenceById.set(String(row.revision_id), [...(extractionEvidenceById.get(String(row.revision_id)) ?? []), mappedExtractionEvidence[i]]);
      }
      const extractionOptions = extractionRows.map((row) => ({ ...mapExtractionRevision(row, extractionEvidenceById.get(String(row.revision_id)) ?? []), paper: mapPaper(row), field: mapField(row), paperScreeningState: mapScreeningState(row.screening_state) }));
      const statementRows = synthesisRows.length ? await db.execute(sql`select id, project_id, created_at from synthesis_statements where project_id=${projectId} and id in (${sql.join(synthesisRows.map((row) => sql`${row.synthesisStatementId}::uuid`), sql`, `)})`) as unknown as typeof synthesisStatements.$inferSelect[] : [];
      const statementMap = new Map(statementRows.map((statement) => [statement.id, statement]));
      const activeStatementRows = await db.execute(sql`select distinct on (synthesis_statement_id) synthesis_statement_id, state from synthesis_revisions where project_id=${projectId} and finalized_at is not null order by synthesis_statement_id, sequence desc`) as unknown as Record<string, unknown>[];
      const activeStatementIds = new Set(activeStatementRows.filter((row) => String(row.state) === "active").map((row) => String(row.synthesis_statement_id)));
      const syntheses = (await synthesisViewsForRevisions(projectId, statementMap, synthesisRows)).filter((view) => view.state === "active" && activeStatementIds.has(view.synthesisStatementId));
      return { evidence: evidenceOptions, extraction: extractionOptions, synthesis: syntheses };
    },

    async createClaim(projectId: string, input: CreateClaimInput) {
      await requireProject(projectId);
      const values = validate(createClaimSchema, input);
      const result = await db.transaction(async (tx) => {
        const claim = await claimRevisionRepo.createClaim(tx, projectId);
        if (!claim) throw new DomainError("DATABASE_CONSTRAINT", "Claim could not be created");
        const revision = await createClaimRevisionSnapshot(projectId, String(claim.id), { lifecycle: "active", claimText: values.claimText, researcherNote: values.researcherNote ?? null, supports: [] }, tx);
        return { claim, revision };
      });
      return { id: String(result.claim.id), projectId, claimText: values.claimText, createdAt: result.claim.created_at as Date, updatedAt: result.claim.created_at as Date, claim: { id: String(result.claim.id), projectId, claimText: values.claimText, createdAt: result.claim.created_at as Date, updatedAt: result.claim.created_at as Date }, revision: result.revision };
    },

    async createClaimWithSynthesisSupport(projectId: string, input: CreateClaimWithSynthesisSupportInput) {
      await requireProject(projectId);
      const values = validate(createClaimWithSynthesisSupportSchema, input);
      const result = await db.transaction(async (tx) => {
        const claim = await claimRevisionRepo.createClaim(tx, projectId);
        if (!claim) throw new DomainError("DATABASE_CONSTRAINT", "Claim could not be created");
        const revision = await createClaimRevisionSnapshot(
          projectId,
          String(claim.id),
          {
            lifecycle: "active",
            claimText: values.claimText,
            researcherNote: values.researcherNote ?? null,
            supports: [
              {
                kind: "synthesisRevision",
                synthesisRevisionId: values.synthesisRevisionId,
              },
            ],
          },
          tx,
        );
        return { claim, revision };
      });
      return {
        id: String(result.claim.id),
        projectId,
        claimText: values.claimText,
        createdAt: result.claim.created_at as Date,
        updatedAt: result.claim.created_at as Date,
        claim: {
          id: String(result.claim.id),
          projectId,
          claimText: values.claimText,
          createdAt: result.claim.created_at as Date,
          updatedAt: result.claim.created_at as Date,
        },
        revision: result.revision,
      };
    },

    async createClaimFromInterpretation(projectId: string, input: CreateClaimFromInterpretationInput) {
      await requireProject(projectId);
      const values = validate(createClaimFromInterpretationSchema, input);
      const interp = await getSynthesisInterpretationServices().getSynthesisInterpretationSnapshot(projectId, values.interpretationId);
      if (values.synthesisRevisionId && values.synthesisRevisionId !== interp.synthesisRevisionId) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis revision does not match the interpretation snapshot");
      }
      return this.createClaimWithSynthesisSupport(projectId, {
        claimText: values.claimText,
        researcherNote: values.researcherNote ?? null,
        synthesisRevisionId: interp.synthesisRevisionId,
      });
    },

    async createClaimRevision(projectId: string, claimId: string, input: CreateClaimRevisionInput) {
      await requireProject(projectId); ensureId(claimId);
      const revision = await db.transaction((tx) => createClaimRevisionSnapshot(projectId, claimId, input, tx));
      return this.getClaimRevision(projectId, claimId, revision.id);
    },

    async withdrawClaim(projectId: string, claimId: string, input?: WithdrawClaimInput) {
      await requireProject(projectId); ensureId(claimId);
      const values = validate(withdrawClaimSchema, input ?? {});
      const result = await db.transaction(async (tx) => {
        const locked = await claimRevisionRepo.findForUpdate(tx, projectId, claimId);
        if (!locked) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
        const current = await currentClaimRevision(tx, projectId, claimId);
        if (values.expectedCurrentRevisionId !== undefined && (values.expectedCurrentRevisionId ?? null) !== (current ? String(current.id) : null)) throw new DomainError("VALIDATION_ERROR", "Claim changed while withdrawal was being prepared");
        if (current && String(current.state) === "withdrawn" && (current.researcher_note ?? null) === (values.researcherNote ?? null)) return mapClaimRevision(current);
        return createClaimRevisionSnapshot(projectId, claimId, { lifecycle: "withdrawn", claimText: null, researcherNote: values.researcherNote ?? null, supports: [], expectedCurrentRevisionId: current ? String(current.id) : null }, tx);
      });
      return this.getClaimRevision(projectId, claimId, result.id);
    },

    async reactivateClaim(projectId: string, claimId: string, input: CreateClaimRevisionInput) {
      const values = { ...input, lifecycle: "active" as const };
      return this.createClaimRevision(projectId, claimId, values);
    },

    async getCurrentClaim(projectId: string, claimId: string) {
      await requireProject(projectId); ensureId(claimId);
      const claim = await requireClaim(projectId, claimId);
      const revision = await currentClaimRevision(db, projectId, claimId);
      if (!revision) throw new DomainError("NOT_FOUND", "Claim has no finalized revision");
      return { claim: { ...claim, claimText: revision.claim_text == null ? "" : String(revision.claim_text) }, currentRevision: await claimRevisionView(projectId, revision) };
    },

    async getClaimRevision(projectId: string, claimId: string, revisionId: string) {
      await requireProject(projectId); ensureId(claimId); ensureId(revisionId);
      const claim = await requireClaim(projectId, claimId);
      const rows = await db.execute(sql`select id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at from claim_revisions where project_id=${projectId} and claim_id=${claimId} and id=${revisionId} and finalized_at is not null`) as unknown as Record<string, unknown>[];
      if (!rows.length) throw new DomainError("NOT_FOUND", "Claim revision was not found");
      return { claim: { ...claim, claimText: rows[0].claim_text == null ? "" : String(rows[0].claim_text) }, revision: await claimRevisionView(projectId, rows[0]) };
    },

    async getClaimHistory(projectId: string, claimId: string) {
      await requireProject(projectId); ensureId(claimId);
      const claim = await requireClaim(projectId, claimId);
      const rows = await claimRevisionRepo.history(projectId, claimId);
      return { claim, revisions: await Promise.all(rows.map((row) => claimRevisionView(projectId, row))) };
    },

    async linkEvidenceToClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireEvidence(projectId, values.evidenceId);
      try {
        const current = await this.getCurrentClaim(projectId, values.claimId);
        if (current.currentRevision.supports.evidence.some((item) => item.evidenceId === values.evidenceId)) {
          throw new DomainError("DUPLICATE_LINK", "Evidence is already linked to this claim");
        }
        const supports = [
          ...current.currentRevision.supports.evidence.map((item) => ({ kind: "evidence" as const, evidenceId: item.evidenceId })),
          ...current.currentRevision.supports.extractionRevisions.map((item) => ({ kind: "extractionRevision" as const, extractionRevisionId: item.extractionRevisionId })),
          ...current.currentRevision.supports.synthesisRevisions.map((item) => ({ kind: "synthesisRevision" as const, synthesisRevisionId: item.synthesisRevisionId })),
          { kind: "evidence" as const, evidenceId: values.evidenceId },
        ];
        return await this.createClaimRevision(projectId, values.claimId, { lifecycle: "active", claimText: current.currentRevision.claimText, researcherNote: current.currentRevision.researcherNote, supports, expectedCurrentRevisionId: current.currentRevision.id });
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DUPLICATE_LINK", "Evidence is already linked to this claim");
        throw error;
      }
    },

    async unlinkEvidenceFromClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireEvidence(projectId, values.evidenceId);
      const current = await this.getCurrentClaim(projectId, values.claimId);
      const existing = current.currentRevision.supports.evidence.some((item) => item.evidenceId === values.evidenceId);
      if (!existing) throw new DomainError("NOT_FOUND", "Evidence link was not found");
      const supports = [
        ...current.currentRevision.supports.evidence.filter((item) => item.evidenceId !== values.evidenceId).map((item) => ({ kind: "evidence" as const, evidenceId: item.evidenceId })),
        ...current.currentRevision.supports.extractionRevisions.map((item) => ({ kind: "extractionRevision" as const, extractionRevisionId: item.extractionRevisionId })),
        ...current.currentRevision.supports.synthesisRevisions.map((item) => ({ kind: "synthesisRevision" as const, synthesisRevisionId: item.synthesisRevisionId })),
      ];
      return this.createClaimRevision(projectId, values.claimId, { lifecycle: current.currentRevision.lifecycle, claimText: current.currentRevision.claimText, researcherNote: current.currentRevision.researcherNote, supports, expectedCurrentRevisionId: current.currentRevision.id });
    },

    async deleteClaim(projectId: string, claimId: string) {
      await requireClaim(projectId, claimId);
      throw new DomainError("PROTECTED_DELETE", "Claims with revision history cannot be deleted; withdraw the claim instead");
    },

    async getClaimProvenance(projectId: string, claimId: string) {
      const result = await this.getCurrentClaim(projectId, claimId);
      return { claim: result.claim, supportStatus: result.currentRevision.supportStatus, evidence: result.currentRevision.supports.evidence.map((item) => item.evidence) };
    },
  };
}
