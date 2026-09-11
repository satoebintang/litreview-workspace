import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../../src/db/client";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseMarkerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
const nextBin = path.resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const serverHost = "127.0.0.1";
const serverPort = 3000;
const readinessUrl = `http://${serverHost}:${serverPort}/`;
const readinessTimeoutMs = 300_000;
const requiredSchema = {
  research_questions: ["id", "project_id", "identifier", "label", "sort_order", "created_at", "updated_at", "archived_at"],
  search_sources: ["id", "project_id", "source_key", "display_name", "created_at", "updated_at", "archived_at"],
  search_strategies: ["id", "project_id", "search_source_id", "name", "query_text", "created_at", "updated_at", "archived_at"],
  search_runs: ["id", "sequence", "project_id", "search_source_id", "strategy_id", "query_text", "reported_result_count", "executed_at", "created_at"],
  retrieved_records: ["id", "project_id", "search_run_id", "search_source_id", "source_record_id", "title", "doi", "retrieved_at", "created_at"],
  retrieved_record_matches: ["id", "sequence", "project_id", "retrieved_record_id", "paper_id", "action", "created_at"],
  retrieved_record_deduplication_decisions: ["id", "sequence", "project_id", "left_retrieved_record_id", "right_retrieved_record_id", "decision", "created_at"],
  full_text_screening_criteria: ["id", "project_id", "text", "sort_order", "created_at", "archived_at"],
  full_text_screening_decisions: ["id", "sequence", "project_id", "paper_id", "decision", "exclusion_criterion_id", "note", "created_at"],
  full_text_retrieval_attempts: ["id", "sequence", "project_id", "paper_id", "outcome", "method", "source_reference", "note", "attempted_at", "created_at"],
  full_text_documents: ["id", "project_id", "paper_id", "storage_key", "original_filename", "media_type", "byte_size", "sha256", "note", "created_at", "archived_at"],
  paper_full_text_preferences: ["project_id", "paper_id", "full_text_document_id", "updated_at"],
  document_text_extractions: ["id", "sequence", "project_id", "paper_id", "full_text_document_id", "extractor_key", "extractor_version", "algorithm_version", "status", "page_count", "character_count", "error_code", "error_message", "started_at", "completed_at", "created_at"],
  document_text_extraction_pages: ["id", "project_id", "paper_id", "document_text_extraction_id", "page_number", "status", "text", "character_count", "error_code", "error_message", "created_at"],
  evidence: ["id", "project_id", "paper_id", "full_text_document_id", "document_text_extraction_id", "source_text", "page_number", "extraction_start_offset", "extraction_end_offset", "note", "created_at", "updated_at"],
  evidence_review_decisions: ["id", "sequence", "project_id", "evidence_id", "decision", "note", "created_at"],
  evidence_annotations: ["id", "sequence", "project_id", "evidence_id", "body", "created_at"],
  evidence_labels: ["id", "project_id", "name", "description", "created_at", "archived_at"],
  evidence_label_events: ["id", "sequence", "project_id", "evidence_id", "label_id", "event", "created_at"],
  evidence_sets: ["id", "project_id", "name", "description", "created_at", "updated_at", "archived_at"],
  evidence_set_memberships: ["id", "project_id", "evidence_set_id", "evidence_id", "created_at"],
  evidence_set_composition_revisions: ["id", "sequence", "project_id", "evidence_set_id", "operation_kind", "created_at"],
  evidence_set_composition_members: ["project_id", "evidence_set_id", "composition_revision_id", "membership_id", "sort_order"],
  evidence_set_annotations: ["id", "sequence", "project_id", "evidence_set_id", "body", "created_at"],
  synthesis_preparations: ["id", "project_id", "evidence_set_id", "evidence_set_composition_revision_id", "extraction_field_id", "working_title", "working_note", "target_synthesis_statement_id", "status", "finalized_synthesis_revision_id", "created_at", "updated_at", "finalized_at", "abandoned_at"],
  synthesis_preparation_selections: ["project_id", "preparation_id", "extraction_revision_id", "created_at"],
  synthesis_interpretations: ["id", "sequence", "project_id", "synthesis_statement_id", "synthesis_revision_id", "convergence_state", "summary", "researcher_note", "created_at", "finalized_at"],
  synthesis_interpretation_limitations: ["id", "project_id", "interpretation_id", "sort_order", "category", "body", "created_at"],
  synthesis_interpretation_questions: ["id", "project_id", "interpretation_id", "sort_order", "body", "created_at"],
  synthesis_interpretation_contradictions: ["id", "project_id", "interpretation_id", "synthesis_revision_id", "sort_order", "left_extraction_revision_id", "right_extraction_revision_id", "note", "created_at"],
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

function databaseIdentity(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return `${url.protocol}//${url.hostname}:${url.port || "(default)"}/${url.pathname.slice(1)}`;
}

function shellArgument(value: string) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function logNextEnvironment(phase: string, args: string[], env: NodeJS.ProcessEnv) {
  console.error(`[playwright-next] ${phase} command: ${shellArgument(process.execPath)} ${args.map(shellArgument).join(" ")}`);
  console.error(`[playwright-next] ${phase} environment: DATABASE_URL=${databaseIdentity(env.DATABASE_URL ?? "")}; PORT=${env.PORT ?? "(unset)"}; HOSTNAME=${env.HOSTNAME ?? "(unset)"}; NODE_ENV=${env.NODE_ENV ?? "(unset)"}; CI=${env.CI ?? "(unset)"}`);
}

function waitForProcess(childProcess: ReturnType<typeof spawn>, phase: string) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return Promise.resolve(childProcess.exitCode ?? (childProcess.signalCode ? 1 : 0));
  return new Promise<number>((resolve, reject) => {
    childProcess.once("error", (error) => {
      console.error(`[playwright-next] ${phase} process error: ${error instanceof Error ? error.message : String(error)}`);
      reject(error);
    });
    childProcess.once("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      console.error(`[playwright-next] ${phase} process exited: code=${code ?? "null"}; signal=${signal ?? "none"}; effectiveExitCode=${exitCode}`);
      resolve(exitCode);
    });
  });
}

function spawnNext(phase: string, args: string[], env: NodeJS.ProcessEnv) {
  logNextEnvironment(phase, args, env);
  const childProcess = spawn(process.execPath, args, {
    env,
    stdio: "inherit",
  });
  return childProcess;
}

async function waitForReadiness(childProcess: ReturnType<typeof spawn>) {
  const startedAt = Date.now();
  let lastError = "no response";
  while (Date.now() - startedAt < readinessTimeoutMs) {
    if (childProcess.exitCode !== null) {
      throw new Error(`Next exited before readiness: code=${childProcess.exitCode ?? "null"}; signal=${childProcess.signalCode ?? "none"}; last readiness error=${lastError}`);
    }

    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(readinessUrl, { signal: controller.signal });
      await response.text();
      if (response.ok) {
        console.error(`[playwright-next] readiness confirmed: ${readinessUrl}; status=${response.status}; elapsedMs=${Date.now() - startedAt}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next readiness timed out after ${readinessTimeoutMs}ms at ${readinessUrl}; last readiness error=${lastError}; childExitCode=${childProcess.exitCode ?? "null"}`);
}

async function assertSchema(client: postgres.Sql, databaseName: string) {
  const { migrations } = readExpectedMigrations();
  const expectedLatest = migrations.at(-1);
  if (!expectedLatest || expectedLatest.tag !== "0019_synthesis_interpretation") {
    throw new Error(`Playwright schema assertion cannot run: migration chain must end at 0019_synthesis_interpretation, found ${expectedLatest?.tag ?? "none"}`);
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
    throw new Error(`Playwright schema assertion failed for ${databaseName}: expected the exact ${migrations.length}-migration chain through 0019_synthesis_interpretation; journal rows=${migrationRows.length}; mismatches=${migrationMismatches.join(", ") || "none"}`);
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
    throw new Error(`Playwright schema assertion failed for ${databaseName}: expected current schema through 0018_synthesis_preparations; missing tables=${missingTables.join(", ") || "none"}; missing columns=${missingColumns.join(", ") || "none"}; retired columns=${legacyColumns.map((row) => `projects.${row.column_name}`).join(", ") || "none"}`);
  }
}

async function main() {
  const adminUrl = process.env.PLAYWRIGHT_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const databaseName = createDatabaseName();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "litreview_playwright_storage_"));
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const testDatabaseUrl = databaseUrl.toString();
  const nextEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: testDatabaseUrl, PORT: String(serverPort), HOSTNAME: serverHost, LITREVIEW_DOCUMENT_STORAGE_ROOT: storageRoot };
  delete nextEnv.FORCE_COLOR;
  const admin = postgres(adminUrl, { max: 1 });
  let child: ReturnType<typeof spawn> | undefined;
  let requestedExitCode: number | undefined;
  const lifecycleStartedAt = Date.now();

  console.error(`[playwright-lifecycle] webServer command=npm run e2e:server; readiness=${readinessUrl}; reuseExistingServer=false; timeoutMs=${readinessTimeoutMs}`);
  console.error(`[playwright-db] admin database identity: ${databaseIdentity(adminUrl)}`);
  console.error(`[playwright-db] effective test database identity: ${databaseIdentity(testDatabaseUrl)}`);

  const cleanup = async () => {
    const processToStop = child;
    if (processToStop && processToStop.exitCode === null && processToStop.signalCode === null) {
      console.error(`[playwright-lifecycle] stopping Next process during cleanup: pid=${processToStop.pid ?? "unknown"}`);
      if (!processToStop.killed) processToStop.kill("SIGTERM");
      await waitForProcess(processToStop, "next-cleanup").catch((error) => console.error(`[playwright-lifecycle] Next cleanup wait failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    child = undefined;
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
    const resolvedStorageRoot = path.resolve(storageRoot);
    const resolvedTempRoot = path.resolve(os.tmpdir());
    if (!path.basename(resolvedStorageRoot).startsWith("litreview_playwright_storage_") || !resolvedStorageRoot.startsWith(`${resolvedTempRoot}${path.sep}`)) {
      throw new Error(`Refusing to remove unexpected Playwright storage root: ${resolvedStorageRoot}`);
    }
    fs.rmSync(resolvedStorageRoot, { recursive: true, force: true });
    fs.rmSync(databaseMarkerPath, { force: true });
    await admin.end();
    console.error(`[playwright-lifecycle] cleanup complete: database=${databaseName}; elapsedMs=${Date.now() - lifecycleStartedAt}`);
  };

  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    fs.mkdirSync(path.dirname(databaseMarkerPath), { recursive: true });
    fs.writeFileSync(databaseMarkerPath, JSON.stringify({ adminUrl, databaseName, storageRoot }), "utf8");
    const database = createDb(testDatabaseUrl);
    try {
      await migrate(database.db, { migrationsFolder: migrationFolder });
      await assertSchema(database.client, databaseName);
    } finally {
      await database.client.end();
    }
  console.error(`[playwright-db] ready: ${databaseName}; migrations through 0017_evidence_sets verified; storage=${storageRoot}`);

    child = spawnNext("next-build", [nextBin, "build"], nextEnv);
    const buildExitCode = await waitForProcess(child, "next-build");
    child = undefined;
    if (buildExitCode !== 0) throw new Error(`Next production build failed with exit code ${buildExitCode}`);

    child = spawnNext("next-start", [nextBin, "start", "--hostname", serverHost, "--port", String(serverPort)], nextEnv);
    await waitForReadiness(child);
    const requestStop = (code: number) => {
      requestedExitCode = code;
      if (child?.exitCode === null) child.kill("SIGTERM");
    };
    process.once("SIGINT", () => requestStop(130));
    process.once("SIGTERM", () => requestStop(143));
    const childExitCode = await waitForProcess(child, "next-start");
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
