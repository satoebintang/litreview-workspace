import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice17_upgrade_${Date.now()}`;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function runMigration(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement);
}

describe("Slice 17 migration boundary", () => {
  let client: postgres.Sql | undefined;
  let databaseCreated = false;
  let projectId = "";
  let paperId = "";
  let evidenceId = "";

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
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 15)) await runMigration(client, `${entry.tag}.sql`);
    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 17 upgrade project') returning id`;
    [{ id: paperId }] = await client`insert into papers (project_id, title) values (${projectId}, 'Slice 17 paper') returning id`;
    [{ id: evidenceId }] = await client`insert into evidence (project_id, paper_id, source_text, page_number) values (${projectId}, ${paperId}, 'Legacy passage', 4) returning id`;
    await runMigration(client, "0016_evidence_review_curation.sql");
    await runMigration(client, "0017_evidence_sets.sql");
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (!databaseCreated) return;
    const admin = postgres(BASE_URL, { max: 1 });
    try { await admin.unsafe(`drop database if exists "${databaseName}" with (force)`); }
    finally { await admin.end(); }
  }, 120_000);

  it("adds the complete Evidence Set relational graph without changing legacy Evidence", async () => {
    expect(await client!`select to_regclass('public.evidence_sets') as table_name`).toEqual([{ table_name: "evidence_sets" }]);
    expect(await client!`select to_regclass('public.evidence_set_memberships') as table_name`).toEqual([{ table_name: "evidence_set_memberships" }]);
    expect(await client!`select to_regclass('public.evidence_set_composition_revisions') as table_name`).toEqual([{ table_name: "evidence_set_composition_revisions" }]);
    expect(await client!`select to_regclass('public.evidence_set_composition_members') as table_name`).toEqual([{ table_name: "evidence_set_composition_members" }]);
    expect(await client!`select to_regclass('public.evidence_set_annotations') as table_name`).toEqual([{ table_name: "evidence_set_annotations" }]);
    expect(await client!`select id, project_id, paper_id, source_text, page_number from evidence where id=${evidenceId}`).toEqual([{ id: evidenceId, project_id: projectId, paper_id: paperId, source_text: "Legacy passage", page_number: 4 }]);
  });

  it("requires an initial empty snapshot, supports transactional rollback, and validates direct composition inserts", async () => {
    const missingSnapshotId = crypto.randomUUID();
    await expect(client!.begin(async (tx) => {
      await tx`insert into evidence_sets (id, project_id, name) values (${missingSnapshotId}, ${projectId}, 'Missing snapshot')`;
    })).rejects.toThrow(/initial empty composition snapshot/i);
    expect(await client!`select count(*)::int as count from evidence_sets where id=${missingSnapshotId}`).toEqual([{ count: 0 }]);

    const rolledBackId = crypto.randomUUID();
    await expect(client!.begin(async (tx) => {
      await tx`insert into evidence_sets (id, project_id, name) values (${rolledBackId}, ${projectId}, 'Rollback set')`;
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${rolledBackId}, 'created')`;
      throw new Error("migration rollback sentinel");
    })).rejects.toThrow("migration rollback sentinel");
    expect(await client!`select count(*)::int as count from evidence_sets where id=${rolledBackId}`).toEqual([{ count: 0 }]);

    const setId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await client!.begin(async (tx) => {
      await tx`insert into evidence_sets (id, project_id, name) values (${setId}, ${projectId}, 'Direct valid set')`;
      const [created] = await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${setId}, 'created') returning id`;
      await tx`insert into evidence_set_memberships (id, project_id, evidence_set_id, evidence_id) values (${membershipId}, ${projectId}, ${setId}, ${evidenceId})`;
      const [added] = await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${setId}, 'added') returning id`;
      await tx`insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order) values (${projectId}, ${setId}, ${added.id}, ${membershipId}, 1)`;
      expect(created.id).toBeTruthy();
    });
    expect(await client!`select operation_kind from evidence_set_composition_revisions where evidence_set_id=${setId} order by sequence`).toEqual([{ operation_kind: "created" }, { operation_kind: "added" }]);

    await expect(client!.begin(async (tx) => {
      const [revision] = await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${setId}, 'reordered') returning id`;
      await tx`insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order) values (${projectId}, ${setId}, ${revision.id}, ${membershipId}, 1)`;
    })).rejects.toThrow(/reordered composition/i);
  });

  it("enforces composite ownership for memberships and historical composition rows", async () => {
    const otherProject = crypto.randomUUID();
    const otherPaper = crypto.randomUUID();
    const otherEvidence = crypto.randomUUID();
    await client!`insert into projects (id, title) values (${otherProject}, 'Other project')`;
    await client!`insert into papers (id, project_id, title) values (${otherPaper}, ${otherProject}, 'Other paper')`;
    await client!`insert into evidence (id, project_id, paper_id, source_text, page_number) values (${otherEvidence}, ${otherProject}, ${otherPaper}, 'Other passage', 1)`;

    const localSet = crypto.randomUUID();
    const foreignSet = crypto.randomUUID();
    await client!.begin(async (tx) => {
      await tx`insert into evidence_sets (id, project_id, name) values (${localSet}, ${projectId}, 'Ownership local')`;
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${localSet}, 'created')`;
      await tx`insert into evidence_sets (id, project_id, name) values (${foreignSet}, ${otherProject}, 'Ownership foreign')`;
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${otherProject}, ${foreignSet}, 'created')`;
    });
    const [localRevision] = await client!`select id from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${localSet}`;
    const [foreignRevision] = await client!`select id from evidence_set_composition_revisions where project_id=${otherProject} and evidence_set_id=${foreignSet}`;
    await expect(client!`insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id) values (${projectId}, ${localSet}, ${otherEvidence})`).rejects.toThrow();
    await expect(client!`insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order) values (${otherProject}, ${foreignSet}, ${foreignRevision.id}, ${crypto.randomUUID()}, 1)`).rejects.toThrow();
    expect(localRevision.id).not.toBe(foreignRevision.id);
  });
});
