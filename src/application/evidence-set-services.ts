import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appendEvidenceSetAnnotationSchema,
  createEvidenceSetSchema,
  evidenceSetMembershipInputSchema,
  moveEvidenceSetMembershipSchema,
  reorderEvidenceSetSchema,
  updateEvidenceSetMetadataSchema,
  type AppendEvidenceSetAnnotationInput,
  type CreateEvidenceSetInput,
  type MoveEvidenceSetMembershipInput,
  type ReorderEvidenceSetInput,
  type UpdateEvidenceSetMetadataInput,
} from "@/domain/validation";
import { DomainError, isConstraintError } from "@/domain/errors";
import type {
  EvidenceReviewState,
  EvidenceSet,
  EvidenceSetAnnotation,
  EvidenceSetCompositionOperationKind,
  EvidenceSetCompositionRevision,
  EvidenceSetMembership,
} from "@/domain/types";
import { resolveEvidenceSetCompositionRevisionMembers } from "@/application/evidence-set-composition-resolver";

type SqlExecutor = Pick<Database, "execute">;
type ReviewTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
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

const STALE_COMPOSITION_MESSAGE = "This Evidence Set changed in another session. Reload the current composition before continuing.";

function requireExpectedRevisionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("CONCURRENT_MODIFICATION", STALE_COMPOSITION_MESSAGE);
  }
  return value;
}

function mapSet(row: Row): EvidenceSet {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    archivedAt: row.archived_at as Date | null,
  };
}

function mapMembership(row: Row): EvidenceSetMembership {
  return {
    id: String(row.id ?? row.membership_id),
    projectId: String(row.project_id),
    evidenceSetId: String(row.evidence_set_id),
    evidenceId: String(row.evidence_id),
    createdAt: row.created_at as Date,
  };
}

function mapRevision(row: Row): EvidenceSetCompositionRevision {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    evidenceSetId: String(row.evidence_set_id),
    operationKind: String(row.operation_kind) as EvidenceSetCompositionOperationKind,
    createdAt: row.created_at as Date,
  };
}

function mapAnnotation(row: Row): EvidenceSetAnnotation {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    evidenceSetId: String(row.evidence_set_id),
    body: String(row.body),
    createdAt: row.created_at as Date,
  };
}

function deriveReviewState(value: string | null | undefined): EvidenceReviewState {
  return value === "needs_review" || value === "accepted" || value === "rejected" ? value : "unreviewed";
}

function warningsForState(state: EvidenceReviewState) {
  if (state === "unreviewed") return ["never_reviewed"] as const;
  if (state === "needs_review") return ["needs_review"] as const;
  if (state === "rejected") return ["currently_rejected"] as const;
  return [] as const;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapEvidenceRow(row: Row) {
  const documentId = row.full_text_document_id == null ? null : String(row.full_text_document_id);
  const reviewState = deriveReviewState(row.decision == null ? null : String(row.decision));
  const labels = parseJsonArray(row.labels).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (item.id == null || item.name == null) return [];
    return [{ id: String(item.id), name: String(item.name), archivedAt: item.archivedAt == null ? null : new Date(String(item.archivedAt)) }];
  });
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
    paper: {
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
      mediaType: String(row.document_media_type ?? "application/pdf") as "application/pdf",
      byteSize: Number(row.document_byte_size ?? 0),
      sha256: String(row.document_sha256),
      createdAt: row.document_created_at as Date,
      archivedAt: row.document_archived_at as Date | null,
    } : null,
    reviewState,
    curationWarning: warningsForState(reviewState)[0] ?? null,
    labels,
    usage: Boolean(row.used) ? "used" : "unused",
  };
}

type SnapshotMember = {
  membership: EvidenceSetMembership;
  sortOrder: number;
};

type Snapshot = {
  revision: EvidenceSetCompositionRevision;
  members: SnapshotMember[];
};

type CurrentRevision = EvidenceSetCompositionRevision & {
  setOrdinal: number;
  previousRevisionId: string | null;
  headMembershipId: string | null;
  tailMembershipId: string | null;
  memberCount: number;
  distinctPaperCount: number;
};

function publicRevision(revision: CurrentRevision): EvidenceSetCompositionRevision {
  return {
    id: revision.id,
    sequence: revision.sequence,
    projectId: revision.projectId,
    evidenceSetId: revision.evidenceSetId,
    operationKind: revision.operationKind,
    createdAt: revision.createdAt,
  };
}

type Dependencies = {
  requireProject: (projectId: string) => Promise<unknown>;
  requireEvidence: (projectId: string, evidenceId: string) => Promise<unknown>;
};

export function createEvidenceSetServices(db: Database, dependencies: Dependencies) {
  async function requireProject(projectId: string) {
    ensureUuid(projectId, "Project");
    await dependencies.requireProject(projectId);
  }

  async function lockSet(tx: ReviewTransaction, projectId: string, evidenceSetId: string) {
    const result = rows(await tx.execute(sql`
      select id, project_id, name, description, created_at, updated_at, archived_at
      from evidence_sets
      where project_id=${projectId} and id=${evidenceSetId}
      for update
    `));
    if (!result[0]) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
    return mapSet(result[0]);
  }

  async function lockEvidence(tx: ReviewTransaction, projectId: string, evidenceId: string) {
    const result = rows(await tx.execute(sql`
      select id from evidence where project_id=${projectId} and id=${evidenceId} for update
    `));
    if (!result[0]) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
  }

  async function readCurrentRevision(executor: SqlExecutor, projectId: string, evidenceSetId: string): Promise<CurrentRevision> {
    const revisionRows = rows(await executor.execute(sql`
      select id, sequence, project_id, evidence_set_id, operation_kind, created_at,
        set_ordinal, previous_revision_id, head_membership_id, tail_membership_id,
        member_count, distinct_paper_count
      from evidence_set_composition_revisions
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
      order by set_ordinal desc
      limit 1
    `));
    const row = revisionRows[0];
    if (!row) throw new DomainError("DATABASE_CONSTRAINT", "Evidence Set has no composition revision");
    return {
      ...mapRevision(row),
      setOrdinal: Number(row.set_ordinal),
      previousRevisionId: row.previous_revision_id == null ? null : String(row.previous_revision_id),
      headMembershipId: row.head_membership_id == null ? null : String(row.head_membership_id),
      tailMembershipId: row.tail_membership_id == null ? null : String(row.tail_membership_id),
      memberCount: Number(row.member_count),
      distinctPaperCount: Number(row.distinct_paper_count),
    };
  }

  async function readCurrentSnapshot(executor: SqlExecutor, projectId: string, evidenceSetId: string): Promise<Snapshot> {
    const current = await readCurrentRevision(executor, projectId, evidenceSetId);
    const revision: EvidenceSetCompositionRevision = {
      id: current.id,
      sequence: current.sequence,
      projectId: current.projectId,
      evidenceSetId: current.evidenceSetId,
      operationKind: current.operationKind,
      createdAt: current.createdAt,
    };
    const orderedMembers = await resolveEvidenceSetCompositionRevisionMembers(executor, projectId, evidenceSetId, current.id);
    if (!orderedMembers.length) return { revision, members: [] };
    const membershipRows = rows(await executor.execute(sql`
      select id, project_id, evidence_set_id, evidence_id, created_at
      from evidence_set_memberships
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
        and id in (${sql.join(orderedMembers.map((member) => sql`${member.membershipId}::uuid`), sql`, `)})
    `));
    const membershipById = new Map(membershipRows.map((row) => [String(row.id), mapMembership(row)]));
    const members = orderedMembers.map((member) => {
      const membership = membershipById.get(member.membershipId);
      if (!membership) throw new DomainError("DATABASE_CONSTRAINT", "Evidence Set composition references a missing membership");
      return { membership, sortOrder: member.position };
    });
    return { revision, members };
  }

  async function appendRevision(
    tx: ReviewTransaction,
    projectId: string,
    evidenceSetId: string,
    operationKind: EvidenceSetCompositionOperationKind,
    targetMembershipId?: string,
    moveDirection?: "up" | "down",
    reorderedHeadMembershipId?: string,
    reorderedTailMembershipId?: string,
  ) {
    const revisionRows = rows(await tx.execute(sql`
      insert into evidence_set_composition_revisions (
        project_id, evidence_set_id, operation_kind, target_membership_id, move_direction,
        head_membership_id, tail_membership_id
      )
      values (
        ${projectId}, ${evidenceSetId}, ${operationKind}, ${targetMembershipId ?? null},
        ${moveDirection ?? null}, ${reorderedHeadMembershipId ?? null}, ${reorderedTailMembershipId ?? null}
      )
      returning id, sequence, project_id, evidence_set_id, operation_kind, created_at,
        set_ordinal, previous_revision_id, head_membership_id, tail_membership_id,
        member_count, distinct_paper_count
    `));
    const row = revisionRows[0];
    return {
      ...mapRevision(row),
      setOrdinal: Number(row.set_ordinal),
      previousRevisionId: row.previous_revision_id == null ? null : String(row.previous_revision_id),
      headMembershipId: row.head_membership_id == null ? null : String(row.head_membership_id),
      tailMembershipId: row.tail_membership_id == null ? null : String(row.tail_membership_id),
      memberCount: Number(row.member_count),
      distinctPaperCount: Number(row.distinct_paper_count),
    } satisfies CurrentRevision;
  }

  function checkExpectedRevision(current: CurrentRevision, expectedRevisionId: string) {
    if (current.id !== expectedRevisionId) {
      throw new DomainError("CONCURRENT_MODIFICATION", STALE_COMPOSITION_MESSAGE);
    }
  }

  function checkOptionalExpectedRevision(current: CurrentRevision, expectedRevisionId: string | undefined) {
    if (expectedRevisionId !== undefined) checkExpectedRevision(current, expectedRevisionId);
  }

  async function closeOrderVersion(tx: ReviewTransaction, projectId: string, evidenceSetId: string, membershipId: string, ordinal: number) {
    const result = rows(await tx.execute(sql`
      update evidence_set_membership_order_versions
      set valid_to_ordinal=${ordinal}
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
        and membership_id=${membershipId} and valid_to_ordinal is null
      returning membership_id
    `));
    if (result.length !== 1) throw new DomainError("DATABASE_CONSTRAINT", "Expected one current Evidence Set order version to close");
  }

  async function insertOrderVersion(
    tx: ReviewTransaction,
    projectId: string,
    evidenceSetId: string,
    membershipId: string,
    nextMembershipId: string | null,
    ordinal: number,
  ) {
    await tx.execute(sql`
      insert into evidence_set_membership_order_versions (
        project_id, evidence_set_id, membership_id, next_membership_id,
        valid_from_ordinal, valid_to_ordinal
      ) values (
        ${projectId}, ${evidenceSetId}, ${membershipId}, ${nextMembershipId}, ${ordinal}, null
      )
    `);
  }

  async function currentNext(tx: ReviewTransaction, projectId: string, evidenceSetId: string, membershipId: string) {
    const result = rows(await tx.execute(sql`
      select next_membership_id
      from evidence_set_membership_order_versions
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
        and membership_id=${membershipId} and valid_to_ordinal is null
    `));
    if (!result.length) throw new DomainError("NOT_FOUND", "Evidence Set membership is not currently active");
    return result[0].next_membership_id == null ? null : String(result[0].next_membership_id);
  }

  async function currentPredecessor(tx: ReviewTransaction, projectId: string, evidenceSetId: string, membershipId: string) {
    const result = rows(await tx.execute(sql`
      select membership_id
      from evidence_set_membership_order_versions
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
        and next_membership_id=${membershipId} and valid_to_ordinal is null
    `));
    return result[0] ? String(result[0].membership_id) : null;
  }

  async function enrichEvidence(executor: SqlExecutor, projectId: string, evidenceIds: string[]) {
    if (!evidenceIds.length) return [] as ReturnType<typeof mapEvidenceRow>[];
    const result = rows(await executor.execute(sql`
      with current_review as (
        select distinct on (project_id, evidence_id) project_id, evidence_id, decision
        from evidence_review_decisions
        where project_id=${projectId}
        order by project_id, evidence_id, sequence desc
      ), current_label_events as (
        select distinct on (project_id, evidence_id, label_id) project_id, evidence_id, label_id, event
        from evidence_label_events
        where project_id=${projectId}
        order by project_id, evidence_id, label_id, sequence desc
      ), label_values as (
        select cle.project_id, cle.evidence_id,
          coalesce(json_agg(json_build_object('id', l.id, 'name', l.name, 'archivedAt', l.archived_at) order by lower(l.name), l.id), '[]'::json) as labels
        from current_label_events cle
        join evidence_labels l on l.project_id=cle.project_id and l.id=cle.label_id
        where cle.event='assigned'
        group by cle.project_id, cle.evidence_id
      )
      select e.id, e.project_id, e.paper_id, e.full_text_document_id, e.document_text_extraction_id,
        e.extraction_start_offset, e.extraction_end_offset, e.source_text, e.page_number, e.note, e.created_at, e.updated_at,
        p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi,
        d.original_filename as document_original_filename, d.media_type as document_media_type, d.byte_size as document_byte_size,
        d.sha256 as document_sha256, d.created_at as document_created_at, d.archived_at as document_archived_at,
        cr.decision, coalesce(lv.labels, '[]'::json) as labels,
        (exists(select 1 from extraction_revision_evidence x where x.project_id=e.project_id and x.evidence_id=e.id)
          or exists(select 1 from claim_revision_evidence_supports x where x.project_id=e.project_id and x.evidence_id=e.id)
          or exists(select 1 from claim_revision_extraction_supports x join extraction_revision_evidence y on y.project_id=x.project_id and y.revision_id=x.extraction_revision_id where x.project_id=e.project_id and y.evidence_id=e.id)
          or exists(select 1 from synthesis_revision_supports x join extraction_revision_evidence y on y.project_id=x.project_id and y.revision_id=x.extraction_revision_id where x.project_id=e.project_id and y.evidence_id=e.id)
          or exists(select 1 from claim_revision_synthesis_supports x join synthesis_revision_supports y on y.project_id=x.project_id and y.synthesis_revision_id=x.synthesis_revision_id join extraction_revision_evidence z on z.project_id=y.project_id and z.revision_id=y.extraction_revision_id where x.project_id=e.project_id and z.evidence_id=e.id)) as used
      from evidence e
      join papers p on p.project_id=e.project_id and p.id=e.paper_id
      left join full_text_documents d on d.project_id=e.project_id and d.paper_id=e.paper_id and d.id=e.full_text_document_id
      left join current_review cr on cr.project_id=e.project_id and cr.evidence_id=e.id
      left join label_values lv on lv.project_id=e.project_id and lv.evidence_id=e.id
      where e.project_id=${projectId}
        and e.id in (${sql.join(evidenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by e.created_at, e.id
    `));
    return result.map(mapEvidenceRow);
  }

  async function listHistory(projectId: string, evidenceSetId: string) {
    const result = rows(await db.execute(sql`
      with recursive composition_revisions as (
        select r.id, r.sequence, r.project_id, r.evidence_set_id, r.operation_kind, r.created_at,
          r.set_ordinal, r.head_membership_id, r.tail_membership_id, r.member_count
        from evidence_set_composition_revisions r
        where r.project_id=${projectId} and r.evidence_set_id=${evidenceSetId}
      ), walk(revision_id, membership_id, next_membership_id, position, path) as (
        select r.id, v.membership_id, v.next_membership_id, 1,
          array[v.membership_id]::uuid[]
        from composition_revisions r
        join evidence_set_membership_order_versions v
          on v.project_id=r.project_id and v.evidence_set_id=r.evidence_set_id
         and v.membership_id=r.head_membership_id
         and v.valid_from_ordinal <= r.set_ordinal
         and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
        union all
        select w.revision_id, next_version.membership_id, next_version.next_membership_id,
          w.position + 1, w.path || next_version.membership_id
        from walk w
        join composition_revisions r on r.id=w.revision_id
        join evidence_set_membership_order_versions next_version
          on next_version.project_id=r.project_id and next_version.evidence_set_id=r.evidence_set_id
         and next_version.membership_id=w.next_membership_id
         and next_version.valid_from_ordinal <= r.set_ordinal
         and (next_version.valid_to_ordinal is null or r.set_ordinal < next_version.valid_to_ordinal)
        where w.next_membership_id is not null
          and not w.next_membership_id = any(w.path)
      )
      select r.id, r.sequence, r.project_id, r.evidence_set_id, r.operation_kind, r.created_at,
        r.member_count, r.tail_membership_id, w.membership_id, m.evidence_id, w.position
      from composition_revisions r
      left join walk w on w.revision_id=r.id
      left join evidence_set_memberships m
        on m.project_id=r.project_id and m.evidence_set_id=r.evidence_set_id and m.id=w.membership_id
      order by r.set_ordinal, w.position
    `));
    const history = new Map<string, {
      revision: EvidenceSetCompositionRevision;
      expectedCount: number;
      expectedTail: string | null;
      members: Array<{ membershipId: string; evidenceId: string; sortOrder: number }>;
    }>();
    for (const row of result) {
      const revisionId = String(row.id);
      let entry = history.get(revisionId);
      if (!entry) {
        entry = {
          revision: mapRevision(row),
          expectedCount: Number(row.member_count),
          expectedTail: row.tail_membership_id == null ? null : String(row.tail_membership_id),
          members: [],
        };
        history.set(revisionId, entry);
      }
      if (row.membership_id != null) {
        if (row.evidence_id == null) throw new DomainError("DATABASE_CONSTRAINT", "Evidence Set history references a missing Evidence membership");
        entry.members.push({ membershipId: String(row.membership_id), evidenceId: String(row.evidence_id), sortOrder: Number(row.position) });
      }
    }
    return [...history.values()].map((entry) => {
      if (entry.members.length !== entry.expectedCount
        || (entry.members.at(-1)?.membershipId ?? null) !== entry.expectedTail) {
        throw new DomainError("DATABASE_CONSTRAINT", "Evidence Set history failed its exact member-count or tail invariant");
      }
      return { revision: entry.revision, members: entry.members, evidenceIds: entry.members.map((member) => member.evidenceId) };
    });
  }

  async function relatedExtractionRevisions(projectId: string, evidenceIds: string[]) {
    if (!evidenceIds.length) return [];
    const result = rows(await db.execute(sql`
      select distinct r.id, r.sequence, r.project_id, r.paper_id, r.field_id, f.name as field_name,
        r.value_state, r.finalized_at, p.title as paper_title,
        exists(select 1 from extraction_value_revisions newer where newer.project_id=r.project_id and newer.extraction_value_id=r.extraction_value_id and newer.finalized_at is not null and newer.sequence > r.sequence) as has_newer_revision
      from extraction_revision_evidence l
      join extraction_value_revisions r on r.project_id=l.project_id and r.id=l.revision_id
      join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
      join papers p on p.project_id=r.project_id and p.id=r.paper_id
      where l.project_id=${projectId} and l.evidence_id in (${sql.join(evidenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by r.sequence, r.id
    `));
    return result.map((row) => ({
      id: String(row.id), sequence: Number(row.sequence), projectId: String(row.project_id), paperId: String(row.paper_id),
      paperTitle: String(row.paper_title), fieldId: String(row.field_id), fieldName: String(row.field_name),
      valueState: String(row.value_state), finalizedAt: row.finalized_at as Date | null, isCurrent: !Boolean(row.has_newer_revision),
    }));
  }

  async function getSetRow(projectId: string, evidenceSetId: string, executor: SqlExecutor = db) {
    const result = rows(await executor.execute(sql`
      select id, project_id, name, description, created_at, updated_at, archived_at
      from evidence_sets
      where project_id=${projectId} and id=${evidenceSetId}
      limit 1
    `));
    if (!result[0]) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
    return mapSet(result[0]);
  }

  async function listAnnotations(projectId: string, evidenceSetId: string) {
    await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
    return rows(await db.execute(sql`
      select id, sequence, project_id, evidence_set_id, body, created_at
      from evidence_set_annotations
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
      order by sequence
    `)).map(mapAnnotation);
  }

  return {
    async createEvidenceSet(projectId: string, input: CreateEvidenceSetInput) {
      await requireProject(projectId);
      const parsed = createEvidenceSetSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set is invalid", parsed.error.issues);
      try {
        return await db.transaction(async (tx) => {
          const setRows = rows(await tx.execute(sql`
            insert into evidence_sets (project_id, name, description)
            values (${projectId}, ${parsed.data.name}, ${parsed.data.description ?? null})
            returning id, project_id, name, description, created_at, updated_at, archived_at
          `));
          const set = mapSet(setRows[0]);
          const revision = await appendRevision(tx, projectId, set.id, "created");
          return { set, revision: {
            id: revision.id, sequence: revision.sequence, projectId: revision.projectId,
            evidenceSetId: revision.evidenceSetId, operationKind: revision.operationKind, createdAt: revision.createdAt,
          } };
        });
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "An active Evidence Set with this name already exists");
        throw error;
      }
    },

    async updateEvidenceSetMetadata(projectId: string, evidenceSetId: string, input: UpdateEvidenceSetMetadataInput) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const parsed = updateEvidenceSetMetadataSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set metadata is invalid", parsed.error.issues);
      try {
        return await db.transaction(async (tx) => {
          const set = await lockSet(tx, projectId, evidenceSetId);
          if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
          const updated = rows(await tx.execute(sql`
            update evidence_sets set
              name=${parsed.data.name ?? set.name},
              description=${parsed.data.description === undefined ? set.description : parsed.data.description},
              updated_at=now()
            where project_id=${projectId} and id=${evidenceSetId}
            returning id, project_id, name, description, created_at, updated_at, archived_at
          `));
          return mapSet(updated[0]);
        });
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "An active Evidence Set with this name already exists");
        throw error;
      }
    },

    async archiveEvidenceSet(projectId: string, evidenceSetId: string) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) return set;
        const updated = rows(await tx.execute(sql`
          update evidence_sets set archived_at=now(), updated_at=now()
          where project_id=${projectId} and id=${evidenceSetId}
          returning id, project_id, name, description, created_at, updated_at, archived_at
        `));
        return mapSet(updated[0]);
      });
    },

    async listEvidenceSets(projectId: string, includeArchived = true) {
      await requireProject(projectId);
      const result = rows(await db.execute(sql`
        with current_revisions as (
          select distinct on (project_id, evidence_set_id) project_id, evidence_set_id, id
            , set_ordinal, member_count, distinct_paper_count
          from evidence_set_composition_revisions
          where project_id=${projectId}
          order by project_id, evidence_set_id, set_ordinal desc
        ), current_review as (
          select distinct on (project_id, evidence_id) project_id, evidence_id, decision
          from evidence_review_decisions
          where project_id=${projectId}
          order by project_id, evidence_id, sequence desc
        )
        select s.id, s.project_id, s.name, s.description, s.created_at, s.updated_at, s.archived_at,
          coalesce(rv.member_count, 0)::integer as member_count,
          coalesce(rv.distinct_paper_count, 0)::integer as distinct_paper_count,
          count(m.id) filter (where cr.decision is null)::integer as unreviewed_count,
          count(m.id) filter (where cr.decision='needs_review')::integer as needs_review_count,
          count(m.id) filter (where cr.decision='rejected')::integer as rejected_count
        from evidence_sets s
        left join current_revisions rv on rv.project_id=s.project_id and rv.evidence_set_id=s.id
        left join evidence_set_membership_order_versions ov on ov.project_id=rv.project_id and ov.evidence_set_id=rv.evidence_set_id
          and ov.valid_from_ordinal <= rv.set_ordinal and (ov.valid_to_ordinal is null or rv.set_ordinal < ov.valid_to_ordinal)
        left join evidence_set_memberships m on m.project_id=ov.project_id and m.evidence_set_id=ov.evidence_set_id and m.id=ov.membership_id
        left join evidence e on e.project_id=m.project_id and e.id=m.evidence_id
        left join current_review cr on cr.project_id=e.project_id and cr.evidence_id=e.id
        where s.project_id=${projectId} ${includeArchived ? sql`` : sql`and s.archived_at is null`}
        group by s.id, rv.member_count, rv.distinct_paper_count
        order by s.archived_at is not null, lower(s.name), s.id
      `));
      return result.map((row) => ({
        set: mapSet(row),
        memberCount: Number(row.member_count),
        distinctPaperCount: Number(row.distinct_paper_count),
        curationCounts: { unreviewed: Number(row.unreviewed_count), needsReview: Number(row.needs_review_count), rejected: Number(row.rejected_count) },
      }));
    },

    async getEvidenceSet(projectId: string, evidenceSetId: string) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const set = await getSetRow(projectId, evidenceSetId);
      const snapshot = await readCurrentSnapshot(db, projectId, evidenceSetId);
      const evidence = await enrichEvidence(db, projectId, snapshot.members.map((member) => member.membership.evidenceId));
      const evidenceById = new Map(evidence.map((item) => [item.id, item]));
      const members = snapshot.members.map((member) => ({
        membership: member.membership,
        sortOrder: member.sortOrder,
        evidence: evidenceById.get(member.membership.evidenceId) ?? null,
      }));
      const [annotations, history, related] = await Promise.all([
        listAnnotations(projectId, evidenceSetId),
        listHistory(projectId, evidenceSetId),
        relatedExtractionRevisions(projectId, snapshot.members.map((member) => member.membership.evidenceId)),
      ]);
      return { set, currentRevision: snapshot.revision, members, annotations, compositionHistory: history, relatedExtractionRevisions: related };
    },

    async addEvidenceToSet(projectId: string, evidenceSetId: string, input: { evidenceId: string; expectedRevisionId: string }) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const expectedRevisionId = requireExpectedRevisionId(input?.expectedRevisionId);
      const parsed = evidenceSetMembershipInputSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set membership is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
        const current = await readCurrentRevision(tx, projectId, evidenceSetId);
        checkExpectedRevision(current, expectedRevisionId);
        await lockEvidence(tx, projectId, parsed.data.evidenceId);
        const existing = rows(await tx.execute(sql`
          select m.id, m.project_id, m.evidence_set_id, m.evidence_id, m.created_at,
            exists(select 1 from evidence_set_membership_order_versions v
              where v.project_id=m.project_id and v.evidence_set_id=m.evidence_set_id
                and v.membership_id=m.id and v.valid_to_ordinal is null) as is_active,
            exists(select 1 from evidence_set_membership_order_versions v
              where v.project_id=m.project_id and v.evidence_set_id=m.evidence_set_id
                and v.membership_id=m.id) as has_history
          from evidence_set_memberships m
          where m.project_id=${projectId} and m.evidence_set_id=${evidenceSetId}
            and m.evidence_id=${parsed.data.evidenceId}
          for update of m
        `));
        if (existing[0] && Boolean(existing[0].is_active)) {
          throw new DomainError("DUPLICATE_LINK", "Evidence is already in this Evidence Set");
        }
        if (existing[0] && !Boolean(existing[0].has_history)) {
          throw new DomainError("DATABASE_CONSTRAINT", "Evidence Set contains an unactivated stable membership identity");
        }
        const membership = existing[0] ? mapMembership(existing[0]) : mapMembership(rows(await tx.execute(sql`
          insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id)
          values (${projectId}, ${evidenceSetId}, ${parsed.data.evidenceId})
          returning id, project_id, evidence_set_id, evidence_id, created_at
        `))[0]);
        const operationKind = existing[0] ? "readded" : "added";
        const revision = await appendRevision(tx, projectId, evidenceSetId, operationKind, membership.id);
        if (current.tailMembershipId) {
          await closeOrderVersion(tx, projectId, evidenceSetId, current.tailMembershipId, revision.setOrdinal);
          await insertOrderVersion(tx, projectId, evidenceSetId, current.tailMembershipId, membership.id, revision.setOrdinal);
        }
        await insertOrderVersion(tx, projectId, evidenceSetId, membership.id, null, revision.setOrdinal);
        return { set, membership, revision: publicRevision(revision) };
      });
    },

    async removeEvidenceFromSet(
      projectId: string,
      evidenceSetId: string,
      input: { evidenceId: string; expectedRevisionId: string },
    ) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const expectedRevisionId = requireExpectedRevisionId(input?.expectedRevisionId);
      const parsedResult = evidenceSetMembershipInputSchema.safeParse(input);
      if (!parsedResult.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set membership removal is invalid", parsedResult.error.issues);
      const parsed = parsedResult.data;
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
        const current = await readCurrentRevision(tx, projectId, evidenceSetId);
        checkExpectedRevision(current, expectedRevisionId);
        await lockEvidence(tx, projectId, parsed.evidenceId);
        const activeRows = rows(await tx.execute(sql`
          select m.id, m.project_id, m.evidence_set_id, m.evidence_id, m.created_at,
            v.next_membership_id
          from evidence_set_memberships m
          join evidence_set_membership_order_versions v
            on v.project_id=m.project_id and v.evidence_set_id=m.evidence_set_id
           and v.membership_id=m.id and v.valid_to_ordinal is null
          where m.project_id=${projectId} and m.evidence_set_id=${evidenceSetId}
            and m.evidence_id=${parsed.evidenceId}
          for update of m
        `));
        if (!activeRows[0]) throw new DomainError("NOT_FOUND", "Evidence is not currently in this Evidence Set");
        const membership = mapMembership(activeRows[0]);
        const successor = activeRows[0].next_membership_id == null ? null : String(activeRows[0].next_membership_id);
        const predecessor = await currentPredecessor(tx, projectId, evidenceSetId, membership.id);
        const revision = await appendRevision(tx, projectId, evidenceSetId, "removed", membership.id);
        await closeOrderVersion(tx, projectId, evidenceSetId, membership.id, revision.setOrdinal);
        if (predecessor) {
          await closeOrderVersion(tx, projectId, evidenceSetId, predecessor, revision.setOrdinal);
          await insertOrderVersion(tx, projectId, evidenceSetId, predecessor, successor, revision.setOrdinal);
        }
        return { set, membership, revision: publicRevision(revision) };
      });
    },

    async moveEvidenceSetMembership(projectId: string, evidenceSetId: string, input: MoveEvidenceSetMembershipInput) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const expectedRevisionId = requireExpectedRevisionId((input as { expectedRevisionId?: unknown } | null)?.expectedRevisionId);
      const parsed = moveEvidenceSetMembershipSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set membership move is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
        const current = await readCurrentRevision(tx, projectId, evidenceSetId);
        checkExpectedRevision(current, expectedRevisionId);
        const target = parsed.data.membershipId;
        const neighborhoodRows = rows(await tx.execute(sql`
          select target.membership_id, target.next_membership_id,
            predecessor.membership_id as previous_membership_id
          from evidence_set_membership_order_versions target
          left join evidence_set_membership_order_versions predecessor
            on predecessor.project_id=target.project_id
           and predecessor.evidence_set_id=target.evidence_set_id
           and predecessor.next_membership_id=target.membership_id
           and predecessor.valid_to_ordinal is null
          where target.project_id=${projectId} and target.evidence_set_id=${evidenceSetId}
            and target.membership_id=${target} and target.valid_to_ordinal is null
          for update of target
        `));
        if (!neighborhoodRows[0]) throw new DomainError("NOT_FOUND", "Evidence Set membership is not currently active");
        const targetNext = neighborhoodRows[0].next_membership_id == null ? null : String(neighborhoodRows[0].next_membership_id);
        const targetPrevious = neighborhoodRows[0].previous_membership_id == null ? null : String(neighborhoodRows[0].previous_membership_id);

        if (parsed.data.direction === "up" && !targetPrevious) {
          return { set, revision: publicRevision(current), moved: false };
        }
        if (parsed.data.direction === "down" && !targetNext) {
          return { set, revision: publicRevision(current), moved: false };
        }

        const changedLinks = new Map<string, string | null>();
        if (parsed.data.direction === "up") {
          const previousPrevious = await currentPredecessor(tx, projectId, evidenceSetId, targetPrevious!);
          if (previousPrevious) changedLinks.set(previousPrevious, target);
          changedLinks.set(target, targetPrevious!);
          changedLinks.set(targetPrevious!, targetNext);
        } else {
          const nextNext = await currentNext(tx, projectId, evidenceSetId, targetNext!);
          if (targetPrevious) changedLinks.set(targetPrevious, targetNext!);
          changedLinks.set(targetNext!, target);
          changedLinks.set(target, nextNext);
        }

        const revision = await appendRevision(tx, projectId, evidenceSetId, "moved", target, parsed.data.direction);
        for (const membershipId of changedLinks.keys()) {
          await closeOrderVersion(tx, projectId, evidenceSetId, membershipId, revision.setOrdinal);
        }
        for (const [membershipId, nextMembershipId] of changedLinks) {
          await insertOrderVersion(tx, projectId, evidenceSetId, membershipId, nextMembershipId, revision.setOrdinal);
        }
        return { set, revision: publicRevision(revision), moved: true };
      });
    },

    async reorderEvidenceSet(projectId: string, evidenceSetId: string, input: ReorderEvidenceSetInput) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const parsed = reorderEvidenceSetSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set order is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
        if (parsed.data.expectedRevisionId !== undefined) ensureUuid(parsed.data.expectedRevisionId, "Composition revision");
        const current = await readCurrentRevision(tx, projectId, evidenceSetId);
        checkOptionalExpectedRevision(current, parsed.data.expectedRevisionId);
        const snapshot = await readCurrentSnapshot(tx, projectId, evidenceSetId);
        const expected = snapshot.members.map((member) => member.membership.evidenceId);
        if (parsed.data.evidenceIds.length !== expected.length || [...parsed.data.evidenceIds].sort().join(",") !== [...expected].sort().join(",")) {
          throw new DomainError("VALIDATION_ERROR", "Reorder must contain exactly the current active Evidence IDs");
        }
        if (parsed.data.evidenceIds.every((id, index) => id === expected[index])) {
          throw new DomainError("VALIDATION_ERROR", "Evidence Set order did not change");
        }
        const membershipByEvidence = new Map(snapshot.members.map((member) => [member.membership.evidenceId, member.membership]));
        const nextMembers = parsed.data.evidenceIds.map((evidenceId, index) => ({ membership: membershipByEvidence.get(evidenceId)!, sortOrder: index + 1 }));
        const orderedIds = nextMembers.map((member) => member.membership.id);
        const revision = await appendRevision(tx, projectId, evidenceSetId, "reordered", undefined, undefined, orderedIds[0], orderedIds.at(-1));
        for (const member of snapshot.members) {
          await closeOrderVersion(tx, projectId, evidenceSetId, member.membership.id, revision.setOrdinal);
        }
        for (let index = 0; index < orderedIds.length; index += 1) {
          await insertOrderVersion(tx, projectId, evidenceSetId, orderedIds[index], orderedIds[index + 1] ?? null, revision.setOrdinal);
        }
        return { set, revision: publicRevision(revision) };
      });
    },

    async listEvidenceSetCompositionHistory(projectId: string, evidenceSetId: string) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      return listHistory(projectId, evidenceSetId);
    },

    async appendEvidenceSetAnnotation(projectId: string, evidenceSetId: string, input: AppendEvidenceSetAnnotationInput) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const parsed = appendEvidenceSetAnnotationSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set annotation is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
        const inserted = rows(await tx.execute(sql`
          insert into evidence_set_annotations (project_id, evidence_set_id, body)
          values (${projectId}, ${evidenceSetId}, ${parsed.data.body})
          returning id, sequence, project_id, evidence_set_id, body, created_at
        `));
        return mapAnnotation(inserted[0]);
      });
    },

    async listEvidenceSetAnnotations(projectId: string, evidenceSetId: string) {
      return listAnnotations(projectId, evidenceSetId);
    },

    async listCandidateEvidenceForSet(projectId: string, evidenceSetId: string) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const candidateRows = rows(await db.execute(sql`
        select e.id
        from evidence e
        where e.project_id=${projectId}
          and not exists (
            select 1
            from evidence_set_composition_revisions current_revision
            join evidence_set_membership_order_versions current_link
              on current_link.project_id=current_revision.project_id
             and current_link.evidence_set_id=current_revision.evidence_set_id
             and current_link.valid_from_ordinal <= current_revision.set_ordinal
             and (current_link.valid_to_ordinal is null or current_revision.set_ordinal < current_link.valid_to_ordinal)
            join evidence_set_memberships current_membership
              on current_membership.project_id=current_link.project_id
             and current_membership.evidence_set_id=current_link.evidence_set_id
             and current_membership.id=current_link.membership_id
            where current_revision.project_id=${projectId}
              and current_revision.evidence_set_id=${evidenceSetId}
              and current_revision.set_ordinal=(
                select max(latest.set_ordinal)
                from evidence_set_composition_revisions latest
                where latest.project_id=current_revision.project_id
                  and latest.evidence_set_id=current_revision.evidence_set_id
              )
              and current_membership.evidence_id=e.id
          )
        order by e.created_at, e.id
      `));
      return enrichEvidence(db, projectId, candidateRows.map((row) => String(row.id)));
    },

    async listRelatedExtractionRevisionsForEvidenceSet(projectId: string, evidenceSetId: string) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const snapshot = await readCurrentSnapshot(db, projectId, evidenceSetId);
      return relatedExtractionRevisions(projectId, snapshot.members.map((member) => member.membership.evidenceId));
    },
  };
}
