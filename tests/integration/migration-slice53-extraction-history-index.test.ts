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
const migration0039Path = path.join(migrationFolder, "0039_slice53_finalized_extraction_history_keysets.sql");
const migration0039Hash = createHash("sha256").update(fs.readFileSync(migration0039Path)).digest("hex");
const newIndex = "extraction_value_revisions_project_paper_field_sequence_id_idx";

function urlFor(name: string) {
  const url = new URL(baseUrl);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(prefix: string) {
  const name = `${prefix}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(baseUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  return { name, admin, url: urlFor(name) };
}

function createMigration0038Folder() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "litreview-slice53-0038-baseline-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, {
    recursive: true,
    filter: (source) => !["0039_slice53_finalized_extraction_history_keysets.sql", "0039_snapshot.json"].includes(path.basename(source)),
  });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
  fs.writeFileSync(journalPath, `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 38) }, null, 2)}\n`, "utf8");
  return { tempRoot, folder: target };
}

async function expectIndex(client: postgres.Sql) {
  const [row] = await client`
    select table_class.relname as table_name, pg_get_indexdef(i.indexrelid) as definition,
      pg_get_expr(i.indpred,i.indrelid) as predicate,
      array(
        select attribute.attname
        from unnest(i.indkey::smallint[]) with ordinality as key(attnum,ordinality)
        join pg_attribute attribute on attribute.attrelid=i.indrelid and attribute.attnum=key.attnum
        where key.ordinality <= i.indnkeyatts order by key.ordinality
      ) as columns,
      i.indisunique as is_unique, i.indisvalid as is_valid, i.indisready as is_ready
    from pg_index i join pg_class index_class on index_class.oid=i.indexrelid
      join pg_class table_class on table_class.oid=i.indrelid
    where index_class.relname=${newIndex}
  `;
  expect(row).toBeDefined();
  expect(row.table_name).toBe("extraction_value_revisions");
  expect(row.columns).toEqual(["project_id", "paper_id", "field_id", "sequence", "id"]);
  expect(String(row.predicate).replace(/[()\"]+/g, "").replace(/\s+/g, " ").trim().toLowerCase()).toBe("finalized_at is not null");
  expect(row.is_unique).toBe(false);
  expect(row.is_valid).toBe(true);
  expect(row.is_ready).toBe(true);
  expect(row.definition).toMatch(/using btree/i);
  expect(row.definition).not.toMatch(/\bdesc\b/i);
  const retained = await client`
    select to_regclass('public.extraction_value_revisions_current_idx') is not null as current_idx,
      to_regclass('public.extraction_values_project_paper_field_idx') is not null as slot_idx
  `;
  expect(retained[0]).toEqual({ current_idx: true, slot_idx: true });
}

async function expectTail(client: postgres.Sql, expectedId: number) {
  const [tail] = await client`select id,hash from drizzle.__drizzle_migrations order by id desc limit 1`;
  expect(Number(tail.id)).toBe(expectedId);
  expect(tail.hash).toBe(migration0039Hash);
}

describe("Slice 53 migration 0039 extraction history keyset", () => {
  it("creates only the approved finalized tuple index on fresh and populated 0038 upgrades", async () => {
    let fresh: Awaited<ReturnType<typeof createDatabase>> | undefined;
    let forward: Awaited<ReturnType<typeof createDatabase>> | undefined;
    let baseline: ReturnType<typeof createMigration0038Folder> | undefined;
    let freshDb: ReturnType<typeof createDb> | undefined;
    let forwardDb: ReturnType<typeof createDb> | undefined;
    try {
      fresh = await createDatabase("slice53_fresh");
      forward = await createDatabase("slice53_forward");
      baseline = createMigration0038Folder();
      freshDb = createDb(fresh.url);
      forwardDb = createDb(forward.url);

      await migrate(freshDb.db, { migrationsFolder: migrationFolder });
      await expectIndex(freshDb.client);
      await expectTail(freshDb.client, 40);

      await migrate(forwardDb.db, { migrationsFolder: baseline.folder });
      const before = await forwardDb.client`
        select to_regclass(${`public.${newIndex}`}::text) is not null as index_exists,
          (select count(*)::int from extraction_value_revisions) as revision_rows
      `;
      expect(before[0]).toEqual({ index_exists: false, revision_rows: 0 });
      const [project] = await forwardDb.client`insert into projects (title) values ('Slice 53 forward migration') returning id`;
      const [paper] = await forwardDb.client`insert into papers (project_id,title) values (${project.id},'Forward fixture') returning id`;
      const [field] = await forwardDb.client`insert into extraction_fields (project_id,name,field_type) values (${project.id},'Outcome','short_text') returning id`;
      const [slot] = await forwardDb.client`insert into extraction_values (project_id,paper_id,field_id) values (${project.id},${paper.id},${field.id}) returning id`;
      const [revision] = await forwardDb.client`
        insert into extraction_value_revisions (
          project_id,paper_id,field_id,extraction_value_id,field_type,value_state,text_value
        ) values (${project.id},${paper.id},${field.id},${slot.id},'short_text','present','Before 0039')
        returning id,sequence::text as sequence
      `;
      await forwardDb.client`update extraction_value_revisions set finalized_at=now() where id=${revision.id}`;
      const beforeRows = await forwardDb.client`
        select id::text,sequence::text,field_type,value_state,text_value,finalized_at is not null as finalized
        from extraction_value_revisions where id=${revision.id}
      `;
      await migrate(forwardDb.db, { migrationsFolder: migrationFolder });
      await expectIndex(forwardDb.client);
      await expectTail(forwardDb.client, 40);
      const afterRows = await forwardDb.client`
        select id::text,sequence::text,field_type,value_state,text_value,finalized_at is not null as finalized
        from extraction_value_revisions where id=${revision.id}
      `;
      expect(afterRows).toEqual(beforeRows);
    } finally {
      try {
        await Promise.all([
          ...(freshDb ? [freshDb.client.end()] : []),
          ...(forwardDb ? [forwardDb.client.end()] : []),
        ]);
      } finally {
        await Promise.all([
          ...(fresh ? [fresh.admin.unsafe(`DROP DATABASE IF EXISTS "${fresh.name}" WITH (FORCE)`).finally(() => fresh!.admin.end())] : []),
          ...(forward ? [forward.admin.unsafe(`DROP DATABASE IF EXISTS "${forward.name}" WITH (FORCE)`).finally(() => forward!.admin.end())] : []),
        ]);
        if (baseline) fs.rmSync(baseline.tempRoot, { recursive: true, force: true });
      }
    }
  }, 180_000);
});
