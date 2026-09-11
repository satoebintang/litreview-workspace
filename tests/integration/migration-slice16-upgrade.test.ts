import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const TEST_DB_NAME = `slice16_upgrade_${Date.now()}`;
const TEST_DB_URL = databaseUrl(TEST_DB_NAME);
const migrationFolder = path.resolve(process.cwd(), "drizzle");

function databaseUrl(databaseName: string) {
  const url = new URL(BASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function runMigration(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement);
}

describe("Slice 16 migration boundary", () => {
  let client: postgres.Sql | undefined;
  let databaseCreated = false;
  let projectId = "";
  let paperId = "";
  let evidenceId = "";
  let claimRevisionId = "";
  let evidenceBefore: Record<string, unknown>;
  let supportBefore: Record<string, unknown>;

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      await admin.unsafe(`create database "${TEST_DB_NAME}"`);
      databaseCreated = true;
    } finally {
      await admin.end();
    }

    client = postgres(TEST_DB_URL, { max: 1 });
    const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 15)) await runMigration(client, `${entry.tag}.sql`);

    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 16 upgrade project') returning id`;
    [{ id: paperId }] = await client`insert into papers (project_id, title) values (${projectId}, 'Slice 16 paper') returning id`;
    [{ id: evidenceId }] = await client`insert into evidence (project_id, paper_id, source_text, page_number) values (${projectId}, ${paperId}, 'Legacy immutable passage', 4) returning id`;
    const [{ id: claimId }] = await client`insert into claims (project_id) values (${projectId}) returning id`;
    [{ id: claimRevisionId }] = await client`insert into claim_revisions (project_id, claim_id, state, claim_text) values (${projectId}, ${claimId}, 'active', 'Legacy claim') returning id`;
    await client`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${claimRevisionId}, ${evidenceId})`;
    await client`update claim_revisions set finalized_at=now() where project_id=${projectId} and id=${claimRevisionId}`;

    [evidenceBefore] = await client`select id, project_id, paper_id, source_text, page_number, note, created_at, updated_at from evidence where id=${evidenceId}`;
    [supportBefore] = await client`select project_id, claim_revision_id, evidence_id, created_at from claim_revision_evidence_supports where claim_revision_id=${claimRevisionId}`;
    await runMigration(client, "0016_evidence_review_curation.sql");
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (!databaseCreated) return;
    const admin = postgres(BASE_URL, { max: 1 });
    try { await admin.unsafe(`drop database if exists "${TEST_DB_NAME}" with (force)`); }
    finally { await admin.end(); }
  }, 120_000);

  it("adds empty curation history without changing existing Evidence or support identity", async () => {
    expect(await client!`select count(*)::integer as count from evidence_review_decisions`).toEqual([{ count: 0 }]);
    expect(await client!`select count(*)::integer as count from evidence_annotations`).toEqual([{ count: 0 }]);
    expect(await client!`select count(*)::integer as count from evidence_label_events`).toEqual([{ count: 0 }]);
    expect(await client!`select count(*)::integer as count from evidence where project_id=${projectId}`).toEqual([{ count: 1 }]);
    expect(await client!`select id, project_id, paper_id, source_text, page_number, note, created_at, updated_at from evidence where id=${evidenceId}`).toEqual([evidenceBefore]);
    expect(await client!`select project_id, claim_revision_id, evidence_id, created_at from claim_revision_evidence_supports where claim_revision_id=${claimRevisionId}`).toEqual([supportBefore]);
  });
});
