import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createManuscriptSnapshotServices } from "@/application/manuscript-snapshot-services";
import type { Database } from "@/db/client";

const projectId = "00000000-0000-4000-8000-000000000001";
const manuscriptId = "00000000-0000-4000-8000-000000000002";
const snapshotId = "00000000-0000-4000-8000-000000000003";
const capturedAt = new Date("2026-09-18T00:00:00.123Z");
const finalizedAt = new Date("2026-09-18T00:00:00.456Z");
const markdown = "# Manuscript\n\n## References\n";
const markdownHash = createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");

const emptySource = {
  manuscript: { id: manuscriptId, projectId, title: "Manuscript", isDefault: true, citationStyle: "numeric", createdAt: capturedAt, updatedAt: capturedAt },
  sections: [],
  bibliographyCandidates: [],
  warnings: [],
  counts: { sectionCount: 0, activeItemCount: 0, proseBlockCount: 0, claimItemCount: 0, placedClaimCount: 0, unsupportedPlacedClaimCount: 0, supersededPlacedClaimCount: 0, withdrawnParentClaimCount: 0, distinctCitationCandidatePaperCount: 0 },
};

function fakeDatabase(firstFailure?: unknown) {
  let transactionCount = 0;
  let loaderCount = 0;
  let transactionExecutor: unknown;
  let loaderExecutor: unknown;
  const transaction = vi.fn(async (callback: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
    transactionCount += 1;
    if (transactionCount === 1 && firstFailure !== undefined) throw firstFailure;
    let call = 0;
    const execute = vi.fn(async () => {
      call += 1;
      if (call === 1) return [];
      if (call === 2) return [{ captured_at: capturedAt }];
      if (call === 3) return [{ id: snapshotId, sequence: BigInt(1), captured_at: capturedAt }];
      if (call === 4) return [{ id: snapshotId, sequence: BigInt(1), captured_at: capturedAt, finalized_at: finalizedAt, rendered_markdown_sha256: markdownHash }];
      throw new Error(`Unexpected fake capture statement ${call}`);
    });
    transactionExecutor = { execute };
    return callback(transactionExecutor as { execute: ReturnType<typeof vi.fn> });
  });
  const outerExecute = vi.fn();
  const db = { execute: outerExecute, transaction } as unknown as Database;
  const services = createManuscriptSnapshotServices(db, async (executor) => {
    loaderCount += 1;
    loaderExecutor = executor;
    return emptySource;
  });
  return { services, transaction, outerExecute, get transactionCount() { return transactionCount; }, get loaderCount() { return loaderCount; }, get transactionExecutor() { return transactionExecutor; }, get loaderExecutor() { return loaderExecutor; } };
}

describe("Manuscript snapshot retry boundary", () => {
  it("keeps the PostgreSQL snapshot function as assembly of already formatted values", () => {
    const migration = fs.readFileSync(path.resolve(process.cwd(), "drizzle/0024_manuscript_snapshots.sql"), "utf8");
    const body = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION assemble_manuscript_snapshot_markdown"), migration.indexOf("CREATE OR REPLACE FUNCTION validate_manuscript_snapshot_finalization"));
    expect(body).not.toMatch(/authors|publication_year|doi|citation_formatter|author_year.*sort/i);
    expect(body).toMatch(/rendered_reference/);
    expect(body).toMatch(/ORDER BY section_position/);
    expect(body).toMatch(/ORDER BY b\.bibliography_position/);
  });

  it("keeps the authoritative capture reads inside one Repeatable Read executor", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/application/manuscript-snapshot-services.ts"), "utf8");
    const start = source.indexOf("const capture = () => db.transaction");
    const end = source.indexOf("for (let attempt", start);
    const capture = source.slice(start, end);
    const isolation = capture.indexOf("set transaction isolation level repeatable read");
    const boundary = capture.indexOf("select statement_timestamp() as captured_at");
    const projection = capture.indexOf("loadManuscriptProjection(tx");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(boundary).toBeGreaterThan(isolation);
    expect(projection).toBeGreaterThan(boundary);
    expect(capture).not.toMatch(/\bdb\.execute/);
    expect(capture.match(/\.transaction\(/g)).toHaveLength(1);
    expect(capture).toContain("${boundary.captured_at}");
  });

  it.each([
    { name: "serialization failure", error: { code: "40001" } },
    { name: "deadlock detected", error: { cause: { code: "40P01" } } },
  ])("restarts the complete capture for a $name", async ({ error }) => {
    const fake = fakeDatabase(error);
    const result = await fake.services.createManuscriptSnapshot(projectId, manuscriptId);
    expect(result.id).toBe(snapshotId);
    expect(result.capturedAt).toEqual(capturedAt);
    expect(fake.transactionCount).toBe(2);
    expect(fake.loaderCount).toBe(1);
    expect(fake.loaderExecutor).toBe(fake.transactionExecutor);
    expect(fake.outerExecute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "validation", error: { code: "VALIDATION_ERROR" } },
    { name: "database constraint", error: { code: "23514" } },
    { name: "unknown transport", error: { code: "ECONNRESET" } },
  ])("does not retry a $name failure", async ({ error }) => {
    const fake = fakeDatabase(error);
    await expect(fake.services.createManuscriptSnapshot(projectId, manuscriptId)).rejects.toMatchObject(error);
    expect(fake.transactionCount).toBe(1);
    expect(fake.loaderCount).toBe(0);
  });
});
