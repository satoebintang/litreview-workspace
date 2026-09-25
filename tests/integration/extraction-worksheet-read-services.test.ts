import "dotenv/config";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtractionWorksheetReadServices } from "@/application/extraction-worksheet-read-services";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { EvidenceRepository, PaperRepository, PaperReviewRepository } from "@/application/repositories";
import { extractionFields, extractionValueRevisions, extractionValues, schema } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice37_extract_ws_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 37 Extraction worksheet reads", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let countedClient: postgres.Sql | undefined;
  let db: ReturnType<typeof createDb>["db"] | undefined;
  let services: ReturnType<typeof createReviewServices> | undefined;
  let worksheetServices: ReturnType<typeof createExtractionWorksheetReadServices> | undefined;
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
    worksheetServices = createExtractionWorksheetReadServices(countedDb, {
      paperRepo: new PaperRepository(countedDb),
      paperReviewRepo: new PaperReviewRepository(countedDb),
      evidenceRepo: new EvidenceRepository(countedDb),
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
    const paper = await services!.addPaper(projectId, { title: `Worksheet paper ${randomUUID()}` });
    await services!.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services!.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services!.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("matches released worksheet, field history, and Evidence projections", async () => {
    const project = await services!.createProject({ title: `Worksheet equivalence ${randomUUID()}` });
    const paper = await includedPaper(project.id);
    const otherPaper = await services!.addPaper(project.id, { title: "Other paper" });
    const otherProject = await services!.createProject({ title: `Other project ${randomUUID()}` });
    const field = await services!.createExtractionField(project.id, {
      name: "Study arm",
      description: "Intervention group",
      fieldType: "single_select",
      required: true,
    });
    const emptyField = await services!.createExtractionField(project.id, {
      name: "Notes",
      fieldType: "long_text",
      required: false,
    });
    const option = await services!.createExtractionOption(project.id, { fieldId: field.id, label: "Treatment" });
    const firstEvidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "First passage", pageNumber: 4 });
    const currentEvidence = await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "Current passage", pageNumber: 9 });
    await services!.recordEvidence(project.id, { paperId: paper.id, sourceText: "Unlinked passage", pageNumber: 11 });
    await services!.recordEvidence(project.id, { paperId: otherPaper.id, sourceText: "Other paper passage", pageNumber: 1 });
    await services!.recordEvidence(otherProject.id, { paperId: (await services!.addPaper(otherProject.id, { title: "Other project paper" })).id, sourceText: "Other project passage", pageNumber: 2 });
    await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: option.id, evidenceIds: [firstEvidence.id] });
    await services!.reviseExtractionValue(project.id, paper.id, field.id, { value: option.id, evidenceIds: [currentEvidence.id] });
    await services!.appendEvidenceReviewDecision(project.id, firstEvidence.id, { decision: "accepted" });
    await services!.appendEvidenceReviewDecision(project.id, firstEvidence.id, { decision: "rejected" });
    await services!.appendEvidenceReviewDecision(project.id, currentEvidence.id, { decision: "accepted" });
    await services!.archiveExtractionOption(project.id, option.id);

    const legacy = await services!.getPaperExtraction(project.id, paper.id);
    const legacyHistory = await services!.getExtractionValueHistory(project.id, paper.id, field.id);
    const legacyEvidence = (await services!.listEvidence(project.id)).filter((item) => item.paperId === paper.id);
    const legacyProgress = (await services!.getProjectExtractionProgress(project.id)).papers.find((item) => item.paper.id === paper.id)!;
    const worksheet = await worksheetServices!.getPaperExtractionWorksheet(project.id, paper.id);

    expect(worksheet.paper).toEqual(legacy.paper);
    expect(worksheet.reviewStatus).toEqual(legacy.reviewStatus);
    expect(worksheet.fields.map(({ id, name, description, fieldType, required, sortOrder }) => ({ id, name, description, fieldType, required, sortOrder })))
      .toEqual(legacy.fields.map(({ id, name, description, fieldType, required, sortOrder }) => ({ id, name, description, fieldType, required, sortOrder })));
    expect(worksheet.fields.map((item) => item.options)).toEqual(await Promise.all(legacy.fields.map((item) => services!.listExtractionOptions(project.id, item.id, true))));
    expect(worksheet.fields.find((item) => item.id === field.id)?.options.find((item) => item.id === option.id)).toMatchObject({
      id: option.id,
      label: "Treatment",
      archivedAt: expect.any(Date),
    });
    expect(worksheet.values.map((value) => ({
      id: value.id,
      fieldId: value.fieldId,
      supportStatus: value.supportStatus,
      currentRevision: value.currentRevision && {
        id: value.currentRevision.id,
        sequence: value.currentRevision.sequence,
        valueState: value.currentRevision.valueState,
        optionId: value.currentRevision.optionId,
        evidenceIds: value.currentRevision.evidence.map((item) => item.id),
      },
    }))).toEqual(legacy.values.map((value) => ({
      id: value.id,
      fieldId: value.fieldId,
      supportStatus: value.supportStatus,
      currentRevision: value.currentRevision && {
        id: value.currentRevision.id,
        sequence: value.currentRevision.sequence,
        valueState: value.currentRevision.valueState,
        optionId: value.currentRevision.optionId,
        evidenceIds: value.currentRevision.evidence.map((item) => item.id),
      },
    })));
    expect(worksheet.values.find((value) => value.fieldId === emptyField.id)).toMatchObject({ id: "", currentRevision: null, supportStatus: "ungrounded", history: [] });
    expect(worksheet.values.find((value) => value.fieldId === field.id)?.history.map((revision) => ({
      id: revision.id,
      sequence: revision.sequence,
      optionId: revision.optionId,
      evidenceIds: revision.evidence.map((item) => item.id),
    }))).toEqual(legacyHistory.map((revision) => ({
      id: revision.id,
      sequence: revision.sequence,
      optionId: revision.optionId,
      evidenceIds: revision.evidence.map((item) => item.id),
    })));
    expect(legacyEvidence.find((item) => item.id === firstEvidence.id)).toMatchObject({ reviewState: "rejected" });
    expect(worksheet.evidence.find((item) => item.id === firstEvidence.id)).toMatchObject({
      id: firstEvidence.id,
      reviewState: "rejected",
      curationWarning: "currently_rejected",
    });
    expect(worksheet.evidence).toEqual(legacyEvidence);
    expect(worksheet.evidence.map((item) => item.id)).not.toContain((await services!.listEvidence(project.id)).find((item) => item.paperId === otherPaper.id)!.id);
    expect(worksheet.progress).toEqual({
      completedRequired: legacyProgress.completedRequired,
      requiredCount: legacyProgress.requiredCount,
      status: legacyProgress.status,
      percentage: legacyProgress.percentage,
      writeEligible: legacyProgress.writeEligible,
    });
  });

  it("uses a constant number of SQL statements as field and history volume grows", async () => {
    const statementCounts: Array<{ total: number; reads: number }> = [];
    for (const fieldCount of [1, 25, 100]) {
      for (const historyCount of [1, 20]) {
        const project = await services!.createProject({ title: `Query count ${fieldCount} ${historyCount} ${randomUUID()}` });
        const paper = await services!.addPaper(project.id, { title: "Count fixture" });
        const fields = await db!.insert(extractionFields).values(Array.from({ length: fieldCount }, (_, index) => ({
          projectId: project.id,
          name: `Field ${index}`,
          fieldType: "short_text",
          required: index % 2 === 0,
          sortOrder: index,
        }))).returning();
        const slots = await db!.insert(extractionValues).values(fields.map((field) => ({
          projectId: project.id,
          paperId: paper.id,
          fieldId: field.id,
        }))).returning();
        const slotByFieldId = new Map(slots.map((slot) => [slot.fieldId, slot]));
        await db!.insert(extractionValueRevisions).values(fields.flatMap((field, fieldIndex) =>
          Array.from({ length: historyCount }, (_, revisionIndex) => ({
            projectId: project.id,
            paperId: paper.id,
            fieldId: field.id,
            extractionValueId: slotByFieldId.get(field.id)!.id,
            fieldType: "short_text",
            valueState: "present",
            textValue: `Field ${fieldIndex} revision ${revisionIndex}`,
            numberValue: null,
            booleanValue: null,
            optionId: null,
            researcherNote: null,
            finalizedAt: new Date(Date.UTC(2026, 0, 1, 0, revisionIndex)),
          })),
        ));

        queryLog.length = 0;
        const worksheet = await worksheetServices!.getPaperExtractionWorksheet(project.id, paper.id);
        expect(worksheet.fields).toHaveLength(fieldCount);
        expect(worksheet.values.every((value) => value.history.length === historyCount)).toBe(true);
        statementCounts.push({
          total: queryLog.length,
          reads: queryLog.filter((query) => /^\s*(select|with)\b/i.test(query)).length,
        });
      }
    }

    expect(new Set(statementCounts.map(({ total }) => total)).size).toBe(1);
    expect(new Set(statementCounts.map(({ reads }) => reads)).size).toBe(1);
    expect(statementCounts[0].reads).toBe(9);
  });
});
