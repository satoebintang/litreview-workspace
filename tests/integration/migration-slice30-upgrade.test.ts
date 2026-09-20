import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const SLICE30_TABLES = [
  "doi_lookup_requests",
  "bibliographic_metadata_fetches",
  "doi_lookup_dispatches",
  "bibliographic_metadata_fetch_results",
  "bibliographic_metadata_result_authors",
  "doi_lookup_resolutions",
  "bibliographic_metadata_http_attempts",
] as const;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

function historicalFolder(lastIndex: number) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "slice30-historical-"));
  const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  for (const entry of entries) fs.copyFileSync(path.join(migrationFolder, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  fs.writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

async function applySql(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement);
}

async function freshDatabase(prefix: string) {
  const name = `${prefix}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(BASE_URL, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  return { name, admin, url: databaseUrl(name) };
}

describe("Slice 30 migration boundary", () => {
  it("applies the complete chain through 0029 with empty DOI lookup history", async () => {
    const createdDatabase = await freshDatabase("slice30_fresh");
    let created: ReturnType<typeof createDb> | undefined;
    try {
      created = createDb(createdDatabase.url);
      await migrate(created.db, { migrationsFolder: migrationFolder });
      const [latest] = await created.client`select id, hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(Number(latest.id)).toBe(30);
      expect(latest.hash).toBe(createHash("sha256").update(fs.readFileSync(path.join(migrationFolder, "0029_doi_metadata_lookup.sql"))).digest("hex"));
      for (const table of SLICE30_TABLES) {
        const [row] = await created.client.unsafe(`select count(*)::integer as count from "${table}"`) as unknown as Array<{ count: number }>;
        expect(Number(row.count), `${table} should start empty`).toBe(0);
      }
    } finally {
      if (created) await created.client.end();
      await createdDatabase.admin.unsafe(`drop database if exists "${createdDatabase.name}"`);
      await createdDatabase.admin.end();
    }
  }, 120_000);

  it("upgrades populated 0028 state without rewriting existing Paper rows", async () => {
    const createdDatabase = await freshDatabase("slice30_populated");
    const folder = historicalFolder(28);
    let created: ReturnType<typeof createDb> | undefined;
    try {
      created = createDb(createdDatabase.url);
      await migrate(created.db, { migrationsFolder: folder });
      const review = createReviewServices(created.db);
      const project = await review.createProject({ title: "Slice 30 populated upgrade" });
      const paper = await review.addPaper(project.id, { title: "Existing paper remains unchanged", authors: ["Researcher"], publicationYear: 2024, venue: "Journal" });
      const before = await created.client`select * from papers where id=${paper.id}::uuid`;
      await applySql(created.client, "0029_doi_metadata_lookup.sql");
      expect(await created.client`select * from papers where id=${paper.id}::uuid`).toEqual(before);
      const [columns] = await created.client`select count(*)::integer as count from information_schema.columns where table_schema='public' and table_name='bibliographic_metadata_fetch_results' and column_name='source_evidence'`;
      expect(Number(columns.count)).toBe(0);
    } finally {
      if (created) await created.client.end();
      fs.rmSync(folder, { recursive: true, force: true });
      await createdDatabase.admin.unsafe(`drop database if exists "${createdDatabase.name}"`);
      await createdDatabase.admin.end();
    }
  }, 120_000);
});
