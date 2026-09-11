import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appendEvidenceSetAnnotationSchema,
  createEvidenceSetSchema,
  evidenceSetMembershipInputSchema,
  reorderEvidenceSetSchema,
  updateEvidenceSetMetadataSchema,
  type AppendEvidenceSetAnnotationInput,
  type CreateEvidenceSetInput,
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

  async function readCurrentSnapshot(executor: SqlExecutor, projectId: string, evidenceSetId: string): Promise<Snapshot> {
    const revisionRows = rows(await executor.execute(sql`
      select id, sequence, project_id, evidence_set_id, operation_kind, created_at
      from evidence_set_composition_revisions
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
      order by sequence desc
      limit 1
    `));
    if (!revisionRows[0]) throw new DomainError("DATABASE_CONSTRAINT", "Evidence Set has no composition snapshot");
    const revision = mapRevision(revisionRows[0]);
    const memberRows = rows(await executor.execute(sql`
      select m.id, m.project_id, m.evidence_set_id, m.evidence_id, m.created_at, cm.sort_order
      from evidence_set_composition_members cm
      join evidence_set_memberships m
        on m.project_id=cm.project_id and m.evidence_set_id=cm.evidence_set_id and m.id=cm.membership_id
      where cm.project_id=${projectId} and cm.evidence_set_id=${evidenceSetId} and cm.composition_revision_id=${revision.id}
      order by cm.sort_order
    `));
    return { revision, members: memberRows.map((row) => ({ membership: mapMembership(row), sortOrder: Number(row.sort_order) })) };
  }

  async function appendSnapshot(
    tx: ReviewTransaction,
    projectId: string,
    evidenceSetId: string,
    operationKind: EvidenceSetCompositionOperationKind,
    members: SnapshotMember[],
  ) {
    const revisionRows = rows(await tx.execute(sql`
      insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind)
      values (${projectId}, ${evidenceSetId}, ${operationKind})
      returning id, sequence, project_id, evidence_set_id, operation_kind, created_at
    `));
    const revision = mapRevision(revisionRows[0]);
    if (members.length) {
      await tx.execute(sql`
        insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order)
        values ${sql.join(members.map((member) => sql`(${projectId}, ${evidenceSetId}, ${revision.id}, ${member.membership.id}, ${member.sortOrder})`), sql`, `)}
      `);
    }
    return revision;
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
    const revisions = rows(await db.execute(sql`
      select id, sequence, project_id, evidence_set_id, operation_kind, created_at
      from evidence_set_composition_revisions
      where project_id=${projectId} and evidence_set_id=${evidenceSetId}
      order by sequence
    `)).map(mapRevision);
    const revisionIds = revisions.map((revision) => revision.id);
    const members = revisionIds.length ? rows(await db.execute(sql`
      select cm.composition_revision_id, cm.membership_id, m.evidence_id, cm.sort_order
      from evidence_set_composition_members cm
      join evidence_set_memberships m
        on m.project_id=cm.project_id and m.evidence_set_id=cm.evidence_set_id and m.id=cm.membership_id
      where cm.project_id=${projectId} and cm.evidence_set_id=${evidenceSetId}
        and cm.composition_revision_id in (${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by cm.composition_revision_id, cm.sort_order
    `)) : [];
    const membersByRevision = new Map<string, Array<{ membershipId: string; evidenceId: string; sortOrder: number }>>();
    for (const row of members) {
      const list = membersByRevision.get(String(row.composition_revision_id)) ?? [];
      list.push({ membershipId: String(row.membership_id), evidenceId: String(row.evidence_id), sortOrder: Number(row.sort_order) });
      membersByRevision.set(String(row.composition_revision_id), list);
    }
    return revisions.map((revision) => ({ revision, members: membersByRevision.get(revision.id) ?? [], evidenceIds: (membersByRevision.get(revision.id) ?? []).map((member) => member.evidenceId) }));
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
          const revision = await appendSnapshot(tx, projectId, set.id, "created", []);
          return { set, revision };
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
          from evidence_set_composition_revisions
          where project_id=${projectId}
          order by project_id, evidence_set_id, sequence desc
        ), current_review as (
          select distinct on (project_id, evidence_id) project_id, evidence_id, decision
          from evidence_review_decisions
          where project_id=${projectId}
          order by project_id, evidence_id, sequence desc
        )
        select s.id, s.project_id, s.name, s.description, s.created_at, s.updated_at, s.archived_at,
          count(cm.membership_id)::integer as member_count,
          count(distinct e.paper_id)::integer as distinct_paper_count,
          count(cm.membership_id) filter (where cr.decision is null)::integer as unreviewed_count,
          count(cm.membership_id) filter (where cr.decision='needs_review')::integer as needs_review_count,
          count(cm.membership_id) filter (where cr.decision='rejected')::integer as rejected_count
        from evidence_sets s
        left join current_revisions rv on rv.project_id=s.project_id and rv.evidence_set_id=s.id
        left join evidence_set_composition_members cm on cm.project_id=rv.project_id and cm.evidence_set_id=rv.evidence_set_id and cm.composition_revision_id=rv.id
        left join evidence_set_memberships m on m.project_id=cm.project_id and m.evidence_set_id=cm.evidence_set_id and m.id=cm.membership_id
        left join evidence e on e.project_id=m.project_id and e.id=m.evidence_id
        left join current_review cr on cr.project_id=e.project_id and cr.evidence_id=e.id
        where s.project_id=${projectId} ${includeArchived ? sql`` : sql`and s.archived_at is null`}
        group by s.id
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

    async addEvidenceToSet(projectId: string, evidenceSetId: string, input: { evidenceId: string }) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const parsed = evidenceSetMembershipInputSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set membership is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
        await lockEvidence(tx, projectId, parsed.data.evidenceId);
        const snapshot = await readCurrentSnapshot(tx, projectId, evidenceSetId);
        if (snapshot.members.some((member) => member.membership.evidenceId === parsed.data.evidenceId)) {
          throw new DomainError("DUPLICATE_LINK", "Evidence is already in this Evidence Set");
        }
        const existing = rows(await tx.execute(sql`
          select id, project_id, evidence_set_id, evidence_id, created_at
          from evidence_set_memberships
          where project_id=${projectId} and evidence_set_id=${evidenceSetId} and evidence_id=${parsed.data.evidenceId}
          for update
        `));
        const membership = existing[0] ? mapMembership(existing[0]) : mapMembership(rows(await tx.execute(sql`
          insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id)
          values (${projectId}, ${evidenceSetId}, ${parsed.data.evidenceId})
          returning id, project_id, evidence_set_id, evidence_id, created_at
        `))[0]);
        const wasPreviouslyActive = Boolean(rows(await tx.execute(sql`
          select 1 from evidence_set_composition_members
          where project_id=${projectId} and evidence_set_id=${evidenceSetId} and membership_id=${membership.id}
          limit 1
        `)).length);
        const operationKind = wasPreviouslyActive ? "readded" : "added" as const;
        const nextMembers = [...snapshot.members, { membership, sortOrder: snapshot.members.length + 1 }];
        const revision = await appendSnapshot(tx, projectId, evidenceSetId, operationKind, nextMembers);
        return { set, membership, revision };
      });
    },

    async removeEvidenceFromSet(projectId: string, evidenceSetId: string, evidenceId: string) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set"); ensureUuid(evidenceId, "Evidence");
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
        await lockEvidence(tx, projectId, evidenceId);
        const snapshot = await readCurrentSnapshot(tx, projectId, evidenceSetId);
        const index = snapshot.members.findIndex((member) => member.membership.evidenceId === evidenceId);
        if (index < 0) throw new DomainError("NOT_FOUND", "Evidence is not currently in this Evidence Set");
        const nextMembers = snapshot.members.filter((_, memberIndex) => memberIndex !== index).map((member, memberIndex) => ({ ...member, sortOrder: memberIndex + 1 }));
        const revision = await appendSnapshot(tx, projectId, evidenceSetId, "removed", nextMembers);
        return { set, membership: snapshot.members[index].membership, revision };
      });
    },

    async reorderEvidenceSet(projectId: string, evidenceSetId: string, input: ReorderEvidenceSetInput) {
      await requireProject(projectId); ensureUuid(evidenceSetId, "Evidence Set");
      const parsed = reorderEvidenceSetSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence Set order is invalid", parsed.error.issues);
      return db.transaction(async (tx) => {
        const set = await lockSet(tx, projectId, evidenceSetId);
        if (set.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived Evidence Sets cannot be changed");
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
        const revision = await appendSnapshot(tx, projectId, evidenceSetId, "reordered", nextMembers);
        return { set, revision };
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
      const snapshot = await readCurrentSnapshot(db, projectId, evidenceSetId);
      const activeIds = snapshot.members.map((member) => member.membership.evidenceId);
      const candidateRows = rows(await db.execute(sql`
        select e.id
        from evidence e
        where e.project_id=${projectId}
          ${activeIds.length ? sql`and e.id not in (${sql.join(activeIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
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
