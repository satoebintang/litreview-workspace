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
import { projects } from "./foundation";
import { evidenceSets, evidenceSetCompositionRevisions } from "./evidence-sets";
import { extractionFields, extractionValueRevisions } from "./extraction";

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
