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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./shared";
import { projects } from "./foundation";
import { claims, claimRevisions } from "./claims";

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

export const manuscriptSnapshots = pgTable("manuscript_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(), sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull(), projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), title: text("title").notNull(), citationStyle: text("citation_style").notNull(), schemaVersion: integer("schema_version").notNull(), rendererVersion: text("renderer_version").notNull(), capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(), renderedMarkdown: text("rendered_markdown").notNull(), renderedMarkdownSha256: text("rendered_markdown_sha256").notNull(), expectedSectionCount: integer("expected_section_count").notNull(), expectedItemCount: integer("expected_item_count").notNull(), expectedBibliographyCount: integer("expected_bibliography_count").notNull(), expectedWarningCount: integer("expected_warning_count").notNull(), finalizedAt: timestamp("finalized_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), });

export const manuscriptSnapshotSections = pgTable("manuscript_snapshot_sections", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), sourceSectionId: uuid("source_section_id").notNull(), title: text("title").notNull(), sectionType: text("section_type").notNull(), sectionPosition: integer("section_position").notNull(), sourceSortOrder: integer("source_sort_order").notNull() });

export const manuscriptSnapshotItems = pgTable("manuscript_snapshot_items", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), snapshotSectionId: uuid("snapshot_section_id").notNull(), sourceSectionId: uuid("source_section_id").notNull(), sourceSectionItemId: uuid("source_section_item_id").notNull(), itemType: text("item_type").notNull(), itemPosition: integer("item_position").notNull(), sourceSortOrder: integer("source_sort_order").notNull() });

export const manuscriptSnapshotProseItems = pgTable("manuscript_snapshot_prose_items", { projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotItemId: uuid("snapshot_item_id").primaryKey(), snapshotId: uuid("snapshot_id").notNull(), sourceProseBlockId: uuid("source_prose_block_id").notNull(), proseRevisionId: uuid("prose_revision_id").notNull(), proseText: text("prose_text").notNull(), sourceSectionId: uuid("source_section_id").notNull(), sourceSectionItemId: uuid("source_section_item_id").notNull() });

export const manuscriptSnapshotClaimItems = pgTable("manuscript_snapshot_claim_items", { projectId: uuid("project_id").notNull(), manuscriptId: uuid("manuscript_id").notNull(), snapshotItemId: uuid("snapshot_item_id").primaryKey(), snapshotId: uuid("snapshot_id").notNull(), placementId: uuid("placement_id").notNull(), claimId: uuid("claim_id").notNull(), claimRevisionId: uuid("claim_revision_id").notNull(), sourceSectionId: uuid("source_section_id").notNull(), sourceSectionItemId: uuid("source_section_item_id").notNull(), claimText: text("claim_text"), renderedCitationMarker: text("rendered_citation_marker").notNull(), captureSupportStatus: text("capture_support_status").notNull(), captureIsCurrentClaimRevision: boolean("capture_is_current_claim_revision").notNull(), captureIsSuperseded: boolean("capture_is_superseded").notNull(), captureClaimLifecycle: text("capture_claim_lifecycle").notNull() });

export const manuscriptSnapshotBibliographyEntries = pgTable("manuscript_snapshot_bibliography_entries", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), paperId: uuid("paper_id").notNull(), title: text("title").notNull(), authors: text("authors").array().notNull(), publicationYear: integer("publication_year"), venue: text("venue"), doi: text("doi"), citationNumber: integer("citation_number").notNull(), bibliographyPosition: integer("bibliography_position").notNull(), renderedReference: text("rendered_reference").notNull() });

export const manuscriptSnapshotClaimBibliographyMembers = pgTable("manuscript_snapshot_claim_bibliography_members", { projectId: uuid("project_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), snapshotClaimItemId: uuid("snapshot_claim_item_id").notNull(), bibliographyEntryId: uuid("bibliography_entry_id").notNull(), markerPosition: integer("marker_position").notNull() }, (table) => ({ pk: primaryKey({ columns: [table.projectId, table.snapshotId, table.snapshotClaimItemId, table.bibliographyEntryId] }) }));

export const manuscriptSnapshotWarnings = pgTable("manuscript_snapshot_warnings", { id: uuid("id").defaultRandom().primaryKey(), projectId: uuid("project_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), warningPosition: integer("warning_position").notNull(), sectionId: uuid("section_id"), sectionItemId: uuid("section_item_id"), placementId: uuid("placement_id"), claimRevisionId: uuid("claim_revision_id"), paperId: uuid("paper_id"), code: text("code").notNull(), message: text("message").notNull(), metadataField: text("metadata_field") });
