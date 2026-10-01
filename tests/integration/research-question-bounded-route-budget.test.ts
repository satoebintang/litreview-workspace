import "dotenv/config";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createResearchQuestionBoundedReadServices } from "@/application/research-question-bounded-read-services";
import { createReviewServices } from "@/application/services";
import { schema } from "@/db/schema";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice48_rq_route_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(BASE_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;

describe("Slice 48 initial Question route query composition", () => {
  let admin: postgres.Sql | undefined;
  let client: postgres.Sql | undefined;
  let review: ReturnType<typeof createReviewServices>;
  let bounded: ReturnType<typeof createResearchQuestionBoundedReadServices>;
  const selectLog: string[] = [];

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    client = postgres(databaseUrl.toString(), {
      max: 5,
      prepare: false,
      debug: (_connection, query) => { selectLog.push(query); },
    });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    review = createReviewServices(db);
    bounded = createResearchQuestionBoundedReadServices(db);
  });

  afterAll(async () => {
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("measures the bounded page plus its inherited cached Project layout lookup at 12 SELECTs", async () => {
    const project = await review.createProject({ title: `Question route ${randomUUID()}`, researchQuestion: "How many reads make the first page?" });
    const [question] = await review.listResearchQuestions(project.id);
    selectLog.length = 0;

    // These are the two server reads composed by the Next route tree:
    // ProjectLayout.getProjectForRoute and the page's one workspace call.
    await review.getProject(project.id);
    const workspace = await bounded.getResearchQuestionWorkspace(project.id, question!.id);
    const selects = selectLog.filter((query) => /^\s*(select|with)\b/i.test(query));

    expect(workspace.project.id).toBe(project.id);
    expect(selects).toHaveLength(12);
  });
});
