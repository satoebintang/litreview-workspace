import "dotenv/config";
import path from "node:path";
import { parseStorageArgs, reconcileStorage, storageOperationExitCode } from "@/application/storage-operations";
import { DomainError } from "@/domain/errors";
import { createDb } from "@/db/client";
import { LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";

async function main() {
  const { projectId } = parseStorageArgs(process.argv.slice(2));
  const root = process.env.LITREVIEW_DOCUMENT_STORAGE_ROOT?.trim();
  if (!root || !path.isAbsolute(root)) throw new DomainError("STORAGE_ERROR", "Set LITREVIEW_DOCUMENT_STORAGE_ROOT to an absolute storage path");
  const documentStorage = new LocalDocumentStorage(root);
  const intakeStorage = new LocalPdfIntakeStorage(root);
  const { db, client } = createDb();
  try {
    const report = await reconcileStorage(db, { documentStorage, intakeStorage, projectId });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = storageOperationExitCode(report);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof DomainError ? error.code : "COMMAND_FAILURE";
  const message = error instanceof DomainError
    ? error.message
    : "Storage reconciliation failed; check database and storage configuration.";
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 2;
});
