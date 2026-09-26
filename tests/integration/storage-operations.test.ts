import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createReviewServices } from "@/application/services";
import { auditStorageReadOnly, reconcileStorage, storageOperationExitCode } from "@/application/storage-operations";
import { createDb } from "@/db/client";
import { LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

describe("storage audit and reconciliation", () => {
  it("reports corruption without deleting unknown artifacts and recovers only known pending owners", async () => {
    const databaseName = `slice41_storage_ops_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const app = createDb(databaseUrl(databaseName));
    const root = await mkdtemp(path.join(os.tmpdir(), "litreview_slice41_storage_ops_"));
    const documentStorage = new LocalDocumentStorage(root);
    const intakeStorage = new LocalPdfIntakeStorage(root);
    try {
      await migrate(app.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
      const base = createReviewServices(app.db, { documentStorage, pdfIntakeStorage: intakeStorage });
      const project = await base.createProject({ title: `Storage report ${randomUUID()}` });
      const paper = await base.addPaper(project.id, { title: "Storage report Paper" });

      let armedPhase: "good" | "mismatch" | "stage-mismatch" | null = null;
      const crashService = createReviewServices(app.db, {
        documentStorage,
        pdfIntakeStorage: intakeStorage,
        onStorageCheckpoint: async (phase, context) => {
          if (phase === "after_pending_commit" && context.flow === "full_text_document" && armedPhase) {
            armedPhase = null;
            throw new Error("simulated process stop after pending commit");
          }
        },
      });
      const goodBytes = Buffer.from("%PDF-1.7\nreconcile good pending row");
      armedPhase = "good";
      await expect(crashService.uploadFullTextDocument(project.id, paper.id, { originalFilename: "good.pdf", mediaType: "application/pdf" }, Readable.from([goodBytes])))
        .rejects.toThrow("simulated process stop");
      const mismatchBytes = Buffer.from("%PDF-1.7\nreconcile bad final row");
      armedPhase = "mismatch";
      await expect(crashService.uploadFullTextDocument(project.id, paper.id, { originalFilename: "mismatch.pdf", mediaType: "application/pdf" }, Readable.from([mismatchBytes])))
        .rejects.toThrow("simulated process stop");
      const stageMismatchBytes = Buffer.from("%PDF-1.7\nstage bytes do not match owner");
      armedPhase = "stage-mismatch";
      await expect(crashService.uploadFullTextDocument(project.id, paper.id, { originalFilename: "stage-mismatch.pdf", mediaType: "application/pdf" }, Readable.from([stageMismatchBytes])))
        .rejects.toThrow("simulated process stop");

      const [pendingMismatch] = await app.client`
        select id, storage_key, staged_storage_key
        from full_text_documents where project_id=${project.id} and sha256=${createHash("sha256").update(mismatchBytes).digest("hex")}
      `;
      const conflictingBytes = Buffer.from("%PDF-1.7\nconcurrent unknown final");
      const conflictingStage = await documentStorage.stage(Readable.from([conflictingBytes]));
      await documentStorage.install(conflictingStage.temporaryKey, String(pendingMismatch.storage_key));
      await documentStorage.remove(conflictingStage.temporaryKey);
      const [pendingStageMismatch] = await app.client`
        select id, staged_storage_key, storage_key from full_text_documents
        where project_id=${project.id} and sha256=${createHash("sha256").update(stageMismatchBytes).digest("hex")}
      `;
      await documentStorage.remove(String(pendingStageMismatch.staged_storage_key));
      const conflictingStageBytes = Buffer.from("%PDF-1.7\nstaged bytes do not match owner");
      await writeFile(path.join(root, String(pendingStageMismatch.staged_storage_key)), conflictingStageBytes);

      const missingBytes = Buffer.from("%PDF-1.7\nmissing ready final");
      const missing = await base.uploadFullTextDocument(project.id, paper.id, { originalFilename: "missing.pdf", mediaType: "application/pdf" }, Readable.from([missingBytes]));
      await documentStorage.remove(missing.document.storageKey);

      const unknownFinalKey = `projects/${project.id}/papers/${paper.id}/documents/${randomUUID()}/source.pdf`;
      const unknownStage = await documentStorage.stage(Readable.from([Buffer.from("%PDF-1.7\nunknown stage")]));
      const orphanStage = await documentStorage.stage(Readable.from([Buffer.from("%PDF-1.7\nunknown final")]));
      await documentStorage.install(orphanStage.temporaryKey, unknownFinalKey);
      await documentStorage.remove(orphanStage.temporaryKey);

      const beforePending = await app.client`select count(*)::int as count from full_text_documents where project_id=${project.id} and storage_state='pending'`;
      expect(Number(beforePending[0].count)).toBe(3);
      const audit = await auditStorageReadOnly(app.db, { documentStorage, intakeStorage, projectId: project.id });
      expect(audit.counts.pending).toBe(3);
      expect(audit.counts.pendingRecoverable).toBe(1);
      expect(audit.counts.missingReady).toBe(1);
      expect(audit.counts.integrityConflict).toBe(2);
      expect(audit.counts.unresolved).toBe(3);
      expect(audit.counts.orphanFinal).toBe(1);
      expect(audit.counts.unknownStaged).toBe(1);
      expect(storageOperationExitCode(audit)).toBe(1);
      expect(Number((await app.client`select count(*)::int as count from full_text_documents where project_id=${project.id} and storage_state='pending'`)[0].count)).toBe(3);

      const reconciled = await reconcileStorage(app.db, { documentStorage, intakeStorage, projectId: project.id });
      expect(reconciled.counts.recovered).toBe(1);
      expect(reconciled.counts.pending).toBe(2);
      expect(reconciled.counts.pendingRecoverable).toBe(0);
      expect(reconciled.counts.missingReady).toBe(1);
      expect(reconciled.counts.integrityConflict).toBe(2);
      expect(reconciled.counts.unresolved).toBe(3);
      expect(reconciled.counts.orphanFinal).toBe(1);
      expect(reconciled.counts.unknownStaged).toBe(1);
      expect(storageOperationExitCode(reconciled)).toBe(1);
      expect(await documentStorage.exists(unknownFinalKey)).toBe(true);
      expect(await documentStorage.exists(unknownStage.temporaryKey)).toBe(true);
      const finalConflict = await documentStorage.inspect(String(pendingMismatch.storage_key));
      expect(finalConflict).toMatchObject({ byteSize: conflictingBytes.byteLength, sha256: createHash("sha256").update(conflictingBytes).digest("hex") });
      expect(await documentStorage.exists(String(pendingMismatch.staged_storage_key))).toBe(true);
      const stageConflict = await documentStorage.inspect(String(pendingStageMismatch.staged_storage_key));
      expect(stageConflict).toMatchObject({ byteSize: conflictingStageBytes.byteLength, sha256: createHash("sha256").update(conflictingStageBytes).digest("hex") });
      expect(await documentStorage.inspect(String(pendingStageMismatch.storage_key))).toBeNull();
      const [goodOwner] = await app.client`
        select id, storage_key, storage_state from full_text_documents
        where project_id=${project.id} and sha256=${createHash("sha256").update(goodBytes).digest("hex")}
      `;
      expect(goodOwner.storage_state).toBe("ready");
      expect(await documentStorage.inspect(String(goodOwner.storage_key))).toMatchObject({ byteSize: goodBytes.byteLength, sha256: createHash("sha256").update(goodBytes).digest("hex") });

      await documentStorage.remove(unknownStage.temporaryKey);
      await documentStorage.remove(unknownFinalKey);
    } finally {
      await app.client.end();
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("restages a committed PDF resolution from retained intake bytes and converges concurrent upload/reconcile workers", async () => {
    const databaseName = `slice41_storage_race_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const app = createDb(databaseUrl(databaseName));
    const root = await mkdtemp(path.join(os.tmpdir(), "litreview_slice41_storage_race_"));
    const documentStorage = new LocalDocumentStorage(root);
    const intakeStorage = new LocalPdfIntakeStorage(root);
    try {
      await migrate(app.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
      const base = createReviewServices(app.db, {
        documentStorage,
        pdfIntakeStorage: intakeStorage,
        pdfMetadataInspector: { inspect: async () => ({ status: "failed", pageCount: null, attemptedPageCount: 0, succeededPageCount: 0, scannedCodePoints: 0, diagnostics: ["test failed"], errorCode: "test", errorMessage: "test failure", extractorKey: "test", extractorVersion: "v1", pdfjsVersion: "pdfjs-test-v1", mappingVersion: "map-v1", textScanVersion: "scan-v1", doiAlgorithmVersion: "doi-v1", fields: [] }) },
      });
      const project = await base.createProject({ title: `Storage recovery ${randomUUID()}` });
      const retainedBytes = Buffer.from("%PDF-1.7\nretained PDF resolution source");
      const intake = await base.uploadPdfIntake(project.id, { originalFilename: "retained.pdf", mediaType: "application/pdf" }, Readable.from([retainedBytes]));
      if (!intake) throw new Error("PDF intake was not returned");
      const preview = await base.previewPdfIntakeResolution(project.id, intake.id, {
        kind: "create_paper",
        payload: { title: "Restaged Paper", authors: [], publicationYear: 2026, venue: null, doi: null, abstract: null, bibliographicNote: null },
        distinctPaperAcknowledged: false,
      });
      const stopped = createReviewServices(app.db, {
        documentStorage,
        pdfIntakeStorage: intakeStorage,
        pdfMetadataInspector: { inspect: async () => ({ status: "failed", pageCount: null, attemptedPageCount: 0, succeededPageCount: 0, scannedCodePoints: 0, diagnostics: ["test failed"], errorCode: "test", errorMessage: "test failure", extractorKey: "test", extractorVersion: "v1", pdfjsVersion: "pdfjs-test-v1", mappingVersion: "map-v1", textScanVersion: "scan-v1", doiAlgorithmVersion: "doi-v1", fields: [] }) },
        onStorageCheckpoint: async (phase, context) => {
          if (phase === "after_resolution_commit" && context.flow === "pdf_intake_resolution") throw new Error("stop after stored decision");
        },
      });
      await expect(stopped.resolvePdfIntake(project.id, intake.id, {
        kind: "create_paper", payload: preview.payload, previewFingerprint: preview.fingerprint,
        metadataResultId: preview.metadataResultId, distinctPaperAcknowledged: false,
      })).rejects.toThrow("stop after stored decision");
      const [pending] = await app.client`
        select id, staged_storage_key, storage_state from full_text_documents where project_id=${project.id}
      `;
      expect(pending.storage_state).toBe("pending");
      await documentStorage.remove(String(pending.staged_storage_key));
      const repaired = await reconcileStorage(app.db, { documentStorage, intakeStorage, projectId: project.id });
      expect(repaired.counts.recovered).toBe(1);
      const [ready] = await app.client`select storage_state, staged_storage_key from full_text_documents where id=${pending.id}`;
      expect(ready).toEqual({ storage_state: "ready", staged_storage_key: null });
      const [resolution] = await app.client`
        select id, paper_id, full_text_document_id from pdf_intake_resolutions where project_id=${project.id} and intake_id=${intake.id}
      `;
      expect(String(resolution.full_text_document_id)).toBe(String(pending.id));

      const paper = await base.addPaper(project.id, { title: "Concurrent identical upload" });
      const raceBytes = Buffer.from("%PDF-1.7\nconcurrent upload/reconciler bytes");
      const crashUpload = createReviewServices(app.db, {
        documentStorage,
        onStorageCheckpoint: async (phase, context) => {
          if (phase === "after_pending_commit" && context.flow === "full_text_document") throw new Error("stop concurrent fixture");
        },
      });
      await expect(crashUpload.uploadFullTextDocument(project.id, paper.id, { originalFilename: "race.pdf", mediaType: "application/pdf" }, Readable.from([raceBytes])))
        .rejects.toThrow("stop concurrent fixture");
      const restarted = createReviewServices(app.db, { documentStorage });
      const [first, second, racedReconcile] = await Promise.all([
        restarted.uploadFullTextDocument(project.id, paper.id, { originalFilename: "race.pdf", mediaType: "application/pdf" }, Readable.from([raceBytes])),
        restarted.uploadFullTextDocument(project.id, paper.id, { originalFilename: "race.pdf", mediaType: "application/pdf" }, Readable.from([raceBytes])),
        reconcileStorage(app.db, { documentStorage, intakeStorage, projectId: project.id }),
      ]);
      expect(first.document.id).toBe(second.document.id);
      expect(racedReconcile.counts.recovered).toBeGreaterThanOrEqual(0);
      const raceOwners = await app.client`
        select id, storage_key, storage_state, sha256 from full_text_documents
        where project_id=${project.id} and paper_id=${paper.id} and sha256=${createHash("sha256").update(raceBytes).digest("hex")}
      `;
      expect(raceOwners).toHaveLength(1);
      expect(raceOwners[0].storage_state).toBe("ready");
      expect(await documentStorage.inspect(String(raceOwners[0].storage_key))).toMatchObject({ byteSize: raceBytes.byteLength, sha256: raceOwners[0].sha256 });
    } finally {
      await app.client.end();
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
