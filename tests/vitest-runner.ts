import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { resolveDatabaseUrl } from "../src/db/config";

function formatError(error: unknown) {
  const message = error instanceof Error ? error.name + ": " + error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]");
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function main() {
  const databaseName = `litreview_vitest_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const adminUrl = resolveDatabaseUrl(undefined, process.env.DATABASE_URL);
  const testDatabaseUrl = new URL(adminUrl);
  testDatabaseUrl.pathname = `/${databaseName}`;
  const vitestBin = path.resolve(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    console.error(`[vitest-db] using disposable database ${databaseName}`);
    const child = spawn(process.execPath, [vitestBin, "run", ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testDatabaseUrl.toString() },
      stdio: "inherit",
      windowsHide: false,
    });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
