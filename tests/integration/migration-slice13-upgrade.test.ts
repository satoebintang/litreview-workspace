import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const cleanDatabaseName = `slice14_clean_migration_${Date.now()}`;
const upgradeDatabaseName = `slice14_upgrade_migration_${Date.now()}`;
const rollbackDatabaseName = `slice14_rollback_migration_${Date.now()}`;
let upgradeProjectId = "";
let upgradePaperId = "";

function databaseUrl(databaseName: string) {
  const url = new URL(BASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function runMigrationSql(client: { unsafe: (query: string) => Promise<unknown> }, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement);
}

describe("Slice 14 migration boundaries", () => {
  let cleanClient: postgres.Sql | undefined;
  let upgradeClient: postgres.Sql | undefined;
  let rollbackClient: postgres.Sql | undefined;
  let cleanCreated = false;
  let upgradeCreated = false;
  let rollbackCreated = false;

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      await admin.unsafe(`create database "${cleanDatabaseName}"`);
      cleanCreated = true;
      await admin.unsafe(`create database "${upgradeDatabaseName}"`);
      upgradeCreated = true;
      await admin.unsafe(`create database "${rollbackDatabaseName}"`);
      rollbackCreated = true;
    } finally {
      await admin.end();
    }

    const cleanDb = createDb(databaseUrl(cleanDatabaseName));
    await migrate(cleanDb.db, { migrationsFolder: migrationFolder });
    await cleanDb.client.end();
    cleanClient = postgres(databaseUrl(cleanDatabaseName), { max: 1 });

    upgradeClient = postgres(databaseUrl(upgradeDatabaseName), { max: 1 });
    const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 12)) await runMigrationSql(upgradeClient, `${entry.tag}.sql`);
    [{ id: upgradeProjectId }] = await upgradeClient`insert into projects (title) values ('Slice 12 project') returning id`;
    [{ id: upgradePaperId }] = await upgradeClient`insert into papers (project_id, title) values (${upgradeProjectId}, 'Legacy paper') returning id`;
    await upgradeClient`insert into screening_decisions (project_id, paper_id, stage, decision) values (${upgradeProjectId}, ${upgradePaperId}, 'title_abstract', 'include')`;
    await upgradeClient`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${upgradeProjectId}, ${upgradePaperId}, 'include')`;
    await runMigrationSql(upgradeClient, "0013_full_text_retrieval.sql");
    await runMigrationSql(upgradeClient, "0014_full_text_documents.sql");

    rollbackClient = postgres(databaseUrl(rollbackDatabaseName), { max: 1 });
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 12)) await runMigrationSql(rollbackClient, `${entry.tag}.sql`);
    const [{ id: rollbackProjectId }] = await rollbackClient`insert into projects (title) values ('Slice 13 rollback project') returning id`;
    const [{ id: rollbackPaperId }] = await rollbackClient`insert into papers (project_id, title) values (${rollbackProjectId}, 'Rollback paper') returning id`;
    await rollbackClient`insert into screening_decisions (project_id, paper_id, stage, decision) values (${rollbackProjectId}, ${rollbackPaperId}, 'title_abstract', 'include')`;
    await rollbackClient`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${rollbackProjectId}, ${rollbackPaperId}, 'include')`;
  }, 120_000);

  afterAll(async () => {
    await cleanClient?.end();
    await upgradeClient?.end();
    await rollbackClient?.end();
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      if (cleanCreated) await admin.unsafe(`drop database if exists "${cleanDatabaseName}" with (force)`);
      if (upgradeCreated) await admin.unsafe(`drop database if exists "${upgradeDatabaseName}" with (force)`);
      if (rollbackCreated) await admin.unsafe(`drop database if exists "${rollbackDatabaseName}" with (force)`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  it("creates the document extraction tables and applies the current migration chain cleanly", async () => {
    expect(await cleanClient!`select count(*)::integer as count from drizzle.__drizzle_migrations`).toEqual([{ count: 21 }]);
    expect(await cleanClient!`select to_regclass('public.full_text_retrieval_attempts') as table_name`).toEqual([{ table_name: "full_text_retrieval_attempts" }]);
    expect(await cleanClient!`select to_regclass('public.full_text_documents') as table_name`).toEqual([{ table_name: "full_text_documents" }]);
    expect(await cleanClient!`select to_regclass('public.paper_full_text_preferences') as table_name`).toEqual([{ table_name: "paper_full_text_preferences" }]);
    expect(await cleanClient!`select count(*)::integer as count from full_text_retrieval_attempts`).toEqual([{ count: 0 }]);
  });

  it("preserves legacy full-text history without synthesizing retrieval attempts", async () => {
    expect(await upgradeClient!`select count(*)::integer as count from full_text_screening_decisions`).toEqual([{ count: 1 }]);
    expect(await upgradeClient!`select count(*)::integer as count from full_text_retrieval_attempts`).toEqual([{ count: 0 }]);
    expect(await upgradeClient!`select count(*)::integer as count from full_text_documents`).toEqual([{ count: 0 }]);
    expect(await upgradeClient!`select decision from full_text_screening_decisions`).toEqual([{ decision: "include" }]);
    const upgradedDb = createDb(databaseUrl(upgradeDatabaseName));
    try {
      const status = await createReviewServices(upgradedDb.db).getPaperReviewStatus(upgradeProjectId, upgradePaperId);
      expect(status.finalEligibility).toBe("included");
      expect(status.fullTextRetrievalState).toBe("not_sought");
      expect(status.everRetrieved).toBe(false);
      expect(status.warnings).toContain("legacy_full_text_decision_without_retrieval_record");
    } finally {
      await upgradedDb.client.end();
    }
  });

  it("rolls back the complete Slice 14 migration atomically", async () => {
    await expect(rollbackClient!.begin(async (tx) => {
      await runMigrationSql(tx, "0013_full_text_retrieval.sql");
      await runMigrationSql(tx, "0014_full_text_documents.sql");
      throw new Error("rollback sentinel");
    })).rejects.toThrow("rollback sentinel");
    expect(await rollbackClient!`select to_regclass('public.full_text_retrieval_attempts') as table_name`).toEqual([{ table_name: null }]);
    expect(await rollbackClient!`select to_regclass('public.full_text_documents') as table_name`).toEqual([{ table_name: null }]);
    expect(await rollbackClient!`select count(*)::integer as count from full_text_screening_decisions`).toEqual([{ count: 1 }]);
  });
});
