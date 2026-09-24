import {
  integer,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  foreignKey,
  primaryKey,
  check,
  bigint,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./shared";
import { projects, papers } from "./foundation";

export const fullTextDocuments = pgTable(
  "full_text_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("full_text_documents_project_id_id_unique").on(table.projectId, table.id),
    projectPaperIdentity: unique("full_text_documents_project_paper_id_id_unique").on(table.projectId, table.paperId, table.id),
    storageKeyUnique: unique("full_text_documents_storage_key_unique").on(table.storageKey),
    activeContentUnique: uniqueIndex("full_text_documents_active_content_unique")
      .on(table.projectId, table.paperId, table.sha256)
      .where(sql`${table.archivedAt} is null`),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "full_text_documents_project_paper_fk",
    }).onDelete("restrict"),
    storageKeyNonblank: check("full_text_documents_storage_key_nonblank", sql`btrim(${table.storageKey}) <> ''`),
    storageKeyFormat: check("full_text_documents_storage_key_format", sql`${table.storageKey} ~ '^projects/[0-9a-f-]{36}/papers/[0-9a-f-]{36}/documents/[0-9a-f-]{36}/source\\.pdf$'`),
    filenameNonblank: check("full_text_documents_filename_nonblank", sql`btrim(${table.originalFilename}) <> ''`),
    mediaTypePdf: check("full_text_documents_media_type_pdf", sql`${table.mediaType} = 'application/pdf'`),
    byteSizePositive: check("full_text_documents_byte_size_positive", sql`${table.byteSize} > 0`),
    sha256Format: check("full_text_documents_sha256_format", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const paperFullTextPreferences = pgTable(
  "paper_full_text_preferences",
  {
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    fullTextDocumentId: uuid("full_text_document_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.paperId] }),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "paper_full_text_preferences_project_paper_fk",
    }).onDelete("restrict"),
    documentOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.fullTextDocumentId],
      foreignColumns: [fullTextDocuments.projectId, fullTextDocuments.paperId, fullTextDocuments.id],
      name: "paper_full_text_preferences_document_fk",
    }).onDelete("restrict"),
  }),
);

export const documentTextExtractions = pgTable(
  "document_text_extractions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    fullTextDocumentId: uuid("full_text_document_id").notNull(),
    extractorKey: text("extractor_key").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    status: text("status").notNull(),
    pageCount: integer("page_count"),
    characterCount: integer("character_count"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("document_text_extractions_project_id_id_unique").on(table.projectId, table.id),
    projectPaperIdentity: unique("document_text_extractions_project_paper_id_id_unique").on(table.projectId, table.paperId, table.id),
    projectDocumentSequence: index("document_text_extractions_project_document_sequence_idx").on(table.projectId, table.fullTextDocumentId, table.sequence),
    projectPaperSequence: index("document_text_extractions_project_paper_sequence_idx").on(table.projectId, table.paperId, table.sequence),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "document_text_extractions_project_id_projects_id_fk",
    }).onDelete("restrict"),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "document_text_extractions_project_paper_fk",
    }).onDelete("restrict"),
    documentOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.fullTextDocumentId],
      foreignColumns: [fullTextDocuments.projectId, fullTextDocuments.paperId, fullTextDocuments.id],
      name: "document_text_extractions_project_paper_document_fk",
    }).onDelete("restrict"),
    extractorKeyNonblank: check("document_text_extractions_extractor_key_nonblank", sql`btrim(${table.extractorKey}) <> ''`),
    extractorVersionNonblank: check("document_text_extractions_extractor_version_nonblank", sql`btrim(${table.extractorVersion}) <> ''`),
    algorithmVersionNonblank: check("document_text_extractions_algorithm_version_nonblank", sql`btrim(${table.algorithmVersion}) <> ''`),
    statusValid: check("document_text_extractions_status_valid", sql`${table.status} in ('succeeded', 'partial', 'failed')`),
    pageCountShape: check("document_text_extractions_page_count_shape", sql`(
      (${table.status} in ('succeeded', 'partial') and ${table.pageCount} is not null and ${table.pageCount} > 0 and ${table.pageCount} <= 2000)
      or (${table.status} = 'failed' and (${table.pageCount} is null or (${table.pageCount} > 0 and ${table.pageCount} <= 2000)))
    )`),
    characterCountShape: check("document_text_extractions_character_count_shape", sql`(
      (${table.status} in ('succeeded', 'partial') and ${table.characterCount} is not null and ${table.characterCount} >= 0 and ${table.characterCount} <= 10000000)
      or (${table.status} = 'failed' and ${table.characterCount} is null)
    )`),
    errorCodeNonblank: check("document_text_extractions_error_code_nonblank", sql`${table.errorCode} is null or btrim(${table.errorCode}) <> ''`),
    errorMessageLimit: check("document_text_extractions_error_message_limit", sql`${table.errorMessage} is null or char_length(${table.errorMessage}) <= 1000`),
    timesOrdered: check("document_text_extractions_times_ordered", sql`${table.completedAt} is null or ${table.startedAt} is null or ${table.completedAt} >= ${table.startedAt}`),
  }),
);

export const documentTextExtractionPages = pgTable(
  "document_text_extraction_pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    documentTextExtractionId: uuid("document_text_extraction_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    status: text("status").notNull(),
    text: text("text").notNull(),
    characterCount: integer("character_count").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("document_text_extraction_pages_project_id_id_unique").on(table.projectId, table.id),
    extractionPageIdentity: unique("document_text_extraction_pages_project_paper_extraction_page_unique").on(table.projectId, table.paperId, table.documentTextExtractionId, table.pageNumber),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "document_text_extraction_pages_project_id_projects_id_fk",
    }).onDelete("restrict"),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "document_text_extraction_pages_project_paper_fk",
    }).onDelete("restrict"),
    extractionOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.documentTextExtractionId],
      foreignColumns: [documentTextExtractions.projectId, documentTextExtractions.paperId, documentTextExtractions.id],
      name: "document_text_extraction_pages_project_paper_extraction_fk",
    }).onDelete("restrict"),
    pagePositive: check("document_text_extraction_pages_page_positive", sql`${table.pageNumber} > 0 and ${table.pageNumber} <= 2000`),
    statusValid: check("document_text_extraction_pages_status_valid", sql`${table.status} in ('succeeded', 'failed')`),
    textNormalized: check("document_text_extraction_pages_text_normalized", sql`${table.text} !~ E'\\r'`),
    characterCountShape: check("document_text_extraction_pages_character_count_shape", sql`${table.characterCount} = char_length(${table.text}) and ${table.characterCount} >= 0 and ${table.characterCount} <= 500000`),
    failedPlaceholderShape: check("document_text_extraction_pages_failed_placeholder_shape", sql`(
      (${table.status} = 'succeeded' and ${table.errorCode} is null and ${table.errorMessage} is null)
      or (${table.status} = 'failed' and ${table.text} = '' and ${table.characterCount} = 0 and ${table.errorCode} is not null and btrim(${table.errorCode}) <> '')
    )`),
    errorMessageLimit: check("document_text_extraction_pages_error_message_limit", sql`${table.errorMessage} is null or char_length(${table.errorMessage}) <= 1000`),
  }),
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    fullTextDocumentId: uuid("full_text_document_id"),
    documentTextExtractionId: uuid("document_text_extraction_id"),
    extractionStartOffset: integer("extraction_start_offset"),
    extractionEndOffset: integer("extraction_end_offset"),
    sourceText: text("source_text").notNull(),
    pageNumber: integer("page_number").notNull(),
    note: text("note"),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("evidence_project_id_id_unique").on(table.projectId, table.id),
    projectPaperIdentity: unique("evidence_project_paper_id_unique").on(table.projectId, table.paperId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "evidence_project_paper_fk",
    }).onDelete("restrict"),
    documentOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.fullTextDocumentId],
      foreignColumns: [fullTextDocuments.projectId, fullTextDocuments.paperId, fullTextDocuments.id],
      name: "evidence_project_paper_document_fk",
    }).onDelete("restrict"),
    extractionOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.documentTextExtractionId],
      foreignColumns: [documentTextExtractions.projectId, documentTextExtractions.paperId, documentTextExtractions.id],
      name: "evidence_project_paper_extraction_fk",
    }).onDelete("restrict"),
    extractionPageOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.documentTextExtractionId, table.pageNumber],
      foreignColumns: [documentTextExtractionPages.projectId, documentTextExtractionPages.paperId, documentTextExtractionPages.documentTextExtractionId, documentTextExtractionPages.pageNumber],
      name: "evidence_project_paper_extraction_page_fk",
    }).onDelete("restrict"),
    projectPaperCreatedAt: index("evidence_project_paper_created_at_idx").on(
      table.projectId,
      table.paperId,
      table.createdAt,
    ),
    sourceTextNonblank: check("evidence_source_text_nonblank", sql`btrim(${table.sourceText}) <> ''`),
    pagePositive: check("evidence_page_positive", sql`${table.pageNumber} > 0`),
    extractionOffsetShape: check("evidence_extraction_offset_nonnegative", sql`(
      (${table.extractionStartOffset} is null and ${table.extractionEndOffset} is null)
      or (${table.extractionStartOffset} is not null and ${table.extractionEndOffset} is not null and ${table.extractionStartOffset} >= 0 and ${table.extractionEndOffset} > ${table.extractionStartOffset})
    )`),
  }),
);

export const evidenceReviewDecisions = pgTable(
  "evidence_review_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    decision: text("decision").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("evidence_review_decisions_project_id_id_unique").on(table.projectId, table.id),
    evidenceIdentity: unique("evidence_review_decisions_project_evidence_id_id_unique").on(table.projectId, table.evidenceId, table.id),
    evidenceSequence: index("evidence_review_decisions_project_evidence_sequence_idx").on(table.projectId, table.evidenceId, table.sequence),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "evidence_review_decisions_project_evidence_fk",
    }).onDelete("restrict"),
    decisionValid: check("evidence_review_decisions_decision_valid", sql`${table.decision} in ('needs_review', 'accepted', 'rejected')`),
    noteShape: check("evidence_review_decisions_note_shape", sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`),
  }),
);

export const evidenceAnnotations = pgTable(
  "evidence_annotations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("evidence_annotations_project_id_id_unique").on(table.projectId, table.id),
    evidenceSequence: index("evidence_annotations_project_evidence_sequence_idx").on(table.projectId, table.evidenceId, table.sequence),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "evidence_annotations_project_evidence_fk",
    }).onDelete("restrict"),
    bodyShape: check("evidence_annotations_body_shape", sql`btrim(${table.body}) <> '' and char_length(${table.body}) <= 10000`),
  }),
);

export const evidenceLabels = pgTable(
  "evidence_labels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("evidence_labels_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("evidence_labels_project_created_at_idx").on(table.projectId, table.createdAt),
    activeNameUnique: uniqueIndex("evidence_labels_active_name_unique")
      .on(table.projectId, sql`lower(btrim(${table.name}))`)
      .where(sql`${table.archivedAt} is null`),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "evidence_labels_project_id_projects_id_fk",
    }).onDelete("restrict"),
    nameShape: check("evidence_labels_name_shape", sql`btrim(${table.name}) <> '' and char_length(${table.name}) <= 100`),
    descriptionShape: check("evidence_labels_description_shape", sql`${table.description} is null or char_length(${table.description}) <= 500`),
  }),
);

export const evidenceLabelEvents = pgTable(
  "evidence_label_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    labelId: uuid("label_id").notNull(),
    event: text("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("evidence_label_events_project_id_id_unique").on(table.projectId, table.id),
    pairSequence: index("evidence_label_events_project_pair_sequence_idx").on(table.projectId, table.evidenceId, table.labelId, table.sequence),
    evidenceLookup: index("evidence_label_events_project_evidence_idx").on(table.projectId, table.evidenceId),
    labelLookup: index("evidence_label_events_project_label_idx").on(table.projectId, table.labelId),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "evidence_label_events_project_evidence_fk",
    }).onDelete("restrict"),
    labelOwnership: foreignKey({
      columns: [table.projectId, table.labelId],
      foreignColumns: [evidenceLabels.projectId, evidenceLabels.id],
      name: "evidence_label_events_project_label_fk",
    }).onDelete("restrict"),
    eventValid: check("evidence_label_events_event_valid", sql`${table.event} in ('assigned', 'removed')`),
  }),
);
