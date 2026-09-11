import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appendEvidenceAnnotationSchema,
  appendEvidenceReviewDecisionSchema,
  createEvidenceLabelSchema,
  evidenceWorkspaceFilterSchema,
} from "@/domain/validation";
import { DomainError, isConstraintError } from "@/domain/errors";
import type {
  EvidenceAnnotation,
  EvidenceLabel,
  EvidenceLabelEvent,
  EvidenceReviewDecision,
  EvidenceReviewDecisionValue,
  EvidenceReviewState,
} from "@/domain/types";

type SqlExecutor = Pick<Database, "execute">;

export type EvidenceWorkspaceFilter = {
  state?: "attention" | "unreviewed" | "needs_review" | "accepted" | "rejected" | "all";
  paperId?: string;
  labelId?: string;
  fullTextDocumentId?: string;
  documentProvenance?: "any" | "none" | "document" | "extraction";
  documentTextExtractionId?: string;
  pageNumber?: number;
  usage?: "any" | "used" | "unused";
  page?: number;
  pageSize?: number;
};

type Dependencies = {
  requireProject: (projectId: string) => Promise<unknown>;
  requireEvidence: (projectId: string, evidenceId: string) => Promise<unknown>;
};

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return value as Row[];
}

function ensureUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`);
  }
  return value;
}

function mapReview(row: Row): EvidenceReviewDecision {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    evidenceId: String(row.evidence_id),
    decision: String(row.decision) as EvidenceReviewDecisionValue,
    note: row.note == null ? null : String(row.note),
    createdAt: row.created_at as Date,
  };
}

function mapAnnotation(row: Row): EvidenceAnnotation {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    evidenceId: String(row.evidence_id),
    body: String(row.body),
    createdAt: row.created_at as Date,
  };
}

function mapLabel(row: Row): EvidenceLabel {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    createdAt: row.created_at as Date,
    archivedAt: row.archived_at as Date | null,
  };
}

function mapLabelEvent(row: Row): EvidenceLabelEvent {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    evidenceId: String(row.evidence_id),
    labelId: String(row.label_id),
    event: String(row.event) as EvidenceLabelEvent["event"],
    createdAt: row.created_at as Date,
  };
}

function deriveReviewState(decision: string | null | undefined): EvidenceReviewState {
  return decision === "needs_review" || decision === "accepted" || decision === "rejected" ? decision : "unreviewed";
}

function warningsForState(state: EvidenceReviewState) {
  if (state === "unreviewed") return ["never_reviewed"] as const;
  if (state === "needs_review") return ["needs_review"] as const;
  if (state === "rejected") return ["currently_rejected"] as const;
  return [] as const;
}

/**
 * The application-side direct-support gate. The SELECT FOR UPDATE is the
 * shared Evidence-row serialization boundary with review decisions and the
 * database trigger in 0016.
 */
export async function requireEvidenceUsableForNewDirectSupport(executor: SqlExecutor, projectId: string, evidenceId: string) {
  const locked = rows(await executor.execute(sql`
    select id from evidence
    where project_id=${projectId} and id=${evidenceId}
    for update
  `));
  if (!locked.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
  const latest = rows(await executor.execute(sql`
    select decision from evidence_review_decisions
    where project_id=${projectId} and evidence_id=${evidenceId}
    order by sequence desc
    limit 1
  `))[0];
  if (latest && String(latest.decision) === "rejected") {
    throw new DomainError("VALIDATION_ERROR", "Rejected Evidence cannot be used as new direct support");
  }
  return deriveReviewState(latest ? String(latest.decision) : null);
}

function mapEvidence(row: Row) {
  const documentId = row.full_text_document_id == null ? null : String(row.full_text_document_id);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    paperId: String(row.paper_id),
    sourceText: String(row.source_text),
    pageNumber: Number(row.page_number),
    fullTextDocumentId: documentId,
    documentTextExtractionId: row.document_text_extraction_id == null ? null : String(row.document_text_extraction_id),
    extractionStartOffset: row.extraction_start_offset == null ? null : Number(row.extraction_start_offset),
    extractionEndOffset: row.extraction_end_offset == null ? null : Number(row.extraction_end_offset),
    note: row.note == null ? null : String(row.note),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    paper: row.paper_id == null ? null : {
      id: String(row.paper_id),
      title: String(row.paper_title ?? "Untitled paper"),
      authors: Array.isArray(row.authors) ? row.authors as string[] : [],
      publicationYear: row.publication_year == null ? null : Number(row.publication_year),
      venue: row.venue == null ? null : String(row.venue),
      doi: row.doi == null ? null : String(row.doi),
    },
    document: documentId && row.document_original_filename != null ? {
      id: documentId,
      originalFilename: String(row.document_original_filename),
      sha256: String(row.document_sha256),
      archivedAt: row.document_archived_at as Date | null,
    } : null,
  };
}

export function createEvidenceCurationServices(db: Database, dependencies: Dependencies) {
  async function requireProject(projectId: string) {
    ensureUuid(projectId, "Project");
    await dependencies.requireProject(projectId);
  }

  async function requireIds(projectId: string, evidenceId: string) {
    await requireProject(projectId);
    ensureUuid(evidenceId, "Evidence");
    await dependencies.requireEvidence(projectId, evidenceId);
  }

  async function lockEvidence(tx: SqlExecutor, projectId: string, evidenceId: string) {
    const locked = rows(await tx.execute(sql`
      select id from evidence where project_id=${projectId} and id=${evidenceId} for update
    `));
    if (!locked.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
  }

  async function lockLabel(tx: SqlExecutor, projectId: string, labelId: string) {
    const locked = rows(await tx.execute(sql`
      select id, project_id, name, description, created_at, archived_at
      from evidence_labels where project_id=${projectId} and id=${labelId} for update
    `));
    if (!locked.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence label does not belong to this project");
    return locked[0];
  }

  async function currentReview(projectId: string, evidenceId: string, executor: SqlExecutor = db) {
    const latest = rows(await executor.execute(sql`
      select id, sequence, project_id, evidence_id, decision, note, created_at
      from evidence_review_decisions
      where project_id=${projectId} and evidence_id=${evidenceId}
      order by sequence desc
      limit 1
    `))[0];
    return latest ? mapReview(latest) : null;
  }

  async function currentLabels(projectId: string, evidenceId: string, executor: SqlExecutor = db) {
    const labelRows = rows(await executor.execute(sql`
      with current_events as (
        select distinct on (project_id, evidence_id, label_id) project_id, evidence_id, label_id, event, sequence
        from evidence_label_events
        where project_id=${projectId} and evidence_id=${evidenceId}
        order by project_id, evidence_id, label_id, sequence desc
      )
      select l.id, l.project_id, l.name, l.description, l.created_at, l.archived_at
      from current_events ce
      join evidence_labels l on l.project_id=ce.project_id and l.id=ce.label_id
      where ce.event='assigned'
      order by lower(l.name), l.id
    `));
    return labelRows.map(mapLabel);
  }

  async function labelEvents(projectId: string, evidenceId: string) {
    const eventRows = rows(await db.execute(sql`
      select id, sequence, project_id, evidence_id, label_id, event, created_at
      from evidence_label_events
      where project_id=${projectId} and evidence_id=${evidenceId}
      order by sequence asc
    `));
    return eventRows.map(mapLabelEvent);
  }

  async function baseEvidence(projectId: string, evidenceId: string) {
    const result = rows(await db.execute(sql`
      select e.id, e.project_id, e.paper_id, e.full_text_document_id, e.document_text_extraction_id,
        e.source_text, e.page_number, e.extraction_start_offset, e.extraction_end_offset, e.note,
        e.created_at, e.updated_at,
        p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi,
        d.original_filename as document_original_filename, d.sha256 as document_sha256, d.archived_at as document_archived_at
      from evidence e
      join papers p on p.project_id=e.project_id and p.id=e.paper_id
      left join full_text_documents d on d.project_id=e.project_id and d.paper_id=e.paper_id and d.id=e.full_text_document_id
      where e.project_id=${projectId} and e.id=${evidenceId}
      limit 1
    `));
    if (!result[0]) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
    return mapEvidence(result[0]);
  }

  async function listEvidenceReviewHistory(projectId: string, evidenceId: string) {
    await requireIds(projectId, evidenceId);
    const result = rows(await db.execute(sql`
      select id, sequence, project_id, evidence_id, decision, note, created_at
      from evidence_review_decisions
      where project_id=${projectId} and evidence_id=${evidenceId}
      order by sequence asc
    `));
    return result.map(mapReview);
  }

  async function listEvidenceAnnotations(projectId: string, evidenceId: string) {
    await requireIds(projectId, evidenceId);
    const result = rows(await db.execute(sql`
      select id, sequence, project_id, evidence_id, body, created_at
      from evidence_annotations
      where project_id=${projectId} and evidence_id=${evidenceId}
      order by sequence asc
    `));
    return result.map(mapAnnotation);
  }

  async function listEvidenceLabels(projectId: string, includeArchived = true) {
    await requireProject(projectId);
    const result = rows(await db.execute(sql`
      select id, project_id, name, description, created_at, archived_at
      from evidence_labels
      where project_id=${projectId} ${includeArchived ? sql`` : sql`and archived_at is null`}
      order by archived_at is not null, lower(name), id
    `));
    return result.map(mapLabel);
  }

  async function listEvidenceLabelHistory(projectId: string, evidenceId: string) {
    await requireIds(projectId, evidenceId);
    return labelEvents(projectId, evidenceId);
  }

  async function listEvidenceDownstreamUsage(projectId: string, evidenceId: string) {
    await requireIds(projectId, evidenceId);
    const [extractionRows, synthesisRows, directClaimRows, extractionClaimRows, synthesisClaimRows, manuscriptRows] = await Promise.all([
      db.execute(sql`
        select r.id, r.sequence, r.project_id, r.paper_id, r.field_id, f.name as field_name,
          r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id,
          r.finalized_at
        from extraction_revision_evidence l
        join extraction_value_revisions r on r.project_id=l.project_id and r.id=l.revision_id
        join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
        where l.project_id=${projectId} and l.evidence_id=${evidenceId}
        order by r.sequence asc
      `),
      db.execute(sql`
        select distinct sr.id, sr.sequence, sr.project_id, sr.synthesis_statement_id, sr.state, sr.title, sr.statement_text, sr.finalized_at
        from synthesis_revision_supports l
        join synthesis_revisions sr on sr.project_id=l.project_id and sr.id=l.synthesis_revision_id
        join extraction_revision_evidence er on er.project_id=l.project_id and er.revision_id=l.extraction_revision_id
        where l.project_id=${projectId} and er.evidence_id=${evidenceId}
        order by sr.sequence asc
      `),
      db.execute(sql`
        select cr.id as claim_revision_id, cr.sequence, cr.claim_id, cr.state, cr.claim_text
        from claim_revision_evidence_supports l
        join claim_revisions cr on cr.project_id=l.project_id and cr.id=l.claim_revision_id
        where l.project_id=${projectId} and l.evidence_id=${evidenceId}
        order by cr.sequence asc
      `),
      db.execute(sql`
        select distinct cr.id as claim_revision_id, cr.sequence, cr.claim_id, cr.state, cr.claim_text
        from claim_revision_extraction_supports l
        join claim_revisions cr on cr.project_id=l.project_id and cr.id=l.claim_revision_id
        join extraction_revision_evidence er on er.project_id=l.project_id and er.revision_id=l.extraction_revision_id
        where l.project_id=${projectId} and er.evidence_id=${evidenceId}
        order by cr.sequence asc
      `),
      db.execute(sql`
        select distinct cr.id as claim_revision_id, cr.sequence, cr.claim_id, cr.state, cr.claim_text
        from claim_revision_synthesis_supports l
        join claim_revisions cr on cr.project_id=l.project_id and cr.id=l.claim_revision_id
        join synthesis_revision_supports sr on sr.project_id=l.project_id and sr.synthesis_revision_id=l.synthesis_revision_id
        join extraction_revision_evidence er on er.project_id=l.project_id and er.revision_id=sr.extraction_revision_id
        where l.project_id=${projectId} and er.evidence_id=${evidenceId}
        order by cr.sequence asc
      `),
      db.execute(sql`
        select p.id, p.claim_id, p.claim_revision_id, p.manuscript_id, p.section_id, p.created_at, p.removed_at
        from manuscript_claim_placements p
        where p.project_id=${projectId} and p.claim_revision_id in (
          select l.claim_revision_id from claim_revision_evidence_supports l where l.project_id=${projectId} and l.evidence_id=${evidenceId}
          union
          select l.claim_revision_id from claim_revision_extraction_supports l join extraction_revision_evidence er on er.project_id=l.project_id and er.revision_id=l.extraction_revision_id where l.project_id=${projectId} and er.evidence_id=${evidenceId}
          union
          select l.claim_revision_id from claim_revision_synthesis_supports l join synthesis_revision_supports sr on sr.project_id=l.project_id and sr.synthesis_revision_id=l.synthesis_revision_id join extraction_revision_evidence er on er.project_id=l.project_id and er.revision_id=sr.extraction_revision_id where l.project_id=${projectId} and er.evidence_id=${evidenceId}
        )
        order by p.created_at asc, p.id
      `),
    ]);
    const extraction = rows(extractionRows).map((row) => ({ id: String(row.id), sequence: Number(row.sequence), paperId: String(row.paper_id), fieldId: String(row.field_id), fieldName: String(row.field_name), valueState: String(row.value_state), finalizedAt: row.finalized_at as Date | null }));
    const synthesis = rows(synthesisRows).map((row) => ({ id: String(row.id), sequence: Number(row.sequence), statementId: String(row.synthesis_statement_id), state: String(row.state), title: row.title == null ? null : String(row.title), statementText: row.statement_text == null ? null : String(row.statement_text), finalizedAt: row.finalized_at as Date | null }));
    const directClaims = rows(directClaimRows).map((row) => ({ id: String(row.claim_revision_id), sequence: Number(row.sequence), claimId: String(row.claim_id), state: String(row.state), claimText: row.claim_text == null ? null : String(row.claim_text), path: "directEvidence" as const }));
    const extractionClaims = rows(extractionClaimRows).map((row) => ({ id: String(row.claim_revision_id), sequence: Number(row.sequence), claimId: String(row.claim_id), state: String(row.state), claimText: row.claim_text == null ? null : String(row.claim_text), path: "extractionRevision" as const }));
    const synthesisClaims = rows(synthesisClaimRows).map((row) => ({ id: String(row.claim_revision_id), sequence: Number(row.sequence), claimId: String(row.claim_id), state: String(row.state), claimText: row.claim_text == null ? null : String(row.claim_text), path: "synthesisRevision" as const }));
    const claims = [...directClaims, ...extractionClaims, ...synthesisClaims].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id && candidate.path === item.path) === index);
    const manuscript = rows(manuscriptRows).map((row) => ({ id: String(row.id), claimId: String(row.claim_id), claimRevisionId: String(row.claim_revision_id), manuscriptId: String(row.manuscript_id), sectionId: String(row.section_id), createdAt: row.created_at as Date, removedAt: row.removed_at as Date | null }));
    return {
      extractionRevisions: extraction,
      synthesisRevisions: synthesis,
      claimRevisions: claims,
      manuscriptPlacements: manuscript,
      counts: { extractionRevisions: extraction.length, synthesisRevisions: synthesis.length, claimRevisions: new Set(claims.map((item) => item.id)).size, manuscriptPlacements: manuscript.length },
    };
  }

  async function listEvidenceWorkspace(projectId: string, input: EvidenceWorkspaceFilter = {}) {
    const parsed = evidenceWorkspaceFilterSchema.safeParse(input);
    if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence workspace filters are invalid", parsed.error.issues);
    const filter = parsed.data;
    await requireProject(projectId);
    const conditions = [sql`e.project_id=${projectId}`];
    const state = filter.state ?? "attention";
    if (state === "attention") conditions.push(sql`(cr.decision is null or cr.decision='needs_review')`);
    else if (state === "unreviewed") conditions.push(sql`cr.decision is null`);
    else if (state !== "all") conditions.push(sql`cr.decision=${state}`);
    if (filter.paperId) conditions.push(sql`e.paper_id=${filter.paperId}`);
    if (filter.fullTextDocumentId) conditions.push(sql`e.full_text_document_id=${filter.fullTextDocumentId}`);
    if (filter.documentTextExtractionId) conditions.push(sql`e.document_text_extraction_id=${filter.documentTextExtractionId}`);
    if (filter.pageNumber) conditions.push(sql`e.page_number=${filter.pageNumber}`);
    if (filter.documentProvenance === "none") conditions.push(sql`e.full_text_document_id is null`);
    if (filter.documentProvenance === "document") conditions.push(sql`e.full_text_document_id is not null and e.document_text_extraction_id is null`);
    if (filter.documentProvenance === "extraction") conditions.push(sql`e.document_text_extraction_id is not null`);
    if (filter.labelId) conditions.push(sql`exists (
      select 1 from current_label_events cle
      where cle.project_id=e.project_id and cle.evidence_id=e.id and cle.label_id=${filter.labelId} and cle.event='assigned'
    )`);
    if (filter.usage === "used") conditions.push(sql`exists (
      select 1 from extraction_revision_evidence eu where eu.project_id=e.project_id and eu.evidence_id=e.id
      union all
      select 1 from claim_revision_evidence_supports cu where cu.project_id=e.project_id and cu.evidence_id=e.id
      union all
      select 1 from claim_revision_extraction_supports ce
        join extraction_revision_evidence er on er.project_id=ce.project_id and er.revision_id=ce.extraction_revision_id
        where ce.project_id=e.project_id and er.evidence_id=e.id
      union all
      select 1 from synthesis_revision_supports ss
        join extraction_revision_evidence er on er.project_id=ss.project_id and er.revision_id=ss.extraction_revision_id
        where ss.project_id=e.project_id and er.evidence_id=e.id
      union all
      select 1 from claim_revision_synthesis_supports cs
        join synthesis_revision_supports ss on ss.project_id=cs.project_id and ss.synthesis_revision_id=cs.synthesis_revision_id
        join extraction_revision_evidence er on er.project_id=ss.project_id and er.revision_id=ss.extraction_revision_id
        where cs.project_id=e.project_id and er.evidence_id=e.id
    )`);
    if (filter.usage === "unused") conditions.push(sql`not exists (
      select 1 from extraction_revision_evidence eu where eu.project_id=e.project_id and eu.evidence_id=e.id
      union all
      select 1 from claim_revision_evidence_supports cu where cu.project_id=e.project_id and cu.evidence_id=e.id
      union all
      select 1 from claim_revision_extraction_supports ce
        join extraction_revision_evidence er on er.project_id=ce.project_id and er.revision_id=ce.extraction_revision_id
        where ce.project_id=e.project_id and er.evidence_id=e.id
      union all
      select 1 from synthesis_revision_supports ss
        join extraction_revision_evidence er on er.project_id=ss.project_id and er.revision_id=ss.extraction_revision_id
        where ss.project_id=e.project_id and er.evidence_id=e.id
      union all
      select 1 from claim_revision_synthesis_supports cs
        join synthesis_revision_supports ss on ss.project_id=cs.project_id and ss.synthesis_revision_id=cs.synthesis_revision_id
        join extraction_revision_evidence er on er.project_id=ss.project_id and er.revision_id=ss.extraction_revision_id
        where cs.project_id=e.project_id and er.evidence_id=e.id
    )`);
    const where = sql.join(conditions, sql` and `);
    const limit = filter.pageSize ?? 50;
    const offset = ((filter.page ?? 1) - 1) * limit;
    const result = rows(await db.execute(sql`
      with current_review as (
        select distinct on (project_id, evidence_id) project_id, evidence_id, decision, id as decision_id, sequence
        from evidence_review_decisions
        where project_id=${projectId}
        order by project_id, evidence_id, sequence desc
      ), current_label_events as (
        select distinct on (project_id, evidence_id, label_id) project_id, evidence_id, label_id, event, sequence
        from evidence_label_events
        where project_id=${projectId}
        order by project_id, evidence_id, label_id, sequence desc
      )
      select e.id, e.project_id, e.paper_id, e.full_text_document_id, e.document_text_extraction_id,
        e.source_text, e.page_number, e.extraction_start_offset, e.extraction_end_offset, e.note,
        e.created_at, e.updated_at,
        p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi,
        d.original_filename as document_original_filename, d.sha256 as document_sha256, d.archived_at as document_archived_at,
        cr.decision, cr.decision_id, cr.sequence as decision_sequence,
        count(*) over() as total_count
      from evidence e
      join papers p on p.project_id=e.project_id and p.id=e.paper_id
      left join full_text_documents d on d.project_id=e.project_id and d.paper_id=e.paper_id and d.id=e.full_text_document_id
      left join current_review cr on cr.project_id=e.project_id and cr.evidence_id=e.id
      where ${where}
      order by e.created_at asc, e.id asc
      limit ${limit} offset ${offset}
    `));
    const evidence = result.map((row) => {
      const item = mapEvidence(row);
      const reviewState = deriveReviewState(row.decision == null ? null : String(row.decision));
      return { ...item, reviewState, latestDecisionId: row.decision_id == null ? null : String(row.decision_id), warnings: warningsForState(reviewState) };
    });
    const labels = await Promise.all(evidence.map((item) => currentLabels(projectId, item.id)));
    const usage = await Promise.all(evidence.map(async (item) => {
      const usageRows = rows(await db.execute(sql`
        select (exists(select 1 from extraction_revision_evidence where project_id=${projectId} and evidence_id=${item.id})
          or exists(select 1 from claim_revision_evidence_supports where project_id=${projectId} and evidence_id=${item.id})
          or exists(select 1 from claim_revision_extraction_supports ce
            join extraction_revision_evidence er on er.project_id=ce.project_id and er.revision_id=ce.extraction_revision_id
            where ce.project_id=${projectId} and er.evidence_id=${item.id})
          or exists(select 1 from synthesis_revision_supports ss
            join extraction_revision_evidence er on er.project_id=ss.project_id and er.revision_id=ss.extraction_revision_id
            where ss.project_id=${projectId} and er.evidence_id=${item.id})
          or exists(select 1 from claim_revision_synthesis_supports cs
            join synthesis_revision_supports ss on ss.project_id=cs.project_id and ss.synthesis_revision_id=cs.synthesis_revision_id
            join extraction_revision_evidence er on er.project_id=ss.project_id and er.revision_id=ss.extraction_revision_id
            where cs.project_id=${projectId} and er.evidence_id=${item.id})) as used
      `));
      return Boolean(usageRows[0]?.used);
    }));
    return {
      items: evidence.map((item, index) => ({ ...item, labels: labels[index], usage: usage[index] ? "used" as const : "unused" as const })),
      page: filter.page ?? 1,
      pageSize: limit,
      total: result[0] ? Number(result[0].total_count) : 0,
    };
  }

  async function getEvidenceCurationDetail(projectId: string, evidenceId: string) {
    await requireIds(projectId, evidenceId);
    const evidence = await baseEvidence(projectId, evidenceId);
    const [latest, reviewHistory, annotations, labels, labelHistory, usage] = await Promise.all([
      currentReview(projectId, evidenceId),
      listEvidenceReviewHistory(projectId, evidenceId),
      listEvidenceAnnotations(projectId, evidenceId),
      currentLabels(projectId, evidenceId),
      labelEvents(projectId, evidenceId),
      listEvidenceDownstreamUsage(projectId, evidenceId),
    ]);
    const reviewState = deriveReviewState(latest?.decision);
    return { evidence, reviewState, warnings: warningsForState(reviewState), latestReview: latest, reviewHistory, annotations, labels, labelHistory, usage };
  }

  return {
    async getEvidenceReviewState(projectId: string, evidenceId: string) {
      await requireIds(projectId, evidenceId);
      const latest = await currentReview(projectId, evidenceId);
      const state = deriveReviewState(latest?.decision);
      return { state, latestDecision: latest, warnings: warningsForState(state) };
    },

    listEvidenceReviewHistory,
    listEvidenceAnnotations,
    listEvidenceLabelHistory,
    listEvidenceLabels,
    listEvidenceDownstreamUsage,
    listEvidenceWorkspace,
    getEvidenceCurationDetail,

    async appendEvidenceReviewDecision(projectId: string, evidenceId: string, input: { decision: EvidenceReviewDecisionValue; note?: string | null }) {
      await requireIds(projectId, evidenceId);
      const parsed = appendEvidenceReviewDecisionSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Review decision is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        await lockEvidence(tx, projectId, evidenceId);
        const inserted = rows(await tx.execute(sql`
          insert into evidence_review_decisions (project_id, evidence_id, decision, note)
          values (${projectId}, ${evidenceId}, ${parsed.data.decision}, ${parsed.data.note ?? null})
          returning id, sequence, project_id, evidence_id, decision, note, created_at
        `));
        return mapReview(inserted[0]);
      });
    },

    async appendEvidenceAnnotation(projectId: string, evidenceId: string, input: { body: string }) {
      await requireIds(projectId, evidenceId);
      const parsed = appendEvidenceAnnotationSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Annotation is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        await lockEvidence(tx, projectId, evidenceId);
        const inserted = rows(await tx.execute(sql`
          insert into evidence_annotations (project_id, evidence_id, body)
          values (${projectId}, ${evidenceId}, ${parsed.data.body})
          returning id, sequence, project_id, evidence_id, body, created_at
        `));
        return mapAnnotation(inserted[0]);
      });
    },

    async createEvidenceLabel(projectId: string, input: { name: string; description?: string | null }) {
      await requireProject(projectId);
      const parsed = createEvidenceLabelSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence label is invalid", parsed.error.issues);
      try {
        const inserted = rows(await db.execute(sql`
          insert into evidence_labels (project_id, name, description)
          values (${projectId}, ${parsed.data.name}, ${parsed.data.description ?? null})
          returning id, project_id, name, description, created_at, archived_at
        `));
        return mapLabel(inserted[0]);
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "An active Evidence label with this name already exists");
        throw error;
      }
    },

    async archiveEvidenceLabel(projectId: string, labelId: string) {
      await requireProject(projectId);
      ensureUuid(labelId, "Evidence label");
      return db.transaction(async (tx) => {
        const label = await lockLabel(tx, projectId, labelId);
        if (label.archived_at) return mapLabel(label);
        const updated = rows(await tx.execute(sql`
          update evidence_labels set archived_at=now()
          where project_id=${projectId} and id=${labelId}
          returning id, project_id, name, description, created_at, archived_at
        `));
        return mapLabel(updated[0]);
      });
    },

    async assignEvidenceLabel(projectId: string, evidenceId: string, labelId: string) {
      await requireIds(projectId, evidenceId);
      ensureUuid(labelId, "Evidence label");
      return db.transaction(async (tx) => {
        await lockEvidence(tx, projectId, evidenceId);
        const label = await lockLabel(tx, projectId, labelId);
        if (label.archived_at) throw new DomainError("VALIDATION_ERROR", "Archived Evidence labels cannot be assigned");
        const latest = rows(await tx.execute(sql`
          select event from evidence_label_events where project_id=${projectId} and evidence_id=${evidenceId} and label_id=${labelId} order by sequence desc limit 1
        `))[0];
        if (latest?.event === "assigned") throw new DomainError("DUPLICATE_LINK", "Evidence label is already assigned");
        const inserted = rows(await tx.execute(sql`
          insert into evidence_label_events (project_id, evidence_id, label_id, event)
          values (${projectId}, ${evidenceId}, ${labelId}, 'assigned')
          returning id, sequence, project_id, evidence_id, label_id, event, created_at
        `));
        return mapLabelEvent(inserted[0]);
      });
    },

    async removeEvidenceLabel(projectId: string, evidenceId: string, labelId: string) {
      await requireIds(projectId, evidenceId);
      ensureUuid(labelId, "Evidence label");
      return db.transaction(async (tx) => {
        await lockEvidence(tx, projectId, evidenceId);
        await lockLabel(tx, projectId, labelId);
        const latest = rows(await tx.execute(sql`
          select event from evidence_label_events where project_id=${projectId} and evidence_id=${evidenceId} and label_id=${labelId} order by sequence desc limit 1
        `))[0];
        if (latest?.event !== "assigned") throw new DomainError("NOT_FOUND", "Evidence label is not currently assigned");
        const inserted = rows(await tx.execute(sql`
          insert into evidence_label_events (project_id, evidence_id, label_id, event)
          values (${projectId}, ${evidenceId}, ${labelId}, 'removed')
          returning id, sequence, project_id, evidence_id, label_id, event, created_at
        `));
        return mapLabelEvent(inserted[0]);
      });
    },
  };
}
