import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolveEvidenceSetCompositionRevisionMembers } from "@/application/evidence-set-composition-resolver";
import { createDb } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";

const baseUrl = resolveDatabaseUrl();
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const migration0033Hash = createHash("sha256")
  .update(fs.readFileSync(path.join(migrationFolder, "0033_storage_materialization_recovery.sql")))
  .digest("hex");
const migration0034Hash = createHash("sha256")
  .update(fs.readFileSync(path.join(migrationFolder, "0034_evidence_set_composition_timeline.sql")))
  .digest("hex");
const migration0035Hash = createHash("sha256")
  .update(fs.readFileSync(path.join(migrationFolder, "0035_retrieved_record_run_order.sql")))
  .digest("hex");
const migration0036Hash = createHash("sha256")
  .update(fs.readFileSync(path.join(migrationFolder, "0036_ai_synthesis_preparation_history.sql")))
  .digest("hex");

function databaseUrl(name: string) {
  const url = new URL(baseUrl);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(prefix: string) {
  const name = `${prefix}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  return { name, admin, url: databaseUrl(name) };
}

function createPre0034MigrationFolder() {
  const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "litreview-slice45-pre0034-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, {
    recursive: true,
    filter: (source) => ![
      "0034_evidence_set_composition_timeline.sql",
      "0034_snapshot.json",
      "0035_retrieved_record_run_order.sql",
      "0035_snapshot.json",
      "0036_ai_synthesis_preparation_history.sql",
      "0036_snapshot.json",
    ].includes(path.basename(source)),
  });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((entry) => ![
    "0034_evidence_set_composition_timeline",
    "0035_retrieved_record_run_order",
    "0036_ai_synthesis_preparation_history",
  ].includes(entry.tag));
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return { tempRoot, folder: target };
}

function createFailing0034MigrationFolder() {
  const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "litreview-slice45-failed0034-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, { recursive: true });
  fs.rmSync(path.join(target, "0035_retrieved_record_run_order.sql"));
  fs.rmSync(path.join(target, "meta", "0035_snapshot.json"));
  fs.rmSync(path.join(target, "0036_ai_synthesis_preparation_history.sql"));
  fs.rmSync(path.join(target, "meta", "0036_snapshot.json"));
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((entry) => ![
    "0035_retrieved_record_run_order",
    "0036_ai_synthesis_preparation_history",
  ].includes(entry.tag));
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  fs.appendFileSync(
    path.join(target, "0034_evidence_set_composition_timeline.sql"),
    "\n--> statement-breakpoint\nDO $slice45_rollback_proof$ BEGIN RAISE EXCEPTION 'Slice 45 migration rollback proof'; END $slice45_rollback_proof$;\n",
  );
  return { tempRoot, folder: target };
}

type OldRevision = {
  id: string;
  sequence: string;
  evidenceSetId: string;
  members: string[];
};

describe("Slice 45 populated 0033 forward migration", () => {
  it("rolls back all 0034 schema changes and leaves the journal at 0033 on migration failure", async () => {
    const created = await freshDatabase("slice45_rollback");
    const pre0034 = createPre0034MigrationFolder();
    const failing0034 = createFailing0034MigrationFolder();
    const app = createDb(created.url);
    try {
      await migrate(app.db, { migrationsFolder: pre0034.folder });
      await expect(migrate(app.db, { migrationsFolder: failing0034.folder }))
        .rejects.toThrow(/Slice 45 migration rollback proof/);
      const [tail] = await app.client`select hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(tail.hash).toBe(migration0033Hash);
      const [legacyTable] = await app.client`select to_regclass('public.evidence_set_composition_members') as table_name`;
      const [timelineTable] = await app.client`select to_regclass('public.evidence_set_membership_order_versions') as table_name`;
      expect(legacyTable.table_name).toBe("evidence_set_composition_members");
      expect(timelineTable.table_name).toBeNull();
      const [ordinalColumn] = await app.client`
        select count(*)::int as count from information_schema.columns
        where table_schema='public' and table_name='evidence_set_composition_revisions' and column_name='set_ordinal'
      `;
      expect(ordinalColumn.count).toBe(0);
    } finally {
      await app.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}" with (force)`);
      await created.admin.end();
      fs.rmSync(pre0034.tempRoot, { recursive: true, force: true });
      fs.rmSync(failing0034.tempRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("preserves every exact historical ordered composition and existing pins", async () => {
    const created = await freshDatabase("slice45_forward");
    const pre0034 = createPre0034MigrationFolder();
    const app = createDb(created.url);
    try {
      await migrate(app.db, { migrationsFolder: pre0034.folder });
      const [preTail] = await app.client`select hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(preTail.hash).toBe(migration0033Hash);

      const projectId = randomUUID();
      const paperIds = Array.from({ length: 5 }, () => randomUUID());
      const evidenceIds = Array.from({ length: 5 }, () => randomUUID());
      const extractionFieldId = randomUUID();
      await app.client.begin(async (tx) => {
        await tx`insert into projects (id, title) values (${projectId}, 'Slice 45 migration fixture')`;
        for (let index = 0; index < paperIds.length; index += 1) {
          await tx`insert into papers (id, project_id, title) values (${paperIds[index]}, ${projectId}, ${`Paper ${index + 1}`})`;
          await tx`
            insert into evidence (id, project_id, paper_id, source_text, page_number)
            values (${evidenceIds[index]}, ${projectId}, ${paperIds[index]}, ${`Source evidence ${index + 1}`}, ${index + 1})
          `;
        }
        await tx`
          insert into extraction_fields (id, project_id, name, field_type)
          values (${extractionFieldId}, ${projectId}, 'Migration fixture field', 'short_text')
        `;
      });

      const createLegacySet = async (name: string) => {
        const evidenceSetId = randomUUID();
        const createdRevisionId = randomUUID();
        await app.client.begin(async (tx) => {
          await tx`insert into evidence_sets (id, project_id, name) values (${evidenceSetId}, ${projectId}, ${name})`;
          await tx`
            insert into evidence_set_composition_revisions (id, project_id, evidence_set_id, operation_kind)
            values (${createdRevisionId}, ${projectId}, ${evidenceSetId}, 'created')
          `;
        });
        return { evidenceSetId, createdRevisionId };
      };

      const set = await createLegacySet("Legacy reordered and archived Set");
      const membershipByEvidence = new Map<string, string>();
      let activeOrder: string[] = [];
      const insertLegacyRevision = async (input: {
        operation: "added" | "readded" | "removed" | "reordered";
        order: string[];
        newMembership?: { evidenceId: string; membershipId: string };
      }) => {
        const revisionId = randomUUID();
        await app.client.begin(async (tx) => {
          if (input.newMembership) {
            await tx`
              insert into evidence_set_memberships (id, project_id, evidence_set_id, evidence_id)
              values (${input.newMembership.membershipId}, ${projectId}, ${set.evidenceSetId}, ${input.newMembership.evidenceId})
            `;
          }
          await tx`
            insert into evidence_set_composition_revisions (id, project_id, evidence_set_id, operation_kind)
            values (${revisionId}, ${projectId}, ${set.evidenceSetId}, ${input.operation})
          `;
          for (let index = 0; index < input.order.length; index += 1) {
            await tx`
              insert into evidence_set_composition_members
                (project_id, evidence_set_id, composition_revision_id, membership_id, sort_order)
              values (${projectId}, ${set.evidenceSetId}, ${revisionId}, ${input.order[index]}, ${index + 1})
            `;
          }
        });
        activeOrder = [...input.order];
        return revisionId;
      };

      const addEvidence = async (evidenceIndex: number) => {
        const evidenceId = evidenceIds[evidenceIndex];
        const previousMembershipId = membershipByEvidence.get(evidenceId);
        const membershipId = previousMembershipId ?? randomUUID();
        const operation = previousMembershipId ? "readded" : "added";
        const revisionId = await insertLegacyRevision({
          operation,
          order: [...activeOrder, membershipId],
          ...(!previousMembershipId ? { newMembership: { evidenceId, membershipId } } : {}),
        });
        membershipByEvidence.set(evidenceId, membershipId);
        return { revisionId, membershipId };
      };

      const first = await addEvidence(0);
      const second = await addEvidence(1);
      const third = await addEvidence(2);
      const pinnedRevisionId = third.revisionId;
      await insertLegacyRevision({
        operation: "removed",
        order: activeOrder.filter((id) => id !== second.membershipId),
      });
      const readded = await addEvidence(1);
      const reorderedRevisionId = await insertLegacyRevision({
        operation: "reordered",
        order: [third.membershipId, first.membershipId, readded.membershipId],
      });
      await insertLegacyRevision({
        operation: "removed",
        order: activeOrder.filter((id) => id !== first.membershipId),
      });
      await addEvidence(0);

      const archivedSet = await createLegacySet("Legacy archived empty Set");
      await app.client`update evidence_sets set archived_at=now() where project_id=${projectId} and id=${archivedSet.evidenceSetId}`;

      const annotationId = randomUUID();
      const preparationId = randomUUID();
      await app.client.begin(async (tx) => {
        await tx`
          insert into evidence_set_annotations (id, project_id, evidence_set_id, body)
          values (${annotationId}, ${projectId}, ${set.evidenceSetId}, 'Pinned before the 0034 migration')
        `;
        await tx`
          insert into synthesis_preparations
            (id, project_id, evidence_set_id, evidence_set_composition_revision_id, extraction_field_id, working_title)
          values (${preparationId}, ${projectId}, ${set.evidenceSetId}, ${pinnedRevisionId}, ${extractionFieldId}, 'Pre-migration pin')
        `;
      });
      await app.client`update evidence_sets set archived_at=now() where project_id=${projectId} and id=${set.evidenceSetId}`;

      const oldRevisions = await app.client<OldRevision[]>`
        select r.id::text, r.sequence::text, r.evidence_set_id::text as "evidenceSetId",
          coalesce(array_agg(m.membership_id::text order by m.sort_order) filter (where m.membership_id is not null), array[]::text[]) as members
        from evidence_set_composition_revisions r
        left join evidence_set_composition_members m
          on m.project_id=r.project_id and m.evidence_set_id=r.evidence_set_id and m.composition_revision_id=r.id
        where r.project_id=${projectId}
        group by r.id, r.sequence, r.evidence_set_id
        order by r.sequence
      `;
      expect(oldRevisions.length).toBeGreaterThan(8);
      expect(oldRevisions.find((revision) => revision.id === reorderedRevisionId)?.members).toEqual([
        third.membershipId,
        first.membershipId,
        readded.membershipId,
      ]);

      await migrate(app.db, { migrationsFolder: migrationFolder });
      const appliedHashes = await app.client`select hash from drizzle.__drizzle_migrations order by id`;
      expect(appliedHashes.map((row) => row.hash)).toContain(migration0034Hash);
      expect(appliedHashes.map((row) => row.hash)).toContain(migration0035Hash);
      expect(appliedHashes.at(-1)?.hash).toBe(migration0036Hash);

      const [retiredSnapshot] = await app.client`select to_regclass('public.evidence_set_composition_members') as table_name`;
      expect(retiredSnapshot.table_name).toBeNull();
      const [preparation] = await app.client`
        select evidence_set_composition_revision_id::text as revision_id
        from synthesis_preparations where project_id=${projectId} and id=${preparationId}
      `;
      expect(preparation.revision_id).toBe(pinnedRevisionId);
      const [annotation] = await app.client`
        select body from evidence_set_annotations where project_id=${projectId} and id=${annotationId}
      `;
      expect(annotation.body).toBe("Pinned before the 0034 migration");
      const setRows = await app.client`
        select id::text, archived_at is not null as archived
        from evidence_sets where project_id=${projectId} order by id
      `;
      expect(setRows).toHaveLength(2);
      expect(setRows.every((row) => row.archived)).toBe(true);

      const revisionsAfter = await app.client`
        select id::text, sequence::text, set_ordinal::text
        from evidence_set_composition_revisions where project_id=${projectId}
        order by evidence_set_composition_revisions.sequence
      `;
      expect(revisionsAfter.map((revision) => [revision.id, revision.sequence])).toEqual(
        oldRevisions.map((revision) => [revision.id, revision.sequence]),
      );
      for (const revision of oldRevisions) {
        const reconstructed = await resolveEvidenceSetCompositionRevisionMembers(
          app.db,
          projectId,
          revision.evidenceSetId,
          revision.id,
        );
        expect(reconstructed.map((member) => member.membershipId), `revision ${revision.id}`).toEqual(revision.members);
      }
    } finally {
      await app.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}" with (force)`);
      await created.admin.end();
      fs.rmSync(pre0034.tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
