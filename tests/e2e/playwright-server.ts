import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../../src/db/client";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@localhost:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseMarkerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
const nextBin = path.resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const requiredSchema = {
  research_questions: ["id", "project_id", "identifier", "label", "sort_order", "created_at", "updated_at", "archived_at"],
  search_sources: ["id", "project_id", "source_key", "display_name", "created_at", "updated_at", "archived_at"],
  search_strategies: ["id", "project_id", "search_source_id", "name", "query_text", "created_at", "updated_at", "archived_at"],
  search_runs: ["id", "sequence", "project_id", "search_source_id", "strategy_id", "query_text", "reported_result_count", "executed_at", "created_at"],
  retrieved_records: ["id", "project_id", "search_run_id", "search_source_id", "source_record_id", "title", "doi", "retrieved_at", "created_at"],
  retrieved_record_matches: ["id", "sequence", "project_id", "retrieved_record_id", "paper_id", "action", "created_at"],
  retrieved_record_deduplication_decisions: ["id", "sequence", "project_id", "left_retrieved_record_id", "right_retrieved_record_id", "decision", "created_at"],
} as const;

type MigrationEntry = { idx: number; tag: string; when: number };
type MigrationJournal = { entries: MigrationEntry[] };
type MigrationRow = { id: number; hash: string; created_at: number | string };
type SchemaRow = { table_name: string; column_name: string };

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function readExpectedMigrations() {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as MigrationJournal;
  return {
    journal,
    migrations: journal.entries.map((entry) => {
      const sql = fs.readFileSync(path.join(migrationFolder, `${entry.tag}.sql`));
      return { ...entry, hash: createHash("sha256").update(sql).digest("hex") };
    }),
  };
}

function createDatabaseName() {
  return `litreview_playwright_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function waitForProcess(childProcess: ReturnType<typeof spawn>) {
  return new Promise<number>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function assertSchema(client: postgres.Sql, databaseName: string) {
  const { migrations } = readExpectedMigrations();
  const expectedLatest = migrations.at(-1);
  if (!expectedLatest || expectedLatest.tag !== "0011_deduplication_flow") {
    throw new Error(`Playwright schema assertion cannot run: migration chain must end at 0011_deduplication_flow, found ${expectedLatest?.tag ?? "none"}`);
  }

  const migrationRows = await client.unsafe("select id, hash, created_at from drizzle.__drizzle_migrations order by id") as unknown as MigrationRow[];
  const migrationMismatches = migrations.flatMap((expected, index) => {
    const actual = migrationRows[index];
    if (!actual || Number(actual.id) !== index + 1 || actual.hash !== expected.hash || Number(actual.created_at) !== expected.when) {
      return [`${expected.tag} (expected id/hash/timestamp, got ${actual ? `${actual.id}/${actual.hash}/${actual.created_at}` : "missing"})`];
    }
    return [];
  });
  if (migrationRows.length !== migrations.length || migrationMismatches.length > 0) {
    throw new Error(`Playwright schema assertion failed for ${databaseName}: expected the exact ${migrations.length}-migration chain through 0011_deduplication_flow; journal rows=${migrationRows.length}; mismatches=${migrationMismatches.join(", ") || "none"}`);
  }

  const tableNames = Object.keys(requiredSchema);
  const quotedTableNames = tableNames.map((tableName) => `'${tableName}'`).join(", ");
  const schemaRows = await client.unsafe(`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in (${quotedTableNames})`) as unknown as SchemaRow[];
  const actualColumns = new Map<string, Set<string>>();
  for (const row of schemaRows) {
    const columns = actualColumns.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actualColumns.set(row.table_name, columns);
  }
  const missingTables = tableNames.filter((tableName) => !actualColumns.has(tableName));
  const missingColumns = Object.entries(requiredSchema).flatMap(([tableName, columns]) => columns.filter((columnName) => !actualColumns.get(tableName)?.has(columnName)).map((columnName) => `${tableName}.${columnName}`));
  const legacyColumns = await client.unsafe("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'research_question'") as unknown as Array<{ column_name: string }>;
  if (missingTables.length > 0 || missingColumns.length > 0 || legacyColumns.length > 0) {
    throw new Error(`Playwright schema assertion failed for ${databaseName}: expected current schema through 0011_deduplication_flow; missing tables=${missingTables.join(", ") || "none"}; missing columns=${missingColumns.join(", ") || "none"}; retired columns=${legacyColumns.map((row) => `projects.${row.column_name}`).join(", ") || "none"}`);
  }
}

async function main() {
  const adminUrl = process.env.PLAYWRIGHT_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const databaseName = createDatabaseName();
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const testDatabaseUrl = databaseUrl.toString();
  const admin = postgres(adminUrl, { max: 1 });
  let child: ReturnType<typeof spawn> | undefined;
  let requestedExitCode: number | undefined;

  const cleanup = async () => {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
    fs.rmSync(databaseMarkerPath, { force: true });
    await admin.end();
  };

  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    fs.mkdirSync(path.dirname(databaseMarkerPath), { recursive: true });
    fs.writeFileSync(databaseMarkerPath, JSON.stringify({ adminUrl, databaseName }), "utf8");
    const database = createDb(testDatabaseUrl);
    try {
      await migrate(database.db, { migrationsFolder: migrationFolder });
      await assertSchema(database.client, databaseName);
    } finally {
      await database.client.end();
    }
    console.error(`[playwright-db] ready: ${databaseName}; migrations through 0011_deduplication_flow verified`);

    child = spawn(process.execPath, [nextBin, "build"], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
    const buildExitCode = await waitForProcess(child);
    child = undefined;
    if (buildExitCode !== 0) throw new Error(`Next production build failed with exit code ${buildExitCode}`);

    child = spawn(process.execPath, [nextBin, "start"], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
    const requestStop = (code: number) => {
      requestedExitCode = code;
      if (child?.exitCode === null) child.kill("SIGTERM");
    };
    process.once("SIGINT", () => requestStop(130));
    process.once("SIGTERM", () => requestStop(143));
    const childExitCode = await waitForProcess(child);
    await cleanup();
    process.exitCode = requestedExitCode ?? childExitCode;
  } catch (error) {
    console.error(error);
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error(`[playwright-db] cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    process.exitCode = 1;
  }
}

void main();
