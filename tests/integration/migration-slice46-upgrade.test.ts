import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { createDb } from "@/db/client";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const TEST_DB_NAME = `slice46_upgrade_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const testUrl = new URL(BASE_URL);
testUrl.pathname = `/${TEST_DB_NAME}`;
let appClient: postgres.Sql | undefined;
let adminClient: postgres.Sql | undefined;
let migrationDb!: ReturnType<typeof createDb>["db"];
let baselineMigrationsDir = "";

describe("Slice 46 migration from the released Slice 45 schema", () => {
  beforeAll(async () => {
    adminClient = postgres(BASE_URL, { max: 1, prepare: false });
    await adminClient.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
    const created = createDb(testUrl.toString());
    migrationDb = created.db;
    appClient = created.client;

    const sourceDir = path.resolve(process.cwd(), "drizzle");
    baselineMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice46-baseline-migrations-"));
    fs.mkdirSync(path.join(baselineMigrationsDir, "meta"), { recursive: true });
    for (const file of fs.readdirSync(sourceDir).filter((name) => name.endsWith(".sql") && ![
      "0035_retrieved_record_run_order.sql",
      "0036_ai_synthesis_preparation_history.sql",
      "0037_research_question_traceability_epoch.sql",
    ].includes(name))) {
      fs.copyFileSync(path.join(sourceDir, file), path.join(baselineMigrationsDir, file));
    }
    const journalPath = path.join(sourceDir, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    fs.writeFileSync(path.join(baselineMigrationsDir, "meta", "_journal.json"), `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 34) }, null, 2)}\n`, "utf8");
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (baselineMigrationsDir) fs.rmSync(baselineMigrationsDir, { recursive: true, force: true });
    if (adminClient) {
      await adminClient.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
      await adminClient.end();
    }
  });

  it("applies 0035 forward from 0034 and creates the ordered run index", async () => {
    await migrate(migrationDb, { migrationsFolder: baselineMigrationsDir });
    const before = await migrationDb.execute(sql`select to_regclass('public.retrieved_records_project_run_order_idx') as index_name`);
    expect((before as unknown as Array<Record<string, unknown>>)[0]?.index_name).toBeNull();

    await migrate(migrationDb, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    const after = await migrationDb.execute(sql`select pg_get_indexdef(to_regclass('public.retrieved_records_project_run_order_idx')) as definition`);
    expect((after as unknown as Array<Record<string, unknown>>)[0]?.definition).toContain("(project_id, search_run_id, retrieved_at DESC NULLS LAST, id DESC NULLS LAST)");
  });
});
