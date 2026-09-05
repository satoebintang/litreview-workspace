import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";

type Executor = Pick<Database, "execute">;
type Row = Record<string, unknown>;

const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID");
  return value;
};
const rows = (value: unknown) => value as unknown as Row[];
const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${uuid(id)}::uuid`), sql`, `);
const date = (value: unknown) => value as Date;
const paper = (r: Row) => ({ id: String(r.paper_id), projectId: String(r.project_id), title: String(r.paper_title), authors: (r.authors as string[]) ?? [], publicationYear: r.publication_year as number | null, venue: r.venue as string | null, doi: r.doi as string | null, abstract: r.abstract as string | null, bibliographicNote: r.bibliographic_note as string | null, createdAt: date(r.paper_created_at), updatedAt: date(r.paper_updated_at) });

export function createManuscriptServices(db: Database) {
  async function requireProject(projectId: string) {
    uuid(projectId);
    const found = rows(await db.execute(sql`select id, title from projects where id=${projectId} limit 1`))[0];
    if (!found) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return found;
  }

  async function requireManuscript(projectId: string, manuscriptId: string) {
    await requireProject(projectId); uuid(manuscriptId);
    const found = rows(await db.execute(sql`select id, project_id, title, is_default, created_at, updated_at from manuscripts where project_id=${projectId} and id=${manuscriptId} limit 1`))[0];
    if (!found) throw new DomainError("CROSS_PROJECT_REFERENCE", "Manuscript does not belong to this project");
    return found;
  }

  async function getOrCreateDefaultManuscript(projectId: string) {
    await requireProject(projectId);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`insert into manuscripts (project_id, title, is_default) values (${projectId}, 'Manuscript', true) on conflict (project_id) where is_default do nothing`);
      const found = rows(await tx.execute(sql`select id, project_id, title, is_default, created_at, updated_at from manuscripts where project_id=${projectId} and is_default=true limit 1`))[0];
      if (!found) throw new DomainError("DATABASE_CONSTRAINT", "Default Manuscript could not be created");
      return found;
    });
    return mapManuscript(result);
  }

  const mapManuscript = (r: Row) => ({ id: String(r.id), projectId: String(r.project_id), title: String(r.title), isDefault: Boolean(r.is_default), createdAt: date(r.created_at), updatedAt: date(r.updated_at) });
  const mapSection = (r: Row) => ({ id: String(r.id), projectId: String(r.project_id), manuscriptId: String(r.manuscript_id), title: String(r.title), sectionType: String(r.section_type), sortOrder: Number(r.sort_order), createdAt: date(r.created_at), updatedAt: date(r.updated_at), archivedAt: r.archived_at ? date(r.archived_at) : null });

  async function section(projectId: string, manuscriptId: string, sectionId: string, includeArchived = true) {
    await requireManuscript(projectId, manuscriptId); uuid(sectionId);
    const found = rows(await db.execute(sql`select id, project_id, manuscript_id, title, section_type, sort_order, created_at, updated_at, archived_at from manuscript_sections where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${sectionId} ${includeArchived ? sql`` : sql`and archived_at is null`} limit 1`))[0];
    if (!found) throw new DomainError("CROSS_PROJECT_REFERENCE", "Section does not belong to this Manuscript");
    return found;
  }

  async function createSection(projectId: string, manuscriptId: string, input: { title: string; sectionType?: string }) {
    await requireManuscript(projectId, manuscriptId);
    const title = input.title?.trim(); if (!title) throw new DomainError("VALIDATION_ERROR", "Section title is required");
    const allowed = ["introduction", "methods", "results", "discussion", "limitations", "conclusion", "custom"];
    const sectionType = input.sectionType ?? "custom"; if (!allowed.includes(sectionType)) throw new DomainError("VALIDATION_ERROR", "Invalid section type");
    const max = rows(await db.execute(sql`select coalesce(max(sort_order), -1) as max_order from manuscript_sections where project_id=${projectId} and manuscript_id=${manuscriptId} and archived_at is null`))[0];
    const result = rows(await db.execute(sql`insert into manuscript_sections (project_id, manuscript_id, title, section_type, sort_order) values (${projectId}, ${manuscriptId}, ${title}, ${sectionType}, ${Number(max?.max_order ?? -1) + 1}) returning id, project_id, manuscript_id, title, section_type, sort_order, created_at, updated_at, archived_at`))[0];
    return mapSection(result);
  }

  async function renameSection(projectId: string, manuscriptId: string, sectionId: string, title: string) {
    await section(projectId, manuscriptId, sectionId, false); const value = title?.trim(); if (!value) throw new DomainError("VALIDATION_ERROR", "Section title is required");
    const result = rows(await db.execute(sql`update manuscript_sections set title=${value}, updated_at=now() where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${sectionId} and archived_at is null returning id, project_id, manuscript_id, title, section_type, sort_order, created_at, updated_at, archived_at`))[0];
    return mapSection(result);
  }

  async function reorderSections(projectId: string, manuscriptId: string, orderedSectionIds: string[]) {
    await requireManuscript(projectId, manuscriptId); orderedSectionIds.forEach(uuid);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from manuscript_sections where project_id=${projectId} and manuscript_id=${manuscriptId} for update`);
      const active = rows(await tx.execute(sql`select id from manuscript_sections where project_id=${projectId} and manuscript_id=${manuscriptId} and archived_at is null order by sort_order, id`)).map((r) => String(r.id));
      if (active.length !== orderedSectionIds.length || new Set(orderedSectionIds).size !== active.length || active.some((id) => !orderedSectionIds.includes(id))) throw new DomainError("VALIDATION_ERROR", "Section reorder must include every active section exactly once");
      for (let i = 0; i < orderedSectionIds.length; i += 1) await tx.execute(sql`update manuscript_sections set sort_order=${i}, updated_at=now() where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${orderedSectionIds[i]}`);
      return getManuscript(projectId, manuscriptId);
    });
  }

  async function archiveSection(projectId: string, manuscriptId: string, sectionId: string) {
    await section(projectId, manuscriptId, sectionId, false);
    const active = rows(await db.execute(sql`select id from manuscript_claim_placements where project_id=${projectId} and manuscript_id=${manuscriptId} and section_id=${sectionId} and removed_at is null limit 1`));
    if (active.length) throw new DomainError("PROTECTED_DELETE", "Section cannot be archived while it contains placements");
    const result = rows(await db.execute(sql`update manuscript_sections set archived_at=now(), updated_at=now() where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${sectionId} and archived_at is null returning id, project_id, manuscript_id, title, section_type, sort_order, created_at, updated_at, archived_at`))[0];
    return mapSection(result);
  }

  async function validatePlacementTarget(executor: Executor, projectId: string, claimRevisionId: string, currentSequence?: number, claimId?: string) {
    uuid(claimRevisionId);
    const target = rows(await executor.execute(sql`select r.id as claim_revision_id, r.project_id, r.claim_id, r.sequence, r.state, r.finalized_at, c.id as stable_claim_id,
      (select current_r.state from claim_revisions current_r where current_r.project_id=r.project_id and current_r.claim_id=r.claim_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) as current_claim_state
      from claim_revisions r join claims c on c.project_id=r.project_id and c.id=r.claim_id
      where r.project_id=${projectId} and r.id=${claimRevisionId} ${claimId ? sql`and r.claim_id=${uuid(claimId)}` : sql``} limit 1`))[0];
    if (!target) throw new DomainError("CROSS_PROJECT_REFERENCE", "ClaimRevision does not belong to this project or Claim");
    if (target.finalized_at == null || String(target.state) !== "active") throw new DomainError("INELIGIBLE_REFERENCE", "Only finalized active ClaimRevisions may be placed");
    if (String(target.current_claim_state) !== "active") throw new DomainError("INELIGIBLE_REFERENCE", "A withdrawn Claim cannot receive a new placement");
    if (currentSequence !== undefined && Number(target.sequence) <= currentSequence) throw new DomainError("VALIDATION_ERROR", "Replacement must use a higher ClaimRevision sequence");
    return target;
  }

  async function placeClaimRevision(projectId: string, manuscriptId: string, sectionId: string, claimRevisionId: string) {
    await section(projectId, manuscriptId, sectionId, false);
    return db.transaction(async (tx) => {
      await validatePlacementTarget(tx, projectId, claimRevisionId);
      const max = rows(await tx.execute(sql`select coalesce(max(sort_order), -1) as max_order from manuscript_claim_placements where project_id=${projectId} and manuscript_id=${manuscriptId} and section_id=${sectionId} and removed_at is null`))[0];
      try {
        const result = rows(await tx.execute(sql`insert into manuscript_claim_placements (project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order) select ${projectId}, ${manuscriptId}, ${sectionId}, claim_id, ${claimRevisionId}, ${Number(max?.max_order ?? -1) + 1} from claim_revisions where project_id=${projectId} and id=${claimRevisionId} returning id, project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order, created_at, removed_at`))[0];
        return mapPlacement(result);
      } catch (error) { throw new DomainError("DUPLICATE_LINK", "ClaimRevision is already placed in this section", error); }
    });
  }

  const mapPlacement = (r: Row) => ({ id: String(r.id), projectId: String(r.project_id), manuscriptId: String(r.manuscript_id), sectionId: String(r.section_id), claimId: String(r.claim_id), claimRevisionId: String(r.claim_revision_id), sortOrder: Number(r.sort_order), createdAt: date(r.created_at), removedAt: r.removed_at ? date(r.removed_at) : null });

  async function replacePlacedClaimRevision(projectId: string, manuscriptId: string, placementId: string, claimRevisionId: string, expectedClaimRevisionId?: string) {
    await requireManuscript(projectId, manuscriptId); uuid(placementId);
    return db.transaction(async (tx) => {
      const current = rows(await tx.execute(sql`select id, project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order, created_at, removed_at from manuscript_claim_placements where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${placementId} for update`))[0];
      if (!current) throw new DomainError("NOT_FOUND", "Placement was not found");
      if (current.removed_at) throw new DomainError("VALIDATION_ERROR", "Removed placements cannot be replaced");
      if (expectedClaimRevisionId && String(current.claim_revision_id) !== uuid(expectedClaimRevisionId)) throw new DomainError("VALIDATION_ERROR", "Placement changed while replacement was being prepared");
      const oldRevision = rows(await tx.execute(sql`select sequence from claim_revisions where project_id=${projectId} and id=${current.claim_revision_id}`))[0];
      await validatePlacementTarget(tx, projectId, claimRevisionId, Number(oldRevision.sequence), String(current.claim_id));
      const result = rows(await tx.execute(sql`update manuscript_claim_placements set claim_revision_id=${claimRevisionId} where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${placementId} and removed_at is null returning id, project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order, created_at, removed_at`))[0];
      return mapPlacement(result);
    });
  }

  async function removeClaimPlacement(projectId: string, manuscriptId: string, placementId: string) {
    await requireManuscript(projectId, manuscriptId); uuid(placementId);
    const result = rows(await db.execute(sql`update manuscript_claim_placements set removed_at=now() where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${placementId} and removed_at is null returning id, project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order, created_at, removed_at`))[0];
    if (!result) throw new DomainError("NOT_FOUND", "Active placement was not found");
    return mapPlacement(result);
  }

  async function reorderClaimPlacements(projectId: string, manuscriptId: string, sectionId: string, orderedPlacementIds: string[]) {
    await section(projectId, manuscriptId, sectionId, false); orderedPlacementIds.forEach(uuid);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from manuscript_claim_placements where project_id=${projectId} and manuscript_id=${manuscriptId} and section_id=${sectionId} for update`);
      const active = rows(await tx.execute(sql`select id from manuscript_claim_placements where project_id=${projectId} and manuscript_id=${manuscriptId} and section_id=${sectionId} and removed_at is null order by sort_order, id`)).map((r) => String(r.id));
      if (active.length !== orderedPlacementIds.length || new Set(orderedPlacementIds).size !== active.length || active.some((id) => !orderedPlacementIds.includes(id))) throw new DomainError("VALIDATION_ERROR", "Placement reorder must include every active placement exactly once");
      for (let i = 0; i < orderedPlacementIds.length; i += 1) await tx.execute(sql`update manuscript_claim_placements set sort_order=${i} where project_id=${projectId} and manuscript_id=${manuscriptId} and section_id=${sectionId} and id=${orderedPlacementIds[i]} and removed_at is null`);
      return getManuscript(projectId, manuscriptId);
    });
  }

  async function getManuscriptPlacementHistory(projectId: string, manuscriptId: string, placementId: string) {
    await requireManuscript(projectId, manuscriptId); uuid(placementId);
    return rows(await db.execute(sql`select id, sequence, project_id, manuscript_id, section_id, placement_id, claim_id, event_type, from_claim_revision_id, to_claim_revision_id, occurred_at from manuscript_claim_placement_events where project_id=${projectId} and manuscript_id=${manuscriptId} and placement_id=${placementId} order by sequence`)).map((r) => ({ id: String(r.id), sequence: Number(r.sequence), projectId: String(r.project_id), manuscriptId: String(r.manuscript_id), sectionId: String(r.section_id), placementId: String(r.placement_id), claimId: String(r.claim_id), eventType: String(r.event_type), fromClaimRevisionId: r.from_claim_revision_id ? String(r.from_claim_revision_id) : null, toClaimRevisionId: r.to_claim_revision_id ? String(r.to_claim_revision_id) : null, occurredAt: date(r.occurred_at) }));
  }

  async function getManuscript(projectId: string, manuscriptId: string) {
    const manuscript = await requireManuscript(projectId, manuscriptId);
    const sectionRows = rows(await db.execute(sql`select id, project_id, manuscript_id, title, section_type, sort_order, created_at, updated_at, archived_at from manuscript_sections where project_id=${projectId} and manuscript_id=${manuscriptId} and archived_at is null order by sort_order, id`));
    const placementRows = rows(await db.execute(sql`select p.id, p.project_id, p.manuscript_id, p.section_id, p.claim_id, p.claim_revision_id, p.sort_order, p.created_at, p.removed_at,
      r.sequence, r.state, r.claim_text, r.researcher_note, r.finalized_at,
      latest.id as latest_revision_id, latest.sequence as latest_revision_sequence, latest.state as latest_revision_state
      from manuscript_claim_placements p join claim_revisions r on r.project_id=p.project_id and r.id=p.claim_revision_id
      join lateral (select current_r.id, current_r.sequence, current_r.state from claim_revisions current_r where current_r.project_id=p.project_id and current_r.claim_id=p.claim_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) latest on true
      where p.project_id=${projectId} and p.manuscript_id=${manuscriptId} and p.removed_at is null and exists (select 1 from manuscript_sections s where s.project_id=p.project_id and s.manuscript_id=p.manuscript_id and s.id=p.section_id and s.archived_at is null)
      order by p.section_id, p.sort_order, p.id`));
    const revisionIds = placementRows.map((r) => String(r.claim_revision_id));
    const supportCounts = new Map<string, number>();
    if (revisionIds.length) {
      const counts = rows(await db.execute(sql`select claim_revision_id, count(*)::int as count from (
        select project_id, claim_revision_id from claim_revision_evidence_supports where project_id=${projectId} and claim_revision_id in (${idList(revisionIds)})
        union all select project_id, claim_revision_id from claim_revision_extraction_supports where project_id=${projectId} and claim_revision_id in (${idList(revisionIds)})
        union all select project_id, claim_revision_id from claim_revision_synthesis_supports where project_id=${projectId} and claim_revision_id in (${idList(revisionIds)})
      ) supports group by claim_revision_id`));
      counts.forEach((r) => supportCounts.set(String(r.claim_revision_id), Number(r.count)));
    }
    const candidateRows = revisionIds.length ? rows(await db.execute(sql`select * from (
      select s.claim_revision_id, 1 as source_rank, s.created_at as support_created_at, e.created_at as provenance_created_at, s.evidence_id::text as target_id, e.paper_id, p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note, p.created_at as paper_created_at, p.updated_at as paper_updated_at
      from claim_revision_evidence_supports s join evidence e on e.project_id=s.project_id and e.id=s.evidence_id join papers p on p.project_id=e.project_id and p.id=e.paper_id
      where s.project_id=${projectId} and s.claim_revision_id in (${idList(revisionIds)})
      union all
      select s.claim_revision_id, 2, s.created_at, x.created_at as provenance_created_at, s.extraction_revision_id::text, e.paper_id, p.title, p.authors, p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note, p.created_at, p.updated_at
      from claim_revision_extraction_supports s join extraction_revision_evidence x on x.project_id=s.project_id and x.revision_id=s.extraction_revision_id join evidence e on e.project_id=x.project_id and e.id=x.evidence_id join papers p on p.project_id=e.project_id and p.id=e.paper_id
      where s.project_id=${projectId} and s.claim_revision_id in (${idList(revisionIds)})
      union all
      select s.claim_revision_id, 3, s.created_at, ss.created_at as provenance_created_at, s.synthesis_revision_id::text, e.paper_id, p.title, p.authors, p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note, p.created_at, p.updated_at
      from claim_revision_synthesis_supports s join synthesis_revision_supports ss on ss.project_id=s.project_id and ss.synthesis_revision_id=s.synthesis_revision_id join extraction_revision_evidence x on x.project_id=ss.project_id and x.revision_id=ss.extraction_revision_id join evidence e on e.project_id=x.project_id and e.id=x.evidence_id join papers p on p.project_id=e.project_id and p.id=e.paper_id
      where s.project_id=${projectId} and s.claim_revision_id in (${idList(revisionIds)})
    ) candidates order by claim_revision_id, source_rank, support_created_at, provenance_created_at, target_id, paper_id`)) : [];
    const candidateByRevision = new Map<string, Row[]>();
    for (const r of candidateRows) { const key = String(r.claim_revision_id); const list = candidateByRevision.get(key) ?? []; if (!list.some((x) => String(x.paper_id) === String(r.paper_id))) list.push(r); candidateByRevision.set(key, list); }
    const bibliography = new Map<string, Row & { firstSectionId?: string; firstPlacementId?: string; firstClaimRevisionId?: string; firstCandidateRank?: number; citationNumber?: number }>();
    const placementViews = placementRows.map((r) => {
      const candidates = candidateByRevision.get(String(r.claim_revision_id)) ?? [];
      const view = { ...mapPlacement(r), claimRevision: { id: String(r.claim_revision_id), sequence: Number(r.sequence), state: String(r.state), claimText: r.claim_text as string | null, researcherNote: r.researcher_note as string | null, finalizedAt: date(r.finalized_at) }, stableClaimId: String(r.claim_id), latestClaimRevisionId: String(r.latest_revision_id), isCurrentClaimRevision: String(r.latest_revision_id) === String(r.claim_revision_id), isSuperseded: Number(r.latest_revision_sequence) > Number(r.sequence), currentClaimLifecycle: String(r.latest_revision_state), supportStatus: (supportCounts.get(String(r.claim_revision_id)) ?? 0) > 0 ? "supported" : "unsupported", supportCount: supportCounts.get(String(r.claim_revision_id)) ?? 0, citationPaperIds: candidates.map((x) => String(x.paper_id)), citationNumbers: [] as number[] };
      return view;
    });
    const sectionOrder = new Map(sectionRows.map((r, i) => [String(r.id), i]));
    const orderedPlacements = [...placementViews].sort((a, b) => (sectionOrder.get(a.sectionId)! - sectionOrder.get(b.sectionId)!) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    for (const placement of orderedPlacements) for (const [candidateRank, candidate] of (candidateByRevision.get(placement.claimRevisionId) ?? []).entries()) { const id = String(candidate.paper_id); if (!bibliography.has(id)) bibliography.set(id, { ...candidate, firstSectionId: placement.sectionId, firstPlacementId: placement.id, firstClaimRevisionId: placement.claimRevisionId, firstCandidateRank: candidateRank }); }
    const placementOrder = new Map(orderedPlacements.map((placement, index) => [placement.id, index]));
    const orderedBibliography = [...bibliography.values()].sort((a, b) => (placementOrder.get(String(a.firstPlacementId)) ?? 0) - (placementOrder.get(String(b.firstPlacementId)) ?? 0) || (a.firstCandidateRank ?? 0) - (b.firstCandidateRank ?? 0) || String(a.paper_id).localeCompare(String(b.paper_id)));
    orderedBibliography.forEach((r, i) => { r.citationNumber = i + 1; });
    const numbers = new Map(orderedBibliography.map((r) => [String(r.paper_id), Number(r.citationNumber)]));
    placementViews.forEach((v) => { v.citationNumbers = v.citationPaperIds.map((id) => numbers.get(id)).filter((n): n is number => n !== undefined).sort((a, b) => a - b); });
    const warnings = placementViews.flatMap((v) => [
      ...(v.supportStatus === "unsupported" ? [{ placementId: v.id, code: "unsupported" as const, message: "This placed ClaimRevision has no typed support." }] : []),
      ...(v.citationPaperIds.length === 0 ? [{ placementId: v.id, code: "no_citations" as const, message: "No citation candidates are reachable from this exact ClaimRevision." }] : []),
      ...(v.isSuperseded ? [{ placementId: v.id, code: "superseded" as const, message: "A newer ClaimRevision exists; this placement remains exact until replaced." }] : []),
      ...(v.currentClaimLifecycle === "withdrawn" ? [{ placementId: v.id, code: "withdrawn_parent" as const, message: "The stable Claim is currently withdrawn; historical placement is retained." }] : []),
    ]);
    return { manuscript: mapManuscript(manuscript), sections: sectionRows.map(mapSection).map((s) => ({ ...s, placements: placementViews.filter((p) => p.sectionId === s.id) })), bibliographyCandidates: orderedBibliography.map((r) => ({ paper: paper(r), citationNumber: Number(r.citationNumber), firstOccurrence: { sectionId: String(r.firstSectionId), placementId: String(r.firstPlacementId), claimRevisionId: String(r.firstClaimRevisionId) } })), warnings, counts: { sectionCount: sectionRows.length, placedClaimCount: placementViews.length, unsupportedPlacedClaimCount: placementViews.filter((p) => p.supportStatus === "unsupported").length, supersededPlacedClaimCount: placementViews.filter((p) => p.isSuperseded).length, withdrawnParentClaimCount: placementViews.filter((p) => p.currentClaimLifecycle === "withdrawn").length, distinctCitationCandidatePaperCount: orderedBibliography.length } };
  }

  async function listPlaceableClaimRevisions(projectId: string) {
    await requireProject(projectId);
    return rows(await db.execute(sql`select r.id, r.project_id, r.claim_id, r.sequence, r.state, r.claim_text, r.finalized_at,
      (select current_r.id from claim_revisions current_r where current_r.project_id=r.project_id and current_r.claim_id=r.claim_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) as latest_revision_id,
      (select current_r.state from claim_revisions current_r where current_r.project_id=r.project_id and current_r.claim_id=r.claim_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) as current_claim_state
      from claim_revisions r where r.project_id=${projectId} and r.finalized_at is not null and r.state='active' order by r.sequence desc, r.id`)).filter((r) => String(r.current_claim_state) === "active").map((r) => ({ id: String(r.id), claimId: String(r.claim_id), sequence: Number(r.sequence), claimText: String(r.claim_text), isCurrent: String(r.latest_revision_id) === String(r.id) }));
  }

  return { getOrCreateDefaultManuscript, getManuscript, createSection, renameSection, reorderSections, archiveSection, placeClaimRevision, replacePlacedClaimRevision, removeClaimPlacement, reorderClaimPlacements, getManuscriptPlacementHistory, listPlaceableClaimRevisions };
}
