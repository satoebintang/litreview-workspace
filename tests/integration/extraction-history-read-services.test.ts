import "dotenv/config";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtractionHistoryReadServices } from "@/application/extraction-history-read-services";
import { createExtractionWorksheetReadServices } from "@/application/extraction-worksheet-read-services";
import { PaperRepository, PaperReviewRepository } from "@/application/repositories";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { evidence, extractionFields, extractionOptions, extractionRevisionEvidence, extractionValueRevisions, extractionValues, schema } from "@/db/schema";
import { decodeExtractionHistoryCursor, encodeExtractionHistoryCursor } from "@/application/extraction-history-cursor";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice53_extract_history_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.hostname = "127.0.0.1";
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 53 Extraction revision history and exact audit", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let countedClient: postgres.Sql | undefined;
  let countedDb: ReturnType<typeof createDb>["db"] | undefined;
  let db: ReturnType<typeof createDb>["db"] | undefined;
  let services: ReturnType<typeof createReviewServices> | undefined;
  let history: ReturnType<typeof createExtractionHistoryReadServices> | undefined;
  let worksheetServices: ReturnType<typeof createExtractionWorksheetReadServices> | undefined;
  const queryLog: string[] = [];

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    const created = createDb(databaseUrl.toString());
    appClient = created.client;
    db = created.db;
    await migrate(created.db, { migrationsFolder: "./drizzle" });
    services = createReviewServices(created.db);

    countedClient = postgres(databaseUrl.toString(), { max: 1, prepare: false });
    countedDb = drizzle(countedClient, {
      schema,
      logger: { logQuery(query) { queryLog.push(query); } },
    });
    history = createExtractionHistoryReadServices(countedDb);
    worksheetServices = createExtractionWorksheetReadServices(countedDb, {
      paperRepo: new PaperRepository(countedDb),
      paperReviewRepo: new PaperReviewRepository(countedDb),
    });
  });

  afterAll(async () => {
    await Promise.all([appClient?.end(), countedClient?.end()]);
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function includedPaper(projectId: string) {
    const paper = await services!.addPaper(projectId, { title: `History paper ${randomUUID()}` });
    await services!.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services!.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services!.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("pages a slot, excludes the sentinel from visible counts, and restores the exact immutable snapshot", async () => {
    const project = await services!.createProject({ title: `Slice 53 history ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const field = await services!.createExtractionField(project.id, { name: "Methods", fieldType: "long_text" });
    const firstEvidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "First exact passage", pageNumber: 7, note: "evidence note" });
    const currentEvidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "Current exact passage", pageNumber: 8 });
    const first = await services!.reviseExtractionValue(project.id, paper.id, field.id, {
      value: "First immutable long value",
      researcherNote: "First immutable note",
      evidenceIds: [firstEvidence.id],
    });
    const current = await services!.reviseExtractionValue(project.id, paper.id, field.id, {
      value: "Current value",
      evidenceIds: [currentEvidence.id],
    });

    queryLog.length = 0;
    const firstPage = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]).toMatchObject({
      id: current.id,
      sequence: String(current.sequence),
      textValuePreview: "Current value",
      supportStatus: "grounded",
      evidenceCount: "1",
      isCurrent: true,
    });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.current).toEqual({ id: current.id, sequence: String(current.sequence) });
    const pageStatement = queryLog.find((query) => /visible_evidence_counts/i.test(query));
    expect(pageStatement).toContain("join visible_page visible on visible.id=link.revision_id");
    expect(pageStatement).not.toContain("join page_keys visible on visible.id=link.revision_id");
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(queryLog.filter((query) => /^\s*set local statement_timeout\b/i.test(query))).toHaveLength(1);

    queryLog.length = 0;
    const finalPage = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, {
      pageSize: 1,
      cursor: firstPage.nextCursor,
    });
    expect(finalPage.items).toHaveLength(1);
    expect(finalPage.items[0]).toMatchObject({ id: first.id, evidenceCount: "1", isCurrent: false });
    expect(finalPage.hasMore).toBe(false);
    expect(finalPage.nextCursor).toBeNull();
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(queryLog.filter((query) => /^\s*set local statement_timeout\b/i.test(query))).toHaveLength(1);

    queryLog.length = 0;
    const routeBoundPage = await countedDb!.transaction(
      (tx) => history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 1 }, tx),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    expect(routeBoundPage.items[0].id).toBe(current.id);
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(queryLog.filter((query) => /^\s*set local statement_timeout\b/i.test(query))).toHaveLength(1);

    const legacyHistory = await services!.getExtractionValueHistory(project.id, paper.id, field.id);
    const legacyDescending = [...legacyHistory].sort((left, right) => Number(right.sequence) - Number(left.sequence));
    const boundedDescending = [...firstPage.items, ...finalPage.items];
    expect(boundedDescending.map((item) => ({ id: item.id, sequence: item.sequence, valueState: item.valueState, textValuePreview: item.textValuePreview, researcherNotePreview: item.researcherNotePreview, evidenceCount: item.evidenceCount }))).toEqual(
      legacyDescending.map((item) => ({ id: item.id, sequence: String(item.sequence), valueState: item.valueState, textValuePreview: item.textValue, researcherNotePreview: item.researcherNote, evidenceCount: String(item.evidence.length) })),
    );

    queryLog.length = 0;
    const exactBeforeReview = await countedDb!.transaction(
      (tx) => history!.getExtractionRevisionExact(project.id, paper.id, field.id, first.id, tx),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    expect(exactBeforeReview.revision.evidence).toMatchObject([{ id: firstEvidence.id, reviewState: "unreviewed", curationWarning: "never_reviewed" }]);
    const exactEvidenceSql = queryLog.find((query) => /from scoped_revision scope/i.test(query));
    expect(exactEvidenceSql).toMatch(/order by item\.page_number asc, item\.created_at asc\s*$/i);
    expect(exactEvidenceSql).not.toMatch(/order by item\.page_number asc, item\.created_at asc\s*,/i);
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);
    expect(queryLog.filter((query) => /^\s*set local statement_timeout\b/i.test(query))).toHaveLength(1);

    await services!.appendEvidenceReviewDecision(project.id, firstEvidence.id, { decision: "rejected" });
    queryLog.length = 0;
    const exact = await history!.getExtractionRevisionExact(project.id, paper.id, field.id, first.id);
    expect(exact).toMatchObject({
      paper: { id: paper.id },
      field: { id: field.id, fieldType: "long_text", archivedAt: null },
      revision: {
        id: first.id,
        sequence: String(first.sequence),
        textValue: "First immutable long value",
        researcherNote: "First immutable note",
        evidence: [{ id: firstEvidence.id, sourceText: "First exact passage", note: "evidence note", reviewState: "rejected", curationWarning: "currently_rejected" }],
      },
      isCurrentRevision: false,
    });
    expect(exact.revision.evidence.map((item) => item.id)).toEqual(exactBeforeReview.revision.evidence.map((item) => item.id));
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(2);

    const later = await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: "New current value", evidenceIds: [] });
    const exactAfterNewRevision = await history!.getExtractionRevisionExact(project.id, paper.id, field.id, first.id);
    expect(exactAfterNewRevision.isCurrentRevision).toBe(false);
    expect(exactAfterNewRevision.revision.textValue).toBe("First immutable long value");

    await services!.archiveExtractionField(project.id, field.id);
    const exclusionCriterion = await services!.createFullTextScreeningCriterion(project.id, { text: "Excluded after extraction history" });
    await services!.recordFullTextScreeningDecision(project.id, paper.id, { decision: "exclude", exclusionCriterionId: exclusionCriterion.id });
    const archivedFieldHistory = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id);
    const exactAfterExclusion = await history!.getExtractionRevisionExact(project.id, paper.id, field.id, first.id);
    expect(archivedFieldHistory.field.archivedAt).toEqual(expect.any(Date));
    expect(archivedFieldHistory.items.map((item) => item.id)).toEqual([later.id, current.id, first.id]);
    expect(archivedFieldHistory.current?.id).toBe(later.id);
    expect(exactAfterExclusion.isCurrentRevision).toBe(false);
    expect(exactAfterExclusion.revision.evidence.map((item) => item.id)).toEqual([firstEvidence.id]);
  });

  it("matches deterministic randomized bounded pages to safe-sequence legacy history", async () => {
    const project = await services!.createProject({ title: `Slice 53 randomized parity ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const field = await services!.createExtractionField(project.id, { name: "Randomized history", fieldType: "long_text" });
    const valueStates = ["present", "not_reported", "not_applicable", "cleared"] as const;
    let seed = 0x53a7e;
    const nextRandom = (limit: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % limit;
    };

    for (let index = 0; index < 53; index += 1) {
      const valueState = valueStates[nextRandom(valueStates.length)];
      const researcherNote = nextRandom(4) === 0 ? null : `note-${index}-${nextRandom(10_000)}`;
      if (valueState === "present") {
        await services!.reviseExtractionValue(project.id, paper.id, field.id, {
          value: `value-${index}-${nextRandom(1_000_000)}`,
          researcherNote,
          evidenceIds: [],
        });
      } else {
        await services!.reviseExtractionValue(project.id, paper.id, field.id, {
          state: valueState,
          researcherNote,
          evidenceIds: [],
        });
      }
    }

    const legacyHistory = await services!.getExtractionValueHistory(project.id, paper.id, field.id);
    // The writer assigns a unique, safely representable sequence to each fixture row;
    // this comparison never chooses a current winner for tied sequences.
    const expected = [...legacyHistory].sort((left, right) => Number(right.sequence) - Number(left.sequence));
    const actual: Awaited<ReturnType<NonNullable<typeof history>["getExtractionFieldRevisionHistoryPage"]>>["items"] = [];
    let cursor: string | null | undefined;
    do {
      const page = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 9, cursor });
      actual.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(actual).toHaveLength(53);
    expect(actual.map((item) => ({
      id: item.id,
      sequence: item.sequence,
      fieldType: item.fieldType,
      valueState: item.valueState,
      textValuePreview: item.textValuePreview,
      researcherNotePreview: item.researcherNotePreview,
      evidenceCount: item.evidenceCount,
    }))).toEqual(expected.map((item) => ({
      id: item.id,
      sequence: String(item.sequence),
      fieldType: item.fieldType,
      valueState: item.valueState,
      textValuePreview: item.textValue,
      researcherNotePreview: item.researcherNote,
      evidenceCount: String(item.evidence.length),
    })));
  });

  it("returns generic not-found for exact revisions outside the full ownership scope before Evidence hydration", async () => {
    const project = await services!.createProject({ title: `Slice 53 exact ownership ${randomUUID()}` });
    const otherProject = await services!.createProject({ title: `Slice 53 other project ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const otherPaper = await includedPaper(project.id);
    const field = await services!.createExtractionField(project.id, { name: "Owned Field", fieldType: "short_text" });
    const otherField = await services!.createExtractionField(project.id, { name: "Other Field", fieldType: "short_text" });
    const evidenceItem = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "Ownership proof", pageNumber: 1 });
    const ownedRevision = await services!.reviseExtractionValue(project.id, paper.id, field.id, {
      value: "owned revision",
      evidenceIds: [evidenceItem.id],
    });
    const wrongSlotRevision = await services!.reviseExtractionValue(project.id, paper.id, otherField.id, {
      value: "other slot revision",
      evidenceIds: [],
    });
    const [slot] = await db!.select().from(extractionValues).where(eq(extractionValues.fieldId, field.id));
    const [unfinalizedRevision] = await db!.insert(extractionValueRevisions).values({
      projectId: project.id,
      paperId: paper.id,
      fieldId: field.id,
      extractionValueId: slot.id,
      fieldType: "short_text",
      valueState: "present",
      textValue: "not finalized",
      finalizedAt: null,
    }).returning();

    const assertGenericNotFoundBeforeEvidenceRead = async (
      scope: { projectId: string; paperId: string; fieldId: string; revisionId: string },
    ) => {
      queryLog.length = 0;
      await expect(history!.getExtractionRevisionExact(scope.projectId, scope.paperId, scope.fieldId, scope.revisionId))
        .rejects.toMatchObject({ code: "NOT_FOUND", message: "Extraction revision was not found" });
      expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(1);
      expect(queryLog.some((query) => /from scoped_revision\s+scope/i.test(query))).toBe(false);
    };

    await assertGenericNotFoundBeforeEvidenceRead({
      projectId: otherProject.id,
      paperId: paper.id,
      fieldId: field.id,
      revisionId: ownedRevision.id,
    });
    await assertGenericNotFoundBeforeEvidenceRead({
      projectId: project.id,
      paperId: otherPaper.id,
      fieldId: field.id,
      revisionId: ownedRevision.id,
    });
    await assertGenericNotFoundBeforeEvidenceRead({
      projectId: project.id,
      paperId: paper.id,
      fieldId: otherField.id,
      revisionId: ownedRevision.id,
    });
    await assertGenericNotFoundBeforeEvidenceRead({
      projectId: project.id,
      paperId: paper.id,
      fieldId: field.id,
      revisionId: wrongSlotRevision.id,
    });
    await assertGenericNotFoundBeforeEvidenceRead({
      projectId: project.id,
      paperId: paper.id,
      fieldId: field.id,
      revisionId: unfinalizedRevision.id,
    });
  });

  it("matches released current values, notes, Field/Option order, and revision identity across all Field types", async () => {
    const project = await services!.createProject({ title: `Slice 53 worksheet parity ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const fields = [
      await services!.createExtractionField(project.id, { name: "Short", fieldType: "short_text" }),
      await services!.createExtractionField(project.id, { name: "Long", fieldType: "long_text" }),
      await services!.createExtractionField(project.id, { name: "Number", fieldType: "number" }),
      await services!.createExtractionField(project.id, { name: "Boolean", fieldType: "boolean" }),
      await services!.createExtractionField(project.id, { name: "Select", fieldType: "single_select" }),
    ];
    const [shortField, longField, numberField, booleanField, selectField] = fields;
    const firstOption = await services!.createExtractionOption(project.id, { fieldId: selectField.id, label: "Original first option" });
    const selectedArchivedOption = await services!.createExtractionOption(project.id, { fieldId: selectField.id, label: "Original archived option" });

    await services!.reviseExtractionValue(project.id, paper.id, shortField.id, { value: "Earlier short value", researcherNote: "Earlier short note" });
    await services!.reviseExtractionValue(project.id, paper.id, shortField.id, { value: "Current short value", researcherNote: null });
    await services!.reviseExtractionValue(project.id, paper.id, longField.id, { value: "Earlier long value", researcherNote: "Earlier long note" });
    await services!.reviseExtractionValue(project.id, paper.id, longField.id, { state: "not_reported", researcherNote: null });
    await services!.reviseExtractionValue(project.id, paper.id, numberField.id, { value: "2.5", researcherNote: "Earlier numeric note" });
    await services!.reviseExtractionValue(project.id, paper.id, numberField.id, { value: "0", researcherNote: "Zero note" });
    await services!.reviseExtractionValue(project.id, paper.id, booleanField.id, { value: false, researcherNote: "False note" });
    const selectedRevision = await services!.reviseExtractionValue(project.id, paper.id, selectField.id, {
      value: selectedArchivedOption.id,
      researcherNote: "Archived Option note",
    });
    await services!.archiveExtractionOption(project.id, selectedArchivedOption.id);

    const legacy = await services!.getPaperExtraction(project.id, paper.id);
    const legacyOptions = await Promise.all(legacy.fields.map((field) => services!.listExtractionOptions(project.id, field.id, true)));
    const legacyHistories = await Promise.all(legacy.fields.map((field) => services!.getExtractionValueHistory(project.id, paper.id, field.id)));
    const worksheet = await worksheetServices!.getPaperExtractionWorksheet(project.id, paper.id);

    expect(worksheet.fields.map((field) => ({ id: field.id, name: field.name, fieldType: field.fieldType, sortOrder: field.sortOrder })))
      .toEqual(legacy.fields.map((field) => ({ id: field.id, name: field.name, fieldType: field.fieldType, sortOrder: field.sortOrder })));
    expect(worksheet.fields.map((field) => field.id)).toEqual(fields.map((field) => field.id));
    expect(worksheet.fields.map((field) => field.options.map(({ id, label, sortOrder, archivedAt }) => ({ id, label, sortOrder, archivedAt }))))
      .toEqual(legacyOptions.map((options) => options.map(({ id, label, sortOrder, archivedAt }) => ({ id, label, sortOrder, archivedAt }))));
    expect(worksheet.fields.find((field) => field.id === selectField.id)?.options.map((option) => option.label))
      .toEqual([firstOption.label, selectedArchivedOption.label]);
    expect(worksheet.fields.find((field) => field.id === selectField.id)?.options.find((option) => option.id === selectedArchivedOption.id)?.archivedAt)
      .toEqual(expect.any(Date));

    const worksheetByFieldId = new Map(worksheet.values.map((value) => [value.field.id, value]));
    const legacyByFieldId = new Map(legacy.values.map((value) => [value.field.id, value]));
    expect(worksheet.values.map((value) => value.field.id)).toEqual(legacy.values.map((value) => value.field.id));
    const typedSnapshot = (revision: {
      id: string;
      sequence: number | string;
      fieldType: string;
      valueState: string;
      textValue: string | null;
      numberValue: number | string | null;
      booleanValue: boolean | null;
      optionId: string | null;
      researcherNote: string | null;
    } | null) => revision && ({
      id: revision.id,
      sequence: String(revision.sequence),
      fieldType: revision.fieldType,
      valueState: revision.valueState,
      textValue: revision.textValue,
      // This fixture uses exact, safely representable decimal values so the released JS-number DTO and specialized text DTO compare semantically.
      numberValue: revision.numberValue == null ? null : Number(revision.numberValue),
      booleanValue: revision.booleanValue,
      optionId: revision.optionId,
      researcherNote: revision.researcherNote,
    });

    for (const field of fields) {
      const worksheetValue = worksheetByFieldId.get(field.id)!;
      const legacyValue = legacyByFieldId.get(field.id)!;
      const legacyCurrent = legacyValue.currentRevision;
      expect(typedSnapshot(worksheetValue.currentRevision)).toEqual(typedSnapshot(legacyCurrent));
      expect(worksheetValue.currentRevision?.id ?? null).toBe(legacyCurrent?.id ?? null);
      const historyRows = legacyHistories[legacy.fields.findIndex((candidate) => candidate.id === field.id)];
      if (legacyCurrent) {
        const historyCurrent = historyRows.find((revision) => revision.id === legacyCurrent.id);
        expect(historyCurrent).toBeDefined();
        expect(typedSnapshot(historyCurrent!)).toEqual(typedSnapshot(legacyCurrent));
        expect(typedSnapshot(worksheetValue.currentRevision)).toEqual(typedSnapshot(historyCurrent!));
      } else {
        expect(historyRows).toHaveLength(0);
      }
    }

    expect(worksheetByFieldId.get(shortField.id)?.currentRevision).toMatchObject({ textValue: "Current short value", researcherNote: null });
    expect(worksheetByFieldId.get(longField.id)?.currentRevision).toMatchObject({ valueState: "not_reported", textValue: null, numberValue: null, booleanValue: null, optionId: null, researcherNote: null });
    expect(worksheetByFieldId.get(numberField.id)?.currentRevision).toMatchObject({ valueState: "present", numberValue: "0.0000000000", researcherNote: "Zero note" });
    expect(worksheetByFieldId.get(booleanField.id)?.currentRevision).toMatchObject({ valueState: "present", booleanValue: false, researcherNote: "False note" });
    expect(worksheetByFieldId.get(selectField.id)?.currentRevision).toMatchObject({
      id: selectedRevision.id,
      optionId: selectedArchivedOption.id,
      optionLabel: "Original archived option",
      optionArchivedAt: expect.any(Date),
      researcherNote: "Archived Option note",
    });
    expect(legacyHistories[0].map((revision) => ({ textValue: revision.textValue, researcherNote: revision.researcherNote })))
      .toEqual([{ textValue: "Earlier short value", researcherNote: "Earlier short note" }, { textValue: "Current short value", researcherNote: null }]);
    expect(legacyHistories[1].map((revision) => ({ valueState: revision.valueState, textValue: revision.textValue, researcherNote: revision.researcherNote })))
      .toEqual([{ valueState: "present", textValue: "Earlier long value", researcherNote: "Earlier long note" }, { valueState: "not_reported", textValue: null, researcherNote: null }]);
  });

  it("preserves all value states and Field types, including zero, false, archived Option, and empty slots", async () => {
    const project = await services!.createProject({ title: `Slice 53 values ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const shortText = await services!.createExtractionField(project.id, { name: "Short", fieldType: "short_text" });
    const longText = await services!.createExtractionField(project.id, { name: "Long", fieldType: "long_text" });
    const number = await services!.createExtractionField(project.id, { name: "Number", fieldType: "number" });
    const boolean = await services!.createExtractionField(project.id, { name: "Boolean", fieldType: "boolean" });
    const select = await services!.createExtractionField(project.id, { name: "Select", fieldType: "single_select" });
    const empty = await services!.createExtractionField(project.id, { name: "Empty", fieldType: "long_text" });
    const option = await services!.createExtractionOption(project.id, { fieldId: select.id, label: "Original label" });

    const shortPresent = await services!.reviseExtractionValue(project.id, paper.id, shortText.id, { value: "short" });
    const longNotReported = await services!.reviseExtractionValue(project.id, paper.id, longText.id, { state: "not_reported" });
    const numberZero = await services!.reviseExtractionValue(project.id, paper.id, number.id, { value: "0" });
    const booleanFalse = await services!.reviseExtractionValue(project.id, paper.id, boolean.id, { value: false });
    const selectedOption = await services!.reviseExtractionValue(project.id, paper.id, select.id, { value: option.id });
    await services!.archiveExtractionOption(project.id, option.id);
    const notApplicable = await services!.reviseExtractionValue(project.id, paper.id, shortText.id, { state: "not_applicable" });
    const cleared = await services!.reviseExtractionValue(project.id, paper.id, shortText.id, { state: "cleared" });

    const numberHistory = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, number.id);
    const booleanHistory = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, boolean.id);
    const selectHistory = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, select.id);
    const emptyHistory = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, empty.id);
    expect(numberHistory.items[0]).toMatchObject({ numberValue: "0.0000000000", valueState: "present" });
    expect(booleanHistory.items[0]).toMatchObject({ booleanValue: false, valueState: "present" });
    expect(selectHistory.items[0]).toMatchObject({ optionId: option.id, optionLabelPreview: "Original label", optionArchivedAt: expect.any(Date) });
    expect(emptyHistory).toMatchObject({ items: [], hasMore: false, current: null, field: { extractionValueId: null } });
    expect((await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, longText.id)).items[0].valueState).toBe("not_reported");
    const shortHistory = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, shortText.id, { pageSize: 50 });
    expect(shortHistory.items.map((item) => item.valueState)).toEqual(["cleared", "not_applicable", "present"]);
    expect((await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, shortText.id)).pageSize).toBe(20);
    expect((await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, shortText.id, { pageSize: 51 })).pageSize).toBe(50);

    const [shortExact, notReportedExact, numberExact, booleanExact, optionExact, notApplicableExact, clearedExact] = await Promise.all([
      history!.getExtractionRevisionExact(project.id, paper.id, shortText.id, shortPresent.id),
      history!.getExtractionRevisionExact(project.id, paper.id, longText.id, longNotReported.id),
      history!.getExtractionRevisionExact(project.id, paper.id, number.id, numberZero.id),
      history!.getExtractionRevisionExact(project.id, paper.id, boolean.id, booleanFalse.id),
      history!.getExtractionRevisionExact(project.id, paper.id, select.id, selectedOption.id),
      history!.getExtractionRevisionExact(project.id, paper.id, shortText.id, notApplicable.id),
      history!.getExtractionRevisionExact(project.id, paper.id, shortText.id, cleared.id),
    ]);
    expect(shortExact.revision).toMatchObject({ valueState: "present", textValue: "short", numberValue: null, booleanValue: null, optionId: null });
    expect(notReportedExact.revision).toMatchObject({ valueState: "not_reported", textValue: null, numberValue: null, booleanValue: null, optionId: null });
    expect(numberExact.revision).toMatchObject({ valueState: "present", numberValue: "0.0000000000", textValue: null, booleanValue: null, optionId: null });
    expect(booleanExact.revision).toMatchObject({ valueState: "present", booleanValue: false, textValue: null, numberValue: null, optionId: null });
    expect(optionExact.revision).toMatchObject({ valueState: "present", optionId: option.id, optionLabel: "Original label", optionArchivedAt: expect.any(Date) });
    expect(notApplicableExact.revision).toMatchObject({ valueState: "not_applicable", textValue: null, numberValue: null, booleanValue: null, optionId: null });
    expect(clearedExact.revision).toMatchObject({ valueState: "cleared", textValue: null, numberValue: null, booleanValue: null, optionId: null });
  });

  it("retains traversal ties without selecting an invented current UUID winner", async () => {
    const project = await services!.createProject({ title: `Slice 53 tied ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const field = await services!.createExtractionField(project.id, { name: "Tie", fieldType: "short_text" });
    const slot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: field.id }).returning().then((items) => items[0]);
    const [first] = await appClient!`
      insert into extraction_value_revisions (sequence,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,finalized_at)
      overriding system value
      values (77,${project.id},${paper.id},${field.id},${slot.id},'short_text','present','first',now()) returning id::text as id
    `;
    const [second] = await appClient!`
      insert into extraction_value_revisions (sequence,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,finalized_at)
      overriding system value
      values (77,${project.id},${paper.id},${field.id},${slot.id},'short_text','present','second',now()) returning id::text as id
    `;

    const tied = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 2 });
    expect(tied.items.map((item) => item.id)).toEqual([first.id, second.id].sort((left, right) => left === right ? 0 : left < right ? 1 : -1));
    expect([first.id, second.id]).toContain(tied.current?.id);
    expect(tied.items.filter((item) => item.isCurrent).map((item) => item.id)).toEqual([tied.current?.id]);
  });

  it("uses BIGINT tuple cursors and rejects cross-slot anchors before page selection", async () => {
    const project = await services!.createProject({ title: `Slice 53 bigint ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const field = await services!.createExtractionField(project.id, { name: "Large sequence", fieldType: "short_text" });
    const otherField = await services!.createExtractionField(project.id, { name: "Other slot", fieldType: "short_text" });
    const slot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: field.id }).returning().then((items) => items[0]);
    const otherSlot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: otherField.id }).returning().then((items) => items[0]);
    await appClient!`
      insert into extraction_value_revisions (sequence,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,finalized_at)
      overriding system value
      values (9007199254740993,${project.id},${paper.id},${field.id},${slot.id},'short_text','present','older',now())
    `;
    await appClient!`
      insert into extraction_value_revisions (sequence,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,finalized_at)
      overriding system value
      values (9007199254740994,${project.id},${paper.id},${field.id},${slot.id},'short_text','present','newer',now())
    `;
    const [other] = await appClient!`
      insert into extraction_value_revisions (sequence,project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,finalized_at)
      overriding system value
      values (9007199254740995,${project.id},${paper.id},${otherField.id},${otherSlot.id},'short_text','present','other',now()) returning extraction_value_id::text as extraction_value_id
    `;

    const page = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 1 });
    expect(page.items[0].sequence).toBe("9007199254740994");
    const cursor = decodeExtractionHistoryCursor(page.nextCursor, { projectId: project.id, paperId: paper.id, fieldId: field.id, pageSize: 1 });
    expect(cursor?.lastSequence).toBe("9007199254740994");
    const invalidSlotCursor = encodeExtractionHistoryCursor({ ...cursor!, extractionValueId: other.extraction_value_id });
    queryLog.length = 0;
    await expect(history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 1, cursor: invalidSlotCursor }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(queryLog.filter((query) => /^\s*(select|with)\b/i.test(query))).toHaveLength(1);
  });

  it("keeps worst-case 50-row preview JSON under 256 KiB while preserving non-BMP values", async () => {
    const project = await services!.createProject({ title: `Slice 53 payload ${randomUUID()}` });
    const paper = await services!.addPaper(project.id, { title: "Payload fixture" });
    const field = await services!.createExtractionField(project.id, { name: "Payload field", fieldType: "single_select" });
    const option = await services!.createExtractionOption(project.id, { fieldId: field.id, label: "Payload option" });
    const textField = await services!.createExtractionField(project.id, { name: "Text payload field", fieldType: "short_text" });
    const escapedChunk = `${Array.from({ length: 0x1f }, (_, index) => String.fromCharCode(index + 1)).join("")}"\\/ASCII😀`;
    const escapedValue = (minimumCodePoints: number) => {
      let value = "";
      while (Array.from(value).length <= minimumCodePoints) value += escapedChunk;
      return value;
    };
    // PostgreSQL text cannot contain U+0000. The stored fixtures cover every
    // other JSON C0 control plus quotes, backslashes, ASCII, and non-BMP text.
    const hostile = escapedValue(520);
    const note = escapedValue(210);
    await db!.update(extractionFields).set({ name: hostile }).where(eq(extractionFields.id, field.id));
    await db!.update(extractionOptions).set({ label: hostile }).where(eq(extractionOptions.id, option.id));
    await db!.update(extractionFields).set({ name: hostile }).where(eq(extractionFields.id, textField.id));
    const slot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: field.id }).returning().then((items) => items[0]);
    await db!.insert(extractionValueRevisions).values(Array.from({ length: 51 }, () => ({
      projectId: project.id,
      paperId: paper.id,
      fieldId: field.id,
      extractionValueId: slot.id,
      fieldType: "single_select",
      valueState: "present",
      textValue: null,
      numberValue: null,
      booleanValue: null,
      optionId: option.id,
      researcherNote: note,
      finalizedAt: null,
    })));
    const textSlot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: textField.id }).returning().then((items) => items[0]);
    await db!.insert(extractionValueRevisions).values(Array.from({ length: 51 }, () => ({
      projectId: project.id,
      paperId: paper.id,
      fieldId: textField.id,
      extractionValueId: textSlot.id,
      fieldType: "short_text",
      valueState: "present",
      textValue: hostile,
      numberValue: null,
      booleanValue: null,
      optionId: null,
      researcherNote: note,
      finalizedAt: null,
    })));

    const [sentinel] = await appClient!.unsafe(
      `select id::text as id from extraction_value_revisions
       where project_id=$1::uuid and paper_id=$2::uuid and field_id=$3::uuid
       order by sequence desc,id desc offset 50 limit 1`,
      [project.id, paper.id, field.id],
    ) as Array<{ id: string }>;
    const supportItems = await db!.insert(evidence).values(Array.from({ length: 75 }, (_, index) => ({
      projectId: project.id,
      paperId: paper.id,
      sourceText: `Sentinel support passage ${index + 1}`,
      pageNumber: index + 1,
    }))).returning({ id: evidence.id });
    await db!.insert(extractionRevisionEvidence).values(supportItems.map((item) => ({
      projectId: project.id,
      paperId: paper.id,
      revisionId: sentinel.id,
      evidenceId: item.id,
    })));
    await db!.update(extractionValueRevisions).set({ finalizedAt: new Date() }).where(eq(extractionValueRevisions.projectId, project.id));

    queryLog.length = 0;
    const payload = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 50 });
    const serialized = JSON.stringify(payload);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(256 * 1024);
    for (let control = 1; control <= 0x1f; control += 1) expect(hostile).toContain(String.fromCharCode(control));
    expect(hostile).toContain('"');
    expect(hostile).toContain("\\");
    expect(hostile).toContain("ASCII");
    expect(hostile).toContain("😀");
    expect(Array.from(payload.field.namePreview)).toHaveLength(500);
    expect(payload.field.nameTruncated).toBe(true);
    expect(Array.from(payload.items[0].optionLabelPreview ?? "")).toHaveLength(500);
    expect(payload.items[0].optionLabelTruncated).toBe(true);
    expect(payload.items[0].researcherNoteTruncated).toBe(true);
    expect(payload.items).toHaveLength(50);
    expect(payload.hasMore).toBe(true);
    expect(payload.items.every((item) => item.evidenceCount === "0")).toBe(true);
    const nulEscapingProbe = {
      ...payload,
      field: { ...payload.field, namePreview: payload.field.namePreview.replaceAll("\u0001", "\u0000") },
      items: payload.items.map((item) => ({ ...item, optionLabelPreview: item.optionLabelPreview?.replaceAll("\u0001", "\u0000") ?? null })),
    };
    expect(Buffer.byteLength(JSON.stringify(nulEscapingProbe), "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(queryLog.find((query) => /visible_evidence_counts/i.test(query))).toContain("join visible_page visible on visible.id=link.revision_id");

    const textPayload = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, textField.id, { pageSize: 50 });
    expect(textPayload.items).toHaveLength(50);
    expect(Array.from(textPayload.items[0].textValuePreview ?? "")).toHaveLength(448);
    expect(textPayload.items[0].textValueTruncated).toBe(true);
    expect(Array.from(textPayload.items[0].researcherNotePreview ?? "")).toHaveLength(192);
    expect(textPayload.items[0].researcherNoteTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(textPayload), "utf8")).toBeLessThanOrEqual(256 * 1024);

    const singleControl = "\u0001".repeat(520);
    const singleControlNote = "\u0001".repeat(210);
    const controlField = await services!.createExtractionField(project.id, { name: "Control escape field", fieldType: "single_select" });
    const controlOption = await services!.createExtractionOption(project.id, { fieldId: controlField.id, label: "Control escape option" });
    await db!.update(extractionFields).set({ name: singleControl }).where(eq(extractionFields.id, controlField.id));
    await db!.update(extractionOptions).set({ label: singleControl }).where(eq(extractionOptions.id, controlOption.id));
    const controlSlot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: controlField.id }).returning().then((items) => items[0]);
    await db!.insert(extractionValueRevisions).values(Array.from({ length: 51 }, () => ({
      projectId: project.id,
      paperId: paper.id,
      fieldId: controlField.id,
      extractionValueId: controlSlot.id,
      fieldType: "single_select",
      valueState: "present",
      optionId: controlOption.id,
      researcherNote: singleControlNote,
      finalizedAt: null,
    })));
    await db!.update(extractionValueRevisions).set({ finalizedAt: new Date() }).where(eq(extractionValueRevisions.fieldId, controlField.id));
    const controlPayload = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, controlField.id, { pageSize: 50 });
    const controlSerialized = JSON.stringify(controlPayload);
    expect(Buffer.byteLength(controlSerialized, "utf8")).toBeLessThanOrEqual(262144);
    expect(controlPayload.items).toHaveLength(50);
    expect(controlPayload.field.namePreview).toBe("\u0001".repeat(500));
    expect(controlPayload.field.nameTruncated).toBe(true);
    expect(controlPayload.items.every((item) => item.optionLabelPreview === "\u0001".repeat(500)
      && item.optionLabelTruncated
      && item.researcherNotePreview === "\u0001".repeat(192)
      && item.researcherNoteTruncated)).toBe(true);
    expect(controlSerialized).toContain("\\u0001".repeat(500));

    const controlTextField = await services!.createExtractionField(project.id, { name: "Control text escape field", fieldType: "short_text" });
    await db!.update(extractionFields).set({ name: singleControl }).where(eq(extractionFields.id, controlTextField.id));
    const controlTextSlot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: controlTextField.id }).returning().then((items) => items[0]);
    await db!.insert(extractionValueRevisions).values(Array.from({ length: 51 }, () => ({
      projectId: project.id,
      paperId: paper.id,
      fieldId: controlTextField.id,
      extractionValueId: controlTextSlot.id,
      fieldType: "short_text",
      valueState: "present",
      textValue: singleControl,
      researcherNote: singleControlNote,
      finalizedAt: null,
    })));
    await db!.update(extractionValueRevisions).set({ finalizedAt: new Date() }).where(eq(extractionValueRevisions.fieldId, controlTextField.id));
    const controlTextPayload = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, controlTextField.id, { pageSize: 50 });
    const controlTextSerialized = JSON.stringify(controlTextPayload);
    expect(Buffer.byteLength(controlTextSerialized, "utf8")).toBeLessThanOrEqual(262144);
    expect(controlTextPayload.items).toHaveLength(50);
    expect(controlTextPayload.field.namePreview).toBe("\u0001".repeat(500));
    expect(controlTextPayload.field.nameTruncated).toBe(true);
    expect(controlTextPayload.items.every((item) => item.textValuePreview === "\u0001".repeat(448)
      && item.textValueTruncated
      && item.researcherNotePreview === "\u0001".repeat(192)
      && item.researcherNoteTruncated)).toBe(true);
    expect(controlTextSerialized).toContain("\\u0001".repeat(448));

    const lastPage = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 50, cursor: payload.nextCursor });
    expect(lastPage.items).toHaveLength(1);
    expect(lastPage.items[0]).toMatchObject({ id: sentinel.id, evidenceCount: "75", supportStatus: "grounded" });
    expect(lastPage.hasMore).toBe(false);
    const exact = await history!.getExtractionRevisionExact(project.id, paper.id, field.id, sentinel.id);
    expect(exact.revision.evidence).toHaveLength(75);
    expect(exact.revision.evidence.map((item) => item.pageNumber)).toEqual(Array.from({ length: 75 }, (_, index) => index + 1));
  });

  it("seeks a deep 50-row page in a 50k-revision slot", async () => {
    const project = await services!.createProject({ title: `Slice 53 50k ${randomUUID()}` });
    const paper = await services!.addPaper(project.id, { title: "Fifty thousand history rows" });
    const field = await services!.createExtractionField(project.id, { name: "Deep field", fieldType: "short_text" });
    const slot = await db!.insert(extractionValues).values({ projectId: project.id, paperId: paper.id, fieldId: field.id }).returning().then((items) => items[0]);
    await appClient!.unsafe(`
      insert into extraction_value_revisions (
        project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value,finalized_at
      )
      select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'short_text','present','revision-' || n::text,now()
      from generate_series(1,50000) n
    `, [project.id, paper.id, field.id, slot.id]);
    await appClient!.unsafe("analyze extraction_value_revisions");
    const [anchor] = await appClient!`
      select id::text as id,sequence::text as sequence
      from extraction_value_revisions
      where project_id=${project.id} and paper_id=${paper.id} and field_id=${field.id}
      order by sequence desc,id desc offset 24999 limit 1
    `;
    const deepCursor = encodeExtractionHistoryCursor({
      v: 1,
      projectId: project.id,
      paperId: paper.id,
      fieldId: field.id,
      extractionValueId: slot.id,
      historyType: "extraction-value-revision",
      pageSize: 50,
      lastSequence: String(anchor.sequence),
      lastRevisionId: String(anchor.id),
    });
    const deep = await history!.getExtractionFieldRevisionHistoryPage(project.id, paper.id, field.id, { pageSize: 50, cursor: deepCursor });
    expect(deep.items).toHaveLength(50);
    expect(BigInt(deep.items[0].sequence)).toBeLessThan(BigInt(String(anchor.sequence)));
    expect(deep.items.at(-1)?.sequence).toBeTruthy();
    expect(deep.hasMore).toBe(true);
  }, 180_000);
});
