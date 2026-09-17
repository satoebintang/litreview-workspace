import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { serializeManuscriptMarkdown } from "@/application/manuscript-formatting";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice24_upgrade_${Date.now()}_${randomUUID().slice(0, 8)}`;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function runMigration(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  const statements = content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean);
  for (const [index, statement] of statements.entries()) {
    try {
      await client.unsafe(statement);
    } catch (error) {
      const detail = error as { position?: unknown };
      throw new Error(`${filename} statement ${index}: ${error instanceof Error ? error.message : String(error)} position=${String(detail.position ?? "")} :: ${statement}`);
    }
  }
}

describe("Slice 24 migration 0022 -> 0023", () => {
  let client: postgres.Sql | undefined;
  let databaseCreated = false;
  let projectId = "";
  let manuscriptId = "";
  let sectionId = "";
  let activeItemId = "";
  let removedItemId = "";
  const activeText = "  active baseline\nsecond line  ";
  const removedText = "Removed baseline";
  const activeUpdatedAt = "2026-09-01T00:00:00.000Z";
  const removedUpdatedAt = "2026-09-02T00:00:00.000Z";

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      await admin.unsafe(`create database "${databaseName}"`);
      databaseCreated = true;
    } finally {
      await admin.end();
    }

    client = postgres(databaseUrl(databaseName), { max: 1 });
    const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 22)) await runMigration(client, `${entry.tag}.sql`);

    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 24 upgrade') returning id`;
    [{ id: manuscriptId }] = await client`insert into manuscripts (project_id, title, is_default) values (${projectId}, 'Manuscript', true) returning id`;
    [{ id: sectionId }] = await client`insert into manuscript_sections (project_id, manuscript_id, title, section_type, sort_order) values (${projectId}, ${manuscriptId}, 'Discussion', 'discussion', 0) returning id`;
    await client.begin(async (tx) => {
      [{ id: activeItemId }] = await tx`insert into manuscript_section_items (project_id, manuscript_id, section_id, item_type, sort_order) values (${projectId}, ${manuscriptId}, ${sectionId}, 'prose', 0) returning id`;
      await tx`insert into manuscript_prose_blocks (id, project_id, manuscript_id, section_id, section_item_id, item_type, text, created_at, updated_at) values (${activeItemId}, ${projectId}, ${manuscriptId}, ${sectionId}, ${activeItemId}, 'prose', ${activeText}, '2026-08-01T00:00:00.000Z', ${activeUpdatedAt})`;
    });
    await client.begin(async (tx) => {
      [{ id: removedItemId }] = await tx`insert into manuscript_section_items (project_id, manuscript_id, section_id, item_type, sort_order, created_at) values (${projectId}, ${manuscriptId}, ${sectionId}, 'prose', 1, '2026-08-02T00:00:00.000Z') returning id`;
      await tx`insert into manuscript_prose_blocks (id, project_id, manuscript_id, section_id, section_item_id, item_type, text, created_at, updated_at) values (${removedItemId}, ${projectId}, ${manuscriptId}, ${sectionId}, ${removedItemId}, 'prose', ${removedText}, '2026-08-02T00:00:00.000Z', ${removedUpdatedAt})`;
      await tx`update manuscript_section_items set removed_at='2026-09-03T00:00:00.000Z' where project_id=${projectId} and id=${removedItemId}`;
    });
    await client.begin(async (tx) => {
      const [{ id: threadId }] = await tx`insert into manuscript_review_threads (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_prose_text) values (${projectId}, ${manuscriptId}, ${sectionId}, ${activeItemId}, 'prose', 'Legacy opening', ${activeText}) returning id`;
      await tx`insert into manuscript_review_events (project_id, thread_id, event_type, body) values (${projectId}, ${threadId}, 'opened', 'Opening before Slice 24')`;
    });

    await runMigration(client, "0023_manuscript_prose_revisions.sql");
  });

  afterAll(async () => {
    if (client) await client.end();
    if (databaseCreated) {
      const admin = postgres(BASE_URL, { max: 1 });
      try {
        await admin.unsafe(`drop database if exists "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  });

  it("backfills active and removed Prose exactly once while preserving stable identities and legacy thread NULL IDs", async () => {
    if (!client) throw new Error("Database client missing");
    const revisions = await client`select prose_block_id, prose_text, created_at from manuscript_prose_revisions where project_id=${projectId} order by prose_block_id`;
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => String(row.prose_block_id))).toEqual(expect.arrayContaining([activeItemId, removedItemId]));
    const activeRevision = revisions.find((row) => String(row.prose_block_id) === activeItemId)!;
    const removedRevision = revisions.find((row) => String(row.prose_block_id) === removedItemId)!;
    expect(String(activeRevision.prose_text)).toBe(activeText);
    expect(String(removedRevision.prose_text)).toBe(removedText);
    expect(new Date(activeRevision.created_at).toISOString()).toBe(activeUpdatedAt);
    expect(new Date(removedRevision.created_at).toISOString()).toBe(removedUpdatedAt);

    const identities = await client`select p.id, p.section_item_id, i.id as item_id, i.removed_at from manuscript_prose_blocks p join manuscript_section_items i on i.project_id=p.project_id and i.id=p.section_item_id where p.project_id=${projectId} order by p.id`;
    expect(identities.every((row) => String(row.id) === String(row.section_item_id) && String(row.id) === String(row.item_id))).toBe(true);
    expect(identities.find((row) => String(row.id) === removedItemId)?.removed_at).not.toBeNull();

    const legacyThreads = await client`select opening_prose_text, opening_prose_revision_id from manuscript_review_threads where project_id=${projectId} and target_item_type='prose'`;
    expect(legacyThreads).toHaveLength(1);
    expect(String(legacyThreads[0].opening_prose_text)).toBe(activeText);
    expect(legacyThreads[0].opening_prose_revision_id).toBeNull();
  });

  it("removes the legacy content columns and keeps the unchanged active export byte-identical", async () => {
    if (!client) throw new Error("Database client missing");
    const retired = await client`select column_name from information_schema.columns where table_schema='public' and table_name='manuscript_prose_blocks' and column_name in ('text', 'updated_at')`;
    expect(retired).toHaveLength(0);
    const db = createDb(databaseUrl(databaseName));
    try {
      const services = createReviewServices(db.db);
      const projection = await services.getFormattedManuscript(projectId, manuscriptId);
      const markdown = serializeManuscriptMarkdown(projection);
      expect(markdown).toBe(`# Manuscript\n\n## Discussion\n\n${activeText}\n\n## References\n`);
    } finally {
      await db.client.end();
    }
  });

  it("applies the complete 0000 -> 0023 chain to a fresh database", async () => {
    const freshName = `${databaseName}_fresh`;
    const admin = postgres(BASE_URL, { max: 1 });
    let fresh: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`create database "${freshName}"`);
      fresh = createDb(databaseUrl(freshName));
      await migrate(fresh.db, { migrationsFolder: migrationFolder });
      const [latest] = await fresh.client`select id, hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(Number(latest.id)).toBe(24);
      const migrationHash = createHash("sha256").update(fs.readFileSync(path.join(migrationFolder, "0023_manuscript_prose_revisions.sql"))).digest("hex");
      expect(latest.hash).toBe(migrationHash);
      const [revisionTable] = await fresh.client`select to_regclass('public.manuscript_prose_revisions') as table_name`;
      expect(revisionTable.table_name).toBe("manuscript_prose_revisions");
    } finally {
      if (fresh) await fresh.client.end();
      await admin.unsafe(`drop database if exists "${freshName}"`);
      await admin.end();
    }
  });
});
