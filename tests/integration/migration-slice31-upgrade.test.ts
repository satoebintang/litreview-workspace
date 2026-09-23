import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { BATCH_DOMAIN_VERSION, buildPinnedExtractionPageManifest, hashBatchItemManifest, hashBatchManifest, hashFieldSnapshot, hashOptionSnapshot } from "@/application/ai-extraction-batch-domain";
import { BATCH_DISCLOSURE_VERSION, BATCH_SELECTION_POLICY_VERSION, REQUEST_DISCLOSURE_VERSION } from "@/application/ai-extraction-batch-services";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const migrationFolder = path.resolve(process.cwd(), "drizzle");

function databaseUrl(name: string) {
  const url = new URL(BASE_URL);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(prefix: string) {
  const name = `${prefix}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(BASE_URL, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  return { name, admin, url: databaseUrl(name) };
}

function validItem(projectId: string, paperId: string, fieldId: string, idempotencyKey: string, documentId: string, extractionId: string, pageId: string) {
  const fieldOptionSnapshot = [] as const;
  const fieldDefinitionHash = hashFieldSnapshot({ projectId, id: fieldId, name: "Outcome", description: null, fieldType: "short_text", required: false, sortOrder: 0, archivedAt: null, options: fieldOptionSnapshot });
  const source = buildPinnedExtractionPageManifest({ paper: { projectId, paperId, title: "Pinned paper", finallyIncluded: true }, document: { id: documentId, paperId, archivedAt: null }, extraction: { id: extractionId, paperId, fullTextDocumentId: documentId, sequence: 1, status: "succeeded" }, pages: [{ id: pageId, paperId, documentTextExtractionId: extractionId, pageNumber: 1, status: "succeeded", text: "αβ résumé — 你好" }] });
  const item = {
    itemOrdinal: 0,
    paperId,
    extractionFieldId: fieldId,
    expectedCurrentExtractionRevisionId: null,
    titleAbstractDecisionId: null,
    fullTextDecisionId: null,
    fullTextDocumentId: documentId,
    documentTextExtractionId: extractionId,
    initialDisposition: "executable",
    initialReasonCode: "eligible",
    idempotencyKey,
    expectedRequestIntentHash: null,
    fieldDefinitionHash,
    optionSnapshotHash: hashOptionSnapshot(fieldOptionSnapshot),
    paperTitleSnapshot: "Pinned paper",
    paperAbstractSnapshot: null,
    fieldNameSnapshot: "Outcome",
    fieldDescriptionSnapshot: null,
    fieldTypeSnapshot: "short_text",
    fieldRequiredSnapshot: false,
    documentFilenameSnapshot: "study.pdf",
    extractionSequenceSnapshot: 1,
    extractionStatusSnapshot: "succeeded",
    fieldOptionSnapshot,
    pageManifest: source,
    pageManifestHash: source.hash,
    pageCount: source.pages.length,
    sourceCharacterCount: source.characterCount,
    sourceByteSize: source.byteSize,
  } as const;
  return { ...item, itemManifestHash: hashBatchItemManifest(item) };
}

type TamperedItem = Omit<ReturnType<typeof validItem>, "itemOrdinal" | "fieldOptionSnapshot" | "paperTitleSnapshot" | "fieldDescriptionSnapshot"> & {
  itemOrdinal: number;
  fieldOptionSnapshot: readonly { id: string; label: string; sortOrder: number }[];
  paperTitleSnapshot: string;
  fieldDescriptionSnapshot: string | null;
};

function validBatch(projectId: string, itemManifestHash: string, id = randomUUID()) {
  return {
    id,
    projectId,
    provider: "openai",
    configuredModel: "gpt-test",
    configuredReasoningEffort: "low",
    selectionPolicyVersion: BATCH_SELECTION_POLICY_VERSION,
    batchDisclosureVersion: BATCH_DISCLOSURE_VERSION,
    requestDisclosureVersion: REQUEST_DISCLOSURE_VERSION,
    externalTransmissionAcknowledged: true,
    paperCount: 1,
    fieldCount: 1,
    cellCount: 1,
    executableCount: 1,
    manifestAlgorithmVersion: BATCH_DOMAIN_VERSION,
    manifestSha256: hashBatchManifest({
      manifestAlgorithmVersion: BATCH_DOMAIN_VERSION,
      provider: "openai",
      configuredModel: "gpt-test",
      configuredReasoningEffort: "low",
      selectionPolicyVersion: BATCH_SELECTION_POLICY_VERSION,
      batchDisclosureVersion: BATCH_DISCLOSURE_VERSION,
      requestDisclosureVersion: REQUEST_DISCLOSURE_VERSION,
      externalTransmissionAcknowledged: true,
      paperCount: 1,
      fieldCount: 1,
      cellCount: 1,
      executableCount: 1,
      items: [{ itemOrdinal: 0, itemManifestHash }],
    }),
  } as const;
}

describe("Slice 33 critical appraisal migration boundary", () => {
  it("applies 0031 and exposes the ten appraisal tables", async () => {
    const created = await freshDatabase("slice31_fresh");
    const db = createDb(created.url);
    try {
      await migrate(db.db, { migrationsFolder: migrationFolder });
      const [latest] = await db.client`select id, hash from drizzle.__drizzle_migrations order by id desc limit 1`;
      expect(Number(latest.id)).toBe(32);
      expect(latest.hash).toBe(createHash("sha256").update(fs.readFileSync(path.join(migrationFolder, "0031_critical_appraisal.sql")).subarray()).digest("hex"));
      const tables = await db.client`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('appraisal_frameworks', 'appraisal_framework_versions', 'appraisal_framework_sections', 'appraisal_framework_items', 'appraisal_framework_response_options', 'appraisal_framework_overall_judgement_options', 'appraisals', 'appraisal_revisions', 'appraisal_revision_responses', 'appraisal_revision_response_evidence') order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual([
        "appraisal_framework_items",
        "appraisal_framework_overall_judgement_options",
        "appraisal_framework_response_options",
        "appraisal_framework_sections",
        "appraisal_framework_versions",
        "appraisal_frameworks",
        "appraisal_revision_response_evidence",
        "appraisal_revision_responses",
        "appraisal_revisions",
        "appraisals",
      ]);
    } finally {
      await db.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}"`);
      await created.admin.end();
    }
  }, 120_000);

  it("enforces project ownership, immutable manifests, deferred completeness, and one-way cancellation", async () => {
    const created = await freshDatabase("slice31_invariants");
    const db = createDb(created.url);
    try {
      await migrate(db.db, { migrationsFolder: migrationFolder });
      const projectId = "00000000-0000-4000-8000-000000000001";
      const otherProjectId = "00000000-0000-4000-8000-000000000009";
      const paperId = "00000000-0000-4000-8000-000000000002";
      const fieldId = "00000000-0000-4000-8000-000000000003";
      const documentId = "00000000-0000-4000-8000-000000000004";
      const extractionId = "00000000-0000-4000-8000-000000000005";
      const extractionPageId = "00000000-0000-4000-8000-000000000006";
      const batchId = "00000000-0000-4000-8000-000000000010";
      const itemId = "00000000-0000-4000-8000-000000000011";
      const idempotencyKey = "00000000-0000-4000-8000-000000000007";
      const item = validItem(projectId, paperId, fieldId, idempotencyKey, documentId, extractionId, extractionPageId);
      const batch = validBatch(projectId, item.itemManifestHash, batchId);
      expect(item.itemManifestHash).toBe("9021f87200f95ec3329ac41508823ee9084dd5489b568b277c794da7649da14e");
      expect(batch.manifestSha256).toBe("cf36d5caa58562dbad556cc5d9698c0ed884d3c2d71f6dbd92186f031411b888");

      await db.client`insert into projects (id, title) values (${projectId}::uuid, 'Slice 31 project'), (${otherProjectId}::uuid, 'Other project')`;
      await db.client`insert into papers (id, project_id, title) values (${paperId}::uuid, ${projectId}::uuid, 'Pinned paper')`;
      await db.client`insert into extraction_fields (id, project_id, name, field_type) values (${fieldId}::uuid, ${projectId}::uuid, 'Outcome', 'short_text')`;
      await db.client`insert into full_text_documents (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256) values (${documentId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${`projects/${projectId}/papers/${paperId}/documents/${documentId}/source.pdf`}, 'study.pdf', 'application/pdf', 8, ${"a".repeat(64)})`;
      await db.client.begin(async (tx) => {
        await tx`insert into document_text_extractions (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version, algorithm_version, status, page_count, character_count, started_at, completed_at) values (${extractionId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${documentId}::uuid, 'fixture', '1', '1', 'succeeded', 1, 14, now(), now())`;
        await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count) values (${extractionPageId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${extractionId}::uuid, 1, 'succeeded', 'αβ résumé — 你好', 14)`;
      });

      await db.client.begin(async (tx) => {
        await tx`insert into ai_extraction_batches (id, project_id, provider, configured_model, configured_reasoning_effort, selection_policy_version, batch_disclosure_version, request_disclosure_version, external_transmission_acknowledged, paper_count, field_count, cell_count, executable_count, manifest_algorithm_version, manifest_sha256) values (${batch.id}::uuid, ${batch.projectId}::uuid, ${batch.provider}, ${batch.configuredModel}, ${batch.configuredReasoningEffort}, ${batch.selectionPolicyVersion}, ${batch.batchDisclosureVersion}, ${batch.requestDisclosureVersion}, ${batch.externalTransmissionAcknowledged}, ${batch.paperCount}, ${batch.fieldCount}, ${batch.cellCount}, ${batch.executableCount}, ${batch.manifestAlgorithmVersion}, ${batch.manifestSha256})`;
        await tx`insert into ai_extraction_batch_items (id, project_id, batch_id, item_ordinal, paper_id, extraction_field_id, full_text_document_id, document_text_extraction_id, initial_disposition, initial_reason_code, idempotency_key, field_definition_hash, option_snapshot_hash, paper_title_snapshot, paper_abstract_snapshot, field_name_snapshot, field_description_snapshot, field_type_snapshot, field_required_snapshot, field_option_snapshot, document_filename_snapshot, extraction_sequence_snapshot, extraction_status_snapshot, page_manifest, page_manifest_hash, page_count, source_character_count, source_byte_size, item_manifest_hash) values (${itemId}::uuid, ${projectId}::uuid, ${batchId}::uuid, ${item.itemOrdinal}, ${paperId}::uuid, ${fieldId}::uuid, ${documentId}::uuid, ${extractionId}::uuid, ${item.initialDisposition}, ${item.initialReasonCode}, ${idempotencyKey}::uuid, ${item.fieldDefinitionHash}, ${item.optionSnapshotHash}, ${item.paperTitleSnapshot}, ${item.paperAbstractSnapshot}, ${item.fieldNameSnapshot}, ${item.fieldDescriptionSnapshot}, ${item.fieldTypeSnapshot}, ${item.fieldRequiredSnapshot}, ${JSON.stringify(item.fieldOptionSnapshot)}::jsonb, ${item.documentFilenameSnapshot}, ${item.extractionSequenceSnapshot}, ${item.extractionStatusSnapshot}, ${JSON.stringify(item.pageManifest.pages)}::jsonb, ${item.pageManifestHash}, ${item.pageCount}, ${item.sourceCharacterCount}, ${item.sourceByteSize}, ${item.itemManifestHash})`;
      });

      const sqlHashes = await db.client`select ai_extraction_batch_item_manifest_hash(i) as item_hash, ai_extraction_batch_manifest_hash(b) as batch_hash from ai_extraction_batch_items i join ai_extraction_batches b on b.project_id=i.project_id and b.id=i.batch_id where i.project_id=${projectId}::uuid and i.id=${itemId}::uuid`;
      expect(sqlHashes).toEqual([{ item_hash: item.itemManifestHash, batch_hash: batch.manifestSha256 }]);

      const alternateDocumentId = "00000000-0000-4000-8000-000000000012";
      const alternateExtractionId = "00000000-0000-4000-8000-000000000013";
      const alternatePageId = "00000000-0000-4000-8000-000000000014";
      await db.client`insert into full_text_documents (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256) values (${alternateDocumentId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${`projects/${projectId}/papers/${paperId}/documents/${alternateDocumentId}/source.pdf`}, 'alternate.pdf', 'application/pdf', 8, ${"b".repeat(64)})`;
      await db.client.begin(async (tx) => {
        await tx`insert into document_text_extractions (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version, algorithm_version, status, page_count, character_count, started_at, completed_at) values (${alternateExtractionId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${alternateDocumentId}::uuid, 'fixture', '1', '1', 'succeeded', 1, 14, now(), now())`;
        await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count) values (${alternatePageId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${alternateExtractionId}::uuid, 1, 'succeeded', 'αβ résumé — 你好', 14)`;
      });

      const expectRejectedTamper = async (label: string, tampered: TamperedItem) => {
        const tamperedBatch = validBatch(projectId, item.itemManifestHash);
        const tamperedItemId = randomUUID();
        await expect(db.client.begin(async (tx) => {
          await tx`insert into ai_extraction_batches (id, project_id, provider, configured_model, configured_reasoning_effort, selection_policy_version, batch_disclosure_version, request_disclosure_version, external_transmission_acknowledged, paper_count, field_count, cell_count, executable_count, manifest_algorithm_version, manifest_sha256) values (${tamperedBatch.id}::uuid, ${tamperedBatch.projectId}::uuid, ${tamperedBatch.provider}, ${tamperedBatch.configuredModel}, ${tamperedBatch.configuredReasoningEffort}, ${tamperedBatch.selectionPolicyVersion}, ${tamperedBatch.batchDisclosureVersion}, ${tamperedBatch.requestDisclosureVersion}, ${tamperedBatch.externalTransmissionAcknowledged}, ${tamperedBatch.paperCount}, ${tamperedBatch.fieldCount}, ${tamperedBatch.cellCount}, ${tamperedBatch.executableCount}, ${tamperedBatch.manifestAlgorithmVersion}, ${tamperedBatch.manifestSha256})`;
          await tx`insert into ai_extraction_batch_items (id, project_id, batch_id, item_ordinal, paper_id, extraction_field_id, full_text_document_id, document_text_extraction_id, initial_disposition, initial_reason_code, idempotency_key, field_definition_hash, option_snapshot_hash, paper_title_snapshot, paper_abstract_snapshot, field_name_snapshot, field_description_snapshot, field_type_snapshot, field_required_snapshot, field_option_snapshot, document_filename_snapshot, extraction_sequence_snapshot, extraction_status_snapshot, page_manifest, page_manifest_hash, page_count, source_character_count, source_byte_size, item_manifest_hash) values (${tamperedItemId}::uuid, ${projectId}::uuid, ${tamperedBatch.id}::uuid, ${tampered.itemOrdinal}, ${tampered.paperId}::uuid, ${tampered.extractionFieldId}::uuid, ${tampered.fullTextDocumentId}::uuid, ${tampered.documentTextExtractionId}::uuid, ${tampered.initialDisposition}, ${tampered.initialReasonCode}, ${tampered.idempotencyKey}::uuid, ${tampered.fieldDefinitionHash}, ${tampered.optionSnapshotHash}, ${tampered.paperTitleSnapshot}, ${tampered.paperAbstractSnapshot}, ${tampered.fieldNameSnapshot}, ${tampered.fieldDescriptionSnapshot}, ${tampered.fieldTypeSnapshot}, ${tampered.fieldRequiredSnapshot}, ${JSON.stringify(tampered.fieldOptionSnapshot)}::jsonb, ${tampered.documentFilenameSnapshot}, ${tampered.extractionSequenceSnapshot}, ${tampered.extractionStatusSnapshot}, ${JSON.stringify(tampered.pageManifest.pages)}::jsonb, ${tampered.pageManifestHash}, ${tampered.pageCount}, ${tampered.sourceCharacterCount}, ${tampered.sourceByteSize}, ${tampered.itemManifestHash})`;
        }), label).rejects.toThrow();
      };

      await expectRejectedTamper("field description tamper", { ...item, fieldDescriptionSnapshot: "tampered description" });
      await expectRejectedTamper("option snapshot tamper", { ...item, fieldOptionSnapshot: [{ id: randomUUID(), label: "Option", sortOrder: 0 }] });
      await expectRejectedTamper("page manifest tamper", { ...item, pageManifest: { ...item.pageManifest, pages: [{ ...item.pageManifest.pages[0], textSha256: "f".repeat(64) }] } });
      await expectRejectedTamper("Paper title snapshot tamper", { ...item, paperTitleSnapshot: "Tampered paper" });
      await expectRejectedTamper("source identity tamper", { ...item, fullTextDocumentId: alternateDocumentId, documentTextExtractionId: alternateExtractionId });
      await expectRejectedTamper("extraction ordinal tamper", { ...item, itemOrdinal: 1 });

      await expect(db.client`update ai_extraction_batches set configured_model = 'changed' where project_id = ${projectId}::uuid and id = ${batchId}::uuid`).rejects.toThrow(/immutable/i);
      await expect(db.client`update ai_extraction_batch_items set field_name_snapshot = 'changed' where project_id = ${projectId}::uuid and id = ${itemId}::uuid`).rejects.toThrow(/immutable/i);
      await expect(db.client`insert into ai_extraction_batch_items (project_id, batch_id, item_ordinal, paper_id, extraction_field_id, initial_disposition, initial_reason_code, idempotency_key, field_definition_hash, option_snapshot_hash, paper_title_snapshot, field_name_snapshot, field_type_snapshot, field_required_snapshot, field_option_snapshot, page_manifest, page_manifest_hash, page_count, source_character_count, source_byte_size, item_manifest_hash) values (${otherProjectId}::uuid, ${batchId}::uuid, 1, ${paperId}::uuid, ${fieldId}::uuid, 'ineligible', 'paper_not_finally_included', ${randomUUID()}::uuid, ${item.fieldDefinitionHash}, ${item.optionSnapshotHash}, 'Pinned paper', 'Outcome', 'short_text', false, '[]'::jsonb, '[]'::jsonb, ${item.pageManifestHash}, 0, 0, 0, ${item.itemManifestHash})`).rejects.toThrow();

      await db.client`update ai_extraction_batches set cancelled_at = now() where project_id = ${projectId}::uuid and id = ${batchId}::uuid`;
      await expect(db.client`update ai_extraction_batches set cancelled_at = null where project_id = ${projectId}::uuid and id = ${batchId}::uuid`).rejects.toThrow(/cancellation|immutable/i);

      const incompleteBatchId = randomUUID();
      const incomplete = validBatch(projectId, item.itemManifestHash, incompleteBatchId);
      await expect(db.client`insert into ai_extraction_batches (id, project_id, provider, configured_model, configured_reasoning_effort, selection_policy_version, batch_disclosure_version, request_disclosure_version, external_transmission_acknowledged, paper_count, field_count, cell_count, executable_count, manifest_algorithm_version, manifest_sha256) values (${incomplete.id}::uuid, ${projectId}::uuid, ${incomplete.provider}, ${incomplete.configuredModel}, ${incomplete.configuredReasoningEffort}, ${incomplete.selectionPolicyVersion}, ${incomplete.batchDisclosureVersion}, ${incomplete.requestDisclosureVersion}, true, 1, 1, 1, 0, ${incomplete.manifestAlgorithmVersion}, ${incomplete.manifestSha256})`).rejects.toThrow(/counts|manifest|items|ordinal/i);
    } finally {
      await db.client.end();
      await created.admin.unsafe(`drop database if exists "${created.name}"`);
      await created.admin.end();
    }
  }, 120_000);
});
