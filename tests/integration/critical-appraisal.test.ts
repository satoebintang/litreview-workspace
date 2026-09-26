import "dotenv/config";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createAiExtractionSuggestionServices } from "@/application/ai-extraction-suggestion-services";
import { createAiSynthesisSuggestionServices } from "@/application/ai-synthesis-suggestion-services";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(DATABASE_URL);
const services = createReviewServices(db);
let projectId = "";

describe("Slice 33 critical appraisal foundation", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Appraisal project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE appraisal_revision_response_evidence, appraisal_revision_responses, appraisal_revisions, appraisals, appraisal_framework_overall_judgement_options, appraisal_framework_response_options, appraisal_framework_items, appraisal_framework_sections, appraisal_framework_versions, appraisal_frameworks CASCADE");
    await client.end();
  });

  async function includedPaper(title = "Included study") {
    const paper = await services.addPaper(projectId, { title, authors: ["Author"] });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  async function finalizedFramework(name = "Custom appraisal") {
    const created = await services.createAppraisalFramework(projectId, { name });
    let expectedDraftRevision = created.version.draftRevision;
    const section = await services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision, label: "Study design" });
    expectedDraftRevision = section.draftRevision;
    const item = await services.addFrameworkItem(projectId, { versionId: created.version.id, expectedDraftRevision, sectionId: section.id, prompt: "Is the design appropriate?", required: true });
    expectedDraftRevision = item.draftRevision;
    const yes = await services.addFrameworkResponseOption(projectId, { versionId: created.version.id, expectedDraftRevision, itemId: item.id, optionKey: "yes", label: "Yes" });
    expectedDraftRevision = yes.draftRevision;
    const unclear = await services.addFrameworkResponseOption(projectId, { versionId: created.version.id, expectedDraftRevision, itemId: item.id, optionKey: "unclear", label: "Unclear" });
    expectedDraftRevision = unclear.draftRevision;
    await services.setFrameworkOverallJudgementOptions(projectId, { versionId: created.version.id, expectedDraftRevision, required: false, options: [{ optionKey: "useful", label: "Useful" }, { optionKey: "limited", label: "Limited" }] });
    const detail = await services.readFrameworkVersion(projectId, created.version.id);
    const finalized = await services.finalizeFrameworkVersion(projectId, created.version.id, detail.version.draftRevision);
    return { framework: created.framework, version: finalized.version, item: finalized.items[0], option: finalized.items[0].options[0], overall: finalized.overallOptions[0] };
  }

  async function draftWithSectionAndItem(name: string) {
    const created = await services.createAppraisalFramework(projectId, { name });
    const section = await services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: created.version.draftRevision, label: "Design" });
    const item = await services.addFrameworkItem(projectId, { versionId: created.version.id, expectedDraftRevision: section.draftRevision, sectionId: section.id, prompt: "Is the design appropriate?", required: true });
    return { ...created, section, item, draftRevision: item.draftRevision };
  }

  function expectOneConflict(attempts: PromiseSettledResult<unknown>[]) {
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  }

  async function save(paperId: string, frameworkId: string, versionId: string, itemId: string, optionId: string, expectedCurrentRevisionId: string | null, evidenceIds: string[] = []) {
    return services.saveAppraisalRevision(projectId, {
      paperId,
      frameworkId,
      frameworkVersionId: versionId,
      expectedCurrentRevisionId,
      responses: [{ itemId, selectedOptionId: optionId, rationale: "Researcher rationale", evidenceIds }],
    });
  }

  const requiredProtectedTables = [
    "screening_decisions", "full_text_screening_decisions", "full_text_retrieval_attempts",
    "evidence", "evidence_review_decisions", "evidence_annotations", "evidence_label_events",
    "evidence_set_memberships", "evidence_set_composition_revisions", "evidence_set_composition_members",
    "extraction_values", "extraction_value_revisions", "extraction_revision_evidence",
    "ai_extraction_requests", "ai_extraction_request_pages", "ai_extraction_dispatches", "ai_extraction_results",
    "ai_extraction_result_groundings", "ai_extraction_decisions", "ai_extraction_decision_evidence",
    "ai_extraction_batches", "ai_extraction_batch_items",
    "synthesis_preparations", "synthesis_preparation_selections", "synthesis_statements", "synthesis_revisions",
    "synthesis_revision_supports", "synthesis_interpretations", "ai_synthesis_requests", "ai_synthesis_request_supports",
    "ai_synthesis_request_sources", "ai_synthesis_dispatches", "ai_synthesis_results", "ai_synthesis_result_groundings",
    "ai_synthesis_decisions",
    "claims", "claim_revisions", "claim_revision_evidence_supports", "claim_revision_extraction_supports",
    "claim_revision_synthesis_supports",
    "research_questions", "research_question_answers", "research_question_answer_claim_contexts",
    "research_question_answer_synthesis_contexts", "research_question_claim_events", "research_question_evidence_set_events",
    "research_question_extraction_field_events", "research_question_synthesis_statement_events",
    "manuscripts", "manuscript_sections", "manuscript_claim_placements", "manuscript_section_items",
    "manuscript_prose_blocks", "manuscript_prose_revisions", "manuscript_review_threads", "manuscript_review_events",
    "manuscript_snapshots", "manuscript_snapshot_sections", "manuscript_snapshot_items", "manuscript_snapshot_prose_items",
    "manuscript_snapshot_claim_items", "manuscript_snapshot_bibliography_entries",
    "manuscript_snapshot_claim_bibliography_members", "manuscript_snapshot_warnings",
    "search_strategies", "search_runs", "retrieved_records", "retrieved_record_matches",
    "retrieved_record_deduplication_decisions",
  ];
  const allowedAppraisalTables = [
    "appraisal_frameworks", "appraisal_framework_versions", "appraisal_framework_sections", "appraisal_framework_items",
    "appraisal_framework_response_options", "appraisal_framework_overall_judgement_options", "appraisals",
    "appraisal_revisions", "appraisal_revision_responses", "appraisal_revision_response_evidence",
  ];

  async function snapshotProjectState(ownerProjectId: string) {
    const projectTables = await client.unsafe(
      "select distinct c.table_name from information_schema.columns c join information_schema.tables i on i.table_schema=c.table_schema and i.table_name=c.table_name where c.table_schema='public' and (c.column_name='project_id' or c.table_name='projects') and i.table_type='BASE TABLE' order by c.table_name",
    ) as Array<{ table_name: string }>;
    const primaryKeyRows = await client.unsafe(`
      select key_usage.table_name, key_usage.column_name, key_usage.ordinal_position
      from information_schema.table_constraints constraints
      join information_schema.key_column_usage key_usage
        on key_usage.constraint_catalog=constraints.constraint_catalog
       and key_usage.constraint_schema=constraints.constraint_schema
       and key_usage.constraint_name=constraints.constraint_name
       and key_usage.table_name=constraints.table_name
      where constraints.table_schema='public' and constraints.constraint_type='PRIMARY KEY'
      order by key_usage.table_name, key_usage.ordinal_position
    `) as Array<{ table_name: string; column_name: string; ordinal_position: number }>;
    const keysByTable = new Map<string, string[]>();
    for (const row of primaryKeyRows) keysByTable.set(row.table_name, [...(keysByTable.get(row.table_name) ?? []), row.column_name]);
    const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const snapshot: Record<string, { count: number; sha256: string }> = {};

    for (const { table_name: tableName } of projectTables) {
      const primaryKey = keysByTable.get(tableName);
      if (!primaryKey?.length) throw new Error(`Project table ${tableName} has no stable primary key for snapshot ordering`);
      const orderBy = primaryKey.map((column) => `t.${quoteIdentifier(column)}`).join(", ");
      const projectPredicate = tableName === "projects" ? "t.id=$1" : "t.project_id=$1";
      const rows = await client.unsafe(
        `select to_jsonb(t)::text as canonical_row from public.${quoteIdentifier(tableName)} t where ${projectPredicate} order by ${orderBy}`,
        [ownerProjectId],
      ) as Array<{ canonical_row: string }>;
      const serialized = JSON.stringify(rows.map((row) => row.canonical_row));
      snapshot[tableName] = { count: rows.length, sha256: createHash("sha256").update(serialized).digest("hex") };
    }

    const present = new Set(projectTables.map((row) => row.table_name));
    expect(requiredProtectedTables.filter((table) => !present.has(table))).toEqual([]);
    return snapshot;
  }

  it("creates a complete immutable revision with exact eligibility and Evidence review snapshots", async () => {
    const paper = await includedPaper();
    const framework = await finalizedFramework();
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Exact design passage", pageNumber: 4 });
    const review = await services.appendEvidenceReviewDecision(projectId, evidence.id, { decision: "accepted", note: "Checked" });

    const revision = await save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, null, [evidence.id]);
    expect(revision.finalizedAt).toBeTruthy();
    expect(revision.titleAbstractDecisionId).toBeTruthy();
    expect(revision.fullTextDecisionId).toBeTruthy();
    expect(revision.responses).toHaveLength(1);
    expect(revision.responses[0].evidence[0]).toMatchObject({ evidenceId: evidence.id, evidenceReviewDecisionIdAtSave: review.id, evidenceReviewStateAtSave: "accepted" });
    const paperView = await services.readPaperAppraisal(projectId, paper.id, framework.framework.id);
    expect(paperView.currentRevision?.id).toBe(revision.id);
    expect(paperView.currentRevision?.responses[0].evidence[0].evidenceId).toBe(evidence.id);
    const history = await services.readAppraisalHistory(projectId, paper.id, framework.framework.id);
    expect(history.revisions[0]).toMatchObject({ id: revision.id, revisionNumber: 1, versionNumber: framework.version.versionNumber, completion: "complete" });
  });

  it("rejects stale direct-SQL eligibility pins and unfinalized committed revisions", async () => {
    const paper = await includedPaper("Eligibility race");
    const framework = await finalizedFramework("Eligibility framework");
    const first = await save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, null);
    await services.recordScreeningDecision(projectId, paper.id, { decision: "maybe" });

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`insert into appraisal_revisions (revision_number, project_id, paper_id, framework_id, appraisal_id, framework_version_id, title_abstract_decision_id, full_text_decision_id, finalized_at) values (2,${projectId},${paper.id},${framework.framework.id},${first.appraisalId},${framework.version.id},${first.titleAbstractDecisionId},${first.fullTextDecisionId},now())`);
    })).rejects.toThrow(/latest included title\/abstract decision/i);

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`insert into appraisal_revisions (revision_number, project_id, paper_id, framework_id, appraisal_id, framework_version_id, title_abstract_decision_id, full_text_decision_id) values (2,${projectId},${paper.id},${framework.framework.id},${first.appraisalId},${framework.version.id},${first.titleAbstractDecisionId},${first.fullTextDecisionId})`);
    })).rejects.toThrow(/cannot be committed/i);
  });

  it("grandfathers only the immediately preceding rejected Evidence pair", async () => {
    const paper = await includedPaper("Evidence grandfather");
    const framework = await finalizedFramework("Evidence framework");
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Evidence passage", pageNumber: 2 });
    await services.appendEvidenceReviewDecision(projectId, evidence.id, { decision: "accepted" });
    const first = await save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, null, [evidence.id]);
    await services.appendEvidenceReviewDecision(projectId, evidence.id, { decision: "rejected" });

    const carried = await save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, first.id, [evidence.id]);
    expect(carried.responses[0].evidence[0].evidenceReviewStateAtSave).toBe("rejected");
    const removed = await save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, carried.id, []);
    await expect(save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, removed.id, [evidence.id])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps framework-version movement monotonic and permits v1 editing until v2 reassessment", async () => {
    const paper = await includedPaper("Version movement");
    const framework = await finalizedFramework("Version framework");
    const first = await save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, null);
    const draftV2 = await services.createNewFrameworkVersion(projectId, framework.framework.id, { versionLabel: "2" });
    const finalizedV2 = await services.finalizeFrameworkVersion(projectId, draftV2.version.id, draftV2.version.draftRevision);

    const continuedV1 = await save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, first.id);
    const reassessed = await save(paper.id, framework.framework.id, finalizedV2.version.id, finalizedV2.items[0].id, finalizedV2.items[0].options[0].id, continuedV1.id);
    expect(reassessed.frameworkVersionId).toBe(finalizedV2.version.id);
    await expect(save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, reassessed.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("serializes two first saves and two saves from one expected revision", async () => {
    const paper = await includedPaper("Concurrent saves");
    const framework = await finalizedFramework("Concurrency framework");
    const firstAttempts = await Promise.allSettled([
      save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, null),
      save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, null),
    ]);
    expect(firstAttempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(firstAttempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const first = firstAttempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof save>>> => attempt.status === "fulfilled")!.value;
    const secondAttempts = await Promise.allSettled([
      save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, first.id),
      save(paper.id, framework.framework.id, framework.version.id, framework.item.id, framework.option.id, first.id),
    ]);
    expect(secondAttempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(secondAttempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("serializes competing section additions and advances the draft once", async () => {
    const created = await services.createAppraisalFramework(projectId, { name: "Section race" });
    const attempts = await Promise.allSettled([
      services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: 0, label: "A" }),
      services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: 0, label: "B" }),
    ]);
    expectOneConflict(attempts);
    const detail = await services.readFrameworkVersion(projectId, created.version.id);
    expect(detail.version.draftRevision).toBe(1);
    expect(detail.sections).toHaveLength(1);
  });

  it("serializes competing item additions against one draft revision", async () => {
    const draft = await draftWithSectionAndItem("Item race");
    const attempts = await Promise.allSettled([
      services.addFrameworkItem(projectId, { versionId: draft.version.id, expectedDraftRevision: draft.draftRevision, sectionId: draft.section.id, prompt: "A" }),
      services.addFrameworkItem(projectId, { versionId: draft.version.id, expectedDraftRevision: draft.draftRevision, sectionId: draft.section.id, prompt: "B" }),
    ]);
    expectOneConflict(attempts);
    const detail = await services.readFrameworkVersion(projectId, draft.version.id);
    expect(detail.version.draftRevision).toBe(draft.draftRevision + 1);
    expect(detail.items).toHaveLength(2);
  });

  it("serializes competing response-option additions against one draft revision", async () => {
    const draft = await draftWithSectionAndItem("Option race");
    const attempts = await Promise.allSettled([
      services.addFrameworkResponseOption(projectId, { versionId: draft.version.id, expectedDraftRevision: draft.draftRevision, itemId: draft.item.id, optionKey: "a", label: "A" }),
      services.addFrameworkResponseOption(projectId, { versionId: draft.version.id, expectedDraftRevision: draft.draftRevision, itemId: draft.item.id, optionKey: "b", label: "B" }),
    ]);
    expectOneConflict(attempts);
    const detail = await services.readFrameworkVersion(projectId, draft.version.id);
    expect(detail.version.draftRevision).toBe(draft.draftRevision + 1);
    expect(detail.items[0].options).toHaveLength(1);
  });

  it("serializes competing overall-judgement option changes", async () => {
    const created = await services.createAppraisalFramework(projectId, { name: "Overall option race" });
    const attempts = await Promise.allSettled([
      services.setFrameworkOverallJudgementOptions(projectId, { versionId: created.version.id, expectedDraftRevision: 0, required: false, options: [{ optionKey: "a", label: "A" }] }),
      services.setFrameworkOverallJudgementOptions(projectId, { versionId: created.version.id, expectedDraftRevision: 0, required: true, options: [{ optionKey: "b", label: "B" }] }),
    ]);
    expectOneConflict(attempts);
    const detail = await services.readFrameworkVersion(projectId, created.version.id);
    expect(detail.version.draftRevision).toBe(1);
    expect(detail.overallOptions).toHaveLength(1);
  });

  it("makes reorder and an item edit mutually exclusive at one expected revision", async () => {
    const created = await services.createAppraisalFramework(projectId, { name: "Reorder edit race" });
    const section = await services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: 0, label: "Items" });
    const first = await services.addFrameworkItem(projectId, { versionId: created.version.id, expectedDraftRevision: section.draftRevision, sectionId: section.id, prompt: "First item", required: true });
    const second = await services.addFrameworkItem(projectId, { versionId: created.version.id, expectedDraftRevision: first.draftRevision, sectionId: section.id, prompt: "Second item", required: true });
    const expectedDraftRevision = second.draftRevision;
    const attempts = await Promise.allSettled([
      services.reorderFrameworkItems(projectId, { versionId: created.version.id, expectedDraftRevision, sectionId: section.id, ids: [second.id, first.id] }),
      services.updateFrameworkItem(projectId, { versionId: created.version.id, expectedDraftRevision, sectionId: section.id, itemId: first.id, prompt: "First item edited", required: true }),
    ]);
    expectOneConflict(attempts);
    const detail = await services.readFrameworkVersion(projectId, created.version.id);
    expect(detail.version.draftRevision).toBe(expectedDraftRevision + 1);
    const items = detail.items.filter((item) => item.sectionId === section.id);
    const editWon = items.map((item) => item.prompt).join(",") === "First item edited,Second item";
    const reorderWon = items.map((item) => item.id).join(",") === [second.id, first.id].join(",");
    expect(editWon || reorderWon).toBe(true);
  });

  it("rejects incomplete, duplicate, and foreign reorder identity sets without writing", async () => {
    const created = await services.createAppraisalFramework(projectId, { name: "Reorder validation" });
    const first = await services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: 0, label: "First" });
    const second = await services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: first.draftRevision, label: "Second" });
    const expectedDraftRevision = second.draftRevision;
    await expect(services.reorderFrameworkSections(projectId, { versionId: created.version.id, expectedDraftRevision, ids: [first.id] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.reorderFrameworkSections(projectId, { versionId: created.version.id, expectedDraftRevision, ids: [first.id, first.id] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.reorderFrameworkSections(projectId, { versionId: created.version.id, expectedDraftRevision, ids: [first.id, crypto.randomUUID()] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.readFrameworkVersion(projectId, created.version.id)).version.draftRevision).toBe(expectedDraftRevision);
  });

  it("rejects stale finalization after a definition mutation", async () => {
    const created = await services.createAppraisalFramework(projectId, { name: "Stale finalization" });
    await services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: 0, label: "Changed" });
    await expect(services.finalizeFrameworkVersion(projectId, created.version.id, 0)).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const current = await services.readFrameworkVersion(projectId, created.version.id);
    expect(current.version).toMatchObject({ draftRevision: 1, finalizedAt: null });
    expect(current.sections).toHaveLength(1);
  });

  it("requires a valid expected draft revision and maps stale definition writes to one conflict", async () => {
    const created = await services.createAppraisalFramework(projectId, { name: "Stale mutation mapping" });
    await expect(services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: undefined as unknown as number, label: "Missing token" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const section = await services.addFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: 0, label: "Current section" });
    await expect(services.updateFrameworkSection(projectId, { versionId: created.version.id, expectedDraftRevision: 0, sectionId: section.id, label: "Stale edit" })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const current = await services.readFrameworkVersion(projectId, created.version.id);
    expect(current.version.draftRevision).toBe(1);
    expect(current.sections).toMatchObject([{ id: section.id, label: "Current section" }]);
  });

  it("keeps every project-scoped downstream row unchanged across the complete appraisal lifecycle", async () => {
    const paper = await services.addPaper(projectId, { title: "Downstream snapshot study", authors: ["Researcher"], publicationYear: 2024 });
    const source = (await services.listSearchSources(projectId))[0];
    const strategy = await services.createSearchStrategy(projectId, { searchSourceId: source.id, name: "Snapshot search", queryText: "study methods" });
    const run = await services.createSearchRun(projectId, {
      searchSourceId: source.id,
      sourceKeySnapshot: source.sourceKey,
      sourceDisplayNameSnapshot: source.displayName,
      strategyId: strategy.id,
      queryText: strategy.queryText,
      reportedResultCount: 2,
      executedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const retrievedOne = await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: source.id, sourceRecordId: "snapshot-a", title: "Downstream snapshot study", retrievedAt: new Date("2026-01-01T00:00:00Z") });
    const retrievedTwo = await services.createRetrievedRecord(projectId, { searchRunId: run.id, searchSourceId: source.id, sourceRecordId: "snapshot-b", title: "Related but distinct study", retrievedAt: new Date("2026-01-01T00:00:00Z") });
    await services.linkRetrievedRecordToPaper(projectId, retrievedOne.id, paper.id);
    await services.decideDifferentWork(projectId, retrievedOne.id, retrievedTwo.id, "Separate publications");
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date("2026-01-02T00:00:00Z") });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });

    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "The study reports 42 participants and an appropriate design.", pageNumber: 3, note: "Snapshot fixture" });
    await services.appendEvidenceReviewDecision(projectId, evidence.id, { decision: "accepted", note: "Checked before appraisal" });
    await services.appendEvidenceAnnotation(projectId, evidence.id, { body: "Retain this annotation through appraisal." });
    const label = await services.createEvidenceLabel(projectId, { name: "Snapshot label" });
    await services.assignEvidenceLabel(projectId, evidence.id, label.id);
    const evidenceSet = (await services.createEvidenceSet(projectId, { name: "Snapshot Evidence Set" })).set;
    await services.addEvidenceToSet(projectId, evidenceSet.id, { evidenceId: evidence.id });

    const field = await services.createExtractionField(projectId, { name: "Participants", fieldType: "number", required: true });
    const extraction = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: 42, evidenceIds: [evidence.id] });

    const documentId = crypto.randomUUID();
    const documentTextExtractionId = crypto.randomUUID();
    const pageId = crypto.randomUUID();
    const text = "The report includes 42 participants. The study design is appropriate.";
    const bytes = Buffer.from("%PDF-1.7\nsynthetic appraisal snapshot fixture");
    const documentHash = createHash("sha256").update(bytes).digest("hex");
    await client.unsafe(
      "insert into full_text_documents (id,project_id,paper_id,storage_key,original_filename,media_type,byte_size,sha256,storage_state,staged_storage_key) values ($1::uuid,$2::uuid,$3::uuid,$4,'snapshot.pdf','application/pdf',$5,$6,'ready',null)",
      [documentId, projectId, paper.id, `projects/${projectId}/papers/${paper.id}/documents/${documentId}/source.pdf`, bytes.byteLength, documentHash],
    );
    await client.begin(async (tx) => {
      await tx.unsafe(
        "insert into document_text_extractions (id,project_id,paper_id,full_text_document_id,extractor_key,extractor_version,algorithm_version,status,page_count,character_count,started_at,completed_at) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'fixture','1','1','succeeded',1,$5,now(),now())",
        [documentTextExtractionId, projectId, paper.id, documentId, Array.from(text).length],
      );
      await tx.unsafe(
        "insert into document_text_extraction_pages (id,project_id,paper_id,document_text_extraction_id,page_number,status,text,character_count) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,'succeeded',$5,$6)",
        [pageId, projectId, paper.id, documentTextExtractionId, text, Array.from(text).length],
      );
    });
    const aiExtraction = createAiExtractionSuggestionServices(db, {
      async suggest() {
        return {
          kind: "success",
          suggestion: { outcome: "candidate", state: "present", value: "42", explanation: "The count appears in the source text.", groundings: [{ pageId, quote: "42 participants" }] },
          metadata: { provider: "fake", configuredModel: "fixture-model", returnedModel: "fixture-model", responseId: "fixture-response", inputTokens: 10, outputTokens: 10, totalTokens: 20, durationMs: 1 },
        };
      },
    }, { defaultModel: "fixture-model", defaultReasoningEffort: "low" });
    const aiExtractionRequest = await aiExtraction.beginAiExtractionSuggestion({
      projectId,
      paperId: paper.id,
      fieldId: field.id,
      fullTextDocumentId: documentId,
      documentTextExtractionId,
      idempotencyKey: crypto.randomUUID(),
      externalTransmissionAcknowledged: true,
      disclosureVersion: "test-fixture",
    });
    await aiExtraction.executeAiExtractionSuggestion(String(aiExtractionRequest.requestId));
    await aiExtraction.rejectAiExtractionSuggestion(projectId, String(aiExtractionRequest.requestId));

    const evidenceSetPreparation = await services.createSynthesisPreparation(projectId, { evidenceSetId: evidenceSet.id, extractionFieldId: field.id, workingTitle: "Snapshot preparation" });
    await services.replaceSynthesisPreparationSelections(projectId, evidenceSetPreparation.id, { extractionRevisionIds: [extraction.id] });
    const synthesis = await services.createSynthesisStatement(projectId, { statementText: "The study reports 42 participants.", extractionRevisionIds: [extraction.id] });
    await services.appendSynthesisInterpretation(projectId, synthesis.statement.id, synthesis.revision.id, {
      convergenceState: "mixed",
      summary: "A researcher-authored interpretation for the baseline snapshot.",
      limitations: [{ category: "reporting", body: "Single-study snapshot fixture." }],
      questions: [{ body: "Would another study report the same outcome?" }],
    });
    const aiSynthesis = createAiSynthesisSuggestionServices(db, {
      async suggest(input) {
        const support = input.supports[0];
        const sourceEvidence = support.connectingEvidence[0];
        return {
          kind: "success",
          suggestion: {
            outcome: "candidate",
            title: "Fixture synthesis candidate",
            statementText: "A fixture synthesis candidate remains a proposal.",
            explanation: "The source is included only to seed canonical proposal state.",
            groundings: [{ supportId: support.id, evidenceId: String(sourceEvidence.evidenceId ?? sourceEvidence.id), quote: String(sourceEvidence.text ?? sourceEvidence.sourceText) }],
          },
          metadata: { provider: "fake", configuredModel: "fixture-model", returnedModel: "fixture-model", responseId: "fixture-synthesis-response", inputTokens: 10, outputTokens: 10, totalTokens: 20, durationMs: 1 },
        };
      },
    }, { defaultModel: "fixture-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const aiSynthesisRequest = await aiSynthesis.beginAiSynthesisSuggestion({
      projectId,
      preparationId: evidenceSetPreparation.id,
      idempotencyKey: crypto.randomUUID(),
      externalTransmissionAcknowledged: true,
      disclosureVersion: "test-fixture",
    });
    await aiSynthesis.executeAiSynthesisSuggestion(String(aiSynthesisRequest.requestId), projectId);
    await aiSynthesis.rejectAiSynthesisSuggestion(projectId, String(aiSynthesisRequest.requestId));

    const claim = await services.createClaim(projectId, { claimText: "The study reports 42 participants." });
    const claimRevision = await services.createClaimRevision(projectId, claim.id, {
      claimText: claim.claimText,
      supports: [
        { kind: "evidence", evidenceId: evidence.id },
        { kind: "extractionRevision", extractionRevisionId: extraction.id },
        { kind: "synthesisRevision", synthesisRevisionId: synthesis.revision.id },
      ],
      expectedCurrentRevisionId: claim.revision.id,
    });
    const question = await services.createResearchQuestion(projectId, { identifier: "RQ1", label: "What participant count was reported?" });
    await services.linkClaim({ projectId, questionId: question.id, claimId: claim.id });
    await services.linkExtractionField({ projectId, questionId: question.id, fieldId: field.id });
    await services.linkEvidenceSet({ projectId, questionId: question.id, evidenceSetId: evidenceSet.id });
    await services.linkSynthesisStatement({ projectId, questionId: question.id, statementId: synthesis.statement.id });
    await services.appendResearchQuestionAnswer(projectId, question.id, {
      answerText: "The included study reported 42 participants.",
      claimRevisionIds: [claimRevision.revision.id],
      synthesisRevisionIds: [synthesis.revision.id],
    });

    const manuscript = await services.getOrCreateDefaultManuscript(projectId);
    const section = await services.createSection(projectId, manuscript.id, { title: "Results", sectionType: "results" });
    await services.placeClaimRevision(projectId, manuscript.id, section.id, claimRevision.revision.id);
    const prose = await services.createProseBlock(projectId, manuscript.id, section.id, "Researcher-authored narrative for the baseline snapshot.");
    await services.openManuscriptReviewThread(projectId, manuscript.id, { sectionItemId: prose.id, title: "Snapshot review", initialComment: "Preserve this manuscript review event." });
    await services.createManuscriptSnapshot(projectId, manuscript.id);

    const before = await snapshotProjectState(projectId);
    for (const table of [
      "projects", "screening_decisions", "full_text_screening_decisions", "full_text_retrieval_attempts", "evidence",
      "evidence_review_decisions", "evidence_annotations", "evidence_label_events", "evidence_set_memberships",
      "evidence_set_composition_revisions", "extraction_values", "extraction_value_revisions", "extraction_revision_evidence",
      "ai_extraction_requests", "ai_extraction_results", "ai_extraction_result_groundings", "ai_extraction_decisions",
      "synthesis_preparations", "synthesis_preparation_selections", "synthesis_statements", "synthesis_revisions",
      "synthesis_revision_supports", "synthesis_interpretations", "ai_synthesis_requests", "ai_synthesis_results",
      "ai_synthesis_result_groundings", "ai_synthesis_decisions", "claims", "claim_revisions",
      "claim_revision_evidence_supports", "claim_revision_extraction_supports", "claim_revision_synthesis_supports",
      "research_questions", "research_question_answers", "research_question_answer_claim_contexts",
      "research_question_answer_synthesis_contexts", "research_question_claim_events", "research_question_evidence_set_events",
      "research_question_extraction_field_events", "research_question_synthesis_statement_events", "manuscripts",
      "manuscript_sections", "manuscript_claim_placements", "manuscript_prose_blocks", "manuscript_prose_revisions",
      "manuscript_review_threads", "manuscript_review_events", "manuscript_snapshots", "manuscript_snapshot_sections",
      "manuscript_snapshot_items", "manuscript_snapshot_prose_items", "manuscript_snapshot_claim_items",
      "manuscript_snapshot_bibliography_entries", "search_strategies", "search_runs", "retrieved_records",
      "retrieved_record_matches", "retrieved_record_deduplication_decisions",
    ]) expect(before[table]?.count, `${table} must contain baseline state`).toBeGreaterThan(0);

    const appraisalSchemaTables = await client.unsafe(
      "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name ilike '%appraisal%' order by table_name",
    ) as Array<{ table_name: string }>;
    expect(appraisalSchemaTables.map((row) => row.table_name)).toEqual([...allowedAppraisalTables].sort());
    const downstreamAppraisalColumns = await client.unsafe(
      "select table_name, column_name from information_schema.columns where table_schema='public' and table_name <> all($1::text[]) and column_name ilike '%appraisal%' order by table_name, column_name",
      [allowedAppraisalTables],
    );
    expect(downstreamAppraisalColumns).toEqual([]);
    const downstreamAppraisalForeignKeys = await client.unsafe(`
      select tc.table_name, kcu.column_name, ccu.table_name as referenced_table
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_catalog=tc.constraint_catalog
       and kcu.constraint_schema=tc.constraint_schema
       and kcu.constraint_name=tc.constraint_name
       and kcu.table_name=tc.table_name
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_catalog=tc.constraint_catalog
       and ccu.constraint_schema=tc.constraint_schema
       and ccu.constraint_name=tc.constraint_name
      where tc.table_schema='public' and tc.constraint_type='FOREIGN KEY'
        and tc.table_name <> all($1::text[]) and ccu.table_name = any($1::text[])
      order by tc.table_name, kcu.column_name
    `, [allowedAppraisalTables]);
    expect(downstreamAppraisalForeignKeys).toEqual([]);

    const framework = await finalizedFramework("Snapshot custom framework");
    const incomplete = await services.saveAppraisalRevision(projectId, {
      paperId: paper.id,
      frameworkId: framework.framework.id,
      frameworkVersionId: framework.version.id,
      expectedCurrentRevisionId: null,
      responses: [{ itemId: framework.item.id, selectedOptionId: null, rationale: "The required response remains unanswered.", evidenceIds: [evidence.id] }],
    });
    const complete = await services.saveAppraisalRevision(projectId, {
      paperId: paper.id,
      frameworkId: framework.framework.id,
      frameworkVersionId: framework.version.id,
      expectedCurrentRevisionId: incomplete.id,
      overallJudgementOptionId: framework.overall.id,
      overallRationale: "Researcher-authored overall rationale.",
      responses: [{ itemId: framework.item.id, selectedOptionId: framework.option.id, rationale: "The design is appropriate.", evidenceIds: [evidence.id] }],
    });
    const draftV2 = await services.createNewFrameworkVersion(projectId, framework.framework.id, { versionLabel: "2" });
    const versionV2 = await services.finalizeFrameworkVersion(projectId, draftV2.version.id, draftV2.version.draftRevision);
    await services.saveAppraisalRevision(projectId, {
      paperId: paper.id,
      frameworkId: framework.framework.id,
      frameworkVersionId: versionV2.version.id,
      expectedCurrentRevisionId: complete.id,
      overallJudgementOptionId: versionV2.overallOptions[0].id,
      responses: [{ itemId: versionV2.items[0].id, selectedOptionId: versionV2.items[0].options[0].id, rationale: "Explicit reassessment against version 2.", evidenceIds: [evidence.id] }],
    });
    await services.archiveAppraisalFramework(projectId, framework.framework.id);

    const after = await snapshotProjectState(projectId);
    const changedTables = Object.keys(before).filter((table) => before[table].count !== after[table].count || before[table].sha256 !== after[table].sha256).sort();
    expect(changedTables).toEqual([...allowedAppraisalTables].sort());
    for (const table of Object.keys(before)) {
      if (allowedAppraisalTables.includes(table)) continue;
      expect(after[table].count, `${table} row count changed during appraisal`).toBe(before[table].count);
      expect(after[table].sha256, `${table} canonical content changed during appraisal`).toBe(before[table].sha256);
    }
    expect(after.projects.sha256, "appraisal must not change the Project activity timestamp").toBe(before.projects.sha256);
  });
});
