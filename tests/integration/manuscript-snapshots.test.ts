import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { serializeManuscriptMarkdown } from "@/application/manuscript-formatting";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice25_snapshots_${Date.now()}_${randomUUID().slice(0, 8)}`;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

describe("Slice 25 immutable manuscript snapshots", () => {
  let admin: postgres.Sql | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let services: ReturnType<typeof createReviewServices>;
  let projectId = "";

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    db = createDb(databaseUrl(databaseName));
    await migrate(db.db, { migrationsFolder: migrationFolder });
    services = createReviewServices(db.db);
  });

  afterAll(async () => {
    if (db) await db.client.end();
    if (admin) {
      await admin.unsafe(`drop database if exists "${databaseName}"`);
      await admin.end();
    }
  });

  it("freezes composition, exact revisions, citation inputs, and Markdown across working-copy drift", async () => {
    const project = await services.createProject({ title: `Snapshot project ${randomUUID()}` });
    projectId = project.id;
    const manuscript = await services.getOrCreateDefaultManuscript(projectId);
    const first = await services.createSection(projectId, manuscript.id, { title: "Introduction", sectionType: "introduction" });
    const empty = await services.createSection(projectId, manuscript.id, { title: "Empty Section", sectionType: "custom" });
    const third = await services.createSection(projectId, manuscript.id, { title: "Results", sectionType: "results" });
    await services.reorderSections(projectId, manuscript.id, [third.id, empty.id, first.id]);

    const prose = await services.createProseBlock(projectId, manuscript.id, first.id, "Original prose\r\nwith two lines");
    const paper = await services.addPaper(projectId, {
      title: "Original Paper",
      authors: ["Ada Author"],
      publicationYear: 2020,
      venue: "Original Journal",
      doi: "10.5555/original",
    });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "A source passage", pageNumber: 1 });
    const claim = await services.createClaim(projectId, { claimText: "Original claim" });
    const claimRevision = await services.createClaimRevision(projectId, claim.id, {
      claimText: "Original claim",
      lifecycle: "active",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: claim.revision.id,
    });
    const placement = await services.placeClaimRevision(projectId, manuscript.id, third.id, claimRevision.revision.id);
    const unsupportedClaim = await services.createClaim(projectId, { claimText: "Unsupported claim" });
    const unsupportedPlacement = await services.placeClaimRevision(projectId, manuscript.id, empty.id, unsupportedClaim.revision.id);

    const before = await services.getFormattedManuscript(projectId, manuscript.id);
    const snapshot1 = await services.createManuscriptSnapshot(projectId, manuscript.id);
    const frozen1 = await services.getManuscriptSnapshot(projectId, manuscript.id, snapshot1.id);
    expect(frozen1.sequence).toMatch(/^\d+$/);
    expect(frozen1.sections.map((section) => String(section.source_section_id))).toEqual([third.id, empty.id, first.id]);
    expect(frozen1.sections.some((section) => String(section.source_section_id) === empty.id)).toBe(true);
    expect(frozen1.items.map((item) => String(item.source_section_item_id))).toEqual([placement.id, unsupportedPlacement.id, prose.id]);
    expect(frozen1.items.find((item) => String(item.source_section_item_id) === prose.id)?.prose_revision_id).toBe(prose.currentRevisionId);
    expect(frozen1.bibliography[0].title).toBe("Original Paper");
    expect(frozen1.warnings.map((warning) => warning.code)).toEqual(["unsupported_claim_revision", "no_citation_candidates"]);
    expect(frozen1.renderedMarkdown).toBe(serializeManuscriptMarkdown(before));
    expect(createHash("sha256").update(Buffer.from(frozen1.renderedMarkdown, "utf8")).digest("hex")).toBe(frozen1.renderedMarkdownSha256);
    const originalMarkdown = frozen1.renderedMarkdown;

    await db!.client.unsafe("update papers set title=$1, authors=$2, publication_year=$3, venue=$4, doi=$5, updated_at=now() where project_id=$6 and id=$7", ["Corrected Paper", ["Grace Corrector"], 2024, "Corrected Journal", "10.5555/corrected", projectId, paper.id]);
    const revisedClaim = await services.createClaimRevision(projectId, claim.id, {
      claimText: "Revised claim",
      lifecycle: "active",
      supports: [{ kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: claimRevision.revision.id,
    });
    await services.replacePlacedClaimRevision(projectId, manuscript.id, placement.id, revisedClaim.revision.id, claimRevision.revision.id);
    const revisedProse = await services.reviseProseBlock(projectId, manuscript.id, prose.id, { text: "Revised prose", expectedCurrentRevisionId: prose.currentRevisionId });
    await services.renameSection(projectId, manuscript.id, first.id, "Renamed Introduction");
    await services.removeClaimPlacement(projectId, manuscript.id, unsupportedPlacement.id);
    await services.archiveSection(projectId, manuscript.id, empty.id);
    await services.reorderSections(projectId, manuscript.id, [first.id, third.id]);
    await services.setManuscriptCitationStyle(projectId, manuscript.id, "author_year");
    await db!.client.unsafe("update manuscripts set title=$1, updated_at=now() where project_id=$2 and id=$3", ["Current working title", projectId, manuscript.id]);

    const snapshot2 = await services.createManuscriptSnapshot(projectId, manuscript.id);
    const frozen2 = await services.getManuscriptSnapshot(projectId, manuscript.id, snapshot2.id);
    expect(frozen2.sections.map((section) => String(section.source_section_id))).toEqual([first.id, third.id]);
    expect(frozen2.sections.find((section) => String(section.source_section_id) === first.id)?.title).toBe("Renamed Introduction");
    expect(frozen2.items.find((item) => String(item.source_section_item_id) === prose.id)?.prose_revision_id).toBe(revisedProse.currentRevisionId);
    expect(frozen2.items.find((item) => String(item.source_section_item_id) === placement.id)?.claim_revision_id).toBe(revisedClaim.revision.id);
    expect(frozen2.bibliography[0].title).toBe("Corrected Paper");
    expect(frozen2.citationStyle).toBe("author_year");
    expect(frozen2.renderedMarkdown).toContain("- ");
    expect(frozen2.renderedMarkdownSha256).toBe(createHash("sha256").update(Buffer.from(frozen2.renderedMarkdown, "utf8")).digest("hex"));

    const refetched1 = await services.getManuscriptSnapshot(projectId, manuscript.id, snapshot1.id);
    expect(refetched1.title).toBe("Manuscript");
    expect(refetched1.renderedMarkdown).toBe(originalMarkdown);
    expect(refetched1.renderedMarkdown).toContain("Original claim");
    expect(refetched1.renderedMarkdown).toContain("Original Paper");
    expect(refetched1.renderedMarkdown).not.toContain("Revised claim");
    expect(refetched1.renderedMarkdown).not.toContain("Corrected Paper");
    expect(await services.getManuscriptSnapshotMarkdown(projectId, manuscript.id, snapshot1.id)).toBe(originalMarkdown);
    expect((await services.listManuscriptSnapshots(projectId, manuscript.id)).map((snapshot) => snapshot.sequence)).toEqual([snapshot2.sequence, snapshot1.sequence]);
  });

  it("rejects cross-project capture and direct SQL mutation or incomplete finalization", async () => {
    const project = await services.createProject({ title: `Snapshot guard project ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Guard" });
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Guard prose");
    const snapshot = await services.createManuscriptSnapshot(project.id, manuscript.id);
    const foreignProject = await services.createProject({ title: `Foreign snapshot project ${randomUUID()}` });
    const foreignManuscript = await services.getOrCreateDefaultManuscript(foreignProject.id);
    await expect(services.createManuscriptSnapshot(project.id, foreignManuscript.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });

    await expect(db!.client.unsafe("update manuscript_snapshots set title=$1 where project_id=$2 and id=$3", ["tampered", project.id, snapshot.id])).rejects.toThrow(/immutable/i);
    await expect(db!.client.unsafe("delete from manuscript_snapshot_items where project_id=$1 and snapshot_id=$2", [project.id, snapshot.id])).rejects.toThrow(/immutable/i);
    await expect(db!.client.unsafe("insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values ($1,$2,$3,$4,$5,$6,$7,$8)", [project.id, manuscript.id, snapshot.id, section.id, "duplicate", "custom", 99, 99])).rejects.toThrow(/finalized|immutable/i);
    await expect(db!.client.unsafe("delete from manuscript_snapshots where project_id=$1 and id=$2", [project.id, snapshot.id])).rejects.toThrow(/immutable/i);
    await expect(db!.client.begin(async (tx) => {
      const invalidId = randomUUID();
      await tx`insert into manuscript_snapshots (id,project_id,manuscript_id,title,citation_style,schema_version,renderer_version,captured_at,rendered_markdown,rendered_markdown_sha256,expected_section_count,expected_item_count,expected_bibliography_count,expected_warning_count) values (${invalidId},${project.id},${manuscript.id},'Invalid','numeric',1,'manuscript-markdown-v1',statement_timestamp(),'# Invalid\n',repeat('0',64),1,1,0,0)`;
      await tx`update manuscript_snapshots set finalized_at=statement_timestamp() where project_id=${project.id} and id=${invalidId}`;
    })).rejects.toThrow(/incomplete|composition|integrity/i);
    expect(prose.id).toBeTruthy();
  });

  it("reports structured/artifact disagreement on historical reads", async () => {
    const project = await services.createProject({ title: `Snapshot integrity project ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Integrity" });
    await services.createProseBlock(project.id, manuscript.id, section.id, "Integrity prose");
    const snapshot = await services.createManuscriptSnapshot(project.id, manuscript.id);

    await db!.client.unsafe("alter table manuscript_snapshot_sections disable trigger manuscript_snapshot_sections_immutable");
    try {
      await db!.client.unsafe("update manuscript_snapshot_sections set title=$1 where project_id=$2 and snapshot_id=$3", ["Tampered", project.id, snapshot.id]);
      await expect(services.getManuscriptSnapshot(project.id, manuscript.id, snapshot.id)).rejects.toMatchObject({ code: "DATABASE_CONSTRAINT" });
      await expect(services.getManuscriptSnapshotMarkdown(project.id, manuscript.id, snapshot.id)).rejects.toMatchObject({ code: "DATABASE_CONSTRAINT" });
      await db!.client.unsafe("update manuscript_snapshot_sections set title=$1 where project_id=$2 and snapshot_id=$3", ["Integrity", project.id, snapshot.id]);
    } finally {
      await db!.client.unsafe("alter table manuscript_snapshot_sections enable trigger manuscript_snapshot_sections_immutable");
    }
  });

  it("rejects a copied Prose text mismatch at deferred finalization and accepts the exact pair", async () => {
    const project = await services.createProject({ title: `Prose mismatch ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Prose" });
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Exact prose");
    const projection = await services.getFormattedManuscript(project.id, manuscript.id);
    const markdown = serializeManuscriptMarkdown(projection);
    const makeDraft = async (copiedText: string) => {
      const draftId = randomUUID();
      await db!.client.begin(async (tx) => {
        await tx`insert into manuscript_snapshots (id,project_id,manuscript_id,title,citation_style,schema_version,renderer_version,captured_at,rendered_markdown,rendered_markdown_sha256,expected_section_count,expected_item_count,expected_bibliography_count,expected_warning_count) values (${draftId},${project.id},${manuscript.id},${projection.manuscript.title},${projection.manuscript.citationStyle},1,'manuscript-markdown-v1',statement_timestamp(),${markdown},${createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex")},1,1,0,0)`;
        const [{ id: snapshotSectionId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${draftId},${section.id},'Prose','custom',0,0) returning id`;
        const [{ id: snapshotItemId }] = await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${project.id},${manuscript.id},${draftId},${snapshotSectionId},${section.id},${prose.id},'prose',0,0) returning id`;
        await tx`insert into manuscript_snapshot_prose_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,source_prose_block_id,prose_revision_id,prose_text,source_section_id,source_section_item_id) values (${project.id},${manuscript.id},${snapshotItemId},${draftId},${prose.id},${prose.currentRevisionId},${copiedText},${section.id},${prose.id})`;
        await tx`update manuscript_snapshots set finalized_at=statement_timestamp() where project_id=${project.id} and id=${draftId}`;
      });
      return draftId;
    };
    await expect(makeDraft("Not the referenced revision")).rejects.toThrow(/Prose identity|copied text|incomplete/i);
    const exactDraft = await makeDraft("Exact prose");
    const rows = await db!.client`select finalized_at from manuscript_snapshots where project_id=${project.id} and id=${exactDraft}`;
    expect(rows[0].finalized_at).not.toBeNull();
  });

  it("rejects a copied Claim text mismatch, including NULL-sensitive equality", async () => {
    const project = await services.createProject({ title: `Claim mismatch ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Claims" });
    const claim = await services.createClaim(project.id, { claimText: "Exact claim" });
    const revision = await services.createClaimRevision(project.id, claim.id, { claimText: "Exact claim", lifecycle: "active", supports: [], expectedCurrentRevisionId: claim.revision.id });
    const placement = await services.placeClaimRevision(project.id, manuscript.id, section.id, revision.revision.id);
    const projection = await services.getFormattedManuscript(project.id, manuscript.id);
    const formattedClaim = projection.sections[0].items[0];
    if (formattedClaim.itemType !== "claim") throw new Error("expected Claim item");
    const markdown = serializeManuscriptMarkdown(projection);
    const warnings = projection.warnings;
    const makeDraft = async (copiedText: string | null) => {
      const draftId = randomUUID();
      await db!.client.begin(async (tx) => {
        await tx`insert into manuscript_snapshots (id,project_id,manuscript_id,title,citation_style,schema_version,renderer_version,captured_at,rendered_markdown,rendered_markdown_sha256,expected_section_count,expected_item_count,expected_bibliography_count,expected_warning_count) values (${draftId},${project.id},${manuscript.id},${projection.manuscript.title},${projection.manuscript.citationStyle},1,'manuscript-markdown-v1',statement_timestamp(),${markdown},${createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex")},1,1,0,${warnings.length})`;
        const [{ id: snapshotSectionId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${draftId},${section.id},'Claims','custom',0,0) returning id`;
        const [{ id: snapshotItemId }] = await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${project.id},${manuscript.id},${draftId},${snapshotSectionId},${section.id},${placement.id},'claim',0,0) returning id`;
        await tx`insert into manuscript_snapshot_claim_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,placement_id,claim_id,claim_revision_id,source_section_id,source_section_item_id,claim_text,rendered_citation_marker,capture_support_status,capture_is_current_claim_revision,capture_is_superseded,capture_claim_lifecycle) values (${project.id},${manuscript.id},${snapshotItemId},${draftId},${placement.id},${claim.id},${revision.revision.id},${section.id},${placement.id},${copiedText},'',${formattedClaim.placement.supportStatus},true,false,'active')`;
        for (const [position, warning] of warnings.entries()) await tx`insert into manuscript_snapshot_warnings (project_id,snapshot_id,warning_position,section_id,section_item_id,placement_id,claim_revision_id,paper_id,code,message,metadata_field) values (${project.id},${draftId},${position},${warning.sectionId ?? null},${warning.sectionItemId ?? null},${warning.placementId ?? null},${warning.claimRevisionId ?? null},${warning.paperId ?? null},${warning.code},${warning.message},${warning.metadataField ?? null})`;
        await tx`update manuscript_snapshots set finalized_at=statement_timestamp() where project_id=${project.id} and id=${draftId}`;
      });
      return draftId;
    };
    await expect(makeDraft("Wrong claim")).rejects.toThrow(/Claim identity|copied text|incomplete/i);
    await expect(makeDraft(null)).rejects.toThrow(/Claim identity|copied text|incomplete/i);
    const exactDraft = await makeDraft("Exact claim");
    const exactRows = await db!.client`select finalized_at from manuscript_snapshots where project_id=${project.id} and id=${exactDraft}`;
    expect(exactRows[0].finalized_at).not.toBeNull();
    expect(formattedClaim.claimText).toBe("Exact claim");
  });

  it("rejects every finalized-parent and finalized-child SQL mutation path", async () => {
    const project = await services.createProject({ title: `Snapshot mutation matrix ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Matrix" });
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Matrix prose");
    const paper = await services.addPaper(project.id, { title: "Matrix paper", authors: ["Matrix Author"], publicationYear: 2020, venue: "Matrix Venue", doi: "10.5555/matrix" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    const evidence = await services.recordEvidence(project.id, { paperId: paper.id, sourceText: "Matrix source", pageNumber: 1 });
    const supportedClaim = await services.createClaim(project.id, { claimText: "Supported matrix claim" });
    const supportedRevision = await services.createClaimRevision(project.id, supportedClaim.id, { claimText: "Supported matrix claim", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: supportedClaim.revision.id });
    await services.placeClaimRevision(project.id, manuscript.id, section.id, supportedRevision.revision.id);
    const unsupportedSection = await services.createSection(project.id, manuscript.id, { title: "Warnings" });
    const unsupportedClaim = await services.createClaim(project.id, { claimText: "Unsupported matrix claim" });
    const unsupportedRevision = await services.createClaimRevision(project.id, unsupportedClaim.id, { claimText: "Unsupported matrix claim", lifecycle: "active", supports: [], expectedCurrentRevisionId: unsupportedClaim.revision.id });
    await services.placeClaimRevision(project.id, manuscript.id, unsupportedSection.id, unsupportedRevision.revision.id);
    const snapshot = await services.createManuscriptSnapshot(project.id, manuscript.id);
    const [sectionRow] = await db!.client`select id from manuscript_snapshot_sections where project_id=${project.id} and snapshot_id=${snapshot.id} order by section_position limit 1`;
    const [itemRow] = await db!.client`select id from manuscript_snapshot_items where project_id=${project.id} and snapshot_id=${snapshot.id} and item_type='prose' limit 1`;
    const [proseRow] = await db!.client`select snapshot_item_id as id from manuscript_snapshot_prose_items where project_id=${project.id} and snapshot_id=${snapshot.id} limit 1`;
    const [claimRow] = await db!.client`select snapshot_item_id as id from manuscript_snapshot_claim_items where project_id=${project.id} and snapshot_id=${snapshot.id} and claim_id=${supportedClaim.id} limit 1`;
    const [bibRow] = await db!.client`select id from manuscript_snapshot_bibliography_entries where project_id=${project.id} and snapshot_id=${snapshot.id} limit 1`;
    const [memberRow] = await db!.client`select snapshot_claim_item_id, bibliography_entry_id from manuscript_snapshot_claim_bibliography_members where project_id=${project.id} and snapshot_id=${snapshot.id} limit 1`;
    const [warningRow] = await db!.client`select id from manuscript_snapshot_warnings where project_id=${project.id} and snapshot_id=${snapshot.id} limit 1`;
    const reject = (operation: Promise<unknown>) => expect(operation).rejects.toThrow(/immutable|finalized|cannot mutate/i);

    const draftArtifact = "# Draft\n\n## References\n";
    const draftHash = createHash("sha256").update(Buffer.from(draftArtifact, "utf8")).digest("hex");
    const rejectDraftMutation = async (mutation: (tx: postgres.TransactionSql, draftId: string) => Promise<unknown>) => {
      const draftId = randomUUID();
      let mutationError: unknown;
      await expect(db!.client.begin(async (tx) => {
        await tx`insert into manuscript_snapshots (id,project_id,manuscript_id,title,citation_style,schema_version,renderer_version,captured_at,rendered_markdown,rendered_markdown_sha256,expected_section_count,expected_item_count,expected_bibliography_count,expected_warning_count) values (${draftId},${project.id},${manuscript.id},'Draft','numeric',1,'manuscript-markdown-v1',statement_timestamp(),${draftArtifact},${draftHash},0,0,0,0)`;
        try {
          await mutation(tx, draftId);
        } catch (error) {
          mutationError = error;
          throw new Error("rollback unfinalized draft");
        }
        throw new Error("mutation unexpectedly succeeded");
      })).rejects.toThrow("rollback unfinalized draft");
      expect(String((mutationError as { message?: unknown } | undefined)?.message ?? mutationError)).toMatch(/immutable|finalized|cannot mutate/i);
    };
    await rejectDraftMutation((tx, draftId) => tx`update manuscript_snapshots set title='changed' where project_id=${project.id} and id=${draftId}`);
    await rejectDraftMutation((tx, draftId) => tx`update manuscript_snapshots set manuscript_id=${randomUUID()} where project_id=${project.id} and id=${draftId}`);
    await rejectDraftMutation((tx, draftId) => tx`update manuscript_snapshots set finalized_at=null where project_id=${project.id} and id=${draftId}`);

    await reject(db!.client.unsafe("update manuscript_snapshots set title=$1 where project_id=$2 and id=$3", ["changed", project.id, snapshot.id]));
    await reject(db!.client.unsafe("update manuscript_snapshots set manuscript_id=$1 where project_id=$2 and id=$3", [randomUUID(), project.id, snapshot.id]));
    await reject(db!.client.unsafe("update manuscript_snapshots set finalized_at=now() where project_id=$1 and id=$2", [project.id, snapshot.id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshots where project_id=$1 and id=$2", [project.id, snapshot.id]));

    const insertions = [
      db!.client.unsafe("insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values ($1,$2,$3,$4,'x','custom',99,99)", [project.id, manuscript.id, snapshot.id, section.id]),
      db!.client.unsafe("insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values ($1,$2,$3,$4,$5,$6,'prose',99,99)", [project.id, manuscript.id, snapshot.id, sectionRow.id, section.id, prose.id]),
      db!.client.unsafe("insert into manuscript_snapshot_prose_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,source_prose_block_id,prose_revision_id,prose_text,source_section_id,source_section_item_id) values ($1,$2,$3,$4,$5,$6,'x',$7,$5)", [project.id, manuscript.id, randomUUID(), snapshot.id, prose.id, prose.currentRevisionId, section.id]),
      db!.client.unsafe("insert into manuscript_snapshot_claim_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,placement_id,claim_id,claim_revision_id,source_section_id,source_section_item_id,claim_text,rendered_citation_marker,capture_support_status,capture_is_current_claim_revision,capture_is_superseded,capture_claim_lifecycle) values ($1,$2,$3,$4,$5,$6,$7,$8,$5,'x','','supported',true,false,'active')", [project.id, manuscript.id, randomUUID(), snapshot.id, randomUUID(), supportedClaim.id, supportedRevision.revision.id, section.id]),
      db!.client.unsafe("insert into manuscript_snapshot_bibliography_entries (project_id,snapshot_id,paper_id,title,authors,publication_year,venue,doi,citation_number,bibliography_position,rendered_reference) values ($1,$2,$3,'x',array['x'],2020,'x',null,99,99,'x')", [project.id, snapshot.id, paper.id]),
      db!.client.unsafe("insert into manuscript_snapshot_claim_bibliography_members (project_id,snapshot_id,snapshot_claim_item_id,bibliography_entry_id,marker_position) values ($1,$2,$3,$4,99)", [project.id, snapshot.id, claimRow.id, bibRow.id]),
      db!.client.unsafe("insert into manuscript_snapshot_warnings (project_id,snapshot_id,warning_position,code,message) values ($1,$2,99,'x','x')", [project.id, snapshot.id]),
    ];
    for (const insertion of insertions) await reject(insertion);

    await reject(db!.client.unsafe("update manuscript_snapshot_sections set title='x' where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, sectionRow.id]));
    await reject(db!.client.unsafe("update manuscript_snapshot_items set item_position=item_position where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, itemRow.id]));
    await reject(db!.client.unsafe("update manuscript_snapshot_prose_items set prose_text=prose_text where project_id=$1 and snapshot_id=$2 and snapshot_item_id=$3", [project.id, snapshot.id, proseRow.id]));
    await reject(db!.client.unsafe("update manuscript_snapshot_claim_items set claim_text=claim_text where project_id=$1 and snapshot_id=$2 and snapshot_item_id=$3", [project.id, snapshot.id, claimRow.id]));
    await reject(db!.client.unsafe("update manuscript_snapshot_bibliography_entries set title=title where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, bibRow.id]));
    await reject(db!.client.unsafe("update manuscript_snapshot_claim_bibliography_members set marker_position=marker_position where project_id=$1 and snapshot_id=$2 and snapshot_claim_item_id=$3 and bibliography_entry_id=$4", [project.id, snapshot.id, memberRow.snapshot_claim_item_id, memberRow.bibliography_entry_id]));
    await reject(db!.client.unsafe("update manuscript_snapshot_warnings set message=message where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, warningRow.id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshot_sections where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, sectionRow.id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshot_items where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, itemRow.id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshot_prose_items where project_id=$1 and snapshot_id=$2 and snapshot_item_id=$3", [project.id, snapshot.id, proseRow.id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshot_claim_items where project_id=$1 and snapshot_id=$2 and snapshot_item_id=$3", [project.id, snapshot.id, claimRow.id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshot_bibliography_entries where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, bibRow.id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshot_claim_bibliography_members where project_id=$1 and snapshot_id=$2 and snapshot_claim_item_id=$3 and bibliography_entry_id=$4", [project.id, snapshot.id, memberRow.snapshot_claim_item_id, memberRow.bibliography_entry_id]));
    await reject(db!.client.unsafe("delete from manuscript_snapshot_warnings where project_id=$1 and snapshot_id=$2 and id=$3", [project.id, snapshot.id, warningRow.id]));
  });

  it("rejects representative malformed deferred compositions without rejecting an explicit empty composition", async () => {
    const project = await services.createProject({ title: `Snapshot completeness ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Source" });
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Source prose");
    const malformedClaim = await services.createClaim(project.id, { claimText: "Malformed subtype claim" });
    const malformedRevision = await services.createClaimRevision(project.id, malformedClaim.id, { claimText: "Malformed subtype claim", lifecycle: "active", supports: [], expectedCurrentRevisionId: malformedClaim.revision.id });
    const malformedPlacement = await services.placeClaimRevision(project.id, manuscript.id, section.id, malformedRevision.revision.id);
    const removedProse = await services.createProseBlock(project.id, manuscript.id, section.id, "Removed extra prose");
    await services.removeProseBlock(project.id, manuscript.id, removedProse.id);
    const markdown = "# Manuscript\n\n## References\n";
    const hash = createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");
    const runDraft = async (expectedSections: number, expectedItems: number, build: (tx: postgres.TransactionSql, id: string) => Promise<void>, artifact = markdown, artifactHash = hash) => {
      const id = randomUUID();
      await db!.client.begin(async (tx) => {
        await tx`insert into manuscript_snapshots (id,project_id,manuscript_id,title,citation_style,schema_version,renderer_version,captured_at,rendered_markdown,rendered_markdown_sha256,expected_section_count,expected_item_count,expected_bibliography_count,expected_warning_count) values (${id},${project.id},${manuscript.id},'Manuscript','numeric',1,'manuscript-markdown-v1',statement_timestamp(),${artifact},${artifactHash},${expectedSections},${expectedItems},0,0)`;
        await build(tx, id);
        await tx`update manuscript_snapshots set finalized_at=statement_timestamp() where project_id=${project.id} and id=${id}`;
      });
      return id;
    };

    await expect(runDraft(1, 1, async (tx, id) => {
      const [{ id: snapshotSectionId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${id},${section.id},'Source','custom',0,0) returning id`;
      await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${project.id},${manuscript.id},${id},${snapshotSectionId},${section.id},${prose.id},'prose',0,0)`;
    })).rejects.toThrow(/subtype|incomplete|composition/i);
    await expect(runDraft(1, 1, async (tx, id) => {
      const [{ id: snapshotSectionId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${id},${section.id},'Source','custom',0,0) returning id`;
      const [{ id: snapshotItemId }] = await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${project.id},${manuscript.id},${id},${snapshotSectionId},${section.id},${prose.id},'prose',0,0) returning id`;
      await tx`insert into manuscript_snapshot_prose_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,source_prose_block_id,prose_revision_id,prose_text,source_section_id,source_section_item_id) values (${project.id},${manuscript.id},${snapshotItemId},${id},${prose.id},${prose.currentRevisionId},'Source prose',${section.id},${prose.id})`;
      await tx`insert into manuscript_snapshot_claim_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,placement_id,claim_id,claim_revision_id,source_section_id,source_section_item_id,claim_text,rendered_citation_marker,capture_support_status,capture_is_current_claim_revision,capture_is_superseded,capture_claim_lifecycle) values (${project.id},${manuscript.id},${snapshotItemId},${id},${malformedPlacement.id},${malformedClaim.id},${malformedRevision.revision.id},${section.id},${prose.id},'Malformed subtype claim','', 'unsupported', true, false, 'active')`;
    })).rejects.toThrow(/subtype|incomplete/i);
    await expect(runDraft(1, 0, async (tx, id) => { await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${id},${section.id},'Source','custom',1,0)`; })).rejects.toThrow(/dense|composition|incomplete/i);
    await expect(runDraft(1, 1, async (tx, id) => {
      const [{ id: snapshotSectionId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${id},${section.id},'Source','custom',0,0) returning id`;
      const [{ id: snapshotItemId }] = await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${project.id},${manuscript.id},${id},${snapshotSectionId},${section.id},${prose.id},'prose',1,0) returning id`;
      await tx`insert into manuscript_snapshot_prose_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,source_prose_block_id,prose_revision_id,prose_text,source_section_id,source_section_item_id) values (${project.id},${manuscript.id},${snapshotItemId},${id},${prose.id},${prose.currentRevisionId},'Source prose',${section.id},${prose.id})`;
    })).rejects.toThrow(/dense|incomplete/i);
    await expect(runDraft(2, 1, async (tx, id) => {
      const [{ id: snapshotSectionId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${id},${section.id},'Source','custom',0,0) returning id`;
      const [{ id: snapshotItemId }] = await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${project.id},${manuscript.id},${id},${snapshotSectionId},${section.id},${prose.id},'prose',0,0) returning id`;
      await tx`insert into manuscript_snapshot_prose_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,source_prose_block_id,prose_revision_id,prose_text,source_section_id,source_section_item_id) values (${project.id},${manuscript.id},${snapshotItemId},${id},${prose.id},${prose.currentRevisionId},'Source prose',${section.id},${prose.id})`;
    })).rejects.toThrow(/incomplete/i);
    await expect(runDraft(0, 0, async () => undefined)).rejects.toThrow(/composition|incomplete/i);
    await expect(runDraft(1, 0, async () => undefined)).rejects.toThrow(/incomplete|composition/i);
    await expect(runDraft(1, 2, async (tx, id) => {
      const [{ id: snapshotSectionId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${project.id},${manuscript.id},${id},${section.id},'Source','custom',0,0) returning id`;
      for (const [position, item] of [[0, prose], [1, removedProse]] as const) {
        const [{ id: snapshotItemId }] = await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${project.id},${manuscript.id},${id},${snapshotSectionId},${section.id},${item.id},'prose',${position},${position}) returning id`;
        await tx`insert into manuscript_snapshot_prose_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,source_prose_block_id,prose_revision_id,prose_text,source_section_id,source_section_item_id) values (${project.id},${manuscript.id},${snapshotItemId},${id},${item.id},${item.currentRevisionId},${item.text},${section.id},${item.id})`;
      }
    })).rejects.toThrow(/composition|incomplete/i);
    await expect(runDraft(0, 0, async () => undefined, "# Wrong\n", hash)).rejects.toThrow(/integrity|incomplete/i);
    await expect(runDraft(0, 0, async () => undefined, markdown, "0".repeat(64))).rejects.toThrow(/integrity|incomplete/i);
    await expect(runDraft(0, 0, async (tx, id) => { await tx`insert into manuscript_snapshot_claim_bibliography_members (project_id,snapshot_id,snapshot_claim_item_id,bibliography_entry_id,marker_position) values (${project.id},${id},${randomUUID()},${randomUUID()},0)`; })).rejects.toBeDefined();
    await expect(runDraft(1, 0, async (tx, id) => { await tx`insert into manuscript_snapshot_warnings (project_id,snapshot_id,warning_position,section_id,code,message) values (${project.id},${id},0,${section.id},'x','x')`; })).rejects.toBeDefined();

    const membershipProject = await services.createProject({ title: `Malformed membership ${randomUUID()}` });
    const membershipManuscript = await services.getOrCreateDefaultManuscript(membershipProject.id);
    const membershipSection = await services.createSection(membershipProject.id, membershipManuscript.id, { title: "Membership" });
    const membershipPaper = await services.addPaper(membershipProject.id, { title: "Membership paper", authors: ["Author"], publicationYear: 2020, venue: "Venue", doi: null });
    await services.recordScreeningDecision(membershipProject.id, membershipPaper.id, { decision: "include" });
    const membershipEvidence = await services.recordEvidence(membershipProject.id, { paperId: membershipPaper.id, sourceText: "Membership source", pageNumber: 1 });
    const membershipClaim = await services.createClaim(membershipProject.id, { claimText: "Member claim" });
    const membershipRevision = await services.createClaimRevision(membershipProject.id, membershipClaim.id, { claimText: "Member claim", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: membershipEvidence.id }], expectedCurrentRevisionId: membershipClaim.revision.id });
    const membershipPlacement = await services.placeClaimRevision(membershipProject.id, membershipManuscript.id, membershipSection.id, membershipRevision.revision.id);
    const membershipArtifact = "# Manuscript\n\n## Membership\n\nMember claim\n\n## References\n\nFrozen ref\n";
    const membershipHash = createHash("sha256").update(Buffer.from(membershipArtifact, "utf8")).digest("hex");
    await expect(db!.client.begin(async (tx) => {
      const membershipSnapshotId = randomUUID();
      await tx`insert into manuscript_snapshots (id,project_id,manuscript_id,title,citation_style,schema_version,renderer_version,captured_at,rendered_markdown,rendered_markdown_sha256,expected_section_count,expected_item_count,expected_bibliography_count,expected_warning_count) values (${membershipSnapshotId},${membershipProject.id},${membershipManuscript.id},'Manuscript','numeric',1,'manuscript-markdown-v1',statement_timestamp(),${membershipArtifact},${membershipHash},1,1,1,0)`;
      const [{ id: membershipSectionSnapshotId }] = await tx`insert into manuscript_snapshot_sections (project_id,manuscript_id,snapshot_id,source_section_id,title,section_type,section_position,source_sort_order) values (${membershipProject.id},${membershipManuscript.id},${membershipSnapshotId},${membershipSection.id},'Membership','custom',0,0) returning id`;
      const [{ id: membershipItemSnapshotId }] = await tx`insert into manuscript_snapshot_items (project_id,manuscript_id,snapshot_id,snapshot_section_id,source_section_id,source_section_item_id,item_type,item_position,source_sort_order) values (${membershipProject.id},${membershipManuscript.id},${membershipSnapshotId},${membershipSectionSnapshotId},${membershipSection.id},${membershipPlacement.id},'claim',0,0) returning id`;
      await tx`insert into manuscript_snapshot_claim_items (project_id,manuscript_id,snapshot_item_id,snapshot_id,placement_id,claim_id,claim_revision_id,source_section_id,source_section_item_id,claim_text,rendered_citation_marker,capture_support_status,capture_is_current_claim_revision,capture_is_superseded,capture_claim_lifecycle) values (${membershipProject.id},${membershipManuscript.id},${membershipItemSnapshotId},${membershipSnapshotId},${membershipPlacement.id},${membershipClaim.id},${membershipRevision.revision.id},${membershipSection.id},${membershipPlacement.id},'Member claim','', 'supported', true, false, 'active')`;
      const [{ id: membershipBibId }] = await tx`insert into manuscript_snapshot_bibliography_entries (project_id,snapshot_id,paper_id,title,authors,publication_year,venue,doi,citation_number,bibliography_position,rendered_reference) values (${membershipProject.id},${membershipSnapshotId},${membershipPaper.id},'Membership paper',array['Author'],2020,'Venue',null,1,0,'Frozen ref') returning id`;
      await tx`insert into manuscript_snapshot_claim_bibliography_members (project_id,snapshot_id,snapshot_claim_item_id,bibliography_entry_id,marker_position) values (${membershipProject.id},${membershipSnapshotId},${membershipItemSnapshotId},${membershipBibId},0)`;
      await tx`update manuscript_snapshots set finalized_at=statement_timestamp() where project_id=${membershipProject.id} and id=${membershipSnapshotId}`;
    })).rejects.toThrow(/citation membership|incomplete|composition/i);

    const emptyProject = await services.createProject({ title: `Explicit empty ${randomUUID()}` });
    const emptyManuscript = await services.getOrCreateDefaultManuscript(emptyProject.id);
    const emptySnapshot = await services.createManuscriptSnapshot(emptyProject.id, emptyManuscript.id);
    const emptyDetail = await services.getManuscriptSnapshot(emptyProject.id, emptyManuscript.id, emptySnapshot.id);
    expect(emptyDetail.sections).toHaveLength(0);
    expect(emptyDetail.items).toHaveLength(0);
  });

  it("writes only snapshot tables and leaves provenance, Answers, and editorial history unchanged", async () => {
    const project = await services.createProject({ title: `Snapshot provenance boundary ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Evidence" });
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Draft prose");
    await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: prose.id, title: "Editorial context", initialComment: "Keep this wording" });
    const paper = await services.addPaper(project.id, { title: "Provenance paper", authors: ["Author"], publicationYear: 2020, venue: "Venue", doi: "10.5555/provenance" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    const evidence = await services.recordEvidence(project.id, { paperId: paper.id, sourceText: "Direct source", pageNumber: 1 });
    const claim = await services.createClaim(project.id, { claimText: "Supported provenance claim" });
    const revision = await services.createClaimRevision(project.id, claim.id, { claimText: "Supported provenance claim", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: claim.revision.id });
    await services.placeClaimRevision(project.id, manuscript.id, section.id, revision.revision.id);
    const question = await services.createResearchQuestion(project.id, { identifier: "RQ1", label: "Does the source answer the question?" });
    await db!.client`insert into research_question_claim_events (project_id,research_question_id,claim_id,action) values (${project.id},${question.id},${claim.id},'linked')`;
    const answer = await services.appendResearchQuestionAnswer(project.id, question.id, { answerText: "Researcher answer", claimRevisionIds: [revision.revision.id], synthesisRevisionIds: [] });
    const count = async () => (await db!.client`select
      (select count(*) from evidence where project_id=${project.id}) as evidence,
      (select count(*) from claim_revisions where project_id=${project.id}) as claim_revisions,
      (select count(*) from claim_revision_evidence_supports where project_id=${project.id}) as claim_support,
      (select count(*) from papers where project_id=${project.id}) as papers,
      (select count(*) from screening_decisions where project_id=${project.id}) as screening,
      (select count(*) from research_question_claim_events where project_id=${project.id}) as rq_claim_events,
      (select count(*) from research_question_answers where project_id=${project.id}) as answers,
      (select count(*) from research_question_answer_claim_contexts where project_id=${project.id}) as answer_context,
      (select count(*) from manuscript_review_threads where project_id=${project.id}) as review_threads,
      (select count(*) from manuscript_review_events where project_id=${project.id}) as review_events`)[0];
    const before = await count();
    const supportBefore = await db!.client`select claim_revision_id,evidence_id from claim_revision_evidence_supports where project_id=${project.id} order by claim_revision_id,evidence_id`;
    const snapshot = await services.createManuscriptSnapshot(project.id, manuscript.id);
    const after = await count();
    const supportAfter = await db!.client`select claim_revision_id,evidence_id from claim_revision_evidence_supports where project_id=${project.id} order by claim_revision_id,evidence_id`;
    expect(after).toEqual(before);
    expect(supportAfter).toEqual(supportBefore);
    expect(String(answer.id)).toBeTruthy();
    const [snapshotCounts] = await db!.client`select (select count(*) from manuscript_snapshots where project_id=${project.id}) as parents, (select count(*) from manuscript_snapshot_sections where project_id=${project.id}) as sections, (select count(*) from manuscript_snapshot_items where project_id=${project.id}) as items`;
    expect(Number(snapshotCounts.parents)).toBe(1);
    expect(Number(snapshotCounts.sections)).toBe(1);
    expect(Number(snapshotCounts.items)).toBe(2);
    expect(snapshot.id).toBeTruthy();
  });

  it("finalizes an empty manuscript with zero counts and the released empty serializer", async () => {
    const project = await services.createProject({ title: `Empty snapshot ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const snapshot = await services.createManuscriptSnapshot(project.id, manuscript.id);
    const detail = await services.getManuscriptSnapshot(project.id, manuscript.id, snapshot.id);
    expect(detail.sections).toHaveLength(0);
    expect(detail.items).toHaveLength(0);
    expect(detail.bibliography).toHaveLength(0);
    expect(detail.warnings).toHaveLength(0);
    expect(detail.renderedMarkdown).toBe("# Manuscript\n\n## References\n");
    expect(detail.renderedMarkdownSha256).toBe(createHash("sha256").update(Buffer.from(detail.renderedMarkdown, "utf8")).digest("hex"));
    expect(await services.getManuscriptSnapshotMarkdown(project.id, manuscript.id, snapshot.id)).toBe(detail.renderedMarkdown);
  });

  it("uses dense snapshot positions for tied live Section and SectionItem sort orders", async () => {
    const project = await services.createProject({ title: `Tied ordering ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const firstSection = await services.createSection(project.id, manuscript.id, { title: "First" });
    const secondSection = await services.createSection(project.id, manuscript.id, { title: "Second" });
    const firstItem = await services.createProseBlock(project.id, manuscript.id, firstSection.id, "First item");
    const secondItem = await services.createProseBlock(project.id, manuscript.id, firstSection.id, "Second item");
    await db!.client.unsafe("update manuscript_sections set sort_order=7 where project_id=$1 and manuscript_id=$2", [project.id, manuscript.id]);
    await db!.client.unsafe("update manuscript_section_items set sort_order=5 where project_id=$1 and manuscript_id=$2 and section_id=$3", [project.id, manuscript.id, firstSection.id]);
    const snapshot = await services.createManuscriptSnapshot(project.id, manuscript.id);
    const detail = await services.getManuscriptSnapshot(project.id, manuscript.id, snapshot.id);
    const expectedSections = [firstSection.id, secondSection.id].sort();
    expect(detail.sections.map((row) => String(row.source_section_id))).toEqual(expectedSections);
    expect(detail.sections.map((row) => Number(row.section_position))).toEqual([0, 1]);
    const expectedItems = [firstItem.id, secondItem.id].sort();
    expect(detail.items.filter((row) => String(row.source_section_id) === firstSection.id).map((row) => String(row.source_section_item_id))).toEqual(expectedItems);
    expect(detail.items.filter((row) => String(row.source_section_id) === firstSection.id).map((row) => Number(row.item_position))).toEqual([0, 1]);
    expect(detail.items.every((row) => Number(row.source_sort_order) === 5)).toBe(true);
    expect(detail.sections.every((row) => Number(row.source_sort_order) === 7)).toBe(true);
    const frozenMarkdown = detail.renderedMarkdown;
    await db!.client.unsafe("update manuscript_sections set sort_order=99 where project_id=$1 and manuscript_id=$2", [project.id, manuscript.id]);
    await db!.client.unsafe("update manuscript_section_items set sort_order=99 where project_id=$1 and manuscript_id=$2 and section_id=$3", [project.id, manuscript.id, firstSection.id]);
    const refetched = await services.getManuscriptSnapshot(project.id, manuscript.id, snapshot.id);
    expect(refetched.renderedMarkdown).toBe(frozenMarkdown);
    expect(refetched.sections.map((row) => Number(row.section_position))).toEqual([0, 1]);
    expect(refetched.items.filter((row) => String(row.source_section_id) === firstSection.id).map((row) => Number(row.item_position))).toEqual([0, 1]);
  });

  it("freezes Unicode and CR-only content through UTF-8 Markdown and SQL assembly", async () => {
    const project = await services.createProject({ title: `Unicode snapshot ${randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const unicodeTitle = "研究 🧪 𝄞 manuscript";
    await db!.client.unsafe("update manuscripts set title=$1 where project_id=$2 and id=$3", [unicodeTitle, project.id, manuscript.id]);
    const section = await services.createSection(project.id, manuscript.id, { title: "Résultats 🧬" });
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Ligne A\rLigne B 😀 𝄞");
    const paper = await services.addPaper(project.id, { title: "Pāper 🧫 𝄞", authors: ["Zoë Ω"], publicationYear: 2022, venue: "Vēnue", doi: "10.5555/unicode" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    const evidence = await services.recordEvidence(project.id, { paperId: paper.id, sourceText: "Unicode source", pageNumber: 1 });
    const claim = await services.createClaim(project.id, { claimText: "Claim 🧠 𝄞" });
    const revision = await services.createClaimRevision(project.id, claim.id, { claimText: "Claim 🧠 𝄞", lifecycle: "active", supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: claim.revision.id });
    await services.placeClaimRevision(project.id, manuscript.id, section.id, revision.revision.id);
    const snapshot = await services.createManuscriptSnapshot(project.id, manuscript.id);
    const detail = await services.getManuscriptSnapshot(project.id, manuscript.id, snapshot.id);
    expect(detail.title).toBe(unicodeTitle);
    expect(detail.renderedMarkdown).toContain("😀");
    expect(detail.renderedMarkdown).toContain("𝄞");
    expect(detail.renderedMarkdown).not.toContain("\r");
    const expectedHash = createHash("sha256").update(Buffer.from(detail.renderedMarkdown, "utf8")).digest("hex");
    expect(detail.renderedMarkdownSha256).toBe(expectedHash);
    const [assembled] = await db!.client`select assemble_manuscript_snapshot_markdown(${project.id}, ${snapshot.id}) as assembled`;
    expect(String(assembled.assembled)).toBe(detail.renderedMarkdown);
    expect(prose.id).toBeTruthy();
  });

});
