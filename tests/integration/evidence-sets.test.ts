import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { resolveEvidenceSetCompositionRevisionMembers } from "@/application/evidence-set-composition-resolver";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(DATABASE_URL);
const services = createReviewServices(db);
let projectId = "";

async function truncateAll() {
  await client.unsafe("TRUNCATE TABLE doi_lookup_resolutions, doi_lookup_dispatches, bibliographic_metadata_result_authors, bibliographic_metadata_http_attempts, bibliographic_metadata_fetch_results, bibliographic_metadata_fetches, doi_lookup_requests, pdf_intake_resolutions, pdf_intake_metadata_fields, pdf_intake_metadata_results, pdf_intakes, bibliographic_import_resolutions, bibliographic_import_records, bibliographic_imports, ai_synthesis_decisions, ai_synthesis_result_groundings, ai_synthesis_results, ai_synthesis_dispatches, ai_synthesis_request_sources, ai_synthesis_request_supports, ai_synthesis_requests, ai_extraction_batch_items, ai_extraction_batches, ai_extraction_decision_evidence, ai_extraction_decisions, ai_extraction_result_groundings, ai_extraction_results, ai_extraction_dispatches, ai_extraction_request_pages, ai_extraction_requests, manuscript_snapshot_warnings, manuscript_snapshot_claim_bibliography_members, manuscript_snapshot_bibliography_entries, manuscript_snapshot_claim_items, manuscript_snapshot_prose_items, manuscript_snapshot_items, manuscript_snapshot_sections, manuscript_snapshots, research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, evidence_set_membership_order_versions, evidence_set_paper_member_counts, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_review_events, manuscript_review_threads, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_revisions, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_label_events, evidence_annotations, appraisal_revision_response_evidence, appraisal_revision_responses, appraisal_revisions, appraisals, appraisal_framework_overall_judgement_options, appraisal_framework_response_options, appraisal_framework_items, appraisal_framework_sections, appraisal_framework_versions, appraisal_frameworks, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects");
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

  async function expectedRevisionId(evidenceSetId: string) {
    return (await services.getEvidenceSet(projectId, evidenceSetId)).currentRevision.id;
  }

  async function compositionRevisionCount(evidenceSetId: string) {
    return Number((await client`select count(*)::int as count from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${evidenceSetId}`)[0].count);
  }

  async function addMember(evidenceSetId: string, evidenceId: string, revisionId?: string) {
    return services.addEvidenceToSet(projectId, evidenceSetId, {
      evidenceId,
      expectedRevisionId: revisionId ?? await expectedRevisionId(evidenceSetId),
    });
  }

  async function removeMember(evidenceSetId: string, evidenceId: string, revisionId?: string) {
    return services.removeEvidenceFromSet(projectId, evidenceSetId, {
      evidenceId,
      expectedRevisionId: revisionId ?? await expectedRevisionId(evidenceSetId),
    });
  }

  async function raceAtBarrier(operations: Array<() => Promise<unknown>>) {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return Promise.allSettled(operations.map(async (operation) => {
      arrived += 1;
      if (arrived === operations.length) release();
      await gate;
      return operation();
    }));
  }

  async function assertSnapshotInvariants(evidenceSetId: string) {
    const revisions = await client`select id, sequence, set_ordinal, previous_revision_id, operation_kind, target_membership_id, move_direction, head_membership_id, tail_membership_id, member_count, distinct_paper_count from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${evidenceSetId} order by set_ordinal`;
    expect(revisions.length).toBeGreaterThan(0);
    const previouslyActive = new Set<string>();
    let previousIds: string[] = [];
    for (const [index, revision] of revisions.entries()) {
      const members = await resolveEvidenceSetCompositionRevisionMembers(db, projectId, evidenceSetId, String(revision.id));
      const ids = members.map((member) => member.membershipId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(Number(revision.member_count)).toBe(ids.length);
      expect(Number(revision.distinct_paper_count)).toBe(new Set(members.map((member) => member.paperId)).size);
      expect(revision.head_membership_id == null ? null : String(revision.head_membership_id)).toBe(ids[0] ?? null);
      expect(revision.tail_membership_id == null ? null : String(revision.tail_membership_id)).toBe(ids.at(-1) ?? null);
      if (index === 0) {
        expect(revision.previous_revision_id).toBeNull();
        expect(String(revision.operation_kind)).toBe("created");
      } else {
        expect(String(revision.previous_revision_id)).toBe(String(revisions[index - 1].id));
      }

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
          expect(String(revision.target_membership_id)).toBe(newlyActive[0]);
        } else if (operation === "removed") {
          expect(ids.length).toBe(previousIds.length - 1);
          expect(newlyActive).toHaveLength(0);
          expect(disappeared).toHaveLength(1);
          expect(existingInCurrentOrder).toEqual(survivingPreviousOrder);
          expect(String(revision.target_membership_id)).toBe(disappeared[0]);
        } else if (operation === "moved") {
          expect(ids).toHaveLength(previousIds.length);
          expect(newlyActive).toHaveLength(0);
          expect(disappeared).toHaveLength(0);
          const targetId = String(revision.target_membership_id);
          const before = [...previousIds];
          const targetIndex = before.indexOf(targetId);
          const otherIndex = String(revision.move_direction) === "up" ? targetIndex - 1 : targetIndex + 1;
          [before[targetIndex], before[otherIndex]] = [before[otherIndex], before[targetIndex]];
          expect(ids).toEqual(before);
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
    })).rejects.toThrow(/initial empty composition revision/i);
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
    const firstAdd = await addMember(set.id, first.item.id);
    await addMember(set.id, second.item.id);
    await removeMember(set.id, first.item.id);
    const readded = await addMember(set.id, first.item.id);
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

  it("moves one adjacent membership at a time and rejects invalid or reopened temporal intervals", async () => {
    const records = await Promise.all([
      evidence("Move A", "A", 1),
      evidence("Move B", "B", 2),
      evidence("Move C", "C", 3),
      evidence("Move D", "D", 4),
    ]);
    const set = (await services.createEvidenceSet(projectId, { name: "Move order" })).set;
    for (const record of records) await addMember(set.id, record.item.id);

    const initial = await services.getEvidenceSet(projectId, set.id);
    const [first, second, , fourth] = initial.members.map((member) => member.membership);
    const up = await services.moveEvidenceSetMembership(projectId, set.id, {
      expectedRevisionId: initial.currentRevision.id,
      membershipId: second.id,
      direction: "up",
    });
    expect(up.moved).toBe(true);
    expect((await services.getEvidenceSet(projectId, set.id)).members.map((member) => member.membership.evidenceId)).toEqual([
      records[1].item.id, records[0].item.id, records[2].item.id, records[3].item.id,
    ]);

    const afterUp = await services.getEvidenceSet(projectId, set.id);
    const down = await services.moveEvidenceSetMembership(projectId, set.id, {
      expectedRevisionId: afterUp.currentRevision.id,
      membershipId: second.id,
      direction: "down",
    });
    expect(down.moved).toBe(true);
    const restored = await services.getEvidenceSet(projectId, set.id);
    expect(restored.members.map((member) => member.membership.evidenceId)).toEqual(records.map((record) => record.item.id));

    const beforeBoundaryMove = restored.currentRevision.id;
    const boundary = await services.moveEvidenceSetMembership(projectId, set.id, {
      expectedRevisionId: beforeBoundaryMove,
      membershipId: first.id,
      direction: "up",
    });
    expect(boundary.moved).toBe(false);
    expect(boundary.revision.id).toBe(beforeBoundaryMove);
    const tailBoundary = await services.moveEvidenceSetMembership(projectId, set.id, {
      expectedRevisionId: beforeBoundaryMove,
      membershipId: fourth.id,
      direction: "down",
    });
    expect(tailBoundary.moved).toBe(false);
    expect(tailBoundary.revision.id).toBe(beforeBoundaryMove);

    const revisionCount = Number((await client`select count(*)::int as count from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${set.id}`)[0].count);
    await expect(services.addEvidenceToSet(projectId, set.id, { evidenceId: crypto.randomUUID() } as { evidenceId: string; expectedRevisionId: string }))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    await expect(services.addEvidenceToSet(projectId, set.id, { evidenceId: records[0].item.id, expectedRevisionId: "not-a-uuid" } as { evidenceId: string; expectedRevisionId: string }))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    await expect(services.addEvidenceToSet(projectId, set.id, { evidenceId: records[0].item.id, expectedRevisionId: initial.currentRevision.id }))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(Number((await client`select count(*)::int as count from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${set.id}`)[0].count)).toBe(revisionCount);

    const [closedVersion] = await client`
      select membership_id, valid_from_ordinal, valid_to_ordinal, next_membership_id
      from evidence_set_membership_order_versions
      where project_id=${projectId} and evidence_set_id=${set.id} and valid_to_ordinal is not null
      order by valid_from_ordinal limit 1
    `;
    const [activeVersion] = await client`
      select membership_id, valid_from_ordinal, next_membership_id
      from evidence_set_membership_order_versions
      where project_id=${projectId} and evidence_set_id=${set.id} and valid_to_ordinal is null
      order by valid_from_ordinal limit 1
    `;
    await expect(client`update evidence_set_membership_order_versions set valid_to_ordinal=null where project_id=${projectId} and evidence_set_id=${set.id} and membership_id=${closedVersion.membership_id} and valid_from_ordinal=${closedVersion.valid_from_ordinal}`)
      .rejects.toThrow(/immutable|reopen/i);
    await expect(client`update evidence_set_membership_order_versions set next_membership_id=${crypto.randomUUID()} where project_id=${projectId} and evidence_set_id=${set.id} and membership_id=${closedVersion.membership_id} and valid_from_ordinal=${closedVersion.valid_from_ordinal}`)
      .rejects.toThrow(/immutable|transition/i);
    const current = await services.getEvidenceSet(projectId, set.id);
    const [currentOrdinal] = await client`select set_ordinal from evidence_set_composition_revisions where id=${current.currentRevision.id}`;
    await expect(client`update evidence_set_membership_order_versions set valid_to_ordinal=${Number(currentOrdinal.set_ordinal)} where project_id=${projectId} and evidence_set_id=${set.id} and membership_id=${activeVersion.membership_id} and valid_to_ordinal is null`)
      .rejects.toThrow(/closure|transition|validity/i);
    await expect(client`
      insert into evidence_set_membership_order_versions
        (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal)
      values (${projectId}, ${set.id}, ${activeVersion.membership_id}, ${activeVersion.next_membership_id}, ${Number(currentOrdinal.set_ordinal)})
    `).rejects.toThrow(/order version must start at a non-created composition revision/i);
    await expect(client`
      insert into evidence_set_membership_order_versions
        (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal)
      values (${projectId}, ${set.id}, ${activeVersion.membership_id}, ${activeVersion.next_membership_id}, 1)
    `).rejects.toThrow(/order version must start at a non-created composition revision/i);
    await expect(client`
      insert into evidence_set_membership_order_versions
        (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal, valid_to_ordinal)
      values (${projectId}, ${set.id}, ${closedVersion.membership_id}, ${closedVersion.next_membership_id},
        ${Number(closedVersion.valid_from_ordinal) + 1}, ${closedVersion.valid_to_ordinal})
    `).rejects.toThrow(/new Evidence Set order versions must be open/i);
    const [counter] = await client`
      select paper_id from evidence_set_paper_member_counts
      where project_id=${projectId} and evidence_set_id=${set.id} limit 1
    `;
    await expect(client`
      update evidence_set_paper_member_counts set member_count=99
      where project_id=${projectId} and evidence_set_id=${set.id} and paper_id=${counter.paper_id}
    `).rejects.toThrow(/maintained by composition transitions/i);
    await assertSnapshotInvariants(set.id);
  });

  it("rejects an unrelated interior close added to an otherwise valid ordinary move", async () => {
    const records = await Promise.all([
      evidence("Close guard A", "A", 1),
      evidence("Close guard B", "B", 2),
      evidence("Close guard C", "C", 3),
      evidence("Close guard D", "D", 4),
      evidence("Close guard E", "E", 5),
      evidence("Close guard F", "F", 6),
    ]);
    const set = (await services.createEvidenceSet(projectId, { name: "Unrelated close guard" })).set;
    for (const record of records) await addMember(set.id, record.item.id);

    const before = await services.getEvidenceSet(projectId, set.id);
    const memberIds = before.members.map((member) => member.membership.id);
    const revisionCount = await compositionRevisionCount(set.id);
    const linksBefore = await client`
      select membership_id, next_membership_id, valid_from_ordinal, valid_to_ordinal
      from evidence_set_membership_order_versions
      where project_id=${projectId} and evidence_set_id=${set.id}
      order by valid_from_ordinal, membership_id
    `;

    await expect(client.begin(async (tx) => {
      const [revision] = await tx`
        insert into evidence_set_composition_revisions
          (project_id, evidence_set_id, operation_kind, target_membership_id, move_direction)
        values (${projectId}, ${set.id}, 'moved', ${memberIds[2]}, 'up')
        returning set_ordinal
      `;
      const ordinal = Number(revision.set_ordinal);
      for (const membershipId of [memberIds[0], memberIds[1], memberIds[2]]) {
        await tx`
          update evidence_set_membership_order_versions
          set valid_to_ordinal=${ordinal}
          where project_id=${projectId} and evidence_set_id=${set.id}
            and membership_id=${membershipId} and valid_to_ordinal is null
        `;
      }
      for (const [membershipId, nextMembershipId] of [
        [memberIds[0], memberIds[2]],
        [memberIds[2], memberIds[1]],
        [memberIds[1], memberIds[3]],
      ] as const) {
        await tx`
          insert into evidence_set_membership_order_versions
            (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal)
          values (${projectId}, ${set.id}, ${membershipId}, ${nextMembershipId}, ${ordinal})
        `;
      }
      // D is an unrelated interior link; F remains the declared tail, so a
      // head/tail-only check cannot detect the disconnected suffix.
      await tx`
        update evidence_set_membership_order_versions
        set valid_to_ordinal=${ordinal}
        where project_id=${projectId} and evidence_set_id=${set.id}
          and membership_id=${memberIds[3]} and valid_to_ordinal is null
      `;
    })).rejects.toThrow(/closure is outside the bounded Evidence Set transition neighborhood/i);

    const after = await services.getEvidenceSet(projectId, set.id);
    expect(after.currentRevision.id).toBe(before.currentRevision.id);
    expect(after.members.map((member) => member.membership.id)).toEqual(memberIds);
    expect(await compositionRevisionCount(set.id)).toBe(revisionCount);
    const linksAfter = await client`
      select membership_id, next_membership_id, valid_from_ordinal, valid_to_ordinal
      from evidence_set_membership_order_versions
      where project_id=${projectId} and evidence_set_id=${set.id}
      order by valid_from_ordinal, membership_id
    `;
    expect(linksAfter).toEqual(linksBefore);
    await assertSnapshotInvariants(set.id);
  });

  it("updates both roots when moving the tail above the head in a two-member set", async () => {
    const first = await evidence("Two-member move A", "A", 1);
    const second = await evidence("Two-member move B", "B", 2);
    const set = (await services.createEvidenceSet(projectId, { name: "Two-member head move" })).set;
    await addMember(set.id, first.item.id);
    await addMember(set.id, second.item.id);
    const before = await services.getEvidenceSet(projectId, set.id);
    const moved = await services.moveEvidenceSetMembership(projectId, set.id, {
      expectedRevisionId: before.currentRevision.id,
      membershipId: before.members[1].membership.id,
      direction: "up",
    });
    expect(moved.moved).toBe(true);
    const after = await services.getEvidenceSet(projectId, set.id);
    expect(after.members.map((member) => member.membership.evidenceId)).toEqual([second.item.id, first.item.id]);
    const [revision] = await client`
      select head_membership_id, tail_membership_id
      from evidence_set_composition_revisions where project_id=${projectId} and id=${moved.revision.id}
    `;
    expect(String(revision.head_membership_id)).toBe(before.members[1].membership.id);
    expect(String(revision.tail_membership_id)).toBe(before.members[0].membership.id);
    await assertSnapshotInvariants(set.id);
  });

  it("allows rejected Evidence while keeping live warnings and deletion protection", async () => {
    const source = await evidence("Rejected source", "Retained rejected passage", 4);
    await services.appendEvidenceReviewDecision(projectId, source.item.id, { decision: "rejected", note: "Keep for comparison" });
    const set = (await services.createEvidenceSet(projectId, { name: "Rejected comparison" })).set;
    await addMember(set.id, source.item.id);
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
    await expect(addMember(set.id, foreign.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await addMember(set.id, local.item.id);

    const [otherRevision] = await client`select id, set_ordinal from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${otherSet.id} order by set_ordinal limit 1`;
    const [localMembership] = await client`select id from evidence_set_memberships where project_id=${projectId} and evidence_set_id=${set.id} and evidence_id=${local.item.id}`;
    await expect(client`insert into evidence_set_membership_order_versions (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal) values (${projectId}, ${otherSet.id}, ${localMembership.id}, null, ${Number(otherRevision.set_ordinal) + 1})`).rejects.toThrow();
    await expect(client`insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id) values (${projectId}, ${set.id}, ${foreign.id})`).rejects.toThrow();

    const [currentRevision] = await client`select id from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${set.id} order by set_ordinal desc limit 1`;
    await expect(client.begin(async (tx) => {
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${set.id}, 'reordered')`;
    })).rejects.toThrow(/reordered transition requires a proposed head and tail/i);
    await expect(client.begin(async (tx) => {
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${set.id}, 'added')`;
    })).rejects.toThrow(/Evidence Set transition requires a target membership/i);
    await expect(client.begin(async (tx) => {
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${set.id}, 'created')`;
    })).rejects.toThrow(/sole initial revision/i);
    expect(String(currentRevision.id)).toBe(String((await services.getEvidenceSet(set.projectId, set.id)).currentRevision.id));
    await assertSnapshotInvariants(set.id);
  });

  it("rejects direct SQL duplicate roots, branching children, and incorrect transition summaries", async () => {
    const records = await Promise.all([
      evidence("Revision guard A", "A", 1),
      evidence("Revision guard B", "B", 2),
      evidence("Revision guard C", "C", 3),
    ]);
    const set = (await services.createEvidenceSet(projectId, { name: "Direct revision guards" })).set;
    for (const record of records) await addMember(set.id, record.item.id);
    const detail = await services.getEvidenceSet(projectId, set.id);
    const current = detail.currentRevision;
    const headId = detail.members[0].membership.id;
    const middleId = detail.members[1].membership.id;
    const tailId = detail.members[2].membership.id;
    const [currentSummary] = await client`
      select member_count, distinct_paper_count
      from evidence_set_composition_revisions where id=${current.id}
    `;
    const [root] = await client`
      select id from evidence_set_composition_revisions
      where project_id=${projectId} and evidence_set_id=${set.id} and operation_kind='created'
    `;

    await expect(client`
      insert into evidence_set_composition_revisions
        (project_id, evidence_set_id, operation_kind)
      values (${projectId}, ${set.id}, 'created')
    `).rejects.toThrow(/created Evidence Set composition must be the sole initial revision/i);
    await expect(client`
      insert into evidence_set_composition_revisions
        (project_id, evidence_set_id, operation_kind, previous_revision_id, target_membership_id)
      values (${projectId}, ${set.id}, 'removed', ${root.id}, ${middleId})
    `).rejects.toThrow(/predecessor must be the exact current revision/i);
    await expect(client`
      insert into evidence_set_composition_revisions
        (project_id, evidence_set_id, operation_kind, previous_revision_id, target_membership_id,
         head_membership_id, tail_membership_id, member_count, distinct_paper_count)
      values (${projectId}, ${set.id}, 'removed', ${current.id}, ${middleId},
        ${tailId}, ${tailId}, ${Number(currentSummary.member_count) - 1}, ${Number(currentSummary.distinct_paper_count) - 1})
    `).rejects.toThrow(/revision head does not match its transition/i);
    await expect(client`
      insert into evidence_set_composition_revisions
        (project_id, evidence_set_id, operation_kind, previous_revision_id, target_membership_id,
         head_membership_id, tail_membership_id, member_count, distinct_paper_count)
      values (${projectId}, ${set.id}, 'removed', ${current.id}, ${middleId},
        ${headId}, ${headId}, ${Number(currentSummary.member_count) - 1}, ${Number(currentSummary.distinct_paper_count) - 1})
    `).rejects.toThrow(/revision tail does not match its transition/i);
    await expect(client`
      insert into evidence_set_composition_revisions
        (project_id, evidence_set_id, operation_kind, previous_revision_id, target_membership_id,
         head_membership_id, tail_membership_id, member_count, distinct_paper_count)
      values (${projectId}, ${set.id}, 'removed', ${current.id}, ${middleId},
        ${headId}, ${tailId}, ${Number(currentSummary.member_count)}, ${Number(currentSummary.distinct_paper_count) - 1})
    `).rejects.toThrow(/revision member count does not match its transition/i);
    await expect(client`
      insert into evidence_set_composition_revisions
        (project_id, evidence_set_id, operation_kind, previous_revision_id, target_membership_id,
         head_membership_id, tail_membership_id, member_count, distinct_paper_count)
      values (${projectId}, ${set.id}, 'removed', ${current.id}, ${middleId},
        ${headId}, ${tailId}, ${Number(currentSummary.member_count) - 1}, ${Number(currentSummary.distinct_paper_count)})
    `).rejects.toThrow(/revision Paper count does not match its transition/i);
    expect((await services.getEvidenceSet(projectId, set.id)).currentRevision.id).toBe(current.id);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent add plus add through the Evidence Set row lock", async () => {
    const first = await evidence("Concurrent first", "First", 1);
    const second = await evidence("Concurrent second", "Second", 2);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent adds" })).set;
    const startingRevisionId = await expectedRevisionId(set.id);
    const results = await raceAtBarrier([
      () => addMember(set.id, first.item.id, startingRevisionId),
      () => addMember(set.id, second.item.id, startingRevisionId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect(detail.members).toHaveLength(1);
    expect(detail.compositionHistory.filter((entry) => entry.revision.operationKind === "added")).toHaveLength(1);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent add plus remove against one exact revision", async () => {
    const first = await evidence("Concurrent add/remove A", "A", 1);
    const second = await evidence("Concurrent add/remove B", "B", 2);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent add and remove" })).set;
    await addMember(set.id, first.item.id);
    const startingRevisionId = await expectedRevisionId(set.id);
    const beforeCount = await compositionRevisionCount(set.id);
    const results = await raceAtBarrier([
      () => addMember(set.id, second.item.id, startingRevisionId),
      () => removeMember(set.id, first.item.id, startingRevisionId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect([0, 2]).toContain(detail.members.length);
    expect(await compositionRevisionCount(set.id)).toBe(beforeCount + 1);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent add plus one-step move against one exact revision", async () => {
    const first = await evidence("Concurrent add/move A", "A", 1);
    const second = await evidence("Concurrent add/move B", "B", 2);
    const third = await evidence("Concurrent add/move C", "C", 3);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent add and move" })).set;
    await addMember(set.id, first.item.id);
    await addMember(set.id, second.item.id);
    const before = await services.getEvidenceSet(projectId, set.id);
    const startingRevisionId = before.currentRevision.id;
    const beforeCount = await compositionRevisionCount(set.id);
    const results = await raceAtBarrier([
      () => addMember(set.id, third.item.id, startingRevisionId),
      () => services.moveEvidenceSetMembership(projectId, set.id, {
        expectedRevisionId: startingRevisionId,
        membershipId: before.members[1].membership.id,
        direction: "up",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect([
      [first.item.id, second.item.id, third.item.id],
      [second.item.id, first.item.id],
    ]).toContainEqual(detail.members.map((member) => member.membership.evidenceId));
    expect(await compositionRevisionCount(set.id)).toBe(beforeCount + 1);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent remove plus one-step move against one exact revision", async () => {
    const records = await Promise.all([
      evidence("Concurrent remove/move A", "A", 1),
      evidence("Concurrent remove/move B", "B", 2),
      evidence("Concurrent remove/move C", "C", 3),
    ]);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent remove and move" })).set;
    for (const record of records) await addMember(set.id, record.item.id);
    const before = await services.getEvidenceSet(projectId, set.id);
    const startingRevisionId = before.currentRevision.id;
    const beforeCount = await compositionRevisionCount(set.id);
    const results = await raceAtBarrier([
      () => removeMember(set.id, records[2].item.id, startingRevisionId),
      () => services.moveEvidenceSetMembership(projectId, set.id, {
        expectedRevisionId: startingRevisionId,
        membershipId: before.members[1].membership.id,
        direction: "down",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect([
      [records[0].item.id, records[1].item.id],
      [records[0].item.id, records[2].item.id, records[1].item.id],
    ]).toContainEqual(detail.members.map((member) => member.membership.evidenceId));
    expect(await compositionRevisionCount(set.id)).toBe(beforeCount + 1);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent one-step moves against one exact revision", async () => {
    const records = await Promise.all([
      evidence("Concurrent move/move A", "A", 1),
      evidence("Concurrent move/move B", "B", 2),
      evidence("Concurrent move/move C", "C", 3),
      evidence("Concurrent move/move D", "D", 4),
    ]);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent moves" })).set;
    for (const record of records) await addMember(set.id, record.item.id);
    const before = await services.getEvidenceSet(projectId, set.id);
    const startingRevisionId = before.currentRevision.id;
    const beforeCount = await compositionRevisionCount(set.id);
    const results = await raceAtBarrier([
      () => services.moveEvidenceSetMembership(projectId, set.id, {
        expectedRevisionId: startingRevisionId,
        membershipId: before.members[1].membership.id,
        direction: "up",
      }),
      () => services.moveEvidenceSetMembership(projectId, set.id, {
        expectedRevisionId: startingRevisionId,
        membershipId: before.members[2].membership.id,
        direction: "down",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const detail = await services.getEvidenceSet(projectId, set.id);
    expect([
      [records[1].item.id, records[0].item.id, records[2].item.id, records[3].item.id],
      [records[0].item.id, records[1].item.id, records[3].item.id, records[2].item.id],
    ]).toContainEqual(detail.members.map((member) => member.membership.evidenceId));
    expect(await compositionRevisionCount(set.id)).toBe(beforeCount + 1);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent add plus reorder without committing a stale snapshot", async () => {
    const first = await evidence("Concurrent reorder first", "First", 1);
    const second = await evidence("Concurrent reorder second", "Second", 2);
    const third = await evidence("Concurrent reorder third", "Third", 3);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent add reorder" })).set;
    await addMember(set.id, first.item.id);
    await addMember(set.id, second.item.id);
    const startingRevisionId = await expectedRevisionId(set.id);
    const results = await raceAtBarrier([
      () => addMember(set.id, third.item.id, startingRevisionId),
      () => services.reorderEvidenceSet(projectId, set.id, { evidenceIds: [second.item.id, first.item.id], expectedRevisionId: startingRevisionId }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect([2, 3]).toContain((await services.getEvidenceSet(projectId, set.id)).members.length);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent remove plus reorder without committing a stale snapshot", async () => {
    const first = await evidence("Concurrent remove first", "First", 1);
    const second = await evidence("Concurrent remove second", "Second", 2);
    const third = await evidence("Concurrent remove third", "Third", 3);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent remove reorder" })).set;
    await addMember(set.id, first.item.id);
    await addMember(set.id, second.item.id);
    await addMember(set.id, third.item.id);
    const startingRevisionId = await expectedRevisionId(set.id);
    const results = await raceAtBarrier([
      () => removeMember(set.id, third.item.id, startingRevisionId),
      () => services.reorderEvidenceSet(projectId, set.id, { evidenceIds: [third.item.id, second.item.id, first.item.id], expectedRevisionId: startingRevisionId }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect([2, 3]).toContain((await services.getEvidenceSet(projectId, set.id)).members.length);
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent remove plus archive and freezes whichever state committed first", async () => {
    const source = await evidence("Concurrent remove archive", "Passage", 1);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent remove archive" })).set;
    await addMember(set.id, source.item.id);
    const startingRevisionId = await expectedRevisionId(set.id);
    const results = await raceAtBarrier([
      () => removeMember(set.id, source.item.id, startingRevisionId),
      () => services.archiveEvidenceSet(projectId, set.id),
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
    await addMember(set.id, first.item.id);
    await addMember(set.id, second.item.id);
    const startingRevisionId = await expectedRevisionId(set.id);
    const results = await raceAtBarrier([
      () => services.reorderEvidenceSet(projectId, set.id, { evidenceIds: [second.item.id, first.item.id], expectedRevisionId: startingRevisionId }),
      () => services.archiveEvidenceSet(projectId, set.id),
    ]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getEvidenceSet(projectId, set.id)).set.archivedAt).not.toBeNull();
    await assertSnapshotInvariants(set.id);
  });

  it("serializes concurrent one-step move plus archive", async () => {
    const first = await evidence("Concurrent move/archive A", "A", 1);
    const second = await evidence("Concurrent move/archive B", "B", 2);
    const set = (await services.createEvidenceSet(projectId, { name: "Concurrent move and archive" })).set;
    await addMember(set.id, first.item.id);
    await addMember(set.id, second.item.id);
    const before = await services.getEvidenceSet(projectId, set.id);
    const startingRevisionId = before.currentRevision.id;
    const beforeCount = await compositionRevisionCount(set.id);
    const results = await raceAtBarrier([
      () => services.moveEvidenceSetMembership(projectId, set.id, {
        expectedRevisionId: startingRevisionId,
        membershipId: before.members[1].membership.id,
        direction: "up",
      }),
      () => services.archiveEvidenceSet(projectId, set.id),
    ]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") {
      expect(results[0].reason).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await compositionRevisionCount(set.id)).toBe(beforeCount);
    } else {
      expect(await compositionRevisionCount(set.id)).toBe(beforeCount + 1);
    }
    const archived = await services.getEvidenceSet(projectId, set.id);
    expect(archived.set.archivedAt).not.toBeNull();
    expect(archived.members.map((member) => member.membership.evidenceId)).toEqual(
      results[0].status === "fulfilled" ? [second.item.id, first.item.id] : [first.item.id, second.item.id],
    );
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
