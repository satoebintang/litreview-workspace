import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const databaseName = `slice20_upgrade_${Date.now()}`;

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

describe("Slice 20 migration boundary & database rules", () => {
  let client: postgres.Sql | undefined;
  let databaseCreated = false;
  let projectId = "";
  let otherProjectId = "";
  let questionId = "";
  let archivedQuestionId = "";
  let otherProjectQuestionId = "";
  let fieldId = "";
  let archivedFieldId = "";
  let evidenceSetId = "";
  let statementId = "";
  let claimId = "";

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
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 19)) {
      await runMigration(client, `${entry.tag}.sql`);
    }

    // Populate representative Slice 19 state
    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 20 upgrade project') returning id`;
    [{ id: otherProjectId }] = await client`insert into projects (title) values ('Other project') returning id`;

    [{ id: questionId }] = await client`
      insert into research_questions (project_id, identifier, label, sort_order)
      values (${projectId}, 'RQ1', 'Main question', 0)
      returning id
    `;

    [{ id: archivedQuestionId }] = await client`
      insert into research_questions (project_id, identifier, label, sort_order, archived_at)
      values (${projectId}, 'RQ2', 'Archived question', 1, now())
      returning id
    `;

    [{ id: otherProjectQuestionId }] = await client`
      insert into research_questions (project_id, identifier, label, sort_order)
      values (${otherProjectId}, 'RQ1', 'Other question', 0)
      returning id
    `;

    [{ id: fieldId }] = await client`
      insert into extraction_fields (project_id, name, field_type)
      values (${projectId}, 'Sample Size', 'number')
      returning id
    `;

    [{ id: archivedFieldId }] = await client`
      insert into extraction_fields (project_id, name, field_type, archived_at)
      values (${projectId}, 'Old Field', 'short_text', now())
      returning id
    `;

    await client.begin(async (tx) => {
      [{ id: evidenceSetId }] = await tx`
        insert into evidence_sets (project_id, name, description)
        values (${projectId}, 'Primary Trials', 'Included RCTs')
        returning id
      `;
      await tx`
        insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind)
        values (${projectId}, ${evidenceSetId}, 'created')
      `;
    });

    [{ id: statementId }] = await client`
      insert into synthesis_statements (project_id)
      values (${projectId})
      returning id
    `;

    [{ id: claimId }] = await client`
      insert into claims (project_id)
      values (${projectId})
      returning id
    `;

    // Now run Migration 0020
    await runMigration(client, "0020_research_question_traceability.sql");
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
    if (databaseCreated) {
      const admin = postgres(BASE_URL, { max: 1 });
      try {
        await admin.unsafe(`drop database if exists "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  });

  it("enforces first-event must be 'linked'", async () => {
    if (!client) throw new Error("Database client missing");

    // First event 'unlinked' should fail
    await expect(
      client`
        insert into research_question_extraction_field_events
          (project_id, research_question_id, extraction_field_id, action)
        values
          (${projectId}, ${questionId}, ${fieldId}, 'unlinked')
      `,
    ).rejects.toThrow();

    // First event 'linked' should succeed
    const [linkedEvent] = await client`
      insert into research_question_extraction_field_events
        (project_id, research_question_id, extraction_field_id, action, note)
      values
        (${projectId}, ${questionId}, ${fieldId}, 'linked', 'Initial link')
      returning *
    `;
    expect(linkedEvent.action).toBe("linked");
    expect(Number(linkedEvent.sequence)).toBeGreaterThan(0);
    expect(linkedEvent.note).toBe("Initial link");
  });

  it("rejects duplicate 'linked -> linked' transitions", async () => {
    if (!client) throw new Error("Database client missing");

    await expect(
      client`
        insert into research_question_extraction_field_events
          (project_id, research_question_id, extraction_field_id, action)
        values
          (${projectId}, ${questionId}, ${fieldId}, 'linked')
      `,
    ).rejects.toThrow();
  });

  it("allows 'linked -> unlinked' and rejects duplicate 'unlinked -> unlinked'", async () => {
    if (!client) throw new Error("Database client missing");

    const [unlinkedEvent] = await client`
      insert into research_question_extraction_field_events
        (project_id, research_question_id, extraction_field_id, action, note)
      values
        (${projectId}, ${questionId}, ${fieldId}, 'unlinked', 'Removed from scope')
      returning *
    `;
    expect(unlinkedEvent.action).toBe("unlinked");
    expect(Number(unlinkedEvent.sequence)).toBeGreaterThan(0);

    // Duplicate unlinked fails
    await expect(
      client`
        insert into research_question_extraction_field_events
          (project_id, research_question_id, extraction_field_id, action)
        values
          (${projectId}, ${questionId}, ${fieldId}, 'unlinked')
      `,
    ).rejects.toThrow();
  });

  it("allows relinking: 'unlinked -> linked'", async () => {
    if (!client) throw new Error("Database client missing");

    const [relinkedEvent] = await client`
      insert into research_question_extraction_field_events
        (project_id, research_question_id, extraction_field_id, action, note)
      values
        (${projectId}, ${questionId}, ${fieldId}, 'linked', 'Restored to scope')
      returning *
    `;
    expect(relinkedEvent.action).toBe("linked");
    expect(Number(relinkedEvent.sequence)).toBeGreaterThan(0);
  });

  it("rejects UPDATE and DELETE on event tables (append-only)", async () => {
    if (!client) throw new Error("Database client missing");

    await expect(
      client`
        update research_question_extraction_field_events
        set note = 'hacked'
        where project_id = ${projectId}
      `,
    ).rejects.toThrow(/append-only/i);

    await expect(
      client`
        delete from research_question_extraction_field_events
        where project_id = ${projectId}
      `,
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects mutations on archived research questions", async () => {
    if (!client) throw new Error("Database client missing");

    await expect(
      client`
        insert into research_question_extraction_field_events
          (project_id, research_question_id, extraction_field_id, action)
        values
          (${projectId}, ${archivedQuestionId}, ${fieldId}, 'linked')
      `,
    ).rejects.toThrow();
  });

  it("allows linking archived targets without error", async () => {
    if (!client) throw new Error("Database client missing");

    const [event] = await client`
      insert into research_question_extraction_field_events
        (project_id, research_question_id, extraction_field_id, action, note)
      values
        (${projectId}, ${questionId}, ${archivedFieldId}, 'linked', 'Archived field link')
      returning *
    `;
    expect(event.action).toBe("linked");
    expect(event.extraction_field_id).toBe(archivedFieldId);
  });

  it("enforces note trimming and nonblank constraint", async () => {
    if (!client) throw new Error("Database client missing");

    // Blank note (only whitespace) rejected
    await expect(
      client`
        insert into research_question_evidence_set_events
          (project_id, research_question_id, evidence_set_id, action, note)
        values
          (${projectId}, ${questionId}, ${evidenceSetId}, 'linked', '   ')
      `,
    ).rejects.toThrow();

    // Valid note with whitespace gets trimmed
    const [event] = await client`
      insert into research_question_evidence_set_events
        (project_id, research_question_id, evidence_set_id, action, note)
      values
        (${projectId}, ${questionId}, ${evidenceSetId}, 'linked', '  PICO Population set  ')
      returning *
    `;
    expect(event.note).toBe("PICO Population set");
  });

  it("enforces cross-project foreign key isolation", async () => {
    if (!client) throw new Error("Database client missing");

    // Question from other project cannot be linked with target from this project
    await expect(
      client`
        insert into research_question_synthesis_statement_events
          (project_id, research_question_id, synthesis_statement_id, action)
        values
          (${projectId}, ${otherProjectQuestionId}, ${statementId}, 'linked')
      `,
    ).rejects.toThrow();
  });

  it("supports synthesis statements and claims event transitions", async () => {
    if (!client) throw new Error("Database client missing");

    // Synthesis statement link
    const [synthEvent] = await client`
      insert into research_question_synthesis_statement_events
        (project_id, research_question_id, synthesis_statement_id, action)
      values
        (${projectId}, ${questionId}, ${statementId}, 'linked')
      returning *
    `;
    expect(synthEvent.action).toBe("linked");

    // Claim link
    const [claimEvent] = await client`
      insert into research_question_claim_events
        (project_id, research_question_id, claim_id, action)
      values
        (${projectId}, ${questionId}, ${claimId}, 'linked')
      returning *
    `;
    expect(claimEvent.action).toBe("linked");
  });
});
