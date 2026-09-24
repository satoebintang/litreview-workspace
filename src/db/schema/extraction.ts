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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects, papers } from "./foundation";
import { evidence } from "./documents-evidence";

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
