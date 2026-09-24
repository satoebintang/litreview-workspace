import {
  integer,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  foreignKey,
  check,
  bigint,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { retrievedRecordDoiComparison } from "../comparison-expressions";
import { timestamps } from "./shared";
import { projects, papers } from "./foundation";

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
      .using("btree", table.projectId, retrievedRecordDoiComparison(table.doi))
      .where(sql`${table.doi} is not null and btrim(${table.doi}) <> ''`),
    sourceRecordComparison: index("retrieved_records_project_source_record_comparison_idx")
      .on(table.projectId, table.searchSourceId, table.sourceRecordId)
      .where(sql`${table.sourceRecordId} is not null and btrim(${table.sourceRecordId}) <> ''`),
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
