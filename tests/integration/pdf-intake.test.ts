import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import type { PdfMetadataInspection } from "@/application/pdf-intake-services";
import { LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";
import { findPaperCandidates } from "@/application/paper-writer";
import { normalizePdfDoiCandidate } from "@/infrastructure/pdf-metadata-inspector";
import { auditStorageReadOnly } from "@/application/storage-operations";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const TEST_DB_NAME = `slice28_pdf_intake_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

const intakeStorageKey = (projectId: string, intakeId: string) => `projects/${projectId}/pdf-intakes/${intakeId}/source.pdf`;

function failedInspection(): PdfMetadataInspection {
  return {
    status: "failed",
    pageCount: null,
    attemptedPageCount: 0,
    succeededPageCount: 0,
    scannedCodePoints: 0,
    diagnostics: ["InvalidPDFException: malformed retained PDF"],
    errorCode: "InvalidPDFException",
    errorMessage: "malformed retained PDF",
    extractorKey: "test-pdf-inspector",
    extractorVersion: "test-v1",
    pdfjsVersion: "6.3.289",
    mappingVersion: "test-map-v1",
    textScanVersion: "test-text-v1",
    doiAlgorithmVersion: "test-doi-v1",
    fields: ["title", "authors", "publicationYear", "venue", "doi", "abstract"].map((field) => ({
      field: field as "title" | "authors" | "publicationYear" | "venue" | "doi" | "abstract",
      value: null,
      sourceKind: null,
      sourceLocator: null,
      classification: "unavailable" as const,
      diagnostic: "metadata_inspection_failed",
    })),
  };
}

describe("Slice 28 PDF-first intake", () => {
  let admin: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let services!: ReturnType<typeof createReviewServices>;
  let databaseHandle!: ReturnType<typeof createDb>["db"];
  let storageRoot = "";
  let ready = false;

  async function insertDurableIntake(projectId: string, filename: string, bytes: Buffer) {
    const intakeStorage = new LocalPdfIntakeStorage(storageRoot);
    const staged = await intakeStorage.stage(Readable.from([bytes]));
    const intakeId = randomUUID();
    const storageKey = intakeStorageKey(projectId, intakeId);
    await intakeStorage.install(staged.temporaryKey, storageKey);
    await intakeStorage.ensureDurable(storageKey);
    await appClient!`
      insert into pdf_intakes (id, project_id, original_filename, media_type, byte_size, sha256, storage_key, storage_state, staged_storage_key)
      values (${intakeId}, ${projectId}, ${filename}, 'application/pdf', ${staged.byteSize}, ${createHash("sha256").update(bytes).digest("hex")}, ${storageKey}, 'ready', null)
    `;
    await intakeStorage.remove(staged.temporaryKey);
    return intakeId;
  }

  beforeAll(async () => {
    try {
      admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      const created = createDb(TEST_DB_URL);
      appClient = created.client;
      databaseHandle = created.db;
      storageRoot = await mkdtemp(path.join(os.tmpdir(), "litreview_slice28_pdf_intake_"));
      services = createReviewServices(created.db, {
        documentStorage: new LocalDocumentStorage(storageRoot),
        pdfIntakeStorage: new LocalPdfIntakeStorage(storageRoot),
        pdfMetadataInspector: { inspect: async () => failedInspection() },
      });
      await migrate(created.db, { migrationsFolder: "./drizzle" });
      ready = true;
    } catch {
      ready = false;
    }
  }, 120_000);

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
      await admin.end();
    }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 120_000);

  it("retains a signature-bearing malformed PDF, records terminal metadata failure, and matches without Paper mutation", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF failed ${crypto.randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Existing canonical Paper", authors: ["Researcher"] });
    const bytes = Buffer.from("%PDF-1.7\nmalformed but signature-bearing");
    const document = await services.uploadFullTextDocument(project.id, paper.id, { originalFilename: "existing.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
    const intake = await services.uploadPdfIntake(project.id, { originalFilename: "malformed.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
    if (!intake) throw new Error("PDF intake was not returned");
    expect(intake.state).toBe("metadata_failed");
    expect(intake.metadataResult?.status).toBe("failed");
    expect(intake.metadataResult?.errorCode).toBe("InvalidPDFException");
    expect((await services.listPapers(project.id)).map((item) => item.id)).toEqual([paper.id]);

    const preview = await services.previewPdfIntakeResolution(project.id, intake.id, { kind: "match_paper", paperId: paper.id });
    const resolution = await services.resolvePdfIntake(project.id, intake.id, { kind: "match_paper", paperId: paper.id, previewFingerprint: preview.fingerprint, metadataResultId: preview.metadataResultId });
    expect(resolution.materializationKind).toBe("reused_document");
    expect(resolution.fullTextDocumentId).toBe(document.document.id);
    expect((await services.listPapers(project.id)).map((item) => item.id)).toEqual([paper.id]);
    const duplicate = await services.uploadPdfIntake(project.id, { originalFilename: "same-bytes-again.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
    if (!duplicate) throw new Error("Duplicate PDF intake was not returned");
    expect(duplicate.id).toBe(intake.id);
    expect((await services.listPdfIntakes(project.id)).length).toBe(1);
    expect(await services.auditPdfIntakeStorage(project.id)).toEqual({ missingFiles: [], orphanFiles: [], stagedFiles: [] });
    expect((await services.auditFullTextDocumentStorage(project.id)).orphanFiles).toEqual([]);
  });

  it.each([
    "after_staging",
    "after_pending_commit",
    "after_final_installation",
    "after_final_verification",
    "after_ready_transition",
  ] as const)("recovers direct PDF intake upload after the %s crash boundary", async (phase) => {
    if (!ready) return;
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "litreview_slice28_intake_crash_"));
    const documentStorage = new LocalDocumentStorage(isolatedRoot);
    const intakeStorage = new LocalPdfIntakeStorage(isolatedRoot);
    const options = {
      documentStorage,
      pdfIntakeStorage: intakeStorage,
      pdfMetadataInspector: { inspect: async () => failedInspection() },
    };
    const fixtureServices = createReviewServices(databaseHandle, options);
    const project = await fixtureServices.createProject({ title: `PDF intake crash ${phase} ${randomUUID()}` });
    const bytes = Buffer.from(`%PDF-1.7\ndirect intake crash ${phase}`);
    const keysBefore = new Set(await intakeStorage.listKeys());
    let crashed = false;
    let orphanStageKey: string | undefined;
    const crashingServices = createReviewServices(databaseHandle, {
      ...options,
      onStorageCheckpoint: async (observedPhase, context) => {
        if (!crashed && observedPhase === phase && context.flow === "pdf_intake") {
          crashed = true;
          if (phase === "after_staging") orphanStageKey = context.storageKey;
          throw new Error(`simulated intake crash: ${phase}`);
        }
      },
    });

    await expect(crashingServices.uploadPdfIntake(
      project.id,
      { originalFilename: `${phase}.pdf`, mediaType: "application/pdf" },
      Readable.from([bytes]),
    )).rejects.toThrow(`simulated intake crash: ${phase}`);
    expect(crashed).toBe(true);

    let intakeId: string;
    if (phase === "after_staging") {
      expect(orphanStageKey).toMatch(/^\.pdf-intake\/\.tmp\//);
      const before = await auditStorageReadOnly(databaseHandle, { documentStorage, intakeStorage, projectId: project.id });
      expect(before.counts.unknownStaged).toBe(1);
      expect(before.counts.pending).toBe(0);
      await expect(intakeStorage.exists(orphanStageKey!)).resolves.toBe(true);
      const restarted = createReviewServices(databaseHandle, options);
      const reuploaded = await restarted.uploadPdfIntake(project.id, { originalFilename: "retry.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
      if (!reuploaded) throw new Error("PDF intake retry was not returned");
      intakeId = reuploaded.id;
      const rows = await appClient!`select id, storage_state from pdf_intakes where project_id=${project.id}`;
      expect(rows).toHaveLength(1);
      expect(String(rows[0].id)).toBe(intakeId);
      expect(rows[0].storage_state).toBe("ready");
      await intakeStorage.remove(orphanStageKey!);
    } else {
      const [owner] = await appClient!`
        select id, storage_state, staged_storage_key, storage_key
        from pdf_intakes where project_id=${project.id}
      `;
      intakeId = String(owner.id);
      expect(owner.storage_state).toBe(phase === "after_ready_transition" ? "ready" : "pending");
      if (phase === "after_ready_transition") {
        orphanStageKey = (await intakeStorage.listKeys()).find((key) => key.startsWith(".pdf-intake/.tmp/") && !keysBefore.has(key));
      }
      const before = await auditStorageReadOnly(databaseHandle, { documentStorage, intakeStorage, projectId: project.id });
      if (owner.storage_state === "pending") expect(before.counts.pending).toBe(1);
      if (phase === "after_ready_transition") expect(before.counts.unknownStaged).toBe(1);

      const restarted = createReviewServices(databaseHandle, options);
      const recovered = await restarted.uploadPdfIntake(project.id, { originalFilename: `${phase}.pdf`, mediaType: "application/pdf" }, Readable.from([bytes]));
      if (!recovered) throw new Error("PDF intake recovery was not returned");
      expect(recovered.id).toBe(intakeId);
      const [readyRow] = await appClient!`select storage_state, staged_storage_key from pdf_intakes where id=${intakeId}`;
      expect(readyRow).toEqual({ storage_state: "ready", staged_storage_key: null });
      if (phase === "after_ready_transition") {
        expect(orphanStageKey).toBeTruthy();
        expect(await intakeStorage.exists(orphanStageKey!)).toBe(true);
        expect((await auditStorageReadOnly(databaseHandle, { documentStorage, intakeStorage, projectId: project.id })).counts.unknownStaged).toBe(1);
        await intakeStorage.remove(orphanStageKey!);
      } else {
        expect((await auditStorageReadOnly(databaseHandle, { documentStorage, intakeStorage, projectId: project.id })).counts.unknownStaged).toBe(0);
      }
    }
    await rm(isolatedRoot, { recursive: true, force: true });
  }, 30_000);

  it.each([
    "after_staging",
    "after_resolution_commit",
    "after_final_installation",
    "after_final_verification",
    "after_ready_transition",
  ] as const)("recovers the exact %s PDF resolution for create-Paper and match-Paper decisions", async (phase) => {
    if (!ready) return;
    const resolutionRoot = await mkdtemp(path.join(os.tmpdir(), "litreview_slice28_resolution_crash_"));
    const documentStorage = new LocalDocumentStorage(resolutionRoot);
    const intakeStorage = new LocalPdfIntakeStorage(resolutionRoot);
    const isolatedServices = createReviewServices(databaseHandle, {
      documentStorage,
      pdfIntakeStorage: intakeStorage,
      pdfMetadataInspector: { inspect: async () => failedInspection() },
    });
    const priorKeys = new Set(await documentStorage.listKeys());

    for (const resolutionKind of ["create_paper", "match_paper"] as const) {
      const project = await isolatedServices.createProject({ title: `PDF resolution ${phase} ${resolutionKind} ${randomUUID()}` });
      const targetPaper = resolutionKind === "match_paper"
        ? await isolatedServices.addPaper(project.id, { title: "Preselected match Paper" })
        : null;
      const bytes = Buffer.from(`%PDF-1.7\n${phase} ${resolutionKind} resolution bytes`);
      const intake = await isolatedServices.uploadPdfIntake(project.id, { originalFilename: "resolution.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
      if (!intake) throw new Error("PDF intake was not returned");
      const preview = await isolatedServices.previewPdfIntakeResolution(project.id, intake.id, resolutionKind === "create_paper"
        ? {
            kind: "create_paper",
            payload: { title: "Resolved from retained PDF", authors: ["Ada Lovelace"], publicationYear: 1843, venue: null, doi: null, abstract: null, bibliographicNote: null },
            distinctPaperAcknowledged: false,
          }
        : { kind: "match_paper", paperId: targetPaper!.id });
      const request = resolutionKind === "create_paper"
        ? {
            kind: "create_paper" as const,
            payload: preview.payload,
            distinctPaperAcknowledged: false,
            previewFingerprint: preview.fingerprint,
            metadataResultId: preview.metadataResultId,
          }
        : {
            kind: "match_paper" as const,
            paperId: targetPaper!.id,
            previewFingerprint: preview.fingerprint,
            metadataResultId: preview.metadataResultId,
          };

      let crashed = false;
      let orphanStageKey: string | undefined;
      const crashingServices = createReviewServices(databaseHandle, {
        documentStorage,
        pdfIntakeStorage: intakeStorage,
        pdfMetadataInspector: { inspect: async () => failedInspection() },
        onStorageCheckpoint: async (observedPhase, context) => {
          if (!crashed && observedPhase === phase && context.flow === "pdf_intake_resolution") {
            crashed = true;
            if (phase === "after_staging") orphanStageKey = context.storageKey;
            throw new Error(`simulated resolution crash: ${phase}`);
          }
        },
      });

      await expect(crashingServices.resolvePdfIntake(project.id, intake.id, request))
        .rejects.toThrow(`simulated resolution crash: ${phase}`);
      expect(crashed).toBe(true);

      const committedRows = await appClient!`
        select id, paper_id, full_text_document_id, materialization_kind
        from pdf_intake_resolutions where project_id=${project.id} and intake_id=${intake.id}
      `;
      if (phase === "after_staging") {
        expect(committedRows).toHaveLength(0);
        expect(orphanStageKey).toMatch(/^\.tmp\//);
      } else {
        expect(committedRows).toHaveLength(1);
        expect(committedRows[0].materialization_kind).toBe("created_document");
      }

      if (phase === "after_resolution_commit" && resolutionKind === "create_paper") {
        // Change candidate context after commit. A retry must finish the
        // stored exact Paper/document decision without recalculating it.
        const changedCandidate = await isolatedServices.addPaper(project.id, { title: "New candidate after commit", publicationYear: 1843 });
        await appClient!`update papers set title='Resolved from retained PDF' where project_id=${project.id} and id=${changedCandidate.id}`;
      }

      const restarted = createReviewServices(databaseHandle, {
        documentStorage,
        pdfIntakeStorage: intakeStorage,
        pdfMetadataInspector: { inspect: async () => failedInspection() },
      });
      const recovered = await restarted.resolvePdfIntake(project.id, intake.id, request);
      expect(recovered.materializationKind).toBe("created_document");
      if (committedRows[0]) {
        expect(recovered.id).toBe(String(committedRows[0].id));
        expect(recovered.paperId).toBe(String(committedRows[0].paper_id));
        expect(recovered.fullTextDocumentId).toBe(String(committedRows[0].full_text_document_id));
      }
      const resolutions = await appClient!`
        select id, paper_id, full_text_document_id
        from pdf_intake_resolutions where project_id=${project.id} and intake_id=${intake.id}
      `;
      expect(resolutions).toHaveLength(1);
      expect(recovered.id).toBe(String(resolutions[0].id));
      expect(recovered.paperId).toBe(String(resolutions[0].paper_id));
      expect(recovered.fullTextDocumentId).toBe(String(resolutions[0].full_text_document_id));
      expect((await restarted.listPapers(project.id)).length).toBe(resolutionKind === "match_paper" ? 1 : phase === "after_resolution_commit" ? 2 : 1);
      expect((await restarted.listFullTextDocuments(project.id, recovered.paperId)).map((document) => document.id)).toEqual([recovered.fullTextDocumentId]);

      if (phase === "after_staging") {
        expect(await documentStorage.exists(orphanStageKey!)).toBe(true);
        expect((await isolatedServices.auditFullTextDocumentStorage(project.id)).stagedFiles).toContain(orphanStageKey);
        await documentStorage.remove(orphanStageKey!);
      } else if (phase === "after_ready_transition") {
        const stageKey = (await documentStorage.listKeys()).find((key) => key.startsWith(".tmp/") && !priorKeys.has(key));
        expect(stageKey).toBeTruthy();
        expect(await documentStorage.exists(stageKey!)).toBe(true);
        expect((await isolatedServices.auditFullTextDocumentStorage(project.id)).stagedFiles).toContain(stageKey);
        await documentStorage.remove(stageKey!);
      } else {
        expect(await isolatedServices.auditFullTextDocumentStorage(project.id)).toEqual({ missingFiles: [], orphanFiles: [], stagedFiles: [] });
      }
    }
    await rm(resolutionRoot, { recursive: true, force: true });
  }, 60_000);

  it("preserves and completes a committed resolution when PostgreSQL loses the commit response", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF uncertain commit ${randomUUID()}` });
    const bytes = Buffer.from("%PDF-1.7\nuncertain resolution commit");
    const intake = await services.uploadPdfIntake(project.id, { originalFilename: "uncertain.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
    if (!intake) throw new Error("PDF intake was not returned");
    const preview = await services.previewPdfIntakeResolution(project.id, intake.id, {
      kind: "create_paper",
      payload: { title: "Uncertain commit Paper", authors: ["Grace Hopper"], publicationYear: 1952, venue: null, doi: null, abstract: null, bibliographicNote: null },
      distinctPaperAcknowledged: false,
    });
    const mutableDb = databaseHandle as unknown as { transaction: (callback: unknown, config?: unknown) => Promise<unknown> };
    const originalTransaction = mutableDb.transaction.bind(databaseHandle);
    let dropCommitResponse = true;
    mutableDb.transaction = async (callback, config) => {
      const committed = await originalTransaction(callback, config);
      if (dropCommitResponse && (config as { isolationLevel?: string } | undefined)?.isolationLevel === "serializable") {
        dropCommitResponse = false;
        throw new Error("simulated lost serializable commit response");
      }
      return committed;
    };
    let resolved;
    try {
      resolved = await services.resolvePdfIntake(project.id, intake.id, {
        kind: "create_paper",
        payload: preview.payload,
        previewFingerprint: preview.fingerprint,
        metadataResultId: preview.metadataResultId,
        distinctPaperAcknowledged: false,
      });
    } finally {
      mutableDb.transaction = originalTransaction;
    }
    expect(dropCommitResponse).toBe(false);
    expect(resolved.materializationKind).toBe("created_document");
    const [stored] = await appClient!`
      select id, paper_id, full_text_document_id, materialization_kind
      from pdf_intake_resolutions where project_id=${project.id} and intake_id=${intake.id}
    `;
    expect(resolved.id).toBe(String(stored.id));
    expect(resolved.paperId).toBe(String(stored.paper_id));
    expect(resolved.fullTextDocumentId).toBe(String(stored.full_text_document_id));
    expect((await services.listPapers(project.id)).map((paper) => paper.id)).toEqual([resolved.paperId]);
    expect(await services.auditFullTextDocumentStorage(project.id)).toEqual({ missingFiles: [], orphanFiles: [], stagedFiles: [] });
  }, 30_000);

  it("recovers a durable intake with no metadata result and persists an oversized parser error within the diagnostic bound", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF recovery ${randomUUID()}` });
    const bytes = Buffer.from("%PDF-1.7\nrecovery fixture");
    const intakeId = await insertDurableIntake(project.id, "recovery.pdf", bytes);
    const before = await services.getPdfIntake(project.id, intakeId);
    expect(before?.metadataResult).toBeNull();
    const first = await services.ensureInitialPdfMetadataResult(project.id, intakeId);
    expect(first.sequenceNo).toBe(1);
    expect(first.status).toBe("failed");
    const after = await services.getPdfIntake(project.id, intakeId);
    expect(after?.metadataResult?.id).toBe(first.id);

    const longServices = createReviewServices(databaseHandle, {
      documentStorage: new LocalDocumentStorage(storageRoot),
      pdfIntakeStorage: new LocalPdfIntakeStorage(storageRoot),
      pdfMetadataInspector: {
        inspect: async () => ({ ...failedInspection(), errorMessage: "x".repeat(20_000), diagnostics: ["x".repeat(20_000)] }),
      },
    });
    const longIntakeId = await insertDurableIntake(project.id, "long-error.pdf", Buffer.concat([bytes, Buffer.from(" long")]));
    const longResult = await longServices.ensureInitialPdfMetadataResult(project.id, longIntakeId);
    expect(longResult.errorMessage?.length).toBeLessThanOrEqual(2_000);
    const [stored] = await appClient!`select error_message, diagnostics from pdf_intake_metadata_results where id=${longResult.id}`;
    expect(String(stored.error_message).length).toBeLessThanOrEqual(2_000);
    const persistedDiagnostics = Array.isArray(stored.diagnostics) ? stored.diagnostics.map(String) : [];
    expect(persistedDiagnostics.length).toBeGreaterThan(0);
    expect(persistedDiagnostics.every((diagnostic) => diagnostic.length <= 2_000)).toBe(true);
  });

  it("audits missing, orphan, and temporary files by storage namespace", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF storage audit ${randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Storage audit Paper", authors: ["Researcher"] });
    const bytes = Buffer.from("%PDF-1.7\nstorage audit");
    await services.uploadFullTextDocument(project.id, paper.id, { originalFilename: "audit.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
    const intake = await services.uploadPdfIntake(project.id, { originalFilename: "audit-intake.pdf", mediaType: "application/pdf" }, Readable.from([bytes, Buffer.from(" intake")]))
    if (!intake) throw new Error("PDF intake was not returned");
    const [storedDocument] = await appClient!`select id, storage_key from full_text_documents where project_id=${project.id} and paper_id=${paper.id} order by created_at desc limit 1`;

    await rm(path.join(storageRoot, String(storedDocument.storage_key)), { force: true });
    await rm(path.join(storageRoot, intake.storageKey), { force: true });

    const orphanDocumentKey = `projects/${project.id}/papers/${paper.id}/documents/${randomUUID()}/source.pdf`;
    const orphanIntakeKey = `projects/${project.id}/pdf-intakes/${randomUUID()}/source.pdf`;
    await mkdir(path.join(storageRoot, path.dirname(orphanDocumentKey)), { recursive: true });
    await mkdir(path.join(storageRoot, path.dirname(orphanIntakeKey)), { recursive: true });
    await writeFile(path.join(storageRoot, orphanDocumentKey), bytes);
    await writeFile(path.join(storageRoot, orphanIntakeKey), bytes);
    await mkdir(path.join(storageRoot, ".tmp"), { recursive: true });
    await mkdir(path.join(storageRoot, ".pdf-intake", ".tmp"), { recursive: true });
    await writeFile(path.join(storageRoot, ".tmp", "canonical.upload"), bytes);
    await writeFile(path.join(storageRoot, ".pdf-intake", ".tmp", "intake.upload"), bytes);

    const intakeAudit = await services.auditPdfIntakeStorage(project.id);
    expect(intakeAudit.missingFiles).toContain(intake.id);
    expect(intakeAudit.orphanFiles).toContain(orphanIntakeKey);
    expect(intakeAudit.stagedFiles).toEqual([".pdf-intake/.tmp/intake.upload"]);

    const documentAudit = await services.auditFullTextDocumentStorage(project.id);
    expect(documentAudit.missingFiles).toContain(String(storedDocument.id));
    expect(documentAudit.orphanFiles).toContain(orphanDocumentKey);
    expect(documentAudit.orphanFiles).not.toContain(orphanIntakeKey);
    expect(documentAudit.stagedFiles).toEqual([".tmp/canonical.upload"]);

    await rm(path.join(storageRoot, "projects", project.id), { recursive: true, force: true });
    await rm(path.join(storageRoot, ".tmp", "canonical.upload"), { force: true });
    await rm(path.join(storageRoot, ".pdf-intake", ".tmp", "intake.upload"), { force: true });
  });

  it("allows concurrent initial inspection calls to create exactly one authoritative sequence-1 result", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF concurrent inspection ${randomUUID()}` });
    const intakeId = await insertDurableIntake(project.id, "concurrent.pdf", Buffer.from("%PDF-1.7\nconcurrent"));
    const results = await Promise.all([
      services.ensureInitialPdfMetadataResult(project.id, intakeId),
      services.ensureInitialPdfMetadataResult(project.id, intakeId),
    ]);
    expect(results[0].id).toBe(results[1].id);
    const rows = await appClient!`select sequence_no from pdf_intake_metadata_results where intake_id=${intakeId}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].sequence_no)).toBe(1);
  });

  it("keeps direct intake history immutable", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF immutable ${randomUUID()}` });
    const intake = await services.uploadPdfIntake(project.id, { originalFilename: "immutable.pdf", mediaType: "application/pdf" }, Readable.from([Buffer.from("%PDF-1.7\nimmutable")]));
    if (!intake?.metadataResult) throw new Error("metadata result missing");
    const paper = await services.addPaper(project.id, { title: "Immutable target", authors: ["Researcher"] });
    const preview = await services.previewPdfIntakeResolution(project.id, intake.id, { kind: "match_paper", paperId: paper.id });
    await services.resolvePdfIntake(project.id, intake.id, { kind: "match_paper", paperId: paper.id, previewFingerprint: preview.fingerprint, metadataResultId: preview.metadataResultId });
    const [field] = await appClient!`select id from pdf_intake_metadata_fields where result_id=${intake.metadataResult.id} limit 1`;
    const [resolution] = await appClient!`select id from pdf_intake_resolutions where intake_id=${intake.id}`;
    const attempts: Promise<unknown>[] = [
      appClient!`update pdf_intakes set original_filename='changed.pdf' where id=${intake.id}`,
      appClient!`delete from pdf_intakes where id=${intake.id}`,
      appClient!`update pdf_intake_metadata_results set error_message='changed' where id=${intake.metadataResult.id}`,
      appClient!`delete from pdf_intake_metadata_results where id=${intake.metadataResult.id}`,
      appClient!`update pdf_intake_metadata_fields set diagnostic='changed' where id=${field.id}`,
      appClient!`delete from pdf_intake_metadata_fields where id=${field.id}`,
      appClient!`update pdf_intake_resolutions set resolution_kind='match_paper' where id=${resolution.id}`,
      appClient!`delete from pdf_intake_resolutions where id=${resolution.id}`,
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toBeDefined();
  });

  it("uses the same DOI identity for PDF proposals and Paper candidate matching", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF DOI parity ${randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "DOI parity Paper", authors: ["Researcher"], doi: "https://doi.org/10.1000/ABC" });
    const proposed = normalizePdfDoiCandidate("doi:10.1000/ABC.");
    expect(proposed).toBe("10.1000/abc");
    const candidates = await findPaperCandidates(databaseHandle, project.id, { title: "Unrelated title", doi: proposed, publicationYear: null });
    expect(candidates.map((candidate) => String(candidate.id))).toContain(paper.id);
  });

  it("deduplicates concurrent identical uploads by project and SHA-256", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF upload race ${randomUUID()}` });
    const bytes = Buffer.from("%PDF-1.7\nconcurrent identical upload");
    const results = await Promise.all([
      services.uploadPdfIntake(project.id, { originalFilename: "first.pdf", mediaType: "application/pdf" }, Readable.from([bytes])),
      services.uploadPdfIntake(project.id, { originalFilename: "second.pdf", mediaType: "application/pdf" }, Readable.from([bytes])),
    ]);
    if (!results[0] || !results[1]) throw new Error("Concurrent PDF intake upload returned no detail");
    expect(results[0].id).toBe(results[1].id);
    expect(["first.pdf", "second.pdf"]).toContain(results[0].originalFilename);
    expect(results[1].originalFilename).toBe(results[0].originalFilename);
    expect((await services.listPdfIntakes(project.id))).toHaveLength(1);
  });

  it("serializes create/create, create/match, and match/match resolution races", async () => {
    if (!ready) return;
    const race = async (suffix: string, left: { kind: "create_paper" | "match_paper"; paperId?: string; payload?: { title: string; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null; abstract: string | null; bibliographicNote: string | null } }, right: { kind: "create_paper" | "match_paper"; paperId?: string; payload?: { title: string; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null; abstract: string | null; bibliographicNote: string | null } }) => {
      const project = await services.createProject({ title: `PDF resolution race ${suffix} ${randomUUID()}` });
      const intake = await services.uploadPdfIntake(project.id, { originalFilename: `${suffix}.pdf`, mediaType: "application/pdf" }, Readable.from([Buffer.from(`%PDF-1.7\n${suffix}`)]));
      if (!intake) throw new Error("PDF intake was not returned");
      const leftPreview = await services.previewPdfIntakeResolution(project.id, intake.id, left);
      const rightPreview = await services.previewPdfIntakeResolution(project.id, intake.id, right);
      const toInput = (request: typeof left, preview: typeof leftPreview) => ({ ...request, previewFingerprint: preview.fingerprint, metadataResultId: preview.metadataResultId, distinctPaperAcknowledged: request.kind === "create_paper" ? true : undefined });
      const settled = await Promise.allSettled([
        services.resolvePdfIntake(project.id, intake.id, toInput(left, leftPreview)),
        services.resolvePdfIntake(project.id, intake.id, toInput(right, rightPreview)),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const [resolutionCount] = await appClient!`select count(*)::integer as count from pdf_intake_resolutions where project_id=${project.id}`;
      expect(resolutionCount.count).toBe(1);
      return { project, settled };
    };

    const createPayload = (title: string) => ({ title, authors: ["Researcher"], publicationYear: 2024, venue: null, doi: null, abstract: null, bibliographicNote: null });
    await race("create-create", { kind: "create_paper", payload: createPayload("Race create") }, { kind: "create_paper", payload: createPayload("Race create") });

    const createMatchProject = await services.createProject({ title: `PDF create match ${randomUUID()}` });
    const matchPaper = await services.addPaper(createMatchProject.id, { title: "Existing match target", authors: ["Researcher"] });
    const createMatchIntake = await services.uploadPdfIntake(createMatchProject.id, { originalFilename: "create-match.pdf", mediaType: "application/pdf" }, Readable.from([Buffer.from("%PDF-1.7\ncreate-match")]))
    if (!createMatchIntake) throw new Error("PDF intake was not returned");
    const createMatchCreate = { kind: "create_paper" as const, payload: createPayload("Race distinct") };
    const createMatchMatch = { kind: "match_paper" as const, paperId: matchPaper.id };
    const createMatchCreatePreview = await services.previewPdfIntakeResolution(createMatchProject.id, createMatchIntake.id, createMatchCreate);
    const createMatchMatchPreview = await services.previewPdfIntakeResolution(createMatchProject.id, createMatchIntake.id, createMatchMatch);
    const createMatchSettled = await Promise.allSettled([
      services.resolvePdfIntake(createMatchProject.id, createMatchIntake.id, { ...createMatchCreate, previewFingerprint: createMatchCreatePreview.fingerprint, metadataResultId: createMatchCreatePreview.metadataResultId, distinctPaperAcknowledged: true }),
      services.resolvePdfIntake(createMatchProject.id, createMatchIntake.id, { ...createMatchMatch, previewFingerprint: createMatchMatchPreview.fingerprint, metadataResultId: createMatchMatchPreview.metadataResultId }),
    ]);
    expect(createMatchSettled.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const [createMatchCount] = await appClient!`select count(*)::integer as count from pdf_intake_resolutions where project_id=${createMatchProject.id}`;
    expect(createMatchCount.count).toBe(1);

    const matchMatchProject = await services.createProject({ title: `PDF match match ${randomUUID()}` });
    const paperA = await services.addPaper(matchMatchProject.id, { title: "Match A", authors: ["A"] });
    const paperB = await services.addPaper(matchMatchProject.id, { title: "Match B", authors: ["B"] });
    const matchMatchIntake = await services.uploadPdfIntake(matchMatchProject.id, { originalFilename: "match-match.pdf", mediaType: "application/pdf" }, Readable.from([Buffer.from("%PDF-1.7\nmatch-match")]))
    if (!matchMatchIntake) throw new Error("PDF intake was not returned");
    const previewA = await services.previewPdfIntakeResolution(matchMatchProject.id, matchMatchIntake.id, { kind: "match_paper", paperId: paperA.id });
    const previewB = await services.previewPdfIntakeResolution(matchMatchProject.id, matchMatchIntake.id, { kind: "match_paper", paperId: paperB.id });
    const matchSettled = await Promise.allSettled([
      services.resolvePdfIntake(matchMatchProject.id, matchMatchIntake.id, { kind: "match_paper", paperId: paperA.id, previewFingerprint: previewA.fingerprint, metadataResultId: previewA.metadataResultId }),
      services.resolvePdfIntake(matchMatchProject.id, matchMatchIntake.id, { kind: "match_paper", paperId: paperB.id, previewFingerprint: previewB.fingerprint, metadataResultId: previewB.metadataResultId }),
    ]);
    expect(matchSettled.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const [matchCount] = await appClient!`select count(*)::integer as count from pdf_intake_resolutions where project_id=${matchMatchProject.id}`;
    expect(matchCount.count).toBe(1);
  });

  it("does not reuse a same-hash document owned by another Paper", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `PDF cross-paper hash ${randomUUID()}` });
    const sourcePaper = await services.addPaper(project.id, { title: "Source Paper", authors: ["Source"] });
    const targetPaper = await services.addPaper(project.id, { title: "Target Paper", authors: ["Target"] });
    const bytes = Buffer.from("%PDF-1.7\ncross-paper hash");
    const existing = await services.uploadFullTextDocument(project.id, sourcePaper.id, { originalFilename: "source.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
    const intake = await services.uploadPdfIntake(project.id, { originalFilename: "intake.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
    if (!intake) throw new Error("PDF intake was not returned");
    expect(intake.exactDocumentMatches?.length ?? 0).toBeGreaterThan(0);
    const preview = await services.previewPdfIntakeResolution(project.id, intake.id, { kind: "match_paper", paperId: targetPaper.id });
    const resolution = await services.resolvePdfIntake(project.id, intake.id, { kind: "match_paper", paperId: targetPaper.id, previewFingerprint: preview.fingerprint, metadataResultId: preview.metadataResultId });
    expect(resolution.materializationKind).toBe("created_document");
    expect(resolution.fullTextDocumentId).not.toBe(existing.document.id);
  });
});
