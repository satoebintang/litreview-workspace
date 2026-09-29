import "dotenv/config";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createSynthesisPreparationReadServices } from "@/application/synthesis-preparation-read-services";
import { schema } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice47_prep_reads_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 47 SynthesisPreparation bounded reads", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let countedClient: postgres.Sql | undefined;
  let services: ReturnType<typeof createReviewServices> | undefined;
  let reads: ReturnType<typeof createSynthesisPreparationReadServices> | undefined;
  const queryLog: string[] = [];

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    const created = createDb(databaseUrl.toString());
    appClient = created.client;
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    services = createReviewServices(created.db);
    countedClient = postgres(databaseUrl.toString(), { max: 1, prepare: false });
    const countedDb = drizzle(countedClient, {
      schema,
      logger: { logQuery(query) { queryLog.push(query); } },
    });
    reads = createSynthesisPreparationReadServices(countedDb);
  });

  afterAll(async () => {
    await Promise.all([appClient?.end(), countedClient?.end()]);
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function includedPaper(projectId: string, title: string) {
    const paper = await services!.addPaper(projectId, { title });
    await services!.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services!.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services!.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  async function setWithEvidence(projectId: string, evidenceIds: string[]) {
    const created = await services!.createEvidenceSet(projectId, { name: `Pinned ${randomUUID()}` });
    for (const evidenceId of evidenceIds) {
      const current = await services!.getEvidenceSet(projectId, created.set.id);
      await services!.addEvidenceToSet(projectId, created.set.id, {
        evidenceId,
        expectedRevisionId: current.currentRevision.id,
      });
    }
    return created.set;
  }

  async function appendSequenceInvertedMembership(input: {
    projectId: string;
    evidenceSetId: string;
    evidenceId: string;
    reservedSequence: number;
  }) {
    return appClient!.begin(async (tx) => {
      await tx.unsafe("select id from evidence_sets where project_id=$1::uuid and id=$2::uuid for update", [input.projectId, input.evidenceSetId]);
      const current = await tx.unsafe(
        "select tail_membership_id from evidence_set_composition_revisions where project_id=$1::uuid and evidence_set_id=$2::uuid order by set_ordinal desc limit 1",
        [input.projectId, input.evidenceSetId],
      ) as unknown as Array<{ tail_membership_id: string | null }>;
      const membership = await tx.unsafe(
        "insert into evidence_set_memberships (project_id,evidence_set_id,evidence_id) values ($1::uuid,$2::uuid,$3::uuid) returning id",
        [input.projectId, input.evidenceSetId, input.evidenceId],
      ) as unknown as Array<{ id: string }>;
      const revision = await tx.unsafe(
        "insert into evidence_set_composition_revisions (sequence,project_id,evidence_set_id,operation_kind,target_membership_id) overriding system value values ($1::bigint,$2::uuid,$3::uuid,'added',$4::uuid) returning id,set_ordinal",
        [input.reservedSequence, input.projectId, input.evidenceSetId, membership[0].id],
      ) as unknown as Array<{ id: string; set_ordinal: string | number }>;
      const ordinal = Number(revision[0].set_ordinal);
      if (current[0].tail_membership_id != null) {
        await tx.unsafe(
          "update evidence_set_membership_order_versions set valid_to_ordinal=$4::bigint where project_id=$1::uuid and evidence_set_id=$2::uuid and membership_id=$3::uuid and valid_to_ordinal is null",
          [input.projectId, input.evidenceSetId, current[0].tail_membership_id, ordinal],
        );
        await tx.unsafe(
          "insert into evidence_set_membership_order_versions (project_id,evidence_set_id,membership_id,next_membership_id,valid_from_ordinal) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint)",
          [input.projectId, input.evidenceSetId, current[0].tail_membership_id, membership[0].id, ordinal],
        );
      }
      await tx.unsafe(
        "insert into evidence_set_membership_order_versions (project_id,evidence_set_id,membership_id,next_membership_id,valid_from_ordinal) values ($1::uuid,$2::uuid,$3::uuid,null,$4::bigint)",
        [input.projectId, input.evidenceSetId, membership[0].id, ordinal],
      );
      return { revisionId: revision[0].id, ordinal };
    });
  }

  function legacyCandidateProjection(workspace: Awaited<ReturnType<NonNullable<typeof services>["getSynthesisPreparationWorkspace"]>>) {
    return workspace.candidates.map((candidate) => ({
      extractionRevisionId: candidate.extractionRevision.id,
      extractionValueId: candidate.extractionRevision.extractionValueId,
      sequence: candidate.extractionRevision.sequence,
      finalizedAt: comparableTimestamp(candidate.extractionRevision.finalizedAt),
      valueState: candidate.extractionRevision.valueState,
      value: candidate.extractionRevision.valueState === "present"
        ? candidate.extractionRevision.textValue ?? candidate.extractionRevision.numberValue ?? (candidate.extractionRevision.booleanValue == null ? null : candidate.extractionRevision.booleanValue ? "Yes" : "No")
        : candidate.extractionRevision.valueState.replaceAll("_", " "),
      optionId: candidate.extractionRevision.optionId,
      optionLabel: null as string | null,
      paper: { id: candidate.paper.id, title: candidate.paper.title },
      isFinallyIncluded: candidate.isFinallyIncluded,
      isCurrentExtractionRevision: candidate.isCurrentExtractionRevision,
      selected: candidate.selected,
      selectable: candidate.selectable,
      membershipOrder: Math.min(...candidate.connectingEvidence.map((item) => item.membershipOrder)),
      connectingEvidenceCount: candidate.connectingEvidence.length,
      directEvidenceCount: candidate.extractionRevision.evidence.length,
      eligibilityReasons: candidate.eligibilityReasons,
      warnings: candidate.warnings,
    }));
  }

  function comparableTimestamp(value: string | Date | null) {
    return value == null ? null : typeof value === "string" ? new Date(value).getTime() : value.getTime();
  }

  function selectCount() {
    return queryLog.filter((query) => /^\s*(with|select)\b/i.test(query)).length;
  }

  it("keeps the candidate identity epoch fixed across later finalizations and refreshes live annotations", async () => {
    const project = await services!.createProject({ title: `Epoch read ${randomUUID()}` });
    const paperA = await includedPaper(project.id, "A pinned candidate");
    const paperB = await includedPaper(project.id, "B later finalized candidate");
    const paperC = await includedPaper(project.id, "C pinned candidate");
    const evidenceA = await services!.recordEvidence(project.id, { paperId: paperA.id, sourceText: "Supporting A", pageNumber: 1 });
    const evidenceB = await services!.recordEvidence(project.id, { paperId: paperB.id, sourceText: "Supporting B", pageNumber: 2 });
    const evidenceC = await services!.recordEvidence(project.id, { paperId: paperC.id, sourceText: "Supporting C", pageNumber: 3 });
    const field = await services!.createExtractionField(project.id, { name: "Finding", fieldType: "short_text" });
    const revisionA = await services!.reviseExtractionValue(project.id, paperA.id, field.id, { value: "A value", evidenceIds: [evidenceA.id] });
    const revisionC = await services!.reviseExtractionValue(project.id, paperC.id, field.id, { value: "C value", evidenceIds: [evidenceC.id] });
    const set = await setWithEvidence(project.id, [evidenceA.id, evidenceB.id, evidenceC.id]);
    const preparation = await services!.createSynthesisPreparation(project.id, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });

    const legacyAtEpoch = await services!.getSynthesisPreparationWorkspace(project.id, preparation.id);
    queryLog.length = 0;
    const header = await reads!.getSynthesisPreparationHeader(project.id, preparation.id);
    const firstPage = await reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { pageSize: 1 });
    expect(selectCount()).toBe(2);
    expect(header.pinnedComposition.id).toBe(preparation.evidenceSetCompositionRevisionId);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0].extractionRevisionId).toBe(revisionA.id);
    expect(firstPage.candidateCount).toBe(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();
    queryLog.length = 0;
    const parityPage = await reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { pageSize: 100 });
    expect(parityPage.items.map((candidate) => candidate.extractionRevisionId)).toEqual(
      legacyCandidateProjection(legacyAtEpoch).map((candidate) => candidate.extractionRevisionId),
    );
    expect(parityPage.items.map((candidate) => ({
      extractionRevisionId: candidate.extractionRevisionId,
      extractionValueId: candidate.extractionValueId,
      sequence: candidate.sequence,
      finalizedAt: comparableTimestamp(candidate.finalizedAt),
      valueState: candidate.valueState,
      value: candidate.value,
      optionId: candidate.optionId,
      optionLabel: candidate.optionLabel,
      paper: candidate.paper,
      isFinallyIncluded: candidate.isFinallyIncluded,
      isCurrentExtractionRevision: candidate.isCurrentExtractionRevision,
      selected: candidate.selected,
      selectable: candidate.selectable,
      membershipOrder: candidate.membershipOrder,
      connectingEvidenceCount: candidate.connectingEvidenceCount,
      directEvidenceCount: candidate.directEvidenceCount,
      eligibilityReasons: candidate.eligibilityReasons,
      warnings: candidate.warnings,
    }))).toEqual(legacyCandidateProjection(legacyAtEpoch));

    const laterRevision = await services!.reviseExtractionValue(project.id, paperB.id, field.id, { value: "B value", evidenceIds: [evidenceB.id] });
    const liveExclusion = await services!.createScreeningCriterion(project.id, { type: "exclusion", text: "Live candidate annotation" });
    await services!.recordScreeningDecision(project.id, paperC.id, { decision: "exclude", exclusionCriterionId: liveExclusion.id });
    const continuation = await reads!.listSynthesisPreparationCandidates(project.id, preparation.id, {
      pageSize: 1,
      cursor: firstPage.nextCursor,
    });
    expect(continuation.candidateSnapshotAt).toBe(firstPage.candidateSnapshotAt);
    expect(continuation.candidateCount).toBe(firstPage.candidateCount);
    expect(continuation.items.map((candidate) => candidate.extractionRevisionId)).toEqual([revisionC.id]);
    expect(continuation.items.map((candidate) => candidate.extractionRevisionId)).not.toContain(laterRevision.id);
    expect(continuation.items[0]).toMatchObject({ isFinallyIncluded: false, selectable: false });

    const refreshedPage = await reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { pageSize: 100 });
    expect(refreshedPage.candidateSnapshotAt).not.toBe(firstPage.candidateSnapshotAt);
    expect(refreshedPage.candidateCount).toBe(firstPage.candidateCount + 1);
    expect(refreshedPage.items.map((candidate) => candidate.extractionRevisionId)).toContain(laterRevision.id);

    await services!.replaceSynthesisPreparationSelections(project.id, preparation.id, { extractionRevisionIds: [revisionA.id] });
    const selectedPage = await reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { filter: "selected" });
    // candidateCount is the all-candidate universe for this fresh epoch, not
    // the one selected row returned by the live selected filter.
    expect(selectedPage.candidateCount).toBe(3);
    expect(selectedPage.items.map((candidate) => candidate.extractionRevisionId)).toEqual([revisionA.id]);
    expect(selectedPage.items[0].selected).toBe(true);
    expect(selectedPage.items[0].warnings).toContain("underlying_evidence_unreviewed");

    await services!.appendEvidenceReviewDecision(project.id, evidenceA.id, { decision: "accepted" });
    const detail = await reads!.getSynthesisPreparationCandidate(project.id, preparation.id, revisionA.id);
    expect(detail.candidate.selected).toBe(true);
    expect(detail.candidate.warnings).not.toContain("underlying_evidence_unreviewed");

    const criterion = await services!.createFullTextScreeningCriterion(project.id, { text: "Current full-text exclusion" });
    await services!.recordFullTextScreeningDecision(project.id, paperA.id, { decision: "exclude", exclusionCriterionId: criterion.id });
    const ineligible = await reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { filter: "ineligible" });
    expect(ineligible.items.find((candidate) => candidate.extractionRevisionId === revisionA.id)).toMatchObject({
      selected: true,
      isFinallyIncluded: false,
      selectable: false,
    });
    await expect(reads!.getSynthesisPreparationCandidate(project.id, preparation.id, laterRevision.id)).resolves.toMatchObject({
      candidate: { extractionRevisionId: laterRevision.id },
    });
    await expect(reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { pageSize: 2, cursor: firstPage.nextCursor }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const otherProject = await services!.createProject({ title: `Cursor scope ${randomUUID()}` });
    await expect(reads!.listSynthesisPreparationCandidates(otherProject.id, preparation.id, { pageSize: 1, cursor: firstPage.nextCursor }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps candidate membership partitioned into canonical selectable and ineligible rows for every screening state", async () => {
    const project = await services!.createProject({ title: `Eligibility partition ${randomUUID()}` });
    const field = await services!.createExtractionField(project.id, { name: "Eligibility field", fieldType: "short_text" });
    const titleExclusion = await services!.createScreeningCriterion(project.id, { type: "exclusion", text: "Title and abstract exclusion" });
    const fullTextExclusion = await services!.createFullTextScreeningCriterion(project.id, { text: "Full-text exclusion" });
    const cases = [
      { key: "unscreened", title: "Unscreened", titleDecision: null, fullTextDecision: null, cleared: false },
      { key: "titleMaybe", title: "Title maybe", titleDecision: "maybe", fullTextDecision: null, cleared: false },
      { key: "titleExcluded", title: "Title excluded", titleDecision: "exclude", fullTextDecision: null, cleared: false },
      { key: "noFullTextDecision", title: "No full-text decision", titleDecision: "include", fullTextDecision: null, cleared: false },
      { key: "fullTextMaybe", title: "Full-text maybe", titleDecision: "include", fullTextDecision: "maybe", cleared: false },
      { key: "fullTextExcluded", title: "Full-text excluded", titleDecision: "include", fullTextDecision: "exclude", cleared: false },
      { key: "included", title: "Finally included", titleDecision: "include", fullTextDecision: "include", cleared: false },
      { key: "clearedIncluded", title: "Cleared but included", titleDecision: "include", fullTextDecision: "include", cleared: true },
    ] as const;
    const rowsByKey = new Map<string, { paperId: string; evidenceId: string; revisionId: string }>();
    for (const candidate of cases) {
      const paper = await includedPaper(project.id, candidate.title);
      const evidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: `Evidence for ${candidate.key}`, pageNumber: 1 });
      const revision = await services!.reviseExtractionValue(project.id, paper.id, field.id, candidate.cleared
        ? { state: "cleared", researcherNote: "Cleared extraction", evidenceIds: [evidence.id] }
        : { value: `Value for ${candidate.key}`, evidenceIds: [evidence.id] });
      rowsByKey.set(candidate.key, { paperId: paper.id, evidenceId: evidence.id, revisionId: revision.id });
    }

    await services!.recordScreeningDecision(project.id, rowsByKey.get("titleMaybe")!.paperId, { decision: "maybe", note: "Ambiguous title and abstract" });
    await services!.recordScreeningDecision(project.id, rowsByKey.get("titleExcluded")!.paperId, { decision: "exclude", exclusionCriterionId: titleExclusion.id });
    await services!.recordFullTextScreeningDecision(project.id, rowsByKey.get("fullTextMaybe")!.paperId, { decision: "maybe" });
    await services!.recordFullTextScreeningDecision(project.id, rowsByKey.get("fullTextExcluded")!.paperId, { decision: "exclude", exclusionCriterionId: fullTextExclusion.id });
    await appClient!.begin(async (tx) => {
      await tx.unsafe("alter table screening_decisions disable trigger user");
      await tx.unsafe("alter table full_text_screening_decisions disable trigger user");
      try {
        await tx.unsafe("delete from screening_decisions where project_id=$1::uuid and paper_id=$2::uuid", [project.id, rowsByKey.get("unscreened")!.paperId]);
        await tx.unsafe("delete from full_text_screening_decisions where project_id=$1::uuid and paper_id in ($2::uuid,$3::uuid)", [
          project.id,
          rowsByKey.get("unscreened")!.paperId,
          rowsByKey.get("noFullTextDecision")!.paperId,
        ]);
      } finally {
        await tx.unsafe("alter table screening_decisions enable trigger user");
        await tx.unsafe("alter table full_text_screening_decisions enable trigger user");
      }
    });

    const evidenceSet = await setWithEvidence(project.id, [...rowsByKey.values()].map(({ evidenceId }) => evidenceId));
    const preparation = await services!.createSynthesisPreparation(project.id, { evidenceSetId: evidenceSet.id, extractionFieldId: field.id });
    const includedRevisionId = rowsByKey.get("included")!.revisionId;
    await services!.replaceSynthesisPreparationSelections(project.id, preparation.id, { extractionRevisionIds: [includedRevisionId] });

    const assertPartition = async () => {
      const [all, selectable, ineligible] = await Promise.all([
        reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { filter: "all" }),
        reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { filter: "selectable" }),
        reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { filter: "ineligible" }),
      ]);
      const ids = (items: typeof all.items) => items.map((item) => item.extractionRevisionId).sort();
      const allIds = ids(all.items);
      const selectableIds = ids(selectable.items);
      const ineligibleIds = ids(ineligible.items);
      expect(all.candidateCount).toBe(cases.length);
      expect(selectable.candidateCount).toBe(cases.length);
      expect(ineligible.candidateCount).toBe(cases.length);
      expect([...selectableIds, ...ineligibleIds].sort()).toEqual(allIds);
      expect(selectableIds.filter((id) => ineligibleIds.includes(id))).toEqual([]);
      return { all, selectable, ineligible };
    };

    const initial = await assertPartition();
    const expected = [
      ["unscreened", false, false],
      ["titleMaybe", false, false],
      ["titleExcluded", false, false],
      ["noFullTextDecision", false, false],
      ["fullTextMaybe", false, false],
      ["fullTextExcluded", false, false],
      ["included", true, true],
      ["clearedIncluded", true, false],
    ] as const;
    for (const [key, isFinallyIncluded, isSelectable] of expected) {
      const candidate = initial.all.items.find((item) => item.extractionRevisionId === rowsByKey.get(key)!.revisionId);
      expect(candidate).toMatchObject({ isFinallyIncluded, selectable: isSelectable });
    }
    expect(initial.ineligible.items.some((candidate) => candidate.extractionRevisionId === rowsByKey.get("unscreened")!.revisionId)).toBe(true);

    await services!.recordScreeningDecision(project.id, rowsByKey.get("included")!.paperId, {
      decision: "exclude",
      exclusionCriterionId: titleExclusion.id,
    });
    const afterDrift = await assertPartition();
    expect(afterDrift.ineligible.items.find((candidate) => candidate.extractionRevisionId === includedRevisionId)).toMatchObject({
      selected: true,
      isFinallyIncluded: false,
      selectable: false,
    });
  });

  it("matches the released workspace for excluded, superseded, cleared, pinned and sequence-inverted candidates", async () => {
    const project = await services!.createProject({ title: `Candidate parity ${randomUUID()}` });
    const paperA = await includedPaper(project.id, "Alpha excluded");
    const paperB = await includedPaper(project.id, "Beta superseded");
    const paperC = await includedPaper(project.id, "Gamma cleared");
    const paperOutside = await includedPaper(project.id, "Delta outside pin");
    const evidenceA = await services!.recordEvidence(project.id, { paperId: paperA.id, sourceText: "A", pageNumber: 1 });
    const evidenceB = await services!.recordEvidence(project.id, { paperId: paperB.id, sourceText: "B", pageNumber: 1 });
    const evidenceC = await services!.recordEvidence(project.id, { paperId: paperC.id, sourceText: "C", pageNumber: 1 });
    const evidenceOutside = await services!.recordEvidence(project.id, { paperId: paperOutside.id, sourceText: "Outside", pageNumber: 1 });
    const field = await services!.createExtractionField(project.id, { name: "Parity Field", fieldType: "short_text" });
    const revisionA = await services!.reviseExtractionValue(project.id, paperA.id, field.id, { value: "A", evidenceIds: [evidenceA.id] });
    const revisionB = await services!.reviseExtractionValue(project.id, paperB.id, field.id, { value: "B old", evidenceIds: [evidenceB.id] });
    await services!.reviseExtractionValue(project.id, paperC.id, field.id, { value: "C old", evidenceIds: [evidenceC.id] });
    const set = (await services!.createEvidenceSet(project.id, { name: "Parity composition" })).set;
    const empty = await services!.getEvidenceSet(project.id, set.id);
    const reserved = await appClient!.unsafe("select nextval(pg_get_serial_sequence('evidence_set_composition_revisions','sequence'))::bigint as sequence") as unknown as Array<{ sequence: string }>;
    await services!.addEvidenceToSet(project.id, set.id, { evidenceId: evidenceA.id, expectedRevisionId: empty.currentRevision.id });
    const inverted = await appendSequenceInvertedMembership({ projectId: project.id, evidenceSetId: set.id, evidenceId: evidenceB.id, reservedSequence: Number(reserved[0].sequence) });
    expect(inverted.ordinal).toBeGreaterThan(2);
    const afterB = await services!.getEvidenceSet(project.id, set.id);
    await services!.addEvidenceToSet(project.id, set.id, { evidenceId: evidenceC.id, expectedRevisionId: afterB.currentRevision.id });
    const preparation = await services!.createSynthesisPreparation(project.id, { evidenceSetId: set.id, extractionFieldId: field.id });
    await services!.replaceSynthesisPreparationSelections(project.id, preparation.id, { extractionRevisionIds: [revisionB.id] });

    const outsideRevision = await services!.reviseExtractionValue(project.id, paperOutside.id, field.id, { value: "Outside", evidenceIds: [evidenceOutside.id] });
    const latestSet = await services!.getEvidenceSet(project.id, set.id);
    await services!.addEvidenceToSet(project.id, set.id, { evidenceId: evidenceOutside.id, expectedRevisionId: latestSet.currentRevision.id });
    const criterion = await services!.createFullTextScreeningCriterion(project.id, { text: "Excluded after pin" });
    await services!.recordFullTextScreeningDecision(project.id, paperA.id, { decision: "exclude", exclusionCriterionId: criterion.id });
    const revisionBLatest = await services!.reviseExtractionValue(project.id, paperB.id, field.id, { value: "B new", evidenceIds: [evidenceB.id] });
    const revisionCCleared = await services!.reviseExtractionValue(project.id, paperC.id, field.id, { state: "cleared", researcherNote: "Cleared after pin", evidenceIds: [evidenceC.id] });

    const workspace = await services!.getSynthesisPreparationWorkspace(project.id, preparation.id);
    const page = await reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { pageSize: 100 });
    const legacy = legacyCandidateProjection(workspace);
    expect(page.items.map((candidate) => candidate.extractionRevisionId)).toEqual(legacy.map((candidate) => candidate.extractionRevisionId));
    expect(page.items.map((candidate) => ({
      extractionRevisionId: candidate.extractionRevisionId,
      extractionValueId: candidate.extractionValueId,
      sequence: candidate.sequence,
      finalizedAt: comparableTimestamp(candidate.finalizedAt),
      valueState: candidate.valueState,
      value: candidate.value,
      optionId: candidate.optionId,
      optionLabel: candidate.optionLabel,
      paper: candidate.paper,
      isFinallyIncluded: candidate.isFinallyIncluded,
      isCurrentExtractionRevision: candidate.isCurrentExtractionRevision,
      selected: candidate.selected,
      selectable: candidate.selectable,
      membershipOrder: candidate.membershipOrder,
      connectingEvidenceCount: candidate.connectingEvidenceCount,
      directEvidenceCount: candidate.directEvidenceCount,
      eligibilityReasons: candidate.eligibilityReasons,
      warnings: candidate.warnings,
    }))).toEqual(legacy);
    expect(page.items.some((candidate) => candidate.extractionRevisionId === outsideRevision.id)).toBe(false);
    expect(page.items.some((candidate) => candidate.extractionRevisionId === revisionA.id && !candidate.isFinallyIncluded)).toBe(true);
    expect(page.items.some((candidate) => candidate.extractionRevisionId === revisionB.id && candidate.selected && candidate.warnings.includes("extraction_revision_superseded"))).toBe(true);
    expect(page.items.some((candidate) => candidate.extractionRevisionId === revisionBLatest.id)).toBe(true);
    expect(page.items.some((candidate) => candidate.extractionRevisionId === revisionCCleared.id && !candidate.selectable && candidate.warnings.includes("extraction_revision_cleared"))).toBe(true);
    expect(page.items.map((candidate) => candidate.membershipOrder)).toEqual([...page.items.map((candidate) => candidate.membershipOrder)].sort((left, right) => left - right));
    await expect(reads!.getSynthesisPreparationCandidate(project.id, preparation.id, outsideRevision.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pages pinned connecting Evidence separately from all direct Evidence and validates exact candidate membership", async () => {
    const project = await services!.createProject({ title: `Evidence read ${randomUUID()}` });
    const paper = await includedPaper(project.id, "Long-source paper");
    const connecting = await services!.recordEvidence(project.id, {
      paperId: paper.id,
      sourceText: "x".repeat(2_100),
      note: "n".repeat(500),
      pageNumber: 2,
    });
    const directOnly = await services!.recordEvidence(project.id, {
      paperId: paper.id,
      sourceText: "Direct but not pinned",
      pageNumber: 3,
    });
    const field = await services!.createExtractionField(project.id, { name: "Outcome", fieldType: "short_text" });
    const revision = await services!.reviseExtractionValue(project.id, paper.id, field.id, {
      value: "A value",
      evidenceIds: [connecting.id, directOnly.id],
    });
    const set = await setWithEvidence(project.id, [connecting.id]);
    const preparation = await services!.createSynthesisPreparation(project.id, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });

    queryLog.length = 0;
    const candidate = await reads!.getSynthesisPreparationCandidate(project.id, preparation.id, revision.id);
    expect(candidate.candidate).toMatchObject({ connectingEvidenceCount: 1, directEvidenceCount: 2 });
    expect(candidate.header).toMatchObject({
      preparation: { id: preparation.id, projectId: project.id },
      pinnedComposition: { id: preparation.evidenceSetCompositionRevisionId },
      field: { id: field.id },
    });
    expect(selectCount()).toBe(1);

    const connectingPage = await reads!.listSynthesisPreparationConnectingEvidence(project.id, preparation.id, revision.id, { pageSize: 1 });
    expect(connectingPage.items).toHaveLength(1);
    expect(connectingPage.hasMore).toBe(false);
    expect(connectingPage.items[0]).toMatchObject({
      id: connecting.id,
      sourceTruncated: true,
      noteTruncated: true,
      membershipOrder: 1,
      curationWarning: "never_reviewed",
    });

    const directFirst = await reads!.listSynthesisPreparationDirectEvidence(project.id, preparation.id, revision.id, { pageSize: 1 });
    expect(directFirst.items).toHaveLength(1);
    expect(directFirst.items[0].id).toBe(connecting.id);
    expect(directFirst.hasMore).toBe(true);
    expect(selectCount()).toBe(3);
    const directSecond = await reads!.listSynthesisPreparationDirectEvidence(project.id, preparation.id, revision.id, {
      pageSize: 1,
      cursor: directFirst.nextCursor,
    });
    expect(directSecond.items.map((item) => item.id)).toEqual([directOnly.id]);
    expect(directSecond.hasMore).toBe(false);

    const outsider = await includedPaper(project.id, "Not pinned");
    const outsiderEvidence = await services!.recordEvidence(project.id, { paperId: outsider.id, sourceText: "Outside", pageNumber: 1 });
    const outsiderRevision = await services!.reviseExtractionValue(project.id, outsider.id, field.id, { value: "Outside", evidenceIds: [outsiderEvidence.id] });
    await expect(reads!.getSynthesisPreparationCandidate(project.id, preparation.id, outsiderRevision.id))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed for a cyclic but otherwise valid-looking pinned order chain", async () => {
    const project = await services!.createProject({ title: `Corrupt composition ${randomUUID()}` });
    const paper = await includedPaper(project.id, "Cycle candidate");
    const evidenceA = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "A", pageNumber: 1 });
    const evidenceB = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "B", pageNumber: 2 });
    const field = await services!.createExtractionField(project.id, { name: "Cycle field", fieldType: "short_text" });
    const revision = await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: "Cycle value", evidenceIds: [evidenceA.id, evidenceB.id] });
    const set = await setWithEvidence(project.id, [evidenceA.id, evidenceB.id]);
    const preparation = await services!.createSynthesisPreparation(project.id, { evidenceSetId: set.id, extractionFieldId: field.id });
    const pinnedSetOrdinal = (await reads!.getSynthesisPreparationHeader(project.id, preparation.id)).pinnedComposition.setOrdinal;
    const members = await appClient!.unsafe(
      "select membership_id,next_membership_id from evidence_set_membership_order_versions where project_id=$1::uuid and evidence_set_id=$2::uuid and valid_from_ordinal<=$3::bigint and (valid_to_ordinal is null or $3::bigint<valid_to_ordinal) order by valid_from_ordinal,membership_id",
      [project.id, set.id, pinnedSetOrdinal],
    ) as unknown as Array<{ membership_id: string; next_membership_id: string | null }>;
    expect(members).toHaveLength(2);
    const headId = members.find((row) => row.next_membership_id != null)!.membership_id;
    const tailId = members.find((row) => row.next_membership_id == null)!.membership_id;

    await appClient!.begin(async (tx) => {
      await tx.unsafe("alter table evidence_set_membership_order_versions disable trigger user");
      try {
        await tx.unsafe(
          "update evidence_set_membership_order_versions set next_membership_id=$4::uuid where project_id=$1::uuid and evidence_set_id=$2::uuid and membership_id=$3::uuid and valid_from_ordinal<=$5::bigint and (valid_to_ordinal is null or $5::bigint<valid_to_ordinal)",
          [project.id, set.id, tailId, headId, pinnedSetOrdinal],
        );
      } finally {
        await tx.unsafe("alter table evidence_set_membership_order_versions enable trigger user");
      }
    });

    await expect(reads!.listSynthesisPreparationCandidates(project.id, preparation.id, { pageSize: 10 }))
      .rejects.toMatchObject({ code: "DATABASE_CONSTRAINT" });
    await expect(reads!.getSynthesisPreparationCandidate(project.id, preparation.id, revision.id))
      .rejects.toMatchObject({ code: "DATABASE_CONSTRAINT" });
    await expect(reads!.listSynthesisPreparationConnectingEvidence(project.id, preparation.id, revision.id))
      .rejects.toMatchObject({ code: "DATABASE_CONSTRAINT" });
  });

  it("SQL-caps preparation ledger previews and related labels", async () => {
    const project = await services!.createProject({ title: `Ledger caps ${randomUUID()}` });
    const paper = await includedPaper(project.id, "Ledger cap source");
    const evidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "Source", pageNumber: 1 });
    const field = await services!.createExtractionField(project.id, { name: "F".repeat(130), fieldType: "short_text" });
    const extraction = await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: "Finding", evidenceIds: [evidence.id] });
    const evidenceSet = await services!.createEvidenceSet(project.id, { name: "S".repeat(100) });
    await services!.addEvidenceToSet(project.id, evidenceSet.set.id, {
      evidenceId: evidence.id,
      expectedRevisionId: evidenceSet.revision.id,
    });
    const preparation = await services!.createSynthesisPreparation(project.id, {
      evidenceSetId: evidenceSet.set.id,
      extractionFieldId: field.id,
      workingTitle: "T".repeat(140),
      workingNote: "N".repeat(220),
    });
    const target = await services!.createSynthesisStatement(project.id, {
      title: "Target".repeat(25),
      statementText: "A ledger target statement",
      extractionRevisionIds: [extraction.id],
    });
    await services!.updateSynthesisPreparation(project.id, preparation.id, {
      targetSynthesisStatementId: target.statement.id,
    });
    const laterEvidence = await services!.recordEvidence(project.id, {
      paperId: paper.id,
      sourceText: "A later source added after the preparation was pinned.",
      pageNumber: 2,
    });
    const latestSet = await services!.getEvidenceSet(project.id, evidenceSet.set.id);
    await services!.addEvidenceToSet(project.id, evidenceSet.set.id, {
      evidenceId: laterEvidence.id,
      expectedRevisionId: latestSet.currentRevision.id,
    });

    const page = await reads!.listSynthesisPreparationLedger(project.id, { pageSize: 10 });
    const row = page.items.find((item) => item.id === preparation.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      evidenceSetName: "S".repeat(100),
      evidenceSetNameTruncated: false,
      extractionFieldName: "F".repeat(120),
      extractionFieldNameTruncated: true,
      workingTitlePreview: "T".repeat(120),
      workingTitleTruncated: true,
      workingNotePreview: "N".repeat(200),
      workingNoteTruncated: true,
      targetSynthesisStatementTitle: "Target".repeat(20),
      targetSynthesisStatementTitleTruncated: true,
      sourceSetChanged: true,
    });
  });

  it("keeps the target picker Project scoped, keyset paged, searchable, and clearable without a query", async () => {
    const project = await services!.createProject({ title: `Target read ${randomUUID()}` });
    const paper = await includedPaper(project.id, "Target support");
    const evidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "Evidence", pageNumber: 1 });
    const field = await services!.createExtractionField(project.id, { name: "Theme", fieldType: "short_text" });
    const revision = await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: "Theme", evidenceIds: [evidence.id] });
    const first = await services!.createSynthesisStatement(project.id, { statementText: "An in vitro synthesis", extractionRevisionIds: [revision.id] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await services!.createSynthesisStatement(project.id, { statementText: "Another in vitro synthesis", extractionRevisionIds: [revision.id] });
    const withdrawn = await services!.createSynthesisStatement(project.id, { statementText: "A browsable withdrawn synthesis", extractionRevisionIds: [revision.id] });
    await services!.withdrawSynthesisStatement(project.id, withdrawn.statement.id);
    const bareStatementId = randomUUID();
    await appClient!.unsafe(
      "insert into synthesis_statements (id,project_id,created_at) values ($1::uuid,$2::uuid,now())",
      [bareStatementId, project.id],
    );

    const page = await reads!.listSynthesisTargetStatementOptions(project.id, { query: "  IN VITRO ", pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(second.statement.id);
    expect(page.items[0].currentRevision?.state).toBe("active");
    expect(page.hasMore).toBe(true);
    const next = await reads!.listSynthesisTargetStatementOptions(project.id, { query: "  IN VITRO ", pageSize: 1, cursor: page.nextCursor });
    expect(next.items.map((item) => item.id)).toEqual([first.statement.id]);
    expect(await reads!.resolveSynthesisTargetStatement(project.id, withdrawn.statement.id)).toMatchObject({
      id: withdrawn.statement.id,
      currentRevision: { state: "withdrawn" },
    });
    expect(await reads!.resolveSynthesisTargetStatement(project.id, bareStatementId)).toMatchObject({
      id: bareStatementId,
      currentRevision: null,
    });
    const browseAll = await reads!.listSynthesisTargetStatementOptions(project.id, { query: "" });
    expect(browseAll.items.some((item) => item.id === bareStatementId && item.currentRevision === null)).toBe(true);

    const otherProject = await services!.createProject({ title: `Other target scope ${randomUUID()}` });
    expect(await reads!.resolveSynthesisTargetStatement(otherProject.id, withdrawn.statement.id)).toBeNull();
    await expect(reads!.listSynthesisTargetStatementOptions(project.id, { query: "x".repeat(201) }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    queryLog.length = 0;
    expect(await reads!.resolveSynthesisTargetStatement(project.id, null)).toBeNull();
    expect(selectCount()).toBe(0);
  });
});
