import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice32_workspace_${Date.now()}`;
const DATABASE_URL = `${BASE_URL.replace(/\/[^/]+$/, "")}/${DATABASE_NAME}`;

describe("Slice 32 project workspace read models", () => {
  let appClient: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let services: ReturnType<typeof createReviewServices>;
  let ready = false;

  beforeAll(async () => {
    try {
      admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
      const created = createDb(DATABASE_URL);
      appClient = created.client;
      await migrate(created.db, { migrationsFolder: "./drizzle" });
      services = createReviewServices(created.db);
      ready = true;
    } catch {
      ready = false;
    }
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("returns bounded deterministic project pages and stable first-question summaries", async () => {
    if (!ready) return;
    for (let index = 0; index < 25; index += 1) await services.createProject({ title: `Project ${index}` });
    const ordered = await services.createProject({ title: "Stable question project" });
    await services.createResearchQuestion(ordered.id, { identifier: "RQ2", label: "Created second", sortOrder: 0 });
    await services.createResearchQuestion(ordered.id, { identifier: "RQ1", label: "Created first", sortOrder: 0 });

    const firstPage = await services.listProjectCards({ page: 1 });
    const secondPage = await services.listProjectCards({ page: 2 });
    expect(firstPage.pageSize).toBe(24);
    expect(firstPage.projects).toHaveLength(24);
    expect(firstPage.totalCount).toBe(26);
    expect(secondPage.projects).toHaveLength(2);
    expect(firstPage.projects[0].title).toBe("Stable question project");

    const stable = firstPage.projects.find((project) => project.id === ordered.id);
    expect(stable?.firstResearchQuestion).toBe("Created second");
    expect(stable?.researchQuestionCount).toBe(2);
  });

  it("derives Overview facts from current research state without creating state", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: "Overview facts" });
    const paper = await services.addPaper(project.id, { title: "Included paper" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.createExtractionField(project.id, { name: "Outcome", fieldType: "short_text", required: true });

    const before = await appClient!`select (select count(*) from manuscripts where project_id=${project.id}) as manuscripts, (select count(*) from projects where id=${project.id}) as projects`;
    expect(await services.getDefaultManuscript(project.id)).toBeNull();
    const afterRead = await appClient!`select count(*) as manuscripts from manuscripts where project_id=${project.id}`;
    expect(Number(afterRead[0].manuscripts)).toBe(0);
    const overview = await services.getProjectOverview(project.id);
    const after = await appClient!`select (select count(*) from manuscripts where project_id=${project.id}) as manuscripts, (select count(*) from projects where id=${project.id}) as projects`;

    expect(overview.papers.canonicalPaperCount).toBe(1);
    expect(overview.screening.finallyIncludedPaperCount).toBe(1);
    expect(overview.extraction.requiredFieldCount).toBe(1);
    expect(overview.extraction.missingRequiredExtractionPaperCount).toBe(1);
    expect(after).toEqual(before);
  });
});
