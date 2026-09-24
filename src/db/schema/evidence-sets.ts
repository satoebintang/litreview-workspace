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
import { projects } from "./foundation";
import { evidence } from "./documents-evidence";

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
