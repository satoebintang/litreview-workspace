import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";

const baseUrl = resolveDatabaseUrl();
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const migrationPath = path.join(migrationFolder, "0032_hot_path_hardening.sql");
const migrationHash = createHash("sha256").update(fs.readFileSync(migrationPath)).digest("hex");

function databaseUrl(name: string) {
  const url = new URL(baseUrl);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(prefix: string) {
  const name = `${prefix}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  return { name, admin, url: databaseUrl(name) };
}

function create0031MigrationFolder() {
  const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "litreview-slice34-0031-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, {
    recursive: true,
    filter: (source) => !["0032_hot_path_hardening.sql", "0032_snapshot.json"].includes(path.basename(source)),
  });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.tag !== "0032_hot_path_hardening");
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return { tempRoot, folder: target };
}

async function seedPopulatedDatabase(db: ReturnType<typeof createDb>["db"]) {
  const services = createReviewServices(db);
  const project = await services.createProject({ title: "Slice 34 populated migration fixture" });
  const [source] = await services.listSearchSources(project.id);
  if (!source) throw new Error("The project did not receive a default SearchSource");
  const strategy = await services.createSearchStrategy(project.id, {
    searchSourceId: source.id,
    name: "Slice 34 migration fixture",
    queryText: "migration preservation",
  });
  const run = await services.createSearchRun(project.id, {
    searchSourceId: source.id,
    sourceKeySnapshot: source.sourceKey,
    sourceDisplayNameSnapshot: source.displayName,
    strategyId: strategy.id,
    queryText: strategy.queryText,
    reportedResultCount: 3,
    executedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const addRecord = (input: { title: string; sourceRecordId: string; doi: string; publicationYear: number }) =>
    services.createRetrievedRecord(project.id, {
      ...input,
      searchSourceId: source.id,
      searchRunId: run.id,
      retrievedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  const left = await addRecord({
    title: "Preserved DOI fixture",
    sourceRecordId: "preserved-source-record-left",
    doi: "10.9000/slice34-preserved",
    publicationYear: 2024,
  });
  const right = await addRecord({
    title: "Preserved DOI fixture, alternate form",
    sourceRecordId: "preserved-source-record-right",
    doi: "https://doi.org/10.9000/slice34-preserved",
    publicationYear: 2024,
  });
  await addRecord({
    title: "Preserved unrelated fixture",
    sourceRecordId: "preserved-unrelated-record",
    doi: "10.9000/slice34-unrelated",
    publicationYear: 2022,
  });
  await services.decideDifferentWork(project.id, left.id, right.id, "Preserve exact deduplication history");
  return project.id;
}

async function researchDataFingerprint(db: ReturnType<typeof createDb>["db"], projectId: string) {
  const retrievedRecords = await db.execute(sql`
    select to_jsonb(record) as row
    from retrieved_records record
    where record.project_id = ${projectId}
    order by record.id
  `) as unknown as Array<{ row: unknown }>;
  const decisions = await db.execute(sql`
    select to_jsonb(decision) as row
    from retrieved_record_deduplication_decisions decision
    where decision.project_id = ${projectId}
    order by decision.sequence
  `) as unknown as Array<{ row: unknown }>;
  const rows = { retrievedRecords: retrievedRecords.map(({ row }) => row), decisions: decisions.map(({ row }) => row) };
  return {
    rowCounts: { retrievedRecords: retrievedRecords.length, decisions: decisions.length },
    sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
}

async function comparisonIndexState(db: ReturnType<typeof createDb>["db"]) {
  const rows = await db.execute(sql`
    select index_name, index_definition
    from (
      select c.relname as index_name, pg_get_indexdef(i.indexrelid) as index_definition
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname in (
        'retrieved_records_project_doi_comparison_idx',
        'retrieved_records_project_source_record_comparison_idx',
        'retrieved_records_project_title_comparison_idx'
      )
    ) definitions
    order by index_name
  `) as unknown as Array<{ index_name: string; index_definition: string }>;
  return new Map(rows.map(({ index_name, index_definition }) => [index_name, index_definition]));
}

describe("Slice 34 hot-path migration boundary", () => {
  it("applies the complete migration chain from a fresh database", async () => {
    const created = await freshDatabase("slice32_fresh");
    const db = createDb(created.url);
    try {
      await migrate(db.db, { migrationsFolder: migrationFolder });
      const [latest] = await db.client`select hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(latest.hash).toBe(migrationHash);
      const indexes = await comparisonIndexState(db.db);
      expect([...indexes.keys()]).toEqual([
        "retrieved_records_project_doi_comparison_idx",
        "retrieved_records_project_source_record_comparison_idx",
        "retrieved_records_project_title_comparison_idx",
      ]);
      expect(indexes.get("retrieved_records_project_doi_comparison_idx")).toContain("btrim(lower(regexp_replace(regexp_replace(btrim(doi)");
      expect(indexes.get("retrieved_records_project_source_record_comparison_idx")).toContain("(project_id, search_source_id, source_record_id)");
    } finally {
      await db.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}" with (force)`);
      await created.admin.end();
    }
  }, 120_000);

  it("upgrades populated 0031 data without changing records, history, or the title/year index", async () => {
    const created = await freshDatabase("slice32_populated");
    const beforeMigration = create0031MigrationFolder();
    const db = createDb(created.url);
    try {
      await migrate(db.db, { migrationsFolder: beforeMigration.folder });
      const projectId = await seedPopulatedDatabase(db.db);
      const beforeData = await researchDataFingerprint(db.db, projectId);
      const beforeIndexes = await comparisonIndexState(db.db);
      expect(beforeData.rowCounts).toEqual({ retrievedRecords: 3, decisions: 1 });
      expect(beforeIndexes.has("retrieved_records_project_title_comparison_idx")).toBe(true);
      expect(beforeIndexes.has("retrieved_records_project_source_record_comparison_idx")).toBe(false);

      await migrate(db.db, { migrationsFolder: migrationFolder });

      const [latest] = await db.client`select hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      const afterData = await researchDataFingerprint(db.db, projectId);
      const afterIndexes = await comparisonIndexState(db.db);
      expect(latest.hash).toBe(migrationHash);
      expect(afterData).toEqual(beforeData);
      expect(afterIndexes.get("retrieved_records_project_title_comparison_idx")).toBe(beforeIndexes.get("retrieved_records_project_title_comparison_idx"));
      expect(afterIndexes.has("retrieved_records_project_source_record_comparison_idx")).toBe(true);
      expect(afterIndexes.get("retrieved_records_project_doi_comparison_idx")).toContain("btrim(lower(regexp_replace(regexp_replace(btrim(doi)");
    } finally {
      await db.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}" with (force)`);
      await created.admin.end();
      fs.rmSync(beforeMigration.tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
