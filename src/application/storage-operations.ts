import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import {
  isDocumentStorageKey,
} from "@/domain/full-text-documents";
import {
  DocumentStorageError,
  isPdfIntakeStorageKey,
  type DocumentStorage,
  type PdfIntakeStorage,
  type StorageInventoryEntry,
} from "@/infrastructure/document-storage";
import {
  materializePendingStorageRecord,
  type StorageMaterializationAccess,
  type StorageMaterializationRecord,
} from "./storage-materialization";

const PAGE_SIZE = 100;
const DETAIL_LIMIT = 100;
const INVENTORY_BATCH_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TableName = "full_text_documents" | "pdf_intakes";
type StorageState = "pending" | "ready";
type StorageRow = StorageMaterializationRecord & { createdAtCursor: string };
type SqlExecutor = Pick<Database, "execute">;
type Finding = { kind?: string; id?: string; projectId?: string; storageKey?: string; reason?: string };
type FindingBucket = "pending" | "pendingRecoverable" | "recovered" | "unresolved" | "missingReady" | "orphanFinal" | "unknownStaged" | "integrityConflict" | "unexpectedArtifact";

export type StorageOperationReport = {
  projectId: string | null;
  counts: Record<FindingBucket, number>;
  details: Record<FindingBucket, Finding[]>;
};

function rows(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

function toStorageRow(row: Record<string, unknown>): StorageRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    storageKey: String(row.storage_key),
    stagedStorageKey: row.staged_storage_key == null ? null : String(row.staged_storage_key),
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    storageState: String(row.storage_state) as StorageState,
    createdAtCursor: String(row.created_at_cursor),
  };
}

function asMaterializationRecord(row: Record<string, unknown> | null | undefined): StorageMaterializationRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    storageKey: String(row.storage_key),
    stagedStorageKey: row.staged_storage_key == null ? null : String(row.staged_storage_key),
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    storageState: String(row.storage_state) as StorageState,
  };
}

function emptyReport(projectId?: string): StorageOperationReport {
  const buckets: FindingBucket[] = [
    "pending", "pendingRecoverable", "recovered", "unresolved", "missingReady",
    "orphanFinal", "unknownStaged", "integrityConflict", "unexpectedArtifact",
  ];
  const counts = Object.fromEntries(buckets.map((bucket) => [bucket, 0]));
  const details = Object.fromEntries(buckets.map((bucket) => [bucket, [] as Finding[]]));
  return {
    projectId: projectId ?? null,
    counts: counts as unknown as Record<FindingBucket, number>,
    details: details as unknown as Record<FindingBucket, Finding[]>,
  };
}

function add(report: StorageOperationReport, bucket: FindingBucket, finding: Finding) {
  report.counts[bucket] += 1;
  if (report.details[bucket].length < DETAIL_LIMIT) report.details[bucket].push(finding);
}

function textArray(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function projectCondition(projectId?: string) {
  return projectId ? sql`and project_id=${projectId}::uuid` : sql``;
}

async function readStatePage(
  executor: SqlExecutor,
  table: TableName,
  state: StorageState,
  projectId: string | undefined,
  after?: { createdAtCursor: string; id: string },
) {
  const keyset = after
    ? sql`and (created_at > ${after.createdAtCursor}::timestamptz or (created_at = ${after.createdAtCursor}::timestamptz and id > ${after.id}::uuid))`
    : sql``;
  const result = await executor.execute(sql`
    select id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state, created_at::text as created_at_cursor
    from ${sql.raw(table)}
    where storage_state=${state} ${projectCondition(projectId)} ${keyset}
    order by created_at, id
    limit ${PAGE_SIZE}
  `);
  return rows(result).map(toStorageRow);
}

async function* iterateStateRows(executor: SqlExecutor, table: TableName, state: StorageState, projectId?: string) {
  let after: { createdAtCursor: string; id: string } | undefined;
  while (true) {
    const page = await readStatePage(executor, table, state, projectId, after);
    if (page.length === 0) return;
    yield* page;
    const last = page[page.length - 1]!;
    after = { createdAtCursor: last.createdAtCursor, id: last.id };
  }
}

function rowFinding(row: StorageRow, reason?: string): Finding {
  return { kind: row.storageState, id: row.id, projectId: row.projectId, storageKey: row.storageKey, ...(reason ? { reason } : {}) };
}

function errorReason(error: unknown) {
  if (error instanceof DomainError) return error.code.toLowerCase();
  if (error instanceof DocumentStorageError) return error.code.toLowerCase();
  return "storage_inspection_failed";
}

function addConflict(report: StorageOperationReport, finding: Finding) {
  add(report, "integrityConflict", finding);
}

async function hasCommittedResolutionSource(
  executor: SqlExecutor,
  row: StorageRow,
  intakeStorage: PdfIntakeStorage,
) {
  const found = rows(await executor.execute(sql`
    select i.storage_key, i.byte_size, i.sha256, i.storage_state
    from pdf_intake_resolutions r
    join pdf_intakes i on i.project_id=r.project_id and i.id=r.intake_id
    where r.project_id=${row.projectId}::uuid
      and r.full_text_document_id=${row.id}::uuid
      and r.materialization_kind='created_document'
    limit 1
  `))[0];
  if (!found || found.storage_state !== "ready") return false;
  try {
    const source = await intakeStorage.inspect(String(found.storage_key));
    return Boolean(source && source.byteSize === Number(found.byte_size) && source.sha256 === String(found.sha256)
      && source.byteSize === row.byteSize && source.sha256 === row.sha256);
  } catch {
    return false;
  }
}

async function inspectOwnerRows(
  executor: SqlExecutor,
  options: { table: TableName; state: StorageState; documentStorage: DocumentStorage; intakeStorage: PdfIntakeStorage; report: StorageOperationReport },
) {
  const { table, state, documentStorage, intakeStorage, report } = options;
  const storage = table === "full_text_documents" ? documentStorage : intakeStorage;
  for await (const row of iterateStateRows(executor, table, state, report.projectId ?? undefined)) {
    let unresolved = false;
    if (state === "pending") add(report, "pending", rowFinding(row));
    try {
      const final = await storage.inspect(row.storageKey);
      if (state === "ready") {
        if (!final) {
          add(report, "missingReady", rowFinding(row, "final_file_missing"));
          unresolved = true;
        } else if (final.byteSize !== row.byteSize || final.sha256 !== row.sha256) {
          addConflict(report, rowFinding(row, "final_bytes_mismatch"));
          unresolved = true;
        }
      } else {
        const stage = row.stagedStorageKey ? await storage.inspect(row.stagedStorageKey) : null;
        if (final && (final.byteSize !== row.byteSize || final.sha256 !== row.sha256)) {
          addConflict(report, rowFinding(row, "final_bytes_mismatch"));
          unresolved = true;
        }
        if (stage && (stage.byteSize !== row.byteSize || stage.sha256 !== row.sha256)) {
          addConflict(report, { ...rowFinding(row, "staged_bytes_mismatch"), storageKey: row.stagedStorageKey ?? undefined });
          unresolved = true;
        }
        if (!unresolved) {
          if (final || stage) {
            add(report, "pendingRecoverable", rowFinding(row, final ? "verified_final_present" : "verified_stage_present"));
          } else if (table === "full_text_documents" && await hasCommittedResolutionSource(executor, row, intakeStorage)) {
            add(report, "pendingRecoverable", rowFinding(row, "retained_intake_can_restage"));
          } else {
            unresolved = true;
          }
        }
      }
    } catch (error) {
      addConflict(report, rowFinding(row, errorReason(error)));
      unresolved = true;
    }
    if (unresolved) add(report, "unresolved", rowFinding(row, state === "pending" ? "pending_storage_unresolved" : "ready_storage_integrity_failure"));
  }
}

async function findOwners(executor: SqlExecutor, keys: readonly string[], staged: boolean) {
  if (keys.length === 0) return new Map<string, Record<string, unknown>[]>();
  const keyList = textArray(keys);
  const field = staged ? "staged_storage_key" : "storage_key";
  const found = rows(await executor.execute(sql`
    select ${sql.raw(field)} as artifact_key, 'full_text_document' as owner_kind, id, project_id
    from full_text_documents where ${sql.raw(field)} in (${keyList})
    union all
    select ${sql.raw(field)} as artifact_key, 'pdf_intake' as owner_kind, id, project_id
    from pdf_intakes where ${sql.raw(field)} in (${keyList})
  `));
  const owners = new Map<string, Record<string, unknown>[]>();
  for (const owner of found) {
    const key = String(owner.artifact_key);
    owners.set(key, [...(owners.get(key) ?? []), owner]);
  }
  return owners;
}

function isStagePrefix(key: string) {
  return key.startsWith(".tmp/") || key.startsWith(".pdf-intake/.tmp/");
}

function isKnownStageShape(key: string) {
  return /^\.tmp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$/.test(key)
    || /^\.pdf-intake\/\.tmp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$/.test(key);
}

async function inspectInventoryBatch(
  executor: SqlExecutor,
  entries: StorageInventoryEntry[],
  report: StorageOperationReport,
) {
  const projectId = report.projectId ?? undefined;
  const finalEntries = entries.filter((entry) => isDocumentStorageKey(entry.key) || isPdfIntakeStorageKey(entry.key));
  const stageEntries = entries.filter((entry) => isStagePrefix(entry.key));
  const finalOwners = await findOwners(executor, finalEntries.map((entry) => entry.key), false);
  const stageOwners = await findOwners(executor, stageEntries.map((entry) => entry.key), true);
  for (const entry of finalEntries) {
    if (projectId && !entry.key.startsWith(`projects/${projectId}/`)) continue;
    const owner = finalOwners.get(entry.key)?.[0];
    if (!owner) {
      add(report, "orphanFinal", { storageKey: entry.key, kind: entry.kind });
      if (entry.kind !== "file") {
        addConflict(report, { storageKey: entry.key, reason: `orphan_${entry.kind}` });
        add(report, "unresolved", { storageKey: entry.key, reason: `orphan_${entry.kind}` });
      }
      continue;
    }
    if (projectId && String(owner.project_id) !== projectId) continue;
    // Owned final paths are checked against immutable SHA/size in the row scan.
    // A non-file entry is caught there as an unsafe path and reported once.
  }
  for (const entry of stageEntries) {
    if (!isKnownStageShape(entry.key)) {
      add(report, "unknownStaged", { storageKey: entry.key, kind: entry.kind, reason: "unrecognized_stage_key" });
      if (entry.kind !== "file") {
        addConflict(report, { storageKey: entry.key, reason: `unrecognized_stage_${entry.kind}` });
        add(report, "unresolved", { storageKey: entry.key, reason: `unrecognized_stage_${entry.kind}` });
      }
      continue;
    }
    const owner = stageOwners.get(entry.key)?.[0];
    if (!owner) {
      add(report, "unknownStaged", { storageKey: entry.key, kind: entry.kind, reason: "stage_has_no_pending_owner" });
      if (entry.kind !== "file") {
        addConflict(report, { storageKey: entry.key, reason: `unowned_stage_${entry.kind}` });
        add(report, "unresolved", { storageKey: entry.key, reason: `unowned_stage_${entry.kind}` });
      }
      continue;
    }
    if (projectId && String(owner.project_id) !== projectId) continue;
    // Pending owners' stage bytes are checked in their bounded row scan.
  }
  for (const entry of entries) {
    if (finalEntries.includes(entry) || stageEntries.includes(entry)) continue;
    if (projectId && entry.key.startsWith("projects/") && !entry.key.startsWith(`projects/${projectId}/`)) continue;
    add(report, "unexpectedArtifact", { storageKey: entry.key, kind: entry.kind });
  }
}

async function inspectInventory(executor: SqlExecutor, storage: DocumentStorage, report: StorageOperationReport) {
  let batch: StorageInventoryEntry[] = [];
  for await (const entry of storage.iterateInventory()) {
    batch.push(entry);
    if (batch.length >= INVENTORY_BATCH_SIZE) {
      await inspectInventoryBatch(executor, batch, report);
      batch = [];
    }
  }
  if (batch.length) await inspectInventoryBatch(executor, batch, report);
}

export async function auditStorage(
  executor: SqlExecutor,
  options: { documentStorage: DocumentStorage; intakeStorage: PdfIntakeStorage; projectId?: string },
) {
  const report = emptyReport(options.projectId);
  await inspectOwnerRows(executor, { table: "full_text_documents", state: "pending", ...options, report });
  await inspectOwnerRows(executor, { table: "pdf_intakes", state: "pending", ...options, report });
  await inspectOwnerRows(executor, { table: "full_text_documents", state: "ready", ...options, report });
  await inspectOwnerRows(executor, { table: "pdf_intakes", state: "ready", ...options, report });
  await inspectInventory(executor, options.documentStorage, report);
  return report;
}

function materializationAccess(db: Database, table: TableName, projectId?: string): StorageMaterializationAccess {
  const project = projectId ? sql`and project_id=${projectId}::uuid` : sql``;
  return {
    load: async (id) => {
      const row = rows(await db.execute(sql`
        select id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
        from ${sql.raw(table)} where id=${id}::uuid ${project} limit 1
      `))[0];
      return asMaterializationRecord(row);
    },
    replaceStage: async (id, expectedStageKey, replacementStageKey) => {
      const row = rows(await db.execute(sql`
        update ${sql.raw(table)} set staged_storage_key=${replacementStageKey}
        where id=${id}::uuid ${project} and storage_state='pending' and staged_storage_key=${expectedStageKey}
        returning id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
      `))[0];
      return asMaterializationRecord(row);
    },
    markReady: async (id, expectedStageKey) => {
      const row = rows(await db.execute(sql`
        update ${sql.raw(table)} set storage_state='ready', staged_storage_key=null
        where id=${id}::uuid ${project} and storage_state='pending' and staged_storage_key=${expectedStageKey}
        returning id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
      `))[0];
      return asMaterializationRecord(row);
    },
  };
}

async function resolutionReplacementStage(
  db: Database,
  row: StorageRow,
  documentStorage: DocumentStorage,
  intakeStorage: PdfIntakeStorage,
) {
  const found = rows(await db.execute(sql`
    select i.storage_key, i.byte_size, i.sha256, i.storage_state
    from pdf_intake_resolutions r
    join pdf_intakes i on i.project_id=r.project_id and i.id=r.intake_id
    where r.project_id=${row.projectId}::uuid
      and r.full_text_document_id=${row.id}::uuid
      and r.materialization_kind='created_document'
    limit 1
  `))[0];
  if (!found || found.storage_state !== "ready") throw new DomainError("STORAGE_PENDING", "No ready retained intake can restore this pending document");
  const intakeKey = String(found.storage_key);
  const verified = await intakeStorage.inspect(intakeKey);
  if (!verified || verified.byteSize !== Number(found.byte_size) || verified.sha256 !== String(found.sha256)
    || verified.byteSize !== row.byteSize || verified.sha256 !== row.sha256) {
    throw new DomainError("STORAGE_INTEGRITY", "Retained intake bytes do not match the committed document identity");
  }
  const source = await intakeStorage.open(intakeKey);
  const staged = await documentStorage.stage(source, { maxBytes: Math.max(row.byteSize, 1) });
  if (staged.byteSize !== row.byteSize || staged.sha256 !== row.sha256) {
    await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
    throw new DomainError("STORAGE_INTEGRITY", "Restaged intake bytes do not match the committed document identity");
  }
  return staged;
}

async function reconcilePendingTable(
  db: Database,
  table: TableName,
  projectId: string | undefined,
  documentStorage: DocumentStorage,
  intakeStorage: PdfIntakeStorage,
  report: StorageOperationReport,
) {
  const storage = table === "full_text_documents" ? documentStorage : intakeStorage;
  const access = materializationAccess(db, table, projectId);
  for await (const row of iterateStateRows(db, table, "pending", projectId)) {
    try {
      await materializePendingStorageRecord({
        access,
        storage,
        id: row.id,
        projectId: row.projectId,
        flow: "reconcile",
        replacementStage: table === "full_text_documents"
          ? () => resolutionReplacementStage(db, row, documentStorage, intakeStorage)
          : undefined,
      });
      add(report, "recovered", rowFinding(row, "storage_ready"));
    } catch (error) {
      // A best-effort stage replacement or install may have created an
      // unowned artifact; the final audit reports it without reclaiming it.
      add(report, "unresolved", rowFinding(row, errorReason(error)));
    }
  }
}

export async function reconcileStorage(
  db: Database,
  options: { documentStorage: DocumentStorage; intakeStorage: PdfIntakeStorage; projectId?: string },
) {
  const recoveryReport = emptyReport(options.projectId);
  await reconcilePendingTable(db, "full_text_documents", options.projectId, options.documentStorage, options.intakeStorage, recoveryReport);
  await reconcilePendingTable(db, "pdf_intakes", options.projectId, options.documentStorage, options.intakeStorage, recoveryReport);
  const report = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return auditStorage(tx, options);
  }, { isolationLevel: "repeatable read" });
  report.counts.recovered = recoveryReport.counts.recovered;
  report.details.recovered = recoveryReport.details.recovered;
  return report;
}

export function parseStorageProjectId(value: string) {
  if (!UUID.test(value)) throw new DomainError("VALIDATION_ERROR", "Project filter must be a UUID");
  return value.toLowerCase();
}

export async function auditStorageReadOnly(
  db: Database,
  options: { documentStorage: DocumentStorage; intakeStorage: PdfIntakeStorage; projectId?: string },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return auditStorage(tx, options);
  }, { isolationLevel: "repeatable read" });
}

export function storageOperationExitCode(report: StorageOperationReport) {
  return report.counts.pending > 0 || report.counts.unresolved > 0 || report.counts.missingReady > 0 || report.counts.integrityConflict > 0 ? 1 : 0;
}

export function parseStorageArgs(args: readonly string[]) {
  let projectId: string | undefined;
  let hasProject = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--project") {
      if (hasProject) throw new DomainError("VALIDATION_ERROR", "Specify --project only once");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new DomainError("VALIDATION_ERROR", "Expected a UUID after --project");
      projectId = parseStorageProjectId(value);
      hasProject = true;
      index += 1;
    } else if (arg.startsWith("--project=")) {
      if (hasProject) throw new DomainError("VALIDATION_ERROR", "Specify --project only once");
      projectId = parseStorageProjectId(arg.slice("--project=".length));
      hasProject = true;
    } else {
      throw new DomainError("VALIDATION_ERROR", "Usage: storage command [--project <uuid>]");
    }
  }
  return { projectId };
}
