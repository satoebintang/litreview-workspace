/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import { papers, projects, retrievedRecordMatches, retrievedRecords } from "@/db/schema";
import { canonicalizeDeduplicationPair, type DeduplicationDecisionValue, type DeduplicationPairInput } from "@/domain/deduplication";
import { DomainError, isConstraintError } from "@/domain/errors";
import { createPaperSchema, idSchema } from "@/domain/validation";
import { DeduplicationDecisionRepository } from "./deduplication-repositories";

const resolutionInput = z.object({ paperId: idSchema.optional(), createFromRecordId: idSchema.optional(), overrides: createPaperSchema.partial().optional() }).refine((v) => Boolean(v.paperId || v.createFromRecordId), "Resolution requires a Paper or source record");

function id(value: string) { const parsed = idSchema.safeParse(value); if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID", parsed.error.issues); return parsed.data; }
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Input failed validation", parsed.error.issues); return parsed.data; }
function pair(left: string | DeduplicationPairInput, right?: string): DeduplicationPairInput {
  try { return canonicalizeDeduplicationPair(typeof left === "string" ? { leftRetrievedRecordId: left, rightRetrievedRecordId: right ?? "" } : left); }
  catch (error) { throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid record pair"); }
}
function decision(row: any) { return row == null ? null : { id: String(row.id), sequence: Number(row.sequence), projectId: String(row.projectId ?? row.project_id), leftRetrievedRecordId: String(row.leftRetrievedRecordId ?? row.left_retrieved_record_id), rightRetrievedRecordId: String(row.rightRetrievedRecordId ?? row.right_retrieved_record_id), decision: row.decision as DeduplicationDecisionValue, note: row.note ?? null, createdAt: row.createdAt ?? row.created_at }; }
function mapRecordSide(row: any, side: "left" | "right") {
  return { id: String(row[`${side}_record_id`]), title: String(row[`${side}_title`]), authors: row[`${side}_authors`] ?? [], abstract: row[`${side}_abstract`] ?? null, doi: row[`${side}_doi`] ?? null, sourceRecordId: row[`${side}_source_record_id`] ?? null, searchRunId: String(row[`${side}_search_run_id`]), searchSourceId: String(row[`${side}_search_source_id`]), publicationYear: row[`${side}_publication_year`] == null ? null : Number(row[`${side}_publication_year`]) };
}
function mapPair(row: any) {
  if (!row) return null;
  const left = row.left_title === undefined ? null : mapRecordSide(row, "left");
  const right = row.right_title === undefined ? null : mapRecordSide(row, "right");
  return {
    leftRetrievedRecord: left, rightRetrievedRecord: right,
    reasons: row.reasons ?? [], strength: row.strength ?? null,
    decision: row.decision ?? null, decisionNote: row.decision_note ?? null,
    decisionSequence: row.decision_sequence == null ? null : Number(row.decision_sequence),
    leftPaperId: row.left_paper_id == null ? null : String(row.left_paper_id), rightPaperId: row.right_paper_id == null ? null : String(row.right_paper_id),
  };
}

export function createDeduplicationServices(db: Database) {
  const repo = new DeduplicationDecisionRepository(db);
  async function requireProject(projectId: string, tx: any = db) { id(projectId); const [p] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1); if (!p) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found"); return p; }
  async function requireRecord(projectId: string, recordId: string, tx: any = db) { id(recordId); const [r] = await tx.select().from(retrievedRecords).where(and(eq(retrievedRecords.projectId, projectId), eq(retrievedRecords.id, recordId))).limit(1); if (!r) throw new DomainError("CROSS_PROJECT_REFERENCE", "Retrieved record does not belong to this project"); return r; }
  async function requirePaper(projectId: string, paperId: string, tx: any = db) { id(paperId); const [p] = await tx.select().from(papers).where(and(eq(papers.projectId, projectId), eq(papers.id, paperId))).limit(1); if (!p) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project"); return p; }
  async function currentMatch(tx: any, projectId: string, recordId: string) { const rows = await tx.execute(sql`select paper_id, action from retrieved_record_matches where project_id=${projectId} and retrieved_record_id=${recordId} order by sequence desc limit 1`); const row = (rows as any[])[0]; return row?.action === "linked" ? String(row.paper_id) : null; }
  async function appendMatch(tx: any, projectId: string, recordId: string, paperId: string, action: "linked" | "unlinked") { try { const [row] = await tx.insert(retrievedRecordMatches).values({ projectId, retrievedRecordId: recordId, paperId, action }).returning(); return row; } catch (error) { if (isConstraintError(error)) throw new DomainError("VALIDATION_ERROR", "Retrieved record match is not valid in its current state"); throw error; } }
  async function writeDecision(projectId: string, p: DeduplicationPairInput, value: DeduplicationDecisionValue, note: string | null | undefined, resolution?: unknown) {
    await requireProject(projectId);
    return db.transaction(async (tx) => {
      const locked = await repo.lockPair(tx, projectId, p.leftRetrievedRecordId, p.rightRetrievedRecordId);
      if ((locked as any[]).length !== 2) throw new DomainError("CROSS_PROJECT_REFERENCE", "Both RetrievedRecords must belong to this project");
      await requireRecord(projectId, p.leftRetrievedRecordId, tx); await requireRecord(projectId, p.rightRetrievedRecordId, tx);
      const leftPaper = await currentMatch(tx, projectId, p.leftRetrievedRecordId); const rightPaper = await currentMatch(tx, projectId, p.rightRetrievedRecordId);
      if (value === "same_work" && leftPaper && rightPaper && leftPaper !== rightPaper) throw new DomainError("VALIDATION_ERROR", "same_work conflicts with distinct canonical Papers");
      if (value === "different_work" && leftPaper && rightPaper && leftPaper === rightPaper) throw new DomainError("VALIDATION_ERROR", "different_work conflicts with a shared canonical Paper");
      let targetPaper: string | null = leftPaper ?? rightPaper;
      if (resolution !== undefined) {
        const resolved = parse(resolutionInput, resolution);
        if (resolved.paperId) { await requirePaper(projectId, resolved.paperId, tx); targetPaper = resolved.paperId; }
        else if (resolved.createFromRecordId) {
          const source = await requireRecord(projectId, resolved.createFromRecordId, tx);
          const [created] = await tx.insert(papers).values({ projectId, title: resolved.overrides?.title ?? source.title, authors: resolved.overrides?.authors ?? source.authors, publicationYear: resolved.overrides?.publicationYear ?? source.publicationYear, venue: resolved.overrides?.venue ?? source.venue, doi: resolved.overrides?.doi ?? source.doi, abstract: resolved.overrides?.abstract ?? source.abstract, bibliographicNote: resolved.overrides?.bibliographicNote ?? null }).returning();
          if (!created) throw new DomainError("DATABASE_CONSTRAINT", "Paper could not be created"); targetPaper = String(created.id);
        }
      }
      if (value === "same_work" && resolution !== undefined && !targetPaper) throw new DomainError("VALIDATION_ERROR", "same_work resolution requires a target Paper");
      const inserted = await repo.insert({ projectId, leftRetrievedRecordId: p.leftRetrievedRecordId, rightRetrievedRecordId: p.rightRetrievedRecordId, decision: value, note: note ?? null }, tx);
      if (value === "same_work" && targetPaper) {
        if (!leftPaper) await appendMatch(tx, projectId, p.leftRetrievedRecordId, targetPaper, "linked");
        if (!rightPaper) await appendMatch(tx, projectId, p.rightRetrievedRecordId, targetPaper, "linked");
      }
      return decision(inserted);
    });
  }
  const service = {
    async listDeduplicationQueue(projectId: string) { await requireProject(projectId); return (await repo.listCandidates(projectId, false)).map((r: any) => mapPair(r)); },
    async getDeduplicationPair(projectId: string, left: string, right: string) { await requireProject(projectId); const p = pair(left, right); const row = await repo.pair(projectId, p.leftRetrievedRecordId, p.rightRetrievedRecordId); if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Retrieved record pair was not found"); return mapPair(row); },
    async listDeduplicationHistory(projectId: string, left: string, right: string) { await requireProject(projectId); const p = pair(left, right); await requireRecord(projectId, p.leftRetrievedRecordId); await requireRecord(projectId, p.rightRetrievedRecordId); return (await repo.history(projectId, p.leftRetrievedRecordId, p.rightRetrievedRecordId)).map(decision); },
    async confirmSameWork(projectId: string, left: string | DeduplicationPairInput, rightOrNote?: string, note?: string) { const p = pair(left, typeof left === "string" ? rightOrNote : undefined); const n = typeof left === "string" ? note : rightOrNote; return writeDecision(projectId, p, "same_work", n); },
    async confirmSameWorkAndResolve(projectId: string, left: string | DeduplicationPairInput, rightOrResolution?: string | unknown, resolutionOrNote?: unknown, note?: string) { const p = pair(left, typeof left === "string" && typeof rightOrResolution === "string" ? rightOrResolution : undefined); const resolution = typeof left === "string" ? resolutionOrNote : rightOrResolution; return writeDecision(projectId, p, "same_work", note, resolution); },
    async decideDifferentWork(projectId: string, left: string | DeduplicationPairInput, rightOrNote?: string, note?: string) { const p = pair(left, typeof left === "string" ? rightOrNote : undefined); const n = typeof left === "string" ? note : rightOrNote; return writeDecision(projectId, p, "different_work", n); },
    async correctDifferentWorkAndResolve(projectId: string, left: string | DeduplicationPairInput, rightOrCorrection?: string | unknown, correctionOrNote?: unknown, note?: string) {
      const p = pair(left, typeof left === "string" && typeof rightOrCorrection === "string" ? rightOrCorrection : undefined); const correction: any = typeof left === "string" ? correctionOrNote : rightOrCorrection;
      return db.transaction(async (tx) => {
        const locked = await repo.lockPair(tx, projectId, p.leftRetrievedRecordId, p.rightRetrievedRecordId); if ((locked as any[]).length !== 2) throw new DomainError("CROSS_PROJECT_REFERENCE", "Both RetrievedRecords must belong to this project");
        const leftPaper = await currentMatch(tx, projectId, p.leftRetrievedRecordId); const rightPaper = await currentMatch(tx, projectId, p.rightRetrievedRecordId);
        if (!leftPaper || !rightPaper || leftPaper !== rightPaper) throw new DomainError("VALIDATION_ERROR", "different_work correction requires a shared current Paper");
        const selected = correction?.relinkRecordId ?? correction?.unlinkRecordId; if (selected !== p.leftRetrievedRecordId && selected !== p.rightRetrievedRecordId) throw new DomainError("VALIDATION_ERROR", "Correction must select one RetrievedRecord");
        await appendMatch(tx, projectId, selected, leftPaper, "unlinked");
        if (correction?.relinkRecordId && correction.toPaperId) { await requirePaper(projectId, correction.toPaperId, tx); await appendMatch(tx, projectId, selected, correction.toPaperId, "linked"); }
        const inserted = await repo.insert({ projectId, leftRetrievedRecordId: p.leftRetrievedRecordId, rightRetrievedRecordId: p.rightRetrievedRecordId, decision: "different_work", note: note ?? (typeof correctionOrNote === "string" ? correctionOrNote : null) }, tx);
        return decision(inserted);
      });
    },
    async getReviewFlowSummary(projectId: string) { await requireProject(projectId); const row = await repo.flowSummary(projectId); const reasons = await repo.exclusionReasons(projectId); return { distinctSearchRuns: Number(row?.distinct_search_runs ?? 0), reportedResultsTotal: Number(row?.reported_results_total ?? 0), retrievedRecords: Number(row?.retrieved_records ?? 0), distinctSources: Number(row?.distinct_sources ?? 0), currentlyResolvedRecords: Number(row?.currently_resolved_records ?? 0), unresolvedRecords: Number(row?.unresolved_records ?? 0), unresolvedDuplicatePairs: Number(row?.unresolved_duplicate_pairs ?? 0), sameWorkDecisionPairs: Number(row?.same_work_decision_pairs ?? 0), differentWorkDecisionPairs: Number(row?.different_work_decision_pairs ?? 0), acquisitionDerivedPapers: Number(row?.acquisition_derived_papers ?? 0), duplicateRecordsCollapsed: Number(row?.duplicate_records_collapsed ?? 0), papersInScreeningPopulation: Number(row?.papers_in_screening_population ?? 0), unscreened: Number(row?.unscreened ?? 0), included: Number(row?.included ?? 0), excluded: Number(row?.excluded ?? 0), maybe: Number(row?.maybe ?? 0), fullTextEligible: Number(row?.full_text_eligible ?? 0), fullTextAwaiting: Number(row?.full_text_awaiting ?? 0), fullTextAssessed: Number(row?.full_text_assessed ?? 0), fullTextIncluded: Number(row?.full_text_included ?? 0), fullTextExcluded: Number(row?.full_text_excluded ?? 0), fullTextMaybe: Number(row?.full_text_maybe ?? 0), fullTextConflicts: Number(row?.full_text_conflicts ?? 0), finallyIncluded: Number(row?.finally_included ?? 0), legacyAnalysisAwaitingFullText: Number(row?.legacy_analysis_awaiting_full_text ?? 0), historicalAcquisitionOnlyPapers: Number(row?.historical_acquisition_only_papers ?? 0), manualPapers: Number(row?.manual_papers ?? 0), exclusionReasons: (reasons as any[]).map((r) => ({ criterionId: String(r.exclusion_criterion_id), text: String(r.text), count: Number(r.count) })) }; },
    async listReviewFlowContributors(projectId: string, metric: string) { await requireProject(projectId); return repo.contributors(projectId, metric); },
  };
  return service;
}
