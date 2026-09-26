import { DomainError } from "@/domain/errors";
import type { DocumentStorage, StagedDocument } from "@/infrastructure/document-storage";

export type StorageMaterializationState = "pending" | "ready";

export type StorageMaterializationRecord = {
  id: string;
  projectId: string;
  storageKey: string;
  stagedStorageKey: string | null;
  byteSize: number;
  sha256: string;
  storageState: StorageMaterializationState;
};

export type StorageMaterializationPhase =
  | "after_staging"
  | "after_pending_commit"
  | "after_final_installation"
  | "after_final_verification"
  | "after_ready_transition"
  | "after_resolution_commit";

export type StorageMaterializationFlow = "full_text_document" | "pdf_intake" | "pdf_intake_resolution" | "reconcile";

export type StorageCheckpoint = (
  phase: StorageMaterializationPhase,
  context: { flow: StorageMaterializationFlow; projectId?: string; id?: string; storageKey?: string },
) => void | Promise<void>;

export type StorageMaterializationAccess = {
  load(id: string): Promise<StorageMaterializationRecord | null>;
  replaceStage(id: string, expectedStageKey: string, replacementStageKey: string): Promise<StorageMaterializationRecord | null>;
  markReady(id: string, expectedStageKey: string): Promise<StorageMaterializationRecord | null>;
};

function assertMatches(record: StorageMaterializationRecord, actual: { byteSize: number; sha256: string }, label: string) {
  if (actual.byteSize !== record.byteSize || actual.sha256 !== record.sha256) {
    throw new DomainError("STORAGE_INTEGRITY", `${label} bytes do not match the committed size and SHA-256`);
  }
}

/**
 * Complete a pending row without holding a database lock during file I/O.
 * The final key is immutable and installation is an atomic no-overwrite link;
 * the only database write is the conditional pending-to-ready transition.
 */
export async function materializePendingStorageRecord(options: {
  access: StorageMaterializationAccess;
  storage: DocumentStorage;
  id: string;
  flow: StorageMaterializationFlow;
  checkpoint?: StorageCheckpoint;
  projectId?: string;
  replacementStage?: () => Promise<StagedDocument>;
}): Promise<StorageMaterializationRecord> {
  const { access, storage, id, flow, checkpoint } = options;
  const context = (record?: StorageMaterializationRecord) => ({
    flow,
    projectId: options.projectId ?? record?.projectId,
    id,
    storageKey: record?.storageKey,
  });
  const maxAttempts = 8;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let record = await access.load(id);
    if (!record) throw new DomainError("DOCUMENT_NOT_FOUND", "Storage owner was not found");

    if (record.storageState === "ready") {
      const final = await storage.inspect(record.storageKey);
      if (!final) throw new DomainError("STORAGE_INTEGRITY", "A ready storage owner has no final file");
      assertMatches(record, final, "Final");
      await storage.ensureDurable(record.storageKey);
      return record;
    }

    let stageKey = record.stagedStorageKey;
    if (!stageKey) throw new DomainError("STORAGE_INTEGRITY", "A pending storage owner has no recorded staging key");

    let stage = await storage.inspect(stageKey);
    if (stage) assertMatches(record, stage, "Recorded stage");
    let final = await storage.inspect(record.storageKey);
    if (!final) {
      if (!stage && options.replacementStage) {
        const replacement = await options.replacementStage();
        const replacementBytes = await storage.inspect(replacement.temporaryKey);
        if (!replacementBytes) throw new DomainError("STORAGE_PENDING", "Replacement staging file is missing");
        try {
          assertMatches(record, replacementBytes, "Replacement stage");
        } catch (error) {
          await storage.remove(replacement.temporaryKey).catch(() => undefined);
          throw error;
        }
        if (replacement.temporaryKey === stageKey) {
          throw new DomainError("STORAGE_PENDING", "The recorded staging file is missing and no distinct replacement was provided");
        }
        let updated: StorageMaterializationRecord | null = null;
        try {
          updated = await access.replaceStage(id, stageKey, replacement.temporaryKey);
        } catch (error) {
          const latest = await access.load(id).catch(() => null);
          if (latest?.stagedStorageKey === replacement.temporaryKey && latest.storageState === "pending") {
            updated = latest;
          } else {
            // The conditional update may still commit after an uncertain
            // transport error. Preserve the new source for reconciliation.
            throw error;
          }
        }
        if (updated === null) {
          const latest = await access.load(id);
          if (latest?.stagedStorageKey === replacement.temporaryKey && latest.storageState === "pending") {
            record = latest;
            stageKey = replacement.temporaryKey;
          } else {
            await storage.remove(replacement.temporaryKey).catch(() => undefined);
            continue;
          }
        } else if (updated) {
          record = updated;
          stageKey = updated.stagedStorageKey ?? replacement.temporaryKey;
        }
        stage = await storage.inspect(stageKey);
      }

      if (!stage) throw new DomainError("STORAGE_PENDING", "Pending storage has neither a final file nor its recorded stage");
      let installFailure: unknown;
      try {
        await storage.install(stageKey, record.storageKey);
      } catch (error) {
        installFailure = error;
      }
      if (installFailure !== undefined) {
        // A competing installer may have won after our first inspection. Its
        // destination is never overwritten; inspect it before deciding whether
        // the pending owner can converge.
        final = await storage.inspect(record.storageKey).catch(() => null);
        if (!final) throw installFailure;
      } else {
        await checkpoint?.("after_final_installation", context(record));
      }
      final = await storage.inspect(record.storageKey);
    }

    if (!final) throw new DomainError("STORAGE_PENDING", "Final storage file is still missing after installation");
    assertMatches(record, final, "Final");
    await storage.ensureDurable(record.storageKey);
    await checkpoint?.("after_final_verification", context(record));

    const transitioned = await access.markReady(id, stageKey);
    if (!transitioned) continue;
    await checkpoint?.("after_ready_transition", context(transitioned));

    // A mismatched or unsafe stage is retained and becomes an audit-visible
    // unowned artifact. Only matching bytes may be removed as routine cleanup.
    const stageAfterReady = await storage.inspect(stageKey).catch(() => null);
    if (stageAfterReady && stageAfterReady.byteSize === transitioned.byteSize && stageAfterReady.sha256 === transitioned.sha256) {
      await storage.remove(stageKey).catch(() => undefined);
    }
    return transitioned;
  }

  throw new DomainError("CONCURRENT_MODIFICATION", "Storage materialization changed concurrently; retry the operation");
}
