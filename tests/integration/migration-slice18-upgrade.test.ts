import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice18_upgrade_${Date.now()}`;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function runMigration(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await client.unsafe(statement);
  }
}

describe("Slice 18 migration boundary", () => {
  let client: postgres.Sql | undefined;
  let databaseCreated = false;
  let projectId = "";
  let paperId = "";
  let evidenceId = "";
  let setId = "";
  let membershipId = "";
  let compositionRevisionId = "";
  let fieldAId = "";
  let fieldBId = "";
  let extractionValueAId = "";
  let extractionValueBId = "";
  let reachableRevisionAId = "";
  let reachableRevisionBId = "";
  let unreachableRevisionAId = "";

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      await admin.unsafe(`create database "${databaseName}"`);
      databaseCreated = true;
    } finally {
      await admin.end();
    }

    client = postgres(databaseUrl(databaseName), { max: 1 });
    const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 17)) {
      await runMigration(client, `${entry.tag}.sql`);
    }

    // Populate representative Slice 17 state
    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 18 upgrade project') returning id`;
    [{ id: paperId }] = await client`insert into papers (project_id, title) values (${projectId}, 'Slice 18 paper') returning id`;
    [{ id: evidenceId }] = await client`insert into evidence (project_id, paper_id, source_text, page_number) values (${projectId}, ${paperId}, 'Evidence passage', 1) returning id`;

    // Evidence Set with 1 member in composition
    await client.begin(async (tx) => {
      [{ id: setId }] = await tx`insert into evidence_sets (project_id, name) values (${projectId}, 'Source Evidence Set') returning id`;
      await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${setId}, 'created')`;
    });
    await client.begin(async (tx) => {
      [{ id: membershipId }] = await tx`insert into evidence_set_memberships (project_id, evidence_set_id, evidence_id) values (${projectId}, ${setId}, ${evidenceId}) returning id`;
      [{ id: compositionRevisionId }] = await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind) values (${projectId}, ${setId}, 'added') returning id`;
      await tx`insert into evidence_set_composition_members (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order) values (${projectId}, ${setId}, ${compositionRevisionId}, ${membershipId}, 1)`;
    });

    // Fields A and B
    [{ id: fieldAId }] = await client`insert into extraction_fields (project_id, name, field_type) values (${projectId}, 'Field A', 'short_text') returning id`;
    [{ id: fieldBId }] = await client`insert into extraction_fields (project_id, name, field_type) values (${projectId}, 'Field B', 'short_text') returning id`;

    // Values and revisions
    [{ id: extractionValueAId }] = await client`insert into extraction_values (project_id, paper_id, field_id) values (${projectId}, ${paperId}, ${fieldAId}) returning id`;
    [{ id: extractionValueBId }] = await client`insert into extraction_values (project_id, paper_id, field_id) values (${projectId}, ${paperId}, ${fieldBId}) returning id`;

    [{ id: reachableRevisionAId }] = await client`
      insert into extraction_value_revisions (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value)
      values (${projectId}, ${paperId}, ${fieldAId}, ${extractionValueAId}, 'short_text', 'present', 'Value A')
      returning id
    `;
    [{ id: reachableRevisionBId }] = await client`
      insert into extraction_value_revisions (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value)
      values (${projectId}, ${paperId}, ${fieldBId}, ${extractionValueBId}, 'short_text', 'present', 'Value B')
      returning id
    `;
    [{ id: unreachableRevisionAId }] = await client`
      insert into extraction_value_revisions (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value)
      values (${projectId}, ${paperId}, ${fieldAId}, ${extractionValueAId}, 'short_text', 'present', 'Unreachable Value A')
      returning id
    `;

    // Connect reachableRevisionA and reachableRevisionB to evidenceId while in draft
    await client`insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id) values (${projectId}, ${paperId}, ${reachableRevisionAId}, ${evidenceId})`;
    await client`insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id) values (${projectId}, ${paperId}, ${reachableRevisionBId}, ${evidenceId})`;

    // Finalize the revisions
    await client`update extraction_value_revisions set finalized_at = now() where id in (${reachableRevisionAId}, ${reachableRevisionBId}, ${unreachableRevisionAId})`;

    // Run Slice 18 migration
    await runMigration(client, "0018_synthesis_preparations.sql");
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (!databaseCreated) return;
    const admin = postgres(BASE_URL, { max: 1 });
    try {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  it("creates the synthesis_preparations and synthesis_preparation_selections tables", async () => {
    expect(await client!`select to_regclass('public.synthesis_preparations') as table_name`).toEqual([
      { table_name: "synthesis_preparations" },
    ]);
    expect(await client!`select to_regclass('public.synthesis_preparation_selections') as table_name`).toEqual([
      { table_name: "synthesis_preparation_selections" },
    ]);
  });

  it("enforces active creation, immutable pinning, and rejects preparation deletion", async () => {
    const prepId = crypto.randomUUID();

    // Must be created with active status
    await expect(
      client!`insert into synthesis_preparations (id, project_id, evidence_set_id, evidence_set_composition_revision_id, extraction_field_id, status) values (${prepId}, ${projectId}, ${setId}, ${compositionRevisionId}, ${fieldAId}, 'finalized')`,
    ).rejects.toThrow(/must be created with active status/i);

    // Valid active insert
    await client!`insert into synthesis_preparations (id, project_id, evidence_set_id, evidence_set_composition_revision_id, extraction_field_id, status) values (${prepId}, ${projectId}, ${setId}, ${compositionRevisionId}, ${fieldAId}, 'active')`;

    // Rejects deletion
    await expect(client!`delete from synthesis_preparations where id = ${prepId}`).rejects.toThrow(
      /synthesis preparations cannot be deleted/i,
    );

    // Rejects identity/pinning mutation
    await expect(
      client!`update synthesis_preparations set evidence_set_id = ${crypto.randomUUID()} where id = ${prepId}`,
    ).rejects.toThrow(/identity and pinning are immutable/i);
    await expect(
      client!`update synthesis_preparations set extraction_field_id = ${fieldBId} where id = ${prepId}`,
    ).rejects.toThrow(/identity and pinning are immutable/i);
  });

  it("enforces ExtractionField equality and reachability on selection insert", async () => {
    const prepId = crypto.randomUUID();
    await client!`insert into synthesis_preparations (id, project_id, evidence_set_id, evidence_set_composition_revision_id, extraction_field_id, status) values (${prepId}, ${projectId}, ${setId}, ${compositionRevisionId}, ${fieldAId}, 'active')`;

    // 1. Direct SQL inserting reachable candidate from DIFFERENT field (Field B into Field A preparation) MUST be rejected by DB trigger
    await expect(
      client!`insert into synthesis_preparation_selections (project_id, preparation_id, extraction_revision_id) values (${projectId}, ${prepId}, ${reachableRevisionBId})`,
    ).rejects.toThrow(/does not match preparation extraction field/i);

    // 2. Direct SQL inserting unreachable candidate from SAME field MUST be rejected by reachability check
    await expect(
      client!`insert into synthesis_preparation_selections (project_id, preparation_id, extraction_revision_id) values (${projectId}, ${prepId}, ${unreachableRevisionAId})`,
    ).rejects.toThrow(/not reachable from pinned evidence set composition/i);

    // 3. Reachable candidate from matching field succeeds
    await client!`insert into synthesis_preparation_selections (project_id, preparation_id, extraction_revision_id) values (${projectId}, ${prepId}, ${reachableRevisionAId})`;
    expect(
      await client!`select extraction_revision_id from synthesis_preparation_selections where preparation_id = ${prepId}`,
    ).toEqual([{ extraction_revision_id: reachableRevisionAId }]);

    // 4. Selections are immutable (rejects update)
    await expect(
      client!`update synthesis_preparation_selections set created_at = now() where preparation_id = ${prepId}`,
    ).rejects.toThrow(/selections are immutable/i);
  });

  it("enforces deferred equality between preparation selections and finalized revision supports", async () => {
    const prepId = crypto.randomUUID();
    await client!`insert into synthesis_preparations (id, project_id, evidence_set_id, evidence_set_composition_revision_id, extraction_field_id, status) values (${prepId}, ${projectId}, ${setId}, ${compositionRevisionId}, ${fieldAId}, 'active')`;
    await client!`insert into synthesis_preparation_selections (project_id, preparation_id, extraction_revision_id) values (${projectId}, ${prepId}, ${reachableRevisionAId})`;

    // Create statement and revision with NO supports
    const [statement] = await client!`insert into synthesis_statements (project_id) values (${projectId}) returning id`;
    const [revision] = await client!`
      insert into synthesis_revisions (project_id, synthesis_statement_id, state, statement_text)
      values (${projectId}, ${statement.id}, 'active', 'Statement text')
      returning id
    `;
    await client!`update synthesis_revisions set finalized_at = now() where id = ${revision.id}`;

    // Finalizing preparation with selection {reachableRevisionAId} while revision has 0 supports must fail deferred trigger
    await expect(
      client!.begin(async (tx) => {
        await tx`
          update synthesis_preparations
          set status = 'finalized', target_synthesis_statement_id = ${statement.id}, finalized_synthesis_revision_id = ${revision.id}, finalized_at = now()
          where id = ${prepId}
        `;
      }),
    ).rejects.toThrow(/preparation selections count/i);

    // Add matching support to revision in a new draft, then test valid finalization
    const [revision2] = await client!`
      insert into synthesis_revisions (project_id, synthesis_statement_id, state, statement_text)
      values (${projectId}, ${statement.id}, 'active', 'Statement text 2')
      returning id
    `;
    await client!`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${projectId}, ${revision2.id}, ${reachableRevisionAId})`;
    await client!`update synthesis_revisions set finalized_at = now() where id = ${revision2.id}`;

    // Finalizing with exact matching support succeeds
    await client!.begin(async (tx) => {
      await tx`
        update synthesis_preparations
        set status = 'finalized', target_synthesis_statement_id = ${statement.id}, finalized_synthesis_revision_id = ${revision2.id}, finalized_at = now()
        where id = ${prepId}
      `;
    });

    const [finalizedPrep] = await client!`select status, finalized_synthesis_revision_id from synthesis_preparations where id = ${prepId}`;
    expect(finalizedPrep.status).toBe("finalized");
    expect(finalizedPrep.finalized_synthesis_revision_id).toBe(revision2.id);

    // Terminal freeze: finalized preparation cannot have selections added or removed
    await expect(
      client!`delete from synthesis_preparation_selections where preparation_id = ${prepId}`,
    ).rejects.toThrow(/selections cannot be removed from a terminal synthesis preparation/i);

    // Terminal freeze: finalized preparation cannot change status or metadata
    await expect(
      client!`update synthesis_preparations set working_title = 'Changed' where id = ${prepId}`,
    ).rejects.toThrow(/terminal synthesis preparations are immutable/i);
  });
});
