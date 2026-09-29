import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";

const baseUrl = resolveDatabaseUrl();
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const migration0035Path = path.join(migrationFolder, "0035_retrieved_record_run_order.sql");
const migration0036Path = path.join(migrationFolder, "0036_ai_synthesis_preparation_history.sql");
const migration0035Hash = createHash("sha256").update(fs.readFileSync(migration0035Path)).digest("hex");
const migration0036Hash = createHash("sha256").update(fs.readFileSync(migration0036Path)).digest("hex");
const historyIndexName = "ai_synthesis_requests_project_preparation_created_id_idx";

function databaseUrl(name: string) {
  const url = new URL(baseUrl);
  url.hostname = "127.0.0.1";
  url.pathname = "/" + name;
  return url.toString();
}

async function freshDatabase(prefix: string) {
  const name = prefix + "_" + Date.now() + "_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe('create database "' + name + '"');
  return { name, admin, url: databaseUrl(name) };
}

function createSlice46MigrationFolder() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "litreview-slice47-slice46-baseline-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, {
    recursive: true,
    filter: (source) => !["0036_ai_synthesis_preparation_history.sql", "0036_snapshot.json"].includes(path.basename(source)),
  });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
  fs.writeFileSync(
    journalPath,
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 35) }, null, 2) + "\n",
    "utf8",
  );
  return { tempRoot, folder: target };
}

describe("Slice 47 AI synthesis history index migration", () => {
  it("installs the index on a fresh schema and forward from the exact Slice 46 tail", async () => {
    const fresh = await freshDatabase("slice47_fresh");
    const forward = await freshDatabase("slice47_forward");
    const slice46 = createSlice46MigrationFolder();
    const freshApp = createDb(fresh.url);
    const forwardApp = createDb(forward.url);
    try {
      await migrate(freshApp.db, { migrationsFolder: migrationFolder });
      const [freshIndex] = await freshApp.client.unsafe(
        "select pg_get_indexdef(to_regclass('public." + historyIndexName + "')) as definition",
      );
      const [freshTail] = await freshApp.client.unsafe(
        "select id, hash from drizzle.__drizzle_migrations order by id desc limit 1",
      );
      expect(freshIndex.definition).toContain(
        "(project_id, preparation_id, created_at DESC NULLS LAST, id DESC NULLS LAST)",
      );
      expect(Number(freshTail.id)).toBe(37);
      expect(freshTail.hash).toBe(migration0036Hash);

      await migrate(forwardApp.db, { migrationsFolder: slice46.folder });
      const [slice46Tail] = await forwardApp.client.unsafe(
        "select id, hash from drizzle.__drizzle_migrations order by id desc limit 1",
      );
      const [beforeIndex] = await forwardApp.client.unsafe(
        "select to_regclass('public." + historyIndexName + "') as index_name",
      );
      expect(Number(slice46Tail.id)).toBe(36);
      expect(slice46Tail.hash).toBe(migration0035Hash);
      expect(beforeIndex.index_name).toBeNull();

      await migrate(forwardApp.db, { migrationsFolder: migrationFolder });
      const [forwardIndex] = await forwardApp.client.unsafe(
        "select pg_get_indexdef(to_regclass('public." + historyIndexName + "')) as definition",
      );
      const [forwardTail] = await forwardApp.client.unsafe(
        "select hash from drizzle.__drizzle_migrations order by id desc limit 1",
      );
      expect(forwardIndex.definition).toContain(
        "(project_id, preparation_id, created_at DESC NULLS LAST, id DESC NULLS LAST)",
      );
      expect(forwardTail.hash).toBe(migration0036Hash);
    } finally {
      await freshApp.client.end();
      await forwardApp.client.end();
      await fresh.admin.unsafe('drop database if exists "' + fresh.name + '" with (force)');
      await forward.admin.unsafe('drop database if exists "' + forward.name + '" with (force)');
      await fresh.admin.end();
      await forward.admin.end();
      fs.rmSync(slice46.tempRoot, { recursive: true, force: true });
    }
  }, 120000);
});
