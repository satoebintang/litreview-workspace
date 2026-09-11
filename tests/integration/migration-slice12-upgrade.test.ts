import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const cleanDatabaseName = `slice12_clean_migration_${Date.now()}`;
const upgradeDatabaseName = `slice12_upgrade_migration_${Date.now()}`;

function databaseUrl(databaseName: string) {
  const url = new URL(BASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function runMigrationSql(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement);
}

describe("Slice 12 migration boundaries", () => {
  let cleanClient: postgres.Sql | undefined;
  let upgradeClient: postgres.Sql | undefined;
  let cleanCreated = false;
  let upgradeCreated = false;

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      await admin.unsafe(`create database "${cleanDatabaseName}"`);
      cleanCreated = true;
      await admin.unsafe(`create database "${upgradeDatabaseName}"`);
      upgradeCreated = true;
    } finally {
      await admin.end();
    }

    const cleanDb = createDb(databaseUrl(cleanDatabaseName));
    await migrate(cleanDb.db, { migrationsFolder: migrationFolder });
    await cleanDb.client.end();
    cleanClient = postgres(databaseUrl(cleanDatabaseName), { max: 1 });

    upgradeClient = postgres(databaseUrl(upgradeDatabaseName), { max: 1 });
    const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 11)) await runMigrationSql(upgradeClient, `${entry.tag}.sql`);
    const [{ id: projectId }] = await upgradeClient`insert into projects (title) values ('Slice 11 project') returning id`;
    const [{ id: paperId }] = await upgradeClient`insert into papers (project_id, title) values (${projectId}, 'Slice 11 paper') returning id`;
    await runMigrationSql(upgradeClient, "0012_full_text_screening.sql");
    const preserved = await upgradeClient`select p.id as project_id, pa.id as paper_id from projects p join papers pa on pa.project_id = p.id where p.id = ${projectId} and pa.id = ${paperId}`;
    expect(preserved).toEqual([{ project_id: projectId, paper_id: paperId }]);
  }, 120_000);

  afterAll(async () => {
    await cleanClient?.end();
    await upgradeClient?.end();
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      if (cleanCreated) await admin.unsafe(`drop database if exists "${cleanDatabaseName}" with (force)`);
      if (upgradeCreated) await admin.unsafe(`drop database if exists "${upgradeDatabaseName}" with (force)`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  it("applies a clean database through the current journal while preserving the 0012 boundary", async () => {
    expect(await cleanClient!`select count(*)::integer as count from drizzle.__drizzle_migrations`).toEqual([{ count: 20 }]);
    expect(await cleanClient!`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'full_text_screening_decisions' order by ordinal_position`).toHaveLength(8);
    expect(await cleanClient!`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'full_text_retrieval_attempts' order by ordinal_position`).toHaveLength(10);
  });

  it("upgrades a representative Slice 11 schema through 0012 without losing existing Paper data", async () => {
    expect(await upgradeClient!`select count(*)::integer as count from projects`).toEqual([{ count: 1 }]);
    expect(await upgradeClient!`select count(*)::integer as count from papers`).toEqual([{ count: 1 }]);
    expect(await upgradeClient!`select to_regclass('public.full_text_screening_criteria') as table_name`).toEqual([{ table_name: "full_text_screening_criteria" }]);
    expect(await upgradeClient!`select to_regclass('public.full_text_screening_decisions') as table_name`).toEqual([{ table_name: "full_text_screening_decisions" }]);
  });
});
