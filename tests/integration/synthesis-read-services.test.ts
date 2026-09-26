import "dotenv/config";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createSynthesisReadServices } from "@/application/synthesis-read-services";
import { extractionFields, extractionValueRevisions, extractionValues, schema, synthesisStatements } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice40_synthesis_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 40 Synthesis comparison read model", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let countedClient: postgres.Sql | undefined;
  let db: ReturnType<typeof createDb>["db"] | undefined;
  let services: ReturnType<typeof createReviewServices> | undefined;
  let reads: ReturnType<typeof createSynthesisReadServices> | undefined;
  const queryLog: string[] = [];

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    const created = createDb(databaseUrl.toString());
    appClient = created.client;
    db = created.db;
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    services = createReviewServices(created.db);

    countedClient = postgres(databaseUrl.toString(), { max: 1, prepare: false });
    const countedDb = drizzle(countedClient, {
      schema,
      logger: { logQuery(query) { queryLog.push(query); } },
    });
    reads = createSynthesisReadServices(countedDb);
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

function selectCount() {
  return queryLog.filter((query) => /^\s*(with|select)\b/i.test(query)).length;
}

function instrumentAfterFirstSelect(base: Database, afterFirstSelect: () => Promise<void>): Database {
  let selectNumber = 0;
  const wrap = (target: unknown) => new Proxy(target as object, {
    get(value, property) {
      if (property === "execute") {
        const execute = Reflect.get(value, property, value) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(execute, value, args);
          selectNumber += 1;
          if (selectNumber === 1) await afterFirstSelect();
          return result;
        };
      }
      const member = Reflect.get(value, property, value);
      return typeof member === "function" ? member.bind(value) : member;
    },
  });
  return new Proxy(base as object, {
    get(value, property) {
      if (property === "transaction") {
        const transaction = Reflect.get(value, property, value) as (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
        return (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => transaction.call(value, (tx) => callback(wrap(tx)), options);
      }
      const member = Reflect.get(value, property, value);
      return typeof member === "function" ? member.bind(value) : member;
    },
  }) as Database;
}

  it("matches the legacy matrix and summary across typed, archived-option, historical, and review states", async () => {
    const project = await services!.createProject({ title: `Matrix equivalence ${randomUUID()}` });
    await includedPaper(project.id, "Paper A — no extraction");
    const paperB = await includedPaper(project.id, "Paper B — current text");
    const paperC = await includedPaper(project.id, "Paper C — not reported");
    const paperD = await includedPaper(project.id, "Paper D — not applicable");
    const paperE = await includedPaper(project.id, "Paper E — cleared");
    const fullTextExcluded = await includedPaper(project.id, "Paper F — full-text excluded");
    const titleAbstractExcluded = await services!.addPaper(project.id, { title: "Paper G — title abstract excluded" });
    await services!.recordScreeningDecision(project.id, titleAbstractExcluded.id, { decision: "include" });
    await services!.recordScreeningDecision(project.id, titleAbstractExcluded.id, { decision: "exclude", exclusionCriterionId: (await services!.createScreeningCriterion(project.id, { type: "exclusion", text: "Out of scope" })).id });
    await services!.recordFullTextRetrievalAttempt(project.id, fullTextExcluded.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services!.recordFullTextScreeningDecision(project.id, fullTextExcluded.id, { decision: "exclude", exclusionCriterionId: (await services!.createFullTextScreeningCriterion(project.id, { text: "Full text out of scope" })).id });

    const textField = await services!.createExtractionField(project.id, { name: "Finding", fieldType: "short_text" });
    const numericField = await services!.createExtractionField(project.id, { name: "Effect", fieldType: "number" });
    const booleanField = await services!.createExtractionField(project.id, { name: "Reported", fieldType: "boolean" });
    const selectField = await services!.createExtractionField(project.id, { name: "Method", fieldType: "single_select" });
    const archivedOption = await services!.createExtractionOption(project.id, { fieldId: selectField.id, label: "Archived method label" });
    const firstEvidence = await services!.recordEvidence(project.id, { paperId: paperB.id, sourceText: "First supporting passage", pageNumber: 2 });
    const secondEvidence = await services!.recordEvidence(project.id, { paperId: paperB.id, sourceText: "Second supporting passage", pageNumber: 8 });
    const oldText = await services!.reviseExtractionValue(project.id, paperB.id, textField.id, { value: "Old finding", evidenceIds: [firstEvidence.id] });
    const currentText = await services!.reviseExtractionValue(project.id, paperB.id, textField.id, { value: "Current finding", evidenceIds: [firstEvidence.id, secondEvidence.id] });
    await services!.reviseExtractionValue(project.id, paperC.id, textField.id, { state: "not_reported" });
    await services!.reviseExtractionValue(project.id, paperD.id, textField.id, { state: "not_applicable" });
    await services!.reviseExtractionValue(project.id, paperE.id, textField.id, { value: "To be cleared" });
    await services!.clearExtractionValue(project.id, paperE.id, textField.id);
    await services!.reviseExtractionValue(project.id, paperB.id, numericField.id, { value: "12.75" });
    await services!.reviseExtractionValue(project.id, paperB.id, booleanField.id, { value: true });
    await services!.reviseExtractionValue(project.id, paperC.id, booleanField.id, { value: false });
    await services!.reviseExtractionValue(project.id, paperB.id, selectField.id, { value: archivedOption.id });
    await services!.archiveExtractionOption(project.id, archivedOption.id);

    expect(oldText.id).not.toBe(currentText.id);
    const matrixCases = [textField, numericField, booleanField, selectField];
    for (const field of matrixCases) {
      const legacy = await services!.listExtractionComparison(project.id, field.id);
      const legacySummary = await services!.getExtractionFieldSummary(project.id, field.id);
      const modern = await reads!.getSynthesisComparisonPage(project.id, field.id, { page: 1, pageSize: 100 });
      expect(modern.pagination.totalCount).toBe(legacy.length);
      expect(modern.items.map((item) => item.paper.id)).toEqual(legacy.map((item) => item.paper.id));
      expect(modern.items.map((item) => item.paper.id)).toEqual([...modern.items]
        .sort((left, right) => left.paper.createdAt.getTime() - right.paper.createdAt.getTime() || left.paper.id.localeCompare(right.paper.id))
        .map((item) => item.paper.id));
      for (let index = 0; index < legacy.length; index += 1) {
        const previous = legacy[index];
        const current = modern.items[index];
        expect(current.field).toMatchObject({ id: previous.field.id, name: previous.field.name, fieldType: previous.field.fieldType, required: previous.field.required, sortOrder: previous.field.sortOrder });
        expect(current.paper).toMatchObject({ id: previous.paper.id, projectId: previous.paper.projectId, title: previous.paper.title });
        expect(current.extractionRevision?.id ?? null).toBe(previous.extractionRevision?.id ?? null);
        expect(current.extractionRevision?.sequence ?? null).toBe(previous.extractionRevision?.sequence ?? null);
        expect(current.valueState).toBe(previous.valueState);
        expect(current.displayValue).toBe(previous.displayValue == null ? null : String(previous.displayValue));
        expect(current.evidenceCount).toBe(previous.extractionRevision?.evidence.length ?? 0);
        expect(current.supportStatus).toBe(previous.supportStatus);
        expect(current.isSelectable).toBe(previous.isSelectable);
      }
      const expectedCounts = {
        not_extracted: legacySummary.counts.not_extracted ?? 0,
        present: legacySummary.counts.present ?? 0,
        not_reported: legacySummary.counts.not_reported ?? 0,
        not_applicable: legacySummary.counts.not_applicable ?? 0,
        cleared: legacySummary.counts.cleared ?? 0,
      };
      expect(modern.summary).toEqual({ totalIncludedPapers: legacySummary.totalIncludedPapers, counts: expectedCounts });
    }

    const textMatrix = await reads!.getSynthesisComparisonPage(project.id, textField.id, { pageSize: 100 });
    expect(textMatrix.items.find((item) => item.paper.id === paperB.id)).toMatchObject({
      extractionRevision: { id: currentText.id, valueState: "present" },
      evidenceCount: 2,
      supportStatus: "grounded",
      isSelectable: true,
    });
    const selectMatrix = await reads!.getSynthesisComparisonPage(project.id, selectField.id, { pageSize: 100 });
    expect(selectMatrix.items.find((item) => item.paper.id === paperB.id)?.displayValue).toBe("Archived method label");
    const booleanMatrix = await reads!.getSynthesisComparisonPage(project.id, booleanField.id, { pageSize: 100 });
    expect(booleanMatrix.items.find((item) => item.paper.id === paperB.id)?.displayValue).toBe("true");
    expect(booleanMatrix.items.find((item) => item.paper.id === paperC.id)?.displayValue).toBe("false");
    expect(JSON.stringify(textMatrix)).not.toContain("First supporting passage");
    await services!.archiveExtractionField(project.id, textField.id);
    await expect(reads!.getSynthesisComparisonPage(project.id, textField.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });

  it("keeps pagination stable, clamps invalid pages, and issues two SELECTs at every page size", async () => {
    const project = await services!.createProject({ title: `Matrix pages ${randomUUID()}` });
    const field = await services!.createExtractionField(project.id, { name: "Value", fieldType: "short_text" });
    for (let index = 0; index < 51; index += 1) await includedPaper(project.id, `Page paper ${String(index).padStart(3, "0")}`);
    await countedClient!.unsafe("select 1");
    for (const pageSize of [1, 25, 50, 100]) {
      queryLog.length = 0;
      const result = await reads!.getSynthesisComparisonPage(project.id, field.id, { page: 1, pageSize });
      expect(result.items).toHaveLength(Math.min(pageSize, 51));
      expect(result.pagination).toMatchObject({ page: 1, pageSize, totalCount: 51, totalPages: Math.ceil(51 / pageSize), from: 1, to: Math.min(pageSize, 51) });
      expect(selectCount()).toBe(2);
    }

    const invalid = await reads!.getSynthesisComparisonPage(project.id, field.id, { page: "nonsense", pageSize: 1000 });
    expect(invalid.pagination).toMatchObject({ page: 1, pageSize: 100, totalCount: 51, totalPages: 1 });
    const last = await reads!.getSynthesisComparisonPage(project.id, field.id, { page: 99, pageSize: 25 });
    expect(last.pagination).toMatchObject({ page: 3, pageSize: 25, totalCount: 51, totalPages: 3, from: 51, to: 51 });
    const emptyProject = await services!.createProject({ title: `Empty matrix ${randomUUID()}` });
    const emptyField = await services!.createExtractionField(emptyProject.id, { name: "Empty", fieldType: "short_text" });
    const empty = await reads!.getSynthesisComparisonPage(emptyProject.id, emptyField.id, { page: 8, pageSize: 25 });
    expect(empty.pagination).toEqual({ page: 1, pageSize: 25, totalCount: 0, totalPages: 0, from: 0, to: 0 });
    expect(empty.items).toEqual([]);
    expect(empty.summary.counts).toEqual({ not_extracted: 0, present: 0, not_reported: 0, not_applicable: 0, cleared: 0 });
  });

  it("matches the legacy Synthesis ledger without hydrating support provenance", async () => {
    const project = await services!.createProject({ title: `Ledger equivalence ${randomUUID()}` });
    const paperA = await includedPaper(project.id, "Ledger paper A");
    const paperB = await includedPaper(project.id, "Ledger paper B");
    const fieldA = await services!.createExtractionField(project.id, { name: "Finding A", fieldType: "short_text" });
    const fieldB = await services!.createExtractionField(project.id, { name: "Finding B", fieldType: "number" });
    const revisionA = await services!.reviseExtractionValue(project.id, paperA.id, fieldA.id, { value: "A" });
    const revisionB = await services!.reviseExtractionValue(project.id, paperA.id, fieldB.id, { value: "2" });
    const revisionC = await services!.reviseExtractionValue(project.id, paperB.id, fieldA.id, { value: "C" });
    const supported = await services!.createSynthesisStatement(project.id, {
      statementText: "Three exact observations.",
      extractionRevisionIds: [revisionA.id, revisionB.id, revisionC.id],
    });
    const unsupported = await services!.createSynthesisStatement(project.id, { statementText: "No linked observations." });
    const withdrawn = await services!.createSynthesisStatement(project.id, { statementText: "Will be withdrawn." });
    await services!.withdrawSynthesisStatement(project.id, withdrawn.statement.id);
    const anomalousStatement = await db!.insert(synthesisStatements).values({ projectId: project.id }).returning();
    expect(anomalousStatement).toHaveLength(1);

    const legacy = await services!.listProjectSynthesis(project.id);
    const modern = await reads!.getSynthesisLedgerPage(project.id, { pageSize: 100 });
    expect(modern.pagination.totalCount).toBe(legacy.length);
    expect(modern.items.map((item) => item.synthesisStatementId)).toEqual(legacy.map((item) => item.synthesisStatementId));
    expect(modern.items.map((item) => item.synthesisStatementId)).not.toContain(anomalousStatement[0].id);
    for (let index = 0; index < legacy.length; index += 1) {
      const old = legacy[index];
      const current = modern.items[index];
      expect(current).toMatchObject({
        projectId: old.projectId,
        synthesisStatementId: old.synthesisStatementId,
        id: old.id,
        sequence: old.sequence,
        state: old.state,
        title: old.title,
        statementText: old.statementText,
        researcherNote: old.researcherNote,
        supportStatus: old.supportStatus,
        supportingRevisionCount: old.supportingRevisionCount,
        supportingPaperCount: old.supportingPaperCount,
        supportingFieldCount: old.supportingFieldCount,
      });
      expect(current.createdAt.getTime()).toBe(new Date(old.createdAt).getTime());
      if (old.finalizedAt == null) expect(current.finalizedAt).toEqual(expect.any(Date));
      else expect(current.finalizedAt.getTime()).toBe(new Date(old.finalizedAt).getTime());
      expect(current.statementCreatedAt.getTime()).toBe(new Date(old.statement.createdAt).getTime());
    }
    expect(modern.items.find((item) => item.synthesisStatementId === supported.statement.id)).toMatchObject({
      supportingRevisionCount: 3,
      supportingPaperCount: 2,
      supportingFieldCount: 2,
      supportStatus: "supported",
    });
    expect(modern.items.find((item) => item.synthesisStatementId === unsupported.statement.id)).toMatchObject({ supportStatus: "unsupported", supportingRevisionCount: 0 });
    expect(modern.items.find((item) => item.synthesisStatementId === withdrawn.statement.id)).toMatchObject({ state: "withdrawn", supportStatus: "unsupported", supportingRevisionCount: 0 });
    expect(JSON.stringify(modern)).not.toContain("paperTitle");
    expect(JSON.stringify(modern)).not.toContain("evidence");

    for (const pageSize of [1, 50, 100]) {
      queryLog.length = 0;
      const page = await reads!.getSynthesisLedgerPage(project.id, { page: 1, pageSize });
      expect(page.items).toHaveLength(Math.min(pageSize, legacy.length));
      expect(selectCount()).toBe(2);
    }
    const last = await reads!.getSynthesisLedgerPage(project.id, { page: 99, pageSize: 1 });
    expect(last.pagination).toMatchObject({ page: legacy.length, totalCount: legacy.length, totalPages: legacy.length });
  });

  it("preserves exact ordered history support summaries and bulk preparation context", async () => {
    const project = await services!.createProject({ title: `History equivalence ${randomUUID()}` });
    const paper = await includedPaper(project.id, "History paper");
    const evidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "History support passage", pageNumber: 4 });
    const field = await services!.createExtractionField(project.id, { name: "Method", fieldType: "single_select" });
    const archivedOption = await services!.createExtractionOption(project.id, { fieldId: field.id, label: "Archived option label" });
    const replacementOption = await services!.createExtractionOption(project.id, { fieldId: field.id, label: "Current option label" });
    const exactSupport = await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: archivedOption.id, evidenceIds: [evidence.id] });
    const set = (await services!.createEvidenceSet(project.id, { name: "History evidence set" })).set;
    await services!.addEvidenceToSet(project.id, set.id, { evidenceId: evidence.id });
    const preparation = await services!.createSynthesisPreparation(project.id, { evidenceSetId: set.id, extractionFieldId: field.id });
    await services!.replaceSynthesisPreparationSelections(project.id, preparation.id, { extractionRevisionIds: [exactSupport.id] });
    const prepared = await services!.finalizeSynthesisPreparation(project.id, preparation.id, { statementText: "Prepared synthesis statement." });
    await services!.archiveExtractionOption(project.id, archivedOption.id);
    await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: replacementOption.id, evidenceIds: [evidence.id] });
    await services!.reviseSynthesisStatement(project.id, prepared.statement.id, {
      statementText: "Direct revision keeps the exact historical support.",
      extractionRevisionIds: [exactSupport.id],
    });

    queryLog.length = 0;
    const modern = await reads!.getSynthesisHistorySummaries(project.id, prepared.statement.id);
    expect(selectCount()).toBe(2);
    const legacy = await services!.getSynthesisHistory(project.id, prepared.statement.id);
    expect(modern.map((revision) => revision.id)).toEqual(legacy.map((revision) => revision.id));
    for (let index = 0; index < legacy.length; index += 1) {
      const old = legacy[index];
      const current = modern[index];
      expect(current).toMatchObject({
        id: old.id,
        sequence: old.sequence,
        state: old.state,
        title: old.title,
        statementText: old.statementText,
        researcherNote: old.researcherNote,
        supportStatus: old.supportStatus,
        supportingRevisionCount: old.supportingRevisionCount,
        supportingPaperCount: old.supportingPaperCount,
        supportingFieldCount: old.supportingFieldCount,
      });
      expect(current.createdAt.getTime()).toBe(new Date(old.createdAt).getTime());
      if (old.finalizedAt == null) expect(current.finalizedAt).toEqual(expect.any(Date));
      else expect(current.finalizedAt.getTime()).toBe(new Date(old.finalizedAt).getTime());
      expect(current.supports.map((support) => support.extractionRevisionId)).toEqual(old.supports.map((support) => support.extractionRevisionId));
      expect(current.supports.map((support) => support.extractionRevisionSequence)).toEqual(old.supports.map((support) => support.extractionRevision.sequence));
      expect(current.supports.map((support) => [support.paperId, support.paperTitle, support.fieldId, support.fieldName, support.valueState]))
        .toEqual(old.supports.map((support) => [support.paper.id, support.paper.title, support.field.id, support.field.name, support.extractionRevision.valueState]));
    }
    expect(modern[0].supports[0]).toMatchObject({
      extractionRevisionId: exactSupport.id,
      optionId: archivedOption.id,
      optionLabel: "Archived option label",
      displayValue: "Archived option label",
      isCurrentExtractionRevision: false,
    });
    expect(modern[1].supports[0]).toMatchObject({ extractionRevisionId: exactSupport.id, isCurrentExtractionRevision: false });
    expect(JSON.stringify(modern)).not.toContain("History support passage");

    const contexts = await reads!.getSynthesisPreparationContextsForRevisions(project.id, modern.map((revision) => revision.id));
    expect(contexts).toHaveLength(1);
    const legacyContext = await services!.getSynthesisPreparationContextForRevision(project.id, prepared.revision.id);
    expect(contexts[0]).toMatchObject({
      synthesisRevisionId: prepared.revision.id,
      preparationId: preparation.id,
      evidenceSetId: set.id,
      evidenceSetName: "History evidence set",
      pinnedCompositionRevisionId: legacyContext!.pinnedCompositionRevisionId,
      pinnedCompositionSequence: legacyContext!.pinnedCompositionSequence,
    });
    expect(contexts[0].evidenceSetArchivedAt).toBeNull();
    const noContext = await reads!.getSynthesisPreparationContextsForRevisions(project.id, [legacy[1].id]);
    expect(noContext).toEqual([]);
    expect(await reads!.getSynthesisPreparationContextsForRevisions(project.id, [])).toEqual([]);
  });

  it("aligns edit carry-forward with canonical final inclusion and hides invalid replacements", async () => {
    const project = await services!.createProject({ title: `Edit eligibility ${randomUUID()}` });
    const activePaper = await includedPaper(project.id, "Edit paper active");
    const clearPaper = await includedPaper(project.id, "Edit paper cleared replacement");
    const archivedPaper = await includedPaper(project.id, "Edit paper archived field");
    const excludedPaper = await includedPaper(project.id, "Edit paper full text excluded");
    const activeField = await services!.createExtractionField(project.id, { name: "Active field", fieldType: "short_text" });
    const clearField = await services!.createExtractionField(project.id, { name: "Cleared field", fieldType: "short_text" });
    const archivedField = await services!.createExtractionField(project.id, { name: "Archived field", fieldType: "short_text" });
    const activeExact = await services!.reviseExtractionValue(project.id, activePaper.id, activeField.id, { value: "Exact active value" });
    const clearExact = await services!.reviseExtractionValue(project.id, clearPaper.id, clearField.id, { value: "Exact clear value" });
    const archivedExact = await services!.reviseExtractionValue(project.id, archivedPaper.id, archivedField.id, { value: "Exact archived value" });
    const excludedExact = await services!.reviseExtractionValue(project.id, excludedPaper.id, activeField.id, { value: "Exact excluded value" });
    const created = await services!.createSynthesisStatement(project.id, {
      statementText: "Exact supports remain visible after current-state changes.",
      extractionRevisionIds: [activeExact.id, clearExact.id, archivedExact.id, excludedExact.id],
    });
    const activeReplacement = await services!.reviseExtractionValue(project.id, activePaper.id, activeField.id, { value: "New active replacement" });
    await services!.reviseExtractionValue(project.id, clearPaper.id, clearField.id, { value: "Value before clear" });
    await services!.clearExtractionValue(project.id, clearPaper.id, clearField.id);
    await services!.reviseExtractionValue(project.id, archivedPaper.id, archivedField.id, { value: "New archived-field extraction" });
    await services!.archiveExtractionField(project.id, archivedField.id);
    const fullTextCriterion = await services!.createFullTextScreeningCriterion(project.id, { text: "Excluded after Synthesis snapshot" });
    await services!.recordFullTextScreeningDecision(project.id, excludedPaper.id, { decision: "exclude", exclusionCriterionId: fullTextCriterion.id });

    const current = await services!.getCurrentSynthesis(project.id, created.statement.id);
    expect(current!.supports.map((support) => support.extractionRevisionId)).toEqual([...current!.supports]
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.extractionRevisionId.localeCompare(right.extractionRevisionId))
      .map((support) => support.extractionRevisionId));
    const targets = current!.supports.map((support) => ({
      paperId: support.paper.id,
      fieldId: support.field.id,
      extractionRevisionId: support.extractionRevisionId,
    }));
    queryLog.length = 0;
    const contexts = await reads!.getSynthesisRevisionEditContext(project.id, targets);
    expect(selectCount()).toBe(1);
    const byRevisionId = new Map(contexts.map((context) => [context.extractionRevisionId, context]));
    expect(contexts.map((context) => context.extractionRevisionId)).toEqual(targets.map((target) => target.extractionRevisionId));
    expect(byRevisionId.get(activeExact.id)).toMatchObject({
      finalEligibility: "included",
      carryForwardEligible: true,
      fieldArchived: false,
      latestExtractionRevision: { id: activeReplacement.id, valueState: "present" },
      replacementEligible: true,
    });
    expect(byRevisionId.get(clearExact.id)).toMatchObject({
      finalEligibility: "included",
      carryForwardEligible: true,
      latestExtractionRevision: { valueState: "cleared" },
      replacementEligible: false,
    });
    expect(byRevisionId.get(archivedExact.id)).toMatchObject({
      finalEligibility: "included",
      carryForwardEligible: true,
      fieldArchived: true,
      replacementEligible: false,
    });
    expect(byRevisionId.get(excludedExact.id)).toMatchObject({
      finalEligibility: "excluded",
      carryForwardEligible: false,
      replacementEligible: false,
    });
    expect(current!.supports.find((support) => support.extractionRevisionId === archivedExact.id)?.field.archivedAt).not.toBeNull();

    const carriedArchived = await services!.reviseSynthesisStatement(project.id, created.statement.id, {
      statementText: "Archived-field support may be carried by exact ID.",
      extractionRevisionIds: [archivedExact.id],
    });
    expect(carriedArchived.revision.sequence).toBeGreaterThan(created.revision.sequence);
  });

  it("keeps edit-context SELECT count constant from 1 to 100 exact targets", async () => {
    const project = await services!.createProject({ title: `Edit context scaling ${randomUUID()}` });
    const paper = await includedPaper(project.id, "Edit context count paper");
    const fields = await db!.insert(extractionFields).values(Array.from({ length: 100 }, (_, index) => ({
      projectId: project.id,
      name: `Edit context field ${index}`,
      fieldType: "short_text",
      required: false,
      sortOrder: index,
    }))).returning();
    const slots = await db!.insert(extractionValues).values(fields.map((field) => ({ projectId: project.id, paperId: paper.id, fieldId: field.id }))).returning();
    const slotByField = new Map(slots.map((slot) => [slot.fieldId, slot.id]));
    const revisions = await db!.insert(extractionValueRevisions).values(fields.map((field) => ({
      projectId: project.id,
      paperId: paper.id,
      fieldId: field.id,
      extractionValueId: slotByField.get(field.id)!,
      fieldType: "short_text",
      valueState: "present",
      textValue: `Value ${field.name}`,
      finalizedAt: new Date(),
    }))).returning({ id: extractionValueRevisions.id, fieldId: extractionValueRevisions.fieldId });
    const targetByField = new Map(revisions.map((revision) => [revision.fieldId, revision.id]));

    for (const count of [1, 25, 100]) {
      const targets = fields.slice(0, count).map((field) => ({ paperId: paper.id, fieldId: field.id, extractionRevisionId: targetByField.get(field.id)! }));
      queryLog.length = 0;
      const result = await reads!.getSynthesisRevisionEditContext(project.id, targets);
      expect(result).toHaveLength(count);
      expect(selectCount()).toBe(1);
    }
  });

  it("keeps matrix and ledger count/page pairs in one repeatable-read snapshot", async () => {
    const matrixProject = await services!.createProject({ title: `Matrix snapshot ${randomUUID()}` });
    const matrixPaper = await includedPaper(matrixProject.id, "Matrix snapshot Paper");
    const matrixField = await services!.createExtractionField(matrixProject.id, { name: "Snapshot field", fieldType: "short_text" });
    await services!.reviseExtractionValue(matrixProject.id, matrixPaper.id, matrixField.id, { value: "Included at snapshot start" });
    const fullTextCriterion = await services!.createFullTextScreeningCriterion(matrixProject.id, { text: "Concurrent exclusion" });
    let matrixMutation: Promise<unknown> | undefined;
    const matrixRead = createSynthesisReadServices(instrumentAfterFirstSelect(db!, async () => {
      matrixMutation = services!.recordFullTextScreeningDecision(matrixProject.id, matrixPaper.id, {
        decision: "exclude",
        exclusionCriterionId: fullTextCriterion.id,
      });
      await matrixMutation;
    }));
    const matrix = await matrixRead.getSynthesisComparisonPage(matrixProject.id, matrixField.id, { pageSize: 10 });
    await matrixMutation;
    expect(matrix.summary.totalIncludedPapers).toBe(1);
    expect(matrix.pagination.totalCount).toBe(1);
    expect(matrix.items.map((item) => item.paper.id)).toEqual([matrixPaper.id]);
    expect((await services!.listExtractionComparison(matrixProject.id, matrixField.id))).toEqual([]);

    const ledgerProject = await services!.createProject({ title: `Ledger snapshot ${randomUUID()}` });
    const initialStatement = await services!.createSynthesisStatement(ledgerProject.id, { statementText: "Present at snapshot start." });
    let ledgerMutation: Promise<unknown> | undefined;
    const ledgerRead = createSynthesisReadServices(instrumentAfterFirstSelect(db!, async () => {
      ledgerMutation = services!.createSynthesisStatement(ledgerProject.id, { statementText: "Committed between count and page." });
      await ledgerMutation;
    }));
    const ledger = await ledgerRead.getSynthesisLedgerPage(ledgerProject.id, { pageSize: 10 });
    await ledgerMutation;
    expect(ledger.pagination.totalCount).toBe(1);
    expect(ledger.items.map((item) => item.synthesisStatementId)).toEqual([initialStatement.statement.id]);
    const afterCommit = await reads!.getSynthesisLedgerPage(ledgerProject.id, { pageSize: 10 });
    expect(afterCommit.pagination.totalCount).toBe(2);
  });
});
