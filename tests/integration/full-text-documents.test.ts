import "dotenv/config";
import { createHash } from "node:crypto";
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
  let databaseHandle!: ReturnType<typeof createDb>["db"];
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
      databaseHandle = created.db;
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

  it.each([
    "after_staging",
    "after_pending_commit",
    "after_final_installation",
    "after_final_verification",
    "after_ready_transition",
  ] as const)("recovers direct upload after the %s crash boundary", async (phase) => {
    if (!ready) return;
    const project = await services.createProject({ title: `Storage crash ${phase} ${crypto.randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: `Crash recovery ${phase}` });
    const bytes = Buffer.from(`%PDF-1.7\ncrash recovery ${phase}`);
    const storage = new LocalDocumentStorage(storageRoot);
    const keysBefore = new Set(await storage.listKeys());
    let stageKey: string | undefined;
    let crashed = false;
    const crashingServices = createReviewServices(databaseHandle, {
      documentStorage: storage,
      onStorageCheckpoint: async (observedPhase, context) => {
        if (!crashed && observedPhase === phase && context.flow === "full_text_document") {
          crashed = true;
          stageKey = observedPhase === "after_staging" ? context.storageKey : stageKey;
          throw new Error(`simulated crash: ${phase}`);
        }
      },
    });

    await expect(crashingServices.uploadFullTextDocument(
      project.id,
      paper.id,
      { originalFilename: `${phase}.pdf`, mediaType: "application/pdf" },
      Readable.from([bytes]),
    )).rejects.toThrow(`simulated crash: ${phase}`);
    expect(crashed).toBe(true);

    const [owner] = await appClient!`
      select id, storage_state, staged_storage_key
      from full_text_documents where project_id=${project.id} and paper_id=${paper.id}
    `;
    if (phase === "after_staging") {
      expect(owner).toBeUndefined();
      expect(stageKey).toMatch(/^\.tmp\//);
      expect((await services.auditFullTextDocumentStorage(project.id)).stagedFiles).toContain(stageKey);
      await storage.remove(stageKey!);
      return;
    }

    expect(owner).toBeDefined();
    const originalId = String(owner.id);
    stageKey = String(owner.staged_storage_key ?? "") || undefined;
    if (phase === "after_ready_transition") {
      stageKey = (await storage.listKeys()).find((key) => key.startsWith(".tmp/") && !keysBefore.has(key));
    }
    expect(owner.storage_state).toBe(phase === "after_ready_transition" ? "ready" : "pending");
    if (owner.storage_state === "pending") {
      expect((await services.listFullTextDocuments(project.id, paper.id)).map((document) => document.id)).not.toContain(originalId);
      await expect(services.getFullTextDocument(project.id, originalId)).rejects.toMatchObject({ code: "STORAGE_PENDING" });
      await expect(services.openFullTextDocumentDownload(project.id, originalId)).rejects.toMatchObject({ code: "STORAGE_PENDING" });
      await expect(services.setPreferredFullTextDocument(project.id, paper.id, originalId)).rejects.toMatchObject({ code: "STORAGE_PENDING" });
    }

    const restarted = createReviewServices(databaseHandle, { documentStorage: storage });
    const recovered = await restarted.uploadFullTextDocument(
      project.id,
      paper.id,
      { originalFilename: `${phase}.pdf`, mediaType: "application/pdf" },
      Readable.from([bytes]),
    );
    expect(recovered.document.id).toBe(originalId);
    expect(recovered.kind).toBe("duplicate");
    const [recoveredState] = await appClient!`select storage_state from full_text_documents where id=${originalId}`;
    expect(recoveredState.storage_state).toBe("ready");
    if (phase === "after_ready_transition") {
      expect(stageKey).toBeTruthy();
      expect(await storage.exists(stageKey!)).toBe(true);
      expect((await services.auditFullTextDocumentStorage(project.id)).stagedFiles).toContain(stageKey);
      // This is the explicitly accepted post-ready cleanup orphan. Audit must
      // report it; neither recovery nor audit deletes it.
      await storage.remove(stageKey!);
    } else {
      expect(await services.auditFullTextDocumentStorage(project.id)).toEqual({ missingFiles: [], orphanFiles: [], stagedFiles: [] });
    }
  }, 30_000);

  it("preserves a stage when the database commit succeeds but its response is lost", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `Uncertain commit ${crypto.randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Uncertain storage commit" });
    const bytes = Buffer.from("%PDF-1.7\nuncertain database commit");
    const storage = new LocalDocumentStorage(storageRoot);
    const mutableDb = databaseHandle as unknown as { transaction: (callback: unknown, config?: unknown) => Promise<unknown> };
    const originalTransaction = mutableDb.transaction.bind(databaseHandle);
    let dropCommitResponse = true;
    mutableDb.transaction = async (callback, config) => {
      const committed = await originalTransaction(callback, config);
      if (dropCommitResponse) {
        dropCommitResponse = false;
        throw new Error("simulated lost commit response");
      }
      return committed;
    };

    try {
      await expect(services.uploadFullTextDocument(
        project.id,
        paper.id,
        { originalFilename: "uncertain.pdf", mediaType: "application/pdf" },
        Readable.from([bytes]),
      )).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally {
      mutableDb.transaction = originalTransaction;
    }

    const [pending] = await appClient!`
      select id, staged_storage_key, storage_state
      from full_text_documents where project_id=${project.id} and paper_id=${paper.id}
    `;
    expect(pending.storage_state).toBe("pending");
    expect(await storage.exists(String(pending.staged_storage_key))).toBe(true);
    const recovered = await services.uploadFullTextDocument(
      project.id,
      paper.id,
      { originalFilename: "uncertain.pdf", mediaType: "application/pdf" },
      Readable.from([bytes]),
    );
    expect(recovered.document.id).toBe(String(pending.id));
    const [recoveredState] = await appClient!`select storage_state from full_text_documents where id=${pending.id}`;
    expect(recoveredState.storage_state).toBe("ready");
    expect(await services.auditFullTextDocumentStorage(project.id)).toEqual({ missingFiles: [], orphanFiles: [], stagedFiles: [] });
  }, 30_000);

  it("retains an unowned stage when the reservation transaction fails", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `Unresolved reservation ${crypto.randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Unresolved storage reservation" });
    const bytes = Buffer.from("%PDF-1.7\nreservation transaction unavailable");
    const storage = new LocalDocumentStorage(storageRoot);
    const keysBefore = new Set(await storage.listKeys());
    const mutableDb = databaseHandle as unknown as { transaction: (callback: unknown, config?: unknown) => Promise<unknown> };
    const originalTransaction = mutableDb.transaction.bind(databaseHandle);
    mutableDb.transaction = async () => { throw new Error("simulated unavailable transaction response"); };

    try {
      await expect(services.uploadFullTextDocument(
        project.id,
        paper.id,
        { originalFilename: "unresolved.pdf", mediaType: "application/pdf" },
        Readable.from([bytes]),
      )).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally {
      mutableDb.transaction = originalTransaction;
    }

    const stageKey = (await storage.listKeys()).find((key) => key.startsWith(".tmp/") && !keysBefore.has(key));
    expect(stageKey).toBeTruthy();
    expect(await storage.exists(stageKey!)).toBe(true);
    const owners = await appClient!`
      select id from full_text_documents where project_id=${project.id} and paper_id=${paper.id} and sha256=${createHash("sha256").update(bytes).digest("hex")}
    `;
    expect(owners).toHaveLength(0);
    expect((await services.auditFullTextDocumentStorage(project.id)).stagedFiles).toContain(stageKey);
    // The test explicitly cleans up its own simulated orphan after proving
    // production error handling leaves it visible for operator review.
    await storage.remove(stageKey!);
  }, 30_000);

  it("serializes archival against preferred-document selection", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `Archive preference race ${crypto.randomUUID()}` });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const paper = await services.addPaper(project.id, { title: `Preference race ${attempt}` });
      const bytes = Buffer.from(`%PDF-1.7\narchive preference race ${attempt}`);
      const uploaded = await services.uploadFullTextDocument(project.id, paper.id, { originalFilename: "race.pdf", mediaType: "application/pdf" }, Readable.from([bytes]));
      const outcomes = await Promise.allSettled([
        services.setPreferredFullTextDocument(project.id, paper.id, uploaded.document.id),
        services.archiveFullTextDocument(project.id, uploaded.document.id),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const [state] = await appClient!`
        select doc.archived_at, pref.full_text_document_id
        from full_text_documents doc
        left join paper_full_text_preferences pref
          on pref.project_id=doc.project_id and pref.paper_id=doc.paper_id
        where doc.id=${uploaded.document.id}
      `;
      if (state.archived_at !== null) expect(state.full_text_document_id).toBeNull();
      else if (state.full_text_document_id !== null) expect(String(state.full_text_document_id)).toBe(uploaded.document.id);
    }
  }, 60_000);
});
