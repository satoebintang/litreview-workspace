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
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./shared";
import { papers, projects } from "./foundation";
import { evidence } from "./documents-evidence";

const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => "xid8" });

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
    setOrdinal: bigint("set_ordinal", { mode: "number" }).notNull(),
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    previousRevisionId: uuid("previous_revision_id"),
    headMembershipId: uuid("head_membership_id"),
    tailMembershipId: uuid("tail_membership_id"),
    memberCount: integer("member_count").notNull(),
    distinctPaperCount: integer("distinct_paper_count").notNull(),
    targetMembershipId: uuid("target_membership_id"),
    moveDirection: text("move_direction"),
    transitionTransactionId: xid8("transition_transaction_id").default(sql`pg_current_xact_id()`).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdentity: unique("evidence_set_composition_revisions_project_id_id_unique").on(table.projectId, table.id),
    setRevisionIdentity: unique("evidence_set_composition_revisions_project_set_id_id_unique").on(table.projectId, table.evidenceSetId, table.id),
    setSequence: index("evidence_set_composition_revisions_project_set_sequence_idx").on(table.projectId, table.evidenceSetId, table.sequence),
    setOrdinalIdentity: unique("evidence_set_composition_revisions_project_set_ordinal_unique").on(table.projectId, table.evidenceSetId, table.setOrdinal),
    childRevisionUnique: uniqueIndex("evidence_set_composition_revisions_project_set_previous_unique")
      .on(table.projectId, table.evidenceSetId, table.previousRevisionId)
      .where(sql`${table.previousRevisionId} is not null`),
    setOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "evidence_set_composition_revisions_project_set_fk",
    }).onDelete("restrict"),
    previousRevisionOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.previousRevisionId],
      foreignColumns: [table.projectId, table.evidenceSetId, table.id],
      name: "evidence_set_composition_revisions_project_set_previous_fk",
    }).onDelete("restrict"),
    headMembershipOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.headMembershipId],
      foreignColumns: [evidenceSetMemberships.projectId, evidenceSetMemberships.evidenceSetId, evidenceSetMemberships.id],
      name: "evidence_set_composition_revisions_project_set_head_membership_fk",
    }).onDelete("restrict"),
    tailMembershipOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.tailMembershipId],
      foreignColumns: [evidenceSetMemberships.projectId, evidenceSetMemberships.evidenceSetId, evidenceSetMemberships.id],
      name: "evidence_set_composition_revisions_project_set_tail_membership_fk",
    }).onDelete("restrict"),
    targetMembershipOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.targetMembershipId],
      foreignColumns: [evidenceSetMemberships.projectId, evidenceSetMemberships.evidenceSetId, evidenceSetMemberships.id],
      name: "evidence_set_composition_revisions_project_set_target_membership_fk",
    }).onDelete("restrict"),
    operationKindValid: check("evidence_set_composition_revisions_operation_kind_valid", sql`${table.operationKind} in ('created', 'added', 'readded', 'removed', 'reordered', 'moved')`),
    memberSummaryValid: check("evidence_set_composition_revisions_member_summary_valid", sql`${table.memberCount} >= 0 and ${table.distinctPaperCount} >= 0 and ${table.distinctPaperCount} <= ${table.memberCount}`),
    moveDirectionValid: check("evidence_set_composition_revisions_move_direction_valid", sql`${table.moveDirection} is null or ${table.moveDirection} in ('up', 'down')`),
    operationShape: check("evidence_set_composition_revisions_operation_shape", sql`(
      (${table.operationKind} = 'created' and ${table.previousRevisionId} is null and ${table.targetMembershipId} is null and ${table.moveDirection} is null)
      or (${table.operationKind} in ('added', 'readded', 'removed') and ${table.previousRevisionId} is not null and ${table.targetMembershipId} is not null and ${table.moveDirection} is null)
      or (${table.operationKind} = 'moved' and ${table.previousRevisionId} is not null and ${table.targetMembershipId} is not null and ${table.moveDirection} is not null)
      or (${table.operationKind} = 'reordered' and ${table.previousRevisionId} is not null and ${table.targetMembershipId} is null and ${table.moveDirection} is null)
    )`),
  }),
);

export const evidenceSetMembershipOrderVersions = pgTable(
  "evidence_set_membership_order_versions",
  {
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    nextMembershipId: uuid("next_membership_id"),
    validFromOrdinal: bigint("valid_from_ordinal", { mode: "number" }).notNull(),
    validToOrdinal: bigint("valid_to_ordinal", { mode: "number" }),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.evidenceSetId, table.membershipId, table.validFromOrdinal] }),
    membershipOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.membershipId],
      foreignColumns: [evidenceSetMemberships.projectId, evidenceSetMemberships.evidenceSetId, evidenceSetMemberships.id],
      name: "evidence_set_membership_order_versions_project_set_membership_fk",
    }).onDelete("restrict"),
    nextMembershipOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.nextMembershipId],
      foreignColumns: [evidenceSetMemberships.projectId, evidenceSetMemberships.evidenceSetId, evidenceSetMemberships.id],
      name: "evidence_set_membership_order_versions_project_set_next_membership_fk",
    }).onDelete("restrict"),
    validFromRevisionOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.validFromOrdinal],
      foreignColumns: [evidenceSetCompositionRevisions.projectId, evidenceSetCompositionRevisions.evidenceSetId, evidenceSetCompositionRevisions.setOrdinal],
      name: "evidence_set_membership_order_versions_project_set_valid_from_revision_fk",
    }).onDelete("restrict"),
    validToRevisionOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId, table.validToOrdinal],
      foreignColumns: [evidenceSetCompositionRevisions.projectId, evidenceSetCompositionRevisions.evidenceSetId, evidenceSetCompositionRevisions.setOrdinal],
      name: "evidence_set_membership_order_versions_project_set_valid_to_revision_fk",
    }).onDelete("restrict"),
    membershipIntervalLookup: index("evidence_set_membership_order_versions_project_set_member_from_idx").on(table.projectId, table.evidenceSetId, table.membershipId, table.validFromOrdinal),
    predecessorLookup: index("evidence_set_membership_order_versions_project_set_next_from_idx").on(table.projectId, table.evidenceSetId, table.nextMembershipId, table.validFromOrdinal),
    openMembershipUnique: uniqueIndex("evidence_set_membership_order_versions_open_member_unique")
      .on(table.projectId, table.evidenceSetId, table.membershipId)
      .where(sql`${table.validToOrdinal} is null`),
    openSuccessorUnique: uniqueIndex("evidence_set_membership_order_versions_open_successor_unique")
      .on(table.projectId, table.evidenceSetId, table.nextMembershipId)
      .where(sql`${table.validToOrdinal} is null and ${table.nextMembershipId} is not null`),
    intervalValid: check("evidence_set_membership_order_versions_interval_valid", sql`${table.validToOrdinal} is null or ${table.validToOrdinal} > ${table.validFromOrdinal}`),
    noSelfLink: check("evidence_set_membership_order_versions_no_self_link", sql`${table.nextMembershipId} is null or ${table.nextMembershipId} <> ${table.membershipId}`),
  }),
);

export const evidenceSetPaperMemberCounts = pgTable(
  "evidence_set_paper_member_counts",
  {
    projectId: uuid("project_id").notNull(),
    evidenceSetId: uuid("evidence_set_id").notNull(),
    paperId: uuid("paper_id").notNull(),
    memberCount: integer("member_count").notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.projectId, table.evidenceSetId, table.paperId] }),
    setOwnership: foreignKey({
      columns: [table.projectId, table.evidenceSetId],
      foreignColumns: [evidenceSets.projectId, evidenceSets.id],
      name: "evidence_set_paper_member_counts_project_set_fk",
    }).onDelete("restrict"),
    paperOwnership: foreignKey({
      columns: [table.projectId, table.paperId],
      foreignColumns: [papers.projectId, papers.id],
      name: "evidence_set_paper_member_counts_project_paper_fk",
    }).onDelete("restrict"),
    memberCountValid: check("evidence_set_paper_member_counts_member_count_valid", sql`${table.memberCount} > 0`),
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
