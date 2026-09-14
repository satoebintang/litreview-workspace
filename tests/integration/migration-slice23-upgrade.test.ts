import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice23_upgrade_${Date.now()}`;

function databaseUrl(name: string) { const url = new URL(BASE_URL); url.hostname = "127.0.0.1"; url.pathname = `/${name}`; return url.toString(); }
async function runMigration(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  const statements = content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean);
  for (const [index, statement] of statements.entries()) {
    try { await client.unsafe(statement); }
    catch (error) { const detail = error as { position?: unknown }; throw new Error(`${filename} statement ${index}: ${error instanceof Error ? error.message : String(error)} position=${String(detail.position ?? "")} :: ${statement}`); }
  }
}

describe("Slice 23 migration 0021 -> 0022", () => {
  let client: postgres.Sql | undefined;
  let databaseCreated = false;
  let projectId = "";
  let manuscriptId = "";
  let sectionId = "";
  let itemId = "";

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1 });
    try { await admin.unsafe(`create database "${databaseName}"`); databaseCreated = true; } finally { await admin.end(); }
    client = postgres(databaseUrl(databaseName), { max: 1 });
    const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 21)) await runMigration(client, `${entry.tag}.sql`);
    await runMigration(client, "0022_manuscript_editorial_review.sql");
    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 23 upgrade') returning id`;
    [{ id: manuscriptId }] = await client`insert into manuscripts (project_id, title, is_default) values (${projectId}, 'Manuscript', true) returning id`;
    [{ id: sectionId }] = await client`insert into manuscript_sections (project_id, manuscript_id, title, section_type, sort_order) values (${projectId}, ${manuscriptId}, 'Discussion', 'discussion', 0) returning id`;
    await client.begin(async (tx) => {
      [{ id: itemId }] = await tx`insert into manuscript_section_items (project_id, manuscript_id, section_id, item_type, sort_order) values (${projectId}, ${manuscriptId}, ${sectionId}, 'prose', 0) returning id`;
      await tx`insert into manuscript_prose_blocks (id, project_id, manuscript_id, section_id, section_item_id, item_type, text) values (${itemId}, ${projectId}, ${manuscriptId}, ${sectionId}, ${itemId}, 'prose', ${"  exact\ntext  "})`;
    });
  });

  afterAll(async () => {
    if (client) await client.end();
    if (databaseCreated) { const admin = postgres(BASE_URL, { max: 1 }); try { await admin.unsafe(`drop database if exists "${databaseName}"`); } finally { await admin.end(); } }
  });

  it("creates the editorial tables on the released 0021 chain", async () => {
    if (!client) throw new Error("Database client missing");
    const tables = await client`select to_regclass('public.manuscript_review_threads') as threads, to_regclass('public.manuscript_review_events') as events`;
    expect(tables[0].threads).toBe("manuscript_review_threads");
    expect(tables[0].events).toBe("manuscript_review_events");
  });

  it("requires exact opening context and an opening event at commit", async () => {
    if (!client) throw new Error("Database client missing");
    let thread: { id: string };
    await client.begin(async (tx) => {
      [thread] = await tx`
        insert into manuscript_review_threads
          (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_prose_text)
        values (${projectId}, ${manuscriptId}, ${sectionId}, ${itemId}, 'prose', 'Exact', ${"  exact\ntext  "})
        returning id
      `;
      await tx`insert into manuscript_review_events (project_id, thread_id, event_type, body) values (${projectId}, ${thread.id}, 'opened', 'Opening')`;
    });
    await expect(client`
      insert into manuscript_review_threads
        (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_prose_text)
      values (${projectId}, ${manuscriptId}, ${sectionId}, ${itemId}, 'prose', 'Forged', 'forged')
    `).rejects.toThrow(/exact persisted Prose text/i);
    await expect(client`
      insert into manuscript_review_threads
        (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_prose_text)
      values (${projectId}, ${manuscriptId}, ${sectionId}, ${itemId}, 'prose', 'No event', ${"  exact\ntext  "})
    `).rejects.toThrow(/exactly one opened|opened event/i);
  });
});
