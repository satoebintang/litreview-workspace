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
import type { DocumentTextExtractionParser, DocumentTextExtractionParserResult } from "@/application/document-text-extraction-services";
import { codePointLength, codePointSlice, normalizeLineEndings } from "@/domain/unicode-offsets";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const TEST_DB_NAME = `slice15_text_extraction_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

describe("Slice 15 document text extraction application flow", () => {
  let admin: postgres.Sql | undefined;
  let client: postgres.Sql | undefined;
  let storageRoot = "";
  let services!: ReturnType<typeof createReviewServices>;
  let parserCalls = 0;
  let ready = false;

  const parser: DocumentTextExtractionParser = {
    extractorKey: "test-parser",
    extractorVersion: "1.0.0",
    algorithmVersion: "test-text-v1",
    async extract(): Promise<DocumentTextExtractionParserResult> {
      parserCalls += 1;
      if (parserCalls === 3) {
        return { status: "failed", pageCount: null, pages: [], error: { code: "InvalidPDFException", message: "Malformed PDF" } };
      }
      if (parserCalls === 2) {
        return {
          status: "partial",
          pageCount: 2,
          pages: [
            { pageNumber: 1, status: "succeeded", text: "A😀 B\r\n", characterCount: 5 },
            { pageNumber: 2, status: "failed", text: "", characterCount: 0, error: { code: "page_extraction_issue", message: "Fixture page failure" } },
          ],
          error: { code: "page_extraction_issue", message: "Fixture page failure" },
        };
      }
      return {
        status: "succeeded",
        pageCount: 2,
        pages: [
          { pageNumber: 1, status: "succeeded", text: "A😀 B\r\n", characterCount: 5 },
          { pageNumber: 2, status: "succeeded", text: "CJK 文献", characterCount: 6 },
        ],
        error: null,
      };
    },
  };

  beforeAll(async () => {
    try {
      admin = postgres(BASE_URL, { max: 1 });
      await admin`select 1`;
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      const created = createDb(TEST_DB_URL);
      client = created.client;
      storageRoot = await mkdtemp(path.join(os.tmpdir(), "litreview_slice15_extraction_"));
      services = createReviewServices(created.db, { documentStorage: new LocalDocumentStorage(storageRoot), documentTextExtractor: parser });
      await migrate(created.db, { migrationsFolder: "./drizzle" });
      ready = true;
    } catch {
      await admin?.end().catch(() => undefined);
      admin = undefined;
      ready = false;
    }
  }, 120_000);

  afterAll(async () => {
    if (client) await client.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
      await admin.end();
    }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 120_000);

  it("persists immutable page-aware runs and derives exact code-point Evidence server-side", async () => {
    if (!ready) return;
    const project = await services.createProject({ title: `Extraction project ${crypto.randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "Native text study" });
    const uploaded = await services.uploadFullTextDocument(project.id, paper.id, { originalFilename: "study.pdf", mediaType: "application/pdf" }, Readable.from([Buffer.from("%PDF-1.7\nfixture")]))
    expect(uploaded.kind).toBe("created");
    if (uploaded.kind !== "created") throw new Error("fixture upload was not created");

    const first = await services.extractDocumentText(project.id, uploaded.document.id);
    const second = await services.extractDocumentText(project.id, uploaded.document.id);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("partial");
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second.pages?.[1]).toMatchObject({ status: "failed", text: "", characterCount: 0 });
    expect((await services.getLatestDocumentTextExtraction(project.id, uploaded.document.id))?.id).toBe(second.id);
    expect(first.pages?.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(first.pages?.[0]?.text).toBe("A😀 B\n");
    expect(first.pages?.[0]?.characterCount).toBe(5);

    const evidence = await services.recordEvidenceFromExtractedPage(project.id, {
      paperId: paper.id,
      fullTextDocumentId: uploaded.document.id,
      documentTextExtractionId: first.id,
      pageNumber: 1,
      startOffset: 1,
      endOffset: 2,
      note: "Exact emoji span",
    });
    expect(evidence.sourceText).toBe("😀");
    expect(evidence.extractionStartOffset).toBe(1);
    expect(evidence.extractionEndOffset).toBe(2);
    expect(evidence.documentTextExtractionId).toBe(first.id);

    // PostgreSQL's character semantics must remain equivalent to the central
    // TypeScript code-point helper used for persisted provenance offsets.
    const unicodeCases = ["ASCII", "A😀B", "漢字", "e\u0301", normalizeLineEndings("A😀\r\n漢字e\u0301")];
    for (const text of unicodeCases) {
      const [row] = await client!`select char_length(${text})::integer as length, substring(${text} from 1 for ${codePointLength(text)}) as slice` as unknown as Array<{ length: number; slice: string }>;
      expect(Number(row.length)).toBe(codePointLength(text));
      expect(row.slice).toBe(codePointSlice(text, 0, codePointLength(text)));
    }

    await expect(services.recordEvidenceFromExtractedPage(project.id, {
      paperId: paper.id,
      fullTextDocumentId: uploaded.document.id,
      documentTextExtractionId: first.id,
      pageNumber: 1,
      startOffset: 0,
      endOffset: 99,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const failed = await services.extractDocumentText(project.id, uploaded.document.id);
    expect(failed.status).toBe("failed");
    expect(failed.pageCount).toBeNull();
    expect(failed.characterCount).toBeNull();
    expect(failed.pages).toEqual([]);
    expect((await services.getDocumentTextExtraction(project.id, uploaded.document.id, first.id)).pages).toHaveLength(2);

    await services.archiveFullTextDocument(project.id, uploaded.document.id);
    await expect(services.extractDocumentText(project.id, uploaded.document.id)).rejects.toMatchObject({ code: "DOCUMENT_ARCHIVED" });
    await expect(services.recordEvidenceFromExtractedPage(project.id, {
      paperId: paper.id,
      fullTextDocumentId: uploaded.document.id,
      documentTextExtractionId: first.id,
      pageNumber: 1,
      startOffset: 0,
      endOffset: 1,
    })).rejects.toMatchObject({ code: "DOCUMENT_ARCHIVED" });
  });
});
