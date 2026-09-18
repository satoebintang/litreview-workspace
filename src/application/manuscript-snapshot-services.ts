/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { buildFormattedManuscript, serializeManuscriptMarkdown, type ManuscriptFormattingSource } from "@/application/manuscript-formatting";

type Executor = Pick<Database, "execute">;
type Row = Record<string, unknown>;
const rows = (value: unknown) => value as unknown as Row[];
const id = (value: string) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID"); return value; };
const hash = (value: string) => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const bigintString = (value: unknown) => String(value);
const textArray = (values: readonly string[]) => values.length
  ? sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`
  : sql`ARRAY[]::text[]`;

type ManuscriptLoader = (executor: Executor, projectId: string, manuscriptId: string) => Promise<unknown>;
const isRetryableCaptureAbort = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  const code = String(value.code ?? value.cause?.code ?? "");
  return code === "40001" || code === "40P01";
};

export function createManuscriptSnapshotServices(db: Database, loadManuscriptProjection: ManuscriptLoader) {
  async function requireManuscript(projectId: string, manuscriptId: string) {
    const row = rows(await db.execute(sql`select id from manuscripts where project_id=${projectId} and id=${manuscriptId} limit 1`))[0];
    if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Manuscript does not belong to this project");
  }

  async function createManuscriptSnapshot(projectId: string, manuscriptId: string) {
    id(projectId); id(manuscriptId);
    const capture = () => db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      const boundary = rows(await tx.execute(sql`select statement_timestamp() as captured_at from manuscripts where project_id=${projectId} and id=${manuscriptId} limit 1`))[0];
      if (!boundary) throw new DomainError("CROSS_PROJECT_REFERENCE", "Manuscript does not belong to this project");
      const source = await loadManuscriptProjection(tx, projectId, manuscriptId) as any;
      const sourcePaperMap = new Map<string, any>(((source as any).bibliographyCandidates ?? []).map((candidate: any) => [String(candidate.paper.id), candidate.paper]));
      const formatted = buildFormattedManuscript(source as ManuscriptFormattingSource);
      const markdown = serializeManuscriptMarkdown(formatted);
      const paperMap = sourcePaperMap;
      const sectionCount = formatted.sections.length;
      const itemCount = formatted.sections.reduce((n, s) => n + s.items.length, 0);
      const bibliographyCount = formatted.bibliography.length;
      const warningCount = formatted.warnings.length;
      const parent = rows(await tx.execute(sql`insert into manuscript_snapshots
        (project_id, manuscript_id, title, citation_style, schema_version, renderer_version, captured_at, rendered_markdown, rendered_markdown_sha256, expected_section_count, expected_item_count, expected_bibliography_count, expected_warning_count)
        values (${projectId}, ${manuscriptId}, ${formatted.manuscript.title}, ${formatted.manuscript.citationStyle}, 1, 'manuscript-markdown-v1', ${boundary.captured_at}, ${markdown}, ${hash(markdown)}, ${sectionCount}, ${itemCount}, ${bibliographyCount}, ${warningCount}) returning id, sequence, captured_at`))[0];
      if (!parent) throw new DomainError("DATABASE_CONSTRAINT", "Snapshot could not be created");
      const sectionDbIds = new Map<string, string>();
      for (const [sectionPosition, section] of formatted.sections.entries()) {
        const row = rows(await tx.execute(sql`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) select ${projectId},${manuscriptId},${parent.id},${section.id},${section.title},${section.sectionType},${sectionPosition},s.sort_order from manuscript_sections s where s.project_id=${projectId} and s.manuscript_id=${manuscriptId} and s.id=${section.id} returning id`))[0];
        if (!row) throw new DomainError("DATABASE_CONSTRAINT", "Snapshot Section could not be created");
        sectionDbIds.set(section.id, String(row.id));
        for (const [itemPosition, item] of section.items.entries()) {
          const itemRow = rows(await tx.execute(sql`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) select ${projectId},${manuscriptId},${parent.id},${row.id},${section.id},${item.id},${item.itemType},${itemPosition},i.sort_order from manuscript_section_items i where i.project_id=${projectId} and i.manuscript_id=${manuscriptId} and i.section_id=${section.id} and i.id=${item.id} returning id`))[0];
          if (!itemRow) throw new DomainError("DATABASE_CONSTRAINT", "Snapshot item could not be created");
          if (item.itemType === "prose") {
            const proseBlockId = (item as any).proseBlockId;
            if (!proseBlockId) throw new DomainError("DATABASE_CONSTRAINT", "Prose SectionItem is missing its stable ProseBlock identity");
            await tx.execute(sql`insert into manuscript_snapshot_prose_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,source_prose_block_id,prose_revision_id,prose_text,source_section_id,source_section_item_id) values (${projectId},${manuscriptId},${itemRow.id},${parent.id},${proseBlockId},${item.currentRevisionId},${item.text},${section.id},${item.id})`);
          } else {
            const claim = item as any;
            const placement = claim.placement;
            // Keep the nullable ClaimRevision text exactly as persisted.  The
            // formatter intentionally renders a withdrawn/null revision as an
            // empty body, but the snapshot copy must retain the distinction.
            const exactClaimText = placement.claimRevision?.claimText ?? null;
            await tx.execute(sql`insert into manuscript_snapshot_claim_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,placement_id,claim_id,claim_revision_id,source_section_id,source_section_item_id,claim_text,rendered_citation_marker,capture_support_status,capture_is_current_claim_revision,capture_is_superseded,capture_claim_lifecycle) values (${projectId},${manuscriptId},${itemRow.id},${parent.id},${placement.id},${placement.claimId},${placement.claimRevisionId},${section.id},${item.id},${exactClaimText},${claim.renderedCitationMarker},${placement.supportStatus},${placement.isCurrentClaimRevision},${placement.isSuperseded},${placement.claimLifecycle})`);
          }
        }
      }
      for (const [bibliographyPosition, entry] of formatted.bibliography.entries()) {
        const paper = paperMap.get(entry.paperId);
        if (!paper) throw new DomainError("DATABASE_CONSTRAINT", "Snapshot bibliography Paper input is missing");
        await tx.execute(sql`insert into manuscript_snapshot_bibliography_entries (project_id,snapshot_id,paper_id,title,authors,publication_year,venue,doi,citation_number,bibliography_position,rendered_reference) values (${projectId},${parent.id},${entry.paperId},${paper.title},${textArray(paper.authors)},${paper.publicationYear},${paper.venue},${paper.doi},${entry.citationNumber},${bibliographyPosition},${entry.renderedReference})`);
      }
      // Bibliography rows are inserted after items; add memberships in a second pass.
      for (const section of formatted.sections) for (const item of section.items) if (item.itemType === "claim") {
        const claim = item as any;
        for (const [markerPosition, paperId] of (claim.citationPaperIds ?? []).entries()) await tx.execute(sql`insert into manuscript_snapshot_claim_bibliography_members (project_id,snapshot_id,snapshot_claim_item_id,bibliography_entry_id,marker_position) select ${projectId},${parent.id},si.id,be.id,${markerPosition} from manuscript_snapshot_items si join manuscript_snapshot_claim_items ci on ci.project_id=si.project_id and ci.snapshot_item_id=si.id and ci.snapshot_id=${parent.id} join manuscript_snapshot_bibliography_entries be on be.project_id=${projectId} and be.snapshot_id=${parent.id} and be.paper_id=${paperId} where si.source_section_item_id=${item.id}`);
      }
      for (const [warningPosition, warning] of formatted.warnings.entries()) await tx.execute(sql`insert into manuscript_snapshot_warnings (project_id,snapshot_id,warning_position,section_id,section_item_id,placement_id,claim_revision_id,paper_id,code,message,metadata_field) values (${projectId},${parent.id},${warningPosition},${(warning as any).sectionId ?? null},${(warning as any).sectionItemId ?? null},${(warning as any).placementId ?? null},${(warning as any).claimRevisionId ?? null},${(warning as any).paperId ?? null},${warning.code},${warning.message},${(warning as any).metadataField ?? null})`);
      const finalized = rows(await tx.execute(sql`update manuscript_snapshots set finalized_at=statement_timestamp() where project_id=${projectId} and id=${parent.id} and finalized_at is null returning id, sequence, finalized_at, captured_at, rendered_markdown_sha256`))[0];
      if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Snapshot could not be finalized");
      return { id: String(finalized.id), sequence: bigintString(finalized.sequence), capturedAt: finalized.captured_at as Date, finalizedAt: finalized.finalized_at as Date, renderedMarkdownSha256: String(finalized.rendered_markdown_sha256) };
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await capture(); }
      catch (error) { if (!isRetryableCaptureAbort(error) || attempt === 1) throw error; }
    }
    throw new DomainError("DATABASE_CONSTRAINT", "Snapshot capture did not complete");
  }

  async function listManuscriptSnapshots(projectId: string, manuscriptId: string) {
    id(projectId); id(manuscriptId);
    await requireManuscript(projectId, manuscriptId);
    return rows(await db.execute(sql`select id, sequence, project_id, manuscript_id, title, citation_style, schema_version, renderer_version, captured_at, finalized_at, rendered_markdown_sha256, expected_section_count, expected_item_count, expected_bibliography_count, expected_warning_count from manuscript_snapshots where project_id=${projectId} and manuscript_id=${manuscriptId} and finalized_at is not null order by sequence desc`)).map((r) => ({ id: String(r.id), sequence: bigintString(r.sequence), projectId: String(r.project_id), manuscriptId: String(r.manuscript_id), title: String(r.title), citationStyle: String(r.citation_style), schemaVersion: Number(r.schema_version), rendererVersion: String(r.renderer_version), capturedAt: r.captured_at as Date, finalizedAt: r.finalized_at as Date, renderedMarkdownSha256: String(r.rendered_markdown_sha256), counts: { sections: Number(r.expected_section_count), items: Number(r.expected_item_count), bibliography: Number(r.expected_bibliography_count), warnings: Number(r.expected_warning_count) } }));
  }

  async function getManuscriptSnapshot(projectId: string, manuscriptId: string, snapshotId: string) {
    id(projectId); id(manuscriptId); id(snapshotId);
    await requireManuscript(projectId, manuscriptId);
    const parent = rows(await db.execute(sql`select * from manuscript_snapshots where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${snapshotId} and finalized_at is not null limit 1`))[0];
    if (!parent) throw new DomainError("NOT_FOUND", "Snapshot was not found");
    const integrity = rows(await db.execute(sql`select assemble_manuscript_snapshot_markdown(${projectId},${snapshotId}) as assembled, encode(sha256(convert_to(rendered_markdown,'UTF8')),'hex') as calculated_hash from manuscript_snapshots where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${snapshotId} and finalized_at is not null limit 1`))[0];
    if (!integrity || String(integrity.assembled) !== String(parent.rendered_markdown) || String(integrity.calculated_hash) !== String(parent.rendered_markdown_sha256)) {
      throw new DomainError("DATABASE_CONSTRAINT", "Snapshot rendered artifact integrity check failed");
    }
    const sections = rows(await db.execute(sql`select * from manuscript_snapshot_sections where project_id=${projectId} and snapshot_id=${snapshotId} order by section_position`));
    const items = rows(await db.execute(sql`select i.*, p.prose_revision_id, p.prose_text, c.placement_id, c.claim_id, c.claim_revision_id, c.claim_text, c.rendered_citation_marker, c.capture_support_status, c.capture_is_current_claim_revision, c.capture_is_superseded, c.capture_claim_lifecycle from manuscript_snapshot_items i join manuscript_snapshot_sections ss on ss.project_id=i.project_id and ss.snapshot_id=i.snapshot_id and ss.id=i.snapshot_section_id left join manuscript_snapshot_prose_items p on p.project_id=i.project_id and p.snapshot_id=i.snapshot_id and p.snapshot_item_id=i.id left join manuscript_snapshot_claim_items c on c.project_id=i.project_id and c.snapshot_id=i.snapshot_id and c.snapshot_item_id=i.id where i.project_id=${projectId} and i.snapshot_id=${snapshotId} order by ss.section_position,i.item_position`));
    const bibliography = rows(await db.execute(sql`select * from manuscript_snapshot_bibliography_entries where project_id=${projectId} and snapshot_id=${snapshotId} order by bibliography_position`));
    const warnings = rows(await db.execute(sql`select * from manuscript_snapshot_warnings where project_id=${projectId} and snapshot_id=${snapshotId} order by warning_position`));
    return { id: String(parent.id), sequence: bigintString(parent.sequence), projectId: String(parent.project_id), manuscriptId: String(parent.manuscript_id), title: String(parent.title), citationStyle: String(parent.citation_style), schemaVersion: Number(parent.schema_version), rendererVersion: String(parent.renderer_version), capturedAt: parent.captured_at as Date, finalizedAt: parent.finalized_at as Date, renderedMarkdown: String(parent.rendered_markdown), renderedMarkdownSha256: String(parent.rendered_markdown_sha256), sections, items, bibliography, warnings };
  }

  async function getManuscriptSnapshotMarkdown(projectId: string, manuscriptId: string, snapshotId: string) {
    const snapshot = await getManuscriptSnapshot(projectId, manuscriptId, snapshotId);
    if (hash(snapshot.renderedMarkdown) !== snapshot.renderedMarkdownSha256) throw new DomainError("DATABASE_CONSTRAINT", "Snapshot Markdown hash is invalid");
    return snapshot.renderedMarkdown;
  }
  return { createManuscriptSnapshot, listManuscriptSnapshots, getManuscriptSnapshot, getManuscriptSnapshotMarkdown };
}
