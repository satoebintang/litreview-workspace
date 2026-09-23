import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../../src/db/client";
import { resolveDatabaseUrl } from "../../src/db/config";
import {
  buildMigrationManifest,
  comparePublicSchema,
  derivePublicSchema,
  formatPublicSchemaDiff,
  getLatestSnapshotPath,
  getMigrationRowMismatches,
  type DrizzleSnapshot,
  type MigrationJournal,
  type MigrationRow,
} from "./playwright-schema-contract";

const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseMarkerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
const nextBin = path.resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const serverHost = "127.0.0.1";
const serverPort = 3000;
const readinessUrl = `http://${serverHost}:${serverPort}/`;
const readinessTimeoutMs = 300_000;

type SchemaRow = { table_name: string; column_name: string };

function formatError(error: unknown) {
  const message = error instanceof Error ? error.name + ": " + error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]");
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function readExpectedMigrations() {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as MigrationJournal;
  const migrations = buildMigrationManifest(journal, (tag) => fs.readFileSync(path.join(migrationFolder, `${tag}.sql`)));
  const snapshotPath = getLatestSnapshotPath(migrationFolder, migrations);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as DrizzleSnapshot;
  return {
    journal,
    migrations,
    snapshotPath,
    expectedSchema: derivePublicSchema(snapshot),
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
  const { migrations, snapshotPath, expectedSchema } = readExpectedMigrations();
  const expectedLatest = migrations.at(-1);
  if (!expectedLatest) {
    throw new Error("Playwright schema assertion cannot run: migration journal has no tail entry");
  }

  const migrationRows = await client.unsafe("select id, hash, created_at from drizzle.__drizzle_migrations order by id") as unknown as MigrationRow[];
  const migrationMismatches = getMigrationRowMismatches(migrations, migrationRows);
  if (migrationRows.length !== migrations.length || migrationMismatches.length > 0) {
    throw new Error(`Playwright schema assertion failed for ${databaseName}: expected the exact ${migrations.length}-migration chain through ${expectedLatest.tag}; journal rows=${migrationRows.length}; mismatches=${migrationMismatches.join(", ") || "none"}`);
  }

  const schemaRows = await client.unsafe("select columns.table_name, columns.column_name from information_schema.columns columns join information_schema.tables catalog_tables on catalog_tables.table_schema = columns.table_schema and catalog_tables.table_name = columns.table_name where columns.table_schema = 'public' and catalog_tables.table_type = 'BASE TABLE' order by columns.table_name, columns.ordinal_position") as unknown as SchemaRow[];
  const schemaMismatches = formatPublicSchemaDiff(comparePublicSchema(expectedSchema, schemaRows));
  const legacyColumns = await client.unsafe("select table_name, column_name from information_schema.columns where table_schema = 'public' and ((table_name = 'projects' and column_name = 'research_question') or (table_name = 'manuscript_prose_blocks' and column_name in ('text', 'updated_at')))") as unknown as Array<{ table_name: string; column_name: string }>;
  if (schemaMismatches.length > 0 || legacyColumns.length > 0) {
    throw new Error(`Playwright schema assertion failed for ${databaseName}: expected public tables and columns from ${path.basename(snapshotPath)} through ${expectedLatest.tag}; schema differences=${schemaMismatches.join(", ") || "none"}; retired columns=${legacyColumns.map((row) => `${row.table_name}.${row.column_name}`).join(", ") || "none"}`);
  }
}

async function main() {
  let adminUrl: string;
  let databaseUrl: URL;
  try {
    adminUrl = resolveDatabaseUrl(process.env.PLAYWRIGHT_ADMIN_DATABASE_URL, process.env.DATABASE_URL);
    databaseUrl = new URL(adminUrl);
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
    return;
  }
  const databaseName = createDatabaseName();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "litreview_playwright_storage_"));
  databaseUrl.pathname = `/${databaseName}`;
  const testDatabaseUrl = databaseUrl.toString();
  const nextEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    PORT: String(serverPort),
    HOSTNAME: serverHost,
    LITREVIEW_DOCUMENT_STORAGE_ROOT: storageRoot,
    AI_SYNTHESIS_TEST_PROVIDER: "fake",
    AI_EXTRACTION_TEST_PROVIDER: "fake",
    CROSSREF_MAILTO: "test@example.com",
    PLAYWRIGHT_TEST: "1",
  };
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
    fs.writeFileSync(databaseMarkerPath, JSON.stringify({ databaseName, storageRoot }), "utf8");
    const database = createDb(testDatabaseUrl);
    try {
      await migrate(database.db, { migrationsFolder: migrationFolder });
      await assertSchema(database.client, databaseName);
    } finally {
      await database.client.end();
    }
  console.error(`[playwright-db] ready: ${databaseName}; migration and public schema tail verified; storage=${storageRoot}`);

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
    console.error(formatError(error));
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error(`[playwright-db] cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
