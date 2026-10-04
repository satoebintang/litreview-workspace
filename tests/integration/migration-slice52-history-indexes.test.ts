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
import { createReviewServices } from "@/application/services";

const baseUrl = resolveDatabaseUrl();
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const migration0037Path = path.join(migrationFolder, "0037_research_question_traceability_epoch.sql");
const migration0038Path = path.join(migrationFolder, "0038_slice52_finalized_history_keysets.sql");
const migration0037Hash = createHash("sha256").update(fs.readFileSync(migration0037Path)).digest("hex");
const migration0038Hash = createHash("sha256").update(fs.readFileSync(migration0038Path)).digest("hex");

const historyIndexes = [
  {
    name: "claim_revisions_project_claim_sequence_id_idx",
    table: "claim_revisions",
    columns: ["project_id", "claim_id", "sequence", "id"],
  },
  {
    name: "synthesis_revisions_project_statement_sequence_id_idx",
    table: "synthesis_revisions",
    columns: ["project_id", "synthesis_statement_id", "sequence", "id"],
  },
  {
    name: "synthesis_interpretations_project_revision_sequence_id_idx",
    table: "synthesis_interpretations",
    columns: ["project_id", "synthesis_revision_id", "sequence", "id"],
  },
] as const;

function databaseUrl(name: string) {
  const url = new URL(baseUrl);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(prefix: string) {
  const name = `${prefix}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(baseUrl, { max: 1, prepare: false });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  return { name, admin, url: databaseUrl(name) };
}

async function closeDatabase(
  database: Awaited<ReturnType<typeof freshDatabase>>,
  app: ReturnType<typeof createDb> | undefined,
) {
  try {
    await app?.client.end();
  } finally {
    try {
      await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    } finally {
      await database.admin.end();
    }
  }
}

function createMigration0037Folder() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "litreview-slice52-0037-baseline-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, {
    recursive: true,
    filter: (source) => ![
      "0038_slice52_finalized_history_keysets.sql",
      "0038_snapshot.json",
    ].includes(path.basename(source)),
  });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 37) }, null, 2)}\n`,
    "utf8",
  );
  return { tempRoot, folder: target };
}

async function expectMigrationTail(client: postgres.Sql, expectedId: number, expectedHash: string) {
  const [tail] = await client`select id,hash from drizzle.__drizzle_migrations order by id desc limit 1`;
  expect(Number(tail.id)).toBe(expectedId);
  expect(tail.hash).toBe(expectedHash);
}

async function expectHistoryIndexes(client: postgres.Sql) {
  const names = historyIndexes.map((index) => index.name);
  const rows = await client`
    select index_class.relname as index_name,
      table_class.relname as table_name,
      array(
        select a.attname
        from unnest(i.indkey::smallint[]) with ordinality as index_key(attnum,ordinality)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=index_key.attnum
        where index_key.ordinality <= i.indnkeyatts
        order by index_key.ordinality
      ) as columns,
      pg_get_expr(i.indpred,i.indrelid) as predicate,
      pg_get_indexdef(i.indexrelid) as definition,
      i.indisunique as is_unique,
      i.indisvalid as is_valid
    from pg_index i
    join pg_class index_class on index_class.oid=i.indexrelid
    join pg_class table_class on table_class.oid=i.indrelid
    where index_class.relname = any(${names}::text[])
    order by index_class.relname
  `;

  expect(rows.map((row) => row.index_name)).toEqual([...names].sort());
  for (const expected of historyIndexes) {
    const actual = rows.find((row) => row.index_name === expected.name);
    expect(actual).toBeDefined();
    expect(actual?.table_name).toBe(expected.table);
    expect(actual?.columns).toEqual([...expected.columns]);
    expect(actual?.is_unique).toBe(false);
    expect(actual?.is_valid).toBe(true);
    expect(String(actual?.predicate).replace(/[()\"]+/g, "").replace(/\s+/g, " ").trim().toLowerCase())
      .toBe("finalized_at is not null");
    expect(actual?.definition).toMatch(/using btree/i);
    expect(actual?.definition).not.toMatch(/\bdesc\b/i);
  }

  const retained = await client`
    select
      to_regclass('public.claim_revisions_project_claim_sequence_idx') is not null as claim_index,
      to_regclass('public.synthesis_revisions_project_statement_sequence_idx') is not null as synthesis_index,
      to_regclass('public.synthesis_interpretations_project_revision_sequence_idx') is not null as interpretation_index
  `;
  expect(retained[0]).toEqual({ claim_index: true, synthesis_index: true, interpretation_index: true });
}

async function seedHistoryAt0037(app: ReturnType<typeof createDb>) {
  const services = createReviewServices(app.db);
  const project = await services.createProject({ title: `Slice 52 migration fixture ${randomUUID()}` });
  const claim = await services.createClaim(project.id, { claimText: "Claim present before migration 0038" });
  const revisedClaim = await services.createClaimRevision(project.id, claim.id, {
    claimText: "Revised claim present before migration 0038",
    supports: [],
    expectedCurrentRevisionId: claim.revision.id,
  });

  const statementId = randomUUID();
  const synthesisRevisionIds = [randomUUID(), randomUUID()];
  const interpretationIds = [randomUUID(), randomUUID()];
  await app.client.begin(async (tx) => {
    await tx`insert into synthesis_statements (id,project_id) values (${statementId},${project.id})`;
    for (const [index, revisionId] of synthesisRevisionIds.entries()) {
      await tx`
        insert into synthesis_revisions (id,project_id,synthesis_statement_id,state,statement_text)
        values (${revisionId},${project.id},${statementId},'active',${`Synthesis revision ${index + 1} before 0038`})
      `;
      await tx`update synthesis_revisions set finalized_at=now() where id=${revisionId}`;

      const interpretationId = interpretationIds[index];
      await tx`
        insert into synthesis_interpretations (
          id,project_id,synthesis_statement_id,synthesis_revision_id,convergence_state,summary
        ) values (
          ${interpretationId},${project.id},${statementId},${revisionId},'convergent',${`Interpretation ${index + 1} before 0038`}
        )
      `;
      await tx`update synthesis_interpretations set finalized_at=now() where id=${interpretationId}`;
    }
  });

  return {
    projectId: project.id,
    claimRevisionIds: [claim.revision.id, revisedClaim.revision.id],
    statementId,
    synthesisRevisionIds,
    interpretationIds,
  };
}

async function readSeededHistory(client: postgres.Sql, fixture: Awaited<ReturnType<typeof seedHistoryAt0037>>) {
  const claimRows = await client`
    select id::text as id,claim_text,finalized_at is not null as finalized
    from claim_revisions
    where project_id=${fixture.projectId} and id=any(${fixture.claimRevisionIds}::uuid[])
    order by sequence
  `;
  const synthesisRows = await client`
    select id::text as id,synthesis_statement_id::text as statement_id,statement_text,finalized_at is not null as finalized
    from synthesis_revisions
    where project_id=${fixture.projectId} and id=any(${fixture.synthesisRevisionIds}::uuid[])
    order by sequence
  `;
  const interpretationRows = await client`
    select id::text as id,synthesis_revision_id::text as revision_id,summary,finalized_at is not null as finalized
    from synthesis_interpretations
    where project_id=${fixture.projectId} and id=any(${fixture.interpretationIds}::uuid[])
    order by sequence
  `;
  return { claimRows, synthesisRows, interpretationRows };
}

describe("Slice 52 migration 0038 finalized history keysets", () => {
  it("creates the indexes on fresh databases and populated upgrades from exactly 0037", async () => {
    let fresh: Awaited<ReturnType<typeof freshDatabase>> | undefined;
    let forward: Awaited<ReturnType<typeof freshDatabase>> | undefined;
    let baseline0037: ReturnType<typeof createMigration0037Folder> | undefined;
    let freshApp: ReturnType<typeof createDb> | undefined;
    let forwardApp: ReturnType<typeof createDb> | undefined;

    try {
      fresh = await freshDatabase("slice52_fresh");
      forward = await freshDatabase("slice52_forward");
      baseline0037 = createMigration0037Folder();
      freshApp = createDb(fresh.url);
      forwardApp = createDb(forward.url);

      await migrate(freshApp.db, { migrationsFolder: migrationFolder });
      await expectHistoryIndexes(freshApp.client);
      await expectMigrationTail(freshApp.client, 39, migration0038Hash);

      await migrate(forwardApp.db, { migrationsFolder: baseline0037.folder });
      await expectMigrationTail(forwardApp.client, 38, migration0037Hash);
      const [preMigrationIndexes] = await forwardApp.client`
        select count(*)::int as count from pg_class where relname = any(${historyIndexes.map((index) => index.name)}::text[])
      `;
      expect(Number(preMigrationIndexes.count)).toBe(0);

      const fixture = await seedHistoryAt0037(forwardApp);
      const beforeMigration = await readSeededHistory(forwardApp.client, fixture);
      expect(beforeMigration.claimRows).toHaveLength(2);
      expect(beforeMigration.synthesisRows).toHaveLength(2);
      expect(beforeMigration.interpretationRows).toHaveLength(2);

      await migrate(forwardApp.db, { migrationsFolder: migrationFolder });
      await expectHistoryIndexes(forwardApp.client);
      await expectMigrationTail(forwardApp.client, 39, migration0038Hash);
      expect(await readSeededHistory(forwardApp.client, fixture)).toEqual(beforeMigration);
    } finally {
      try {
        const cleanup = await Promise.allSettled([
          ...(fresh ? [closeDatabase(fresh, freshApp)] : []),
          ...(forward ? [closeDatabase(forward, forwardApp)] : []),
        ]);
        const cleanupErrors = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors.map((result) => result.reason), "Slice 52 migration test database cleanup failed");
        }
      } finally {
        if (baseline0037) fs.rmSync(baseline0037.tempRoot, { recursive: true, force: true });
      }
    }
  }, 180_000);
});
