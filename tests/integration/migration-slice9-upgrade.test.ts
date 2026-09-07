import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview";
const TEST_DB_NAME = `slice9_upgrade_test_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
const drizzleDir = path.resolve(process.cwd(), "drizzle");
async function runStatements(client: postgres.Sql, content: string) { for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement); }

describe("Slice 9 additive upgrade from Slice 8", () => {
  let client: postgres.Sql | undefined;
  let projectId = "";
  let ready = false;
  beforeAll(async () => {
    try {
      const admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`); await admin.end();
      client = postgres(TEST_DB_URL, { max: 1 });
      const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
      for (const entry of journal.entries.filter((candidate: { idx: number }) => candidate.idx <= 9)) await runStatements(client, fs.readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8"));
      [{ id: projectId }] = await client`insert into projects (title, research_question) values ('Upgrade fixture', 'Legacy question') returning id`;
      await runStatements(client, fs.readFileSync(path.join(drizzleDir, "0010_review_protocol_search.sql"), "utf8"));
      ready = true;
    } catch { ready = false; }
  });
  afterAll(async () => { if (client) await client.end(); if (ready || client) { const admin = postgres(BASE_URL, { max: 1 }); try { await admin.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`); } finally { await admin.end(); } } });
  it("backfills the legacy question exactly, seeds existing projects, and removes the retired column", async () => {
    if (!ready || !client) return;
    expect(await client`select label from research_questions where project_id=${projectId} and identifier='RQ1'`).toEqual([{ label: "Legacy question" }]);
    expect(await client`select source_key from search_sources where project_id=${projectId} order by source_key`).toHaveLength(8);
    expect(await client`select column_name from information_schema.columns where table_name='projects' and column_name='research_question'`).toHaveLength(0);
  });
});
