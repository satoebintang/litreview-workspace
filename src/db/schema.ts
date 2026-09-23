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
  boolean,
  numeric,
  customType,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  ...timestamps,
}, (table) => ({
  titleNonblank: check("projects_title_nonblank", sql`btrim(${table.title}) <> ''`),
}));

export const papers = pgTable(
  "papers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    authors: text("authors").array().notNull().default([]),
    publicationYear: integer("publication_year"),
    venue: text("venue"),
    doi: text("doi"),
    abstract: text("abstract"),
    bibliographicNote: text("bibliographic_note"),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("papers_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("papers_project_created_at_idx").on(table.projectId, table.createdAt),
    doiComparison: index("papers_project_doi_comparison_idx")
      .using("btree", table.projectId, sql`lower(regexp_replace(regexp_replace(btrim(${table.doi}), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))`)
      .where(sql`${table.doi} is not null and btrim(${table.doi}) <> ''`),
    titleComparison: index("papers_project_title_comparison_idx")
      .using("btree", table.projectId, sql`lower(regexp_replace(btrim(${table.title}), '[[:space:]]+', ' ', 'g'))`, table.publicationYear)
      .where(sql`${table.title} is not null and btrim(${table.title}) <> ''`),
    titleNonblank: check("papers_title_nonblank", sql`btrim(${table.title}) <> ''`),
  }),
);

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

export const evidenceSets = pgTable(
  "evidence_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ...timestamps,
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("evidence_sets_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("evidence_sets_project_created_at_idx").on(table.projectId, table.createdAt),
    activeNameUnique: uniqueIndex("evidence_sets_active_name_unique")
      .on(table.projectId, sql`lower(btrim(${table.name}))`)
      .where(sql`${table.archivedAt} is null`),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "evidence_sets_project_id_projects_id_fk",
    }).onDelete("restrict"),
    nameShape: check("evidence_sets_name_shape", sql`btrim(${table.name}) <> '' and char_length(${table.name}) <= 100`),
    descriptionShape: check("evidence_sets_description_shape", sql`${table.description} is null or char_length(${table.description}) <= 500`),
  }),
);

export const evidenceSetMemberships = pgTable(
  "evidence_set_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("evidence_set_memberships_project_id_id_unique").on(table.projectId, table.id),
    setMembershipIdentity: unique("evidence_set_memberships_project_set_id_id_unique").on(table.projectId, table.evidenceSetId, table.id),
    pairIdentity: unique("evidence_set_memberships_project_set_evidence_unique").on(table.projectId, table.evidenceSetId, table.evidenceId),
    setOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "evidence_set_memberships_project_set_fk",
    }).onDelete("restrict"),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "evidence_set_memberships_project_evidence_fk",
    }).onDelete("restrict"),
    setLookup: index("evidence_set_memberships_project_set_idx").on(table.projectId, table.evidenceSetId),
    evidenceLookup: index("evidence_set_memberships_project_evidence_idx").on(table.projectId, table.evidenceId),
  }),
);

export const evidenceSetCompositionRevisions = pgTable(
  "evidence_set_composition_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("evidence_set_composition_revisions_project_id_id_unique").on(table.projectId, table.id),
    setRevisionIdentity: unique("evidence_set_composition_revisions_project_set_id_id_unique").on(table.projectId, table.evidenceSetId, table.id),
    setSequence: index("evidence_set_composition_revisions_project_set_sequence_idx").on(table.projectId, table.evidenceSetId, table.sequence),
    setOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "evidence_set_composition_revisions_project_set_fk",
    }).onDelete("restrict"),
    operationKindValid: check("evidence_set_composition_revisions_operation_kind_valid", sql`${table.operationKind} in ('created', 'added', 'readded', 'removed', 'reordered')`),
  }),
);

export const evidenceSetCompositionMembers = pgTable(
  "evidence_set_composition_members",
  {
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    compositionRevisionId: uuid("composition_revision_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.compositionRevisionId, table.membershipId] }),
    revisionOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.compositionRevisionId],
      foreignColumns: [evidenceSetCompositionRevisions.projectId, evidenceSetCompositionRevisions.evidenceSetId, evidenceSetCompositionRevisions.id],
      name: "evidence_set_composition_members_project_set_revision_fk",
    }).onDelete("restrict"),
    membershipOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.membershipId],
      foreignColumns: [evidenceSetMemberships.projectId, evidenceSetMemberships.evidenceSetId, evidenceSetMemberships.id],
      name: "evidence_set_composition_members_project_set_membership_fk",
    }).onDelete("restrict"),
    revisionLookup: index("evidence_set_composition_members_project_revision_idx").on(table.projectId, table.compositionRevisionId, table.sortOrder),
    membershipLookup: index("evidence_set_composition_members_project_membership_idx").on(table.projectId, table.membershipId),
    sortOrderUnique: unique("evidence_set_composition_members_project_revision_sort_unique").on(table.projectId, table.compositionRevisionId, table.sortOrder),
    sortOrderPositive: check("evidence_set_composition_members_sort_order_positive", sql`${table.sortOrder} > 0`),
  }),
);

export const evidenceSetAnnotations = pgTable(
  "evidence_set_annotations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("evidence_set_annotations_project_id_id_unique").on(table.projectId, table.id),
    setSequence: index("evidence_set_annotations_project_set_sequence_idx").on(table.projectId, table.evidenceSetId, table.sequence),
    setOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "evidence_set_annotations_project_set_fk",
    }).onDelete("restrict"),
    bodyShape: check("evidence_set_annotations_body_shape", sql`btrim(${table.body}) <> '' and char_length(${table.body}) <= 10000`),
  }),
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("claims_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("claims_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const claimRevisions = pgTable(
  "claim_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    state: text("state").notNull().default("active"),
    claimText: text("claim_text"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("claim_revisions_project_id_id_unique").on(table.projectId, table.id),
    claimIdentity: unique("claim_revisions_project_claim_id_id_unique").on(table.projectId, table.claimId, table.id),
    claimSequence: index("claim_revisions_project_claim_sequence_idx").on(table.projectId, table.claimId, table.sequence),
    projectSequence: index("claim_revisions_project_sequence_idx").on(table.projectId, table.sequence),
    claimOwnership: foreignKey({
      columns: [table.projectId, table.claimId],
      foreignColumns: [claims.projectId, claims.id],
      name: "claim_revisions_project_claim_fk",
    }).onDelete("restrict"),
    stateValid: check("claim_revisions_state_valid", sql`${table.state} in ('active', 'withdrawn')`),
    claimTextShape: check("claim_revisions_claim_text_shape", sql`(
      (${table.state} = 'active' and ${table.claimText} is not null and btrim(${table.claimText}) <> '')
      or (${table.state} = 'withdrawn' and ${table.claimText} is null)
    )`),
    noteNonblank: check("claim_revisions_note_nonblank", sql`${table.researcherNote} is null or btrim(${table.researcherNote}) <> ''`),
  }),
);

export const claimRevisionEvidenceSupports = pgTable(
  "claim_revision_evidence_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.evidenceId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_evidence_supports_project_revision_fk",
    }).onDelete("restrict"),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.id],
      name: "claim_revision_evidence_supports_project_evidence_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_evidence_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    evidenceLookup: index("claim_revision_evidence_supports_project_evidence_idx").on(table.projectId, table.evidenceId),
  }),
);

export const screeningCriteria = pgTable(
  "screening_criteria",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    text: text("text").notNull(),
    sortOrder: bigint("sort_order", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("screening_criteria_project_id_id_unique").on(table.projectId, table.id),
    projectTypedIdentity: unique("screening_criteria_project_id_id_type_unique").on(table.projectId, table.id, table.type),
    projectOrder: index("screening_criteria_project_order_idx").on(table.projectId, table.sortOrder),
    typeValid: check("screening_criteria_type_valid", sql`${table.type} in ('inclusion', 'exclusion')`),
    textNonblank: check("screening_criteria_text_nonblank", sql`btrim(${table.text}) <> ''`),
  }),
);

export const screeningDecisions = pgTable(
  "screening_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    stage: text("stage").notNull().default("title_abstract"),
    decision: text("decision").notNull(),
    exclusionCriterionId: uuid("exclusion_criterion_id"),
    exclusionCriterionType: text("exclusion_criterion_type"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("screening_decisions_project_id_id_unique").on(table.projectId, table.id),
    paperIdentity: unique("screening_decisions_project_paper_id_id_unique").on(table.projectId, table.paperId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "screening_decisions_project_paper_fk",
    }).onDelete("restrict"),
    criterionOwnership: foreignKey({
      columns: [table.projectId, table.exclusionCriterionId, table.exclusionCriterionType],
      foreignColumns: [screeningCriteria.projectId, screeningCriteria.id, screeningCriteria.type],
      name: "screening_decisions_project_criterion_fk",
    }).onDelete("restrict"),
    paperSequence: index("screening_decisions_project_paper_sequence_idx").on(table.projectId, table.paperId, table.sequence),
    projectStageSequence: index("screening_decisions_project_stage_sequence_idx").on(table.projectId, table.stage, table.sequence),
    stageValid: check("screening_decisions_stage_valid", sql`${table.stage} = 'title_abstract'`),
    decisionValid: check("screening_decisions_decision_valid", sql`${table.decision} in ('include', 'exclude', 'maybe')`),
    exclusionShape: check("screening_decisions_exclusion_shape", sql`(
      (${table.decision} = 'exclude' and ${table.exclusionCriterionId} is not null and ${table.exclusionCriterionType} = 'exclusion')
      or (${table.decision} in ('include', 'maybe') and ${table.exclusionCriterionId} is null and ${table.exclusionCriterionType} is null)
    )`),
    noteNonblank: check("screening_decisions_note_nonblank", sql`${table.note} is null or btrim(${table.note}) <> ''`),
  }),
);

export const fullTextScreeningCriteria = pgTable(
  "full_text_screening_criteria",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    text: text("text").notNull(),
    sortOrder: bigint("sort_order", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("full_text_screening_criteria_project_id_id_unique").on(table.projectId, table.id),
    projectOrder: index("full_text_screening_criteria_project_order_idx").on(table.projectId, table.sortOrder),
    textNonblank: check("full_text_screening_criteria_text_nonblank", sql`btrim(${table.text}) <> ''`),
  }),
);

export const fullTextScreeningDecisions = pgTable(
  "full_text_screening_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    decision: text("decision").notNull(),
    exclusionCriterionId: uuid("exclusion_criterion_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("full_text_screening_decisions_project_id_id_unique").on(table.projectId, table.id),
    paperIdentity: unique("full_text_screening_decisions_project_paper_id_id_unique").on(table.projectId, table.paperId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "full_text_screening_decisions_project_paper_fk",
    }).onDelete("restrict"),
    criterionOwnership: foreignKey({
      columns: [table.projectId, table.exclusionCriterionId],
      foreignColumns: [fullTextScreeningCriteria.projectId, fullTextScreeningCriteria.id],
      name: "full_text_screening_decisions_project_criterion_fk",
    }).onDelete("restrict"),
    paperSequence: index("full_text_screening_decisions_project_paper_sequence_idx").on(table.projectId, table.paperId, table.sequence),
    decisionValid: check("full_text_screening_decisions_decision_valid", sql`${table.decision} in ('include', 'exclude', 'maybe')`),
    exclusionShape: check("full_text_screening_decisions_exclusion_shape", sql`(
      (${table.decision} = 'exclude' and ${table.exclusionCriterionId} is not null)
      or (${table.decision} in ('include', 'maybe') and ${table.exclusionCriterionId} is null)
    )`),
    noteNonblank: check("full_text_screening_decisions_note_nonblank", sql`${table.note} is null or btrim(${table.note}) <> ''`),
  }),
);

export const fullTextRetrievalAttempts = pgTable(
  "full_text_retrieval_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    paperId: uuid("paper_id").notNull(),
    outcome: text("outcome").notNull(),
    method: text("method"),
    sourceReference: text("source_reference"),
    note: text("note"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("full_text_retrieval_attempts_project_id_id_unique").on(table.projectId, table.id),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "full_text_retrieval_attempts_project_paper_fk",
    }).onDelete("restrict"),
    paperSequence: index("full_text_retrieval_attempts_project_paper_sequence_idx").on(table.projectId, table.paperId, table.sequence),
    outcomeValid: check("full_text_retrieval_attempts_outcome_valid", sql`${table.outcome} in ('pending', 'unavailable', 'retrieved')`),
    methodValid: check("full_text_retrieval_attempts_method_valid", sql`${table.method} is null or ${table.method} in ('publisher', 'bibliographic_database', 'institutional_access', 'library', 'interlibrary_loan', 'author_contact', 'web', 'manual', 'other')`),
    sourceReferenceNonblank: check("full_text_retrieval_attempts_source_reference_nonblank", sql`${table.sourceReference} is null or btrim(${table.sourceReference}) <> ''`),
    noteNonblank: check("full_text_retrieval_attempts_note_nonblank", sql`${table.note} is null or btrim(${table.note}) <> ''`),
  }),
);

export const extractionFields = pgTable(
  "extraction_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    fieldType: text("field_type").notNull(),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("extraction_fields_project_id_id_unique").on(table.projectId, table.id),
    projectOrder: index("extraction_fields_project_order_idx").on(table.projectId, table.sortOrder, table.id),
    typeValid: check("extraction_fields_type_valid", sql`${table.fieldType} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    nameNonblank: check("extraction_fields_name_nonblank", sql`btrim(${table.name}) <> ''`),
    descriptionNonblank: check("extraction_fields_description_nonblank", sql`${table.description} is null or btrim(${table.description}) <> ''`),
    sortPositive: check("extraction_fields_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const extractionOptions = pgTable(
  "extraction_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("extraction_options_project_id_id_unique").on(table.projectId, table.id),
    fieldIdentity: unique("extraction_options_project_field_id_unique").on(table.projectId, table.fieldId, table.id),
    fieldOwnership: foreignKey({
      columns: [table.projectId, table.fieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "extraction_options_project_field_fk",
    }).onDelete("restrict"),
    fieldOrder: index("extraction_options_field_order_idx").on(table.projectId, table.fieldId, table.sortOrder, table.id),
    labelNonblank: check("extraction_options_label_nonblank", sql`btrim(${table.label}) <> ''`),
    sortPositive: check("extraction_options_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const extractionValues = pgTable(
  "extraction_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("extraction_values_project_id_id_unique").on(table.projectId, table.id),
    slotUnique: unique("extraction_values_project_paper_field_unique").on(table.projectId, table.paperId, table.fieldId),
    projectPaperIdentity: unique("extraction_values_project_paper_id_unique").on(table.projectId, table.paperId, table.id),
    projectPaperFieldIdentity: unique("extraction_values_project_paper_field_id_unique").on(table.projectId, table.paperId, table.id, table.fieldId),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "extraction_values_project_paper_fk",
    }).onDelete("restrict"),
    fieldOwnership: foreignKey({
      columns: [table.projectId, table.fieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "extraction_values_project_field_fk",
    }).onDelete("restrict"),
    paperFieldLookup: index("extraction_values_project_paper_field_idx").on(table.projectId, table.paperId, table.fieldId),
  }),
);

export const extractionValueRevisions = pgTable(
  "extraction_value_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    extractionValueId: uuid("extraction_value_id").notNull(),
    fieldType: text("field_type").notNull(),
    valueState: text("value_state").notNull(),
    textValue: text("text_value"),
    numberValue: numeric("number_value", { precision: 30, scale: 10 }),
    booleanValue: boolean("boolean_value"),
    optionId: uuid("option_id"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("extraction_value_revisions_project_id_id_unique").on(table.projectId, table.id),
    projectPaperIdentity: unique("extraction_value_revisions_project_paper_id_unique").on(table.projectId, table.paperId, table.id),
    valueIdentity: unique("extraction_value_revisions_project_value_id_unique").on(table.projectId, table.extractionValueId, table.id),
    valuePaperIdentity: unique("extraction_value_revisions_project_paper_value_id_unique").on(table.projectId, table.paperId, table.extractionValueId, table.id),
    valueOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.extractionValueId, table.fieldId],
      foreignColumns: [extractionValues.projectId, extractionValues.paperId, extractionValues.id, extractionValues.fieldId],
      name: "extraction_value_revisions_value_fk",
    }).onDelete("restrict"),
    fieldOwnership: foreignKey({
      columns: [table.projectId, table.fieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "extraction_value_revisions_field_fk",
    }).onDelete("restrict"),
    optionOwnership: foreignKey({
      columns: [table.projectId, table.fieldId, table.optionId],
      foreignColumns: [extractionOptions.projectId, extractionOptions.fieldId, extractionOptions.id],
      name: "extraction_value_revisions_option_fk",
    }).onDelete("restrict"),
    valueLookup: index("extraction_value_revisions_current_idx").on(table.projectId, table.paperId, table.fieldId, table.sequence),
    stateValid: check("extraction_value_revisions_state_valid", sql`${table.valueState} in ('present', 'not_reported', 'not_applicable', 'cleared')`),
    typeValid: check("extraction_value_revisions_type_valid", sql`${table.fieldType} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    valueShape: check("extraction_value_revisions_value_shape", sql`(
      (${table.valueState} <> 'present' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
      or (${table.valueState} = 'present' and (
        (${table.fieldType} in ('short_text', 'long_text') and ${table.textValue} is not null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
        or (${table.fieldType} = 'number' and ${table.textValue} is null and ${table.numberValue} is not null and ${table.booleanValue} is null and ${table.optionId} is null)
        or (${table.fieldType} = 'boolean' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is not null and ${table.optionId} is null)
        or (${table.fieldType} = 'single_select' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is not null)
      ))
    )`),
    noteNonblank: check("extraction_value_revisions_note_nonblank", sql`${table.researcherNote} is null or btrim(${table.researcherNote}) <> ''`),
  }),
);

export const extractionRevisionEvidence = pgTable(
  "extraction_revision_evidence",
  {
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.revisionId, table.evidenceId] }),
    revisionOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.revisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.paperId, extractionValueRevisions.id],
      name: "extraction_revision_evidence_revision_fk",
    }).onDelete("restrict"),
    evidenceOwnership: foreignKey({
      columns: [table.projectId, table.paperId, table.evidenceId],
      foreignColumns: [evidence.projectId, evidence.paperId, evidence.id],
      name: "extraction_revision_evidence_evidence_fk",
    }).onDelete("restrict"),
    revisionLookup: index("extraction_revision_evidence_revision_idx").on(table.projectId, table.revisionId),
    evidenceLookup: index("extraction_revision_evidence_evidence_idx").on(table.projectId, table.paperId, table.evidenceId),
  }),
);

export const synthesisStatements = pgTable(
  "synthesis_statements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("synthesis_statements_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("synthesis_statements_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const synthesisRevisions = pgTable(
  "synthesis_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    synthesisStatementId: uuid("synthesis_statement_id").notNull(),
    state: text("state").notNull().default("active"),
    title: text("title"),
    statementText: text("statement_text"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("synthesis_revisions_project_id_id_unique").on(table.projectId, table.id),
    statementIdentity: unique("synthesis_revisions_project_statement_id_id_unique").on(table.projectId, table.synthesisStatementId, table.id),
    statementSequence: index("synthesis_revisions_project_statement_sequence_idx").on(table.projectId, table.synthesisStatementId, table.sequence),
    projectSequence: index("synthesis_revisions_project_sequence_idx").on(table.projectId, table.sequence),
    statementOwnership: foreignKey({
      columns: [table.projectId, table.synthesisStatementId],
      foreignColumns: [synthesisStatements.projectId, synthesisStatements.id],
      name: "synthesis_revisions_project_statement_fk",
    }).onDelete("restrict"),
    stateValid: check("synthesis_revisions_state_valid", sql`${table.state} in ('active', 'withdrawn')`),
    titleNonblank: check("synthesis_revisions_title_nonblank", sql`${table.title} is null or btrim(${table.title}) <> ''`),
    statementShape: check("synthesis_revisions_statement_shape", sql`(
      (${table.state} = 'active' and ${table.statementText} is not null and btrim(${table.statementText}) <> '')
      or (${table.state} = 'withdrawn' and ${table.statementText} is null)
    )`),
    noteNonblank: check("synthesis_revisions_note_nonblank", sql`${table.researcherNote} is null or btrim(${table.researcherNote}) <> ''`),
  }),
);

export const synthesisRevisionSupports = pgTable(
  "synthesis_revision_supports",
  {
    projectId: uuid("project_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.synthesisRevisionId, table.extractionRevisionId] }),
    synthesisRevisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.id],
      name: "synthesis_revision_supports_project_synthesis_revision_fk",
    }).onDelete("restrict"),
    extractionRevisionOwnership: foreignKey({
      columns: [table.projectId, table.extractionRevisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id],
      name: "synthesis_revision_supports_project_extraction_revision_fk",
    }).onDelete("restrict"),
    synthesisRevisionLookup: index("synthesis_revision_supports_project_synthesis_revision_idx").on(table.projectId, table.synthesisRevisionId),
    extractionRevisionLookup: index("synthesis_revision_supports_project_extraction_revision_idx").on(table.projectId, table.extractionRevisionId),
  }),
);

export const synthesisPreparations = pgTable(
  "synthesis_preparations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    evidenceSetCompositionRevisionId: uuid("evidence_set_composition_revision_id").notNull(),
    extractionFieldId: uuid("extraction_field_id").notNull(),
    workingTitle: text("working_title"),
    workingNote: text("working_note"),
    targetSynthesisStatementId: uuid("target_synthesis_statement_id"),
    status: text("status").notNull().default("active"),
    finalizedSynthesisRevisionId: uuid("finalized_synthesis_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("synthesis_preparations_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("synthesis_preparations_project_created_at_idx").on(table.projectId, table.createdAt),
    projectStatus: index("synthesis_preparations_project_status_idx").on(table.projectId, table.status),
    projectSet: index("synthesis_preparations_project_set_idx").on(table.projectId, table.evidenceSetId),
    projectField: index("synthesis_preparations_project_field_idx").on(table.projectId, table.extractionFieldId),
    finalizedRevisionUnique: uniqueIndex("synthesis_preparations_finalized_revision_unique")
      .on(table.projectId, table.finalizedSynthesisRevisionId)
      .where(sql`${table.finalizedSynthesisRevisionId} is not null`),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "synthesis_preparations_project_id_projects_id_fk",
    }).onDelete("restrict"),
    evidenceSetOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "synthesis_preparations_project_evidence_set_fk",
    }).onDelete("restrict"),
    compositionRevisionOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.evidenceSetCompositionRevisionId],
      foreignColumns: [evidenceSetCompositionRevisions.projectId, evidenceSetCompositionRevisions.evidenceSetId, evidenceSetCompositionRevisions.id],
      name: "synthesis_preparations_project_composition_revision_fk",
    }).onDelete("restrict"),
    fieldOwnership: foreignKey({
      columns: [table.projectId, table.extractionFieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "synthesis_preparations_project_field_fk",
    }).onDelete("restrict"),
    targetStatementOwnership: foreignKey({
      columns: [table.projectId, table.targetSynthesisStatementId],
      foreignColumns: [synthesisStatements.projectId, synthesisStatements.id],
      name: "synthesis_preparations_project_target_statement_fk",
    }).onDelete("restrict"),
    finalizedRevisionOwnership: foreignKey({
      columns: [table.projectId, table.targetSynthesisStatementId, table.finalizedSynthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.synthesisStatementId, synthesisRevisions.id],
      name: "synthesis_preparations_project_finalized_revision_fk",
    }).onDelete("restrict"),
    statusValid: check("synthesis_preparations_status_valid", sql`${table.status} in ('active', 'finalized', 'abandoned')`),
    workingTitleShape: check(
      "synthesis_preparations_working_title_shape",
      sql`${table.workingTitle} is null or (btrim(${table.workingTitle}) <> '' and char_length(${table.workingTitle}) <= 500)`,
    ),
    workingNoteShape: check(
      "synthesis_preparations_working_note_shape",
      sql`${table.workingNote} is null or (btrim(${table.workingNote}) <> '' and char_length(${table.workingNote}) <= 10000)`,
    ),
    statusIntegrity: check(
      "synthesis_preparations_status_integrity",
      sql`(
        (${table.status} = 'active' and ${table.finalizedSynthesisRevisionId} is null and ${table.finalizedAt} is null and ${table.abandonedAt} is null)
        or (${table.status} = 'finalized' and ${table.targetSynthesisStatementId} is not null and ${table.finalizedSynthesisRevisionId} is not null and ${table.finalizedAt} is not null and ${table.abandonedAt} is null)
        or (${table.status} = 'abandoned' and ${table.finalizedSynthesisRevisionId} is null and ${table.finalizedAt} is null and ${table.abandonedAt} is not null)
      )`,
    ),
  }),
);

export const synthesisPreparationSelections = pgTable(
  "synthesis_preparation_selections",
  {
    projectId: uuid("project_id").notNull(),
    preparationId: uuid("preparation_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.preparationId, table.extractionRevisionId] }),
    preparationOwnership: foreignKey({
      columns: [table.projectId, table.preparationId],
      foreignColumns: [synthesisPreparations.projectId, synthesisPreparations.id],
      name: "synthesis_preparation_selections_project_preparation_fk",
    }).onDelete("restrict"),
    extractionRevisionOwnership: foreignKey({
      columns: [table.projectId, table.extractionRevisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id],
      name: "synthesis_preparation_selections_project_extraction_revision_fk",
    }).onDelete("restrict"),
    preparationLookup: index("synthesis_preparation_selections_project_preparation_idx").on(table.projectId, table.preparationId),
    extractionRevisionLookup: index("synthesis_preparation_selections_project_extraction_revision_idx").on(table.projectId, table.extractionRevisionId),
  }),
);

export const synthesisInterpretations = pgTable(
  "synthesis_interpretations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    synthesisStatementId: uuid("synthesis_statement_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    convergenceState: text("convergence_state").notNull(),
    summary: text("summary").notNull(),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("synthesis_interpretations_project_id_id_unique").on(table.projectId, table.id),
    revisionEnforcementKey: unique("synthesis_interpretations_project_revision_key_unique").on(table.projectId, table.id, table.synthesisRevisionId),
    projectRevisionSequence: index("synthesis_interpretations_project_revision_sequence_idx").on(table.projectId, table.synthesisRevisionId, table.sequence),
    projectSequence: index("synthesis_interpretations_project_sequence_idx").on(table.projectId, table.sequence),
    projectCreatedAt: index("synthesis_interpretations_project_created_at_idx").on(table.projectId, table.createdAt),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "synthesis_interpretations_project_id_projects_id_fk",
    }).onDelete("restrict"),
    synthesisRevisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisStatementId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.synthesisStatementId, synthesisRevisions.id],
      name: "synthesis_interpretations_project_revision_fk",
    }).onDelete("restrict"),
    convergenceStateValid: check(
      "synthesis_interpretations_convergence_state_valid",
      sql`${table.convergenceState} in ('convergent', 'mixed', 'contradictory', 'inconclusive')`,
    ),
    summaryShape: check(
      "synthesis_interpretations_summary_shape",
      sql`btrim(${table.summary}) <> '' and char_length(${table.summary}) <= 20000`,
    ),
    noteShape: check(
      "synthesis_interpretations_note_shape",
      sql`${table.researcherNote} is null or (btrim(${table.researcherNote}) <> '' and char_length(${table.researcherNote}) <= 10000)`,
    ),
  }),
);

export const synthesisInterpretationLimitations = pgTable(
  "synthesis_interpretation_limitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    interpretationId: uuid("interpretation_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    category: text("category").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    parentOwnership: foreignKey({
      columns: [table.projectId, table.interpretationId],
      foreignColumns: [synthesisInterpretations.projectId, synthesisInterpretations.id],
      name: "synthesis_interpretation_limitations_parent_fk",
    }).onDelete("restrict"),
    uniqueSortOrder: unique("synthesis_interpretation_limitations_project_interpretation_sort_order_unique").on(
      table.projectId,
      table.interpretationId,
      table.sortOrder,
    ),
    interpretationLookup: index("synthesis_interpretation_limitations_interpretation_idx").on(table.projectId, table.interpretationId),
    categoryValid: check(
      "synthesis_interpretation_limitations_category_valid",
      sql`${table.category} in ('methodological', 'population', 'measurement', 'generalizability', 'missing_data', 'heterogeneity', 'reporting', 'other')`,
    ),
    bodyShape: check(
      "synthesis_interpretation_limitations_body_shape",
      sql`btrim(${table.body}) <> '' and char_length(${table.body}) <= 5000`,
    ),
    sortOrderValid: check("synthesis_interpretation_limitations_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const synthesisInterpretationQuestions = pgTable(
  "synthesis_interpretation_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    interpretationId: uuid("interpretation_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    parentOwnership: foreignKey({
      columns: [table.projectId, table.interpretationId],
      foreignColumns: [synthesisInterpretations.projectId, synthesisInterpretations.id],
      name: "synthesis_interpretation_questions_parent_fk",
    }).onDelete("restrict"),
    uniqueSortOrder: unique("synthesis_interpretation_questions_project_interpretation_sort_order_unique").on(
      table.projectId,
      table.interpretationId,
      table.sortOrder,
    ),
    interpretationLookup: index("synthesis_interpretation_questions_interpretation_idx").on(table.projectId, table.interpretationId),
    bodyShape: check(
      "synthesis_interpretation_questions_body_shape",
      sql`btrim(${table.body}) <> '' and char_length(${table.body}) <= 5000`,
    ),
    sortOrderValid: check("synthesis_interpretation_questions_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const synthesisInterpretationContradictions = pgTable(
  "synthesis_interpretation_contradictions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    interpretationId: uuid("interpretation_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    leftExtractionRevisionId: uuid("left_extraction_revision_id").notNull(),
    rightExtractionRevisionId: uuid("right_extraction_revision_id").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    parentOwnership: foreignKey({
      columns: [table.projectId, table.interpretationId, table.synthesisRevisionId],
      foreignColumns: [synthesisInterpretations.projectId, synthesisInterpretations.id, synthesisInterpretations.synthesisRevisionId],
      name: "synthesis_interpretation_contradictions_parent_fk",
    }).onDelete("restrict"),
    leftSupportOwnership: foreignKey({
      columns: [table.projectId, table.synthesisRevisionId, table.leftExtractionRevisionId],
      foreignColumns: [synthesisRevisionSupports.projectId, synthesisRevisionSupports.synthesisRevisionId, synthesisRevisionSupports.extractionRevisionId],
      name: "synthesis_interpretation_contradictions_left_support_fk",
    }).onDelete("restrict"),
    rightSupportOwnership: foreignKey({
      columns: [table.projectId, table.synthesisRevisionId, table.rightExtractionRevisionId],
      foreignColumns: [synthesisRevisionSupports.projectId, synthesisRevisionSupports.synthesisRevisionId, synthesisRevisionSupports.extractionRevisionId],
      name: "synthesis_interpretation_contradictions_right_support_fk",
    }).onDelete("restrict"),
    uniquePair: unique("synthesis_interpretation_contradictions_project_interpretation_pair_unique").on(
      table.projectId,
      table.interpretationId,
      table.leftExtractionRevisionId,
      table.rightExtractionRevisionId,
    ),
    uniqueSortOrder: unique("synthesis_interpretation_contradictions_project_interpretation_sort_order_unique").on(
      table.projectId,
      table.interpretationId,
      table.sortOrder,
    ),
    interpretationLookup: index("synthesis_interpretation_contradictions_interpretation_idx").on(table.projectId, table.interpretationId),
    revisionLookup: index("synthesis_interpretation_contradictions_revision_idx").on(table.projectId, table.synthesisRevisionId),
    canonicalOrder: check(
      "synthesis_interpretation_contradictions_canonical_order",
      sql`${table.leftExtractionRevisionId} < ${table.rightExtractionRevisionId}`,
    ),
    noteShape: check(
      "synthesis_interpretation_contradictions_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 5000)`,
    ),
    sortOrderValid: check("synthesis_interpretation_contradictions_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);


export const claimRevisionExtractionSupports = pgTable(
  "claim_revision_extraction_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.extractionRevisionId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_extraction_supports_project_revision_fk",
    }).onDelete("restrict"),
    extractionRevisionOwnership: foreignKey({
      columns: [table.projectId, table.extractionRevisionId],
      foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id],
      name: "claim_revision_extraction_supports_project_extraction_revision_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_extraction_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    extractionRevisionLookup: index("claim_revision_extraction_supports_project_extraction_revision_idx").on(table.projectId, table.extractionRevisionId),
  }),
);

export const claimRevisionSynthesisSupports = pgTable(
  "claim_revision_synthesis_supports",
  {
    projectId: uuid("project_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.claimRevisionId, table.synthesisRevisionId] }),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.id],
      name: "claim_revision_synthesis_supports_project_revision_fk",
    }).onDelete("restrict"),
    synthesisRevisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.id],
      name: "claim_revision_synthesis_supports_project_synthesis_revision_fk",
    }).onDelete("restrict"),
    revisionLookup: index("claim_revision_synthesis_supports_project_revision_idx").on(table.projectId, table.claimRevisionId),
    synthesisRevisionLookup: index("claim_revision_synthesis_supports_project_synthesis_revision_idx").on(table.projectId, table.synthesisRevisionId),
  }),
);

export const manuscripts = pgTable(
  "manuscripts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull().default("Manuscript"),
    isDefault: boolean("is_default").notNull().default(false),
    citationStyle: text("citation_style").notNull().default("numeric"),
    ...timestamps,
  },
  (table) => ({
    projectIdentity: unique("manuscripts_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("manuscripts_project_created_at_idx").on(table.projectId, table.createdAt),
    defaultPerProject: uniqueIndex("manuscripts_project_default_unique")
      .on(table.projectId)
      .where(sql`${table.isDefault} = true`),
    titleNonblank: check("manuscripts_title_nonblank", sql`btrim(${table.title}) <> ''`),
    citationStyleValid: check("manuscripts_citation_style_valid", sql`${table.citationStyle} in ('numeric', 'author_year')`),
  }),
);

export const manuscriptSections = pgTable(
  "manuscript_sections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    manuscriptId: uuid("manuscript_id").notNull(),
    title: text("title").notNull(),
    sectionType: text("section_type").notNull().default("custom"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("manuscript_sections_project_id_id_unique").on(table.projectId, table.id),
    manuscriptIdentity: unique("manuscript_sections_project_manuscript_id_id_unique").on(table.projectId, table.manuscriptId, table.id),
    manuscriptOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId],
      foreignColumns: [manuscripts.projectId, manuscripts.id],
      name: "manuscript_sections_project_manuscript_fk",
    }).onDelete("restrict"),
    manuscriptOrder: index("manuscript_sections_project_manuscript_order_idx").on(table.projectId, table.manuscriptId, table.sortOrder, table.id),
    sectionTypeValid: check("manuscript_sections_section_type_valid", sql`${table.sectionType} in ('introduction', 'methods', 'results', 'discussion', 'limitations', 'conclusion', 'custom')`),
    titleNonblank: check("manuscript_sections_title_nonblank", sql`btrim(${table.title}) <> ''`),
    sortOrderValid: check("manuscript_sections_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const manuscriptClaimPlacements = pgTable(
  "manuscript_claim_placements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    manuscriptId: uuid("manuscript_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("manuscript_claim_placements_project_id_id_unique").on(table.projectId, table.id),
    sectionIdentity: unique("manuscript_claim_placements_project_section_id_id_unique").on(table.projectId, table.sectionId, table.id),
    manuscriptIdentity: unique("manuscript_claim_placements_project_manuscript_id_id_unique").on(table.projectId, table.manuscriptId, table.id),
    claimRevisionIdentity: unique("manuscript_claim_placements_claim_revision_uq").on(table.projectId, table.claimId, table.claimRevisionId, table.id),
    sectionOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId],
      foreignColumns: [manuscriptSections.projectId, manuscriptSections.manuscriptId, manuscriptSections.id],
      name: "manuscript_claim_placements_project_manuscript_section_fk",
    }).onDelete("restrict"),
    claimRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.claimId, claimRevisions.id],
      name: "manuscript_claim_placements_project_claim_revision_fk",
    }).onDelete("restrict"),
    manuscriptSectionIdentity: unique("manuscript_claim_placements_project_manuscript_section_id_unique").on(table.projectId, table.manuscriptId, table.sectionId, table.id),
    activeRevisionUnique: uniqueIndex("manuscript_claim_placements_active_revision_unique")
      .on(table.projectId, table.sectionId, table.claimRevisionId)
      .where(sql`${table.removedAt} is null`),
  }),
);

export const manuscriptSectionItems = pgTable(
  "manuscript_section_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    manuscriptId: uuid("manuscript_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    itemType: text("item_type").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("manuscript_section_items_project_id_id_unique").on(table.projectId, table.id),
    typedProjectIdentity: unique("manuscript_section_items_project_id_id_type_unique").on(table.projectId, table.id, table.itemType),
    scopeIdentity: unique("manuscript_section_items_project_manuscript_section_id_unique").on(table.projectId, table.manuscriptId, table.sectionId, table.id),
    typedIdentity: unique("manuscript_section_items_project_manuscript_section_id_type_unique").on(table.projectId, table.manuscriptId, table.sectionId, table.id, table.itemType),
    sectionOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId],
      foreignColumns: [manuscriptSections.projectId, manuscriptSections.manuscriptId, manuscriptSections.id],
      name: "manuscript_section_items_project_manuscript_section_fk",
    }).onDelete("restrict"),
    activeOrder: index("manuscript_section_items_project_manuscript_section_order_idx").on(table.projectId, table.manuscriptId, table.sectionId, table.sortOrder, table.id),
    itemTypeValid: check("manuscript_section_items_item_type_valid", sql`${table.itemType} in ('claim', 'prose')`),
    sortOrderValid: check("manuscript_section_items_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const manuscriptSectionItemClaims = pgTable(
  "manuscript_section_item_claims",
  {
    sectionItemId: uuid("section_item_id").primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    manuscriptId: uuid("manuscript_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    itemType: text("item_type").notNull().default("claim"),
    placementId: uuid("placement_id").notNull(),
  },
  (table) => ({
    parentOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId, table.sectionItemId, table.itemType],
      foreignColumns: [manuscriptSectionItems.projectId, manuscriptSectionItems.manuscriptId, manuscriptSectionItems.sectionId, manuscriptSectionItems.id, manuscriptSectionItems.itemType],
      name: "manuscript_section_item_claims_parent_fk",
    }).onDelete("restrict"),
    placementOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId, table.placementId],
      foreignColumns: [manuscriptClaimPlacements.projectId, manuscriptClaimPlacements.manuscriptId, manuscriptClaimPlacements.sectionId, manuscriptClaimPlacements.id],
      name: "manuscript_section_item_claims_placement_fk",
    }).onDelete("restrict"),
    claimItemPlacementId: check("manuscript_section_item_claims_id_matches_placement", sql`${table.sectionItemId} = ${table.placementId}`),
    itemTypeValid: check("manuscript_section_item_claims_item_type_valid", sql`${table.itemType} = 'claim'`),
  }),
);

export const manuscriptProseBlocks = pgTable(
  "manuscript_prose_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    manuscriptId: uuid("manuscript_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    sectionItemId: uuid("section_item_id").notNull(),
    itemType: text("item_type").notNull().default("prose"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("manuscript_prose_blocks_project_id_id_unique").on(table.projectId, table.id),
    parentOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId, table.sectionItemId, table.itemType],
      foreignColumns: [manuscriptSectionItems.projectId, manuscriptSectionItems.manuscriptId, manuscriptSectionItems.sectionId, manuscriptSectionItems.id, manuscriptSectionItems.itemType],
      name: "manuscript_prose_blocks_parent_fk",
    }).onDelete("restrict"),
    itemTypeValid: check("manuscript_prose_blocks_item_type_valid", sql`${table.itemType} = 'prose'`),
    sectionItemIdMatchesId: check("manuscript_prose_blocks_id_matches_section_item", sql`${table.id} = ${table.sectionItemId}`),
    sectionItemUnique: unique("manuscript_prose_blocks_section_item_unique").on(table.sectionItemId),
  }),
);

/** Immutable manuscript Prose content. Currentness is derived from the
 * greatest generated sequence for a (project, proseBlock) pair. */
export const manuscriptProseRevisions = pgTable(
  "manuscript_prose_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    proseBlockId: uuid("prose_block_id").notNull(),
    proseText: text("prose_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("manuscript_prose_revisions_project_id_id_unique").on(table.projectId, table.id),
    blockIdentity: unique("manuscript_prose_revisions_project_block_id_id_unique").on(table.projectId, table.proseBlockId, table.id),
    blockOwnership: foreignKey({
      columns: [table.projectId, table.proseBlockId],
      foreignColumns: [manuscriptProseBlocks.projectId, manuscriptProseBlocks.id],
      name: "manuscript_prose_revisions_project_block_fk",
    }).onDelete("restrict"),
    blockSequence: index("manuscript_prose_revisions_project_block_sequence_idx").on(table.projectId, table.proseBlockId, table.sequence),
    proseTextNonblank: check("manuscript_prose_revisions_prose_text_nonblank", sql`btrim(${table.proseText}) <> ''`),
    proseTextLengthValid: check("manuscript_prose_revisions_prose_text_length_valid", sql`char_length(${table.proseText}) <= 50000`),
  }),
);

export const manuscriptClaimPlacementEvents = pgTable(
  "manuscript_claim_placement_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    manuscriptId: uuid("manuscript_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    placementId: uuid("placement_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    eventType: text("event_type").notNull(),
    fromClaimRevisionId: uuid("from_claim_revision_id"),
    toClaimRevisionId: uuid("to_claim_revision_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    placementSequence: unique("manuscript_claim_placement_events_placement_sequence_uq").on(table.projectId, table.placementId, table.sequence),
    placementOwnership: foreignKey({
      columns: [table.projectId, table.placementId],
      foreignColumns: [manuscriptClaimPlacements.projectId, manuscriptClaimPlacements.id],
      name: "manuscript_claim_placement_events_project_placement_fk",
    }).onDelete("restrict"),
    manuscriptOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId],
      foreignColumns: [manuscripts.projectId, manuscripts.id],
      name: "manuscript_claim_placement_events_project_manuscript_fk",
    }).onDelete("restrict"),
    sectionOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId],
      foreignColumns: [manuscriptSections.projectId, manuscriptSections.manuscriptId, manuscriptSections.id],
      name: "manuscript_claim_placement_events_project_manuscript_section_fk",
    }).onDelete("restrict"),
    claimOwnership: foreignKey({
      columns: [table.projectId, table.claimId],
      foreignColumns: [claims.projectId, claims.id],
      name: "manuscript_claim_placement_events_project_claim_fk",
    }).onDelete("restrict"),
    fromRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimId, table.fromClaimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.claimId, claimRevisions.id],
      name: "manuscript_claim_placement_events_project_from_revision_fk",
    }).onDelete("restrict"),
    toRevisionOwnership: foreignKey({
      columns: [table.projectId, table.claimId, table.toClaimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.claimId, claimRevisions.id],
      name: "manuscript_claim_placement_events_project_to_revision_fk",
    }).onDelete("restrict"),
    placementLookup: index("manuscript_claim_placement_events_project_placement_idx").on(table.projectId, table.placementId, table.sequence),
    eventTypeValid: check("manuscript_claim_placement_events_event_type_valid", sql`${table.eventType} in ('placed', 'replaced', 'removed')`),
    eventShape: check("manuscript_claim_placement_events_shape_valid", sql`(
      (${table.eventType} = 'placed' and ${table.fromClaimRevisionId} is null and ${table.toClaimRevisionId} is not null)
      or (${table.eventType} = 'replaced' and ${table.fromClaimRevisionId} is not null and ${table.toClaimRevisionId} is not null and ${table.fromClaimRevisionId} <> ${table.toClaimRevisionId})
      or (${table.eventType} = 'removed' and ${table.fromClaimRevisionId} is not null and ${table.toClaimRevisionId} is null)
    )`),
  }),
);

export const manuscriptReviewThreads = pgTable(
  "manuscript_review_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    manuscriptId: uuid("manuscript_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    sectionItemId: uuid("section_item_id").notNull(),
    targetItemType: text("target_item_type").notNull(),
    title: text("title").notNull(),
    openingProseText: text("opening_prose_text"),
    openingProseRevisionId: uuid("opening_prose_revision_id"),
    openingClaimId: uuid("opening_claim_id"),
    openingClaimRevisionId: uuid("opening_claim_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("manuscript_review_threads_project_id_id_unique").on(table.projectId, table.id),
    manuscriptIdentity: unique("manuscript_review_threads_project_manuscript_id_id_unique").on(table.projectId, table.manuscriptId, table.id),
    sectionIdentity: unique("manuscript_review_threads_project_manuscript_section_id_id_unique").on(table.projectId, table.manuscriptId, table.sectionId, table.id),
    itemIdentity: unique("manuscript_review_threads_project_section_item_id_unique").on(table.projectId, table.sectionItemId, table.id),
    manuscriptOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId],
      foreignColumns: [manuscripts.projectId, manuscripts.id],
      name: "manuscript_review_threads_project_manuscript_fk",
    }).onDelete("restrict"),
    sectionOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId],
      foreignColumns: [manuscriptSections.projectId, manuscriptSections.manuscriptId, manuscriptSections.id],
      name: "manuscript_review_threads_project_manuscript_section_fk",
    }).onDelete("restrict"),
    itemOwnership: foreignKey({
      columns: [table.projectId, table.manuscriptId, table.sectionId, table.sectionItemId, table.targetItemType],
      foreignColumns: [manuscriptSectionItems.projectId, manuscriptSectionItems.manuscriptId, manuscriptSectionItems.sectionId, manuscriptSectionItems.id, manuscriptSectionItems.itemType],
      name: "manuscript_review_threads_project_section_item_fk",
    }).onDelete("restrict"),
    claimOwnership: foreignKey({
      columns: [table.projectId, table.openingClaimId, table.openingClaimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.claimId, claimRevisions.id],
      name: "manuscript_review_threads_project_opening_claim_revision_fk",
    }).onDelete("restrict"),
    proseRevisionOwnership: foreignKey({
      columns: [table.projectId, table.sectionItemId, table.openingProseRevisionId],
      foreignColumns: [manuscriptProseRevisions.projectId, manuscriptProseRevisions.proseBlockId, manuscriptProseRevisions.id],
      name: "manuscript_review_threads_project_opening_prose_revision_fk",
    }).onDelete("restrict"),
    targetItemTypeValid: check("manuscript_review_threads_target_item_type_valid", sql`${table.targetItemType} in ('claim', 'prose')`),
    titleNonblank: check("manuscript_review_threads_title_nonblank", sql`btrim(${table.title}) <> '' and char_length(${table.title}) <= 300`),
    openingShape: check("manuscript_review_threads_opening_shape", sql`(
      (${table.targetItemType} = 'prose' and ${table.openingProseText} is not null and btrim(${table.openingProseText}) <> '' and char_length(${table.openingProseText}) <= 50000 and ${table.openingClaimId} is null and ${table.openingClaimRevisionId} is null)
      or (${table.targetItemType} = 'claim' and ${table.openingProseText} is null and ${table.openingProseRevisionId} is null and ${table.openingClaimId} is not null and ${table.openingClaimRevisionId} is not null)
    )`),
  }),
);

export const manuscriptReviewEvents = pgTable(
  "manuscript_review_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    eventType: text("event_type").notNull(),
    body: text("body"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("manuscript_review_events_project_id_id_unique").on(table.projectId, table.id),
    threadSequence: unique("manuscript_review_events_project_thread_sequence_unique").on(table.projectId, table.threadId, table.sequence),
    threadOwnership: foreignKey({
      columns: [table.projectId, table.threadId],
      foreignColumns: [manuscriptReviewThreads.projectId, manuscriptReviewThreads.id],
      name: "manuscript_review_events_project_thread_fk",
    }).onDelete("restrict"),
    eventTypeValid: check("manuscript_review_events_event_type_valid", sql`${table.eventType} in ('opened', 'commented', 'resolved', 'reopened')`),
    bodyShape: check("manuscript_review_events_body_shape", sql`
      (${table.eventType} in ('opened', 'commented') and ${table.body} is not null and btrim(${table.body}) <> '' and char_length(${table.body}) <= 10000)
      or (${table.eventType} in ('resolved', 'reopened') and (${table.body} is null or (btrim(${table.body}) <> '' and char_length(${table.body}) <= 10000)))
    `),
  }),
);

export const researchQuestions = pgTable(
  "research_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    identifier: text("identifier").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("research_questions_project_id_id_unique").on(table.projectId, table.id),
    projectIdentifier: unique("research_questions_project_identifier_unique").on(table.projectId, table.identifier),
    projectOrder: index("research_questions_project_order_idx").on(table.projectId, table.sortOrder, table.id),
    identifierNonblank: check("research_questions_identifier_nonblank", sql`btrim(${table.identifier}) <> ''`),
    labelNonblank: check("research_questions_label_nonblank", sql`btrim(${table.label}) <> ''`),
    sortOrderValid: check("research_questions_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const searchSources = pgTable(
  "search_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    sourceKey: text("source_key").notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("search_sources_project_id_id_unique").on(table.projectId, table.id),
    projectKey: unique("search_sources_project_source_key_unique").on(table.projectId, table.sourceKey),
    keyNonblank: check("search_sources_source_key_nonblank", sql`btrim(${table.sourceKey}) <> ''`),
    displayNameNonblank: check("search_sources_display_name_nonblank", sql`btrim(${table.displayName}) <> ''`),
    baseUrlNonblank: check("search_sources_base_url_nonblank", sql`${table.baseUrl} is null or btrim(${table.baseUrl}) <> ''`),
    notesNonblank: check("search_sources_notes_nonblank", sql`${table.notes} is null or btrim(${table.notes}) <> ''`),
  }),
);

export const searchStrategies = pgTable(
  "search_strategies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    searchSourceId: uuid("search_source_id").notNull(),
    name: text("name").notNull(),
    queryText: text("query_text").notNull(),
    filtersText: text("filters_text"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("search_strategies_project_id_id_unique").on(table.projectId, table.id),
    sourceOwnership: foreignKey({
      columns: [table.projectId, table.searchSourceId],
      foreignColumns: [searchSources.projectId, searchSources.id],
      name: "search_strategies_project_source_fk",
    }).onDelete("restrict"),
    projectCreatedAt: index("search_strategies_project_created_at_idx").on(table.projectId, table.createdAt),
    nameNonblank: check("search_strategies_name_nonblank", sql`btrim(${table.name}) <> ''`),
    queryNonblank: check("search_strategies_query_text_nonblank", sql`btrim(${table.queryText}) <> ''`),
    filtersTextNonblank: check("search_strategies_filters_text_nonblank", sql`${table.filtersText} is null or btrim(${table.filtersText}) <> ''`),
    notesNonblank: check("search_strategies_notes_nonblank", sql`${table.notes} is null or btrim(${table.notes}) <> ''`),
  }),
);

export const searchRuns = pgTable(
  "search_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    searchSourceId: uuid("search_source_id").notNull(),
    sourceKeySnapshot: text("source_key_snapshot").notNull(),
    sourceDisplayNameSnapshot: text("source_display_name_snapshot").notNull(),
    strategyId: uuid("strategy_id").notNull(),
    queryText: text("query_text").notNull(),
    filtersTextSnapshot: text("filters_text_snapshot"),
    reportedResultCount: integer("reported_result_count").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("search_runs_project_id_id_unique").on(table.projectId, table.id),
    runSourceIdentity: unique("search_runs_project_id_id_source_unique").on(table.projectId, table.id, table.searchSourceId),
    sourceOwnership: foreignKey({
      columns: [table.projectId, table.searchSourceId],
      foreignColumns: [searchSources.projectId, searchSources.id],
      name: "search_runs_project_source_fk",
    }).onDelete("restrict"),
    strategyOwnership: foreignKey({
      columns: [table.projectId, table.strategyId],
      foreignColumns: [searchStrategies.projectId, searchStrategies.id],
      name: "search_runs_project_strategy_fk",
    }).onDelete("restrict"),
    projectSequence: index("search_runs_project_sequence_idx").on(table.projectId, table.sequence),
    sourceSequence: index("search_runs_project_source_sequence_idx").on(table.projectId, table.searchSourceId, table.sequence),
    sourceKeyNonblank: check("search_runs_source_key_snapshot_nonblank", sql`btrim(${table.sourceKeySnapshot}) <> ''`),
    sourceDisplayNameNonblank: check("search_runs_source_display_name_snapshot_nonblank", sql`btrim(${table.sourceDisplayNameSnapshot}) <> ''`),
    queryNonblank: check("search_runs_query_text_nonblank", sql`btrim(${table.queryText}) <> ''`),
    reportedResultCountValid: check("search_runs_reported_result_count_valid", sql`${table.reportedResultCount} >= 0`),
    filtersTextSnapshotNonblank: check("search_runs_filters_text_snapshot_nonblank", sql`${table.filtersTextSnapshot} is null or btrim(${table.filtersTextSnapshot}) <> ''`),
    notesNonblank: check("search_runs_notes_nonblank", sql`${table.notes} is null or btrim(${table.notes}) <> ''`),
  }),
);

export const retrievedRecords = pgTable(
  "retrieved_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    searchRunId: uuid("search_run_id").notNull(),
    searchSourceId: uuid("search_source_id").notNull(),
    sourceRecordId: text("source_record_id"),
    title: text("title").notNull(),
    authors: text("authors").array().notNull().default([]),
    abstract: text("abstract"),
    doi: text("doi"),
    url: text("url"),
    publicationYear: integer("publication_year"),
    venue: text("venue"),
    rawCitation: text("raw_citation"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("retrieved_records_project_id_id_unique").on(table.projectId, table.id),
    sourceExternalIdentity: uniqueIndex("retrieved_records_project_run_source_record_unique")
      .on(table.projectId, table.searchRunId, table.searchSourceId, table.sourceRecordId)
      .where(sql`${table.sourceRecordId} is not null`),
    runOwnership: foreignKey({
      columns: [table.projectId, table.searchRunId],
      foreignColumns: [searchRuns.projectId, searchRuns.id],
      name: "retrieved_records_project_search_run_fk",
    }).onDelete("restrict"),
    sourceOwnership: foreignKey({
      columns: [table.projectId, table.searchSourceId],
      foreignColumns: [searchSources.projectId, searchSources.id],
      name: "retrieved_records_project_source_fk",
    }).onDelete("restrict"),
    runSourceIdentity: foreignKey({
      columns: [table.projectId, table.searchRunId, table.searchSourceId],
      foreignColumns: [searchRuns.projectId, searchRuns.id, searchRuns.searchSourceId],
      name: "retrieved_records_project_run_source_fk",
    }).onDelete("restrict"),
    doiComparison: index("retrieved_records_project_doi_comparison_idx")
      .using("btree", table.projectId, sql`lower(regexp_replace(regexp_replace(btrim(${table.doi}), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))`)
      .where(sql`${table.doi} is not null and btrim(${table.doi}) <> ''`),
    titleComparison: index("retrieved_records_project_title_comparison_idx")
      .using("btree", table.projectId, sql`lower(regexp_replace(btrim(${table.title}), '[[:space:]]+', ' ', 'g'))`, table.publicationYear)
      .where(sql`${table.title} is not null and btrim(${table.title}) <> ''`),
    sourceRecordIdNonblank: check("retrieved_records_source_record_id_nonblank", sql`${table.sourceRecordId} is null or btrim(${table.sourceRecordId}) <> ''`),
    titleNonblank: check("retrieved_records_title_nonblank", sql`btrim(${table.title}) <> ''`),
    publicationYearValid: check("retrieved_records_publication_year_valid", sql`${table.publicationYear} is null or (${table.publicationYear} >= 1000 and ${table.publicationYear} <= 3000)`),
    venueNonblank: check("retrieved_records_venue_nonblank", sql`${table.venue} is null or btrim(${table.venue}) <> ''`),
  }),
);

export const retrievedRecordMatches = pgTable(
  "retrieved_record_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    retrievedRecordId: uuid("retrieved_record_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("retrieved_record_matches_project_id_id_unique").on(table.projectId, table.id),
    recordOwnership: foreignKey({
      columns: [table.projectId, table.retrievedRecordId],
      foreignColumns: [retrievedRecords.projectId, retrievedRecords.id],
      name: "retrieved_record_matches_project_record_fk",
    }).onDelete("restrict"),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "retrieved_record_matches_project_paper_fk",
    }).onDelete("restrict"),
    recordSequence: index("retrieved_record_matches_project_record_sequence_idx").on(table.projectId, table.retrievedRecordId, table.sequence),
    actionValid: check("retrieved_record_matches_action_valid", sql`${table.action} in ('linked', 'unlinked')`),
  }),
);

export const retrievedRecordDeduplicationDecisions = pgTable(
  "retrieved_record_deduplication_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    leftRetrievedRecordId: uuid("left_retrieved_record_id").notNull(),
    rightRetrievedRecordId: uuid("right_retrieved_record_id").notNull(),
    decision: text("decision").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("retrieved_record_deduplication_decisions_project_id_id_unique").on(table.projectId, table.id),
    leftRecordOwnership: foreignKey({
      columns: [table.projectId, table.leftRetrievedRecordId],
      foreignColumns: [retrievedRecords.projectId, retrievedRecords.id],
      name: "retrieved_record_deduplication_decisions_project_left_record_fk",
    }).onDelete("restrict"),
    rightRecordOwnership: foreignKey({
      columns: [table.projectId, table.rightRetrievedRecordId],
      foreignColumns: [retrievedRecords.projectId, retrievedRecords.id],
      name: "retrieved_record_deduplication_decisions_project_right_record_fk",
    }).onDelete("restrict"),
    pairSequence: index("retrieved_record_deduplication_decisions_project_pair_sequence_idx").on(table.projectId, table.leftRetrievedRecordId, table.rightRetrievedRecordId, table.sequence),
    rightRecordSequence: index("retrieved_record_deduplication_decisions_project_right_record_sequence_idx").on(table.projectId, table.rightRetrievedRecordId, table.sequence),
    decisionValid: check("retrieved_record_deduplication_decisions_decision_valid", sql`${table.decision} in ('same_work', 'different_work')`),
    noteNonblank: check("retrieved_record_deduplication_decisions_note_nonblank", sql`${table.note} is null or btrim(${table.note}) <> ''`),
    orderedDistinctPair: check("retrieved_record_deduplication_decisions_ordered_distinct_pair", sql`${table.leftRetrievedRecordId} < ${table.rightRetrievedRecordId}`),
  }),
);

export const researchQuestionExtractionFieldEvents = pgTable(
  "research_question_extraction_field_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    extractionFieldId: uuid("extraction_field_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_extraction_field_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_extraction_field_events_project_rq_fk",
    }).onDelete("restrict"),
    projectFieldOwnership: foreignKey({
      columns: [table.projectId, table.extractionFieldId],
      foreignColumns: [extractionFields.projectId, extractionFields.id],
      name: "rq_extraction_field_events_project_field_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_extraction_field_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectFieldSequence: index("rq_extraction_field_events_project_field_seq_idx").on(
      table.projectId,
      table.extractionFieldId,
      table.sequence,
    ),
    projectPairSequence: index("rq_extraction_field_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.extractionFieldId,
      table.sequence,
    ),
    actionValid: check(
      "rq_extraction_field_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_extraction_field_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

export const researchQuestionEvidenceSetEvents = pgTable(
  "research_question_evidence_set_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_evidence_set_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_evidence_set_events_project_rq_fk",
    }).onDelete("restrict"),
    projectEvidenceSetOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "rq_evidence_set_events_project_set_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_evidence_set_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectEvidenceSetSequence: index("rq_evidence_set_events_project_set_seq_idx").on(
      table.projectId,
      table.evidenceSetId,
      table.sequence,
    ),
    projectPairSequence: index("rq_evidence_set_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.evidenceSetId,
      table.sequence,
    ),
    actionValid: check(
      "rq_evidence_set_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_evidence_set_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

export const researchQuestionSynthesisStatementEvents = pgTable(
  "research_question_synthesis_statement_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    synthesisStatementId: uuid("synthesis_statement_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_synthesis_statement_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_synthesis_statement_events_project_rq_fk",
    }).onDelete("restrict"),
    projectStatementOwnership: foreignKey({
      columns: [table.projectId, table.synthesisStatementId],
      foreignColumns: [synthesisStatements.projectId, synthesisStatements.id],
      name: "rq_synthesis_statement_events_project_stmt_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_synthesis_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectStatementSequence: index("rq_synthesis_events_project_stmt_seq_idx").on(
      table.projectId,
      table.synthesisStatementId,
      table.sequence,
    ),
    projectPairSequence: index("rq_synthesis_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.synthesisStatementId,
      table.sequence,
    ),
    actionValid: check(
      "rq_synthesis_statement_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_synthesis_statement_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

export const researchQuestionClaimEvents = pgTable(
  "research_question_claim_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "rq_claim_events_project_fk",
    }).onDelete("restrict"),
    projectQuestionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "rq_claim_events_project_rq_fk",
    }).onDelete("restrict"),
    projectClaimOwnership: foreignKey({
      columns: [table.projectId, table.claimId],
      foreignColumns: [claims.projectId, claims.id],
      name: "rq_claim_events_project_claim_fk",
    }).onDelete("restrict"),
    projectQuestionSequence: index("rq_claim_events_project_rq_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.sequence,
    ),
    projectClaimSequence: index("rq_claim_events_project_claim_seq_idx").on(
      table.projectId,
      table.claimId,
      table.sequence,
    ),
    projectPairSequence: index("rq_claim_events_project_pair_seq_idx").on(
      table.projectId,
      table.researchQuestionId,
      table.claimId,
      table.sequence,
    ),
    actionValid: check(
      "rq_claim_events_action_valid",
      sql`${table.action} in ('linked', 'unlinked')`,
    ),
    noteShape: check(
      "rq_claim_events_note_shape",
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`,
    ),
  }),
);

// Slice 21 Research Question Answer snapshots.  Answer context is historical
// drafting context only; it is deliberately kept separate from every formal
// support/citation relation.
export const researchQuestionAnswers = pgTable(
  "research_question_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    answerText: text("answer_text").notNull(),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("research_question_answers_project_id_id_unique").on(table.projectId, table.id),
    questionIdentity: unique("research_question_answers_project_question_id_id_unique").on(table.projectId, table.researchQuestionId, table.id),
    questionSequence: index("research_question_answers_project_question_sequence_idx").on(table.projectId, table.researchQuestionId, table.sequence),
    projectSequence: index("research_question_answers_project_sequence_idx").on(table.projectId, table.sequence),
    projectOwnership: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "research_question_answers_project_fk",
    }).onDelete("restrict"),
    questionOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId],
      foreignColumns: [researchQuestions.projectId, researchQuestions.id],
      name: "research_question_answers_project_question_fk",
    }).onDelete("restrict"),
    answerTextShape: check(
      "research_question_answers_answer_text_shape",
      sql`btrim(${table.answerText}) <> '' and char_length(${table.answerText}) <= 20000`,
    ),
    researcherNoteShape: check(
      "research_question_answers_researcher_note_shape",
      sql`${table.researcherNote} is null or (btrim(${table.researcherNote}) <> '' and char_length(${table.researcherNote}) <= 20000)`,
    ),
  }),
);

export const researchQuestionAnswerClaimContexts = pgTable(
  "research_question_answer_claim_contexts",
  {
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    answerId: uuid("answer_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    claimRevisionId: uuid("claim_revision_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.answerId, table.claimRevisionId] }),
    answerSortOrder: unique("research_question_answer_claim_contexts_answer_sort_order_unique").on(table.projectId, table.answerId, table.sortOrder),
    answerOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId, table.answerId],
      foreignColumns: [researchQuestionAnswers.projectId, researchQuestionAnswers.researchQuestionId, researchQuestionAnswers.id],
      name: "research_question_answer_claim_contexts_answer_fk",
    }).onDelete("restrict"),
    revisionOwnership: foreignKey({
      columns: [table.projectId, table.claimId, table.claimRevisionId],
      foreignColumns: [claimRevisions.projectId, claimRevisions.claimId, claimRevisions.id],
      name: "research_question_answer_claim_contexts_revision_fk",
    }).onDelete("restrict"),
    answerLookup: index("research_question_answer_claim_contexts_answer_idx").on(table.projectId, table.answerId, table.sortOrder),
    claimLookup: index("research_question_answer_claim_contexts_claim_idx").on(table.projectId, table.claimId),
    revisionLookup: index("research_question_answer_claim_contexts_revision_idx").on(table.projectId, table.claimRevisionId),
    sortOrderValid: check("research_question_answer_claim_contexts_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const researchQuestionAnswerSynthesisContexts = pgTable(
  "research_question_answer_synthesis_contexts",
  {
    projectId: uuid("project_id").notNull(),
    researchQuestionId: uuid("research_question_id").notNull(),
    answerId: uuid("answer_id").notNull(),
    synthesisStatementId: uuid("synthesis_statement_id").notNull(),
    synthesisRevisionId: uuid("synthesis_revision_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.answerId, table.synthesisRevisionId] }),
    answerSortOrder: unique("research_question_answer_synthesis_contexts_answer_sort_order_unique").on(table.projectId, table.answerId, table.sortOrder),
    answerOwnership: foreignKey({
      columns: [table.projectId, table.researchQuestionId, table.answerId],
      foreignColumns: [researchQuestionAnswers.projectId, researchQuestionAnswers.researchQuestionId, researchQuestionAnswers.id],
      name: "research_question_answer_synthesis_contexts_answer_fk",
    }).onDelete("restrict"),
    revisionOwnership: foreignKey({
      columns: [table.projectId, table.synthesisStatementId, table.synthesisRevisionId],
      foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.synthesisStatementId, synthesisRevisions.id],
      name: "research_question_answer_synthesis_contexts_revision_fk",
    }).onDelete("restrict"),
    answerLookup: index("research_question_answer_synthesis_contexts_answer_idx").on(table.projectId, table.answerId, table.sortOrder),
    statementLookup: index("research_question_answer_synthesis_contexts_statement_idx").on(table.projectId, table.synthesisStatementId),
    revisionLookup: index("research_question_answer_synthesis_contexts_revision_idx").on(table.projectId, table.synthesisRevisionId),
    sortOrderValid: check("research_question_answer_synthesis_contexts_sort_order_valid", sql`${table.sortOrder} >= 0`),
  }),
);

export const manuscriptSnapshots = pgTable("manuscript_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(), sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull(), projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), title: text("title").notNull(), citationStyle: text("citation_style").notNull(), schemaVersion: integer("schema_version").notNull(), rendererVersion: text("renderer_version").notNull(), capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(), renderedMarkdown: text("rendered_markdown").notNull(), renderedMarkdownSha256: text("rendered_markdown_sha256").notNull(), expectedSectionCount: integer("expected_section_count").notNull(), expectedItemCount: integer("expected_item_count").notNull(), expectedBibliographyCount: integer("expected_bibliography_count").notNull(), expectedWarningCount: integer("expected_warning_count").notNull(), finalizedAt: timestamp("finalized_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), });
export const manuscriptSnapshotSections = pgTable("manuscript_snapshot_sections", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), sourceSectionId: uuid("source_section_id").notNull(), title: text("title").notNull(), sectionType: text("section_type").notNull(), sectionPosition: integer("section_position").notNull(), sourceSortOrder: integer("source_sort_order").notNull() });
export const manuscriptSnapshotItems = pgTable("manuscript_snapshot_items", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), snapshotSectionId: uuid("snapshot_section_id").notNull(), sourceSectionId: uuid("source_section_id").notNull(), sourceSectionItemId: uuid("source_section_item_id").notNull(), itemType: text("item_type").notNull(), itemPosition: integer("item_position").notNull(), sourceSortOrder: integer("source_sort_order").notNull() });
export const manuscriptSnapshotProseItems = pgTable("manuscript_snapshot_prose_items", { projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotItemId: uuid("snapshot_item_id").primaryKey(), snapshotId: uuid("snapshot_id").notNull(), sourceProseBlockId: uuid("source_prose_block_id").notNull(), proseRevisionId: uuid("prose_revision_id").notNull(), proseText: text("prose_text").notNull(), sourceSectionId: uuid("source_section_id").notNull(), sourceSectionItemId: uuid("source_section_item_id").notNull() });
export const manuscriptSnapshotClaimItems = pgTable("manuscript_snapshot_claim_items", { projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotItemId: uuid("snapshot_item_id").primaryKey(), snapshotId: uuid("snapshot_id").notNull(), placementId: uuid("placement_id").notNull(), claimId: uuid("claim_id").notNull(), claimRevisionId: uuid("claim_revision_id").notNull(), sourceSectionId: uuid("source_section_id").notNull(), sourceSectionItemId: uuid("source_section_item_id").notNull(), claimText: text("claim_text"), renderedCitationMarker: text("rendered_citation_marker").notNull(), captureSupportStatus: text("capture_support_status").notNull(), captureIsCurrentClaimRevision: boolean("capture_is_current_claim_revision").notNull(), captureIsSuperseded: boolean("capture_is_superseded").notNull(), captureClaimLifecycle: text("capture_claim_lifecycle").notNull() });
export const manuscriptSnapshotBibliographyEntries = pgTable("manuscript_snapshot_bibliography_entries", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), paperId: uuid("paper_id").notNull(), title: text("title").notNull(), authors: text("authors").array().notNull(), publicationYear: integer("publication_year"), venue: text("venue"), doi: text("doi"), citationNumber: integer("citation_number").notNull(), bibliographyPosition: integer("bibliography_position").notNull(), renderedReference: text("rendered_reference").notNull() });
export const manuscriptSnapshotClaimBibliographyMembers = pgTable("manuscript_snapshot_claim_bibliography_members", { projectId: uuid("project_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), snapshotClaimItemId: uuid("snapshot_claim_item_id").notNull(), bibliographyEntryId: uuid("bibliography_entry_id").notNull(), markerPosition: integer("marker_position").notNull() }, (table) => ({ pk: primaryKey({ columns: [table.projectId, table.snapshotId, table.snapshotClaimItemId, table.bibliographyEntryId] }) }));
export const manuscriptSnapshotWarnings = pgTable("manuscript_snapshot_warnings", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), warningPosition: integer("warning_position").notNull(), sectionId: uuid("section_id"), sectionItemId: uuid("section_item_id"), placementId: uuid("placement_id"), claimRevisionId: uuid("claim_revision_id"), paperId: uuid("paper_id"), code: text("code").notNull(), message: text("message").notNull(), metadataField: text("metadata_field") });

// Slice 26 AI extraction suggestions. These rows are immutable workflow
// history; canonical Evidence and ExtractionValueRevision rows are written by
// the acceptance service through the existing generic writers.
export const aiExtractionRequests = pgTable(
  "ai_extraction_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    extractionFieldId: uuid("extraction_field_id").notNull(),
    fullTextDocumentId: uuid("full_text_document_id").notNull(),
    documentTextExtractionId: uuid("document_text_extraction_id").notNull(),
    baselineExtractionRevisionId: uuid("baseline_extraction_revision_id"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    intentHash: text("intent_hash").notNull(),
    fieldNameSnapshot: text("field_name_snapshot").notNull(),
    fieldDescriptionSnapshot: text("field_description_snapshot"),
    fieldType: text("field_type").notNull(),
    optionSnapshot: jsonb("option_snapshot").notNull().default([]),
    provider: text("provider").notNull(),
    configuredModel: text("configured_model").notNull(),
    configuredReasoningEffort: text("configured_reasoning_effort").notNull(),
    promptVersion: text("prompt_version").notNull(),
    responseSchemaVersion: text("response_schema_version").notNull(),
    groundingResolverVersion: text("grounding_resolver_version").notNull(),
    contextSelectionVersion: text("context_selection_version").notNull(),
    sourceCharacterCount: integer("source_character_count").notNull(),
    sourceByteSize: integer("source_byte_size").notNull(),
    pageManifestHash: text("page_manifest_hash").notNull(),
    externalTransmissionAcknowledged: boolean("external_transmission_acknowledged").notNull(),
    disclosureVersion: text("disclosure_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_requests_project_id_id_unique").on(table.projectId, table.id),
    idempotency: unique("ai_extraction_requests_project_id_idempotency_key_unique").on(table.projectId, table.idempotencyKey),
    projectPaperFieldIdentity: unique("ai_extraction_requests_project_paper_field_id_unique").on(table.projectId, table.paperId, table.extractionFieldId, table.id),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "ai_extraction_requests_project_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "ai_extraction_requests_paper_fk" }).onDelete("restrict"),
    fieldOwnership: foreignKey({ columns: [table.projectId, table.extractionFieldId], foreignColumns: [extractionFields.projectId, extractionFields.id], name: "ai_extraction_requests_field_fk" }).onDelete("restrict"),
    documentOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.fullTextDocumentId], foreignColumns: [fullTextDocuments.projectId, fullTextDocuments.paperId, fullTextDocuments.id], name: "ai_extraction_requests_document_fk" }).onDelete("restrict"),
    extractionOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.documentTextExtractionId], foreignColumns: [documentTextExtractions.projectId, documentTextExtractions.paperId, documentTextExtractions.id], name: "ai_extraction_requests_extraction_fk" }).onDelete("restrict"),
    baselineRevisionOwnership: foreignKey({ columns: [table.projectId, table.baselineExtractionRevisionId], foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id], name: "ai_extraction_requests_baseline_revision_fk" }).onDelete("restrict"),
    fieldTypeValid: check("ai_extraction_requests_field_type_valid", sql`${table.fieldType} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    providerNonblank: check("ai_extraction_requests_provider_nonblank", sql`btrim(${table.provider}) <> ''`),
    modelNonblank: check("ai_extraction_requests_model_nonblank", sql`btrim(${table.configuredModel}) <> ''`),
    versionShape: check("ai_extraction_requests_version_shape", sql`btrim(${table.promptVersion}) <> '' and btrim(${table.responseSchemaVersion}) <> '' and btrim(${table.groundingResolverVersion}) <> '' and btrim(${table.contextSelectionVersion}) <> ''`),
    hashShape: check("ai_extraction_requests_hash_shape", sql`${table.intentHash} ~ '^[0-9a-f]{64}$' and ${table.pageManifestHash} ~ '^[0-9a-f]{64}$'`),
    sourceBounds: check("ai_extraction_requests_source_bounds", sql`${table.sourceCharacterCount} >= 0 and ${table.sourceCharacterCount} <= 80000 and ${table.sourceByteSize} >= 0 and ${table.sourceByteSize} <= 327680`),
    acknowledged: check("ai_extraction_requests_transmission_acknowledged", sql`${table.externalTransmissionAcknowledged} = true`),
  }),
);

export const aiExtractionRequestPages = pgTable(
  "ai_extraction_request_pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    pageId: uuid("page_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    fullTextDocumentId: uuid("full_text_document_id").notNull(),
    documentTextExtractionId: uuid("document_text_extraction_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    pageOrdinal: integer("page_ordinal").notNull(),
    textSha256: text("text_sha256").notNull(),
    characterCount: integer("character_count").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_request_pages_project_id_id_unique").on(table.projectId, table.id),
    requestPage: unique("ai_extraction_request_pages_request_page_unique").on(table.projectId, table.requestId, table.pageNumber),
    requestOrdinal: unique("ai_extraction_request_pages_request_ordinal_unique").on(table.projectId, table.requestId, table.pageOrdinal),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiExtractionRequests.projectId, aiExtractionRequests.id], name: "ai_extraction_request_pages_request_fk" }).onDelete("restrict"),
    sourcePageOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.documentTextExtractionId, table.pageNumber], foreignColumns: [documentTextExtractionPages.projectId, documentTextExtractionPages.paperId, documentTextExtractionPages.documentTextExtractionId, documentTextExtractionPages.pageNumber], name: "ai_extraction_request_pages_source_page_fk" }).onDelete("restrict"),
    sourcePageIdentity: foreignKey({ columns: [table.projectId, table.pageId], foreignColumns: [documentTextExtractionPages.projectId, documentTextExtractionPages.id], name: "ai_extraction_request_pages_source_page_id_fk" }).onDelete("restrict"),
    pageNumberValid: check("ai_extraction_request_pages_page_number_valid", sql`${table.pageNumber} > 0 and ${table.pageNumber} <= 2000`),
    ordinalValid: check("ai_extraction_request_pages_ordinal_valid", sql`${table.pageOrdinal} >= 0 and ${table.pageOrdinal} < 40`),
    hashShape: check("ai_extraction_request_pages_hash_shape", sql`${table.textSha256} ~ '^[0-9a-f]{64}$'`),
    countBounds: check("ai_extraction_request_pages_count_bounds", sql`${table.characterCount} > 0 and ${table.characterCount} <= 500000 and ${table.byteSize} > 0 and ${table.byteSize} <= 2000000`),
  }),
);

export const aiExtractionDispatches = pgTable(
  "ai_extraction_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_dispatches_project_id_id_unique").on(table.projectId, table.id),
    requestUnique: unique("ai_extraction_dispatches_project_request_unique").on(table.projectId, table.requestId),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiExtractionRequests.projectId, aiExtractionRequests.id], name: "ai_extraction_dispatches_request_fk" }).onDelete("restrict"),
    deadlineOrder: check("ai_extraction_dispatches_deadline_order", sql`${table.deadlineAt} > ${table.startedAt}`),
  }),
);

export const aiExtractionResults = pgTable(
  "ai_extraction_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    outcome: text("outcome").notNull(),
    providerDiagnostic: text("provider_diagnostic").notNull(),
    errorCode: text("error_code"),
    candidateState: text("candidate_state"),
    textValue: text("text_value"),
    numberValue: numeric("number_value", { precision: 30, scale: 10 }),
    booleanValue: boolean("boolean_value"),
    optionId: uuid("option_id"),
    explanation: text("explanation"),
    providerRequestId: text("provider_request_id"),
    configuredModel: text("configured_model").notNull(),
    returnedModel: text("returned_model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_results_project_id_id_unique").on(table.projectId, table.id),
    requestUnique: unique("ai_extraction_results_project_request_unique").on(table.projectId, table.requestId),
    requestIdentity: unique("ai_extraction_results_project_request_id_unique").on(table.projectId, table.requestId, table.id),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiExtractionRequests.projectId, aiExtractionRequests.id], name: "ai_extraction_results_request_fk" }).onDelete("restrict"),
    optionOwnership: foreignKey({ columns: [table.projectId, table.optionId], foreignColumns: [extractionOptions.projectId, extractionOptions.id], name: "ai_extraction_results_option_fk" }).onDelete("restrict"),
    outcomeValid: check("ai_extraction_results_outcome_valid", sql`${table.outcome} in ('succeeded', 'no_candidate', 'provider_unavailable', 'failed', 'invalid_output', 'unresolvable_grounding', 'outcome_unknown')`),
    diagnosticValid: check("ai_extraction_results_provider_diagnostic_valid", sql`${table.providerDiagnostic} in ('success', 'refusal', 'incomplete', 'schema_invalid', 'transport_error', 'api_error', 'unknown')`),
    candidateStateValid: check("ai_extraction_results_candidate_state_valid", sql`${table.candidateState} is null or ${table.candidateState} in ('present', 'not_reported', 'not_applicable')`),
    candidateValueShape: check("ai_extraction_results_candidate_value_shape", sql`(
      (${table.candidateState} is null and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
      or (${table.candidateState} <> 'present' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
      or (${table.candidateState} = 'present' and (
        (${table.textValue} is not null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
        or (${table.textValue} is null and ${table.numberValue} is not null and ${table.booleanValue} is null and ${table.optionId} is null)
        or (${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is not null and ${table.optionId} is null)
        or (${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is not null)
      ))
    )`),
    terminalShape: check("ai_extraction_results_terminal_shape", sql`${table.finalizedAt} is not null`),
    boundedText: check("ai_extraction_results_bounded_text", sql`${table.textValue} is null or char_length(${table.textValue}) <= 10000`),
    boundedExplanation: check("ai_extraction_results_bounded_explanation", sql`${table.explanation} is null or char_length(${table.explanation}) <= 10000`),
    boundedError: check("ai_extraction_results_bounded_error", sql`${table.errorCode} is null or (btrim(${table.errorCode}) <> '' and char_length(${table.errorCode}) <= 200)`),
     usageBounds: check("ai_extraction_results_usage_bounds", sql`(${table.inputTokens} is null or ${table.inputTokens} >= 0) and (${table.outputTokens} is null or ${table.outputTokens} >= 0) and (${table.durationMs} is null or ${table.durationMs} >= 0)`),
  }),
);

export const aiExtractionResultGroundings = pgTable(
  "ai_extraction_result_groundings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    resultId: uuid("result_id").notNull(),
    pageId: uuid("page_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    locatorQuote: text("locator_quote").notNull(),
    locatorPrefix: text("locator_prefix"),
    locatorSuffix: text("locator_suffix"),
    sourceText: text("source_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_result_groundings_project_id_id_unique").on(table.projectId, table.id),
    resultIdentity: unique("ai_extraction_result_groundings_result_page_start_end_unique").on(table.projectId, table.resultId, table.pageNumber, table.startOffset, table.endOffset),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiExtractionRequests.projectId, aiExtractionRequests.id], name: "ai_extraction_result_groundings_request_fk" }).onDelete("restrict"),
    resultOwnership: foreignKey({ columns: [table.projectId, table.requestId, table.resultId], foreignColumns: [aiExtractionResults.projectId, aiExtractionResults.requestId, aiExtractionResults.id], name: "ai_extraction_result_groundings_result_fk" }).onDelete("restrict"),
    pageOwnership: foreignKey({ columns: [table.projectId, table.pageId], foreignColumns: [documentTextExtractionPages.projectId, documentTextExtractionPages.id], name: "ai_extraction_result_groundings_page_fk" }).onDelete("restrict"),
    pagePositive: check("ai_extraction_result_groundings_page_positive", sql`${table.pageNumber} > 0`),
    offsetShape: check("ai_extraction_result_groundings_offset_shape", sql`${table.startOffset} >= 0 and ${table.endOffset} > ${table.startOffset} and ${table.endOffset} - ${table.startOffset} <= 4000`),
    quoteNonblank: check("ai_extraction_result_groundings_quote_nonblank", sql`btrim(${table.locatorQuote}) <> '' and char_length(${table.locatorQuote}) <= 4000`),
    contextBounds: check("ai_extraction_result_groundings_context_bounds", sql`(${table.locatorPrefix} is null or char_length(${table.locatorPrefix}) <= 120) and (${table.locatorSuffix} is null or char_length(${table.locatorSuffix}) <= 120)`),
    sourceTextBound: check("ai_extraction_result_groundings_source_text_bound", sql`char_length(${table.sourceText}) <= 4000`),
  }),
);

export const aiExtractionDecisions = pgTable(
  "ai_extraction_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    decision: text("decision").notNull(),
    acceptanceMode: text("acceptance_mode"),
    expectedCurrentExtractionRevisionId: uuid("expected_current_extraction_revision_id"),
    precedingExtractionRevisionId: uuid("preceding_extraction_revision_id"),
    resultingExtractionRevisionId: uuid("resulting_extraction_revision_id"),
    valueState: text("value_state"),
    textValue: text("text_value"),
    numberValue: numeric("number_value", { precision: 30, scale: 10 }),
    booleanValue: boolean("boolean_value"),
    optionId: uuid("option_id"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_decisions_project_id_id_unique").on(table.projectId, table.id),
    requestUnique: unique("ai_extraction_decisions_project_request_unique").on(table.projectId, table.requestId),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiExtractionRequests.projectId, aiExtractionRequests.id], name: "ai_extraction_decisions_request_fk" }).onDelete("restrict"),
    expectedRevisionOwnership: foreignKey({ columns: [table.projectId, table.expectedCurrentExtractionRevisionId], foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id], name: "ai_extraction_decisions_expected_revision_fk" }).onDelete("restrict"),
    precedingRevisionOwnership: foreignKey({ columns: [table.projectId, table.precedingExtractionRevisionId], foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id], name: "ai_extraction_decisions_preceding_revision_fk" }).onDelete("restrict"),
    resultingRevisionOwnership: foreignKey({ columns: [table.projectId, table.resultingExtractionRevisionId], foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id], name: "ai_extraction_decisions_resulting_revision_fk" }).onDelete("restrict"),
    optionOwnership: foreignKey({ columns: [table.projectId, table.optionId], foreignColumns: [extractionOptions.projectId, extractionOptions.id], name: "ai_extraction_decisions_option_fk" }).onDelete("restrict"),
    decisionValid: check("ai_extraction_decisions_decision_valid", sql`${table.decision} in ('accepted', 'rejected')`),
    acceptanceModeValid: check("ai_extraction_decisions_acceptance_mode_valid", sql`${table.acceptanceMode} is null or ${table.acceptanceMode} in ('accept', 'edit_and_accept')`),
    stateValid: check("ai_extraction_decisions_state_valid", sql`${table.valueState} is null or ${table.valueState} in ('present', 'not_reported', 'not_applicable', 'cleared')`),
    decisionShape: check("ai_extraction_decisions_decision_shape", sql`(
      (${table.decision} = 'rejected' and ${table.acceptanceMode} is null and ${table.resultingExtractionRevisionId} is null and ${table.valueState} is null and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null)
      or (${table.decision} = 'accepted' and ${table.acceptanceMode} is not null and ${table.resultingExtractionRevisionId} is not null and ${table.valueState} is not null)
    )`),
    noteBound: check("ai_extraction_decisions_note_bound", sql`${table.researcherNote} is null or (btrim(${table.researcherNote}) <> '' and char_length(${table.researcherNote}) <= 20000)`),
  }),
);

export const aiExtractionDecisionEvidence = pgTable(
  "ai_extraction_decision_evidence",
  {
    projectId: uuid("project_id").notNull(),
    decisionId: uuid("decision_id").notNull(),
    groundingId: uuid("grounding_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    evidenceMode: text("evidence_mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.decisionId, table.groundingId] }),
    evidenceIdentity: unique("ai_extraction_decision_evidence_project_decision_evidence_unique").on(table.projectId, table.decisionId, table.evidenceId),
    decisionOwnership: foreignKey({ columns: [table.projectId, table.decisionId], foreignColumns: [aiExtractionDecisions.projectId, aiExtractionDecisions.id], name: "ai_extraction_decision_evidence_decision_fk" }).onDelete("restrict"),
    groundingOwnership: foreignKey({ columns: [table.projectId, table.groundingId], foreignColumns: [aiExtractionResultGroundings.projectId, aiExtractionResultGroundings.id], name: "ai_extraction_decision_evidence_grounding_fk" }).onDelete("restrict"),
    evidenceOwnership: foreignKey({ columns: [table.projectId, table.evidenceId], foreignColumns: [evidence.projectId, evidence.id], name: "ai_extraction_decision_evidence_evidence_fk" }).onDelete("restrict"),
    modeValid: check("ai_extraction_decision_evidence_mode_valid", sql`${table.evidenceMode} in ('fresh', 'reused')`),
  }),
);

// Slice 31 AI extraction batches are orchestration history only. They pin the
// researcher-confirmed preview and may link to Slice 26 requests/dispatches;
// they never replace the Slice 26 acceptance authority. Lifecycle state is
// derived from cancellation, item terminal facts, and Slice 26 rows rather
// than duplicated as a mutable batch status column.
export const aiExtractionBatches = pgTable(
  "ai_extraction_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    provider: text("provider").notNull().default("openai"),
    configuredModel: text("configured_model").notNull(),
    configuredReasoningEffort: text("configured_reasoning_effort").notNull().default("low"),
    selectionPolicyVersion: text("selection_policy_version").notNull(),
    batchDisclosureVersion: text("batch_disclosure_version").notNull(),
    requestDisclosureVersion: text("request_disclosure_version").notNull(),
    externalTransmissionAcknowledged: boolean("external_transmission_acknowledged").notNull(),
    paperCount: integer("paper_count").notNull(),
    fieldCount: integer("field_count").notNull(),
    cellCount: integer("cell_count").notNull(),
    executableCount: integer("executable_count").notNull(),
    manifestAlgorithmVersion: text("manifest_algorithm_version").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_batches_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("ai_extraction_batches_project_created_at_idx").on(table.projectId, table.createdAt),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "ai_extraction_batches_project_fk" }).onDelete("restrict"),
    providerValid: check("ai_extraction_batches_provider_valid", sql`${table.provider} = 'openai'`),
    modelShape: check("ai_extraction_batches_model_shape", sql`btrim(${table.configuredModel}) <> '' and char_length(${table.configuredModel}) <= 200`),
    reasoningValid: check("ai_extraction_batches_reasoning_valid", sql`${table.configuredReasoningEffort} = 'low'`),
    versionShape: check("ai_extraction_batches_version_shape", sql`btrim(${table.selectionPolicyVersion}) <> '' and btrim(${table.batchDisclosureVersion}) <> '' and btrim(${table.requestDisclosureVersion}) <> '' and btrim(${table.manifestAlgorithmVersion}) <> ''`),
    acknowledgement: check("ai_extraction_batches_transmission_acknowledged", sql`${table.externalTransmissionAcknowledged} = true`),
    countBounds: check("ai_extraction_batches_count_bounds", sql`${table.paperCount} >= 1 and ${table.paperCount} <= 100 and ${table.fieldCount} >= 1 and ${table.fieldCount} <= 25 and ${table.cellCount} >= 1 and ${table.cellCount} <= 500 and ${table.executableCount} >= 0 and ${table.executableCount} <= ${table.cellCount}`),
    hashShape: check("ai_extraction_batches_manifest_hash_shape", sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const aiExtractionBatchItems = pgTable(
  "ai_extraction_batch_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    itemOrdinal: integer("item_ordinal").notNull(),
    paperId: uuid("paper_id").notNull(),
    extractionFieldId: uuid("extraction_field_id").notNull(),
    expectedCurrentExtractionRevisionId: uuid("expected_current_extraction_revision_id"),
    titleAbstractDecisionId: uuid("title_abstract_decision_id"),
    fullTextDecisionId: uuid("full_text_decision_id"),
    fullTextDocumentId: uuid("full_text_document_id"),
    documentTextExtractionId: uuid("document_text_extraction_id"),
    initialDisposition: text("initial_disposition").notNull(),
    initialReasonCode: text("initial_reason_code").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    expectedRequestIntentHash: text("expected_request_intent_hash"),
    fieldDefinitionHash: text("field_definition_hash").notNull(),
    optionSnapshotHash: text("option_snapshot_hash").notNull(),
    paperTitleSnapshot: text("paper_title_snapshot").notNull(),
    paperAbstractSnapshot: text("paper_abstract_snapshot"),
    fieldNameSnapshot: text("field_name_snapshot").notNull(),
    fieldDescriptionSnapshot: text("field_description_snapshot"),
    fieldTypeSnapshot: text("field_type_snapshot").notNull(),
    fieldRequiredSnapshot: boolean("field_required_snapshot").notNull(),
    fieldOptionSnapshot: jsonb("field_option_snapshot").notNull().default([]),
    documentFilenameSnapshot: text("document_filename_snapshot"),
    extractionSequenceSnapshot: bigint("extraction_sequence_snapshot", { mode: "number" }),
    extractionStatusSnapshot: text("extraction_status_snapshot"),
    pageManifest: jsonb("page_manifest").notNull().default([]),
    pageManifestHash: text("page_manifest_hash").notNull(),
    pageCount: integer("page_count").notNull(),
    sourceCharacterCount: integer("source_character_count").notNull(),
    sourceByteSize: integer("source_byte_size").notNull(),
    itemManifestHash: text("item_manifest_hash").notNull(),
    aiExtractionRequestId: uuid("ai_extraction_request_id"),
    requestRelationship: text("request_relationship"),
    orchestrationTerminalCode: text("orchestration_terminal_code"),
    orchestrationTerminalDetail: text("orchestration_terminal_detail"),
    orchestrationFinalizedAt: timestamp("orchestration_finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_extraction_batch_items_project_id_id_unique").on(table.projectId, table.id),
    batchOrdinal: unique("ai_extraction_batch_items_project_batch_ordinal_unique").on(table.projectId, table.batchId, table.itemOrdinal),
    batchPaperField: unique("ai_extraction_batch_items_project_batch_paper_field_unique").on(table.projectId, table.batchId, table.paperId, table.extractionFieldId),
    batchIdempotency: unique("ai_extraction_batch_items_project_batch_idempotency_unique").on(table.projectId, table.batchId, table.idempotencyKey),
    batchOrder: index("ai_extraction_batch_items_project_batch_ordinal_idx").on(table.projectId, table.batchId, table.itemOrdinal),
    paperOrder: index("ai_extraction_batch_items_project_paper_idx").on(table.projectId, table.paperId, table.itemOrdinal),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "ai_extraction_batch_items_project_fk" }).onDelete("restrict"),
    batchOwnership: foreignKey({ columns: [table.projectId, table.batchId], foreignColumns: [aiExtractionBatches.projectId, aiExtractionBatches.id], name: "ai_extraction_batch_items_batch_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "ai_extraction_batch_items_paper_fk" }).onDelete("restrict"),
    fieldOwnership: foreignKey({ columns: [table.projectId, table.extractionFieldId], foreignColumns: [extractionFields.projectId, extractionFields.id], name: "ai_extraction_batch_items_field_fk" }).onDelete("restrict"),
    documentOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.fullTextDocumentId], foreignColumns: [fullTextDocuments.projectId, fullTextDocuments.paperId, fullTextDocuments.id], name: "ai_extraction_batch_items_document_fk" }).onDelete("restrict"),
    extractionOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.documentTextExtractionId], foreignColumns: [documentTextExtractions.projectId, documentTextExtractions.paperId, documentTextExtractions.id], name: "ai_extraction_batch_items_extraction_fk" }).onDelete("restrict"),
    baselineRevisionOwnership: foreignKey({ columns: [table.projectId, table.expectedCurrentExtractionRevisionId], foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id], name: "ai_extraction_batch_items_baseline_revision_fk" }).onDelete("restrict"),
    requestOwnership: foreignKey({ columns: [table.projectId, table.aiExtractionRequestId], foreignColumns: [aiExtractionRequests.projectId, aiExtractionRequests.id], name: "ai_extraction_batch_items_request_fk" }).onDelete("restrict"),
    ordinalValid: check("ai_extraction_batch_items_ordinal_valid", sql`${table.itemOrdinal} >= 0 and ${table.itemOrdinal} < 500`),
    dispositionValid: check("ai_extraction_batch_items_disposition_valid", sql`${table.initialDisposition} in ('executable', 'reusable', 'blocked', 'ineligible')`),
    reasonShape: check("ai_extraction_batch_items_reason_shape", sql`btrim(${table.initialReasonCode}) <> '' and char_length(${table.initialReasonCode}) <= 100`),
    fieldTypeValid: check("ai_extraction_batch_items_field_type_valid", sql`${table.fieldTypeSnapshot} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    titleAbstractDecisionOwnership: foreignKey({ columns: [table.projectId, table.titleAbstractDecisionId], foreignColumns: [screeningDecisions.projectId, screeningDecisions.id], name: "ai_extraction_batch_items_title_abstract_decision_fk" }).onDelete("restrict"),
    fullTextDecisionOwnership: foreignKey({ columns: [table.projectId, table.fullTextDecisionId], foreignColumns: [fullTextScreeningDecisions.projectId, fullTextScreeningDecisions.id], name: "ai_extraction_batch_items_full_text_decision_fk" }).onDelete("restrict"),
    hashShape: check("ai_extraction_batch_items_hash_shape", sql`${table.fieldDefinitionHash} ~ '^[0-9a-f]{64}$' and ${table.optionSnapshotHash} ~ '^[0-9a-f]{64}$' and ${table.pageManifestHash} ~ '^[0-9a-f]{64}$' and ${table.itemManifestHash} ~ '^[0-9a-f]{64}$' and (${table.expectedRequestIntentHash} is null or ${table.expectedRequestIntentHash} ~ '^[0-9a-f]{64}$')`),
    manifestArray: check("ai_extraction_batch_items_page_manifest_array", sql`jsonb_typeof(${table.pageManifest}) = 'array'`),
    pageCountBounds: check("ai_extraction_batch_items_page_count_bounds", sql`${table.pageCount} >= 0 and ${table.pageCount} <= 40`),
    sourceCountBounds: check("ai_extraction_batch_items_source_count_bounds", sql`${table.sourceCharacterCount} >= 0 and ${table.sourceCharacterCount} <= 80000 and ${table.sourceByteSize} >= 0 and ${table.sourceByteSize} <= 327680`),
    sourceIdentityShape: check("ai_extraction_batch_items_source_identity_shape", sql`(
      (${table.initialDisposition} in ('executable', 'reusable') and ${table.fullTextDocumentId} is not null and ${table.documentTextExtractionId} is not null and ${table.extractionSequenceSnapshot} is not null and ${table.extractionStatusSnapshot} is not null and ${table.pageCount} > 0 and ${table.sourceCharacterCount} > 0 and ${table.sourceByteSize} > 0)
      or ${table.initialDisposition} in ('blocked', 'ineligible')
    )`),
    requestRelationshipValid: check("ai_extraction_batch_items_request_relationship_valid", sql`${table.requestRelationship} is null or ${table.requestRelationship} in ('authoritative', 'blocking')`),
    requestLinkShape: check("ai_extraction_batch_items_request_link_shape", sql`(${table.aiExtractionRequestId} is null and ${table.requestRelationship} is null) or (${table.aiExtractionRequestId} is not null and ${table.requestRelationship} is not null)`),
    terminalShape: check("ai_extraction_batch_items_terminal_shape", sql`(${table.orchestrationTerminalCode} is null and ${table.orchestrationFinalizedAt} is null) or (${table.orchestrationTerminalCode} is not null and ${table.orchestrationFinalizedAt} is not null)`),
  }),
);

export const bibliographicImports = pgTable(
  "bibliographic_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    format: text("format").notNull(),
    filename: text("filename").notNull(),
    sourceBytes: bytea("source_bytes").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceByteSize: integer("source_byte_size").notNull(),
    parserVersion: text("parser_version").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    mappingVersion: text("mapping_version").notNull(),
    status: text("status").notNull().default("pending"),
    expectedRecordCount: integer("expected_record_count").notNull(),
    diagnostics: jsonb("diagnostics").notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("bibliographic_imports_project_id_id_unique").on(table.projectId, table.id),
    projectFormatHashIdentity: unique("bibliographic_imports_project_format_sha256_unique").on(table.projectId, table.format, table.sourceSha256),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "bibliographic_imports_project_fk" }).onDelete("restrict"),
    formatNonblank: check("bibliographic_imports_format_nonblank", sql`btrim(${table.format}) <> ''`),
    formatValid: check("bibliographic_imports_format_valid", sql`${table.format} in ('bibtex', 'ris')`),
    filenameNonblank: check("bibliographic_imports_filename_nonblank", sql`btrim(${table.filename}) <> ''`),
    filenameLength: check("bibliographic_imports_filename_length", sql`char_length(${table.filename}) <= 500`),
    sourceSizeBound: check("bibliographic_imports_source_size_bound", sql`octet_length(${table.sourceBytes}) > 0 and octet_length(${table.sourceBytes}) <= 2097152 and ${table.sourceByteSize} = octet_length(${table.sourceBytes})`),
    versionShape: check("bibliographic_imports_version_shape", sql`btrim(${table.parserVersion}) <> '' and btrim(${table.adapterVersion}) <> '' and btrim(${table.mappingVersion}) <> ''`),
    sha256Shape: check("bibliographic_imports_sha256_shape", sql`${table.sourceSha256} ~ '^[0-9a-f]{64}$'`),
    statusValid: check("bibliographic_imports_status_valid", sql`${table.status} in ('pending', 'parsing', 'complete', 'parsed', 'failed', 'finalized')`),
    recordCountValid: check("bibliographic_imports_record_count_valid", sql`${table.expectedRecordCount} >= 0 and ${table.expectedRecordCount} <= 1000`),
    errorShape: check("bibliographic_imports_error_shape", sql`((${table.status} = 'failed' and ${table.errorCode} is not null and btrim(${table.errorCode}) <> '') or (${table.status} <> 'failed' and ${table.errorCode} is null))`),
    errorMessageBound: check("bibliographic_imports_error_message_bound", sql`${table.errorMessage} is null or char_length(${table.errorMessage}) <= 2000`),
    finalizationShape: check("bibliographic_imports_finalization_shape", sql`((${table.status} in ('finalized', 'failed') and ${table.finalizedAt} is not null) or (${table.status} not in ('finalized', 'failed') and ${table.finalizedAt} is null))`),
    createdAtIndex: index("bibliographic_imports_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const bibliographicImportRecords = pgTable(
  "bibliographic_import_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    importId: uuid("import_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    sourceKey: text("source_key"),
    sourceType: text("source_type"),
    title: text("title"),
    authors: text("authors").array().notNull().default([]),
    abstract: text("abstract"),
    doi: text("doi"),
    url: text("url"),
    publicationYear: integer("publication_year"),
    venue: text("venue"),
    startByte: integer("start_byte").notNull(),
    endByte: integer("end_byte").notNull(),
    parseOutcome: text("parse_outcome").notNull().default("parsed"),
    fieldStates: jsonb("field_states").notNull().default({}),
    diagnostics: jsonb("diagnostics").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("bibliographic_import_records_project_id_id_unique").on(table.projectId, table.id),
    importOrdinal: unique("bibliographic_import_records_project_import_ordinal_unique").on(table.projectId, table.importId, table.ordinal),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "bibliographic_import_records_project_fk" }).onDelete("restrict"),
    importOwnership: foreignKey({ columns: [table.projectId, table.importId], foreignColumns: [bibliographicImports.projectId, bibliographicImports.id], name: "bibliographic_import_records_import_fk" }).onDelete("restrict"),
    importOrdinalIndex: index("bibliographic_import_records_project_import_ordinal_idx").on(table.projectId, table.importId, table.ordinal),
    doiComparison: index("bibliographic_import_records_project_doi_comparison_idx").using("btree", table.projectId, sql`lower(regexp_replace(regexp_replace(btrim(${table.doi}), '^https?://(dx[.])?doi[.]org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))`).where(sql`${table.doi} is not null and btrim(${table.doi}) <> ''`),
    titleComparison: index("bibliographic_import_records_project_title_comparison_idx").using("btree", table.projectId, sql`lower(regexp_replace(btrim(${table.title}), '[[:space:]]+', ' ', 'g'))`, table.publicationYear),
    ordinalValid: check("bibliographic_import_records_ordinal_valid", sql`${table.ordinal} >= 0`),
    sourceKeyNonblank: check("bibliographic_import_records_source_key_nonblank", sql`${table.sourceKey} is null or btrim(${table.sourceKey}) <> ''`),
    sourceTypeNonblank: check("bibliographic_import_records_source_type_nonblank", sql`${table.sourceType} is null or btrim(${table.sourceType}) <> ''`),
    titleNonblank: check("bibliographic_import_records_title_nonblank", sql`((${table.title} is null and ${table.parseOutcome} in ('parsed_with_warnings', 'failed')) or (${table.title} is not null and btrim(${table.title}) <> ''))`),
    yearValid: check("bibliographic_import_records_year_valid", sql`${table.publicationYear} is null or (${table.publicationYear} >= 1000 and ${table.publicationYear} <= 3000)`),
    venueNonblank: check("bibliographic_import_records_venue_nonblank", sql`${table.venue} is null or btrim(${table.venue}) <> ''`),
    spanShape: check("bibliographic_import_records_span_shape", sql`${table.startByte} >= 0 and ${table.endByte} > ${table.startByte}`),
    parseOutcomeValid: check("bibliographic_import_records_parse_outcome_valid", sql`${table.parseOutcome} in ('parsed', 'parsed_with_warnings', 'failed')`),
    finalizationShape: check("bibliographic_import_records_finalization_shape", sql`${table.finalizedAt} is null or ${table.parseOutcome} <> 'failed'`),
  }),
);

export const bibliographicImportResolutions = pgTable(
  "bibliographic_import_resolutions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    importId: uuid("import_id").notNull(),
    recordId: uuid("record_id").notNull(),
    eventType: text("event_type").notNull(),
    paperId: uuid("paper_id"),
    expectedPreviousResolutionId: uuid("expected_previous_resolution_id"),
    creationPayload: jsonb("creation_payload"),
    candidatePaperId: uuid("candidate_paper_id"),
    candidateRank: integer("candidate_rank"),
    candidateReason: text("candidate_reason"),
    candidateDoi: text("candidate_doi"),
    candidateTitle: text("candidate_title"),
    candidatePublicationYear: integer("candidate_publication_year"),
    candidateVenue: text("candidate_venue"),
    candidateContext: jsonb("candidate_context"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("bibliographic_import_resolutions_project_id_id_unique").on(table.projectId, table.id),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "bibliographic_import_resolutions_project_fk" }).onDelete("restrict"),
    recordOwnership: foreignKey({ columns: [table.projectId, table.recordId], foreignColumns: [bibliographicImportRecords.projectId, bibliographicImportRecords.id], name: "bibliographic_import_resolutions_record_fk" }).onDelete("restrict"),
    importOwnership: foreignKey({ columns: [table.projectId, table.importId], foreignColumns: [bibliographicImports.projectId, bibliographicImports.id], name: "bibliographic_import_resolutions_import_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "bibliographic_import_resolutions_paper_fk" }).onDelete("restrict"),
    candidatePaperOwnership: foreignKey({ columns: [table.projectId, table.candidatePaperId], foreignColumns: [papers.projectId, papers.id], name: "bibliographic_import_resolutions_candidate_paper_fk" }).onDelete("restrict"),
    expectedPreviousOwnership: foreignKey({ columns: [table.projectId, table.expectedPreviousResolutionId], foreignColumns: [table.projectId, table.id], name: "bibliographic_import_resolutions_expected_previous_fk" }).onDelete("restrict"),
    recordSequence: index("bibliographic_import_resolutions_project_record_sequence_idx").on(table.projectId, table.recordId, table.sequence),
    importSequence: index("bibliographic_import_resolutions_project_import_sequence_idx").on(table.projectId, table.importId, table.sequence),
    eventTypeValid: check("bibliographic_import_resolutions_event_type_valid", sql`${table.eventType} in ('created_paper', 'matched_paper', 'cleared')`),
    paperShape: check("bibliographic_import_resolutions_paper_shape", sql`((${table.eventType} in ('created_paper', 'matched_paper') and ${table.paperId} is not null) or (${table.eventType} = 'cleared' and ${table.paperId} is null))`),
    creationPayloadShape: check("bibliographic_import_resolutions_creation_payload_shape", sql`((${table.eventType} = 'created_paper' and ${table.creationPayload} is not null) or (${table.eventType} <> 'created_paper' and ${table.creationPayload} is null))`),
    candidateRankValid: check("bibliographic_import_resolutions_candidate_rank_valid", sql`${table.candidateRank} is null or ${table.candidateRank} > 0`),
    candidateReasonShape: check("bibliographic_import_resolutions_candidate_reason_shape", sql`${table.candidateReason} is null or (btrim(${table.candidateReason}) <> '' and char_length(${table.candidateReason}) <= 1000)`),
    candidateYearValid: check("bibliographic_import_resolutions_candidate_year_valid", sql`${table.candidatePublicationYear} is null or (${table.candidatePublicationYear} >= 1000 and ${table.candidatePublicationYear} <= 3000)`),
    noteShape: check("bibliographic_import_resolutions_note_shape", sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`),
  }),
);

export const pdfIntakes = pgTable(
  "pdf_intakes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("pdf_intakes_project_id_id_unique").on(table.projectId, table.id),
    projectSha256Identity: unique("pdf_intakes_project_sha256_unique").on(table.projectId, table.sha256),
    storageKeyUnique: unique("pdf_intakes_storage_key_unique").on(table.storageKey),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "pdf_intakes_project_fk" }).onDelete("restrict"),
    storageKeyNonblank: check("pdf_intakes_storage_key_nonblank", sql`btrim(${table.storageKey}) <> ''`),
    storageKeyFormat: check("pdf_intakes_storage_key_format", sql`${table.storageKey} ~ '^projects/[0-9a-f-]{36}/pdf-intakes/[0-9a-f-]{36}/source\\.pdf$'`),
    filenameNonblank: check("pdf_intakes_filename_nonblank", sql`btrim(${table.originalFilename}) <> ''`),
    filenameLength: check("pdf_intakes_filename_length", sql`char_length(${table.originalFilename}) <= 500`),
    mediaTypePdf: check("pdf_intakes_media_type_pdf", sql`${table.mediaType} = 'application/pdf'`),
    byteSizeBound: check("pdf_intakes_byte_size_bound", sql`${table.byteSize} > 0 and ${table.byteSize} <= 52428800`),
    sha256Format: check("pdf_intakes_sha256_format", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    createdAtIndex: index("pdf_intakes_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const pdfIntakeMetadataResults = pgTable(
  "pdf_intake_metadata_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequenceNo: bigint("sequence_no", { mode: "number" }).notNull(),
    projectId: uuid("project_id").notNull(),
    intakeId: uuid("intake_id").notNull(),
    status: text("status").notNull(),
    extractorKey: text("extractor_key").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    pdfjsVersion: text("pdfjs_version"),
    mappingVersion: text("mapping_version").notNull(),
    textScanVersion: text("text_scan_version").notNull(),
    doiAlgorithmVersion: text("doi_algorithm_version").notNull(),
    pageCount: integer("page_count"),
    attemptedPageCount: integer("attempted_page_count").notNull(),
    succeededPageCount: integer("succeeded_page_count").notNull(),
    scannedCodePoints: integer("scanned_code_points").notNull(),
    diagnostics: jsonb("diagnostics").notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("pdf_intake_metadata_results_project_id_id_unique").on(table.projectId, table.id),
    intakeSequenceIdentity: unique("pdf_intake_metadata_results_project_intake_sequence_no_unique").on(table.projectId, table.intakeId, table.sequenceNo),
    intakeSequence: index("pdf_intake_metadata_results_project_intake_sequence_no_idx").on(table.projectId, table.intakeId, table.sequenceNo),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "pdf_intake_metadata_results_project_fk" }).onDelete("restrict"),
    intakeOwnership: foreignKey({ columns: [table.projectId, table.intakeId], foreignColumns: [pdfIntakes.projectId, pdfIntakes.id], name: "pdf_intake_metadata_results_intake_fk" }).onDelete("restrict"),
    statusValid: check("pdf_intake_metadata_results_status_valid", sql`${table.status} in ('succeeded', 'partial', 'failed')`),
    extractorKeyNonblank: check("pdf_intake_metadata_results_extractor_key_nonblank", sql`btrim(${table.extractorKey}) <> ''`),
    versionShape: check("pdf_intake_metadata_results_version_shape", sql`btrim(${table.extractorVersion}) <> '' and (${table.pdfjsVersion} is null or btrim(${table.pdfjsVersion}) <> '') and btrim(${table.mappingVersion}) <> '' and btrim(${table.textScanVersion}) <> '' and btrim(${table.doiAlgorithmVersion}) <> ''`),
    pageCountsValid: check("pdf_intake_metadata_results_page_counts_valid", sql`${table.pageCount} is null or (${table.pageCount} >= 0 and ${table.attemptedPageCount} >= 0 and ${table.succeededPageCount} >= 0 and ${table.succeededPageCount} <= ${table.attemptedPageCount} and ${table.attemptedPageCount} <= ${table.pageCount})`),
    scannedCodePointsValid: check("pdf_intake_metadata_results_scanned_code_points_valid", sql`${table.scannedCodePoints} >= 0 and ${table.scannedCodePoints} <= 250000`),
    errorShape: check("pdf_intake_metadata_results_error_shape", sql`((${table.status} = 'failed' and ${table.errorCode} is not null and btrim(${table.errorCode}) <> '') or (${table.status} <> 'failed' and ${table.errorCode} is null))`),
    errorMessageBound: check("pdf_intake_metadata_results_error_message_bound", sql`${table.errorMessage} is null or char_length(${table.errorMessage}) <= 2000`),
    createdAtIndex: index("pdf_intake_metadata_results_project_created_at_idx").on(table.projectId, table.createdAt),
  }),
);

export const pdfIntakeMetadataFields = pgTable(
  "pdf_intake_metadata_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    intakeId: uuid("intake_id").notNull(),
    resultId: uuid("result_id").notNull(),
    paperField: text("paper_field").notNull(),
    candidateOrdinal: integer("candidate_ordinal").notNull(),
    valueJsonb: jsonb("value_jsonb"),
    sourceKind: text("source_kind"),
    sourceLocator: text("source_locator"),
    classification: text("classification").notNull(),
    diagnostic: text("diagnostic"),
    normalizedValue: text("normalized_value"),
    pageNumber: integer("page_number"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    exactMatch: text("exact_match"),
    pageTextSha256: text("page_text_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("pdf_intake_metadata_fields_project_id_id_unique").on(table.projectId, table.id),
    resultCandidateIdentity: unique("pdf_intake_metadata_fields_project_intake_result_unique").on(table.projectId, table.intakeId, table.resultId, table.paperField, table.candidateOrdinal),
    resultOrder: index("pdf_intake_metadata_fields_project_result_order_idx").on(table.projectId, table.resultId, table.paperField, table.candidateOrdinal),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "pdf_intake_metadata_fields_project_fk" }).onDelete("restrict"),
    intakeOwnership: foreignKey({ columns: [table.projectId, table.intakeId], foreignColumns: [pdfIntakes.projectId, pdfIntakes.id], name: "pdf_intake_metadata_fields_intake_fk" }).onDelete("restrict"),
    resultOwnership: foreignKey({ columns: [table.projectId, table.resultId], foreignColumns: [pdfIntakeMetadataResults.projectId, pdfIntakeMetadataResults.id], name: "pdf_intake_metadata_fields_result_fk" }).onDelete("restrict"),
    paperFieldValid: check("pdf_intake_metadata_fields_paper_field_valid", sql`${table.paperField} in ('title', 'authors', 'publication_year', 'venue', 'doi', 'abstract')`),
    candidateOrdinalValid: check("pdf_intake_metadata_fields_candidate_ordinal_valid", sql`${table.candidateOrdinal} > 0`),
    sourceKindValid: check("pdf_intake_metadata_fields_source_kind_valid", sql`${table.sourceKind} is null or ${table.sourceKind} in ('pdf_info', 'xmp', 'page_text_match', 'unavailable')`),
    classificationValid: check("pdf_intake_metadata_fields_classification_valid", sql`${table.classification} in ('exact_embedded_metadata', 'exact_text_identifier', 'ambiguous', 'unavailable')`),
    sourceLocatorShape: check("pdf_intake_metadata_fields_source_locator_shape", sql`${table.sourceLocator} is null or btrim(${table.sourceLocator}) <> ''`),
    pageNumberValid: check("pdf_intake_metadata_fields_page_number_valid", sql`${table.pageNumber} is null or ${table.pageNumber} > 0`),
    offsetShape: check("pdf_intake_metadata_fields_offset_shape", sql`((${table.startOffset} is null and ${table.endOffset} is null) or (${table.startOffset} is not null and ${table.endOffset} is not null and ${table.startOffset} >= 0 and ${table.endOffset} > ${table.startOffset}))`),
    exactMatchShape: check("pdf_intake_metadata_fields_exact_match_shape", sql`${table.exactMatch} is null or btrim(${table.exactMatch}) <> ''`),
    pageTextSha256Format: check("pdf_intake_metadata_fields_page_text_sha256_format", sql`${table.pageTextSha256} is null or ${table.pageTextSha256} ~ '^[0-9a-f]{64}$'`),
    pageMatchProvenanceShape: check("pdf_intake_metadata_fields_page_match_provenance_shape", sql`${table.sourceKind} is distinct from 'page_text_match' or (${table.pageNumber} is not null and ${table.startOffset} is not null and ${table.endOffset} is not null and ${table.exactMatch} is not null and ${table.pageTextSha256} is not null)`),
    unavailableShape: check("pdf_intake_metadata_fields_unavailable_shape", sql`(${table.classification} <> 'unavailable' or (${table.valueJsonb} is null and ${table.normalizedValue} is null and ${table.pageNumber} is null and ${table.startOffset} is null and ${table.endOffset} is null and ${table.exactMatch} is null and ${table.pageTextSha256} is null))`),
  }),
);

export const pdfIntakeResolutions = pgTable(
  "pdf_intake_resolutions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequenceNo: bigint("sequence_no", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    intakeId: uuid("intake_id").notNull(),
    metadataResultId: uuid("metadata_result_id").notNull(),
    resolutionKind: text("resolution_kind").notNull(),
    paperId: uuid("paper_id").notNull(),
    fullTextDocumentId: uuid("full_text_document_id").notNull(),
    materializationKind: text("materialization_kind").notNull(),
    creationPayload: jsonb("creation_payload"),
    candidateContext: jsonb("candidate_context").notNull().default({}),
    previewFingerprint: text("preview_fingerprint").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("pdf_intake_resolutions_project_id_id_unique").on(table.projectId, table.id),
    intakeIdentity: unique("pdf_intake_resolutions_project_intake_unique").on(table.projectId, table.intakeId),
    projectSequence: index("pdf_intake_resolutions_project_sequence_no_idx").on(table.projectId, table.sequenceNo),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "pdf_intake_resolutions_project_fk" }).onDelete("restrict"),
    intakeOwnership: foreignKey({ columns: [table.projectId, table.intakeId], foreignColumns: [pdfIntakes.projectId, pdfIntakes.id], name: "pdf_intake_resolutions_intake_fk" }).onDelete("restrict"),
    metadataResultOwnership: foreignKey({ columns: [table.projectId, table.metadataResultId], foreignColumns: [pdfIntakeMetadataResults.projectId, pdfIntakeMetadataResults.id], name: "pdf_intake_resolutions_metadata_result_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "pdf_intake_resolutions_paper_fk" }).onDelete("restrict"),
    fullTextDocumentOwnership: foreignKey({ columns: [table.projectId, table.fullTextDocumentId], foreignColumns: [fullTextDocuments.projectId, fullTextDocuments.id], name: "pdf_intake_resolutions_full_text_document_fk" }).onDelete("restrict"),
    resolutionKindValid: check("pdf_intake_resolutions_resolution_kind_valid", sql`${table.resolutionKind} in ('create_paper', 'match_paper')`),
    materializationKindValid: check("pdf_intake_resolutions_materialization_kind_valid", sql`${table.materializationKind} in ('created_document', 'reused_document')`),
    creationPayloadShape: check("pdf_intake_resolutions_creation_payload_shape", sql`((${table.resolutionKind} = 'create_paper' and ${table.creationPayload} is not null) or (${table.resolutionKind} = 'match_paper' and ${table.creationPayload} is null))`),
    candidateContextShape: check("pdf_intake_resolutions_candidate_context_shape", sql`${table.candidateContext} is not null`),
    previewFingerprintShape: check("pdf_intake_resolutions_preview_fingerprint_shape", sql`${table.previewFingerprint} ~ '^[0-9a-f]{64}$'`),
    requestFingerprintShape: check("pdf_intake_resolutions_request_fingerprint_shape", sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const aiSynthesisRequests = pgTable(
  "ai_synthesis_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    projectTitleSnapshot: text("project_title_snapshot").notNull(),
    preparationId: uuid("preparation_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    evidenceSetCompositionRevisionId: uuid("evidence_set_composition_revision_id").notNull(),
    extractionFieldId: uuid("extraction_field_id").notNull(),
    targetSynthesisStatementId: uuid("target_synthesis_statement_id"),
    targetBaselineSynthesisRevisionId: uuid("target_baseline_synthesis_revision_id"),
    targetTitleSnapshot: text("target_title_snapshot"),
    targetStatementTextSnapshot: text("target_statement_text_snapshot"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    sourceStateHash: text("source_state_hash").notNull(),
    intentHash: text("intent_hash").notNull(),
    fieldNameSnapshot: text("field_name_snapshot").notNull(),
    fieldDescriptionSnapshot: text("field_description_snapshot"),
    fieldType: text("field_type").notNull(),
    provider: text("provider").notNull(),
    configuredModel: text("configured_model").notNull(),
    configuredReasoningEffort: text("configured_reasoning_effort").notNull(),
    promptVersion: text("prompt_version").notNull(),
    responseSchemaVersion: text("response_schema_version").notNull(),
    groundingResolverVersion: text("grounding_resolver_version").notNull(),
    contextSelectionVersion: text("context_selection_version").notNull(),
    sourceCoverageState: text("source_coverage_state").notNull().default("complete"),
    supportCount: integer("support_count").notNull(),
    sourceCount: integer("source_count").notNull(),
    sourceCharacterCount: integer("source_character_count").notNull(),
    sourceByteSize: integer("source_byte_size").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    externalTransmissionAcknowledged: boolean("external_transmission_acknowledged").notNull(),
    disclosureVersion: text("disclosure_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    undispatchedExpiresAt: timestamp("undispatched_expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_synthesis_requests_project_id_id_unique").on(table.projectId, table.id),
    projectIdempotency: unique("ai_synthesis_requests_project_idempotency_key_unique").on(table.projectId, table.idempotencyKey),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "ai_synthesis_requests_project_fk" }).onDelete("restrict"),
    preparationOwnership: foreignKey({ columns: [table.projectId, table.preparationId], foreignColumns: [synthesisPreparations.projectId, synthesisPreparations.id], name: "ai_synthesis_requests_preparation_fk" }).onDelete("restrict"),
    evidenceSetOwnership: foreignKey({ columns: [table.projectId, table.evidenceSetId], foreignColumns: [evidenceSets.projectId, evidenceSets.id], name: "ai_synthesis_requests_evidence_set_fk" }).onDelete("restrict"),
    compositionOwnership: foreignKey({ columns: [table.projectId, table.evidenceSetId, table.evidenceSetCompositionRevisionId], foreignColumns: [evidenceSetCompositionRevisions.projectId, evidenceSetCompositionRevisions.evidenceSetId, evidenceSetCompositionRevisions.id], name: "ai_synthesis_requests_composition_revision_fk" }).onDelete("restrict"),
    fieldOwnership: foreignKey({ columns: [table.projectId, table.extractionFieldId], foreignColumns: [extractionFields.projectId, extractionFields.id], name: "ai_synthesis_requests_field_fk" }).onDelete("restrict"),
    targetStatementOwnership: foreignKey({ columns: [table.projectId, table.targetSynthesisStatementId], foreignColumns: [synthesisStatements.projectId, synthesisStatements.id], name: "ai_synthesis_requests_target_statement_fk" }).onDelete("restrict"),
    targetBaselineOwnership: foreignKey({ columns: [table.projectId, table.targetSynthesisStatementId, table.targetBaselineSynthesisRevisionId], foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.synthesisStatementId, synthesisRevisions.id], name: "ai_synthesis_requests_target_baseline_fk" }).onDelete("restrict"),
    fieldTypeValid: check("ai_synthesis_requests_field_type_valid", sql`${table.fieldType} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    sourceCoverageValid: check("ai_synthesis_requests_source_coverage_valid", sql`${table.sourceCoverageState} = 'complete'`),
    countBounds: check("ai_synthesis_requests_count_bounds", sql`${table.supportCount} >= 1 and ${table.supportCount} <= 20 and ${table.sourceCount} >= 1 and ${table.sourceCount} <= 80`),
    sourceBounds: check("ai_synthesis_requests_source_bounds", sql`${table.sourceCharacterCount} >= 1 and ${table.sourceCharacterCount} <= 80000 and ${table.sourceByteSize} >= 1 and ${table.sourceByteSize} <= 327680`),
    hashShape: check("ai_synthesis_requests_hash_shape", sql`${table.sourceStateHash} ~ '^[0-9a-f]{64}$' and ${table.intentHash} ~ '^[0-9a-f]{64}$' and ${table.sourceManifestHash} ~ '^[0-9a-f]{64}$'`),
    textBounds: check("ai_synthesis_requests_text_bounds", sql`char_length(${table.projectTitleSnapshot}) between 1 and 500 and char_length(${table.fieldNameSnapshot}) between 1 and 500 and (${table.fieldDescriptionSnapshot} is null or char_length(${table.fieldDescriptionSnapshot}) <= 2000) and (${table.targetTitleSnapshot} is null or char_length(${table.targetTitleSnapshot}) <= 500) and (${table.targetStatementTextSnapshot} is null or char_length(${table.targetStatementTextSnapshot}) <= 10000)`),
    nonblankConfig: check("ai_synthesis_requests_config_nonblank", sql`btrim(${table.provider}) <> '' and char_length(${table.provider}) <= 100 and btrim(${table.configuredModel}) <> '' and char_length(${table.configuredModel}) <= 200 and btrim(${table.configuredReasoningEffort}) <> ''`),
    versionsShape: check("ai_synthesis_requests_versions_shape", sql`btrim(${table.promptVersion}) <> '' and char_length(${table.promptVersion}) <= 100 and btrim(${table.responseSchemaVersion}) <> '' and char_length(${table.responseSchemaVersion}) <= 100 and btrim(${table.groundingResolverVersion}) <> '' and char_length(${table.groundingResolverVersion}) <= 100 and btrim(${table.contextSelectionVersion}) <> '' and char_length(${table.contextSelectionVersion}) <= 100 and btrim(${table.disclosureVersion}) <> '' and char_length(${table.disclosureVersion}) <= 100`),
    acknowledged: check("ai_synthesis_requests_transmission_acknowledged", sql`${table.externalTransmissionAcknowledged} = true`),
    expiryFuture: check("ai_synthesis_requests_undispatched_expiry_order", sql`${table.undispatchedExpiresAt} >= ${table.createdAt}`),
  }),
);

export const aiSynthesisRequestSupports = pgTable(
  "ai_synthesis_request_supports",
  {
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    supportOrdinal: integer("support_ordinal").notNull(),
    paperId: uuid("paper_id").notNull(),
    extractionFieldId: uuid("extraction_field_id").notNull(),
    extractionValueId: uuid("extraction_value_id").notNull(),
    fieldType: text("field_type").notNull(),
    valueState: text("value_state").notNull(),
    textValue: text("text_value"),
    numberValue: numeric("number_value", { precision: 30, scale: 10 }),
    booleanValue: boolean("boolean_value"),
    optionId: uuid("option_id"),
    optionLabelSnapshot: text("option_label_snapshot"),
    researcherNote: text("researcher_note"),
    paperTitleSnapshot: text("paper_title_snapshot").notNull(),
    paperPublicationYearSnapshot: integer("paper_publication_year_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.requestId, table.extractionRevisionId] }),
    requestSupportIdentity: unique("ai_synthesis_request_supports_project_request_ordinal_unique").on(table.projectId, table.requestId, table.supportOrdinal),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiSynthesisRequests.projectId, aiSynthesisRequests.id], name: "ai_synthesis_request_supports_request_fk" }).onDelete("restrict"),
    revisionOwnership: foreignKey({ columns: [table.projectId, table.extractionRevisionId], foreignColumns: [extractionValueRevisions.projectId, extractionValueRevisions.id], name: "ai_synthesis_request_supports_revision_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "ai_synthesis_request_supports_paper_fk" }).onDelete("restrict"),
    fieldOwnership: foreignKey({ columns: [table.projectId, table.extractionFieldId], foreignColumns: [extractionFields.projectId, extractionFields.id], name: "ai_synthesis_request_supports_field_fk" }).onDelete("restrict"),
    valueOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.extractionValueId, table.extractionFieldId], foreignColumns: [extractionValues.projectId, extractionValues.paperId, extractionValues.id, extractionValues.fieldId], name: "ai_synthesis_request_supports_value_fk" }).onDelete("restrict"),
    optionOwnership: foreignKey({ columns: [table.projectId, table.extractionFieldId, table.optionId], foreignColumns: [extractionOptions.projectId, extractionOptions.fieldId, extractionOptions.id], name: "ai_synthesis_request_supports_option_fk" }).onDelete("restrict"),
    fieldTypeValid: check("ai_synthesis_request_supports_field_type_valid", sql`${table.fieldType} in ('short_text', 'long_text', 'number', 'boolean', 'single_select')`),
    stateValid: check("ai_synthesis_request_supports_value_state_valid", sql`${table.valueState} in ('present', 'not_reported', 'not_applicable', 'cleared')`),
    valueShape: check("ai_synthesis_request_supports_value_shape", sql`(
      (${table.valueState} <> 'present' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null and ${table.optionLabelSnapshot} is null)
      or (${table.valueState} = 'present' and (
        (${table.fieldType} in ('short_text', 'long_text') and ${table.textValue} is not null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is null and ${table.optionLabelSnapshot} is null)
        or (${table.fieldType} = 'number' and ${table.textValue} is null and ${table.numberValue} is not null and ${table.booleanValue} is null and ${table.optionId} is null and ${table.optionLabelSnapshot} is null)
        or (${table.fieldType} = 'boolean' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is not null and ${table.optionId} is null and ${table.optionLabelSnapshot} is null)
        or (${table.fieldType} = 'single_select' and ${table.textValue} is null and ${table.numberValue} is null and ${table.booleanValue} is null and ${table.optionId} is not null and ${table.optionLabelSnapshot} is not null)
      ))
    )`),
    ordinalValid: check("ai_synthesis_request_supports_ordinal_valid", sql`${table.supportOrdinal} >= 0 and ${table.supportOrdinal} < 20`),
    noteBound: check("ai_synthesis_request_supports_note_bound", sql`${table.researcherNote} is null or char_length(${table.researcherNote}) <= 10000`),
    paperTitleBound: check("ai_synthesis_request_supports_paper_title_bound", sql`char_length(${table.paperTitleSnapshot}) between 1 and 1000`),
    publicationYearValid: check("ai_synthesis_request_supports_publication_year_valid", sql`${table.paperPublicationYearSnapshot} is null or (${table.paperPublicationYearSnapshot} between 1000 and 3000)`),
  }),
);

export const aiSynthesisRequestSources = pgTable(
  "ai_synthesis_request_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    membershipId: uuid("membership_id").notNull(),
    membershipSortOrder: integer("membership_sort_order").notNull(),
    pageNumber: integer("page_number").notNull(),
    sourceText: text("source_text").notNull(),
    sourceTextSha256: text("source_text_sha256").notNull(),
    sourceCharacterCount: integer("source_character_count").notNull(),
    sourceByteSize: integer("source_byte_size").notNull(),
    evidenceReviewState: text("evidence_review_state").notNull(),
    evidenceNoteSnapshot: text("evidence_note_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_synthesis_request_sources_project_id_id_unique").on(table.projectId, table.id),
    sourceIdentity: unique("ai_synthesis_request_sources_project_request_revision_evidence_unique").on(table.projectId, table.requestId, table.extractionRevisionId, table.evidenceId),
    sourceOrder: unique("ai_synthesis_request_sources_project_request_revision_ordinal_unique").on(table.projectId, table.requestId, table.extractionRevisionId, table.sourceOrdinal),
    requestSupportOwnership: foreignKey({ columns: [table.projectId, table.requestId, table.extractionRevisionId], foreignColumns: [aiSynthesisRequestSupports.projectId, aiSynthesisRequestSupports.requestId, aiSynthesisRequestSupports.extractionRevisionId], name: "ai_synthesis_request_sources_support_fk" }).onDelete("restrict"),
    evidenceOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.evidenceId], foreignColumns: [evidence.projectId, evidence.paperId, evidence.id], name: "ai_synthesis_request_sources_evidence_fk" }).onDelete("restrict"),
    membershipOwnership: foreignKey({ columns: [table.projectId, table.membershipId], foreignColumns: [evidenceSetMemberships.projectId, evidenceSetMemberships.id], name: "ai_synthesis_request_sources_membership_fk" }).onDelete("restrict"),
    sourceOrdinalValid: check("ai_synthesis_request_sources_ordinal_valid", sql`${table.sourceOrdinal} >= 0 and ${table.sourceOrdinal} < 8`),
    membershipOrderValid: check("ai_synthesis_request_sources_membership_order_valid", sql`${table.membershipSortOrder} > 0`),
    pagePositive: check("ai_synthesis_request_sources_page_positive", sql`${table.pageNumber} > 0`),
    sourceTextBound: check("ai_synthesis_request_sources_text_bound", sql`btrim(${table.sourceText}) <> '' and char_length(${table.sourceText}) <= 4000`),
    sourceHashShape: check("ai_synthesis_request_sources_hash_shape", sql`${table.sourceTextSha256} ~ '^[0-9a-f]{64}$'`),
    sourceCountShape: check("ai_synthesis_request_sources_count_shape", sql`${table.sourceCharacterCount} = char_length(${table.sourceText}) and ${table.sourceCharacterCount} > 0 and ${table.sourceCharacterCount} <= 4000 and ${table.sourceByteSize} > 0 and ${table.sourceByteSize} <= 163840`),
    reviewStateValid: check("ai_synthesis_request_sources_review_state_valid", sql`${table.evidenceReviewState} in ('unreviewed', 'needs_review', 'accepted', 'rejected')`),
    noteBound: check("ai_synthesis_request_sources_note_bound", sql`${table.evidenceNoteSnapshot} is null or char_length(${table.evidenceNoteSnapshot}) <= 2000`),
  }),
);

export const aiSynthesisDispatches = pgTable(
  "ai_synthesis_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_synthesis_dispatches_project_id_id_unique").on(table.projectId, table.id),
    requestUnique: unique("ai_synthesis_dispatches_project_request_unique").on(table.projectId, table.requestId),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiSynthesisRequests.projectId, aiSynthesisRequests.id], name: "ai_synthesis_dispatches_request_fk" }).onDelete("restrict"),
    deadlineOrder: check("ai_synthesis_dispatches_deadline_order", sql`${table.deadlineAt} > ${table.startedAt}`),
  }),
);

export const aiSynthesisResults = pgTable(
  "ai_synthesis_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    outcome: text("outcome").notNull(),
    providerDiagnostic: text("provider_diagnostic").notNull(),
    errorCode: text("error_code"),
    candidateState: text("candidate_state"),
    proposedTitle: text("proposed_title"),
    proposedStatementText: text("proposed_statement_text"),
    explanation: text("explanation"),
    sourceCoverageState: text("source_coverage_state").notNull().default("complete"),
    coveredSupportCount: integer("covered_support_count").notNull().default(0),
    groundingCount: integer("grounding_count").notNull().default(0),
    providerRequestId: text("provider_request_id"),
    configuredModel: text("configured_model").notNull(),
    returnedModel: text("returned_model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_synthesis_results_project_id_id_unique").on(table.projectId, table.id),
    requestUnique: unique("ai_synthesis_results_project_request_unique").on(table.projectId, table.requestId),
    requestIdentity: unique("ai_synthesis_results_project_request_id_unique").on(table.projectId, table.requestId, table.id),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiSynthesisRequests.projectId, aiSynthesisRequests.id], name: "ai_synthesis_results_request_fk" }).onDelete("restrict"),
    outcomeValid: check("ai_synthesis_results_outcome_valid", sql`${table.outcome} in ('succeeded', 'no_candidate', 'provider_unavailable', 'failed', 'invalid_output', 'unresolvable_grounding', 'outcome_unknown')`),
    diagnosticValid: check("ai_synthesis_results_provider_diagnostic_valid", sql`${table.providerDiagnostic} in ('success', 'refusal', 'incomplete', 'schema_invalid', 'transport_error', 'api_error', 'unknown')`),
    candidateStateValid: check("ai_synthesis_results_candidate_state_valid", sql`${table.candidateState} is null or ${table.candidateState} in ('present', 'not_present')`),
    coverageValid: check("ai_synthesis_results_source_coverage_valid", sql`${table.sourceCoverageState} in ('complete', 'partial', 'not_applicable')`),
    resultShape: check("ai_synthesis_results_result_shape", sql`(
      (${table.outcome} = 'succeeded' and ${table.candidateState} = 'present' and ${table.proposedStatementText} is not null and btrim(${table.proposedStatementText}) <> '' and ${table.errorCode} is null)
      or (${table.outcome} = 'no_candidate' and ${table.candidateState} = 'not_present' and ${table.proposedTitle} is null and ${table.proposedStatementText} is null and ${table.groundingCount} = 0)
      or (${table.outcome} not in ('succeeded', 'no_candidate') and ${table.candidateState} is null and ${table.proposedTitle} is null and ${table.proposedStatementText} is null)
    )`),
    titleBound: check("ai_synthesis_results_title_bound", sql`${table.proposedTitle} is null or (btrim(${table.proposedTitle}) <> '' and char_length(${table.proposedTitle}) <= 500)`),
    statementBound: check("ai_synthesis_results_statement_bound", sql`${table.proposedStatementText} is null or char_length(${table.proposedStatementText}) <= 10000`),
    explanationBound: check("ai_synthesis_results_explanation_bound", sql`${table.explanation} is null or char_length(${table.explanation}) <= 2000`),
    errorBound: check("ai_synthesis_results_error_bound", sql`${table.errorCode} is null or (btrim(${table.errorCode}) <> '' and char_length(${table.errorCode}) <= 80)`),
    metadataBound: check("ai_synthesis_results_metadata_bound", sql`${table.providerRequestId} is null or (btrim(${table.providerRequestId}) <> '' and char_length(${table.providerRequestId}) <= 200)`),
    countsValid: check("ai_synthesis_results_counts_valid", sql`${table.coveredSupportCount} >= 0 and ${table.groundingCount} >= 0 and (${table.inputTokens} is null or ${table.inputTokens} >= 0) and (${table.outputTokens} is null or ${table.outputTokens} >= 0) and (${table.durationMs} is null or ${table.durationMs} >= 0)`),
  }),
);

export const aiSynthesisResultGroundings = pgTable(
  "ai_synthesis_result_groundings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    resultId: uuid("result_id").notNull(),
    extractionRevisionId: uuid("extraction_revision_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    locatorQuote: text("locator_quote").notNull(),
    locatorPrefix: text("locator_prefix"),
    locatorSuffix: text("locator_suffix"),
    sourceText: text("source_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_synthesis_result_groundings_project_id_id_unique").on(table.projectId, table.id),
    groundingIdentity: unique("ai_synthesis_result_groundings_result_source_offset_unique").on(table.projectId, table.resultId, table.extractionRevisionId, table.evidenceId, table.startOffset, table.endOffset),
    requestResultOwnership: foreignKey({ columns: [table.projectId, table.requestId, table.resultId], foreignColumns: [aiSynthesisResults.projectId, aiSynthesisResults.requestId, aiSynthesisResults.id], name: "ai_synthesis_result_groundings_result_fk" }).onDelete("restrict"),
    sourceOwnership: foreignKey({ columns: [table.projectId, table.requestId, table.extractionRevisionId, table.evidenceId], foreignColumns: [aiSynthesisRequestSources.projectId, aiSynthesisRequestSources.requestId, aiSynthesisRequestSources.extractionRevisionId, aiSynthesisRequestSources.evidenceId], name: "ai_synthesis_result_groundings_source_fk" }).onDelete("restrict"),
    pagePositive: check("ai_synthesis_result_groundings_page_positive", sql`${table.pageNumber} > 0`),
    offsetShape: check("ai_synthesis_result_groundings_offset_shape", sql`${table.startOffset} >= 0 and ${table.endOffset} > ${table.startOffset} and ${table.endOffset} - ${table.startOffset} <= 500`),
    quoteBound: check("ai_synthesis_result_groundings_quote_bound", sql`btrim(${table.locatorQuote}) <> '' and char_length(${table.locatorQuote}) <= 500`),
    contextBound: check("ai_synthesis_result_groundings_context_bound", sql`(${table.locatorPrefix} is null or char_length(${table.locatorPrefix}) <= 120) and (${table.locatorSuffix} is null or char_length(${table.locatorSuffix}) <= 120)`),
    sourceTextBound: check("ai_synthesis_result_groundings_source_text_bound", sql`char_length(${table.sourceText}) > 0 and char_length(${table.sourceText}) <= 4000`),
  }),
);

export const aiSynthesisDecisions = pgTable(
  "ai_synthesis_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    decision: text("decision").notNull(),
    acceptanceMode: text("acceptance_mode"),
    expectedCurrentTargetRevisionId: uuid("expected_current_target_revision_id"),
    resultingSynthesisRevisionId: uuid("resulting_synthesis_revision_id"),
    title: text("title"),
    statementText: text("statement_text"),
    researcherNote: text("researcher_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("ai_synthesis_decisions_project_id_id_unique").on(table.projectId, table.id),
    requestUnique: unique("ai_synthesis_decisions_project_request_unique").on(table.projectId, table.requestId),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [aiSynthesisRequests.projectId, aiSynthesisRequests.id], name: "ai_synthesis_decisions_request_fk" }).onDelete("restrict"),
    expectedRevisionOwnership: foreignKey({ columns: [table.projectId, table.expectedCurrentTargetRevisionId], foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.id], name: "ai_synthesis_decisions_expected_revision_fk" }).onDelete("restrict"),
    resultingRevisionOwnership: foreignKey({ columns: [table.projectId, table.resultingSynthesisRevisionId], foreignColumns: [synthesisRevisions.projectId, synthesisRevisions.id], name: "ai_synthesis_decisions_resulting_revision_fk" }).onDelete("restrict"),
    decisionValid: check("ai_synthesis_decisions_decision_valid", sql`${table.decision} in ('rejected', 'accepted')`),
    modeValid: check("ai_synthesis_decisions_acceptance_mode_valid", sql`${table.acceptanceMode} is null or ${table.acceptanceMode} in ('accept', 'edit_and_accept')`),
    decisionShape: check("ai_synthesis_decisions_decision_shape", sql`(
      (${table.decision} = 'rejected' and ${table.acceptanceMode} is null and ${table.resultingSynthesisRevisionId} is null and ${table.title} is null and ${table.statementText} is null and ${table.researcherNote} is null)
      or (${table.decision} = 'accepted' and ${table.acceptanceMode} is not null and ${table.resultingSynthesisRevisionId} is not null and ${table.statementText} is not null and btrim(${table.statementText}) <> '')
    )`),
    titleBound: check("ai_synthesis_decisions_title_bound", sql`${table.title} is null or (btrim(${table.title}) <> '' and char_length(${table.title}) <= 500)`),
    statementBound: check("ai_synthesis_decisions_statement_bound", sql`char_length(${table.statementText}) <= 10000`),
    noteBound: check("ai_synthesis_decisions_note_bound", sql`${table.researcherNote} is null or (btrim(${table.researcherNote}) <> '' and char_length(${table.researcherNote}) <= 10000)`),
  }),
);

export const doiLookupRequests = pgTable(
  "doi_lookup_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    submittedDoi: text("submitted_doi").notNull(),
    normalizedDoi: text("normalized_doi").notNull(),
    provider: text("provider").notNull(),
    providerContractVersion: text("provider_contract_version").notNull(),
    providerMappingVersion: text("provider_mapping_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("doi_lookup_requests_project_id_id_unique").on(table.projectId, table.id),
    projectIdempotency: unique("doi_lookup_requests_project_id_idempotency_key_unique").on(table.projectId, table.idempotencyKey),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "doi_lookup_requests_project_fk" }).onDelete("cascade"),
    projectCreatedAt: index("doi_lookup_requests_project_created_at_idx").on(table.projectId, table.createdAt),
    projectDoi: index("doi_lookup_requests_project_normalized_doi_idx").on(table.projectId, table.normalizedDoi),
    submittedDoiShape: check("doi_lookup_requests_submitted_doi_shape", sql`char_length(${table.submittedDoi}) <= 1000 and btrim(${table.submittedDoi}) <> '' and ${table.submittedDoi} !~ '[\\u0000-\\u001f\\u007f]'`),
    normalizedDoiShape: check("doi_lookup_requests_normalized_doi_shape", sql`char_length(${table.normalizedDoi}) <= 1000 and btrim(${table.normalizedDoi}) <> '' and ${table.normalizedDoi} !~ '[\\u0000-\\u001f\\u007f]'`),
    providerShape: check("doi_lookup_requests_provider_shape", sql`char_length(${table.provider}) <= 100 and btrim(${table.provider}) <> ''`),
    contractVersionShape: check("doi_lookup_requests_contract_version_shape", sql`char_length(${table.providerContractVersion}) <= 100 and btrim(${table.providerContractVersion}) <> ''`),
    mappingVersionShape: check("doi_lookup_requests_mapping_version_shape", sql`char_length(${table.providerMappingVersion}) <= 100 and btrim(${table.providerMappingVersion}) <> ''`),
    idempotencyKeyShape: check("doi_lookup_requests_idempotency_key_shape", sql`char_length(${table.idempotencyKey}) <= 200 and btrim(${table.idempotencyKey}) <> ''`),
  }),
);

export const bibliographicMetadataFetches = pgTable(
  "bibliographic_metadata_fetches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    normalizedDoi: text("normalized_doi").notNull(),
    providerContractVersion: text("provider_contract_version").notNull(),
    providerMappingVersion: text("provider_mapping_version").notNull(),
    cacheKey: text("cache_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    executionIdentity: text("execution_identity").notNull(),
    rateLimitPerSecond: integer("rate_limit_per_second").notNull(),
    concurrencyLimit: integer("concurrency_limit").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    cacheIdentity: index("bibliographic_metadata_fetches_cache_identity_idx").on(table.provider, table.normalizedDoi, table.providerContractVersion, table.providerMappingVersion),
    cacheKeyIndex: index("bibliographic_metadata_fetches_cache_key_idx").on(table.cacheKey),
    providerStartedAt: index("bibliographic_metadata_fetches_provider_started_at_idx").on(table.provider, table.startedAt),
    providerShape: check("bibliographic_metadata_fetches_provider_shape", sql`char_length(${table.provider}) <= 100 and btrim(${table.provider}) <> ''`),
    doiShape: check("bibliographic_metadata_fetches_doi_shape", sql`char_length(${table.normalizedDoi}) <= 1000 and btrim(${table.normalizedDoi}) <> '' and ${table.normalizedDoi} !~ '[\\u0000-\\u001f\\u007f]'`),
    contractShape: check("bibliographic_metadata_fetches_contract_shape", sql`char_length(${table.providerContractVersion}) <= 100 and btrim(${table.providerContractVersion}) <> ''`),
    mappingShape: check("bibliographic_metadata_fetches_mapping_shape", sql`char_length(${table.providerMappingVersion}) <= 100 and btrim(${table.providerMappingVersion}) <> ''`),
    cacheKeyShape: check("bibliographic_metadata_fetches_cache_key_shape", sql`char_length(${table.cacheKey}) <= 2500 and btrim(${table.cacheKey}) <> ''`),
    executionIdentityShape: check("bibliographic_metadata_fetches_execution_identity_shape", sql`char_length(${table.executionIdentity}) <= 200 and btrim(${table.executionIdentity}) <> ''`),
    deadlineShape: check("bibliographic_metadata_fetches_deadline_shape", sql`${table.deadlineAt} > ${table.startedAt}`),
    scheduleShape: check("bibliographic_metadata_fetches_schedule_shape", sql`${table.rateLimitPerSecond} > 0 and ${table.rateLimitPerSecond} <= 1000 and ${table.concurrencyLimit} > 0 and ${table.concurrencyLimit} <= 100`),
  }),
);

export const doiLookupDispatches = pgTable(
  "doi_lookup_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    fetchId: uuid("fetch_id").notNull(),
    dispatchKind: text("dispatch_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("doi_lookup_dispatches_project_id_id_unique").on(table.projectId, table.id),
    projectRequestSequence: index("doi_lookup_dispatches_project_request_sequence_idx").on(table.projectId, table.requestId, table.sequence),
    fetchSequence: index("doi_lookup_dispatches_fetch_sequence_idx").on(table.fetchId, table.sequence),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "doi_lookup_dispatches_project_fk" }).onDelete("cascade"),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [doiLookupRequests.projectId, doiLookupRequests.id], name: "doi_lookup_dispatches_request_fk" }).onDelete("cascade"),
    fetchOwnership: foreignKey({ columns: [table.fetchId], foreignColumns: [bibliographicMetadataFetches.id], name: "doi_lookup_dispatches_fetch_fk" }).onDelete("restrict"),
    kindValid: check("doi_lookup_dispatches_kind_valid", sql`${table.dispatchKind} in ('network_owner', 'network_shared', 'cache_reuse')`),
  }),
);

export const bibliographicMetadataFetchResults = pgTable(
  "bibliographic_metadata_fetch_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fetchId: uuid("fetch_id").notNull(),
    outcome: text("outcome").notNull(),
    httpAttemptCount: integer("http_attempt_count").notNull(),
    lastHttpStatus: integer("last_http_status"),
    responseContentType: text("response_content_type"),
    responseByteSize: integer("response_byte_size"),
    responseSha256: text("response_sha256"),
    sourceSnapshot: jsonb("source_snapshot"),
    providerDoi: text("provider_doi"),
    proposedTitle: text("proposed_title"),
    proposedPublicationYear: integer("proposed_publication_year"),
    proposedVenue: text("proposed_venue"),
    providerType: text("provider_type"),
    providerPublisher: text("provider_publisher"),
    providerUrl: text("provider_url"),
    authorsState: text("authors_state").notNull().default("absent"),
    reportedAuthorCount: integer("reported_author_count"),
    mappingWarnings: jsonb("mapping_warnings").notNull().default([]),
    diagnosticCode: text("diagnostic_code"),
    diagnosticMessage: text("diagnostic_message"),
    providerRequestId: text("provider_request_id"),
    observedRateLimitPerSecond: integer("observed_rate_limit_per_second"),
    observedConcurrencyLimit: integer("observed_concurrency_limit"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    fetchIdentity: unique("bibliographic_metadata_fetch_results_fetch_id_unique").on(table.fetchId),
    finalizedAtId: index("bibliographic_metadata_fetch_results_finalized_at_id_idx").on(table.finalizedAt, table.id),
    outcomeFinalizedAt: index("bibliographic_metadata_fetch_results_outcome_finalized_at_idx").on(table.outcome, table.finalizedAt, table.id),
    fetchOwnership: foreignKey({ columns: [table.fetchId], foreignColumns: [bibliographicMetadataFetches.id], name: "bibliographic_metadata_fetch_results_fetch_fk" }).onDelete("restrict"),
    outcomeValid: check("bibliographic_metadata_fetch_results_outcome_valid", sql`${table.outcome} in ('succeeded', 'not_found', 'provider_unavailable', 'rate_limited', 'invalid_response', 'provider_mismatch', 'failed')`),
    attemptCountValid: check("bibliographic_metadata_fetch_results_attempt_count_valid", sql`${table.httpAttemptCount} >= 0 and ${table.httpAttemptCount} <= 3`),
    httpStatusValid: check("bibliographic_metadata_fetch_results_http_status_valid", sql`${table.lastHttpStatus} is null or (${table.lastHttpStatus} >= 100 and ${table.lastHttpStatus} <= 599)`),
    responseEvidenceShape: check("bibliographic_metadata_fetch_results_response_evidence_shape", sql`((${table.responseByteSize} is null and ${table.responseSha256} is null) or (${table.responseByteSize} > 0 and ${table.responseByteSize} <= 2097152 and ${table.responseSha256} ~ '^[0-9a-f]{64}$'))`),
    authorsStateValid: check("bibliographic_metadata_fetch_results_authors_state_valid", sql`${table.authorsState} in ('valid', 'invalid', 'absent')`),
    reportedAuthorCountValid: check("bibliographic_metadata_fetch_results_reported_author_count_valid", sql`${table.reportedAuthorCount} is null or (${table.reportedAuthorCount} >= 0 and ${table.reportedAuthorCount} <= 10000)`),
    yearValid: check("bibliographic_metadata_fetch_results_year_valid", sql`${table.proposedPublicationYear} is null or (${table.proposedPublicationYear} >= 1000 and ${table.proposedPublicationYear} <= 3000)`),
    titleShape: check("bibliographic_metadata_fetch_results_title_shape", sql`${table.proposedTitle} is null or (btrim(${table.proposedTitle}) <> '' and char_length(${table.proposedTitle}) <= 1000)`),
    venueShape: check("bibliographic_metadata_fetch_results_venue_shape", sql`${table.proposedVenue} is null or (btrim(${table.proposedVenue}) <> '' and char_length(${table.proposedVenue}) <= 1000)`),
    providerTypeShape: check("bibliographic_metadata_fetch_results_provider_type_shape", sql`${table.providerType} is null or (btrim(${table.providerType}) <> '' and char_length(${table.providerType}) <= 200)`),
    publisherShape: check("bibliographic_metadata_fetch_results_publisher_shape", sql`${table.providerPublisher} is null or (btrim(${table.providerPublisher}) <> '' and char_length(${table.providerPublisher}) <= 1000)`),
    providerUrlShape: check("bibliographic_metadata_fetch_results_provider_url_shape", sql`${table.providerUrl} is null or (char_length(${table.providerUrl}) <= 2048 and ${table.providerUrl} ~ '^https?://')`),
    diagnosticCodeShape: check("bibliographic_metadata_fetch_results_diagnostic_code_shape", sql`${table.diagnosticCode} is null or (btrim(${table.diagnosticCode}) <> '' and char_length(${table.diagnosticCode}) <= 80)`),
    diagnosticMessageShape: check("bibliographic_metadata_fetch_results_diagnostic_message_shape", sql`${table.diagnosticMessage} is null or char_length(${table.diagnosticMessage}) <= 2000`),
    providerRequestIdShape: check("bibliographic_metadata_fetch_results_provider_request_id_shape", sql`${table.providerRequestId} is null or (btrim(${table.providerRequestId}) <> '' and char_length(${table.providerRequestId}) <= 200)`),
    durationValid: check("bibliographic_metadata_fetch_results_duration_valid", sql`${table.durationMs} is null or (${table.durationMs} >= 0 and ${table.durationMs} <= 600000)`),
    finalizedShape: check("bibliographic_metadata_fetch_results_finalized_shape", sql`${table.finalizedAt} >= ${table.createdAt}`),
  }),
);

export const bibliographicMetadataResultAuthors = pgTable(
  "bibliographic_metadata_result_authors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resultId: uuid("result_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    literalName: text("literal_name"),
    suffix: text("suffix"),
    orcid: text("orcid"),
    displayName: text("display_name").notNull(),
    providerSequence: text("provider_sequence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    resultIdentity: unique("bibliographic_metadata_result_authors_result_id_id_unique").on(table.resultId, table.id),
    resultOrdinal: unique("bibliographic_metadata_result_authors_result_ordinal_unique").on(table.resultId, table.ordinal),
    resultOwnership: foreignKey({ columns: [table.resultId], foreignColumns: [bibliographicMetadataFetchResults.id], name: "bibliographic_metadata_result_authors_result_fk" }).onDelete("restrict"),
    ordinalValid: check("bibliographic_metadata_result_authors_ordinal_valid", sql`${table.ordinal} >= 1 and ${table.ordinal} <= 200`),
    givenNameShape: check("bibliographic_metadata_result_authors_given_name_shape", sql`${table.givenName} is null or (btrim(${table.givenName}) <> '' and char_length(${table.givenName}) <= 500)`),
    familyNameShape: check("bibliographic_metadata_result_authors_family_name_shape", sql`${table.familyName} is null or (btrim(${table.familyName}) <> '' and char_length(${table.familyName}) <= 500)`),
    literalNameShape: check("bibliographic_metadata_result_authors_literal_name_shape", sql`${table.literalName} is null or (btrim(${table.literalName}) <> '' and char_length(${table.literalName}) <= 500)`),
    suffixShape: check("bibliographic_metadata_result_authors_suffix_shape", sql`${table.suffix} is null or (btrim(${table.suffix}) <> '' and char_length(${table.suffix}) <= 500)`),
    orcidShape: check("bibliographic_metadata_result_authors_orcid_shape", sql`${table.orcid} is null or (btrim(${table.orcid}) <> '' and char_length(${table.orcid}) <= 200)`),
    displayNameShape: check("bibliographic_metadata_result_authors_display_name_shape", sql`btrim(${table.displayName}) <> '' and char_length(${table.displayName}) <= 500`),
    providerSequenceShape: check("bibliographic_metadata_result_authors_provider_sequence_shape", sql`${table.providerSequence} is null or (btrim(${table.providerSequence}) <> '' and char_length(${table.providerSequence}) <= 32)`),
    nameShape: check("bibliographic_metadata_result_authors_name_shape", sql`(${table.literalName} is not null and ${table.givenName} is null and ${table.familyName} is null) or (${table.literalName} is null and (${table.givenName} is not null or ${table.familyName} is not null))`),
  }),
);

export const doiLookupResolutions = pgTable(
  "doi_lookup_resolutions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid("project_id").notNull(),
    requestId: uuid("request_id").notNull(),
    resultId: uuid("result_id").notNull(),
    resolutionKind: text("resolution_kind").notNull(),
    paperId: uuid("paper_id"),
    expectedPreviousResolutionId: uuid("expected_previous_resolution_id"),
    creationPayload: jsonb("creation_payload"),
    candidateContext: jsonb("candidate_context"),
    previewFingerprint: text("preview_fingerprint"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("doi_lookup_resolutions_project_id_id_unique").on(table.projectId, table.id),
    projectRequestSequence: index("doi_lookup_resolutions_project_request_sequence_idx").on(table.projectId, table.requestId, table.sequence),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "doi_lookup_resolutions_project_fk" }).onDelete("cascade"),
    requestOwnership: foreignKey({ columns: [table.projectId, table.requestId], foreignColumns: [doiLookupRequests.projectId, doiLookupRequests.id], name: "doi_lookup_resolutions_request_fk" }).onDelete("cascade"),
    resultOwnership: foreignKey({ columns: [table.resultId], foreignColumns: [bibliographicMetadataFetchResults.id], name: "doi_lookup_resolutions_result_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "doi_lookup_resolutions_paper_fk" }).onDelete("restrict"),
    expectedPreviousOwnership: foreignKey({ columns: [table.projectId, table.expectedPreviousResolutionId], foreignColumns: [table.projectId, table.id], name: "doi_lookup_resolutions_expected_previous_fk" }).onDelete("restrict"),
    resolutionKindValid: check("doi_lookup_resolutions_kind_valid", sql`${table.resolutionKind} in ('created_paper', 'matched_paper', 'cleared')`),
    paperShape: check("doi_lookup_resolutions_paper_shape", sql`((${table.resolutionKind} in ('created_paper', 'matched_paper') and ${table.paperId} is not null) or (${table.resolutionKind} = 'cleared' and ${table.paperId} is null))`),
    creationPayloadShape: check("doi_lookup_resolutions_creation_payload_shape", sql`((${table.resolutionKind} = 'created_paper' and ${table.creationPayload} is not null) or (${table.resolutionKind} <> 'created_paper' and ${table.creationPayload} is null))`),
    previewFingerprintShape: check("doi_lookup_resolutions_preview_fingerprint_shape", sql`${table.previewFingerprint} is null or (${table.previewFingerprint} ~ '^[0-9a-f]{64}$' and char_length(${table.previewFingerprint}) = 64)`),
    noteShape: check("doi_lookup_resolutions_note_shape", sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 2000)`),
  }),
);

export const bibliographicMetadataHttpAttempts = pgTable(
  "bibliographic_metadata_http_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fetchId: uuid("fetch_id").notNull(),
    attemptOrdinal: integer("attempt_ordinal").notNull(),
    requestUrl: text("request_url").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").notNull().default("started"),
    httpStatus: integer("http_status"),
    outcomeCode: text("outcome_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fetchAttempt: unique("bibliographic_metadata_http_attempts_fetch_attempt_unique").on(table.fetchId, table.attemptOrdinal),
    fetchStartedAt: index("bibliographic_metadata_http_attempts_fetch_started_at_idx").on(table.fetchId, table.startedAt),
    providerAccounting: index("bibliographic_metadata_http_attempts_started_at_status_idx").on(table.startedAt, table.status),
    fetchOwnership: foreignKey({ columns: [table.fetchId], foreignColumns: [bibliographicMetadataFetches.id], name: "bibliographic_metadata_http_attempts_fetch_fk" }).onDelete("restrict"),
    ordinalValid: check("bibliographic_metadata_http_attempts_ordinal_valid", sql`${table.attemptOrdinal} >= 1 and ${table.attemptOrdinal} <= 3`),
    urlShape: check("bibliographic_metadata_http_attempts_url_shape", sql`char_length(${table.requestUrl}) <= 4096 and ${table.requestUrl} ~ '^https://api\\.crossref\\.org/' and ${table.requestUrl} !~ '[?&]mailto='`),
    statusValid: check("bibliographic_metadata_http_attempts_status_valid", sql`${table.status} in ('started', 'succeeded', 'failed')`),
    httpStatusValid: check("bibliographic_metadata_http_attempts_http_status_valid", sql`${table.httpStatus} is null or (${table.httpStatus} >= 100 and ${table.httpStatus} <= 599)`),
    lifecycleShape: check("bibliographic_metadata_http_attempts_lifecycle_shape", sql`(${table.status} = 'started' and ${table.completedAt} is null) or (${table.status} in ('succeeded', 'failed') and ${table.completedAt} is not null)`),
    outcomeCodeShape: check("bibliographic_metadata_http_attempts_outcome_code_shape", sql`${table.outcomeCode} is null or (btrim(${table.outcomeCode}) <> '' and char_length(${table.outcomeCode}) <= 80)`),
  }),
);

// Slice 33: researcher-authored, Paper-level critical appraisal. The model is
// deliberately separate from extraction, Evidence, screening, synthesis, and
// manuscript provenance. Framework definitions are versioned; appraisal
// history is append-only full snapshots.
export const appraisalFrameworks = pgTable(
  "appraisal_frameworks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("appraisal_frameworks_project_id_id_unique").on(table.projectId, table.id),
    projectCreatedAt: index("appraisal_frameworks_project_created_at_idx").on(table.projectId, table.createdAt, table.id),
    projectNameUnique: uniqueIndex("appraisal_frameworks_project_name_unique").on(table.projectId, sql`lower(btrim(${table.name}))`),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_frameworks_project_fk" }).onDelete("restrict"),
    nameShape: check("appraisal_frameworks_name_shape", sql`btrim(${table.name}) <> '' and char_length(${table.name}) <= 200`),
  }),
);

export const appraisalFrameworkVersions = pgTable(
  "appraisal_framework_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    frameworkId: uuid("framework_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    versionLabel: text("version_label").notNull(),
    description: text("description"),
    citation: text("citation"),
    externalReferenceUrl: text("external_reference_url"),
    rightsNote: text("rights_note"),
    instructions: text("instructions"),
    intendedStudyDesign: text("intended_study_design"),
    applicabilityNote: text("applicability_note"),
    overallJudgementRequired: boolean("overall_judgement_required").notNull().default(false),
    draftRevision: integer("draft_revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("appraisal_framework_versions_project_id_id_unique").on(table.projectId, table.id),
    frameworkVersionNumber: unique("appraisal_framework_versions_framework_version_number_unique").on(table.projectId, table.frameworkId, table.versionNumber),
    frameworkVersionIdentity: unique("appraisal_framework_versions_project_id_id_framework_unique").on(table.projectId, table.id, table.frameworkId),
    frameworkVersionLabel: uniqueIndex("appraisal_framework_versions_framework_version_label_unique").on(table.projectId, table.frameworkId, sql`lower(btrim(${table.versionLabel}))`),
    frameworkLookup: index("appraisal_framework_versions_project_framework_idx").on(table.projectId, table.frameworkId, table.versionNumber),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_framework_versions_project_fk" }).onDelete("restrict"),
    frameworkOwnership: foreignKey({ columns: [table.projectId, table.frameworkId], foreignColumns: [appraisalFrameworks.projectId, appraisalFrameworks.id], name: "appraisal_framework_versions_framework_fk" }).onDelete("restrict"),
    versionNumberPositive: check("appraisal_framework_versions_version_number_positive", sql`${table.versionNumber} >= 1`),
    versionLabelShape: check("appraisal_framework_versions_version_label_shape", sql`btrim(${table.versionLabel}) <> '' and char_length(${table.versionLabel}) <= 100`),
    descriptionShape: check("appraisal_framework_versions_description_shape", sql`${table.description} is null or char_length(${table.description}) <= 10000`),
    citationShape: check("appraisal_framework_versions_citation_shape", sql`${table.citation} is null or char_length(${table.citation}) <= 10000`),
    externalReferenceShape: check("appraisal_framework_versions_external_reference_shape", sql`${table.externalReferenceUrl} is null or (char_length(${table.externalReferenceUrl}) <= 2048 and ${table.externalReferenceUrl} ~ '^https?://')`),
    rightsNoteShape: check("appraisal_framework_versions_rights_note_shape", sql`${table.rightsNote} is null or char_length(${table.rightsNote}) <= 10000`),
    instructionsShape: check("appraisal_framework_versions_instructions_shape", sql`${table.instructions} is null or char_length(${table.instructions}) <= 20000`),
    intendedDesignShape: check("appraisal_framework_versions_intended_design_shape", sql`${table.intendedStudyDesign} is null or char_length(${table.intendedStudyDesign}) <= 1000`),
    applicabilityShape: check("appraisal_framework_versions_applicability_shape", sql`${table.applicabilityNote} is null or char_length(${table.applicabilityNote}) <= 10000`),
    draftRevisionNonnegative: check("appraisal_framework_versions_draft_revision_nonnegative", sql`${table.draftRevision} >= 0`),
  }),
);

export const appraisalFrameworkSections = pgTable(
  "appraisal_framework_sections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("appraisal_framework_sections_project_id_id_unique").on(table.projectId, table.id),
    versionIdentity: unique("appraisal_framework_sections_project_version_id_id_unique").on(table.projectId, table.frameworkVersionId, table.id),
    versionOrder: unique("appraisal_framework_sections_project_version_order_unique").on(table.projectId, table.frameworkVersionId, table.sortOrder),
    versionLookup: index("appraisal_framework_sections_project_version_idx").on(table.projectId, table.frameworkVersionId, table.sortOrder),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_framework_sections_project_fk" }).onDelete("restrict"),
    versionOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId], foreignColumns: [appraisalFrameworkVersions.projectId, appraisalFrameworkVersions.id], name: "appraisal_framework_sections_version_fk" }).onDelete("restrict"),
    labelShape: check("appraisal_framework_sections_label_shape", sql`btrim(${table.label}) <> '' and char_length(${table.label}) <= 200`),
    descriptionShape: check("appraisal_framework_sections_description_shape", sql`${table.description} is null or char_length(${table.description}) <= 5000`),
    sortOrderPositive: check("appraisal_framework_sections_sort_order_positive", sql`${table.sortOrder} >= 1 and ${table.sortOrder} <= 50`),
  }),
);

export const appraisalFrameworkItems = pgTable(
  "appraisal_framework_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    prompt: text("prompt").notNull(),
    guidance: text("guidance"),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("appraisal_framework_items_project_id_id_unique").on(table.projectId, table.id),
    versionIdentity: unique("appraisal_framework_items_project_version_id_id_unique").on(table.projectId, table.frameworkVersionId, table.id),
    sectionOrder: unique("appraisal_framework_items_project_section_order_unique").on(table.projectId, table.sectionId, table.sortOrder),
    versionLookup: index("appraisal_framework_items_project_version_idx").on(table.projectId, table.frameworkVersionId, table.sortOrder, table.id),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_framework_items_project_fk" }).onDelete("restrict"),
    versionOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId], foreignColumns: [appraisalFrameworkVersions.projectId, appraisalFrameworkVersions.id], name: "appraisal_framework_items_version_fk" }).onDelete("restrict"),
    sectionOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId, table.sectionId], foreignColumns: [appraisalFrameworkSections.projectId, appraisalFrameworkSections.frameworkVersionId, appraisalFrameworkSections.id], name: "appraisal_framework_items_section_fk" }).onDelete("restrict"),
    promptShape: check("appraisal_framework_items_prompt_shape", sql`btrim(${table.prompt}) <> '' and char_length(${table.prompt}) <= 2000`),
    guidanceShape: check("appraisal_framework_items_guidance_shape", sql`${table.guidance} is null or char_length(${table.guidance}) <= 10000`),
    sortOrderPositive: check("appraisal_framework_items_sort_order_positive", sql`${table.sortOrder} >= 1 and ${table.sortOrder} <= 200`),
  }),
);

export const appraisalFrameworkResponseOptions = pgTable(
  "appraisal_framework_response_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    itemId: uuid("item_id").notNull(),
    optionKey: text("option_key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("appraisal_framework_response_options_project_id_id_unique").on(table.projectId, table.id),
    itemIdentity: unique("appraisal_framework_response_options_project_item_id_id_unique").on(table.projectId, table.frameworkVersionId, table.itemId, table.id),
    itemKey: uniqueIndex("appraisal_framework_response_options_project_item_key_unique").on(table.projectId, table.frameworkVersionId, table.itemId, sql`lower(btrim(${table.optionKey}))`),
    itemLabel: uniqueIndex("appraisal_framework_response_options_project_item_label_unique").on(table.projectId, table.frameworkVersionId, table.itemId, sql`lower(btrim(${table.label}))`),
    itemOrder: unique("appraisal_framework_response_options_project_item_order_unique").on(table.projectId, table.frameworkVersionId, table.itemId, table.sortOrder),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_framework_response_options_project_fk" }).onDelete("restrict"),
    itemOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId, table.itemId], foreignColumns: [appraisalFrameworkItems.projectId, appraisalFrameworkItems.frameworkVersionId, appraisalFrameworkItems.id], name: "appraisal_framework_response_options_item_fk" }).onDelete("restrict"),
    optionKeyShape: check("appraisal_framework_response_options_key_shape", sql`btrim(${table.optionKey}) <> '' and char_length(${table.optionKey}) <= 100`),
    labelShape: check("appraisal_framework_response_options_label_shape", sql`btrim(${table.label}) <> '' and char_length(${table.label}) <= 500`),
    sortOrderPositive: check("appraisal_framework_response_options_sort_order_positive", sql`${table.sortOrder} >= 1 and ${table.sortOrder} <= 20`),
  }),
);

export const appraisalFrameworkOverallJudgementOptions = pgTable(
  "appraisal_framework_overall_judgement_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    optionKey: text("option_key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("appraisal_framework_overall_judgement_options_project_id_id_unique").on(table.projectId, table.id),
    versionIdentity: unique("appraisal_framework_overall_judgement_options_project_version_id_id_unique").on(table.projectId, table.frameworkVersionId, table.id),
    versionKey: uniqueIndex("appraisal_framework_overall_judgement_options_project_version_key_unique").on(table.projectId, table.frameworkVersionId, sql`lower(btrim(${table.optionKey}))`),
    versionLabel: uniqueIndex("appraisal_framework_overall_judgement_options_project_version_label_unique").on(table.projectId, table.frameworkVersionId, sql`lower(btrim(${table.label}))`),
    versionOrder: unique("appraisal_framework_overall_judgement_options_project_version_order_unique").on(table.projectId, table.frameworkVersionId, table.sortOrder),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_framework_overall_judgement_options_project_fk" }).onDelete("restrict"),
    versionOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId], foreignColumns: [appraisalFrameworkVersions.projectId, appraisalFrameworkVersions.id], name: "appraisal_framework_overall_judgement_options_version_fk" }).onDelete("restrict"),
    optionKeyShape: check("appraisal_framework_overall_judgement_options_key_shape", sql`btrim(${table.optionKey}) <> '' and char_length(${table.optionKey}) <= 100`),
    labelShape: check("appraisal_framework_overall_judgement_options_label_shape", sql`btrim(${table.label}) <> '' and char_length(${table.label}) <= 500`),
    sortOrderPositive: check("appraisal_framework_overall_judgement_options_sort_order_positive", sql`${table.sortOrder} >= 1 and ${table.sortOrder} <= 20`),
  }),
);

export const appraisals = pgTable(
  "appraisals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    frameworkId: uuid("framework_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("appraisals_project_id_id_unique").on(table.projectId, table.id),
    paperFrameworkUnique: unique("appraisals_project_paper_framework_unique").on(table.projectId, table.paperId, table.frameworkId),
    identityWithOwnership: unique("appraisals_project_id_paper_framework_unique").on(table.projectId, table.id, table.paperId, table.frameworkId),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisals_project_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "appraisals_paper_fk" }).onDelete("restrict"),
    frameworkOwnership: foreignKey({ columns: [table.projectId, table.frameworkId], foreignColumns: [appraisalFrameworks.projectId, appraisalFrameworks.id], name: "appraisals_framework_fk" }).onDelete("restrict"),
  }),
);

export const appraisalRevisions = pgTable(
  "appraisal_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    revisionNumber: integer("revision_number").notNull(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    frameworkId: uuid("framework_id").notNull(),
    appraisalId: uuid("appraisal_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    titleAbstractDecisionId: uuid("title_abstract_decision_id").notNull(),
    fullTextDecisionId: uuid("full_text_decision_id").notNull(),
    overallJudgementOptionId: uuid("overall_judgement_option_id"),
    overallRationale: text("overall_rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    projectIdentity: unique("appraisal_revisions_project_id_id_unique").on(table.projectId, table.id),
    appraisalRevisionUnique: unique("appraisal_revisions_project_appraisal_revision_number_unique").on(table.projectId, table.appraisalId, table.revisionNumber),
    revisionIdentity: unique("appraisal_revisions_project_identity_unique").on(table.projectId, table.id, table.paperId, table.frameworkId, table.appraisalId, table.frameworkVersionId),
    appraisalSequence: index("appraisal_revisions_project_appraisal_sequence_idx").on(table.projectId, table.appraisalId, table.sequence),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_revisions_project_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "appraisal_revisions_paper_fk" }).onDelete("restrict"),
    frameworkOwnership: foreignKey({ columns: [table.projectId, table.frameworkId], foreignColumns: [appraisalFrameworks.projectId, appraisalFrameworks.id], name: "appraisal_revisions_framework_fk" }).onDelete("restrict"),
    appraisalOwnership: foreignKey({ columns: [table.projectId, table.appraisalId, table.paperId, table.frameworkId], foreignColumns: [appraisals.projectId, appraisals.id, appraisals.paperId, appraisals.frameworkId], name: "appraisal_revisions_appraisal_fk" }).onDelete("restrict"),
    frameworkVersionOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId, table.frameworkId], foreignColumns: [appraisalFrameworkVersions.projectId, appraisalFrameworkVersions.id, appraisalFrameworkVersions.frameworkId], name: "appraisal_revisions_framework_version_fk" }).onDelete("restrict"),
    titleAbstractDecisionOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.titleAbstractDecisionId], foreignColumns: [screeningDecisions.projectId, screeningDecisions.paperId, screeningDecisions.id], name: "appraisal_revisions_title_abstract_decision_fk" }).onDelete("restrict"),
    fullTextDecisionOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.fullTextDecisionId], foreignColumns: [fullTextScreeningDecisions.projectId, fullTextScreeningDecisions.paperId, fullTextScreeningDecisions.id], name: "appraisal_revisions_full_text_decision_fk" }).onDelete("restrict"),
    overallOptionOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId, table.overallJudgementOptionId], foreignColumns: [appraisalFrameworkOverallJudgementOptions.projectId, appraisalFrameworkOverallJudgementOptions.frameworkVersionId, appraisalFrameworkOverallJudgementOptions.id], name: "appraisal_revisions_overall_option_fk" }).onDelete("restrict"),
    revisionNumberPositive: check("appraisal_revisions_revision_number_positive", sql`${table.revisionNumber} >= 1`),
    rationaleShape: check("appraisal_revisions_overall_rationale_shape", sql`${table.overallRationale} is null or char_length(${table.overallRationale}) <= 10000`),
  }),
);

export const appraisalRevisionResponses = pgTable(
  "appraisal_revision_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    frameworkItemId: uuid("framework_item_id").notNull(),
    selectedOptionId: uuid("selected_option_id"),
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("appraisal_revision_responses_project_id_id_unique").on(table.projectId, table.id),
    revisionItemUnique: unique("appraisal_revision_responses_project_revision_item_unique").on(table.projectId, table.revisionId, table.frameworkItemId),
    responseIdentity: unique("appraisal_revision_responses_project_identity_unique").on(table.projectId, table.revisionId, table.id, table.frameworkVersionId, table.frameworkItemId),
    revisionOwnership: foreignKey({ columns: [table.projectId, table.revisionId], foreignColumns: [appraisalRevisions.projectId, appraisalRevisions.id], name: "appraisal_revision_responses_revision_fk" }).onDelete("restrict"),
    itemOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId, table.frameworkItemId], foreignColumns: [appraisalFrameworkItems.projectId, appraisalFrameworkItems.frameworkVersionId, appraisalFrameworkItems.id], name: "appraisal_revision_responses_item_fk" }).onDelete("restrict"),
    optionOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId, table.frameworkItemId, table.selectedOptionId], foreignColumns: [appraisalFrameworkResponseOptions.projectId, appraisalFrameworkResponseOptions.frameworkVersionId, appraisalFrameworkResponseOptions.itemId, appraisalFrameworkResponseOptions.id], name: "appraisal_revision_responses_option_fk" }).onDelete("restrict"),
    rationaleShape: check("appraisal_revision_responses_rationale_shape", sql`${table.rationale} is null or char_length(${table.rationale}) <= 10000`),
  }),
);

export const appraisalRevisionResponseEvidence = pgTable(
  "appraisal_revision_response_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    frameworkId: uuid("framework_id").notNull(),
    appraisalId: uuid("appraisal_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    frameworkItemId: uuid("framework_item_id").notNull(),
    responseId: uuid("response_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    evidenceReviewDecisionIdAtSave: uuid("evidence_review_decision_id_at_save"),
    evidenceReviewStateAtSave: text("evidence_review_state_at_save").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("appraisal_revision_response_evidence_project_id_id_unique").on(table.projectId, table.id),
    responseEvidenceUnique: unique("appraisal_revision_response_evidence_response_evidence_unique").on(table.projectId, table.responseId, table.evidenceId),
    projectOwnership: foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "appraisal_revision_response_evidence_project_fk" }).onDelete("restrict"),
    paperOwnership: foreignKey({ columns: [table.projectId, table.paperId], foreignColumns: [papers.projectId, papers.id], name: "appraisal_revision_response_evidence_paper_fk" }).onDelete("restrict"),
    frameworkOwnership: foreignKey({ columns: [table.projectId, table.frameworkId], foreignColumns: [appraisalFrameworks.projectId, appraisalFrameworks.id], name: "appraisal_revision_response_evidence_framework_fk" }).onDelete("restrict"),
    appraisalOwnership: foreignKey({ columns: [table.projectId, table.appraisalId, table.paperId, table.frameworkId], foreignColumns: [appraisals.projectId, appraisals.id, appraisals.paperId, appraisals.frameworkId], name: "appraisal_revision_response_evidence_appraisal_fk" }).onDelete("restrict"),
    revisionOwnership: foreignKey({ columns: [table.projectId, table.revisionId, table.paperId, table.frameworkId, table.appraisalId, table.frameworkVersionId], foreignColumns: [appraisalRevisions.projectId, appraisalRevisions.id, appraisalRevisions.paperId, appraisalRevisions.frameworkId, appraisalRevisions.appraisalId, appraisalRevisions.frameworkVersionId], name: "appraisal_revision_response_evidence_revision_fk" }).onDelete("restrict"),
    responseOwnership: foreignKey({ columns: [table.projectId, table.revisionId, table.responseId, table.frameworkVersionId, table.frameworkItemId], foreignColumns: [appraisalRevisionResponses.projectId, appraisalRevisionResponses.revisionId, appraisalRevisionResponses.id, appraisalRevisionResponses.frameworkVersionId, appraisalRevisionResponses.frameworkItemId], name: "appraisal_revision_response_evidence_response_fk" }).onDelete("restrict"),
    itemOwnership: foreignKey({ columns: [table.projectId, table.frameworkVersionId, table.frameworkItemId], foreignColumns: [appraisalFrameworkItems.projectId, appraisalFrameworkItems.frameworkVersionId, appraisalFrameworkItems.id], name: "appraisal_revision_response_evidence_item_fk" }).onDelete("restrict"),
    evidenceOwnership: foreignKey({ columns: [table.projectId, table.paperId, table.evidenceId], foreignColumns: [evidence.projectId, evidence.paperId, evidence.id], name: "appraisal_revision_response_evidence_evidence_fk" }).onDelete("restrict"),
    evidenceReviewDecisionOwnership: foreignKey({ columns: [table.projectId, table.evidenceId, table.evidenceReviewDecisionIdAtSave], foreignColumns: [evidenceReviewDecisions.projectId, evidenceReviewDecisions.evidenceId, evidenceReviewDecisions.id], name: "appraisal_revision_response_evidence_review_decision_fk" }).onDelete("restrict"),
    reviewStateValid: check("appraisal_revision_response_evidence_review_state_valid", sql`${table.evidenceReviewStateAtSave} in ('unreviewed', 'needs_review', 'accepted', 'rejected')`),
  }),
);

export const schema = {
  projects,
  papers,
  fullTextDocuments,
  paperFullTextPreferences,
  documentTextExtractions,
  documentTextExtractionPages,
  evidence,
  evidenceReviewDecisions,
  evidenceAnnotations,
  evidenceLabels,
  evidenceLabelEvents,
  evidenceSets,
  evidenceSetMemberships,
  evidenceSetCompositionRevisions,
  evidenceSetCompositionMembers,
  evidenceSetAnnotations,
  claims,
  claimRevisions,
  claimRevisionEvidenceSupports,
  claimRevisionExtractionSupports,
  claimRevisionSynthesisSupports,
  screeningCriteria,
  screeningDecisions,
  fullTextScreeningCriteria,
  fullTextScreeningDecisions,
  fullTextRetrievalAttempts,
  extractionFields,
  extractionOptions,
  extractionValues,
  extractionValueRevisions,
  extractionRevisionEvidence,
  synthesisStatements,
  synthesisRevisions,
  synthesisRevisionSupports,
  synthesisPreparations,
  synthesisPreparationSelections,
  synthesisInterpretations,
  synthesisInterpretationLimitations,
  synthesisInterpretationQuestions,
  synthesisInterpretationContradictions,
  manuscripts,
  manuscriptSections,
  manuscriptClaimPlacements,
  manuscriptSectionItems,
  manuscriptSectionItemClaims,
  manuscriptProseBlocks,
  manuscriptProseRevisions,
  manuscriptClaimPlacementEvents,
  manuscriptReviewThreads,
  manuscriptReviewEvents,
  manuscriptSnapshots,
  manuscriptSnapshotSections,
  manuscriptSnapshotItems,
  manuscriptSnapshotProseItems,
  manuscriptSnapshotClaimItems,
  manuscriptSnapshotBibliographyEntries,
  manuscriptSnapshotClaimBibliographyMembers,
  manuscriptSnapshotWarnings,
  researchQuestions,
  researchQuestionExtractionFieldEvents,
  researchQuestionEvidenceSetEvents,
  researchQuestionSynthesisStatementEvents,
  researchQuestionClaimEvents,
  researchQuestionAnswers,
  researchQuestionAnswerClaimContexts,
  researchQuestionAnswerSynthesisContexts,
  searchSources,
  searchStrategies,
  searchRuns,
  retrievedRecords,
  retrievedRecordMatches,
  retrievedRecordDeduplicationDecisions,
  aiExtractionRequests,
  aiExtractionRequestPages,
  aiExtractionDispatches,
  aiExtractionResults,
  aiExtractionResultGroundings,
  aiExtractionDecisions,
  aiExtractionDecisionEvidence,
  aiExtractionBatches,
  aiExtractionBatchItems,
  bibliographicImports,
  bibliographicImportRecords,
  bibliographicImportResolutions,
  pdfIntakes,
  pdfIntakeMetadataResults,
  pdfIntakeMetadataFields,
  pdfIntakeResolutions,
  aiSynthesisRequests,
  aiSynthesisRequestSupports,
  aiSynthesisRequestSources,
  aiSynthesisDispatches,
  aiSynthesisResults,
  aiSynthesisResultGroundings,
  aiSynthesisDecisions,
  doiLookupRequests,
  bibliographicMetadataFetches,
  doiLookupDispatches,
  bibliographicMetadataFetchResults,
  bibliographicMetadataResultAuthors,
  doiLookupResolutions,
  bibliographicMetadataHttpAttempts,
  appraisalFrameworks,
  appraisalFrameworkVersions,
  appraisalFrameworkSections,
  appraisalFrameworkItems,
  appraisalFrameworkResponseOptions,
  appraisalFrameworkOverallJudgementOptions,
  appraisals,
  appraisalRevisions,
  appraisalRevisionResponses,
  appraisalRevisionResponseEvidence,
};
