import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createResearchQuestionCoverageServices } from "@/application/research-question-coverage-services";
import { createResearchQuestionTraceabilityServices } from "@/application/research-question-traceability-services";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview");
const services = createReviewServices(db);
const traceability = createResearchQuestionTraceabilityServices(db);
const coverage = createResearchQuestionCoverageServices(db, traceability.repo);
let projectId = "";

async function includedPaper(title: string) {
  const paper = await services.addPaper(projectId, { title });
  await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
  await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
  await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
  return paper;
}

async function appendSequenceInvertedMembership(input: {
  projectId: string;
  evidenceSetId: string;
  evidenceId: string;
  reservedSequence: number;
}) {
  return client.begin(async (tx) => {
    await tx`
      select id from evidence_sets
      where project_id=${input.projectId} and id=${input.evidenceSetId}
      for update
    `;
    const [current] = await tx`
      select tail_membership_id
      from evidence_set_composition_revisions
      where project_id=${input.projectId} and evidence_set_id=${input.evidenceSetId}
      order by set_ordinal desc limit 1
    `;
    const [membership] = await tx`
      insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id)
      values (${input.projectId}, ${input.evidenceSetId}, ${input.evidenceId})
      returning id
    `;
    const [revision] = await tx`
      insert into evidence_set_composition_revisions
        (sequence, project_id, evidence_set_id, operation_kind, target_membership_id)
      overriding system value
      values (${input.reservedSequence}, ${input.projectId}, ${input.evidenceSetId}, 'added', ${membership.id})
      returning id, set_ordinal
    `;
    const ordinal = Number(revision.set_ordinal);
    if (current.tail_membership_id != null) {
      await tx`
        update evidence_set_membership_order_versions
        set valid_to_ordinal=${ordinal}
        where project_id=${input.projectId} and evidence_set_id=${input.evidenceSetId}
          and membership_id=${current.tail_membership_id} and valid_to_ordinal is null
      `;
      await tx`
        insert into evidence_set_membership_order_versions
          (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal)
        values (${input.projectId}, ${input.evidenceSetId}, ${current.tail_membership_id}, ${membership.id}, ${ordinal})
      `;
    }
    await tx`
      insert into evidence_set_membership_order_versions
        (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal)
      values (${input.projectId}, ${input.evidenceSetId}, ${membership.id}, null, ${ordinal})
    `;
    return { revisionId: String(revision.id), ordinal };
  });
}

describe("Evidence Set per-Set chronology compatibility", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    projectId = (await services.createProject({ title: `Ordinal chronology ${crypto.randomUUID()}` })).id;
  });

  afterAll(async () => {
    // The integration runner drops its disposable database; append-only history must remain immutable.
    await client.end();
  });

  it("uses per-Set ordinals when global identity values are inverted by a reserved sequence", async () => {
    const firstPaper = await includedPaper("Chronology Study One");
    const secondPaper = await includedPaper("Chronology Study Two");
    const firstEvidence = await services.recordEvidence(projectId, { paperId: firstPaper.id, sourceText: "First passage", pageNumber: 1 });
    const secondEvidence = await services.recordEvidence(projectId, { paperId: secondPaper.id, sourceText: "Second passage", pageNumber: 2 });
    const field = await services.createExtractionField(projectId, { name: "Chronology Outcome", fieldType: "short_text" });
    await services.reviseExtractionValue(projectId, firstPaper.id, field.id, { value: "First", evidenceIds: [firstEvidence.id] });
    await services.reviseExtractionValue(projectId, secondPaper.id, field.id, { value: "Second", evidenceIds: [secondEvidence.id] });

    const { set, revision: emptyRevision } = await services.createEvidenceSet(projectId, { name: "Ordinal chronology Set" });
    const [reserved] = await client`
      select nextval(pg_get_serial_sequence('evidence_set_composition_revisions', 'sequence'))::bigint as sequence
    `;
    const firstAdded = await services.addEvidenceToSet(projectId, set.id, {
      evidenceId: firstEvidence.id,
      expectedRevisionId: emptyRevision.id,
    });
    const [firstSequence] = await client`
      select sequence from evidence_set_composition_revisions where id=${firstAdded.revision.id}
    `;
    expect(Number(firstSequence.sequence)).toBeGreaterThan(Number(reserved.sequence));

    const question = await services.createResearchQuestion(projectId, { identifier: "RQ-ORDINAL", label: "Ordinal currentness" });
    await traceability.linkEvidenceSet({ projectId, questionId: question.id, evidenceSetId: set.id });
    const preparation = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      expectedRevisionId: firstAdded.revision.id,
      extractionFieldId: field.id,
      workingTitle: "Pinned before the inverted sequence",
    });

    const inverted = await appendSequenceInvertedMembership({
      projectId,
      evidenceSetId: set.id,
      evidenceId: secondEvidence.id,
      reservedSequence: Number(reserved.sequence),
    });
    const [latestRow] = await client`
      select id, sequence, set_ordinal from evidence_set_composition_revisions
      where project_id=${projectId} and evidence_set_id=${set.id}
      order by set_ordinal desc limit 1
    `;
    expect(String(latestRow.id)).toBe(inverted.revisionId);
    expect(Number(latestRow.set_ordinal)).toBeGreaterThan(2);
    expect(Number(latestRow.sequence)).toBeLessThan(Number(firstSequence.sequence));

    const history = await services.listEvidenceSetCompositionHistory(projectId, set.id);
    expect(history.map((entry) => entry.revision.operationKind)).toEqual(["created", "added", "added"]);
    expect(history.map((entry) => entry.revision.id)).toEqual([emptyRevision.id, firstAdded.revision.id, inverted.revisionId]);

    const latestFields = await services.listEvidenceSetSynthesisFields(projectId, set.id);
    expect(latestFields.find((item) => item.field.id === field.id)?.candidatePaperCount).toBe(2);

    const driftedWorkspace = await services.getSynthesisPreparationWorkspace(projectId, preparation.id);
    expect(driftedWorkspace.sourceSetChanged).toBe(true);
    expect(driftedWorkspace.latestCompositionSequence).toBeLessThan(driftedWorkspace.pinnedCompositionSequence);
    expect(driftedWorkspace.candidates).toHaveLength(1);
    expect(driftedWorkspace.candidates[0].extractionRevision.paperId).toBe(firstPaper.id);
    const listedPreparation = (await services.listSynthesisPreparations(projectId)).find((item) => item.id === preparation.id);
    expect(listedPreparation?.sourceSetChanged).toBe(true);

    const projection = await coverage.getQuestionTraceability(projectId, question.id);
    expect(projection.evidenceSetCoverage[0].memberCount).toBe(2);
    expect(projection.evidenceSetCoverage[0].distinctPaperCount).toBe(2);
  });
});
