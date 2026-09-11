import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice19_upgrade_${Date.now()}`;

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

describe("Slice 19 migration boundary", () => {
  let client: postgres.Sql | undefined;
  let databaseCreated = false;
  let projectId = "";
  let paperAId = "";
  let paperBId = "";
  let evidenceAId = "";
  let evidenceBId = "";
  let fieldAId = "";
  let extractionValueAId = "";
  let extractionValueBId = "";
  let revisionAId = "";
  let revisionBId = "";
  let statementId = "";
  let synthesisRevisionId = "";

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
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 18)) {
      await runMigration(client, `${entry.tag}.sql`);
    }

    // Populate representative Slice 18 state
    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 19 upgrade project') returning id`;
    [{ id: paperAId }] = await client`insert into papers (project_id, title) values (${projectId}, 'Paper A') returning id`;
    [{ id: paperBId }] = await client`insert into papers (project_id, title) values (${projectId}, 'Paper B') returning id`;
    [{ id: evidenceAId }] = await client`insert into evidence (project_id, paper_id, source_text, page_number) values (${projectId}, ${paperAId}, 'Passage A', 1) returning id`;
    [{ id: evidenceBId }] = await client`insert into evidence (project_id, paper_id, source_text, page_number) values (${projectId}, ${paperBId}, 'Passage B', 2) returning id`;

    [{ id: fieldAId }] = await client`insert into extraction_fields (project_id, name, field_type) values (${projectId}, 'Metric', 'short_text') returning id`;
    [{ id: extractionValueAId }] = await client`insert into extraction_values (project_id, paper_id, field_id) values (${projectId}, ${paperAId}, ${fieldAId}) returning id`;
    [{ id: extractionValueBId }] = await client`insert into extraction_values (project_id, paper_id, field_id) values (${projectId}, ${paperBId}, ${fieldAId}) returning id`;

    [{ id: revisionAId }] = await client`
      insert into extraction_value_revisions (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value)
      values (${projectId}, ${paperAId}, ${fieldAId}, ${extractionValueAId}, 'short_text', 'present', 'High 50%')
      returning id
    `;
    await client`insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id) values (${projectId}, ${paperAId}, ${revisionAId}, ${evidenceAId})`;
    await client`update extraction_value_revisions set finalized_at = now() where id = ${revisionAId}`;

    [{ id: revisionBId }] = await client`
      insert into extraction_value_revisions (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value)
      values (${projectId}, ${paperBId}, ${fieldAId}, ${extractionValueBId}, 'short_text', 'present', 'Low 10%')
      returning id
    `;
    await client`insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id) values (${projectId}, ${paperBId}, ${revisionBId}, ${evidenceBId})`;
    await client`update extraction_value_revisions set finalized_at = now() where id = ${revisionBId}`;

    // Finalized synthesis revision supporting both revisionA and revisionB
    [{ id: statementId }] = await client`insert into synthesis_statements (project_id) values (${projectId}) returning id`;
    [{ id: synthesisRevisionId }] = await client`
      insert into synthesis_revisions (project_id, synthesis_statement_id, state, statement_text)
      values (${projectId}, ${statementId}, 'active', 'Synthesized observation')
      returning id
    `;
    await client`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${projectId}, ${synthesisRevisionId}, ${revisionAId})`;
    await client`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${projectId}, ${synthesisRevisionId}, ${revisionBId})`;
    await client`update synthesis_revisions set finalized_at = now() where id = ${synthesisRevisionId}`;
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

  it("applies 0019_synthesis_interpretation.sql cleanly over Slice 18 without backfill", async () => {
    await runMigration(client!, "0019_synthesis_interpretation.sql");

    // Zero backfill
    const interpretations = await client!`select count(*)::integer as count from synthesis_interpretations`;
    expect(interpretations[0].count).toBe(0);

    // Existing synthesis and supports unchanged
    const supports = await client!`select extraction_revision_id from synthesis_revision_supports where synthesis_revision_id = ${synthesisRevisionId} order by extraction_revision_id`;
    const expectedSupports = [revisionAId, revisionBId].sort();
    expect(supports.map((r) => r.extraction_revision_id).sort()).toEqual(expectedSupports);
  });

  it("proves the normal draft -> children -> finalize -> commit path succeeds despite deferred trigger", async () => {
    const interpId = crypto.randomUUID();
    const sortedRevs = [revisionAId, revisionBId].sort();

    await client!.begin(async (tx) => {
      // 1. Insert draft (finalized_at = NULL)
      await tx`
        insert into synthesis_interpretations (
          id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary
        ) values (
          ${interpId}, ${projectId}, ${statementId}, ${synthesisRevisionId}, 'contradictory', 'Discrepant findings between A and B'
        )
      `;

      // 2. Insert limitation
      await tx`
        insert into synthesis_interpretation_limitations (
          project_id, interpretation_id, sort_order, category, body
        ) values (
          ${projectId}, ${interpId}, 0, 'methodological', 'Different measurement tools used across studies'
        )
      `;

      // 3. Insert question
      await tx`
        insert into synthesis_interpretation_questions (
          project_id, interpretation_id, sort_order, body
        ) values (
          ${projectId}, ${interpId}, 0, 'What causes the 40% difference in reported metrics?'
        )
      `;

      // 4. Insert contradiction pair
      await tx`
        insert into synthesis_interpretation_contradictions (
          project_id, interpretation_id, synthesis_revision_id, sort_order,
          left_extraction_revision_id, right_extraction_revision_id, note
        ) values (
          ${projectId}, ${interpId}, ${synthesisRevisionId}, 0,
          ${sortedRevs[0]}, ${sortedRevs[1]}, 'Study A reports 50% while Study B reports 10%'
        )
      `;

      // 5. Finalize
      await tx`
        update synthesis_interpretations
        set finalized_at = now()
        where id = ${interpId}
      `;
    });

    const [persisted] = await client!`select id, convergence_state, finalized_at from synthesis_interpretations where id = ${interpId}`;
    expect(persisted.convergence_state).toBe("contradictory");
    expect(persisted.finalized_at).not.toBeNull();
  });

  it("proves commit without finalizing is rejected by deferred trigger", async () => {
    const unfinalizedId = crypto.randomUUID();

    await expect(
      client!.begin(async (tx) => {
        await tx`
          insert into synthesis_interpretations (
            id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary
          ) values (
            ${unfinalizedId}, ${projectId}, ${statementId}, ${synthesisRevisionId}, 'convergent', 'Draft interpretation'
          )
        `;
      }),
    ).rejects.toThrow(/draft synthesis interpretation cannot survive transaction commit/i);
  });

  it("enforces immutable snapshot guards and post-finalization child protection", async () => {
    const interpId = crypto.randomUUID();

    await client!.begin(async (tx) => {
      await tx`
        insert into synthesis_interpretations (
          id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary
        ) values (
          ${interpId}, ${projectId}, ${statementId}, ${synthesisRevisionId}, 'convergent', 'Convergent findings'
        )
      `;
      await tx`update synthesis_interpretations set finalized_at = now() where id = ${interpId}`;
    });

    // 1. Finalized interpretation is immutable
    await expect(
      client!`update synthesis_interpretations set summary = 'Altered summary' where id = ${interpId}`,
    ).rejects.toThrow(/finalized synthesis interpretations are immutable/i);

    // 2. Finalized interpretation cannot be deleted
    await expect(
      client!`delete from synthesis_interpretations where id = ${interpId}`,
    ).rejects.toThrow(/synthesis interpretations cannot be deleted/i);

    // 3. Post-finalization child insertion is rejected
    await expect(
      client!`
        insert into synthesis_interpretation_limitations (
          project_id, interpretation_id, sort_order, category, body
        ) values (
          ${projectId}, ${interpId}, 0, 'methodological', 'Late limitation'
        )
      `,
    ).rejects.toThrow(/cannot add children to a finalized synthesis interpretation/i);

    // 4. Initial insert directly with finalized_at is rejected
    await expect(
      client!`
        insert into synthesis_interpretations (
          id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary, finalized_at
        ) values (
          ${crypto.randomUUID()}, ${projectId}, ${statementId}, ${synthesisRevisionId}, 'convergent', 'Summary', now()
        )
      `,
    ).rejects.toThrow(/synthesis interpretations must be created in draft state/i);
  });

  it("enforces contradiction foreign keys directly to synthesis_revision_supports", async () => {
    const interpId = crypto.randomUUID();
    const foreignRevId = crypto.randomUUID(); // Valid UUID not in supports

    await expect(
      client!.begin(async (tx) => {
        await tx`
          insert into synthesis_interpretations (
            id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary
          ) values (
            ${interpId}, ${projectId}, ${statementId}, ${synthesisRevisionId}, 'contradictory', 'Contradictory summary'
          )
        `;

        const sorted = [revisionAId, foreignRevId].sort();
        await tx`
          insert into synthesis_interpretation_contradictions (
            project_id, interpretation_id, synthesis_revision_id, sort_order,
            left_extraction_revision_id, right_extraction_revision_id
          ) values (
            ${projectId}, ${interpId}, ${synthesisRevisionId}, 0,
            ${sorted[0]}, ${sorted[1]}
          )
        `;

        await tx`update synthesis_interpretations set finalized_at = now() where id = ${interpId}`;
      }),
    ).rejects.toThrow(/synthesis_interpretation_contradictions/i);
  });

  it("enforces convergence matrix consistency at commit time", async () => {
    const convergentWithPairsId = crypto.randomUUID();
    const sortedRevs = [revisionAId, revisionBId].sort();

    // convergent with 1 pair must fail deferred validation
    await expect(
      client!.begin(async (tx) => {
        await tx`
          insert into synthesis_interpretations (
            id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary
          ) values (
            ${convergentWithPairsId}, ${projectId}, ${statementId}, ${synthesisRevisionId}, 'convergent', 'Claimed convergent'
          )
        `;
        await tx`
          insert into synthesis_interpretation_contradictions (
            project_id, interpretation_id, synthesis_revision_id, sort_order,
            left_extraction_revision_id, right_extraction_revision_id
          ) values (
            ${projectId}, ${convergentWithPairsId}, ${synthesisRevisionId}, 0,
            ${sortedRevs[0]}, ${sortedRevs[1]}
          )
        `;
        await tx`update synthesis_interpretations set finalized_at = now() where id = ${convergentWithPairsId}`;
      }),
    ).rejects.toThrow(/convergent synthesis interpretations must have exactly 0 contradiction pairs/i);

    // contradictory with 0 pairs must fail deferred validation
    const contradictoryWithoutPairsId = crypto.randomUUID();
    await expect(
      client!.begin(async (tx) => {
        await tx`
          insert into synthesis_interpretations (
            id, project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary
          ) values (
            ${contradictoryWithoutPairsId}, ${projectId}, ${statementId}, ${synthesisRevisionId}, 'contradictory', 'Claimed contradictory'
          )
        `;
        await tx`update synthesis_interpretations set finalized_at = now() where id = ${contradictoryWithoutPairsId}`;
      }),
    ).rejects.toThrow(/contradictory synthesis interpretations must have at least 1 contradiction pair/i);
  });
});
