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
const migration0037Path = path.join(migrationFolder, "0037_research_question_traceability_epoch.sql");
const migration0037Hash = createHash("sha256").update(fs.readFileSync(migration0037Path)).digest("hex");

function databaseUrl(name: string) {
  const url = new URL(baseUrl);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(prefix: string) {
  const name = `${prefix}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(baseUrl, { max: 1, prepare: false });
  await admin.unsafe(`create database "${name}"`);
  return { name, admin, url: databaseUrl(name) };
}

function createSlice47MigrationFolder() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "litreview-slice48-slice47-baseline-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, {
    recursive: true,
    filter: (source) => ![
      "0037_research_question_traceability_epoch.sql",
      "0037_snapshot.json",
    ].includes(path.basename(source)),
  });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 36) }, null, 2)}\n`,
    "utf8",
  );
  return { tempRoot, folder: target };
}

async function seedLegacyQuestionAndEvent(client: postgres.Sql, includeEvent = true) {
  const projectId = randomUUID();
  const questionId = randomUUID();
  const claimId = randomUUID();
  await client.begin(async (tx) => {
    await tx`insert into projects (id,title) values (${projectId},'Slice 48 forward migration fixture')`;
    await tx`
      insert into research_questions (id,project_id,identifier,label,sort_order)
      values (${questionId},${projectId},'RQ-forward','Existing Question before 0037',0)
    `;
    await tx`insert into claims (id,project_id) values (${claimId},${projectId})`;
    if (includeEvent) {
      await tx`
        insert into research_question_claim_events (project_id,research_question_id,claim_id,action,note)
        values (${projectId},${questionId},${claimId},'linked','Existing event before 0037')
      `;
    }
  });
  return { projectId, questionId, claimId };
}

describe("Slice 48 traceability epoch migration", () => {
  it("migrates fresh and populated Slice 47 schemas without losing history", async () => {
    const fresh = await freshDatabase("slice48_fresh");
    const forward = await freshDatabase("slice48_forward");
    const slice47 = createSlice47MigrationFolder();
    const freshApp = createDb(fresh.url);
    const forwardApp = createDb(forward.url);
    try {
      await migrate(freshApp.db, { migrationsFolder: migrationFolder });
      const freshIds = await seedLegacyQuestionAndEvent(freshApp.client, false);
      const [freshEpoch] = await freshApp.client`
        select traceability_epoch::text as epoch from research_questions where project_id=${freshIds.projectId} and id=${freshIds.questionId}
      `;
      const [freshTail] = await freshApp.client`select id,hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      const freshTriggers = await freshApp.client`
        select t.tgname,t.tgenabled
        from pg_trigger t
        where not t.tgisinternal and t.tgname in (
          'rq_extraction_field_events_epoch_after_insert',
          'rq_evidence_set_events_epoch_after_insert',
          'rq_synthesis_statement_events_epoch_after_insert',
          'rq_claim_events_epoch_after_insert'
        )
        order by t.tgname
      `;
      expect(freshEpoch.epoch).toBe("0");
      expect(Number(freshTail.id)).toBe(38);
      expect(freshTail.hash).toBe(migration0037Hash);
      expect(freshTriggers).toHaveLength(4);
      expect(freshTriggers.every((trigger) => trigger.tgenabled === "O")).toBe(true);
      await freshApp.client`
        insert into research_question_claim_events (project_id,research_question_id,claim_id,action,note)
        values (${freshIds.projectId},${freshIds.questionId},${freshIds.claimId},'linked','Valid event after 0037')
      `;
      const [freshEpochAfterInsert] = await freshApp.client`
        select traceability_epoch::text as epoch from research_questions where project_id=${freshIds.projectId} and id=${freshIds.questionId}
      `;
      expect(freshEpochAfterInsert.epoch).toBe("1");

      await migrate(forwardApp.db, { migrationsFolder: slice47.folder });
      const forwardIds = await seedLegacyQuestionAndEvent(forwardApp.client);
      const [beforeMigration] = await forwardApp.client`
        select q.updated_at::text as updated_at,e.id::text as event_id,e.sequence::text as sequence,e.action,e.note
        from research_questions q
        join research_question_claim_events e on e.project_id=q.project_id and e.research_question_id=q.id
        where q.project_id=${forwardIds.projectId} and q.id=${forwardIds.questionId}
      `;
      const [slice47Tail] = await forwardApp.client`select id,hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(Number(slice47Tail.id)).toBe(37);

      await migrate(forwardApp.db, { migrationsFolder: migrationFolder });
      const [afterMigration] = await forwardApp.client`
        select q.traceability_epoch::text as epoch,q.updated_at::text as updated_at,
          e.id::text as event_id,e.sequence::text as sequence,e.action,e.note
        from research_questions q
        join research_question_claim_events e on e.project_id=q.project_id and e.research_question_id=q.id
        where q.project_id=${forwardIds.projectId} and q.id=${forwardIds.questionId}
      `;
      const [forwardTail] = await forwardApp.client`select id,hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(afterMigration).toMatchObject({
        epoch: "0",
        updated_at: beforeMigration.updated_at,
        event_id: beforeMigration.event_id,
        sequence: beforeMigration.sequence,
        action: beforeMigration.action,
        note: beforeMigration.note,
      });
      expect(Number(forwardTail.id)).toBe(38);
      expect(forwardTail.hash).toBe(migration0037Hash);

      const nextClaimId = randomUUID();
      await forwardApp.client`insert into claims (id,project_id) values (${nextClaimId},${forwardIds.projectId})`;
      await forwardApp.client`
        insert into research_question_claim_events (project_id,research_question_id,claim_id,action)
        values (${forwardIds.projectId},${forwardIds.questionId},${nextClaimId},'linked')
      `;
      const [afterInsert] = await forwardApp.client`
        select traceability_epoch::text as epoch from research_questions where project_id=${forwardIds.projectId} and id=${forwardIds.questionId}
      `;
      expect(afterInsert.epoch).toBe("1");

      const rolledBackClaimId = randomUUID();
      await forwardApp.client`insert into claims (id,project_id) values (${rolledBackClaimId},${forwardIds.projectId})`;
      await expect(forwardApp.client.begin(async (tx) => {
        await tx`
          insert into research_question_claim_events (project_id,research_question_id,claim_id,action)
          values (${forwardIds.projectId},${forwardIds.questionId},${rolledBackClaimId},'linked')
        `;
        const [inside] = await tx`
          select traceability_epoch::text as epoch from research_questions where project_id=${forwardIds.projectId} and id=${forwardIds.questionId}
        `;
        expect(inside.epoch).toBe("2");
        throw new Error("rollback 0037 epoch increment");
      })).rejects.toThrow("rollback 0037 epoch increment");
      const [afterRollback] = await forwardApp.client`
        select q.traceability_epoch::text as epoch,
          (select count(*)::int from research_question_claim_events e where e.project_id=q.project_id and e.research_question_id=q.id and e.claim_id=${rolledBackClaimId}) as rolled_back_events
        from research_questions q where q.project_id=${forwardIds.projectId} and q.id=${forwardIds.questionId}
      `;
      expect(afterRollback).toEqual({ epoch: "1", rolled_back_events: 0 });
    } finally {
      await freshApp.client.end();
      await forwardApp.client.end();
      await fresh.admin.unsafe(`drop database if exists "${fresh.name}" with (force)`);
      await forward.admin.unsafe(`drop database if exists "${forward.name}" with (force)`);
      await fresh.admin.end();
      await forward.admin.end();
      fs.rmSync(slice47.tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
