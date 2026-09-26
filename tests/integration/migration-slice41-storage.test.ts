import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolveDatabaseUrl } from "@/db/config";

const baseUrl = resolveDatabaseUrl();
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const migrationPath = path.join(migrationFolder, "0033_storage_materialization_recovery.sql");
const migrationHash = createHash("sha256").update(fs.readFileSync(migrationPath)).digest("hex");

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

function createPre0033MigrationFolder() {
  const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "litreview-slice41-pre0033-"));
  const target = path.join(tempRoot, "drizzle");
  fs.cpSync(migrationFolder, target, {
    recursive: true,
    filter: (source) => !["0033_storage_materialization_recovery.sql", "0033_snapshot.json"].includes(path.basename(source)),
  });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((entry) => entry.tag !== "0033_storage_materialization_recovery");
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return { tempRoot, folder: target };
}

function stageKey() {
  return `.tmp/${randomUUID()}.upload`;
}

function intakeStageKey() {
  return `.pdf-intake/.tmp/${randomUUID()}.upload`;
}

describe("Slice 41 storage materialization migration and database invariants", () => {
  it("applies the fresh migration chain with explicit storage-state inserts and exact transition guards", async () => {
    const created = await freshDatabase("slice41_fresh");
    const app = createDb(created.url);
    try {
      await migrate(app.db, { migrationsFolder: migrationFolder });
      const [latest] = await app.client`select hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(latest.hash).toBe(migrationHash);
      const defaults = await app.client`
        select table_name, column_default, is_nullable
        from information_schema.columns
        where table_schema='public' and table_name in ('full_text_documents', 'pdf_intakes') and column_name='storage_state'
        order by table_name
      `;
      expect(defaults).toEqual([
        { table_name: "full_text_documents", column_default: null, is_nullable: "NO" },
        { table_name: "pdf_intakes", column_default: null, is_nullable: "NO" },
      ]);

      const services = createReviewServices(app.db);
      const project = await services.createProject({ title: `Slice 41 trigger matrix ${randomUUID()}` });
      const paper = await services.addPaper(project.id, { title: "Storage transition Paper" });
      const otherPaper = await services.addPaper(project.id, { title: "Storage resolution Paper" });

      const insertDocument = async (sha256: string, state: "pending" | "ready", stage: string | null, paperId = paper.id) => {
        const id = randomUUID();
        const storageKey = `projects/${project.id}/papers/${paperId}/documents/${id}/source.pdf`;
        await app.client`
          insert into full_text_documents
            (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key)
          values (${id}, ${project.id}, ${paperId}, ${storageKey}, 'trigger.pdf', 'application/pdf', 9, ${sha256}, ${state}, ${stage})
        `;
        return { id, storageKey };
      };

      const insertIntake = async (sha256: string, state: "pending" | "ready", stage: string | null) => {
        const id = randomUUID();
        const storageKey = `projects/${project.id}/pdf-intakes/${id}/source.pdf`;
        await app.client`
          insert into pdf_intakes
            (id, project_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key)
          values (${id}, ${project.id}, ${storageKey}, 'trigger.pdf', 'application/pdf', 9, ${sha256}, ${state}, ${stage})
        `;
        return { id, storageKey };
      };
      const insertMetadataResult = async (intakeId: string) => {
        const id = randomUUID();
        await app.client`
          insert into pdf_intake_metadata_results
            (id, sequence_no, project_id, intake_id, status, extractor_key, extractor_version,
             mapping_version, text_scan_version, doi_algorithm_version,
             attempted_page_count, succeeded_page_count, scanned_code_points,
             error_code, error_message, completed_at)
          values (${id}, 1, ${project.id}, ${intakeId}, 'failed', 'slice41-test', 'test-v1',
             'map-v1', 'scan-v1', 'doi-v1', 0, 0, 0, 'fixture_error', 'fixture failed', now())
        `;
        return id;
      };
      const insertResolution = (input: {
        intakeId: string;
        resultId: string;
        documentId: string;
        paperId: string;
        kind: "created_document" | "reused_document";
        resolutionId?: string;
      }) => app.client`
        insert into pdf_intake_resolutions
          (id, project_id, intake_id, metadata_result_id, resolution_kind, paper_id,
           full_text_document_id, materialization_kind, creation_payload, candidate_context,
           preview_fingerprint, request_fingerprint)
        values (${input.resolutionId ?? randomUUID()}, ${project.id}, ${input.intakeId}, ${input.resultId},
           'match_paper', ${input.paperId}, ${input.documentId}, ${input.kind}, null, '{}'::jsonb,
           ${"a".repeat(64)}, ${"b".repeat(64)})
      `;
      const reject = async (promise: Promise<unknown>) => expect(promise).rejects.toBeTruthy();

      const pendingDocument = await insertDocument(createHash("sha256").update("pending-doc").digest("hex"), "pending", stageKey());
      const replacementStage = stageKey();
      await app.client`update full_text_documents set staged_storage_key=${replacementStage} where id=${pendingDocument.id}`;
      await reject(app.client`update full_text_documents set sha256=${"0".repeat(64)} where id=${pendingDocument.id}`);
      await reject(app.client`update full_text_documents set byte_size=10 where id=${pendingDocument.id}`);
      const changedDocumentKey = `projects/${project.id}/papers/${paper.id}/documents/${randomUUID()}/source.pdf`;
      await reject(app.client`update full_text_documents set storage_key=${changedDocumentKey} where id=${pendingDocument.id}`);
      await reject(app.client`update full_text_documents set archived_at=now() where id=${pendingDocument.id}`);
      await reject(app.client`update full_text_documents set storage_state='ready', staged_storage_key=null, archived_at=now() where id=${pendingDocument.id}`);
      await app.client`update full_text_documents set storage_state='ready', staged_storage_key=null where id=${pendingDocument.id}`;
      await reject(app.client`update full_text_documents set storage_state='pending', staged_storage_key=${stageKey()} where id=${pendingDocument.id}`);
      await reject(app.client`update full_text_documents set staged_storage_key=${stageKey()} where id=${pendingDocument.id}`);
      await app.client`update full_text_documents set archived_at=now() where id=${pendingDocument.id}`;
      await reject(app.client`update full_text_documents set archived_at=null where id=${pendingDocument.id}`);

      const pendingArchive = await insertDocument(createHash("sha256").update("pending-archive").digest("hex"), "pending", stageKey());
      await reject(app.client`update full_text_documents set archived_at=now() where id=${pendingArchive.id}`);

      const pendingIntake = await insertIntake(createHash("sha256").update("pending-intake").digest("hex"), "pending", intakeStageKey());
      await app.client`update pdf_intakes set staged_storage_key=${intakeStageKey()} where id=${pendingIntake.id}`;
      await reject(app.client`update pdf_intakes set sha256=${"1".repeat(64)} where id=${pendingIntake.id}`);
      await reject(app.client`update pdf_intakes set byte_size=10 where id=${pendingIntake.id}`);
      const changedIntakeKey = `projects/${project.id}/pdf-intakes/${randomUUID()}/source.pdf`;
      await reject(app.client`update pdf_intakes set storage_key=${changedIntakeKey} where id=${pendingIntake.id}`);
      await app.client`update pdf_intakes set storage_state='ready', staged_storage_key=null where id=${pendingIntake.id}`;
      await reject(app.client`update pdf_intakes set storage_state='pending', staged_storage_key=${intakeStageKey()} where id=${pendingIntake.id}`);

      const pendingSource = await insertIntake(createHash("sha256").update("pending-source").digest("hex"), "pending", intakeStageKey());
      const pendingSourceResult = await insertMetadataResult(pendingSource.id);
      const pendingSourceDocument = await insertDocument(createHash("sha256").update("pending-source").digest("hex"), "pending", stageKey(), otherPaper.id);
      await reject(insertResolution({ intakeId: pendingSource.id, resultId: pendingSourceResult, documentId: pendingSourceDocument.id, paperId: otherPaper.id, kind: "created_document" }));

      const createdHash = createHash("sha256").update("created-pending-resolution").digest("hex");
      const createdIntake = await insertIntake(createdHash, "ready", null);
      const createdResult = await insertMetadataResult(createdIntake.id);
      const createdPendingDocument = await insertDocument(createdHash, "pending", stageKey(), otherPaper.id);
      await insertResolution({ intakeId: createdIntake.id, resultId: createdResult, documentId: createdPendingDocument.id, paperId: otherPaper.id, kind: "created_document" });

      const reusedPendingHash = createHash("sha256").update("reused-pending-resolution").digest("hex");
      const reusedPendingIntake = await insertIntake(reusedPendingHash, "ready", null);
      const reusedPendingResult = await insertMetadataResult(reusedPendingIntake.id);
      const reusedPendingDocument = await insertDocument(reusedPendingHash, "pending", stageKey(), otherPaper.id);
      await reject(insertResolution({ intakeId: reusedPendingIntake.id, resultId: reusedPendingResult, documentId: reusedPendingDocument.id, paperId: otherPaper.id, kind: "reused_document" }));

      const reusedReadyHash = createHash("sha256").update("reused-ready-resolution").digest("hex");
      const reusedReadyIntake = await insertIntake(reusedReadyHash, "ready", null);
      const reusedReadyResult = await insertMetadataResult(reusedReadyIntake.id);
      const reusedReadyDocument = await insertDocument(reusedReadyHash, "ready", null, otherPaper.id);
      await insertResolution({ intakeId: reusedReadyIntake.id, resultId: reusedReadyResult, documentId: reusedReadyDocument.id, paperId: otherPaper.id, kind: "reused_document" });

      const guardHash = createHash("sha256").update("ready-only-guards").digest("hex");
      const nonReadyDocument = await insertDocument(guardHash, "pending", stageKey());
      await reject(app.client`
        insert into paper_full_text_preferences (project_id, paper_id, full_text_document_id)
        values (${project.id}, ${paper.id}, ${nonReadyDocument.id})
      `);
      await reject(app.client`
        insert into document_text_extractions
          (project_id, paper_id, full_text_document_id, extractor_key, extractor_version,
           algorithm_version, status, page_count, character_count)
        values (${project.id}, ${paper.id}, ${nonReadyDocument.id}, 'test', 'v1', 'a1', 'succeeded', 1, 0)
      `);
      await reject(app.client`
        insert into evidence (project_id, paper_id, full_text_document_id, source_text, page_number)
        values (${project.id}, ${paper.id}, ${nonReadyDocument.id}, 'not yet materialized', 1)
      `);

      const readyHash = createHash("sha256").update("ready-document-guards").digest("hex");
      const readyDocument = await insertDocument(readyHash, "ready", null);
      const extractionId = randomUUID();
      await app.client.begin(async (tx) => {
        await tx`
          insert into document_text_extractions
            (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version,
             algorithm_version, status, page_count, character_count)
          values (${extractionId}, ${project.id}, ${paper.id}, ${readyDocument.id}, 'test', 'v1', 'a1', 'succeeded', 1, 4)
        `;
        await tx`
          insert into document_text_extraction_pages
            (project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count)
          values (${project.id}, ${paper.id}, ${extractionId}, 1, 'succeeded', 'text', 4)
        `;
      });
      const evidenceId = randomUUID();
      await app.client`
        insert into evidence
          (id, project_id, paper_id, full_text_document_id, document_text_extraction_id,
           extraction_start_offset, extraction_end_offset, source_text, page_number)
        values (${evidenceId}, ${project.id}, ${paper.id}, ${readyDocument.id}, ${extractionId}, 0, 4, 'text', 1)
      `;
      await reject(app.client`update evidence set source_text='changed extracted evidence' where id=${evidenceId}`);
      await app.client`
        insert into paper_full_text_preferences (project_id, paper_id, full_text_document_id)
        values (${project.id}, ${paper.id}, ${readyDocument.id})
      `;
    } finally {
      await app.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}" with (force)`);
      await created.admin.end();
    }
  }, 180_000);

  it("backfills existing document and intake rows as ready on a populated forward migration", async () => {
    const created = await freshDatabase("slice41_forward");
    const pre0033 = createPre0033MigrationFolder();
    const app = createDb(created.url);
    try {
      await migrate(app.db, { migrationsFolder: pre0033.folder });
      const services = createReviewServices(app.db);
      const project = await services.createProject({ title: `Slice 41 forward migration ${randomUUID()}` });
      const paper = await services.addPaper(project.id, { title: "Legacy document Paper" });
      const documentId = randomUUID();
      const documentHash = createHash("sha256").update("legacy document").digest("hex");
      await app.client`
        insert into full_text_documents
          (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256)
        values (${documentId}, ${project.id}, ${paper.id},
          ${`projects/${project.id}/papers/${paper.id}/documents/${documentId}/source.pdf`},
          'legacy.pdf', 'application/pdf', 15, ${documentHash})
      `;
      const intakeId = randomUUID();
      const intakeHash = createHash("sha256").update("legacy intake").digest("hex");
      await app.client`
        insert into pdf_intakes
          (id, project_id, storage_key, original_filename, media_type, byte_size, sha256)
        values (${intakeId}, ${project.id}, ${`projects/${project.id}/pdf-intakes/${intakeId}/source.pdf`},
          'legacy-intake.pdf', 'application/pdf', 13, ${intakeHash})
      `;

      await migrate(app.db, { migrationsFolder: migrationFolder });
      const [document] = await app.client`select storage_state, staged_storage_key from full_text_documents where id=${documentId}`;
      const [intake] = await app.client`select storage_state, staged_storage_key from pdf_intakes where id=${intakeId}`;
      expect(document).toEqual({ storage_state: "ready", staged_storage_key: null });
      expect(intake).toEqual({ storage_state: "ready", staged_storage_key: null });
      const columns = await app.client`
        select table_name, column_default, is_nullable
        from information_schema.columns
        where table_schema='public' and table_name in ('full_text_documents', 'pdf_intakes') and column_name='storage_state'
        order by table_name
      `;
      expect(columns).toEqual([
        { table_name: "full_text_documents", column_default: null, is_nullable: "NO" },
        { table_name: "pdf_intakes", column_default: null, is_nullable: "NO" },
      ]);
      const [latest] = await app.client`select hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(latest.hash).toBe(migrationHash);
    } finally {
      await app.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}" with (force)`);
      await created.admin.end();
      fs.rmSync(pre0033.tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
