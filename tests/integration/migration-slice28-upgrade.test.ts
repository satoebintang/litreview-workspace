import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function runMigration(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement);
}

function createSlice28MigrationFolder() {
  const historicalFolder = fs.mkdtempSync(path.join(os.tmpdir(), "slice28-migrations-"));
  const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const slice28Entries = journal.entries.filter((entry) => entry.idx <= 27);
  fs.mkdirSync(path.join(historicalFolder, "meta"), { recursive: true });
  for (const entry of slice28Entries) {
    fs.copyFileSync(path.join(migrationFolder, `${entry.tag}.sql`), path.join(historicalFolder, `${entry.tag}.sql`));
  }
  fs.writeFileSync(path.join(historicalFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: slice28Entries }));
  return historicalFolder;
}

describe("Slice 28 migration boundaries", () => {
  it("applies 0000 -> 0027 to a fresh database", async () => {
    const name = `slice28_fresh_${Date.now()}`;
    const slice28MigrationFolder = createSlice28MigrationFolder();
    const admin = postgres(BASE_URL, { max: 1 });
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`create database "${name}"`);
      db = createDb(databaseUrl(name));
      await migrate(db.db, { migrationsFolder: slice28MigrationFolder });
      const [latest] = await db.client`select id, hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(Number(latest.id)).toBe(28);
      const migrationHash = createHash("sha256").update(fs.readFileSync(path.join(migrationFolder, "0027_pdf_intake_metadata.sql"))).digest("hex");
      expect(latest.hash).toBe(migrationHash);
      const tables = await db.client`select table_name from information_schema.tables where table_schema='public' and table_name in ('pdf_intakes', 'pdf_intake_metadata_results', 'pdf_intake_metadata_fields', 'pdf_intake_resolutions') order by table_name`;
      expect(tables.map((row) => String(row.table_name))).toEqual([
        "pdf_intake_metadata_fields",
        "pdf_intake_metadata_results",
        "pdf_intake_resolutions",
        "pdf_intakes",
      ]);
    } finally {
      if (db) await db.client.end();
      fs.rmSync(slice28MigrationFolder, { recursive: true, force: true });
      await admin.unsafe(`drop database if exists "${name}"`);
      await admin.end();
    }
  });

  it("applies published populated 0026 -> 0027 without rewriting existing Paper data", async () => {
    const name = `slice28_populated_${Date.now()}`;
    const admin = postgres(BASE_URL, { max: 1 });
    let client: postgres.Sql | undefined;
    try {
      await admin.unsafe(`create database "${name}"`);
      client = postgres(databaseUrl(name), { max: 1 });
      const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      for (const entry of journal.entries.filter((candidate) => candidate.idx <= 25)) await runMigration(client, `${entry.tag}.sql`);
      const [{ id: projectId }] = await client`insert into projects (title) values ('Slice 28 populated upgrade') returning id`;
      const [{ id: paperId }] = await client`
        insert into papers (project_id, title, authors, publication_year, venue, doi, abstract)
        values (${projectId}, 'Preserved Paper', array['Ada Lovelace'], 2024, 'Journal', '10.1234/preserved', 'Preserved abstract')
        returning id
      `;
      await runMigration(client, "0026_bibliographic_intake.sql");
      const [before] = await client`select project_id, title, authors, publication_year, venue, doi, abstract from papers where id=${paperId}`;
      await runMigration(client, "0027_pdf_intake_metadata.sql");
      const [after] = await client`select project_id, title, authors, publication_year, venue, doi, abstract from papers where id=${paperId}`;
      expect(after).toEqual(before);
      const [intakeTable] = await client`select to_regclass('public.pdf_intakes') as table_name`;
      expect(intakeTable.table_name).toBe("pdf_intakes");
      const publishedEntries = journal.entries.filter((entry) => entry.idx <= 27);
      expect(publishedEntries.at(-1)?.tag).toBe("0027_pdf_intake_metadata");
    } finally {
      if (client) await client.end();
      await admin.unsafe(`drop database if exists "${name}"`);
      await admin.end();
    }
  });
});
