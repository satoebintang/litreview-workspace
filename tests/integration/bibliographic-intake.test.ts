import crypto from "node:crypto";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import type { BibliographicImportServices } from "@/application/bibliographic-import-services";
import { bibliographicParser } from "@/infrastructure/bibliographic-parser";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `litreview_bibliographic_${crypto.randomUUID().replaceAll("-", "")}`;
const DATABASE_URL = `${BASE_URL.replace(/\/[^/]+$/, "")}/${DATABASE_NAME}`;

describe("bibliographic intake", () => {
  let db: ReturnType<typeof createDb>["db"];
  let client: ReturnType<typeof createDb>["client"];
  type ReviewServicesWithBibliographic = ReturnType<typeof createReviewServices> & BibliographicImportServices;
  let services: ReviewServicesWithBibliographic;
  let projectId: string;

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    await admin.end();
    const created = createDb(DATABASE_URL);
    db = created.db;
    client = created.client;
    await migrate(db, { migrationsFolder: "./drizzle" });
    services = createReviewServices(db, { bibliographicParser }) as ReviewServicesWithBibliographic;
    projectId = (await services.createProject({ title: "Bibliographic intake", researchQuestion: "What is known?" })).id;
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    const admin = postgres(BASE_URL, { max: 1, prepare: false });
    await admin.unsafe(`DROP DATABASE "${DATABASE_NAME}" WITH (FORCE)`);
    await admin.end();
  });

  it("stores immutable UTF-8 source bytes, parses records, and is idempotent", async () => {
    const source = Buffer.from(`% comment before 🚀\n@article{one,\n  title={研究 🚀},\n  author={Doe, Jane and {NASA}},\n  year={2024},\n  doi={https://doi.org/10.1000/ABC}\n}\n@article{two, title={Second}, author={Roe, Sam}}\n`, "utf8");
    const imported = await services.importFile(projectId, { format: "bibtex", filename: "refs.bib", bytes: source });
    const repeated = await services.importFile(projectId, { format: "bibtex", filename: "refs-again.bib", bytes: source });
    expect(repeated.id).toBe(imported.id);
    expect(repeated.filename).toBe("refs.bib");
    expect(imported.status).toBe("finalized");
    const [artifact] = await client.unsafe("select source_bytes, source_sha256, source_byte_size from bibliographic_imports where project_id=$1 and id=$2", [projectId, imported.id]);
    expect(Buffer.from(artifact.source_bytes)).toEqual(source);
    expect(String(artifact.source_sha256)).toBe(crypto.createHash("sha256").update(source).digest("hex"));
    expect(Number(artifact.source_byte_size)).toBe(source.byteLength);
    expect(imported.records).toHaveLength(2);
    expect(imported.records[0].startByte).toBe(source.indexOf(Buffer.from("@article{one")));
    expect(source.subarray(imported.records[0].startByte, imported.records[0].endByte).toString("utf8")).toContain("研究 🚀");
    expect(await services.getRecordSourceBytes(projectId, imported.records[0].id)).toEqual(source.subarray(imported.records[0].startByte, imported.records[0].endByte));
    expect(imported.records[0].authors).toEqual(["Jane Doe", "NASA"]);
    expect(imported.records[0].doi).toBe("https://doi.org/10.1000/ABC");
  });

  it("keeps explicit resolution events and never overwrites a matched Paper", async () => {
    const existing = await services.addPaper(projectId, { title: "Existing work", authors: ["Existing Author"], publicationYear: 2020, doi: "10.1000/existing" });
    const source = Buffer.from("TY  - JOUR\nTI  - Existing work\nAU  - Existing Author\nPY  - 2020\nDO  - 10.1000/existing\nER  -\n", "utf8");
    const imported = await services.importFile(projectId, { format: "ris", filename: "refs.ris", bytes: source });
    const record = imported.records[0];
    const candidates = await services.listRecordCandidates(projectId, record.id);
    expect(candidates.map((candidate) => candidate.id)).toContain(existing.id);
    const resolved = await services.resolveImportRecord({ projectId, importRecordId: record.id, action: "matched_paper", paperId: existing.id });
    expect(resolved.eventType).toBe("matched_paper");
    expect(resolved.candidate?.paperId).toBe(existing.id);
    expect(resolved.candidateContext).toEqual(expect.arrayContaining([expect.objectContaining({ paperId: existing.id, selected: true })]));
    const detail = await services.getImport(projectId, imported.id);
    expect(detail.currentResolutions.get(record.id)?.paperId).toBe(existing.id);
    expect((await services.listPapers(projectId)).find((paper) => paper.id === existing.id)?.title).toBe("Existing work");
    await expect(services.resolveImportRecord({ projectId, importRecordId: record.id, action: "created_paper" })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("appends clear and retarget events without changing either canonical Paper", async () => {
    const first = await services.addPaper(projectId, { title: "Intake target A", authors: ["Author A"], publicationYear: 2020 });
    const second = await services.addPaper(projectId, { title: "Intake target B", authors: ["Author B"], publicationYear: 2021 });
    const imported = await services.importFile(projectId, { format: "bibtex", filename: "correction.bib", bytes: Buffer.from("@article{correction, title={Imported correction}}", "utf8") });
    const record = imported.records[0];
    const matchedA = await services.resolveImportRecord({ projectId, importRecordId: record.id, action: "matched_paper", paperId: first.id, note: "Initial identity" });
    const cleared = await services.resolveImportRecord({ projectId, importRecordId: record.id, action: "cleared", expectedResolutionId: matchedA.id, note: "Correction requested" });
    await services.resolveImportRecord({ projectId, importRecordId: record.id, action: "matched_paper", paperId: second.id, expectedResolutionId: cleared.id, note: "Retargeted identity" });
    const detail = await services.getImport(projectId, imported.id);
    const history = detail.resolutions.filter((event) => event.recordId === record.id);
    expect(history.map((event) => event.eventType)).toEqual(["matched_paper", "cleared", "matched_paper"]);
    expect(detail.currentResolutions.get(record.id)?.paperId).toBe(second.id);
    expect((await services.listPapers(projectId)).filter((paper) => [first.id, second.id].includes(paper.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, title: "Intake target A", authors: ["Author A"], publicationYear: 2020 }),
      expect.objectContaining({ id: second.id, title: "Intake target B", authors: ["Author B"], publicationYear: 2021 }),
    ]));
  });

  it("bulk-creates selected eligible records atomically through the canonical writer", async () => {
    const source = Buffer.from([
      "@article{bulk-one, title={Bulk one}, author={One, Author}, year={2020}}",
      "@article{bulk-two, title={Bulk two}, author={Two, Author}, year={2021}}",
      "@article{bulk-three, title={Bulk three}, author={Three, Author}, year={2022}}",
    ].join("\n"), "utf8");
    const imported = await services.importFile(projectId, { format: "bibtex", filename: "bulk.bib", bytes: source });
    const preview = await services.getBulkImportPreview(projectId, imported.id, imported.records.map((record) => record.id));
    expect(preview.canConfirm).toBe(true);
    expect(preview.selected.map((record) => record.title)).toEqual(["Bulk one", "Bulk two", "Bulk three"]);
    const result = await services.bulkCreateImportRecords({ projectId, importId: imported.id, selection: preview.selection });
    expect(result.created).toHaveLength(3);
    const detail = await services.getImport(projectId, imported.id);
    expect(detail.resolutions.filter((event) => event.eventType === "created_paper")).toHaveLength(3);
    expect([...detail.currentResolutions.values()].filter((event) => event.paperId)).toHaveLength(3);
  });

  it("rejects duplicate peers atomically", async () => {
    const imported = await services.importFile(projectId, { format: "bibtex", filename: "peer-duplicates.bib", bytes: Buffer.from("@article{peer-a, title={Same peer title}}\n@article{peer-b, title={Same peer title}}", "utf8") });
    const preview = await services.getBulkImportPreview(projectId, imported.id, imported.records.map((record) => record.id));
    expect(preview.canConfirm).toBe(false);
    await expect(services.bulkCreateImportRecords({ projectId, importId: imported.id, selection: preview.selection })).rejects.toMatchObject({ code: "DUPLICATE_REVIEW_REQUIRED" });
    expect((await services.getImport(projectId, imported.id)).resolutions).toHaveLength(0);
  });

  it("rejects stale candidate, resolution, and invalid-metadata confirmations before writes", async () => {
    const candidateImport = await services.importFile(projectId, { format: "bibtex", filename: "bulk-candidate.bib", bytes: Buffer.from("@article{candidate, title={Candidate arrives}}", "utf8") });
    const candidatePreview = await services.getBulkImportPreview(projectId, candidateImport.id, [candidateImport.records[0].id]);
    await services.addPaper(projectId, { title: "Candidate arrives", authors: [], publicationYear: null });
    await expect(services.bulkCreateImportRecords({ projectId, importId: candidateImport.id, selection: candidatePreview.selection })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect((await services.getImport(projectId, candidateImport.id)).resolutions).toHaveLength(0);

    const resolvedImport = await services.importFile(projectId, { format: "bibtex", filename: "bulk-resolved.bib", bytes: Buffer.from("@article{resolved, title={Resolved first}}", "utf8") });
    const resolvedPreview = await services.getBulkImportPreview(projectId, resolvedImport.id, [resolvedImport.records[0].id]);
    await services.resolveImportRecord({ projectId, importRecordId: resolvedImport.records[0].id, action: "created_paper", distinctPaperAcknowledged: true });
    await expect(services.bulkCreateImportRecords({ projectId, importId: resolvedImport.id, selection: resolvedPreview.selection })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect((await services.getImport(projectId, resolvedImport.id)).resolutions).toHaveLength(1);

    const invalidImport = await services.importFile(projectId, { format: "ris", filename: "bulk-invalid.ris", bytes: Buffer.from("TY  - JOUR\nAU  - Missing title\nER  -\n", "utf8") });
    const invalidPreview = await services.getBulkImportPreview(projectId, invalidImport.id, invalidImport.records.map((record) => record.id));
    expect(invalidPreview.canConfirm).toBe(false);
    await expect(services.bulkCreateImportRecords({ projectId, importId: invalidImport.id, selection: invalidPreview.selection })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getImport(projectId, invalidImport.id)).resolutions).toHaveLength(0);
  });

  it("creates 100 eligible records and rejects 101 before any writes", async () => {
    const source = Array.from({ length: 100 }, (_, index) => `@article{bulk-${index}, title={Bulk capacity ${index}}, author={Author ${index}}}`).join("\n");
    const imported = await services.importFile(projectId, { format: "bibtex", filename: "bulk-100.bib", bytes: Buffer.from(source, "utf8") });
    const preview = await services.getBulkImportPreview(projectId, imported.id, imported.records.map((record) => record.id));
    expect(preview.canConfirm).toBe(true);
    const result = await services.bulkCreateImportRecords({ projectId, importId: imported.id, selection: preview.selection });
    expect(result.created).toHaveLength(100);

    const overLimitSource = Array.from({ length: 101 }, (_, index) => `@article{over-${index}, title={Over capacity ${index}}, author={Author ${index}}}`).join("\n");
    const overLimit = await services.importFile(projectId, { format: "bibtex", filename: "bulk-101.bib", bytes: Buffer.from(overLimitSource, "utf8") });
    const overLimitPreview = await services.getBulkImportPreview(projectId, overLimit.id, overLimit.records.map((record) => record.id));
    expect(overLimitPreview.selectedCount).toBe(101);
    await expect(services.bulkCreateImportRecords({ projectId, importId: overLimit.id, selection: overLimitPreview.selection })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getImport(projectId, overLimit.id)).resolutions).toHaveLength(0);
  });

  it("requires explicit acknowledgement before creating a distinct matching Paper", async () => {
    const source = Buffer.from("@article{new, title={Existing work}, author={Existing Author}, year={2021}}", "utf8");
    const imported = await services.importFile(projectId, { format: "bibtex", filename: "distinct.bib", bytes: source });
    const record = imported.records[0];
    expect((await services.listRecordCandidates(projectId, record.id))[0]?.candidateReason).toBe("title");
    await expect(services.resolveImportRecord({ projectId, importRecordId: record.id, action: "created_paper" })).rejects.toMatchObject({ code: "DUPLICATE_REVIEW_REQUIRED" });
    const created = await services.resolveImportRecord({ projectId, importRecordId: record.id, action: "created_paper", distinctPaperAcknowledged: true });
    expect(created.eventType).toBe("created_paper");
    const createdPaper = (await services.listPapers(projectId)).find((paper) => paper.id === created.paperId);
    expect(createdPaper).toMatchObject({ title: "Existing work", authors: ["Existing Author"], publicationYear: 2021, doi: null });
    expect((await services.listPapers(projectId)).filter((paper) => paper.title === "Existing work")).toHaveLength(2);
  });

  it("serializes concurrent identical uploads to one immutable import", async () => {
    const source = Buffer.from("@article{concurrent, title={Concurrent work}}", "utf8");
    const imports = await Promise.all(Array.from({ length: 4 }, (_, index) => services.importFile(projectId, { format: "bibtex", filename: `concurrent-${index}.bib`, bytes: source })));
    expect(new Set(imports.map((item) => item.id)).size).toBe(1);
    const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
    const rows = await client.unsafe("select count(*)::int as count from bibliographic_imports where project_id=$1 and format='bibtex' and source_sha256=$2", [projectId, sourceSha256]);
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("exports canonical Papers deterministically as neutral BibTeX", async () => {
    const first = await services.exportBibtex(projectId);
    const second = await services.exportBibtex(projectId);
    expect(second).toBe(first);
    expect(first).toContain("@misc{");
    expect(first).toContain("author = {");
    expect(first).not.toMatch(/<span|<i>/);
  });

  it("retains record-level parse failures and catastrophic source failures durably", async () => {
    const malformed = await services.importFile(projectId, {
      format: "ris",
      filename: "malformed.ris",
      bytes: Buffer.from("TY  - JOUR\nTI  - Missing terminator\n", "utf8"),
    });
    expect(malformed.status).toBe("finalized");
    expect(malformed.records[0].outcome).toBe("failed");
    await expect(services.resolveImportRecord({ projectId, importRecordId: malformed.records[0].id, action: "created_paper" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const [paper] = await services.listPapers(projectId);
    await expect(client.unsafe("insert into bibliographic_import_resolutions (project_id, import_id, record_id, event_type, paper_id) values ($1,$2,$3,'matched_paper',$4)", [projectId, malformed.id, malformed.records[0].id, paper.id])).rejects.toThrow(/Failed bibliographic records cannot be resolved/i);

    const invalidUtf8 = await services.importFile(projectId, {
      format: "bibtex",
      filename: "invalid.bib",
      bytes: Uint8Array.from([0x40, 0x61, 0x72, 0x74, 0x69, 0x63, 0x6c, 0x65, 0x7b, 0xff, 0x7d]),
    });
    expect(invalidUtf8.status).toBe("failed");
    expect(invalidUtf8.finalizedAt).not.toBeNull();
    expect(invalidUtf8.errorCode).toBe("invalid_source");
    expect(invalidUtf8.records).toHaveLength(0);
  });

  it("rejects finalizing a direct SQL import whose declared record set is incomplete", async () => {
    const source = Buffer.from("@article{draft, title={Draft}}", "utf8");
    const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
    const [draft] = await client.unsafe(
      "insert into bibliographic_imports (project_id, format, filename, source_bytes, source_byte_size, source_sha256, parser_version, adapter_version, mapping_version, status, expected_record_count, diagnostics) values ($1, 'bibtex', 'draft.bib', $2, $3, $4, 'test', 'test', 'test', 'complete', 1, '[]'::jsonb) returning id",
      [projectId, source, source.byteLength, sourceSha256],
    );
    // The test database is dropped after the suite; the immutable import trigger
    // intentionally prevents deleting this direct-SQL draft during cleanup.
    await expect(client.unsafe("update bibliographic_imports set status='finalized', finalized_at=now() where project_id=$1 and id=$2", [projectId, draft.id])).rejects.toThrow(/record count/i);
  });
});
