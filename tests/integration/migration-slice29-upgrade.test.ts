import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createAiExtractionSuggestionServices } from "@/application/ai-extraction-suggestion-services";
import { FakeExtractionSuggestionProvider } from "@/application/ai/extraction-suggestion-provider";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");
const AI_SYNTHESIS_TABLES = [
  "ai_synthesis_decisions",
  "ai_synthesis_result_groundings",
  "ai_synthesis_results",
  "ai_synthesis_dispatches",
  "ai_synthesis_request_sources",
  "ai_synthesis_request_supports",
  "ai_synthesis_requests",
] as const;

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function runMigration(client: postgres.Sql, filename: string) {
  const content = fs.readFileSync(path.join(migrationFolder, filename), "utf8");
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await client.unsafe(statement);
  }
}

function createPublishedMigrationFolder(lastIndex = 27) {
  const historicalFolder = fs.mkdtempSync(path.join(os.tmpdir(), "slice29-published-migrations-"));
  const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const publishedEntries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  fs.mkdirSync(path.join(historicalFolder, "meta"), { recursive: true });
  for (const entry of publishedEntries) {
    fs.copyFileSync(path.join(migrationFolder, `${entry.tag}.sql`), path.join(historicalFolder, `${entry.tag}.sql`));
  }
  fs.writeFileSync(
    path.join(historicalFolder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: publishedEntries }),
  );
  return historicalFolder;
}

async function assertAiSynthesisTablesEmpty(client: postgres.Sql) {
  for (const tableName of AI_SYNTHESIS_TABLES) {
    const [{ count }] = await client.unsafe(`select count(*)::integer as count from "${tableName}"`) as unknown as Array<{ count: number }>;
    expect(Number(count), `${tableName} should not receive historical backfill`).toBe(0);
  }
}

describe("Slice 29 migration boundaries", () => {
  it("applies 0000 -> 0028 to a fresh database with empty AI synthesis history", async () => {
    const name = `slice29_fresh_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const admin = postgres(BASE_URL, { max: 1 });
    const historicalFolder = createPublishedMigrationFolder(28);
    let created: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`create database "${name}"`);
      created = createDb(databaseUrl(name));
      await migrate(created.db, { migrationsFolder: historicalFolder });

      const [latest] = await created.client`select id, hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(Number(latest.id)).toBe(29);
      const migrationHash = createHash("sha256")
        .update(fs.readFileSync(path.join(migrationFolder, "0028_ai_synthesis_suggestions.sql")))
        .digest("hex");
      expect(latest.hash).toBe(migrationHash);

      const tables = await created.client`
        select table_name
        from information_schema.tables
        where table_schema = 'public' and table_name = any(${AI_SYNTHESIS_TABLES as unknown as string[]})
        order by table_name
      `;
      expect(tables.map((row) => String(row.table_name))).toEqual([...AI_SYNTHESIS_TABLES].sort());
      await assertAiSynthesisTablesEmpty(created.client);
    } finally {
      if (created) await created.client.end();
      fs.rmSync(historicalFolder, { recursive: true, force: true });
      await admin.unsafe(`drop database if exists "${name}"`);
      await admin.end();
    }
  }, 120_000);

  it("applies populated published 0027 -> 0028 without rewriting AI extraction history", async () => {
    const name = `slice29_populated_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const historicalFolder = createPublishedMigrationFolder();
    const admin = postgres(BASE_URL, { max: 1 });
    let created: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`create database "${name}"`);
      created = createDb(databaseUrl(name));
      await migrate(created.db, { migrationsFolder: historicalFolder });

      const review = createReviewServices(created.db);
      const project = await review.createProject({ title: "Slice 29 populated upgrade" });
      const paper = await review.addPaper(project.id, { title: "Preserved AI extraction study" });
      await review.recordScreeningDecision(project.id, paper.id, { decision: "include" });
      await review.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await review.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
      const field = await review.createExtractionField(project.id, { name: "Participants", fieldType: "number" });
      const documentId = randomUUID();
      const extractionId = randomUUID();
      const pageId = randomUUID();
      const pageText = "Study reports 42 participants.";
      const documentBytes = Buffer.from("%PDF-1.7\nSlice 29 migration fixture");
      const documentSha256 = createHash("sha256").update(documentBytes).digest("hex");
      await created.client`
        insert into full_text_documents
          (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256)
        values
          (${documentId}::uuid, ${project.id}::uuid, ${paper.id}::uuid,
           ${`projects/${project.id}/papers/${paper.id}/documents/${documentId}/source.pdf`},
           'study.pdf', 'application/pdf', ${documentBytes.byteLength}, ${documentSha256})
      `;
      await created.client.begin(async (tx) => {
        await tx`
          insert into document_text_extractions
            (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version,
             algorithm_version, status, page_count, character_count, started_at, completed_at)
          values
            (${extractionId}::uuid, ${project.id}::uuid, ${paper.id}::uuid, ${documentId}::uuid,
             'fixture', '1', '1', 'succeeded', 1, ${Array.from(pageText).length}, now(), now())
        `;
        await tx`
          insert into document_text_extraction_pages
            (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count)
          values
            (${pageId}::uuid, ${project.id}::uuid, ${paper.id}::uuid, ${extractionId}::uuid,
             1, 'succeeded', ${pageText}, ${Array.from(pageText).length})
        `;
      });

      const provider = new FakeExtractionSuggestionProvider({
        result: {
          kind: "success",
          suggestion: {
            outcome: "candidate",
            state: "present",
            value: "42",
            explanation: "The sample size is explicit.",
            groundings: [{ pageId, quote: "42 participants" }],
          },
          metadata: {
            provider: "fake",
            configuredModel: "fake-model",
            returnedModel: "fake-model",
            responseId: "migration-fixture-response",
            inputTokens: 10,
            outputTokens: 10,
            totalTokens: 20,
            durationMs: 1,
          },
        },
      });
      const ai = createAiExtractionSuggestionServices(created.db, provider, { defaultModel: "fake-model" });
      const began = await ai.beginAiExtractionSuggestion({
        projectId: project.id,
        paperId: paper.id,
        fieldId: field.id,
        fullTextDocumentId: documentId,
        documentTextExtractionId: extractionId,
        idempotencyKey: randomUUID(),
        externalTransmissionAcknowledged: true,
        disclosureVersion: "openai-extraction-transmission-v1",
      });
      const requestId = String(began.requestId);
      await ai.executeAiExtractionSuggestion(requestId, project.id);
      await ai.rejectAiExtractionSuggestion(project.id, requestId);

      const before = {
        request: await created.client`select * from ai_extraction_requests where id=${requestId}::uuid`,
        pages: await created.client`select * from ai_extraction_request_pages where request_id=${requestId}::uuid order by page_ordinal`,
        dispatch: await created.client`select * from ai_extraction_dispatches where request_id=${requestId}::uuid`,
        result: await created.client`select * from ai_extraction_results where request_id=${requestId}::uuid`,
        groundings: await created.client`select * from ai_extraction_result_groundings where request_id=${requestId}::uuid order by id`,
        decision: await created.client`select * from ai_extraction_decisions where request_id=${requestId}::uuid`,
      };

      await runMigration(created.client, "0028_ai_synthesis_suggestions.sql");

      expect(await created.client`select * from ai_extraction_requests where id=${requestId}::uuid`).toEqual(before.request);
      expect(await created.client`select * from ai_extraction_request_pages where request_id=${requestId}::uuid order by page_ordinal`).toEqual(before.pages);
      expect(await created.client`select * from ai_extraction_dispatches where request_id=${requestId}::uuid`).toEqual(before.dispatch);
      expect(await created.client`select * from ai_extraction_results where request_id=${requestId}::uuid`).toEqual(before.result);
      expect(await created.client`select * from ai_extraction_result_groundings where request_id=${requestId}::uuid order by id`).toEqual(before.groundings);
      expect(await created.client`select * from ai_extraction_decisions where request_id=${requestId}::uuid`).toEqual(before.decision);
      await assertAiSynthesisTablesEmpty(created.client);
    } finally {
      if (created) await created.client.end();
      fs.rmSync(historicalFolder, { recursive: true, force: true });
      await admin.unsafe(`drop database if exists "${name}"`);
      await admin.end();
    }
  }, 120_000);
});
