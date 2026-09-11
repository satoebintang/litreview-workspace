import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(DATABASE_URL);
const services = createReviewServices(db);
let projectId = "";

async function truncateAll() {
  await client.unsafe("TRUNCATE TABLE synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects");
}

describe("Slice 17 Evidence Sets", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Evidence Set project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => { await truncateAll(); await client.end(); });

  async function evidence(title = `Study ${crypto.randomUUID()}`, sourceText = "Exact passage", pageNumber = 1) {
    const paper = await services.addPaper(projectId, { title, authors: ["Author"] });
    const item = await services.recordEvidence(projectId, { paperId: paper.id, sourceText, pageNumber });
    return { paper, item };
  }

  async function assertSnapshotInvariants(evidenceSetId: string) {
    const revisions = await client`select id, sequence, project_id, evidence_set_id, operation_kind from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${evidenceSetId} order by sequence`;
    expect(revisions.length).toBeGreaterThan(0);
    const previouslyActive = new Set<string>();
    let previousIds: string[] = [];
    for (const revision of revisions) {
      const members = await client`select cm.project_id, cm.evidence_set_id, cm.composition_revision_id, cm.membership_id, cm.sort_order, m.evidence_id, e.project_id as evidence_project_id from evidence_set_composition_members cm join evidence_set_memberships m on m.project_id=cm.project_id and m.evidence_set_id=cm.evidence_set_id and m.id=cm.membership_id join evidence e on e.project_id=m.project_id and e.id=m.evidence_id where cm.project_id=${projectId} and cm.evidence_set_id=${evidenceSetId} and cm.composition_revision_id=${revision.id} order by cm.sort_order`;
      const ids = members.map((member) => String(member.membership_id));
      const sortOrders = members.map((member) => Number(member.sort_order));
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(sortOrders).size).toBe(sortOrders.length);
      expect(sortOrders).toEqual(ids.map((_, index) => index + 1));
      expect(members.every((member) => String(member.project_id) === projectId && String(member.evidence_set_id) === evidenceSetId && String(member.evidence_project_id) === projectId && String(member.composition_revision_id) === String(revision.id))).toBe(true);

      const operation = String(revision.operation_kind);
      if (operation === "created") {
        expect(previousIds).toEqual([]);
        expect(ids).toEqual([]);
      } else {
        expect(previousIds.length).toBeGreaterThanOrEqual(0);
        const newlyActive = ids.filter((id) => !previousIds.includes(id));
        const disappeared = previousIds.filter((id) => !ids.includes(id));
        const existingInCurrentOrder = ids.filter((id) => previousIds.includes(id));
        const survivingPreviousOrder = previousIds.filter((id) => ids.includes(id));
        if (operation === "added" || operation === "readded") {
          expect(ids.length).toBe(previousIds.length + 1);
          expect(newlyActive).toHaveLength(1);
          expect(disappeared).toHaveLength(0);
          expect(ids.at(-1)).toBe(newlyActive[0]);
          expect(existingInCurrentOrder).toEqual(previousIds);
          expect(operation === "readded").toBe(previouslyActive.has(newlyActive[0]));
        } else if (operation === "removed") {
          expect(ids.length).toBe(previousIds.length - 1);
          expect(newlyActive).toHaveLength(0);
          expect(disappeared).toHaveLength(1);
          expect(existingInCurrentOrder).toEqual(survivingPreviousOrder);
        } else if (operation === "reordered") {
          expect(ids).toHaveLength(previousIds.length);
          expect(newlyActive).toHaveLength(0);
          expect(disappeared).toHaveLength(0);
          expect(ids).not.toEqual(previousIds);
        } else {
          throw new Error(`Unexpected operation kind ${operation}`);
        }
      }
      ids.forEach((id) => previouslyActive.add(id));
      previousIds = ids;
    }
    expect(String(revisions[0].operation_kind)).toBe("created");
    expect(revisions.filter((revision) => String(revision.operation_kind) === "created")).toHaveLength(1);
  }

  it("atomically creates the mandatory empty snapshot, supports rollback, and archives an empty set", async () => {
    const created = await services.createEvidenceSet(projectId, { name: "  Empty outcomes  ", description: "  Compare findings  " });
    expect(created.revision.operationKind).toBe("created");
    expect(created.set.name).toBe("Empty outcomes");
    expect(created.set.description).toBe("Compare findings");
    const detail = await services.getEvidenceSet(projectId, created.set.id);
    expect(detail.currentRevision.operationKind).toBe("created");
    expect(detail.members).toHaveLength(0);
    expect(detail.compositionHistory).toHaveLength(1);
    await assertSnapshotInvariants(created.set.id);

    await expect(services.createEvidenceSet(projectId, { name: "empty outcomes" })).rejects.toMatchObject({ code: "DATABASE_CONSTRAINT" });
    expect(await client`select count(*)::int as count from evidence_sets where project_id=${projectId}`).toEqual([{ count: 1 }]);

    const directId = crypto.randomUUID();
    await expect(client.begin(async (tx) => {
      await tx`insert into evidence_sets (id, project_id, name) values (${directId}, ${projectId}, 'Direct missing snapshot')`;
    })).rejects.toThrow(/initial empty composition snapshot/i);
    expect(await client`select count(*)::int as count from evidence_sets where id=${directId}`).toEqual([{ count: 0 }]);

    const rollbackId = crypto.randomUUID();
    await expect(client.begin(async (tx) => {
      await tx`insert into evidence_sets (id, project_id, name) values (${rollbackId}, ${projectId}, 'Rolled back set')`;
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${rollbackId}, 'created')`;
      throw new Error("transaction rollback sentinel");
    })).rejects.toThrow("transaction rollback sentinel");
    expect(await client`select count(*)::int as count from evidence_sets where id=${rollbackId}`).toEqual([{ count: 0 }]);

    const archived = await services.archiveEvidenceSet(projectId, created.set.id);
    expect(archived.archivedAt).not.toBeNull();
    const reusedName = await services.createEvidenceSet(projectId, { name: "empty outcomes" });
    expect(reusedName.set.name).toBe("empty outcomes");
    const archivedDetail = await services.getEvidenceSet(projectId, created.set.id);
    expect(archivedDetail.members).toHaveLength(0);
    const postArchiveEvidence = await evidence("Post-archive evidence", "Must not enter a frozen set", 9);
    await expect(client`insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id) values (${projectId}, ${created.set.id}, ${postArchiveEvidence.item.id})`).rejects.toThrow(/Archived Evidence Sets are immutable/);
    await expect(services.appendEvidenceSetAnnotation(projectId, created.set.id, { body: "cannot edit" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.updateEvidenceSetMetadata(projectId, created.set.id, { name: "Unarchive" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps complete snapshots, transition labels, and stable membership identity across remove and re-add", async () => {
    const first = await evidence("First", "First passage", 1);
    const second = await evidence("Second", "Second passage", 2);
    const set = (await services.createEvidenceSet(projectId, { name: "Comparison" })).set;
    const firstAdd = await services.addEvidenceToSet(projectId, set.id, { evidenceId: first.item.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: second.item.id });
    await services.removeEvidenceFromSet(projectId, set.id, first.item.id);
    const readded = await services.addEvidenceToSet(projectId, set.id, { evidenceId: first.item.id });
    await services.reorderEvidenceSet(projectId, set.id, { evidenceIds: [first.item.id, second.item.id] });

    expect(readded.membership.id).toBe(firstAdd.membership.id);
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect(detail.members.map((member) => member.evidence?.id)).toEqual([first.item.id, second.item.id]);
    expect(detail.compositionHistory.map((entry) => entry.revision.operationKind)).toEqual(["created", "added", "added", "removed", "readded", "reordered"]);
    expect(detail.compositionHistory.map((entry) => entry.evidenceIds)).toEqual([
      [],
      [first.item.id],
      [first.item.id, second.item.id],
      [second.item.id],
      [second.item.id, first.item.id],
      [first.item.id, second.item.id],
    ]);
    const membershipRows = await client`select evidence_id, id from evidence_set_memberships where project_id=${projectId} and evidence_set_id=${set.id} order by evidence_id`;
    expect(membershipRows.filter((row) => String(row.evidence_id) === first.item.id)).toHaveLength(1);
    await assertSnapshotInvariants(set.id);
  });

  it("allows rejected Evidence while keeping live warnings and deletion protection", async () => {
    const source = await evidence("Rejected source", "Retained rejected passage", 4);
    await services.appendEvidenceReviewDecision(projectId, source.item.id, { decision: "rejected", note: "Keep for comparison" });
    const set = (await services.createEvidenceSet(projectId, { name: "Rejected comparison" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: source.item.id });
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect(detail.members[0].evidence?.reviewState).toBe("rejected");
    expect(detail.members[0].evidence?.curationWarning).toBe("currently_rejected");
    await expect(services.deleteEvidence(projectId, source.item.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    await services.appendEvidenceSetAnnotation(projectId, set.id, { body: "  Keep the context  " });
    expect((await services.listEvidenceSetAnnotations(projectId, set.id))[0].body).toBe("Keep the context");
    await services.archiveEvidenceSet(projectId, set.id);
    expect((await services.getEvidenceSet(projectId, set.id)).annotations).toHaveLength(1);
    await assertSnapshotInvariants(set.id);
  });

  it("enforces same-project and same-set ownership in services and direct SQL", async () => {
    const local = await evidence("Local", "Local passage", 1);
    const otherProject = await services.createProject({ title: `Other ${crypto.randomUUID()}` });
    const otherPaper = await services.addPaper(otherProject.id, { title: "Foreign" });
    const foreign = await services.recordEvidence(otherProject.id, { paperId: otherPaper.id, sourceText: "Foreign passage", pageNumber: 2 });
    const set = (await services.createEvidenceSet(projectId, { name: "Local set" })).set;
    const otherSet = (await services.createEvidenceSet(projectId, { name: "Other local set" })).set;
    await expect(services.addEvidenceToSet(projectId, set.id, { evidenceId: foreign.id })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: local.item.id });

    const [otherRevision] = await client`select id from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${otherSet.id} order by sequence limit 1`;
    const [localMembership] = await client`select id from evidence_set_memberships where project_id=${projectId} and evidence_set_id=${set.id} and evidence_id=${local.item.id}`;
    await expect(client`insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order) values (${projectId}, ${otherSet.id}, ${otherRevision.id}, ${localMembership.id}, 1)`).rejects.toThrow();
    await expect(client`insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id) values (${projectId}, ${set.id}, ${foreign.id})`).rejects.toThrow();

    const [currentRevision] = await client`select id from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${set.id} order by sequence desc limit 1`;
    await expect(client.begin(async (tx) => {
      const [revision] = await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${set.id}, 'reordered') returning id`;
      await tx`insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order) values (${projectId}, ${set.id}, ${revision.id}, ${localMembership.id}, 1)`;
    })).rejects.toThrow(/reordered composition/i);
    await expect(client.begin(async (tx) => {
      const [revision] = await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${set.id}, 'added') returning id`;
      await tx`insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order) values (${projectId}, ${set.id}, ${revision.id}, ${localMembership.id}, 1)`;
    })).rejects.toThrow(/added composition/i);
    await expect(client.begin(async (tx) => {
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${set.id}, 'created')`;
    })).rejects.toThrow(/sole initial empty snapshot/i);
    expect(String(currentRevision.id)).toBe(String((await services.getEvidenceSet(set.projectId, set.id)).currentRevision.id));
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent add plus add through the Evidence Set row lock", async () => {
    const first = await evidence("Concurrent first", "First", 1);
    const second = await evidence("Concurrent second", "Second", 2);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent adds" })).set;
    const results = await Promise.allSettled([
      services.addEvidenceToSet(projectId, set.id, { evidenceId: first.item.id }),
      services.addEvidenceToSet(projectId, set.id, { evidenceId: second.item.id }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect(detail.members).toHaveLength(2);
    expect(detail.compositionHistory.filter((entry) => entry.revision.operationKind === "added")).toHaveLength(2);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent add plus reorder without committing a stale snapshot", async () => {
    const first = await evidence("Concurrent reorder first", "First", 1);
    const second = await evidence("Concurrent reorder second", "Second", 2);
    const third = await evidence("Concurrent reorder third", "Third", 3);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent add reorder" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: first.item.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: second.item.id });
    const results = await Promise.allSettled([
      services.addEvidenceToSet(projectId, set.id, { evidenceId: third.item.id }),
      services.reorderEvidenceSet(projectId, set.id, { evidenceIds: [second.item.id, first.item.id, third.item.id] }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    if (results[1].status === "rejected") expect(results[1].reason).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getEvidenceSet(projectId, set.id)).members).toHaveLength(3);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent remove plus reorder without committing a stale snapshot", async () => {
    const first = await evidence("Concurrent remove first", "First", 1);
    const second = await evidence("Concurrent remove second", "Second", 2);
    const third = await evidence("Concurrent remove third", "Third", 3);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent remove reorder" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: first.item.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: second.item.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: third.item.id });
    const results = await Promise.allSettled([
      services.removeEvidenceFromSet(projectId, set.id, third.item.id),
      services.reorderEvidenceSet(projectId, set.id, { evidenceIds: [second.item.id, first.item.id] }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    if (results[1].status === "rejected") expect(results[1].reason).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getEvidenceSet(projectId, set.id)).members).toHaveLength(2);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent remove plus archive and freezes whichever state committed first", async () => {
    const source = await evidence("Concurrent remove archive", "Passage", 1);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent remove archive" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: source.item.id });
    const results = await Promise.allSettled([
      services.removeEvidenceFromSet(projectId, set.id, source.item.id),
      services.archiveEvidenceSet(projectId, set.id),
    ]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getEvidenceSet(projectId, set.id)).set.archivedAt).not.toBeNull();
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent reorder plus archive and freezes the set", async () => {
    const first = await evidence("Concurrent reorder archive first", "First", 1);
    const second = await evidence("Concurrent reorder archive second", "Second", 2);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent reorder archive" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: first.item.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: second.item.id });
    const results = await Promise.allSettled([
      services.reorderEvidenceSet(projectId, set.id, { evidenceIds: [second.item.id, first.item.id] }),
      services.archiveEvidenceSet(projectId, set.id),
    ]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getEvidenceSet(projectId, set.id)).set.archivedAt).not.toBeNull();
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent metadata edit plus archive", async () => {
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent metadata archive" })).set;
    const results = await Promise.allSettled([
      services.updateEvidenceSetMetadata(projectId, set.id, { name: "Renamed before archive" }),
      services.archiveEvidenceSet(projectId, set.id),
    ]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ code: "VALIDATION_ERROR" });
    const archived = await services.getEvidenceSet(projectId, set.id);
    expect(archived.set.archivedAt).not.toBeNull();
    expect(["Concurrent metadata archive", "Renamed before archive"]).toContain(archived.set.name);
    await assertSnapshotInvariants(set.id);
  });
});
