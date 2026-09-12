import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { fullTextRetrievalAttempts } from "@/db/schema";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

describe("Slice 13 full-text retrieval core", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Retrieval project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, full_text_retrieval_attempts");
    await client.end();
  });

  it("derives current state from sequence while preserving everRetrieved", async () => {
    const paper = await services.addPaper(projectId, { title: "Retrieval study" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    const first = await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: "2026-01-01T00:00:00Z", method: "publisher" });
    const second = await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "unavailable", attemptedAt: "2025-01-01T00:00:00Z", method: "library" });
    expect(second.sequence).toBeGreaterThan(first.sequence);
    const view = await services.getPaperFullTextRetrieval(projectId, paper.id);
    expect(view.currentState).toBe("unavailable");
    expect(view.everRetrieved).toBe(true);
    expect(view.history.map((attempt) => attempt.sequence)).toEqual([first.sequence, second.sequence]);
  });

  it("requires current title/abstract inclusion and keeps attempts immutable", async () => {
    const paper = await services.addPaper(projectId, { title: "Not included" });
    await expect(services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "pending", attemptedAt: new Date() })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    const attempt = await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "pending", attemptedAt: new Date(), note: "Searching" });
    await expect(db.update(fullTextRetrievalAttempts).set({ note: "changed" }).where(and(eq(fullTextRetrievalAttempts.projectId, projectId), eq(fullTextRetrievalAttempts.id, attempt.id)))).rejects.toThrow();
    await expect(db.delete(fullTextRetrievalAttempts).where(eq(fullTextRetrievalAttempts.id, attempt.id))).rejects.toThrow();
  });

  it("allows a new full-text decision only after current retrieval is retrieved", async () => {
    const paper = await services.addPaper(projectId, { title: "Screenable study" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    const criterion = await services.createFullTextScreeningCriterion(projectId, { text: "Not eligible" });
    await expect(services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await expect(services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id })).resolves.toBeTruthy();
  });
});
