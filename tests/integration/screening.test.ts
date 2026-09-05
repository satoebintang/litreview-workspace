import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { screeningCriteria, screeningDecisions } from "@/db/schema";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

describe("Slice 2 screening invariants", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Screening project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe(`TRUNCATE TABLE extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, screening_decisions, screening_criteria, claim_evidence, evidence, claims, papers, projects`);
    await client.end();
  });

  it("represents a new Paper as unscreened and derives each decision state", async () => {
    const paper = await services.addPaper(projectId, { title: "Study", abstract: "Abstract" });
    expect((await services.listScreeningPapers(projectId))[0].screeningState).toBe("unscreened");
    await services.recordScreeningDecision(projectId, paper.id, { decision: "maybe", note: "Ambiguous" });
    expect((await services.getPaperScreening(projectId, paper.id)).currentState).toBe("maybe");
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    expect((await services.getPaperScreening(projectId, paper.id)).currentState).toBe("included");
  });

  it("requires a project-owned exclusion criterion and preserves revisions", async () => {
    const other = await services.createProject({ title: "Other project" });
    const paper = await services.addPaper(projectId, { title: "Study" });
    const otherCriterion = await services.createScreeningCriterion(other.id, { type: "exclusion", text: "Wrong population" });
    await expect(services.recordScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: otherCriterion.id })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    const criterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Wrong population" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "maybe" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id, note: "Population mismatch" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    const screening = await services.getPaperScreening(projectId, paper.id);
    expect(screening.currentState).toBe("included");
    expect(screening.history.map((item) => item.decision)).toEqual(["maybe", "exclude", "include"]);
    expect(screening.history[1].exclusionCriterion?.text).toBe("Wrong population");
  });

  it("rejects mutation of append-only decisions at the database boundary", async () => {
    const paper = await services.addPaper(projectId, { title: "Study" });
    const decision = await services.recordScreeningDecision(projectId, paper.id, { decision: "maybe" });
    await expect(db.update(screeningDecisions).set({ note: "mutated" }).where(and(eq(screeningDecisions.projectId, projectId), eq(screeningDecisions.id, decision.id)))).rejects.toThrow();
    await expect(db.delete(screeningDecisions).where(and(eq(screeningDecisions.projectId, projectId), eq(screeningDecisions.id, decision.id)))).rejects.toThrow();
    await expect(db.update(screeningCriteria).set({ text: "mutated" }).where(eq(screeningCriteria.id, (await services.createScreeningCriterion(projectId, { type: "inclusion", text: "Relevant" })).id))).rejects.toThrow();
    await expect(services.deletePaper(projectId, paper.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
  });

  it("keeps archived criteria in history but disallows new exclusions", async () => {
    const paper = await services.addPaper(projectId, { title: "Study" });
    const criterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Editorial" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });
    await services.archiveScreeningCriterion(projectId, criterion.id);
    await expect(services.recordScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(db.insert(screeningDecisions).values({ projectId, paperId: paper.id, decision: "exclude", exclusionCriterionId: criterion.id, exclusionCriterionType: "exclusion" })).rejects.toThrow();
    await expect(db.delete(screeningCriteria).where(eq(screeningCriteria.id, criterion.id))).rejects.toThrow();
    expect((await services.getPaperScreening(projectId, paper.id)).history[0].exclusionCriterion?.text).toBe("Editorial");
  });

  it("enforces project and decision-shape ownership in PostgreSQL", async () => {
    const other = await services.createProject({ title: "Other project" });
    const paper = await services.addPaper(projectId, { title: "Study" });
    const criterion = await services.createScreeningCriterion(projectId, { type: "inclusion", text: "Relevant" });
    const otherCriterion = await services.createScreeningCriterion(other.id, { type: "exclusion", text: "Wrong population" });
    await expect(db.insert(screeningDecisions).values({ projectId: other.id, paperId: paper.id, decision: "maybe", stage: "title_abstract" })).rejects.toThrow();
    await expect(db.insert(screeningDecisions).values({ projectId, paperId: paper.id, decision: "exclude", exclusionCriterionId: criterion.id, exclusionCriterionType: "exclusion" })).rejects.toThrow();
    await expect(db.insert(screeningDecisions).values({ projectId, paperId: paper.id, decision: "exclude", exclusionCriterionId: otherCriterion.id, exclusionCriterionType: "exclusion" })).rejects.toThrow();
    await expect(db.insert(screeningDecisions).values({ projectId, paperId: paper.id, decision: "include", exclusionCriterionId: criterion.id, exclusionCriterionType: "inclusion" })).rejects.toThrow();
  });
});
