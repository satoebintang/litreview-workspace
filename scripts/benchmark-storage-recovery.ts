import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { reconcileStorage } from "@/application/storage-operations";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { schema } from "@/db/schema";
import { fullTextDocuments } from "@/db/schema/documents-evidence";
import { documentStorageKey } from "@/domain/full-text-documents";
import { LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function mebibytes(bytes: number) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function pdfStream(size: number, label: string) {
  const header = Buffer.from(`%PDF-1.7\n${label}\n`);
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  return Readable.from((async function* () {
    yield header;
    let remaining = size - header.byteLength;
    while (remaining > 0) {
      const nextSize = Math.min(chunk.byteLength, remaining);
      yield chunk.subarray(0, nextSize);
      remaining -= nextSize;
    }
  })());
}

async function main() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl?.trim()) {
    throw new Error("Set DATABASE_URL to a local PostgreSQL instance with permission to create disposable databases.");
  }

  const databaseName = `litreview_storage_bench_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(configuredUrl);
  adminUrl.hostname = "127.0.0.1";
  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
  const benchmarkUrl = new URL(configuredUrl);
  benchmarkUrl.hostname = "127.0.0.1";
  benchmarkUrl.pathname = `/${databaseName}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "litreview_storage_bench_"));
  const documentStorage = new LocalDocumentStorage(root);
  const intakeStorage = new LocalPdfIntakeStorage(root);
  let databaseCreated = false;
  let app: ReturnType<typeof createDb> | undefined;

  try {
    const versionRows = await admin`select current_setting('server_version_num')::integer as version`;
    const versionNumber = Number(versionRows[0]?.version);
    if (Math.floor(versionNumber / 10_000) !== 16) {
      throw new Error(`The recovery benchmark requires PostgreSQL 16; connected server_version_num=${versionNumber}.`);
    }

    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    app = createDb(benchmarkUrl.toString());
    await migrate(app.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    let queryCount = 0;
    const measurementDb = drizzle(app.client, {
      schema,
      logger: { logQuery: () => { queryCount += 1; } },
    });
    const services = createReviewServices(measurementDb, { documentStorage, pdfIntakeStorage: intakeStorage });
    const project = await services.createProject({ title: `Storage recovery benchmark ${randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Storage recovery benchmark Paper" });

    async function measure<T>(operation: () => Promise<T>) {
      queryCount = 0;
      const rssBefore = process.memoryUsage().rss;
      let peakRss = rssBefore;
      let peakHeapUsed = process.memoryUsage().heapUsed;
      const memorySampler = setInterval(() => {
        const sample = process.memoryUsage();
        peakRss = Math.max(peakRss, sample.rss);
        peakHeapUsed = Math.max(peakHeapUsed, sample.heapUsed);
      }, 20);
      memorySampler.unref();
      const started = process.hrtime.bigint();
      try {
        const result = await operation();
        const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const memoryAfter = process.memoryUsage();
        peakRss = Math.max(peakRss, memoryAfter.rss);
        peakHeapUsed = Math.max(peakHeapUsed, memoryAfter.heapUsed);
        return {
          result,
          metrics: {
            queries: queryCount,
            wallTimeMs: Number(wallTimeMs.toFixed(1)),
            rssBeforeMiB: mebibytes(rssBefore),
            peakRssMiB: mebibytes(peakRss),
            peakRssIncreaseMiB: mebibytes(Math.max(0, peakRss - rssBefore)),
            rssAfterMiB: mebibytes(memoryAfter.rss),
            peakHeapMiB: mebibytes(peakHeapUsed),
            heapAfterMiB: mebibytes(memoryAfter.heapUsed),
          },
        };
      } finally {
        clearInterval(memorySampler);
      }
    }

    const workloads = [1, 100, 1_000] as const;
    const recoveryResults = [];
    let nextRecord = 0;

    for (const rowCount of workloads) {
      const pendingRows = [];
      for (let index = 0; index < rowCount; index += 1) {
        const recordNumber = nextRecord;
        nextRecord += 1;
        const id = randomUUID();
        const bytes = Buffer.from(`%PDF-1.7\nSlice 41 recovery benchmark record ${recordNumber}`);
        const staged = await documentStorage.stage(Readable.from([bytes]));
        pendingRows.push({
          id,
          projectId: project.id,
          paperId: paper.id,
          storageKey: documentStorageKey(project.id, paper.id, id),
          originalFilename: `recovery-${recordNumber}.pdf`,
          mediaType: "application/pdf",
          byteSize: staged.byteSize,
          sha256: staged.sha256,
          storageState: "pending" as const,
          stagedStorageKey: staged.temporaryKey,
        });
      }
      await app.db.insert(fullTextDocuments).values(pendingRows);

      const measured = await measure(() => reconcileStorage(measurementDb, { documentStorage, intakeStorage, projectId: project.id }));
      const report = measured.result;

      if (report.counts.recovered !== rowCount || report.counts.pending !== 0 || report.counts.unresolved !== 0) {
        throw new Error(`Expected ${rowCount} recovered rows; report was ${JSON.stringify(report.counts)}.`);
      }
      recoveryResults.push({
        recoveryRows: rowCount,
        ...measured.metrics,
      });
    }

    const uploadResults = [];
    for (const upload of [
      { name: "1MiB", byteSize: 1 * 1024 * 1024 },
      { name: "50MiB-limit", byteSize: 50 * 1024 * 1024 },
    ]) {
      const measured = await measure(() => services.uploadFullTextDocument(
        project.id,
        paper.id,
        { originalFilename: `recovery-${upload.name}.pdf`, mediaType: "application/pdf" },
        pdfStream(upload.byteSize, upload.name),
      ));
      if (measured.result.document.byteSize !== upload.byteSize) {
        throw new Error(`${upload.name} upload stored ${measured.result.document.byteSize} bytes instead of ${upload.byteSize}.`);
      }
      uploadResults.push({ payload: upload.name, byteSize: upload.byteSize, ...measured.metrics });
    }

    console.log(JSON.stringify({
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      postgresqlMajor: 16,
      storageRoot: "isolated temporary local filesystem",
      threshold: "measurements only; no wall-time assertion",
      uploadWorkloads: uploadResults,
      recoveryWorkloads: recoveryResults,
    }, null, 2));
  } finally {
    try {
      if (app) await app.client.end();
    } finally {
      try {
        if (databaseCreated) await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
      } finally {
        await admin.end();
        const tempRoot = path.resolve(os.tmpdir());
        const resolvedRoot = path.resolve(root);
        if (!resolvedRoot.startsWith(`${tempRoot}${path.sep}`)) throw new Error("Benchmark cleanup path escaped the temporary directory.");
        await rm(resolvedRoot, { recursive: true, force: true });
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
