import "dotenv/config";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { LocalDocumentStorage } from "@/infrastructure/document-storage";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const TEST_DB_NAME = `slice14_full_text_documents_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

describe("Slice 14 full-text document identity and provenance", () => {
  let admin: postgres.Sql | undefined;
  let client: postgres.Sql | undefined;
  let appClient: postgres.Sql | undefined;
  let services!: ReturnType<typeof createReviewServices>;
  let storageRoot = "";
  let ready = false;

  beforeAll(async () => {
    try {
      admin = postgres(BASE_URL, { max: 1 });
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      client = postgres(TEST_DB_URL, { max: 1 });
      const created = createDb(TEST_DB_URL);
      appClient = created.client;
      storageRoot = await mkdtemp(path.join(os.tmpdir(), "litreview_slice14_documents_"));
      services = createReviewServices(created.db, { documentStorage: new LocalDocumentStorage(storageRoot) });
      await migrate(created.db, { migrationsFolder: "./drizzle" });
      ready = true;
    } catch {
      ready = false;
    }
  }, 120_000);

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
      await admin.end();
    }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 120_000);

  it("rejects active duplicates, permits a new identity after archival, and preserves exact Evidence provenance", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `Document project ${crypto.randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Document identity study" });
    const bytes = Buffer.from("%PDF-1.7\nidentical immutable bytes\n");
    const metadata = { originalFilename: "study.pdf", mediaType: "application/pdf" as const, note: "source file" };

    const first = await services.uploadFullTextDocument(project.id, paper.id, metadata, Readable.from([bytes]));
    expect(first.kind).toBe("created");
    const duplicate = await services.uploadFullTextDocument(project.id, paper.id, metadata, Readable.from([bytes]));
    expect(duplicate.kind).toBe("duplicate");
    expect(duplicate.document.id).toBe(first.document.id);

    const oldEvidence = await services.recordEvidence(project.id, {
      paperId: paper.id,
      fullTextDocumentId: first.document.id,
      sourceText: "Historical passage",
      pageNumber: 2,
      note: null,
    });
    await services.setPreferredFullTextDocument(project.id, paper.id, first.document.id);
    await expect(services.archiveFullTextDocument(project.id, first.document.id)).rejects.toMatchObject({ code: "DOCUMENT_ARCHIVED" });
    await services.clearPreferredFullTextDocument(project.id, paper.id);
    await services.archiveFullTextDocument(project.id, first.document.id);
    const second = await services.uploadFullTextDocument(project.id, paper.id, metadata, Readable.from([bytes]));
    expect(second.kind).toBe("created");
    expect(second.document.id).not.toBe(first.document.id);
    expect(second.document.sha256).toBe(first.document.sha256);
    expect((await services.listEvidence(project.id)).find((item) => item.id === oldEvidence.id)?.fullTextDocumentId).toBe(first.document.id);
    await expect(services.recordEvidence(project.id, {
      paperId: paper.id,
      fullTextDocumentId: first.document.id,
      sourceText: "New passage against archived artifact",
      pageNumber: 3,
      note: null,
    })).rejects.toMatchObject({ code: "DOCUMENT_ARCHIVED" });
    const newEvidence = await services.recordEvidence(project.id, {
      paperId: paper.id,
      fullTextDocumentId: second.document.id,
      sourceText: "New passage",
      pageNumber: 3,
      note: null,
    });
    expect(newEvidence.fullTextDocumentId).toBe(second.document.id);
    const claim = await services.createClaim(project.id, { claimText: "The reattached artifact grounds this claim" });
    const revisedClaim = await services.createClaimRevision(project.id, claim.id, {
      claimText: claim.claimText,
      supports: [{ kind: "evidence", evidenceId: newEvidence.id }],
      expectedCurrentRevisionId: claim.revision.id,
    });
    expect(revisedClaim.revision.supports.evidence[0].evidence.evidence.document).toMatchObject({ id: second.document.id, originalFilename: metadata.originalFilename, sha256: second.document.sha256 });
    expect((await services.listEvidenceForFullTextDocument(project.id, first.document.id)).map((item) => item.id)).toEqual([oldEvidence.id]);
    expect((await services.listEvidenceForFullTextDocument(project.id, second.document.id)).map((item) => item.id)).toEqual([newEvidence.id]);
    expect(await services.auditFullTextDocumentStorage(project.id)).toEqual({ missingFiles: [], orphanFiles: [], stagedFiles: [] });
  });

  it("compensates a staged artifact when metadata validation fails before attachment", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `Invalid upload project ${crypto.randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Invalid upload study" });
    const staged = await services.stageFullTextDocument(Readable.from([Buffer.from("%PDF-1.7\ninvalid filename test")]));
    await expect(services.attachStagedFullTextDocument(project.id, paper.id, {
      originalFilename: "nested/filename.pdf",
      mediaType: "application/pdf",
      note: null,
    }, staged)).rejects.toBeTruthy();
    expect(await services.listFullTextDocuments(project.id, paper.id)).toEqual([]);
    expect(await services.auditFullTextDocumentStorage(project.id)).toEqual({ missingFiles: [], orphanFiles: [], stagedFiles: [] });
  });
});
